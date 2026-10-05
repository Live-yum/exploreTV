import {
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
  existsSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { openWorld, LIMITS } from "../core/world.mjs";
import { ORDINARY_BLOCKS, STORED_FRAME_TILES } from "../core/renderer.mjs";
import {
  createWorldRenderer,
  buildRowIndex,
  readIndexedRegion,
  paddedWorldRect,
  HALO_TILES,
} from "./world-render-engine.mjs";
import { createPngWriter } from "./png-stream.mjs";

const USAGE = `Usage: node --expose-gc scripts/export-world.mjs <world.wld> <png-directory> <output.png> [options]

Exports every world tile at 16 pixels per tile into one streamed RGBA8 PNG.
  --tiles <directory>            Also save compatible PNG pieces and a layout manifest
  --band-tiles <1..32>           Bounded stripe height; default 16 tiles (256 pixels)
  --chunk-tiles <1..252>         Piece width; default 128 tiles (2048 pixels)
  --region <x,y,width,height>    Optional world-tile rectangle for a pilot or smaller export
  --expect-world-sha256 <hash>   Refuse a different input world
  --input-encoding <encoding>   tconvert-game-raw (default) or standard-straight
  --compression-level <0..9>    PNG zlib level; default 6
  --help                        Print help without accessing inputs

The whole world is exported when --region is omitted. Existing output PNG/tile
directories are refused. No world or texture is uploaded or published. Large PNG
dimensions exceed many viewers' limits; --tiles provides ordinary-size pieces.`;

export function parseExportCli(argv) {
  if (argv.includes("--help")) return { help: true };
  const positional = [];
  const config = {
    bandTiles: 16,
    chunkTiles: 128,
    compressionLevel: 6,
    inputEncoding: "tconvert-game-raw",
    tilesPath: null,
    region: null,
    expectedWorldSha256: null,
  };
  const value = (i, flag) => {
    if (!argv[i + 1] || argv[i + 1].startsWith("--"))
      throw new Error(`${flag} requires a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--tiles") config.tilesPath = value(i++, flag);
    else if (flag === "--region") {
      const text = value(i++, flag);
      if (!/^\d+,\d+,\d+,\d+$/.test(text))
        throw new Error("Region must be x,y,width,height in world tiles");
      const [x, y, width, height] = text.split(",").map(Number);
      config.region = { x, y, width, height };
    } else if (
      ["--band-tiles", "--chunk-tiles", "--compression-level"].includes(flag)
    ) {
      const text = value(i++, flag);
      if (!/^\d+$/.test(text)) throw new Error(`${flag} requires an integer`);
      config[
        {
          "--band-tiles": "bandTiles",
          "--chunk-tiles": "chunkTiles",
          "--compression-level": "compressionLevel",
        }[flag]
      ] = Number(text);
    } else if (flag === "--expect-world-sha256")
      config.expectedWorldSha256 = value(i++, flag).toLowerCase();
    else if (flag === "--input-encoding")
      config.inputEncoding = value(i++, flag);
    else if (flag.startsWith("--")) throw new Error(`Unknown option: ${flag}`);
    else positional.push(flag);
  }
  if (positional.length !== 3)
    throw new Error(
      "Provide world.wld, PNG directory and output.png; use --help for usage",
    );
  return validateConfig({
    ...config,
    worldPath: positional[0],
    assetDir: positional[1],
    outputPath: positional[2],
  });
}

function validateConfig(config) {
  for (const [name, min, max] of [
    ["bandTiles", 1, 32],
    ["chunkTiles", 1, 252],
    ["compressionLevel", 0, 9],
  ])
    if (
      !Number.isSafeInteger(config[name]) ||
      config[name] < min ||
      config[name] > max
    )
      throw new Error(`${name} must be ${min}..${max}`);
  if (
    !["tconvert-game-raw", "standard-straight"].includes(config.inputEncoding)
  )
    throw new Error("Unknown input encoding");
  if (
    config.expectedWorldSha256 &&
    !/^[0-9a-f]{64}$/.test(config.expectedWorldSha256)
  )
    throw new Error(
      "Expected world SHA-256 must contain 64 hexadecimal characters",
    );
  if (
    config.region &&
    (!Object.values(config.region).every(Number.isSafeInteger) ||
      config.region.x < 0 ||
      config.region.y < 0 ||
      config.region.width < 1 ||
      config.region.height < 1)
  )
    throw new Error("Invalid world region");
  return config;
}

function throwIfAborted(signal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Export cancelled");
}
const sum = (counts) =>
  Object.values(counts).reduce((total, value) => total + value, 0);

export async function exportWorld(
  config,
  { signal, onProgress = () => {} } = {},
) {
  validateConfig(config);
  throwIfAborted(signal);
  const started = performance.now();
  if (statSync(config.worldPath).size > LIMITS.fileBytes)
    throw new Error("World file size budget exceeded");
  if (!statSync(config.assetDir).isDirectory())
    throw new Error("PNG path must be a directory");
  if (existsSync(config.outputPath))
    throw new Error("Output PNG already exists; choose a new path");
  if (config.tilesPath && existsSync(config.tilesPath))
    throw new Error("Tiles directory already exists; choose a new path");
  if (
    config.tilesPath &&
    (resolve(config.outputPath) === resolve(config.tilesPath) ||
      resolve(config.outputPath).startsWith(resolve(config.tilesPath) + sep))
  )
    throw new Error("Output PNG must be outside the final tiles directory");
  const bytes = readFileSync(config.worldPath),
    worldSha256 = createHash("sha256").update(bytes).digest("hex");
  if (config.expectedWorldSha256 && config.expectedWorldSha256 !== worldSha256)
    throw new Error("World SHA-256 mismatch");
  const world = openWorld(bytes),
    rect = config.region || {
      x: 0,
      y: 0,
      width: world.width,
      height: world.height,
    };
  if (rect.x + rect.width > world.width || rect.y + rect.height > world.height)
    throw new Error("Export region is outside world");
  const plannedChunks =
    Math.ceil(rect.width / config.chunkTiles) *
    Math.ceil(rect.height / config.bandTiles);
  if (config.tilesPath && plannedChunks > 100000)
    throw new Error(
      "Tile export exceeds 100000 pieces; increase chunk-tiles or band-tiles",
    );
  const pixelWidth = rect.width * 16,
    pixelHeight = rect.height * 16;
  const bandRows = Math.min(config.bandTiles, rect.height) * 16,
    rowBytes = pixelWidth * 4;
  const band = Buffer.allocUnsafe(rowBytes * bandRows),
    index = buildRowIndex(world);
  const renderer = createWorldRenderer({
    assetDir: config.assetDir,
    inputEncoding: config.inputEncoding,
  });
  const canvas = createCanvas(1, 1),
    tileCanvas = config.tilesPath ? createCanvas(1, 1) : null;
  const sourceHashes = {};
  for (const relative of [
    "scripts/export-world.mjs",
    "scripts/png-stream.mjs",
    "scripts/world-render-engine.mjs",
    "core/world.mjs",
    "core/utf8.mjs",
    "core/renderer.mjs",
    "core/static-nature.mjs",
    "core/cobweb-shapes.mjs",
    "core/static-objects.mjs",
    "core/static-blocks.mjs",
    "core/static-trees.mjs",
    "core/static-misc.mjs",
    "core/static-furniture-next.mjs",
    "core/static-flames.mjs",
    "core/static-plants-next.mjs",
    "core/static-special-objects.mjs",
    "core/world-tree-context.mjs",

    "core/liquid.mjs",
  "core/liquid-halfbrick.mjs",
    "core/tile-solidity.mjs",
    "core/liquid-visible-level.mjs",
    "core/paint.mjs",
    "core/scene-frames.mjs",
    "core/assets.mjs",
    "core/png-rgba.mjs",
  ])
    sourceHashes[relative] = createHash("sha256")
      .update(readFileSync(new URL("../" + relative, import.meta.url)))
      .digest("hex");
  mkdirSync(dirname(config.outputPath), { recursive: true });
  const tilesTemporary = config.tilesPath
    ? `${config.tilesPath}.partial-${randomUUID()}`
    : null;
  let writer = null,
    processedCells = 0,
    writtenRows = 0,
    chunks = 0,
    peakRssBytes = 0,
    renderSeconds = 0,
    compressionSeconds = 0;
  const tiles = [];
  try {
    if (tilesTemporary) mkdirSync(tilesTemporary, { recursive: true });
    writer = await createPngWriter({
      path: config.outputPath,
      width: pixelWidth,
      height: pixelHeight,
      compressionLevel: config.compressionLevel,
      signal,
    });
    for (let y = rect.y; y < rect.y + rect.height; y += config.bandTiles) {
      throwIfAborted(signal);
      const height = Math.min(config.bandTiles, rect.y + rect.height - y),
        currentRows = height * 16;
      let bandCells = 0;
      for (let x = rect.x; x < rect.x + rect.width; x += config.chunkTiles) {
        throwIfAborted(signal);
        const width = Math.min(config.chunkTiles, rect.x + rect.width - x),
          core = { x, y, width, height };
        const region = readIndexedRegion(
          world,
          index,
          paddedWorldRect(world, core),
        );
        const renderStarted = performance.now();
        await renderer.drawRegion(region, canvas, { core, count: true });
        const rgba = canvas
          .getContext("2d")
          .getImageData(
            (x - region.rect.x) * 16,
            (y - region.rect.y) * 16,
            width * 16,
            currentRows,
          );
        const data = Buffer.from(
            rgba.data.buffer,
            rgba.data.byteOffset,
            rgba.data.byteLength,
          ),
          chunkRowBytes = width * 16 * 4;
        for (let py = 0; py < currentRows; py++)
          data.copy(
            band,
            py * rowBytes + (x - rect.x) * 16 * 4,
            py * chunkRowBytes,
            (py + 1) * chunkRowBytes,
          );
        if (tileCanvas) {
          tileCanvas.width = width * 16;
          tileCanvas.height = currentRows;
          tileCanvas.getContext("2d").putImageData(rgba, 0, 0);
          const file = `tile-${String(y - rect.y).padStart(5, "0")}-${String(x - rect.x).padStart(5, "0")}.png`;
          const png = tileCanvas.toBuffer("image/png");
          writeFileSync(join(tilesTemporary, file), png);
          tiles.push({
            file,
            x: (x - rect.x) * 16,
            y: (y - rect.y) * 16,
            width: width * 16,
            height: currentRows,
            worldRect: core,
            bytes: png.length,
            sha256: createHash("sha256").update(png).digest("hex"),
          });
        }
        renderSeconds += (performance.now() - renderStarted) / 1000;
        bandCells += width * height;
        chunks++;
      }
      assert.equal(
        bandCells,
        rect.width * height,
        "Band coverage must be complete and non-overlapping",
      );
      throwIfAborted(signal);
      const compressionStarted = performance.now();
      await writer.writeRows(
        band.subarray(0, rowBytes * currentRows),
        currentRows,
      );
      compressionSeconds += (performance.now() - compressionStarted) / 1000;
      processedCells += bandCells;
      writtenRows += currentRows;
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      const progress = {
        phase: "export",
        processedCells,
        totalCells: rect.width * rect.height,
        writtenRows,
        totalRows: pixelHeight,
        chunks,
        elapsedSeconds: +((performance.now() - started) / 1000).toFixed(2),
        rssMiB: Math.round(process.memoryUsage().rss / 1048576),
      };
      writeFileSync(
        `${config.outputPath}.progress.json`,
        JSON.stringify(progress, null, 2),
      );
      await onProgress(progress);
      if (global.gc) global.gc();
    }
    throwIfAborted(signal);
    assert.equal(processedCells, rect.width * rect.height);
    assert.equal(writtenRows, pixelHeight);
    const stats = renderer.stats;
    assert.equal(
      stats.plannedCommands,
      stats.renderedCommands +
        sum(stats.missingCommands) +
        sum(stats.invalidCommands) +
        sum(stats.effectFailures),
    );
    if (tilesTemporary) {
      assert.equal(
        tiles.reduce((total, tile) => total + tile.width * tile.height, 0),
        pixelWidth * pixelHeight,
      );
      writeFileSync(
        join(tilesTemporary, "manifest.json"),
        JSON.stringify(
          {
            schema: "exploretv-full-resolution-tiles-v1",
            width: pixelWidth,
            height: pixelHeight,
            pixelsPerTile: 16,
            worldRect: rect,
            worldSha256,
            tiles,
          },
          null,
          2,
        ),
      );
    }
    const png = await writer.finish();
    if (tilesTemporary) renameSync(tilesTemporary, config.tilesPath);
    const report = {
      schema: "exploretv-full-resolution-export-v1",
      worldSha256,
      worldDimensions: { width: world.width, height: world.height },
      worldRect: rect,
      fullWorld:
        !config.region ||
        (rect.x === 0 &&
          rect.y === 0 &&
          rect.width === world.width &&
          rect.height === world.height),
      pixelsPerTile: 16,
      png,
      tiles: config.tilesPath
        ? {
            path: config.tilesPath,
            count: tiles.length,
            manifest: join(config.tilesPath, "manifest.json"),
          }
        : null,
      processedCells,
      writtenRows,
      chunks,
      bandTiles: config.bandTiles,
      chunkTiles: config.chunkTiles,
      haloTiles: HALO_TILES,
      bandBufferBytes: band.length,
      rowIndexBytes: index.bytes,
      rawRgbaBytes: pixelWidth * pixelHeight * 4,
      peakSampledRssBytes: Math.max(peakRssBytes, process.memoryUsage().rss),
      osPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      renderSeconds: +renderSeconds.toFixed(2),
      compressionSeconds: +compressionSeconds.toFixed(2),
      runtimeSeconds: +((performance.now() - started) / 1000).toFixed(2),
      inputEncoding: config.inputEncoding,
      sourceHashes,
      ordinaryBlockIds: [...ORDINARY_BLOCKS],
      storedFrameTileIds: [...STORED_FRAME_TILES],
      ...stats,
      limitations: [
        "Static fullbright rendering at 16 pixels per tile, without dynamic lighting.",
        "Uses the same supported sprite, wall, paint and static-liquid paths as the overview renderer; it does not add unsupported game objects.",
        "Missing sources, invalid crops, unsupported tile types, and unsupported liquid neighborhoods are recorded. Black can represent empty space or an omitted feature.",
        "PNG dimensions are standards-valid but exceed the dimension/pixel budgets of many ordinary viewers; use the optional ordinary-size tile files for compatibility.",
      ],
    };
    writeFileSync(`${config.outputPath}.json`, JSON.stringify(report, null, 2));
    writeFileSync(
      `${config.outputPath}.progress.json`,
      JSON.stringify(
        {
          phase: "done",
          processedCells,
          writtenRows,
          png,
          runtimeSeconds: report.runtimeSeconds,
        },
        null,
        2,
      ),
    );
    return report;
  } catch (error) {
    if (writer) await writer.abort(error);
    if (tilesTemporary)
      rmSync(tilesTemporary, { recursive: true, force: true });
    // If exclusive writer creation failed, this attempt owns no PNG/progress
    // state. Preserve a possibly running earlier export's progress report.
    if (writer)
      writeFileSync(
        `${config.outputPath}.progress.json`,
        JSON.stringify(
          {
            phase: "aborted",
            processedCells,
            writtenRows,
            message: error.message,
          },
          null,
          2,
        ),
      );
    throw error;
  } finally {
    renderer.dispose();
    canvas.width = canvas.height = 1;
    if (tileCanvas) tileCanvas.width = tileCanvas.height = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error("Export cancelled by signal"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const config = parseExportCli(process.argv.slice(2));
    if (config.help) console.log(USAGE);
    else {
      const result = await exportWorld(config, {
        signal: controller.signal,
        onProgress: (p) => console.log(JSON.stringify(p)),
      });
      console.log(
        JSON.stringify({
          phase: "done",
          png: result.png,
          processedCells: result.processedCells,
          runtimeSeconds: result.runtimeSeconds,
          report: `${config.outputPath}.json`,
        }),
      );
    }
  } catch (error) {
    console.error(`export-world: ${error.message}`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
