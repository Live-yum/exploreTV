import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import {
  encodeOverview,
  OVERVIEW_WEBP_LIMITS,
} from "../scripts/encode-overview.mjs";

process.env.DISABLE_SYSTEM_FONTS_LOAD ??= "1";
const { createCanvas, loadImage } = await import("@napi-rs/canvas");
const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function workspace(t) {
  const parent = join(root, "artifacts", "tmp");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "encode-overview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function fixture(directory, width = 96, height = 64) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba.set(
        [
          (x * 13 + y * 29) & 255,
          (x * 3 + y * 17) & 255,
          (x * 31 + y * 7) & 255,
          255,
        ],
        i,
      );
    }
  const bytes = PNG.sync.write({ width, height, data: rgba }),
    inputPath = join(directory, "source.png");
  writeFileSync(inputPath, bytes);
  return { inputPath, bytes, rgba };
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
function resizedHeader(bytes, width, height) {
  const header = Buffer.from(bytes.subarray(0, 33));
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header.writeUInt32BE(crc32(header.subarray(12, 29)), 29);
  return header;
}
function noOutput(directory, outputPath) {
  assert.equal(existsSync(outputPath), false);
  assert.equal(existsSync(`${outputPath}.json`), false);
  assert.equal(
    readdirSync(directory).some((name) => name.includes(".partial-")),
    false,
  );
}

test("default quality-85 WebP preserves dimensions, records input identity and is explicitly lossy", async (t) => {
  const directory = workspace(t),
    source = fixture(directory),
    outputPath = join(directory, "sharing.webp");
  const report = await encodeOverview({
    inputPath: source.inputPath,
    outputPath,
  });
  const bytes = readFileSync(outputPath);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
  assert.deepEqual(readFileSync(source.inputPath), source.bytes);
  assert.equal(report.source.sha256, sha256(source.bytes));
  assert.equal(report.source.bytes, source.bytes.length);
  assert.equal(report.webp.bytes, bytes.length);
  assert.equal(report.webp.sha256, sha256(bytes));
  assert.equal(report.webp.quality, 85);
  assert.equal(report.webp.compression, "lossy");
  assert.equal(report.resize.maxWidth, 4200);
  assert.equal(report.resize.applied, false);
  assert.equal(report.resize.scaleX, 1);
  assert.equal(report.resize.scaleY, 1);
  assert.equal(report.pixelExactnessVerified, false);
  assert.match(report.fidelity, /lossy/);
  assert.equal(report.compressionRatio, bytes.length / source.bytes.length);
  assert.ok(report.osPeakRssBytes > 0);
  assert.deepEqual(
    JSON.parse(readFileSync(`${outputPath}.json`, "utf8")),
    report,
  );
  const decoded = await loadImage(bytes),
    canvas = createCanvas(decoded.width, decoded.height);
  assert.deepEqual([decoded.width, decoded.height], [96, 64]);
  canvas.getContext("2d").drawImage(decoded, 0, 0);
  const actual = canvas.getContext("2d").getImageData(0, 0, 96, 64).data;
  assert.ok(
    actual.some((value, i) => i % 4 !== 3 && value !== source.rgba[i]),
    "The fixture demonstrates that the sharing copy cannot replace the exact PNG",
  );
  canvas.width = canvas.height = 1;
  assert.equal(
    readdirSync(directory).some((name) => name.includes(".partial-")),
    false,
  );
});

test("max-width defaults to 4200, preserves aspect ratio and never enlarges small inputs", async (t) => {
  const directory = workspace(t),
    { inputPath } = fixture(directory, 8400, 2),
    outputPath = join(directory, "default-width.webp");
  const report = await encodeOverview({ inputPath, outputPath });
  assert.deepEqual([report.source.width, report.source.height], [8400, 2]);
  assert.deepEqual([report.webp.width, report.webp.height], [4200, 1]);
  assert.equal(report.resize.applied, true);
  assert.equal(report.resize.scaleX, 0.5);
  assert.equal(report.resize.scaleY, 0.5);
  assert.match(report.resize.filter, /high-quality/);
  assert.equal(report.memory.canvasRgbaBytes, 4200 * 4);
  const decoded = await loadImage(readFileSync(outputPath));
  assert.deepEqual([decoded.width, decoded.height], [4200, 1]);
  const small = fixture(directory);
  const reduced = await encodeOverview({
    inputPath: small.inputPath,
    outputPath: join(directory, "half.webp"),
    maxWidth: 48,
  });
  assert.deepEqual([reduced.webp.width, reduced.webp.height], [48, 32]);
  assert.deepEqual([reduced.source.width, reduced.source.height], [96, 64]);
  const unchanged = await encodeOverview({
    inputPath: small.inputPath,
    outputPath: join(directory, "small.webp"),
    maxWidth: 8400,
  });
  assert.deepEqual([unchanged.webp.width, unchanged.webp.height], [96, 64]);
  assert.equal(unchanged.resize.applied, false);
});

test("quality endpoints are accepted without claiming PNG pixel equality", async (t) => {
  const directory = workspace(t),
    { inputPath } = fixture(directory);
  for (const quality of [0, 100]) {
    const report = await encodeOverview({
      inputPath,
      outputPath: join(directory, `q${quality}.webp`),
      quality,
    });
    assert.equal(report.webp.quality, quality);
    assert.ok(["lossy", "lossless"].includes(report.webp.compression));
    assert.equal(report.pixelExactnessVerified, false);
  }
});

test("repeated valid-image encoding survives source release and explicit GC in one process", async (t) => {
  const directory = workspace(t),
    { inputPath, rgba } = fixture(directory);
  for (let i = 0; i < 6; i++) {
    const outputPath = join(directory, `repeat-${i}.webp`);
    const report = await encodeOverview({
      inputPath,
      outputPath,
      quality: 100,
    });
    assert.equal(report.webp.compression, "lossless");
    let image = await loadImage(readFileSync(outputPath));
    const canvas = createCanvas(96, 64);
    canvas.getContext("2d").drawImage(image, 0, 0);
    const pixels = canvas.getContext("2d").getImageData(0, 0, 96, 64);
    assert.deepEqual(Buffer.from(pixels.data), rgba);
    canvas.width = canvas.height = 1;
    image = null;
    if (global.gc) global.gc();
    await new Promise(setImmediate);
  }
});

test("invalid quality and an aborted operation create no output", async (t) => {
  const directory = workspace(t),
    { inputPath } = fixture(directory),
    outputPath = join(directory, "out.webp");
  for (const quality of [-1, 101, 1.5, NaN, "85"])
    await assert.rejects(
      encodeOverview({ inputPath, outputPath, quality }),
      /quality/,
    );
  for (const maxWidth of [0, 8401, 1.5, NaN, "48"])
    await assert.rejects(
      encodeOverview({ inputPath, outputPath, maxWidth }),
      /max-width/,
    );
  const controller = new AbortController();
  controller.abort(new Error("fixture cancellation"));
  await assert.rejects(
    encodeOverview({ inputPath, outputPath }, { signal: controller.signal }),
    /fixture cancellation/,
  );
  noOutput(directory, outputPath);
});

test("IHDR dimensions, CRC and encoded-byte caps reject input before native decoding", async (t) => {
  const directory = workspace(t),
    { bytes } = fixture(directory),
    inputPath = join(directory, "invalid.png"),
    outputPath = join(directory, "out.webp");
  for (const [width, height] of [
    [0, 1],
    [8401, 1],
    [1, 2401],
    [16384, 1],
    [8400, 2401],
  ]) {
    writeFileSync(inputPath, resizedHeader(bytes, width, height));
    await assert.rejects(
      encodeOverview({ inputPath, outputPath }),
      /dimensions exceed/,
    );
  }
  const badCrc = Buffer.from(bytes.subarray(0, 33));
  badCrc[29] ^= 1;
  writeFileSync(inputPath, badCrc);
  await assert.rejects(
    encodeOverview({ inputPath, outputPath }),
    /signature or IHDR/,
  );
  writeFileSync(inputPath, bytes.subarray(0, 33));
  truncateSync(inputPath, OVERVIEW_WEBP_LIMITS.encodedPngBytes + 1);
  await assert.rejects(encodeOverview({ inputPath, outputPath }), /128 MiB/);
  noOutput(directory, outputPath);
});

test("existing output and report are preserved, and failed decoding leaves no partial files", async (t) => {
  const directory = workspace(t),
    { inputPath, bytes } = fixture(directory),
    outputPath = join(directory, "out.webp");
  writeFileSync(outputPath, "keep output");
  await assert.rejects(
    encodeOverview({ inputPath, outputPath }),
    /already exists/,
  );
  assert.equal(readFileSync(outputPath, "utf8"), "keep output");
  rmSync(outputPath);
  writeFileSync(`${outputPath}.json`, "keep report");
  await assert.rejects(
    encodeOverview({ inputPath, outputPath }),
    /already exists/,
  );
  assert.equal(readFileSync(`${outputPath}.json`, "utf8"), "keep report");
  rmSync(`${outputPath}.json`);
  writeFileSync(inputPath, bytes.subarray(0, 33));
  await assert.rejects(encodeOverview({ inputPath, outputPath }));
  noOutput(directory, outputPath);
});

test("standalone CLI emits a small WebP and its separate process memory report", (t) => {
  const directory = workspace(t),
    { inputPath } = fixture(directory),
    outputPath = join(directory, "cli.webp");
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "scripts/encode-overview.mjs", inputPath, outputPath],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 128 * 1024,
      env: { ...process.env, DISABLE_SYSTEM_FONTS_LOAD: "1" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, "exploretv-overview-webp-v1");
  assert.equal(report.webp.quality, 85);
  assert.equal(report.memory.explicitGc, true);
  assert.ok(report.osPeakRssBytes > 0);
  assert.equal(existsSync(outputPath), true);
  const bad = spawnSync(
    process.execPath,
    [
      "scripts/encode-overview.mjs",
      inputPath,
      join(directory, "bad.webp"),
      "--quality",
      "101",
    ],
    { cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 128 * 1024 },
  );
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /quality/);
  noOutput(directory, join(directory, "bad.webp"));
  const resizePath = join(directory, "cli-small.webp");
  const resized = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "scripts/encode-overview.mjs",
      inputPath,
      resizePath,
      "--max-width",
      "48",
      "--quality",
      "70",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 128 * 1024,
      env: { ...process.env, DISABLE_SYSTEM_FONTS_LOAD: "1" },
    },
  );
  assert.equal(resized.status, 0, resized.stderr);
  const resizeReport = JSON.parse(resized.stdout);
  assert.deepEqual(
    [
      resizeReport.webp.width,
      resizeReport.webp.height,
      resizeReport.webp.quality,
    ],
    [48, 32, 70],
  );
});
