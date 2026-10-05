import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import assert from "node:assert/strict";
import {
  openWorld,
  Reader,
  decodeRecord,
  LIMITS,
  validateRect,
} from "../core/world.mjs";
import { ORDINARY_BLOCKS, STORED_FRAME_TILES } from "../core/renderer.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { createWorldRenderer } from "./world-render-engine.mjs";

const USAGE = `Usage: node --expose-gc scripts/render-full-world.mjs <world.wld> <png-directory> <output-directory> [options]

Options:
  --inventory-only                    Scan RLE records and list required textures; do not render
  --detail name:x,y,width,height       Add a native-resolution detail (repeat up to 16 times)
  --expect-world-sha256 <64 hex chars>  Refuse a different input world
  --input-encoding <encoding>          tconvert-game-raw (default) or standard-straight
  --help                              Print this help without reading or writing files

Details use world tile coordinates. Each side must be 1..252 tiles and inside the world.
PNG textures must be supplied by the user unless redistribution permission is verified.
The renderer never downloads, uploads, or publishes assets or outputs.`;

export function parseCli(argv) {
  if (argv.includes("--help")) return { help: true };
  const positional = [],
    details = [],
    names = new Set();
  let inventoryOnly = false,
    expectedWorldSha256 = null,
    inputEncoding = "tconvert-game-raw";
  const argument = (index, name) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${name} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--inventory-only") inventoryOnly = true;
    else if (value === "--detail") {
      const text = argument(i++, value);
      const match =
        /^([a-z0-9][a-z0-9_-]{0,39}):(\d+),(\d+),(\d+),(\d+)$/i.exec(text);
      if (!match)
        throw new Error(
          "Detail must be name:x,y,width,height with a safe filename name",
        );
      const [, name, ...numbers] = match;
      const [x, y, width, height] = numbers.map(Number);
      if (
        ![x, y, width, height].every(Number.isSafeInteger) ||
        width < 1 ||
        height < 1 ||
        width > 252 ||
        height > 252
      )
        throw new Error(
          "Detail coordinates must be safe integers and dimensions 1..252 tiles",
        );
      if (names.has(name.toLowerCase()))
        throw new Error(`Duplicate detail name: ${name}`);
      if (details.length >= 16)
        throw new Error("At most 16 details are allowed");
      names.add(name.toLowerCase());
      details.push({ name, x, y, width, height });
    } else if (value === "--expect-world-sha256") {
      expectedWorldSha256 = argument(i++, value).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedWorldSha256))
        throw new Error(
          "Expected world SHA-256 must contain 64 hexadecimal characters",
        );
    } else if (value === "--input-encoding") {
      inputEncoding = argument(i++, value);
      if (!["tconvert-game-raw", "standard-straight"].includes(inputEncoding))
        throw new Error("Unknown input encoding");
    } else if (value.startsWith("--"))
      throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  if (positional.length !== 3)
    throw new Error(
      "Provide world.wld, PNG directory and output directory; use --help for usage",
    );
  return {
    worldPath: positional[0],
    assetDir: positional[1],
    outDir: positional[2],
    inventoryOnly,
    details,
    expectedWorldSha256,
    inputEncoding,
  };
}

async function main(argv) {
  const config = parseCli(argv);
  if (config.help) {
    console.log(USAGE);
    return;
  }
  const started = performance.now();
  const { worldPath, assetDir, outDir } = config;
  if (statSync(worldPath).size > LIMITS.fileBytes)
    throw new Error("World file size budget exceeded");
  const bytes = readFileSync(worldPath);
  const worldSha256 = createHash("sha256").update(bytes).digest("hex");
  if (config.expectedWorldSha256 && worldSha256 !== config.expectedWorldSha256)
    throw new Error(
      `World SHA-256 mismatch: expected ${config.expectedWorldSha256}, got ${worldSha256}`,
    );
  const sourceHashes = {};
  for (const relative of [
    "scripts/render-full-world.mjs",
    "scripts/world-render-engine.mjs",
    "core/world.mjs",
    "core/utf8.mjs",
    "core/renderer.mjs",
    "core/liquid.mjs",
    "core/paint.mjs",
    "core/scene-frames.mjs",
    "core/assets.mjs",
    "core/png-rgba.mjs",
  ])
    sourceHashes[relative] = createHash("sha256")
      .update(readFileSync(new URL("../" + relative, import.meta.url)))
      .digest("hex");
  const rendererSha256 = sourceHashes["core/renderer.mjs"];
  const world = openWorld(bytes);
  for (const { name, ...rect } of config.details)
    validateRect(rect, world.width, world.height);
  mkdirSync(outDir, { recursive: true });
  const ordinary = new Set(ORDINARY_BLOCKS),
    stored = new Set(STORED_FRAME_TILES);
  const add = (map, key, value = 1) => {
    map[key] = (map[key] || 0) + value;
  };
  const sortedCounts = (counts) =>
    Object.entries(counts)
      .map(([id, count]) => ({ id: /^\d+$/.test(id) ? +id : id, count }))
      .sort((a, b) => b.count - a.count);
  const supports = (t) => {
    const hasFrame =
      Number.isInteger(t.frameX) &&
      Number.isInteger(t.frameY) &&
      t.frameX >= 0 &&
      t.frameY >= 0;
    return (
      t.shape >= 0 &&
      t.shape <= 5 &&
      ((hasFrame && stored.has(t.type)) ||
        (!hasFrame && (ordinary.has(t.type) || t.type === 353)))
    );
  };
  const inventory = {
    worldSha256,
    version: world.version,
    signature: world.signature,
    width: world.width,
    height: world.height,
    totalCells: world.width * world.height,
    records: world.records,
    worldSurface: world.worldSurface,
    activeCells: 0,
    supportedVisibleTileCells: 0,
    unsupportedVisibleTileCells: 0,
    visibleWallCells: 0,
    hiddenTileCells: 0,
    hiddenWallCells: 0,
    liquidCells: 0,
    paintedCells: 0,
    tiles: {},
    walls: {},
    unsupportedTiles: {},
    liquids: {},
    requiredTextures: {},
  };
  const reader = new Reader(world.bytes, world.sections[2]);
  for (let x = 0; x < world.width; x++) {
    reader.pos = world.columns[x];
    for (let y = 0; y < world.height; ) {
      const { tile: t, repeats } = decodeRecord(reader, world.important),
        n = repeats + 1;
      if (t.active) {
        inventory.activeCells += n;
        add(inventory.tiles, t.type, n);
        if (t.invisibleBlock) inventory.hiddenTileCells += n;
        else if (supports(t)) {
          inventory.supportedVisibleTileCells += n;
          add(inventory.requiredTextures, `Tiles_${t.type}.png`, n);
        } else {
          inventory.unsupportedVisibleTileCells += n;
          add(inventory.unsupportedTiles, t.type, n);
        }
      }
      if (t.wall) {
        add(inventory.walls, t.wall, n);
        if (t.invisibleWall || t.wall === 318) inventory.hiddenWallCells += n;
        else {
          inventory.visibleWallCells += n;
          add(inventory.requiredTextures, `Wall_${t.wall}.png`, n);
        }
      }
      if (t.liquid) {
        inventory.liquidCells += n;
        add(inventory.liquids, t.liquidKind, n);
      }
      if (t.paint || t.wallPaint) inventory.paintedCells += n;
      y += n;
    }
  }
  for (const [kind, name] of [
    [1, "water_0.png"],
    [2, "water_1.png"],
    [3, "water_11.png"],
  ])
    if (inventory.liquids[kind])
      add(inventory.requiredTextures, name, inventory.liquids[kind]);
  inventory.requiredTextures = sortedCounts(inventory.requiredTextures).map(
    ({ id: name, count }) => ({
      name,
      cells: count,
      present: existsSync(join(assetDir, name)),
    }),
  );
  inventory.unsupportedTiles = sortedCounts(inventory.unsupportedTiles);
  inventory.inventorySeconds = +(performance.now() - started).toFixed(1) / 1000;
  writeFileSync(
    join(outDir, "full-world-inventory.json"),
    JSON.stringify(inventory, null, 2),
  );
  console.log(
    JSON.stringify({
      phase: "inventory",
      totalCells: inventory.totalCells,
      activeCells: inventory.activeCells,
      supportedVisibleTileCells: inventory.supportedVisibleTileCells,
      unsupportedVisibleTileCells: inventory.unsupportedVisibleTileCells,
      requiredTextures: inventory.requiredTextures.length,
      missingTextures: inventory.requiredTextures.filter((a) => !a.present),
      elapsedSeconds: (performance.now() - started) / 1000,
    }),
  );
  if (config.inventoryOnly) return;

  const CHUNK = 128,
    HALO = 2;
  const SOURCE = {
    signature: world.signature,
    name: world.name,
    id: world.id,
    width: world.width,
    height: world.height,
    worldSurface: world.worldSurface,
  };
  const overview = createCanvas(world.width, world.height),
    overviewContext = overview.getContext("2d");
  overviewContext.fillStyle = "#000000";
  overviewContext.fillRect(0, 0, world.width, world.height);
  const chunkCanvas = createCanvas(
    (CHUNK + HALO * 2) * 16,
    (CHUNK + HALO * 2) * 16,
  );
  const downsampleA = createCanvas(CHUNK * 8, CHUNK * 8),
    downsampleB = createCanvas(CHUNK * 4, CHUNK * 4);
  let assetHashes,
    assetFailures,
    commandCounts,
    missingCommands,
    invalidCommands,
    effectFailures,
    liquidUnsupported,
    unsupportedTiles;
  const coverageMask = new Uint8Array(world.width * world.height);
  const mark = (x, y, code) => {
    coverageMask[y * world.width + x] |= code;
  };
  let peakAssetCacheBytes = 0,
    peakRssBytes = 0,
    maxChunkCells = 0,
    maxPlanCommands = 0,
    maxPreparedBytes = 0,
    renderedCommands = 0,
    plannedCommands = 0,
    processedCells = 0,
    chunkCount = 0;
  function readStrip(x, width) {
    const columns = [],
      r = new Reader(world.bytes, world.sections[2]);
    for (let dx = 0; dx < width; dx++) {
      const col = new Array(world.height);
      r.pos = world.columns[x + dx];
      for (let y = 0; y < world.height; ) {
        const rec = decodeRecord(r, world.important);
        col.fill(rec.tile, y, y + rec.repeats + 1);
        y += rec.repeats + 1;
      }
      columns.push(col);
    }
    return { x, width, columns };
  }
  function regionFromStrip(strip, rect) {
    const cells = new Array(rect.width * rect.height);
    for (let x = 0; x < rect.width; x++) {
      const col = strip.columns[rect.x + x - strip.x];
      for (let y = 0; y < rect.height; y++)
        cells[x * rect.height + y] = col[rect.y + y];
    }
    return {
      rect,
      cells,
      version: world.version,
      important: world.important,
      source: SOURCE,
    };
  }
  const renderer = createWorldRenderer({
    assetDir,
    inputEncoding: config.inputEncoding,
    onOmission: mark,
  });
  ({
    assetHashes,
    assetFailures,
    commandCounts,
    missingCommands,
    invalidCommands,
    effectFailures,
    liquidUnsupported,
    unsupportedTiles,
  } = renderer.stats);
  async function drawRegion(...args) {
    const result = await renderer.drawRegion(...args),
      stats = renderer.stats;
    ({
      peakAssetCacheBytes,
      maxChunkCells,
      maxPlanCommands,
      maxPreparedBytes,
      renderedCommands,
      plannedCommands,
    } = stats);
    return result;
  }
  function downsampleCore(source, sx, sy, width, height) {
    let current = source,
      sourceX = sx,
      sourceY = sy,
      sourceW = width * 16,
      sourceH = height * 16;
    for (let level = 8; level >= 1; level /= 2) {
      const target = current === downsampleA ? downsampleB : downsampleA;
      target.width = width * level;
      target.height = height * level;
      const ctx = target.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "low";
      ctx.drawImage(
        current,
        sourceX,
        sourceY,
        sourceW,
        sourceH,
        0,
        0,
        target.width,
        target.height,
      );
      current = target;
      sourceX = sourceY = 0;
      sourceW = target.width;
      sourceH = target.height;
    }
    return current;
  }
  for (let x = 0; x < world.width; x += CHUNK) {
    const cw = Math.min(CHUNK, world.width - x),
      sx = Math.max(0, x - HALO),
      sw = Math.min(world.width, x + cw + HALO) - sx;
    let strip = readStrip(sx, sw);
    for (let y = 0; y < world.height; y += CHUNK) {
      const ch = Math.min(CHUNK, world.height - y),
        sy = Math.max(0, y - HALO),
        sh = Math.min(world.height, y + ch + HALO) - sy;
      const core = { x, y, width: cw, height: ch };
      const region = regionFromStrip(strip, {
        x: sx,
        y: sy,
        width: sw,
        height: sh,
      });
      await drawRegion(region, chunkCanvas, { core, count: true });
      const down = downsampleCore(
        chunkCanvas,
        (x - sx) * 16,
        (y - sy) * 16,
        cw,
        ch,
      );
      overviewContext.imageSmoothingEnabled = false;
      overviewContext.drawImage(down, x, y);
      processedCells += cw * ch;
      chunkCount++;
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }
    strip = null;
    if (global.gc) global.gc();
    const progress = {
      phase: "render",
      xThrough: x + cw,
      processedCells,
      totalCells: inventory.totalCells,
      chunkCount,
      renderedCommands,
      elapsedSeconds: +((performance.now() - started) / 1000).toFixed(1),
      rssMiB: Math.round(process.memoryUsage().rss / 1048576),
    };
    writeFileSync(
      join(outDir, "full-world-progress.json"),
      JSON.stringify(progress, null, 2),
    );
    console.log(JSON.stringify(progress));
  }
  assert.equal(
    processedCells,
    world.width * world.height,
    "Full-world coverage mismatch",
  );
  assert.equal(
    Object.values(unsupportedTiles).reduce((a, b) => a + b, 0),
    inventory.unsupportedVisibleTileCells,
    "Unsupported-tile inventory/renderer mismatch",
  );
  assert.equal(
    plannedCommands,
    renderedCommands +
      [missingCommands, invalidCommands, effectFailures].reduce(
        (total, counts) =>
          total + Object.values(counts).reduce((a, b) => a + b, 0),
        0,
      ),
    "Every planned command must be rendered or have exactly one reported failure",
  );
  writeFileSync(join(outDir, "full-world.png"), overview.toBuffer("image/png"));
  // Lossless indexed PNG retains a bitmask at every original world coordinate.
  // Transparent means no flagged omission, not guaranteed game-perfect fidelity.
  function pngChunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0);
    body.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(world.width, 0);
  ihdr.writeUInt32BE(world.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const palette = Buffer.alloc(32 * 3),
    alpha = Buffer.alloc(32, 190),
    coverageCounts = {};
  alpha[0] = 0;
  for (let code = 1; code < 32; code++) {
    const color =
      code & 28 ? [255, 55, 55] : code & 1 ? [230, 70, 255] : [255, 190, 30];
    palette.set(color, code * 3);
  }
  const scanlines = Buffer.alloc((world.width + 1) * world.height);
  for (let y = 0; y < world.height; y++)
    scanlines.set(
      coverageMask.subarray(y * world.width, (y + 1) * world.width),
      y * (world.width + 1) + 1,
    );
  for (const code of coverageMask) add(coverageCounts, code);
  const coveragePath = join(outDir, "full-world-coverage.png");
  writeFileSync(
    coveragePath,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", ihdr),
      pngChunk("PLTE", palette),
      pngChunk("tRNS", alpha),
      pngChunk("IDAT", deflateSync(scanlines)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
  const details = config.details;
  const detailReports = [];
  for (const { name, ...rect } of details) {
    const sx = Math.max(0, rect.x - HALO),
      sy = Math.max(0, rect.y - HALO),
      sw = Math.min(world.width, rect.x + rect.width + HALO) - sx,
      sh = Math.min(world.height, rect.y + rect.height + HALO) - sy;
    const strip = readStrip(sx, sw),
      region = regionFromStrip(strip, { x: sx, y: sy, width: sw, height: sh });
    const { plan } = await drawRegion(region, chunkCanvas);
    const detail = createCanvas(rect.width * 16, rect.height * 16),
      ctx = detail.getContext("2d");
    ctx.drawImage(
      chunkCanvas,
      (rect.x - sx) * 16,
      (rect.y - sy) * 16,
      detail.width,
      detail.height,
      0,
      0,
      detail.width,
      detail.height,
    );
    const path = join(outDir, `full-world-detail-${name}.png`);
    writeFileSync(path, detail.toBuffer("image/png"));
    detailReports.push({
      path,
      rect,
      width: detail.width,
      height: detail.height,
      unsupportedTiles: plan.unsupportedCells.filter(
        (c) =>
          c.x >= rect.x &&
          c.y >= rect.y &&
          c.x < rect.x + rect.width &&
          c.y < rect.y + rect.height,
      ).length,
      liquidUnsupported:
        plan.support.liquidDrawing.unsupportedCoordinates.filter(
          (c) =>
            c.x >= rect.x &&
            c.y >= rect.y &&
            c.x < rect.x + rect.width &&
            c.y < rect.y + rect.height,
        ).length,
    });
    detail.width = detail.height = 1;
  }
  const report = {
    worldSha256,
    sourceDimensions: { width: world.width, height: world.height },
    overview: {
      path: join(outDir, "full-world.png"),
      width: overview.width,
      height: overview.height,
      pixelsPerTile: 1,
      downsample:
        "four successive 2x bilinear reductions from actual 16px sprite crops, never map palette colors",
    },
    processedCells,
    totalCells: inventory.totalCells,
    chunkCount,
    chunkSide: CHUNK,
    haloTiles: HALO,
    plannedCommands,
    renderedCommands,
    commandCounts,
    unsupportedTiles: sortedCounts(unsupportedTiles),
    liquidUnsupported,
    missingCommands,
    invalidCommands,
    effectFailures,
    assetFailures,
    assetHashes,
    details: detailReports,
    peakRssBytes,
    peakAssetCacheBytes,
    maxChunkCells,
    maxPlanCommands,
    maxPreparedBytes,
    runtimeSeconds: +((performance.now() - started) / 1000).toFixed(2),
    limitations: [
      "Static fullbright preview without dynamic lighting.",
      "Real source sprite crops and raw-PNG premultiplied channel conversion; no game screenshot oracle.",
      "Ordinary blocks and walls retain approximate adjacency; cross-material merges, grass transitions and random variants are not reproduced.",
      "Unsupported tile types, liquid neighborhoods, missing sources and invalid crops are explicitly counted; no replacement sprite or map palette is used.",
      "Invisible blocks/walls remain hidden. Wires, background scenery, particles and NPCs are not rendered.",
      "Panorama is downsampled to one pixel per world tile. Detail images retain 16 pixels per tile.",
    ],
    inputEncoding: config.inputEncoding,
  };
  report.coverageMask = {
    path: coveragePath,
    width: world.width,
    height: world.height,
    paletteIndexBitFlags: {
      1: "unsupported-tile",
      2: "unsupported-liquid-neighborhood",
      4: "missing-texture",
      8: "invalid-sprite-crop",
      16: "unsupported-paint-or-channel-effect",
    },
    paletteIndexCounts: coverageCounts,
    legend: {
      transparent: "No flagged omission; approximation limits still apply",
      magenta: "Unsupported tile",
      amber: "Unsupported liquid neighborhood",
      red: "Missing texture, invalid crop, or unsupported effect",
    },
    note: "Indices are bit flags and can combine. Unsupported tiles take magenta priority over amber; asset/effect failures take red priority.",
  };
  report.rendererProvenance = {
    rendererSha256,
    sourceHashes,
    ordinaryBlockIds: [...ORDINARY_BLOCKS],
    storedFrameTileIds: [...STORED_FRAME_TILES],
    note: "SHA-256 hashes identify the actual local renderer, entry point and rendering dependencies used for this run; no unverified commit identity is asserted.",
  };
  report.peakRssBytes = Math.max(
    report.peakRssBytes,
    process.memoryUsage().rss,
  );
  report.memoryMeasurement =
    "peakRssBytes is the largest sampled RSS after a chunk or at completion; logical canvas, frame and asset bounds are reported separately.";
  writeFileSync(
    join(outDir, "full-world-coverage.json"),
    JSON.stringify(report, null, 2),
  );
  writeFileSync(
    join(outDir, "full-world-progress.json"),
    JSON.stringify(
      {
        phase: "done",
        processedCells,
        totalCells: inventory.totalCells,
        chunkCount,
        renderedCommands,
        runtimeSeconds: report.runtimeSeconds,
        coverageReport: join(outDir, "full-world-coverage.json"),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      phase: "done",
      ...report,
      assetHashes: undefined,
      unsupportedTiles: undefined,
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`render-full-world: ${error.message}`);
    process.exitCode = 1;
  });
}
