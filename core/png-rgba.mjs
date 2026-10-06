// Original, bounded PNG RGBA8 decoder. No canvas, platform APIs, or color
// conversion: even RGB hidden behind alpha=0 remains byte-for-byte intact.
// Format references: https://www.w3.org/TR/png-3/ and RFC 1950 / RFC 1951.
export const PNG_RGBA_LIMITS = Object.freeze({
  encodedBytes: 8 * 1024 * 1024,
  decodedBytes: 16 * 1024 * 1024,
  dimension: 4096,
  chunks: 4096,
  deflateBlocks: 4096,
});

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  CRC_TABLE[n] = value >>> 0;
}

function fail(message) {
  throw new Error(`PNG: ${message}`);
}

function uint32(bytes, offset) {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++)
    crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

class BitReader {
  constructor(bytes, end) {
    this.bytes = bytes;
    this.position = 2; // The two-byte zlib header has already been validated.
    this.end = end;
    this.value = 0;
    this.available = 0;
  }
  read(count) {
    while (this.available < count) {
      if (this.position >= this.end) fail("truncated DEFLATE stream");
      this.value |= this.bytes[this.position++] << this.available;
      this.available += 8;
    }
    const value = this.value & ((1 << count) - 1);
    this.value >>>= count;
    this.available -= count;
    return value;
  }
  align() {
    this.value = 0;
    this.available = 0;
  }
}

// Store canonical code ranges, rather than a large lookup table for every
// possible bit pattern. Maximum tree storage is fixed by the DEFLATE format.
function huffman(lengths, kind) {
  const counts = new Uint16Array(16);
  let max = 0;
  for (const length of lengths) {
    if (length > 15) fail("invalid Huffman code length");
    if (length) {
      counts[length]++;
      max = Math.max(max, length);
    }
  }
  if (!max) {
    if (kind !== "distance") fail("empty Huffman tree");
    return { max: 0 };
  }
  let remaining = 1;
  for (let length = 1; length <= 15; length++) {
    remaining = remaining * 2 - counts[length];
    if (remaining < 0) fail("oversubscribed Huffman tree");
  }
  if (remaining && (kind === "code-length" || max !== 1))
    fail("incomplete Huffman tree");
  const first = new Uint16Array(16);
  const offsets = new Uint16Array(16);
  let code = 0;
  let offset = 0;
  for (let length = 1; length <= 15; length++) {
    code = (code + counts[length - 1]) * 2;
    first[length] = code;
    offsets[length] = offset;
    offset += counts[length];
  }
  const symbols = new Uint16Array(offset);
  const next = offsets.slice();
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol];
    if (length) symbols[next[length]++] = symbol;
  }
  return { counts, first, offsets, symbols, max };
}

function readSymbol(reader, tree) {
  let code = 0;
  for (let length = 1; length <= tree.max; length++) {
    code = code * 2 + reader.read(1);
    const index = code - tree.first[length];
    if (index >= 0 && index < tree.counts[length])
      return tree.symbols[tree.offsets[length] + index];
  }
  fail("invalid Huffman symbol");
}

const FIXED_LITERAL_LENGTHS = new Uint8Array(288);
FIXED_LITERAL_LENGTHS.fill(8, 0, 144);
FIXED_LITERAL_LENGTHS.fill(9, 144, 256);
FIXED_LITERAL_LENGTHS.fill(7, 256, 280);
FIXED_LITERAL_LENGTHS.fill(8, 280);
const FIXED_LITERALS = huffman(FIXED_LITERAL_LENGTHS, "literal");
const FIXED_DISTANCES = huffman(new Uint8Array(32).fill(5), "distance");
const CODE_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];

function dynamicTrees(reader) {
  const literalCount = reader.read(5) + 257;
  const distanceCount = reader.read(5) + 1;
  const codeCount = reader.read(4) + 4;
  if (literalCount > 286) fail("invalid DEFLATE literal count");
  const codeLengths = new Uint8Array(19);
  for (let i = 0; i < codeCount; i++)
    codeLengths[CODE_ORDER[i]] = reader.read(3);
  const codeTree = huffman(codeLengths, "code-length");
  const lengths = new Uint8Array(literalCount + distanceCount);
  let i = 0;
  while (i < lengths.length) {
    const symbol = readSymbol(reader, codeTree);
    if (symbol < 16) lengths[i++] = symbol;
    else {
      if (symbol === 16 && !i) fail("Huffman repeat has no predecessor");
      const count =
        symbol === 16
          ? reader.read(2) + 3
          : symbol === 17
            ? reader.read(3) + 3
            : reader.read(7) + 11;
      const value = symbol === 16 ? lengths[i - 1] : 0;
      if (i + count > lengths.length)
        fail("Huffman repeat exceeds tree bounds");
      lengths.fill(value, i, i + count);
      i += count;
    }
  }
  if (!lengths[256]) fail("DEFLATE tree lacks end-of-block symbol");
  return [
    huffman(lengths.subarray(0, literalCount), "literal"),
    huffman(lengths.subarray(literalCount), "distance"),
  ];
}

function inflateZlib(bytes, expectedLength) {
  if (bytes.length < 6) fail("truncated zlib stream");
  const cmf = bytes[0],
    flags = bytes[1];
  if ((cmf & 15) !== 8 || cmf >>> 4 > 7 || (cmf * 256 + flags) % 31)
    fail("invalid zlib header");
  if (flags & 32) fail("zlib preset dictionary is unsupported");
  const windowSize = 1 << ((cmf >>> 4) + 8);
  const reader = new BitReader(bytes, bytes.length - 4);
  // This allocation is determined only by checked IHDR dimensions, never by
  // data inside the compressed stream. Every write checks the remaining room.
  const output = new Uint8Array(expectedLength);
  let written = 0,
    final = 0,
    blocks = 0;
  while (!final) {
    if (++blocks > PNG_RGBA_LIMITS.deflateBlocks)
      fail("DEFLATE block budget exceeded");
    final = reader.read(1);
    const type = reader.read(2);
    if (type === 0) {
      reader.align();
      const length = reader.read(16),
        complement = reader.read(16);
      if ((length ^ complement) !== 65535)
        fail("invalid stored DEFLATE length");
      if (written + length > expectedLength)
        fail("inflated output exceeds dimensions");
      if (reader.position + length > reader.end)
        fail("truncated stored DEFLATE block");
      output.set(
        bytes.subarray(reader.position, reader.position + length),
        written,
      );
      reader.position += length;
      written += length;
    } else if (type === 1 || type === 2) {
      const [literals, distances] =
        type === 1 ? [FIXED_LITERALS, FIXED_DISTANCES] : dynamicTrees(reader);
      while (true) {
        const symbol = readSymbol(reader, literals);
        if (symbol < 256) {
          if (written >= expectedLength)
            fail("inflated output exceeds dimensions");
          output[written++] = symbol;
        } else if (symbol === 256) break;
        else {
          if (symbol > 285) fail("reserved DEFLATE length symbol");
          const lengthIndex = symbol - 257;
          const length =
            LENGTH_BASE[lengthIndex] + reader.read(LENGTH_EXTRA[lengthIndex]);
          const distanceIndex = readSymbol(reader, distances);
          if (distanceIndex > 29) fail("reserved DEFLATE distance symbol");
          const distance =
            DISTANCE_BASE[distanceIndex] +
            reader.read(DISTANCE_EXTRA[distanceIndex]);
          if (distance > written || distance > windowSize)
            fail("invalid DEFLATE back-reference distance");
          if (written + length > expectedLength)
            fail("inflated output exceeds dimensions");
          // Deliberately allow overlap, as required for repeated runs.
          for (let i = 0; i < length; i++) {
            output[written] = output[written - distance];
            written++;
          }
        }
      }
    } else fail("reserved DEFLATE block type");
  }
  if (reader.position !== reader.end) fail("trailing bytes in zlib stream");
  if (written !== expectedLength)
    fail("inflated output does not match dimensions");
  let a = 1,
    b = 0;
  for (let start = 0; start < output.length; start += 5552) {
    const end = Math.min(start + 5552, output.length);
    for (let i = start; i < end; i++) {
      a += output[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  if (((b << 16) | a) >>> 0 !== uint32(bytes, bytes.length - 4))
    fail("zlib Adler-32 checksum mismatch");
  return output;
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const dl = Math.abs(prediction - left);
  const da = Math.abs(prediction - above);
  const du = Math.abs(prediction - upperLeft);
  return dl <= da && dl <= du ? left : da <= du ? above : upperLeft;
}

/**
 * Decode a static, noninterlaced, 8-bit RGBA (color type 6) PNG.
 * Ancillary metadata is CRC-checked but never decompressed/applied. APNG,
 * other pixel formats, unknown critical chunks, and trailing data are rejected.
 * Input may be an ArrayBuffer or an ArrayBuffer view. Returns straight RGBA.
 */
export function decodePngRgba(
  input,
  { inflate = inflateZlib, reuseInflatedBuffer = false } = {},
) {
  if (typeof inflate !== "function") fail("invalid inflater");
  if (typeof reuseInflatedBuffer !== "boolean")
    fail("invalid inflated-buffer reuse option");
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : null;
  if (!bytes) fail("expected an ArrayBuffer or byte view");
  if (bytes.length < 8 || bytes.length > PNG_RGBA_LIMITS.encodedBytes)
    fail("encoded size outside budget");
  if (SIGNATURE.some((value, i) => bytes[i] !== value))
    fail("invalid signature");
  let width = 0,
    height = 0,
    offset = 8,
    chunks = 0;
  let sawHeader = false,
    sawPalette = false,
    sawData = false,
    endedData = false,
    sawEnd = false;
  let dataBytes = 0;
  const parts = [];
  while (offset < bytes.length) {
    if (++chunks > PNG_RGBA_LIMITS.chunks) fail("chunk count exceeds budget");
    if (bytes.length - offset < 12) fail("truncated chunk header");
    const length = uint32(bytes, offset);
    if (length > bytes.length - offset - 12) fail("chunk bounds exceed input");
    const start = offset + 8,
      end = start + length;
    for (let i = offset + 4; i < start; i++) {
      const c = bytes[i];
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122)))
        fail("invalid chunk type");
    }
    if (bytes[offset + 6] & 32) fail("invalid reserved chunk type bit");
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (crc32(bytes, offset + 4, end) !== uint32(bytes, end))
      fail(`${type} CRC mismatch`);
    if (!sawHeader && type !== "IHDR") fail("IHDR must be the first chunk");
    if (sawData && type !== "IDAT") endedData = true;
    if (type === "IHDR") {
      if (sawHeader || length !== 13) fail("invalid or duplicate IHDR");
      width = uint32(bytes, start);
      height = uint32(bytes, start + 4);
      if (
        !width ||
        !height ||
        width > PNG_RGBA_LIMITS.dimension ||
        height > PNG_RGBA_LIMITS.dimension ||
        width * height * 4 > PNG_RGBA_LIMITS.decodedBytes
      )
        fail("decoded dimensions exceed budget");
      if (
        bytes[start + 8] !== 8 ||
        bytes[start + 9] !== 6 ||
        bytes[start + 10] !== 0 ||
        bytes[start + 11] !== 0 ||
        bytes[start + 12] !== 0
      )
        fail("unsupported format; require noninterlaced RGBA8 PNG");
      sawHeader = true;
    } else if (type === "PLTE") {
      if (sawPalette || sawData || !length || length > 768 || length % 3)
        fail("invalid PLTE chunk or order");
      sawPalette = true;
    } else if (type === "IDAT") {
      if (endedData) fail("IDAT chunks must be consecutive");
      sawData = true;
      if (length) parts.push([start, end]);
      dataBytes += length;
    } else if (type === "IEND") {
      if (length || !sawData || !dataBytes)
        fail("invalid IEND or missing IDAT");
      if (end + 4 !== bytes.length) fail("trailing data after IEND");
      sawEnd = true;
      break;
    } else if (type === "tRNS") fail("tRNS is invalid for RGBA PNG");
    else if (type === "acTL" || type === "fcTL" || type === "fdAT")
      fail("animated PNG is unsupported");
    else if (!(bytes[offset + 4] & 32))
      fail(`unsupported critical chunk ${type}`);
    offset = end + 4;
  }
  if (!sawHeader || !sawEnd) fail("missing IHDR or IEND");
  const compressed = new Uint8Array(dataBytes);
  let position = 0;
  for (const [start, end] of parts) {
    compressed.set(bytes.subarray(start, end), position);
    position += end - start;
  }
  const stride = width * 4;
  // Trusted platform adapters may accelerate streams already accepted by the
  // bounded reference inflater. PNG validation and row reconstruction stay here.
  // The third argument lets adapters retain the exact reference acceptance set.
  const expectedLength = (stride + 1) * height;
  const filtered = inflate(compressed, expectedLength, inflateZlib);
  if (!(filtered instanceof Uint8Array) || filtered.length !== expectedLength)
    fail("inflated output does not match dimensions");
  // Opt-in platform adapters own their inflater output. Compact rows toward
  // the start of that buffer: each destination precedes its unread source,
  // while left/up predictors refer to already reconstructed pixels. Never
  // retain an oversized pooled slab or mutate a caller's encoded PNG bytes.
  const reuse =
    reuseInflatedBuffer &&
    filtered.byteOffset === 0 &&
    filtered.buffer.byteLength <= expectedLength + 1 &&
    filtered.buffer !== bytes.buffer;
  const data = reuse
    ? new Uint8ClampedArray(filtered.buffer, 0, stride * height)
    : new Uint8ClampedArray(stride * height);
  for (let y = 0; y < height; y++) {
    const source = y * (stride + 1) + 1,
      target = y * stride;
    const filter = filtered[source - 1];
    // Select once per scanline. Unfiltered rows need no per-byte arithmetic;
    // the other filters read only the neighbors their predictor actually uses.
    if (filter === 0 || (filter === 2 && y === 0)) {
      data.set(filtered.subarray(source, source + stride), target);
    } else if (filter === 1 || (filter === 4 && y === 0)) {
      data.set(filtered.subarray(source, source + 4), target);
      for (let x = 4; x < stride; x++)
        data[target + x] = (filtered[source + x] + data[target + x - 4]) & 255;
    } else if (filter === 2) {
      for (let x = 0; x < stride; x++)
        data[target + x] =
          (filtered[source + x] + data[target + x - stride]) & 255;
    } else if (filter === 3) {
      if (y === 0) {
        data.set(filtered.subarray(source, source + 4), target);
        for (let x = 4; x < stride; x++)
          data[target + x] =
            (filtered[source + x] + (data[target + x - 4] >>> 1)) & 255;
      } else {
        for (let x = 0; x < 4; x++)
          data[target + x] =
            (filtered[source + x] + (data[target + x - stride] >>> 1)) & 255;
        for (let x = 4; x < stride; x++)
          data[target + x] =
            (filtered[source + x] +
              ((data[target + x - 4] + data[target + x - stride]) >>> 1)) &
            255;
      }
    } else if (filter === 4) {
      for (let x = 0; x < 4; x++)
        data[target + x] =
          (filtered[source + x] + data[target + x - stride]) & 255;
      for (let x = 4; x < stride; x++)
        data[target + x] =
          (filtered[source + x] +
            paeth(
              data[target + x - 4],
              data[target + x - stride],
              data[target + x - stride - 4],
            )) &
          255;
    } else {
      fail("unsupported row filter");
    }
  }
  return { width, height, data };
}
