import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  boxDownsampleRgbaNative,
  nativeReducerStatus,
  trimNativeMemory,
} from "../scripts/native-reducer.mjs";

// Independent pixel-scatter oracle: accumulate each source pixel into its output
// bin, rather than walking factor-sized source blocks as either reducer does.
function oracle(source, width, height, factor) {
  const outWidth = width / factor,
    outHeight = height / factor;
  const sums = new Float64Array(outWidth * outHeight * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sourceIndex = (y * width + x) * 4;
      const outputIndex =
        (Math.floor(y / factor) * outWidth + Math.floor(x / factor)) * 4;
      const alpha = source[sourceIndex + 3];
      sums[outputIndex] += source[sourceIndex] * alpha;
      sums[outputIndex + 1] += source[sourceIndex + 1] * alpha;
      sums[outputIndex + 2] += source[sourceIndex + 2] * alpha;
      sums[outputIndex + 3] += alpha;
    }
  const result = Buffer.alloc(outWidth * outHeight * 4);
  for (let i = 0; i < result.length; i += 4) {
    const alpha = sums[i + 3];
    for (let channel = 0; channel < 3; channel++)
      result[i + channel] = alpha
        ? Math.floor(sums[i + channel] / alpha + 0.5)
        : 0;
    result[i + 3] = Math.floor(alpha / (factor * factor) + 0.5);
  }
  return result;
}

let seed = 0xc0ffee;
function randomByte() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 24;
}

test("optional reducer matches independent area integration for all factors, alpha and offset views", () => {
  for (let factor = 1; factor <= 16; factor++) {
    const width = factor * 7,
      height = factor * 5;
    const backing = new Uint8ClampedArray(width * height * 4 + 31);
    const source = backing.subarray(13, 13 + width * height * 4);
    for (let i = 0; i < source.length; i++) source[i] = randomByte();
    for (let i = 0; i < source.length; i += 52) source[i + 3] = 0;
    for (let i = 4; i < source.length; i += 44) source[i + 3] = 255;
    const before = Buffer.from(source);
    const actual = boxDownsampleRgbaNative(source, width, height, factor);
    assert.ok(Buffer.isBuffer(actual));
    assert.deepEqual(
      actual,
      oracle(source, width, height, factor),
      `factor ${factor}`,
    );
    assert.deepEqual(Buffer.from(source), before, "input remains unchanged");
  }
});

test("optional reducer retains single-pixel coverage, transparent RGB and exact half ties", () => {
  const transparent = Buffer.from([
    255, 123, 45, 0, 255, 255, 255, 0, 8, 8, 8, 0, 9, 9, 9, 0,
  ]);
  assert.deepEqual(
    [...boxDownsampleRgbaNative(transparent, 2, 2, 2)],
    [0, 0, 0, 0],
  );
  const half = Buffer.from([0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...boxDownsampleRgbaNative(half, 2, 2, 2)], [1, 1, 1, 1]);
  const single = Buffer.alloc(16 * 16 * 4);
  single.fill(255, 0, 4);
  assert.deepEqual(
    [...boxDownsampleRgbaNative(single, 16, 16, 16)],
    [255, 255, 255, 1],
  );
});

test("native overview mask preserves odd core offsets and skips only proven cells", () => {
  const width = 3 * 16,
    height = 2 * 16,
    factor = 16;
  const source = Buffer.alloc(width * height * 4);
  for (let i = 0; i < source.length; i++) source[i] = randomByte();
  const expected = oracle(source, width, height, factor);
  const safe = new Uint8Array(7 * 6),
    rgba = new Uint8ClampedArray(safe.length * 4);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 3; x++) {
      const tile = (y + 3) * 7 + x + 1;
      if ((x + y) % 2 === 0) {
        safe[tile] = 1;
        rgba.set(
          expected.subarray((y * 3 + x) * 4, (y * 3 + x) * 4 + 4),
          tile * 4,
        );
        // Mutating a proven source block makes the test sensitive to mask use.
        for (let sy = y * 16; sy < (y + 1) * 16; sy++)
          source.fill(
            0,
            (sy * width + x * 16) * 4,
            (sy * width + (x + 1) * 16) * 4,
          );
      }
    }
  assert.deepEqual(
    boxDownsampleRgbaNative(source, width, height, factor, {
      safe,
      rgba,
      widthTiles: 7,
      offsetX: 1,
      offsetY: 3,
    }),
    expected,
  );
});

test("optional reducer rejects inconsistent dimensions and masks before native access", () => {
  const source = Buffer.alloc(16 * 16 * 4);
  const mask = {
    safe: new Uint8Array(1),
    rgba: new Uint8Array(4),
    widthTiles: 1,
  };
  for (const args of [
    [source, 0, 16, 16],
    [source, 16.5, 16, 16],
    [source, 16, 16, 0],
    [source, 16, 16, 17],
    [source, 15, 16, 16],
    [source.subarray(1), 16, 16, 16],
    [Array.from(source), 16, 16, 16],
    [new Uint16Array(1024), 16, 16, 16],
  ])
    assert.throws(() => boxDownsampleRgbaNative(...args), /Invalid RGBA/);
  for (const invalid of [
    { ...mask, widthTiles: 0 },
    { ...mask, offsetX: 1 },
    { ...mask, offsetY: 1 },
    { ...mask, rgba: new Uint8Array(3) },
    { ...mask, safe: [] },
    { ...mask, offsetX: -1 },
    { ...mask, offsetY: 0.5 },
  ])
    assert.throws(
      () => boxDownsampleRgbaNative(source, 16, 16, 16, invalid),
      /Invalid native/,
    );
  assert.throws(
    () => boxDownsampleRgbaNative(source, 16, 16, 8, mask),
    /Invalid native/,
  );
});

test(
  "native addon independently rejects oversized and malformed direct calls",
  { skip: !nativeReducerStatus.available },
  () => {
    const require = createRequire(import.meta.url);
    const addon = require(
      fileURLToPath(
        new URL(
          `../artifacts/native/native-reducer-${process.platform}-${process.arch}.node`,
          import.meta.url,
        ),
      ),
    );
    for (const args of [
      [new Uint8Array(0), 0x80000000, 0x80000000, 16],
      [Buffer.alloc(4), 0x100000001, 1, 1],
      [Buffer.alloc(4), 1, 1, 1, new Uint8Array(1), new Uint8Array(4), 1, 0, 0],
      [Buffer.alloc(4), 1, 1, 1, null],
      [new Uint16Array(4), 1, 1, 1],
    ])
      assert.throws(() => addon.downsampleRgba(...args));
  },
);

test("explicitly disabled native reducer uses byte-identical JavaScript fallback", () => {
  const moduleUrl = new URL("../scripts/native-reducer.mjs", import.meta.url)
    .href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { boxDownsampleRgbaNative, nativeReducerStatus, trimNativeMemory } from ${JSON.stringify(moduleUrl)};
    import assert from 'node:assert/strict';
    assert.equal(nativeReducerStatus.available, false);
    assert.equal(nativeReducerStatus.nativeMemoryTrim.available, false);
    assert.deepEqual(trimNativeMemory(), {available:false, released:false});
    const source = Buffer.from([0,0,0,1,1,1,1,1,0,0,0,0,0,0,0,0]);
    assert.deepEqual([...boxDownsampleRgbaNative(source,2,2,2)], [1,1,1,1]);
    const masked = boxDownsampleRgbaNative(Buffer.alloc(1024),16,16,16,{
      safe: Uint8Array.of(1), rgba: Uint8Array.of(3,4,5,255), widthTiles:1,
    });
    assert.deepEqual([...masked], [3,4,5,255]);
  `,
    ],
    {
      env: { ...process.env, EXPLORETV_DISABLE_NATIVE_REDUCER: "1" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("allocator trimming preserves live buffers, offset views and native reduction results", () => {
  const source = Buffer.alloc(256 * 128 * 4);
  for (let i = 0; i < source.length; i++) source[i] = (i * 37 + (i >>> 8)) & 255;
  const clampedBacking = new Uint8ClampedArray(source.length + 31);
  clampedBacking.set(source, 13);
  const offsetView = clampedBacking.subarray(13, 13 + source.length);
  const reduced = boxDownsampleRgbaNative(offsetView, 256, 128, 16);
  const expected = oracle(source, 256, 128, 16);
  const liveBuffer = Buffer.alloc(2 * 1024 * 1024, 0xa7);
  for (let attempt = 0; attempt < 3; attempt++) {
    const status = trimNativeMemory();
    assert.equal(status.available, nativeReducerStatus.nativeMemoryTrim.available);
    assert.equal(typeof status.released, "boolean");
    if (!status.available) assert.equal(status.released, false);
    assert.deepEqual(Buffer.from(offsetView), source);
    assert.deepEqual(reduced, expected);
    assert.deepEqual(boxDownsampleRgbaNative(offsetView, 256, 128, 16), expected);
    for (const byte of liveBuffer) assert.equal(byte, 0xa7);
  }
  // Retained storage remains writable after trimming, including a native output.
  reduced[0] ^= 255;
  offsetView[0] ^= 255;
  liveBuffer[liveBuffer.length - 1] = 0x3c;
  assert.equal(reduced[0], expected[0] ^ 255);
  assert.equal(offsetView[0], source[0] ^ 255);
  assert.equal(liveBuffer[liveBuffer.length - 1], 0x3c);
});

test("allocator trimming can be disabled independently of the numerical reducer", () => {
  const moduleUrl = new URL("../scripts/native-reducer.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { boxDownsampleRgbaNative, nativeReducerStatus, trimNativeMemory } from ${JSON.stringify(moduleUrl)};
    import assert from 'node:assert/strict';
    assert.equal(nativeReducerStatus.available, ${nativeReducerStatus.available});
    assert.equal(nativeReducerStatus.nativeMemoryTrim.available, false);
    assert.match(nativeReducerStatus.nativeMemoryTrim.reason, /EXPLORETV_DISABLE_NATIVE_TRIM/);
    assert.deepEqual(trimNativeMemory(), {available:false, released:false});
    assert.deepEqual([...boxDownsampleRgbaNative(Buffer.from([3,4,5,255]),1,1,1)], [3,4,5,255]);
  `,
    ],
    {
      env: { ...process.env, EXPLORETV_DISABLE_NATIVE_TRIM: "1" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
