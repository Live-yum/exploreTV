import test from "node:test";
import assert from "node:assert/strict";
import { constants, deflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { decodePngRgba, PNG_RGBA_LIMITS } from "../core/png-rgba.mjs";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Independent bit-at-a-time CRC for test fixtures (no production helper used).
function chunk(type, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 4, "ascii");
  result.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < result.length - 4; i++) {
    crc ^= result[i];
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

function header(width = 1, height = 1, edits = {}) {
  const bytes = Buffer.alloc(13);
  bytes.writeUInt32BE(width, 0);
  bytes.writeUInt32BE(height, 4);
  bytes[8] = 8;
  bytes[9] = 6;
  for (const [offset, value] of Object.entries(edits))
    bytes[Number(offset)] = value;
  return chunk("IHDR", bytes);
}

function makePng(
  raw = Buffer.from([0, 7, 8, 9, 0]),
  width = 1,
  height = 1,
  options = {},
) {
  const compressed = options.compressed || deflateSync(raw, options.zlib);
  return Buffer.concat([
    SIGNATURE,
    header(width, height, options.edits),
    chunk("IDAT", compressed),
    chunk("IEND"),
  ]);
}

function syntheticPixels(width, height) {
  const data = Buffer.alloc(width * height * 4);
  const alphas = [0, 1, 2, 3, 17, 127, 254, 255];
  for (let i = 0; i < width * height; i++) {
    data.set(
      [
        (i * 79 + 253) & 255,
        (i * 113 + 127) & 255,
        (i * 17 + 63) & 255,
        alphas[i % alphas.length],
      ],
      i * 4,
    );
  }
  return data;
}

function rgbaPng(width, height, data, filterType) {
  return PNG.sync.write(
    { width, height, data },
    { colorType: 6, inputColorType: 6, bitDepth: 8, filterType },
  );
}

function unpackChunks(png) {
  const chunks = [];
  for (let position = 8; position < png.length; ) {
    const length = png.readUInt32BE(position);
    chunks.push({
      type: png.toString("ascii", position + 4, position + 8),
      data: png.subarray(position + 8, position + 8 + length),
    });
    position += length + 12;
  }
  return chunks;
}

test("all five row filters retain exact hidden RGB and low-alpha RGBA", () => {
  const width = 19,
    height = 11,
    expected = syntheticPixels(width, height);
  for (let filter = 0; filter <= 4; filter++) {
    const png = rgbaPng(width, height, expected, filter);
    const before = Buffer.from(png);
    const actual = decodePngRgba(png);
    assert.equal(actual.width, width);
    assert.equal(actual.height, height);
    assert.ok(actual.data instanceof Uint8ClampedArray);
    assert.deepEqual(Buffer.from(actual.data), expected, `filter ${filter}`);
    assert.deepEqual(png, before, "input is not changed");
  }
});

test("golden source channels do not pass through premultiplied canvas pixels", () => {
  const expected = Buffer.from([
    255, 173, 61, 0, 251, 127, 63, 1, 149, 201, 253, 2, 17, 79, 233, 3, 83, 131,
    197, 255,
  ]);
  const encoded = rgbaPng(5, 1, expected, 4);
  assert.deepEqual(
    Array.from(decodePngRgba(encoded).data),
    Array.from(expected),
  );
});

test("stored, fixed, and dynamic DEFLATE blocks match original bytes", () => {
  const width = 91,
    height = 31;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const expected = syntheticPixels(width, height);
  for (let y = 0; y < height; y++)
    expected.copy(
      raw,
      y * (width * 4 + 1) + 1,
      y * width * 4,
      (y + 1) * width * 4,
    );
  const cases = [
    [{ level: 0 }, 0],
    [{ strategy: constants.Z_FIXED, level: 9 }, 1],
    [{ level: 9 }, 2],
  ];
  for (const [options, type] of cases) {
    const compressed = deflateSync(raw, options);
    assert.equal(
      (compressed[2] >>> 1) & 3,
      type,
      "fixture uses requested block type",
    );
    assert.deepEqual(
      Buffer.from(
        decodePngRgba(makePng(raw, width, height, { compressed })).data,
      ),
      expected,
    );
  }
});

test("nonzero byte offsets, ArrayBuffers and DataViews are decoded without leaking adjacent bytes", () => {
  const encoded = makePng();
  const wrapper = Buffer.concat([
    Buffer.from([99, 99, 99]),
    encoded,
    Buffer.from([99]),
  ]);
  const view = wrapper.subarray(3, 3 + encoded.length);
  assert.deepEqual(Array.from(decodePngRgba(view).data), [7, 8, 9, 0]);
  const array = Uint8Array.from(encoded);
  assert.deepEqual(Array.from(decodePngRgba(array.buffer).data), [7, 8, 9, 0]);
  assert.deepEqual(
    Array.from(
      decodePngRgba(new DataView(view.buffer, view.byteOffset, view.length))
        .data,
    ),
    [7, 8, 9, 0],
  );
  for (const value of [null, "PNG", [], { length: 20 }])
    assert.throws(() => decodePngRgba(value), /ArrayBuffer/);
});

test("consecutive IDAT chunks, optional palette and ignored metadata preserve source channels", () => {
  const original = rgbaPng(19, 11, syntheticPixels(19, 11), 4);
  const pieces = unpackChunks(original);
  const ihdr = pieces.find((p) => p.type === "IHDR");
  const compressed = Buffer.concat(
    pieces.filter((p) => p.type === "IDAT").map((p) => p.data),
  );
  const parts = [
    SIGNATURE,
    chunk("IHDR", ihdr.data),
    chunk("gAMA", Buffer.from([0, 1, 134, 160])),
    chunk("PLTE", Buffer.from([7, 8, 9])),
  ];
  parts.push(chunk("IDAT"));
  for (let i = 0; i < compressed.length; i += 7)
    parts.push(chunk("IDAT", compressed.subarray(i, i + 7)));
  parts.push(
    chunk("IDAT"),
    chunk("tEXt", Buffer.from("test\0original synthetic fixture")),
    chunk("IEND"),
  );
  assert.deepEqual(
    Buffer.from(decodePngRgba(Buffer.concat(parts)).data),
    syntheticPixels(19, 11),
  );
});

test("signature, truncation, chunk lengths and CRCs are checked before decode", () => {
  const good = makePng();
  for (let end = 0; end < good.length; end++)
    assert.throws(
      () => decodePngRgba(good.subarray(0, end)),
      /PNG:/,
      `truncation ${end}`,
    );
  const magic = Buffer.from(good);
  magic[3] ^= 1;
  assert.throws(() => decodePngRgba(magic), /signature/);
  const length = Buffer.from(good);
  length.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => decodePngRgba(length), /bounds/);
  for (const position of [29, 41, good.length - 1]) {
    const bad = Buffer.from(good);
    bad[position] ^= 1;
    assert.throws(() => decodePngRgba(bad), /CRC/);
  }
});

test("encoded, dimension, decoded-byte and chunk-count limits are enforced", () => {
  assert.throws(
    () => decodePngRgba(new Uint8Array(PNG_RGBA_LIMITS.encodedBytes + 1)),
    /encoded size/,
  );
  for (const [width, height] of [
    [0, 1],
    [1, 0],
    [4097, 1],
    [1, 4097],
    [4096, 1025],
    [0xffffffff, 0xffffffff],
  ]) {
    assert.throws(
      () => decodePngRgba(makePng(undefined, width, height)),
      /dimensions/,
    );
  }
  const emptyChunks = Array.from({ length: PNG_RGBA_LIMITS.chunks }, () =>
    chunk("tEXt"),
  );
  assert.throws(
    () =>
      decodePngRgba(
        Buffer.concat([SIGNATURE, header(), ...emptyChunks, chunk("IEND")]),
      ),
    /chunk count/,
  );
  const raw = Buffer.alloc(4096 * 4 + 1);
  assert.equal(decodePngRgba(makePng(raw, 4096, 1)).data.length, 4096 * 4);
});

test("unsupported color formats, depth, compression, filtering, and interlacing fail closed", () => {
  for (const edits of [
    { 8: 16 },
    { 8: 4 },
    { 9: 0 },
    { 9: 2 },
    { 9: 3 },
    { 9: 4 },
    { 10: 1 },
    { 11: 1 },
    { 12: 1 },
  ])
    assert.throws(
      () => decodePngRgba(makePng(undefined, 1, 1, { edits })),
      /noninterlaced RGBA8/,
    );
  assert.throws(
    () => decodePngRgba(makePng(Buffer.from([5, 0, 0, 0, 0]))),
    /row filter/,
  );
});

test("the exact 16 MiB decoded boundary is accepted without expanding its budget", () => {
  const width = 4096,
    height = 1024;
  const expected = Buffer.alloc(PNG_RGBA_LIMITS.decodedBytes);
  const result = decodePngRgba(rgbaPng(width, height, expected, 0));
  assert.equal(result.width, width);
  assert.equal(result.height, height);
  assert.equal(result.data.byteLength, PNG_RGBA_LIMITS.decodedBytes);
  assert.deepEqual(Buffer.from(result.data), expected);
});

test("invalid chunk names, critical chunks, animation, and RGBA transparency metadata are rejected", () => {
  const data = chunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3, 4])));
  for (const type of ["A1CD", "ABcD", "ABCD", "acTL", "fcTL", "fdAT", "tRNS"])
    assert.throws(
      () =>
        decodePngRgba(
          Buffer.concat([
            SIGNATURE,
            header(),
            chunk(type),
            data,
            chunk("IEND"),
          ]),
        ),
      /chunk|animated|tRNS/,
    );
});

test("IHDR, PLTE, IDAT, and IEND ordering and chunk shapes are strict", () => {
  const h = header(),
    idat = chunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3, 4]))),
    end = chunk("IEND");
  const badSequences = [
    [idat, h, end],
    [h, h, idat, end],
    [h, end],
    [h, chunk("IDAT"), end],
    [h, idat],
    [h, idat, end, end],
    [h, idat, end, Buffer.from([0])],
    [h, idat, chunk("tEXt"), idat, end],
    [h, idat, chunk("PLTE", Buffer.from([1, 2, 3])), end],
    [h, chunk("PLTE", Buffer.from([1])), idat, end],
    [h, chunk("PLTE"), idat, end],
    [h, chunk("PLTE", Buffer.alloc(771)), idat, end],
    [
      h,
      chunk("PLTE", Buffer.from([1, 2, 3])),
      chunk("PLTE", Buffer.from([1, 2, 3])),
      idat,
      end,
    ],
    [chunk("IHDR", Buffer.alloc(12)), idat, end],
    [h, idat, chunk("IEND", Buffer.from([1]))],
  ];
  for (const pieces of badSequences)
    assert.throws(
      () => decodePngRgba(Buffer.concat([SIGNATURE, ...pieces])),
      /PNG:/,
    );
});

test("inflation is bounded by exact scanline size for literals, stored data and back-references", () => {
  const bomb = Buffer.alloc(1024 * 1024);
  for (const options of [
    { level: 0 },
    { level: 9 },
    { strategy: constants.Z_FIXED },
  ])
    assert.throws(
      () => decodePngRgba(makePng(bomb, 1, 1, { zlib: options })),
      /exceeds dimensions/,
    );
  assert.throws(
    () => decodePngRgba(makePng(Buffer.from([0, 1, 2, 3, 4, 5]))),
    /exceeds dimensions/,
  );
  assert.throws(
    () => decodePngRgba(makePng(Buffer.from([0, 1, 2, 3]))),
    /does not match dimensions/,
  );
});

test("zlib headers, Adler checksum, exact stream end, and dictionaries are checked", () => {
  const good = deflateSync(Buffer.from([0, 7, 8, 9, 0]));
  const invalidHeader = Buffer.from(good);
  invalidHeader[0] ^= 1;
  assert.throws(
    () =>
      decodePngRgba(makePng(undefined, 1, 1, { compressed: invalidHeader })),
    /zlib header/,
  );
  const badAdler = Buffer.from(good);
  badAdler[badAdler.length - 1] ^= 1;
  assert.throws(
    () => decodePngRgba(makePng(undefined, 1, 1, { compressed: badAdler })),
    /Adler/,
  );
  const trailing = Buffer.concat([
    good.subarray(0, -4),
    Buffer.from([0]),
    good.subarray(-4),
  ]);
  assert.throws(
    () => decodePngRgba(makePng(undefined, 1, 1, { compressed: trailing })),
    /trailing/,
  );
  const twoStreams = Buffer.concat([good, good]);
  assert.throws(
    () => decodePngRgba(makePng(undefined, 1, 1, { compressed: twoStreams })),
    /trailing/,
  );
  const dictionary = deflateSync(Buffer.from([0, 7, 8, 9, 0]), {
    dictionary: Buffer.from([7, 8, 9]),
  });
  assert.throws(
    () => decodePngRgba(makePng(undefined, 1, 1, { compressed: dictionary })),
    /dictionary/,
  );
  for (let end = 0; end < good.length; end++)
    assert.throws(
      () =>
        decodePngRgba(
          makePng(undefined, 1, 1, { compressed: good.subarray(0, end) }),
        ),
      /PNG:/,
    );
});

test("malformed stored and reserved DEFLATE block types are rejected", () => {
  const reserved = Buffer.from([0x78, 0x9c, 0x07, 0, 0, 0, 0]);
  assert.throws(
    () => decodePngRgba(makePng(undefined, 1, 1, { compressed: reserved })),
    /reserved DEFLATE block/,
  );
  const badStored = Buffer.from([
    0x78, 0x01, 0x01, 0x05, 0, 0xff, 0xff, 0, 1, 2, 3, 4, 0, 0, 0, 0,
  ]);
  assert.throws(
    () => decodePngRgba(makePng(undefined, 1, 1, { compressed: badStored })),
    /stored DEFLATE length/,
  );
});

test("DEFLATE block budget prevents excessive empty-block work", () => {
  const stream = deflateSync(Buffer.from([0, 7, 8, 9, 0]), { level: 0 });
  const emptyBlock = Buffer.from([0, 0, 0, 255, 255]);
  for (const count of [
    PNG_RGBA_LIMITS.deflateBlocks - 1,
    PNG_RGBA_LIMITS.deflateBlocks,
  ]) {
    const prefix = Buffer.alloc(count * emptyBlock.length);
    for (let i = 0; i < count; i++)
      prefix.set(emptyBlock, i * emptyBlock.length);
    const compressed = Buffer.concat([
      stream.subarray(0, 2),
      prefix,
      stream.subarray(2),
    ]);
    const encoded = makePng(undefined, 1, 1, { compressed });
    if (count < PNG_RGBA_LIMITS.deflateBlocks)
      assert.deepEqual(Array.from(decodePngRgba(encoded).data), [7, 8, 9, 0]);
    else assert.throws(() => decodePngRgba(encoded), /block budget exceeded/);
  }
});

test("corrupt Huffman trees and reserved symbols fail before any checksum fallback", () => {
  // Original hand-built RFC 1951 vectors from the independent decoder audit.
  // Adler trailers are intentionally zero: the named structural error must be
  // detected before checksum validation, rather than accidentally reaching it.
  const vectors = [
    ["empty code tree", "78010500000000000000", /empty Huffman tree/],
    [
      "oversubscribed code tree",
      "78010500920000000000",
      /oversubscribed Huffman tree/,
    ],
    ["incomplete code tree", "78010500240000000000", /incomplete Huffman tree/],
    ["repeat without predecessor", "78010500022400000000", /no predecessor/],
    [
      "repeat overrun",
      "7801050080e4ff1f00000000",
      /repeat exceeds tree bounds/,
    ],
    ["missing EOB", "7801050080e47f1b00000000", /lacks end-of-block/],
    [
      "empty distance used",
      "78010dc0010400000080a000000000000000000000000000000000000000000000000000000000000000006f00000000",
      /invalid Huffman symbol/,
    ],
    [
      "back-reference before start",
      "78010dc0010400000080a00000000000000000000000000000000000000000000000000000000000000000df0000000000",
      /back-reference distance/,
    ],
    [
      "reserved fixed length 286",
      "78011b0300000000",
      /reserved DEFLATE length/,
    ],
    [
      "reserved fixed distance 30",
      "7801033e00000000",
      /reserved DEFLATE distance/,
    ],
  ];
  for (const [name, hex, pattern] of vectors) {
    assert.throws(
      () =>
        decodePngRgba(
          makePng(undefined, 1, 1, { compressed: Buffer.from(hex, "hex") }),
        ),
      pattern,
      name,
    );
  }
});

test("deterministic synthetic fixtures cross-check pngjs over dimensions, filters and compression levels", () => {
  let state = 0xa18549;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let n = 0; n < 48; n++) {
    const width = 1 + (random() % 41),
      height = 1 + (random() % 27);
    const expected = Buffer.alloc(width * height * 4);
    for (let i = 0; i < expected.length; i++) expected[i] = random() >>> 24;
    const encoded = PNG.sync.write(
      { width, height, data: expected },
      { colorType: 6, filterType: n % 5, deflateLevel: n % 10 },
    );
    const actual = decodePngRgba(encoded);
    assert.deepEqual(Buffer.from(actual.data), expected, `fixture ${n}`);
    assert.deepEqual(
      Buffer.from(actual.data),
      PNG.sync.read(encoded).data,
      `pngjs oracle ${n}`,
    );
  }
});
