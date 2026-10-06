import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { trimNativeMemory } from "./native-reducer.mjs";
import { verifyExportPng } from "./verify-export.mjs";

export const OVERVIEW_WEBP_LIMITS = Object.freeze({
  encodedPngBytes: 128 * 1024 * 1024,
  width: 8400,
  height: 2400,
  pixels: 24_000_000,
  webpSide: 16383,
  defaultMaxWidth: 4200,
});
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function checkAbort(signal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Cancelled");
}
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function readExactly(fd, bytes, start = 0) {
  let offset = start;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!count) throw new Error("Truncated overview PNG");
    offset += count;
  }
}

/** Validate the bounded IHDR before decoding or allocating a whole raster. */
function openOverviewPng(path) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 33 ||
      stat.size > OVERVIEW_WEBP_LIMITS.encodedPngBytes
    )
      throw new Error(
        "Overview PNG must be a regular file of 33 bytes to 128 MiB",
      );
    const header = Buffer.allocUnsafe(33);
    readExactly(fd, header);
    if (
      !header.subarray(0, 8).equals(PNG_SIGNATURE) ||
      header.readUInt32BE(8) !== 13 ||
      header.toString("ascii", 12, 16) !== "IHDR" ||
      crc32(header.subarray(12, 29)) !== header.readUInt32BE(29)
    )
      throw new Error("Invalid overview PNG signature or IHDR");
    const width = header.readUInt32BE(16),
      height = header.readUInt32BE(20);
    if (
      !width ||
      !height ||
      width > OVERVIEW_WEBP_LIMITS.width ||
      height > OVERVIEW_WEBP_LIMITS.height ||
      width > OVERVIEW_WEBP_LIMITS.webpSide ||
      height > OVERVIEW_WEBP_LIMITS.webpSide ||
      width * height > OVERVIEW_WEBP_LIMITS.pixels
    )
      throw new Error(
        "Overview dimensions exceed 8400 x 2400 or the WebP pixel budget; full-detail exports are unsupported",
      );
    if (header[26] !== 0 || header[27] !== 0 || header[28] > 1)
      throw new Error(
        "Invalid overview PNG compression, filter or interlace method",
      );
    if (width * height >= 1_000_000 && typeof global.gc !== "function")
      throw new Error(
        "Large overview encoding requires node --expose-gc to release the decoded PNG before encoding",
      );
    return { fd, header, bytes: stat.size, width, height };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// The encoded PNG and loaded Image die with this scope. Only the destination
// Canvas survives the caller's GC/macrotask boundary before the WebP encoder.
async function readCanvas(inputPath, maxWidth, signal) {
  const source = openOverviewPng(inputPath);
  try {
    // @napi-rs/canvas 0.1.80 can crash on an IHDR-only truncated PNG instead of
    // rejecting loadImage. Audit complete CRCs and the zlib stream first using
    // the project's bounded verifier, then bind it to the bytes actually used.
    const verified = await verifyExportPng(inputPath);
    checkAbort(signal);
    const bytes = Buffer.allocUnsafe(source.bytes);
    source.header.copy(bytes);
    readExactly(source.fd, bytes, source.header.length);
    if (
      fstatSync(source.fd).size !== source.bytes ||
      readSync(source.fd, Buffer.allocUnsafe(1), 0, 1, source.bytes)
    )
      throw new Error("Overview PNG changed during its bounded read");
    const sourceHash = sha256(bytes);
    if (
      verified.sha256 !== sourceHash ||
      verified.width !== source.width ||
      verified.height !== source.height
    )
      throw new Error("Overview PNG changed after its complete verification");
    checkAbort(signal);
    process.env.DISABLE_SYSTEM_FONTS_LOAD ??= "1";
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    let loaded = await loadImage(bytes);
    checkAbort(signal);
    if (loaded.width !== source.width || loaded.height !== source.height)
      throw new Error("Decoded overview PNG dimensions differ from its IHDR");
    const width = Math.min(source.width, maxWidth),
      height = Math.max(1, Math.round((source.height * width) / source.width)),
      resized = width !== source.width || height !== source.height;
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = resized;
    if (resized) context.imageSmoothingQuality = "high";
    context.drawImage(loaded, 0, 0, width, height);
    loaded = null;
    return {
      canvas,
      output: { width, height },
      source: {
        path: inputPath,
        bytes: source.bytes,
        width: source.width,
        height: source.height,
        sha256: sourceHash,
      },
    };
  } finally {
    closeSync(source.fd);
  }
}

function webpCompression(bytes) {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    throw new Error("Encoder returned an invalid WebP container");
  let compression = null;
  for (let offset = 12; offset < bytes.length; ) {
    if (offset + 8 > bytes.length)
      throw new Error("Truncated encoded WebP chunk");
    const kind = bytes.toString("ascii", offset, offset + 4),
      length = bytes.readUInt32LE(offset + 4);
    offset += 8 + length + (length & 1);
    if (offset > bytes.length)
      throw new Error("Encoded WebP chunk exceeds its container");
    if (kind === "VP8 ") compression = "lossy";
    if (kind === "VP8L") compression = "lossless";
  }
  if (!compression)
    throw new Error("Encoded WebP contains no still-image payload");
  return compression;
}

/** Run as a separate process after PNG rendering has exited. The default
 * quality-85 WebP is a lossy sharing copy, limited to 4200 pixels wide by default;
 * the original PNG remains the exact
 * reference. This stage intentionally does not promise lossless PNG equality,
 * even when the codec selects VP8L at quality 100. */
export async function encodeOverview(
  {
    inputPath,
    outputPath,
    quality = 85,
    maxWidth = OVERVIEW_WEBP_LIMITS.defaultMaxWidth,
  },
  { signal } = {},
) {
  const started = performance.now();
  checkAbort(signal);
  if (!Number.isInteger(quality) || quality < 0 || quality > 100)
    throw new Error("WebP quality must be an integer from 0 to 100");
  if (
    !Number.isInteger(maxWidth) ||
    maxWidth < 1 ||
    maxWidth > OVERVIEW_WEBP_LIMITS.width
  )
    throw new Error("WebP max-width must be an integer from 1 to 8400");
  if (
    typeof inputPath !== "string" ||
    !inputPath ||
    typeof outputPath !== "string" ||
    !outputPath
  )
    throw new Error("Provide an input overview PNG and an output WebP path");
  inputPath = resolve(inputPath);
  outputPath = resolve(outputPath);
  const reportPath = `${outputPath}.json`;
  if (existsSync(outputPath) || existsSync(reportPath))
    throw new Error("WebP output or report already exists; choose a new path");
  const temporary = `${outputPath}.partial-${randomUUID()}`,
    temporaryReport = `${reportPath}.partial-${randomUUID()}`,
    owned = new Set();
  let canvas = null,
    committed = false;
  try {
    const decoded = await readCanvas(inputPath, maxWidth, signal);
    canvas = decoded.canvas;
    const source = decoded.source,
      output = decoded.output;
    const decodeSeconds = (performance.now() - started) / 1000;
    const releaseStarted = performance.now();
    const explicitGc = typeof global.gc === "function";
    if (explicitGc) global.gc();
    await new Promise(setImmediate);
    const releasedAfterDecode = trimNativeMemory();
    checkAbort(signal);
    const releaseSeconds = (performance.now() - releaseStarted) / 1000;
    const encodeStarted = performance.now();
    const encoded = await canvas.encode("webp", quality);
    const encodeSeconds = (performance.now() - encodeStarted) / 1000;
    checkAbort(signal);
    const compression = webpCompression(encoded),
      encodedHash = sha256(encoded);
    // Native encoding is complete before the Canvas backing is released.
    canvas.width = canvas.height = 1;
    canvas = null;
    mkdirSync(dirname(outputPath), { recursive: true });
    const writeStarted = performance.now();
    const fd = openSync(temporary, "wx");
    owned.add(temporary);
    try {
      writeFileSync(fd, encoded);
    } finally {
      closeSync(fd);
    }
    const result = {
      schema: "exploretv-overview-webp-v1",
      source,
      sourceValidation:
        "Project-generated non-interlaced RGBA8 PNG; complete chunk CRCs, zlib stream, dimensions and source SHA-256 verified before native decoding.",
      webp: {
        path: outputPath,
        width: output.width,
        height: output.height,
        quality,
        compression,
        bytes: encoded.length,
        sha256: encodedHash,
      },
      resize: {
        maxWidth,
        applied:
          output.width !== source.width || output.height !== source.height,
        scaleX: output.width / source.width,
        scaleY: output.height / source.height,
        filter:
          output.width === source.width
            ? "none"
            : "Canvas high-quality resampling",
        aspectRatio:
          "Preserved to the nearest integer output height; images are never enlarged.",
      },
      compressionRatio: encoded.length / source.bytes,
      byteReductionFraction: 1 - encoded.length / source.bytes,
      pixelExactnessVerified: false,
      fidelity:
        "Sharing copy; default quality 85 is lossy and width is limited to 4200 pixels. Keep the source PNG as the exact reference. Explicit max-width 8400 can use substantially more memory.",
      runtimeSeconds: (performance.now() - started) / 1000,
      stageSeconds: {
        decode: decodeSeconds,
        release: releaseSeconds,
        encode: encodeSeconds,
        write: (performance.now() - writeStarted) / 1000,
      },
      osPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      memory: {
        explicitGc,
        releasedAfterDecode,
        canvasRgbaBytes: output.width * output.height * 4,
        measurement:
          "OS process lifetime high-water RSS at report publication. Invoke this CLI in its own process after rendering; sequential stage peaks are not added.",
      },
    };
    const reportFd = openSync(temporaryReport, "wx");
    owned.add(temporaryReport);
    try {
      writeFileSync(reportFd, JSON.stringify(result, null, 2));
    } finally {
      closeSync(reportFd);
    }
    checkAbort(signal);
    linkSync(temporary, outputPath);
    owned.add(outputPath);
    linkSync(temporaryReport, reportPath);
    owned.add(reportPath);
    committed = true;
    unlinkSync(temporary);
    owned.delete(temporary);
    unlinkSync(temporaryReport);
    owned.delete(temporaryReport);
    return result;
  } catch (error) {
    for (const path of owned) {
      if (committed && (path === outputPath || path === reportPath)) continue;
      try {
        unlinkSync(path);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      }
    }
    throw error;
  } finally {
    if (canvas) canvas.width = canvas.height = 1;
  }
}

const USAGE = `Usage:
  node --expose-gc scripts/encode-overview.mjs <overview.png> <sharing.webp> [--quality 0..100] [--max-width 1..8400]

Run this process after the renderer exits. Default quality 85 is lossy; retain
the original PNG. Default max-width 4200 resamples larger images proportionally
at high quality; smaller images are unchanged. Explicit --max-width 8400 keeps
full width but can use substantially more memory. Input must use the renderer's non-interlaced RGBA8 PNG format,
up to 8400 x 2400 and 128 MiB. Full-detail exports are unsupported.
An existing output or report is never overwritten.`;

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const controller = new AbortController(),
    interrupt = () => controller.abort(new Error("Cancelled by signal"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") console.log(USAGE);
    else {
      if (args.length < 2 || args.length > 6 || args.length % 2)
        throw new Error(USAGE);
      const config = { inputPath: args[0], outputPath: args[1] },
        seen = new Set();
      for (let i = 2; i < args.length; i += 2) {
        const flag = args[i],
          value = args[i + 1];
        if (
          !["--quality", "--max-width"].includes(flag) ||
          seen.has(flag) ||
          !/^(0|[1-9][0-9]*)$/.test(value)
        )
          throw new Error(USAGE);
        seen.add(flag);
        config[flag === "--quality" ? "quality" : "maxWidth"] = Number(value);
      }
      const result = await encodeOverview(config, {
        signal: controller.signal,
      });
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error("encode-overview: " + error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
