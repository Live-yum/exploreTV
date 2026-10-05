import {
  createReadStream,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInflate } from "node:zlib";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const MAX_RAW_BYTES = 32 * 1024 ** 3,
  MAX_TILES = 100000,
  MAX_CELLS = 24000000;
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  table[i] = c >>> 0;
}
function crc(data) {
  let c = 0xffffffff;
  for (const b of data) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function readJson(path, maxBytes = 16 * 1024 ** 2) {
  assert.ok(
    statSync(path).size <= maxBytes,
    "JSON file exceeds verification budget",
  );
  return JSON.parse(readFileSync(path));
}

/** Audit compressed PNG bytes and filtered scanlines without allocating decoded pixels. */
export async function verifyExportPng(path) {
  const started = performance.now();
  assert.ok(
    statSync(path).size <= MAX_RAW_BYTES + 16 * 1024 ** 2,
    "Encoded PNG exceeds verification budget",
  );
  const inflate = createInflate({ chunkSize: 1024 * 1024 }),
    encodedHash = createHash("sha256"),
    filteredHash = createHash("sha256");
  let pending = Buffer.alloc(0),
    signature = false,
    width = 0,
    height = 0,
    rowBytes = 0,
    rowOffset = 0,
    rows = 0,
    rawBytes = 0,
    encodedBytes = 0,
    chunkCount = 0,
    idatCount = 0,
    end = false,
    fatal = null;
  const filters = {};
  const audit = (async () => {
    for await (const bytes of inflate) {
      filteredHash.update(bytes);
      rawBytes += bytes.length;
      assert.ok(
        rawBytes <= rowBytes * height,
        "Decompressed stream exceeds declared dimensions",
      );
      let cursor = 0;
      while (cursor < bytes.length) {
        if (rowOffset === 0) {
          const filter = bytes[cursor];
          assert.ok(filter <= 4, "Invalid PNG filter");
          filters[filter] = (filters[filter] || 0) + 1;
        }
        const n = Math.min(bytes.length - cursor, rowBytes - rowOffset);
        cursor += n;
        rowOffset += n;
        if (rowOffset === rowBytes) {
          rowOffset = 0;
          rows++;
        }
      }
    }
  })().catch((error) => {
    fatal = error;
    inflate.destroy(error);
  });
  try {
    for await (const bytes of createReadStream(path, {
      highWaterMark: 1024 * 1024,
    })) {
      encodedHash.update(bytes);
      encodedBytes += bytes.length;
      pending = Buffer.concat([pending, bytes]);
      if (!signature) {
        if (pending.length < 8) continue;
        assert.deepEqual(
          pending.subarray(0, 8),
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          "PNG signature",
        );
        pending = pending.subarray(8);
        signature = true;
      }
      while (pending.length >= 12) {
        const length = pending.readUInt32BE(0);
        assert.ok(
          length <= 1024 * 1024,
          "PNG chunk exceeds verification budget",
        );
        if (pending.length < length + 12) break;
        assert.equal(end, false, "Trailing chunk after IEND");
        const name = pending.toString("ascii", 4, 8),
          data = pending.subarray(8, 8 + length);
        assert.equal(
          crc(pending.subarray(4, 8 + length)),
          pending.readUInt32BE(8 + length),
          `${name} CRC`,
        );
        chunkCount++;
        if (chunkCount === 1) assert.equal(name, "IHDR", "IHDR must be first");
        if (name === "IHDR") {
          assert.equal(chunkCount, 1, "Duplicate IHDR");
          assert.equal(length, 13);
          width = data.readUInt32BE(0);
          height = data.readUInt32BE(4);
          assert.ok(
            width > 0 &&
              width <= 262144 &&
              height > 0 &&
              height <= 131072 &&
              width * height * 4 <= MAX_RAW_BYTES,
            "PNG dimensions exceed verification budget",
          );
          assert.equal(data[8], 8, "RGBA8 depth");
          assert.equal(data[9], 6, "RGBA color type");
          assert.equal(data[10], 0);
          assert.equal(data[11], 0);
          assert.equal(data[12], 0, "Non-interlaced PNG");
          rowBytes = width * 4 + 1;
        } else if (name === "IDAT") {
          if (fatal) throw fatal;
          idatCount++;
          await new Promise((resolve, reject) =>
            inflate.write(data, (e) => (e ? reject(e) : resolve())),
          );
        } else if (name === "IEND") {
          assert.equal(length, 0);
          end = true;
        } else throw new Error(`Unexpected generated PNG chunk ${name}`);
        pending = pending.subarray(length + 12);
      }
    }
    assert.equal(pending.length, 0, "Truncated PNG chunk");
    assert.equal(end, true, "Missing IEND");
    assert.ok(idatCount > 0, "Missing IDAT");
    inflate.end();
    await audit;
    if (fatal) throw fatal;
    assert.equal(rows, height, "Exact scanline count");
    assert.equal(rowOffset, 0);
    assert.equal(
      rawBytes,
      (width * 4 + 1) * height,
      "Exact filtered byte count",
    );
    return {
      status: "passed",
      path,
      width,
      height,
      pixels: width * height,
      rows,
      filteredScanlineBytes: rawBytes,
      encodedBytes,
      sha256: encodedHash.digest("hex"),
      filteredScanlineSha256: filteredHash.digest("hex"),
      filters,
      chunkCount,
      idatCount,
      runtimeSeconds: +((performance.now() - started) / 1000).toFixed(2),
      fullImageAllocated: false,
      checks: [
        "PNG signature, IHDR and IEND",
        "Every generated PNG chunk CRC",
        "Complete zlib stream",
        "Every scanline filter and exact declared byte/row count",
        "Encoded PNG SHA-256",
      ],
    };
  } catch (error) {
    inflate.destroy();
    await audit;
    throw error;
  }
}

/** Verify piece identities and one-time world-cell coverage, without decoding every piece. */
export async function verifyExportTiles(directory, expected = {}) {
  const started = performance.now(),
    manifest = readJson(join(directory, "manifest.json"), 64 * 1024 ** 2);
  assert.equal(manifest.schema, "exploretv-full-resolution-tiles-v1");
  assert.ok(
    Number.isSafeInteger(manifest.width) &&
      Number.isSafeInteger(manifest.height) &&
      manifest.width > 0 &&
      manifest.height > 0 &&
      manifest.width % 16 === 0 &&
      manifest.height % 16 === 0,
  );
  const width = manifest.width / 16,
    height = manifest.height / 16;
  assert.ok(
    width <= 10000 && height <= 5000 && width * height <= MAX_CELLS,
    "Manifest dimensions exceed budget",
  );
  if (expected.width !== undefined)
    assert.equal(manifest.width, expected.width);
  if (expected.height !== undefined)
    assert.equal(manifest.height, expected.height);
  if (expected.worldSha256)
    assert.equal(manifest.worldSha256, expected.worldSha256);
  assert.equal(manifest.pixelsPerTile, 16);
  assert.equal(manifest.worldRect.width, width);
  assert.equal(manifest.worldRect.height, height);
  assert.ok(
    [manifest.worldRect.x, manifest.worldRect.y].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ),
  );
  assert.ok(
    Array.isArray(manifest.tiles) &&
      manifest.tiles.length > 0 &&
      manifest.tiles.length <= MAX_TILES,
    "Manifest tile count exceeds budget",
  );
  const coverage = new Uint8Array(width * height),
    files = new Set();
  let bytes = 0,
    pixels = 0;
  for (const tile of manifest.tiles) {
    assert.equal(files.has(tile.file), false, "Duplicate tile filename");
    assert.ok(/^tile-\d+-\d+\.png$/.test(tile.file), "Safe tile filename");
    files.add(tile.file);
    const path = join(directory, tile.file);
    assert.ok(
      statSync(path).size <= 16 * 1024 ** 2,
      "Tile PNG exceeds verification budget",
    );
    const png = readFileSync(path);
    assert.deepEqual(
      png.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    assert.equal(png.toString("ascii", 12, 16), "IHDR");
    assert.equal(png.readUInt32BE(16), tile.width);
    assert.equal(png.readUInt32BE(20), tile.height);
    assert.equal(png.length, tile.bytes);
    assert.equal(
      createHash("sha256").update(png).digest("hex"),
      tile.sha256,
      "Tile SHA-256",
    );
    assert.ok(
      [tile.x, tile.y, tile.width, tile.height].every(
        (n) => Number.isSafeInteger(n) && n % 16 === 0,
      ),
    );
    assert.ok(
      tile.width > 0 &&
        tile.width <= 4032 &&
        tile.height > 0 &&
        tile.height <= 512,
      "Bounded tile dimensions",
    );
    assert.equal(tile.x, (tile.worldRect.x - manifest.worldRect.x) * 16);
    assert.equal(tile.y, (tile.worldRect.y - manifest.worldRect.y) * 16);
    assert.equal(tile.width, tile.worldRect.width * 16);
    assert.equal(tile.height, tile.worldRect.height * 16);
    assert.ok(
      tile.x >= 0 &&
        tile.y >= 0 &&
        tile.x + tile.width <= manifest.width &&
        tile.y + tile.height <= manifest.height,
    );
    for (let y = tile.y / 16; y < (tile.y + tile.height) / 16; y++)
      for (let x = tile.x / 16; x < (tile.x + tile.width) / 16; x++) {
        const i = y * width + x;
        assert.equal(coverage[i], 0, "Overlapping tile coverage");
        coverage[i] = 1;
      }
    bytes += png.length;
    pixels += tile.width * tile.height;
  }
  assert.ok(
    coverage.every((value) => value === 1),
    "Missing tile coverage",
  );
  assert.equal(pixels, manifest.width * manifest.height);
  let pngCount = 0;
  for await (const entry of await opendir(directory))
    if (entry.name.endsWith(".png")) {
      assert.ok(files.has(entry.name), "Unlisted PNG file");
      pngCount++;
    }
  assert.equal(pngCount, manifest.tiles.length);
  return {
    status: "passed",
    directory,
    width: manifest.width,
    height: manifest.height,
    tiles: manifest.tiles.length,
    worldCells: coverage.length,
    pixels,
    bytes,
    runtimeSeconds: +((performance.now() - started) / 1000).toFixed(2),
    checks: [
      "Every tile SHA-256 and encoded byte size",
      "Every PNG header dimension",
      "Manifest coordinate and world-tile agreement",
      "Every world tile covered exactly once",
      "No missing or additional PNG files",
    ],
    decodedAllTilePixels: false,
  };
}

export async function verifyExport(
  path,
  { tilesPath = null, reportPath = `${path}.verification.json` } = {},
) {
  const started = performance.now(),
    png = await verifyExportPng(path),
    sourceReport = existsSync(`${path}.json`) ? readJson(`${path}.json`) : null;
  if (sourceReport) {
    assert.equal(sourceReport.schema, "exploretv-full-resolution-export-v1");
    assert.equal(sourceReport.png.width, png.width);
    assert.equal(sourceReport.png.height, png.height);
    assert.equal(sourceReport.png.rows, png.rows);
    assert.equal(sourceReport.png.bytes, png.encodedBytes);
    assert.equal(
      sourceReport.png.sha256,
      png.sha256,
      "Export report PNG SHA-256",
    );
    assert.equal(sourceReport.writtenRows, png.rows);
  }
  const tiles = tilesPath
    ? await verifyExportTiles(tilesPath, {
        width: png.width,
        height: png.height,
        worldSha256: sourceReport?.worldSha256,
      })
    : null;
  const report = {
    schema: "exploretv-full-resolution-verification-v1",
    status: "passed",
    png,
    tiles,
    exportReportMatched: Boolean(sourceReport),
    runtimeSeconds: +((performance.now() - started) / 1000).toFixed(2),
    osPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    fullImageAllocated: false,
  };
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [path, ...args] = process.argv.slice(2);
    if (path === "--help") {
      console.log(
        "Usage: node scripts/verify-export.mjs <output.png> [--tiles <directory>] [--report <verification.json>]",
      );
    } else {
      if (!path || path.startsWith("--"))
        throw new Error("Provide the exported PNG path");
      const options = {};
      for (let i = 0; i < args.length; i++) {
        if (
          !["--tiles", "--report"].includes(args[i]) ||
          !args[i + 1] ||
          args[i + 1].startsWith("--")
        )
          throw new Error("Expected --tiles <directory> or --report <file>");
        options[args[i] === "--tiles" ? "tilesPath" : "reportPath"] = args[++i];
      }
      console.log(JSON.stringify(await verifyExport(path, options), null, 2));
    }
  } catch (error) {
    console.error(`verify-export: ${error.message}`);
    process.exitCode = 1;
  }
}
