import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const sourcePath = fileURLToPath(
  new URL("./native-blitter.c", import.meta.url),
);
const defaultAddonPath = fileURLToPath(
  new URL(
    `../artifacts/native/native-blitter-${process.platform}-${process.arch}.node`,
    import.meta.url,
  ),
);
const addonPath =
  process.env.EXPLORETV_SCALAR_BLITTER === "1"
    ? defaultAddonPath.replace(/\.node$/, "-scalar.node")
    : defaultAddonPath;
export const BLIT_DESCRIPTOR_SIZE = 8;
let addon = null;
let reason = null;
let sourceSha256 = null;
let binarySha256 = null;
let build = null;
try {
  if (process.env.EXPLORETV_DISABLE_NATIVE_BLITTER === "1")
    throw new Error("disabled by EXPLORETV_DISABLE_NATIVE_BLITTER");
  const receipt = JSON.parse(readFileSync(addonPath + ".json", "utf8"));
  sourceSha256 = createHash("sha256")
    .update(readFileSync(sourcePath))
    .digest("hex");
  if (
    receipt.version !== 2 ||
    receipt.sourceSha256 !== sourceSha256 ||
    receipt.platform !== process.platform ||
    receipt.arch !== process.arch
  )
    throw new Error(
      "native blitter build is stale; rebuild native-blitter.mjs",
    );
  binarySha256 = createHash("sha256")
    .update(readFileSync(addonPath))
    .digest("hex");
  if (receipt.binarySha256 !== binarySha256)
    throw new Error(
      "native blitter binary hash differs from its build receipt",
    );
  addon = require(addonPath);
  if (
    typeof addon?.composeInto !== "function" ||
    typeof addon?.premultiplyInto !== "function" ||
    typeof addon?.scaleOpacityInto !== "function" ||
    typeof addon?.clearOpaque !== "function" ||
    typeof addon?.kernel !== "string" ||
    !addon.kernel
  )
    throw new Error("native blitter export is missing");
  build = Object.freeze({
    napiVersion: receipt.napiVersion,
    compiler: receipt.compiler,
    flags: Object.freeze([...receipt.flags]),
    forceScalar: receipt.forceScalar,
  });
} catch (error) {
  addon = null;
  reason =
    error.code === "ENOENT" ? "native blitter is not prepared" : error.message;
}

export const nativeBlitterStatus = Object.freeze({
  available: addon !== null,
  backend: addon ? "node-api" : "javascript",
  kernel: addon?.kernel ?? "javascript",
  sourceSha256: addon ? sourceSha256 : null,
  binarySha256: addon ? binarySha256 : null,
  build: addon ? build : null,
  reason,
});

function isBytes(value) {
  return (
    (value instanceof Uint8Array || value instanceof Uint8ClampedArray) &&
    value.buffer instanceof ArrayBuffer &&
    value.buffer.detached !== true
  );
}

function overlaps(a, b) {
  return (
    a.buffer === b.buffer &&
    a.byteOffset < b.byteOffset + b.byteLength &&
    b.byteOffset < a.byteOffset + a.byteLength
  );
}

function roundedProduct(color, alpha) {
  const value = color * alpha + 128;
  return (value + (value >> 8)) >> 8;
}

/** Exact byte premultiplication, optionally in place. */
export function premultiplyRgba(
  source,
  target = new Uint8Array(source?.length),
) {
  if (addon) return addon.premultiplyInto(source, target);
  if (
    !isBytes(source) ||
    !isBytes(target) ||
    source.length !== target.length ||
    source.length % 4 ||
    (overlaps(source, target) && source.byteOffset !== target.byteOffset)
  )
    throw new TypeError(
      "Premultiplication requires equal, nonoverlapping RGBA8 byte arrays",
    );
  for (let i = 0; i < source.length; i += 4) {
    const alpha = source[i + 3];
    target[i] = roundedProduct(source[i], alpha);
    target[i + 1] = roundedProduct(source[i + 1], alpha);
    target[i + 2] = roundedProduct(source[i + 2], alpha);
    target[i + 3] = alpha;
  }
  return target;
}

/** Skia stores globalAlpha in float32 before rounding its product with 255. */
export function quantizeCanvasOpacity(opacity) {
  if (
    typeof opacity !== "number" ||
    !Number.isFinite(opacity) ||
    opacity < 0 ||
    opacity > 1
  )
    throw new RangeError(
      "Native frame opacity must be a finite number from zero to one",
    );
  return Math.round(Math.fround(Math.fround(opacity) * 255));
}

/**
 * Bake Canvas globalAlpha into PREMULTIPLIED RGBA8 bytes once per cached frame.
 * This scale differs from ordinary color premultiplication: Skia computes
 * ceil(byte * quantizedAlpha / 256), for every channel including alpha.
 * The prepared bytes can then use the ordinary source-over/additive descriptors.
 */
export function nativeFrameWithOpacity(
  source,
  opacity,
  target = new Uint8Array(source?.length),
) {
  const alpha = quantizeCanvasOpacity(opacity);
  if (addon) return addon.scaleOpacityInto(source, target, alpha);
  if (
    !isBytes(source) ||
    !isBytes(target) ||
    source.length !== target.length ||
    source.length % 4 ||
    (overlaps(source, target) && source.byteOffset !== target.byteOffset)
  )
    throw new TypeError(
      "Opacity scaling requires equal, nonoverlapping RGBA8 byte arrays",
    );
  for (let i = 0; i < source.length; i++)
    target[i] = (source[i] * alpha + 255) >> 8;
  return target;
}

/** Read a prepared Skia surface once; cache these bytes within a fixed budget. */
export function prepareFramePixels(canvas, opacity = 1) {
  quantizeCanvasOpacity(opacity);
  const pixels = canvas
    .getContext("2d")
    .getImageData(0, 0, canvas.width, canvas.height).data;
  const bytes = new Uint8Array(
    pixels.buffer,
    pixels.byteOffset,
    pixels.byteLength,
  );
  premultiplyRgba(bytes, bytes);
  return opacity === 1 ? bytes : nativeFrameWithOpacity(bytes, opacity, bytes);
}

/** Reset the reusable target to the opaque black scene background. */
export function clearOpaque(target) {
  if (addon) return addon.clearOpaque(target);
  if (!isBytes(target) || target.length % 4)
    throw new TypeError("Opaque clear requires an RGBA8 byte array");
  target.fill(0);
  for (let i = 3; i < target.length; i += 4) target[i] = 255;
  return target;
}

/**
 * Compose a bounded, ordered batch into an ALREADY OPAQUE RGBA8 target.
 * `frames` contain PREMULTIPLIED bytes, obtained with prepareFramePixels().
 * Int32 descriptors (8 values): frame index, width, height, destination x/y,
 * horizontal/vertical flip (0 or 1), blend (0 source-over, 1 additive).
 * Destination coordinates are integers local to `target`; clipping at its
 * rectangular bounds is exact. Use nativeFrameWithOpacity() to bake opacity;
 * scaling and nonrectangular clips belong to the Canvas fallback.
 * Input/output buffers must not alias.
 *
 * A missing or stale native build has the same exact JavaScript fallback.
 * Load never compiles or downloads; an exporter can require available=true
 * before selecting this optimization to avoid a slower JS compositing path.
 */
export function composeInto(target, width, height, descriptors, frames) {
  if (addon)
    return addon.composeInto(target, width, height, descriptors, frames);
  if (!Array.isArray(frames) || frames.length > 8192)
    throw new TypeError("Invalid integer-blitter frame array");
  // Resolve possible accessors before validating buffers, matching the addon.
  const sources = Array.from(frames);
  if (
    !isBytes(target) ||
    !Number.isInteger(width) ||
    width < 1 ||
    width > 0x7fffffff ||
    !Number.isInteger(height) ||
    height < 1 ||
    height > 0x7fffffff ||
    target.length !== width * height * 4 ||
    !(descriptors instanceof Int32Array) ||
    !(descriptors.buffer instanceof ArrayBuffer) ||
    descriptors.buffer.detached === true ||
    overlaps(descriptors, target) ||
    descriptors.length % BLIT_DESCRIPTOR_SIZE ||
    descriptors.length / BLIT_DESCRIPTOR_SIZE > 262144 ||
    sources.some((frame) => !isBytes(frame) || overlaps(frame, target))
  )
    throw new TypeError(
      "Invalid integer-blitter target, descriptors, or frame array",
    );
  // Validate the entire batch before modifying any output bytes.
  for (let i = 0; i < descriptors.length; i += BLIT_DESCRIPTOR_SIZE) {
    const [index, fw, fh, , , flipX, flipY, blend] = descriptors.subarray(
      i,
      i + 8,
    );
    if (
      index < 0 ||
      index >= sources.length ||
      fw < 1 ||
      fh < 1 ||
      sources[index].length !== fw * fh * 4 ||
      (flipX !== 0 && flipX !== 1) ||
      (flipY !== 0 && flipY !== 1) ||
      (blend !== 0 && blend !== 1)
    )
      throw new TypeError(
        "Invalid integer-blitter frame index, dimensions, flips, or blend",
      );
  }
  for (let i = 0; i < descriptors.length; i += BLIT_DESCRIPTOR_SIZE) {
    const [index, fw, fh, dx, dy, flipX, flipY, blend] = descriptors.subarray(
      i,
      i + 8,
    );
    const frame = sources[index],
      x0 = Math.max(0, dx),
      y0 = Math.max(0, dy),
      x1 = Math.min(width, dx + fw),
      y1 = Math.min(height, dy + fh);
    for (let y = y0; y < y1; y++) {
      const sy = flipY ? fh - 1 - (y - dy) : y - dy;
      for (let x = x0; x < x1; x++) {
        const sx = flipX ? fw - 1 - (x - dx) : x - dx,
          s = (sy * fw + sx) * 4,
          d = (y * width + x) * 4;
        if (blend) {
          target[d] = Math.min(255, target[d] + frame[s]);
          target[d + 1] = Math.min(255, target[d + 1] + frame[s + 1]);
          target[d + 2] = Math.min(255, target[d + 2] + frame[s + 2]);
        } else if (frame[s + 3] === 255) {
          target[d] = frame[s];
          target[d + 1] = frame[s + 1];
          target[d + 2] = frame[s + 2];
        } else if (frame[s + 3]) {
          const inverseAlpha = 255 - frame[s + 3];
          target[d] = Math.min(
            255,
            frame[s] + roundedProduct(target[d], inverseAlpha),
          );
          target[d + 1] = Math.min(
            255,
            frame[s + 1] + roundedProduct(target[d + 1], inverseAlpha),
          );
          target[d + 2] = Math.min(
            255,
            frame[s + 2] + roundedProduct(target[d + 2], inverseAlpha),
          );
        }
        target[d + 3] = 255;
      }
    }
  }
  return target;
}

/** Explicit offline compilation; headers must already be installed or supplied. */
export async function buildNativeBlitter({
  include,
  compiler = process.env.CC || "cc",
  forceScalar = false,
} = {}) {
  if (!["linux", "darwin"].includes(process.platform))
    throw new Error(
      "Native blitter build supports Linux and macOS; Canvas fallback remains available",
    );
  if (!include) {
    try {
      include = require("node-api-headers").include_dir;
    } catch {
      throw new Error(
        "Install node-api-headers, or pass --include <directory containing node_api.h>",
      );
    }
  }
  include = resolve(include);
  await readFile(resolve(include, "node_api.h"));
  const outputPath = forceScalar
    ? defaultAddonPath.replace(/\.node$/, "-scalar.node")
    : defaultAddonPath;
  const buildId = `${process.pid}.${randomUUID()}`;
  const temporaryPath = `${outputPath}.${buildId}.partial`;
  const temporarySource = `${outputPath}.${buildId}.c`;
  const temporaryReceipt = `${outputPath}.${buildId}.json.partial`;
  const source = await readFile(sourcePath);
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const flags = [
    "-O3",
    "-std=c11",
    "-DNAPI_VERSION=8",
    "-DNODE_GYP_MODULE_NAME=exploretv_native_blitter",
    "-fPIC",
    "-shared",
    "-Wall",
    "-Wextra",
  ];
  if (forceScalar) flags.push("-DEXPLORETV_FORCE_SCALAR=1");
  if (process.platform === "darwin") flags.push("-undefined", "dynamic_lookup");
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    // Compile exactly the immutable bytes represented by the source receipt.
    await writeFile(temporarySource, source);
    const built = spawnSync(
      compiler,
      [...flags, "-I", include, temporarySource, "-o", temporaryPath],
      {
        encoding: "utf8",
        shell: false,
        maxBuffer: 1024 * 1024,
      },
    );
    if (built.error) throw built.error;
    if (built.status !== 0)
      throw new Error(
        `Native blitter compilation failed (${built.status}): ${built.stderr || built.stdout}`,
      );
    const binarySha256 = createHash("sha256")
      .update(await readFile(temporaryPath))
      .digest("hex");
    await writeFile(
      temporaryReceipt,
      JSON.stringify(
        {
          version: 2,
          platform: process.platform,
          arch: process.arch,
          sourceSha256,
          binarySha256,
          napiVersion: 8,
          compiler,
          flags,
          forceScalar,
        },
        null,
        2,
      ) + "\n",
    );
    await rename(temporaryPath, outputPath);
    await rename(temporaryReceipt, outputPath + ".json");
    return {
      outputPath,
      sourceSha256,
      binarySha256,
      napiVersion: 8,
      forceScalar,
    };
  } finally {
    await rm(temporaryPath, { force: true });
    await rm(temporarySource, { force: true });
    await rm(temporaryReceipt, { force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    if (args.shift() !== "--build")
      throw new Error(
        "Usage: node scripts/native-blitter.mjs --build [--scalar] [--include <headers-directory>]",
      );
    while (args.length) {
      const option = args.shift();
      if (option === "--scalar") options.forceScalar = true;
      else if (option === "--include" && args.length)
        options.include = args.shift();
      else throw new Error(`Unknown native-blitter build option: ${option}`);
    }
    console.log(JSON.stringify(await buildNativeBlitter(options)));
  } catch (error) {
    console.error(`native-blitter: ${error.message}`);
    process.exitCode = 1;
  }
}
