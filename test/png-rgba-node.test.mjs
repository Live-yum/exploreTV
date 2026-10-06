import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { constants, deflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { decodePngRgba, PNG_RGBA_LIMITS } from "../core/png-rgba.mjs";
import { createNodePngRgbaDecoder } from "../scripts/png-rgba-node.mjs";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Independent fixture CRC; production validation is never bypassed.
function chunk(type, data = Buffer.alloc(0)) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < out.length - 4; i++) {
    crc ^= out[i];
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}

function header(width = 1, height = 1) {
  const bytes = Buffer.alloc(13);
  bytes.writeUInt32BE(width, 0);
  bytes.writeUInt32BE(height, 4);
  bytes[8] = 8;
  bytes[9] = 6;
  return chunk("IHDR", bytes);
}

const raw = Buffer.from([0, 255, 173, 61, 0]);
const makePng = (compressed = deflateSync(raw), width = 1, height = 1) =>
  Buffer.concat([
    SIGNATURE,
    header(width, height),
    chunk("IDAT", compressed),
    chunk("IEND"),
  ]);

test("first decode is strict, repeat is native and preserves hidden RGB and low alpha for all filters", () => {
  const decoder = createNodePngRgbaDecoder();
  const width = 19,
    height = 11,
    data = Buffer.alloc(width * height * 4);
  const alphas = [0, 1, 2, 3, 17, 127, 254, 255];
  for (let i = 0; i < width * height; i++)
    data.set(
      [
        (i * 79 + 253) & 255,
        (i * 113 + 127) & 255,
        (i * 17 + 63) & 255,
        alphas[i % alphas.length],
      ],
      i * 4,
    );
  for (let filterType = 0; filterType <= 4; filterType++) {
    const png = PNG.sync.write(
      { width, height, data },
      { colorType: 6, inputColorType: 6, bitDepth: 8, filterType },
    );
    const before = Buffer.from(png);
    for (let pass = 0; pass < 2; pass++) {
      const result = decoder.decode(png);
      assert.ok(result.data instanceof Uint8ClampedArray);
      assert.deepEqual(Buffer.from(result.data), data);
      assert.equal(result.width, width);
      assert.equal(result.height, height);
      assert.equal(result.data.byteOffset, 0);
      if (!pass)
        assert.equal(result.data.buffer.byteLength, (width * 4 + 1) * height);
      else
        assert.ok(
          [width * height * 4, (width * 4 + 1) * height + 1].includes(
            result.data.buffer.byteLength,
          ),
        );
      assert.deepEqual(
        png,
        before,
        "in-place raw reconstruction leaves the encoded PNG unchanged",
      );
    }
  }
  assert.equal(decoder.stats.strictInflations, 5);
  assert.equal(decoder.stats.nativeInflations, 5);
});

test("stored, fixed and dynamic valid streams use exact native decoding on repeat", () => {
  const width = 91,
    height = 31,
    filtered = Buffer.alloc((width * 4 + 1) * height);
  for (let i = 0; i < filtered.length; i++) filtered[i] = (i * 37) & 255;
  for (let y = 0; y < height; y++) filtered[y * (width * 4 + 1)] = 0;
  const decoder = createNodePngRgbaDecoder();
  for (const options of [
    { level: 0 },
    { strategy: constants.Z_FIXED, level: 9 },
    { level: 9 },
  ]) {
    const png = makePng(deflateSync(filtered, options), width, height);
    assert.deepEqual(decoder.decode(png), decodePngRgba(png));
    assert.deepEqual(decoder.decode(png), decodePngRgba(png));
  }
  assert.equal(decoder.stats.strictInflations, 3);
  assert.equal(decoder.stats.nativeInflations, 3);
});

test("metadata cache is bounded, evicts least-recently-used streams, and clears", () => {
  for (const maxStreams of [0, -1, 513, 1.5, NaN])
    assert.throws(() => createNodePngRgbaDecoder({ maxStreams }), /budget/);
  const decoder = createNodePngRgbaDecoder({ maxStreams: 2 });
  const pngs = [1, 2, 3].map((n) =>
    makePng(deflateSync(Buffer.from([0, n, 2, 3, 4]))),
  );
  decoder.decode(pngs[0]);
  decoder.decode(pngs[1]);
  decoder.decode(pngs[0]);
  decoder.decode(pngs[2]);
  decoder.decode(pngs[0]);
  assert.equal(decoder.stats.strictInflations, 3);
  assert.equal(decoder.stats.nativeInflations, 2);
  assert.equal(decoder.stats.cachedStreams, 2);
  assert.equal(decoder.stats.evictions, 1);
  decoder.decode(pngs[1]);
  assert.equal(decoder.stats.strictInflations, 4);
  decoder.clear();
  assert.equal(decoder.stats.cachedStreams, 0);
  decoder.decode(pngs[0]);
  assert.equal(decoder.stats.strictInflations, 5);
});

test("reference-valid streams rejected by native zlib remain reference-only after one fallback", () => {
  // HDIST=30 declares 31 distance codes. The reference accepts these unused
  // codes; native zlib rejects the table before decoding the literal pixels.
  const compressed = Buffer.from(
    "780105de010400000002a0ff1f000000000000000000000000000000000000000000000000000000000000c001000000a09c030019000b",
    "hex",
  );
  const png = makePng(compressed),
    decoder = createNodePngRgbaDecoder(),
    expected = decodePngRgba(png);
  assert.deepEqual(Array.from(expected.data), [1, 2, 3, 4]);
  for (let pass = 0; pass < 4; pass++)
    assert.deepEqual(decoder.decode(png), expected);
  assert.equal(decoder.stats.strictInflations, 4);
  assert.equal(decoder.stats.nativeFallbacks, 1);
  assert.equal(decoder.stats.nativeInflations, 0);
  assert.equal(decoder.stats.cachedStreams, 1);
  const ordinary = makePng();
  decoder.decode(ordinary);
  decoder.decode(ordinary);
  assert.equal(decoder.stats.nativeInflations, 1);
  assert.equal(decoder.stats.nativeFallbacks, 1);
  assert.equal(decoder.stats.cachedStreams, 2);
});

test("warm streams still undergo all PNG checks and dimensions are part of acceptance", () => {
  const compressed = deflateSync(raw),
    png = makePng(compressed),
    decoder = createNodePngRgbaDecoder();
  decoder.decode(png);
  decoder.decode(png);
  const badCrc = Buffer.from(png);
  badCrc[badCrc.length - 1] ^= 1;
  for (const bad of [
    badCrc,
    makePng(compressed, 2, 1),
    Buffer.concat([png, Buffer.from([0])]),
    Buffer.concat([
      SIGNATURE,
      header(),
      chunk("acTL"),
      chunk("IDAT", compressed),
      chunk("IEND"),
    ]),
    Buffer.concat([
      SIGNATURE,
      header(),
      chunk("IDAT", compressed),
      chunk("tEXt"),
      chunk("IDAT", compressed),
      chunk("IEND"),
    ]),
  ]) {
    for (let pass = 0; pass < 2; pass++)
      assert.throws(() => decoder.decode(bad), /PNG:/);
  }
  assert.equal(decoder.stats.strictInflations, 1);
  assert.equal(decoder.stats.nativeInflations, 1);
  // DEFLATE acceptance does not accept invalid row filters, even on native hits.
  const badFilter = makePng(deflateSync(Buffer.from([5, 1, 2, 3, 4])));
  for (let pass = 0; pass < 2; pass++)
    assert.throws(() => decoder.decode(badFilter), /row filter/);
});

test("trailing, concatenated, oversized, short, corrupt and dictionary streams never become accepted", () => {
  const good = deflateSync(raw),
    badAdler = Buffer.from(good),
    badHeader = Buffer.from(good);
  badAdler[badAdler.length - 1] ^= 1;
  badHeader[0] ^= 1;
  const invalid = [
    Buffer.concat([good, Buffer.from([0])]),
    Buffer.concat([good, good]),
    Buffer.concat([good.subarray(0, -4), Buffer.from([0]), good.subarray(-4)]),
    badAdler,
    badHeader,
    deflateSync(raw, { dictionary: Buffer.from([1, 2, 3]) }),
    deflateSync(Buffer.alloc(4)),
    deflateSync(Buffer.alloc(1024 * 1024)),
    Buffer.from("78011b0300000000", "hex"),
    Buffer.from("7801033e00000000", "hex"),
  ];
  for (let end = 0; end < good.length; end++)
    invalid.push(good.subarray(0, end));
  const decoder = createNodePngRgbaDecoder();
  decoder.decode(makePng(good));
  for (const bytes of invalid) {
    const png = makePng(bytes);
    for (let pass = 0; pass < 2; pass++)
      assert.throws(() => decoder.decode(png), /PNG:/);
  }
  assert.equal(decoder.stats.strictInflations, 1);
  assert.equal(decoder.stats.nativeInflations, 0);
  assert.equal(decoder.stats.cachedStreams, 1);
});

test("reference DEFLATE block budget remains exact on cold and repeated inputs", () => {
  const stream = deflateSync(raw, { level: 0 }),
    emptyBlock = Buffer.from([0, 0, 0, 255, 255]),
    decoder = createNodePngRgbaDecoder();
  for (const count of [
    PNG_RGBA_LIMITS.deflateBlocks - 1,
    PNG_RGBA_LIMITS.deflateBlocks,
  ]) {
    const prefix = Buffer.alloc(count * emptyBlock.length);
    for (let i = 0; i < count; i++)
      prefix.set(emptyBlock, i * emptyBlock.length);
    const png = makePng(
      Buffer.concat([stream.subarray(0, 2), prefix, stream.subarray(2)]),
    );
    for (let pass = 0; pass < 2; pass++) {
      if (count < PNG_RGBA_LIMITS.deflateBlocks)
        assert.deepEqual(
          Array.from(decoder.decode(png).data),
          [255, 173, 61, 0],
        );
      else assert.throws(() => decoder.decode(png), /block budget exceeded/);
    }
  }
  assert.equal(decoder.stats.strictInflations, 1);
  assert.equal(decoder.stats.nativeInflations, 1);
});

test("optional inflater output is still bounded to exact scanline size", () => {
  const png = makePng();
  assert.throws(
    () => decodePngRgba(png, { inflate: null }),
    /invalid inflater/,
  );
  for (const output of [null, [], new Uint8Array(4), new Uint8Array(6)])
    assert.throws(
      () => decodePngRgba(png, { inflate: () => output }),
      /does not match dimensions/,
    );
  const expected = decodePngRgba(png);
  assert.deepEqual(
    decodePngRgba(png, {
      inflate: (bytes, length, strict) => strict(bytes, length),
    }),
    expected,
  );
});

const assetDir = new URL("../example/assets/", import.meta.url);
test(
  "all bundled source textures match reference RGBA on cold and native repeated decoding",
  {
    skip: !existsSync(assetDir),
  },
  () => {
    const decoder = createNodePngRgbaDecoder();
    const names = readdirSync(assetDir)
      .filter((name) => name.endsWith(".png"))
      .sort();
    assert.ok(names.length > 0);
    for (const name of names) {
      const png = readFileSync(new URL(name, assetDir));
      const before = Buffer.from(png),
        expected = decodePngRgba(png);
      assert.deepEqual(decoder.decode(png), expected, `${name}: strict`);
      assert.deepEqual(decoder.decode(png), expected, `${name}: native`);
      assert.deepEqual(png, before, `${name}: immutable encoded input`);
    }
    assert.ok(decoder.stats.nativeInflations >= names.length);
    assert.ok(decoder.stats.cachedStreams <= 512);
  },
);

test("tiny native output rejects the oversized minimum zlib slab", () => {
  const png = makePng(),
    before = Buffer.from(png),
    decoder = createNodePngRgbaDecoder();
  const cold = decoder.decode(png),
    warm = decoder.decode(png);
  assert.equal(cold.data.buffer.byteLength, 5);
  assert.equal(warm.data.buffer.byteLength, 4);
  assert.deepEqual(cold, warm);
  assert.deepEqual(png, before);
});

test("in-place node reconstruction handles all filters on tall, narrow and wide rows", () => {
  const decoder = createNodePngRgbaDecoder();
  for (const [width, height] of [
    [1, 1024],
    [2, 53],
    [35, 47],
    [512, 2],
  ])
    for (let filterType = 0; filterType < 5; filterType++) {
      const data = Buffer.alloc(width * height * 4);
      for (let i = 0; i < data.length; i++)
        data[i] = (i * 43 + (i >>> 5) * 21) % 256;
      const png = PNG.sync.write(
        { width, height, data },
        { colorType: 6, inputColorType: 6, filterType },
      );
      const before = Buffer.from(png);
      for (let pass = 0; pass < 2; pass++)
        assert.deepEqual(Buffer.from(decoder.decode(png).data), data);
      assert.deepEqual(png, before);
    }
});

test("large native repeat retains one tightly sized inflated backing buffer", () => {
  const width = 128,
    height = 64,
    data = Buffer.alloc(width * height * 4, 173);
  const png = PNG.sync.write(
    { width, height, data },
    { colorType: 6, inputColorType: 6, filterType: 4 },
  );
  const decoder = createNodePngRgbaDecoder();
  const cold = decoder.decode(png),
    warm = decoder.decode(png);
  assert.equal(cold.data.buffer.byteLength, (width * 4 + 1) * height);
  assert.equal(warm.data.buffer.byteLength, (width * 4 + 1) * height + 1);
  assert.deepEqual(Buffer.from(cold.data), data);
  assert.deepEqual(Buffer.from(warm.data), data);
});
