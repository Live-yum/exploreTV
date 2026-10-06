import { getHeapStatistics } from "node:v8";
import {
  sampleProcessMemory,
  getProcessMemorySamplingStatus,
} from "./process-memory.mjs";
import { applyOpaqueOverview } from "./overview-fast-path.mjs";
import { createWorldWaterfallRegistry } from "./world-render-engine.mjs";
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
import { cpus, availableParallelism, platform, arch, release } from "node:os";
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
import {
  boxDownsampleRgbaNative,
  nativeReducerStatus,
  trimNativeMemory,
} from "./native-reducer.mjs";
import { mergeCanvasOverviewRows } from "./reduce-overview-canvas.mjs";

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

export function parseExportCli(argv, { pixelsPerTile = 16 } = {}) {
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
    pixelsPerTile,
    worldPath: positional[0],
    assetDir: positional[1],
    outputPath: positional[2],
  });
}

function validateConfig(config) {
  for (const [name, min, max] of [
    ["bandTiles", 1, (config.pixelsPerTile ?? 16) < 16 ? 128 : 32],
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
  { signal, onProgress = () => {}, commandRecorder = null } = {},
) {
  validateConfig(config);
  const pixelsPerTile = config.pixelsPerTile ?? 16;
  if (![1, 2, 4, 8, 16].includes(pixelsPerTile))
    throw new Error("pixelsPerTile must be 1, 2, 4, 8 or 16");
  const overview = pixelsPerTile < 16;
  if (
    commandRecorder &&
    (pixelsPerTile !== 1 || config.inputEncoding !== "tconvert-game-raw")
  )
    throw new Error(
      "World instruction preparation requires 1 px/tile raw input",
    );
  if (overview && config.tilesPath)
    throw new Error("Direct overview does not emit full-resolution tile files");
  throwIfAborted(signal);
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
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
  const worldReadHashSeconds = (performance.now() - started) / 1000;
  let setupStarted = performance.now();
  const world = openWorld(bytes),
    rect = config.region || {
      x: 0,
      y: 0,
      width: world.width,
      height: world.height,
    };
  if (rect.x + rect.width > world.width || rect.y + rect.height > world.height)
    throw new Error("Export region is outside world");
  const worldParseSeconds = (performance.now() - setupStarted) / 1000;
  if (
    overview &&
    rect.width * rect.height >= 1000000 &&
    (typeof global.gc !== "function" ||
      getHeapStatistics().heap_size_limit > 120000000)
  )
    throw new Error(
      "Large overview requires bounded Node memory: use npm run export:overview, or --expose-gc --max-old-space-size=48 --max-semi-space-size=4",
    );
  const plannedChunks =
    Math.ceil(rect.width / config.chunkTiles) *
    Math.ceil(rect.height / config.bandTiles);
  if (config.tilesPath && plannedChunks > 100000)
    throw new Error(
      "Tile export exceeds 100000 pieces; increase chunk-tiles or band-tiles",
    );
  const pixelWidth = rect.width * pixelsPerTile,
    pixelHeight = rect.height * pixelsPerTile;
  const bandRows = Math.min(config.bandTiles, rect.height) * pixelsPerTile,
    rowBytes = pixelWidth * 4;
  setupStarted = performance.now();
  const band = Buffer.allocUnsafe(rowBytes * bandRows),
    index = buildRowIndex(world, overview ? 32 : 16);
  const rowIndexSeconds = (performance.now() - setupStarted) / 1000;
  const waterfallRegistry = createWorldWaterfallRegistry(world, {
    compact: overview,
  });
  if (overview && global.gc) {
    global.gc();
    await new Promise(setImmediate);
  }
  const checkOverviewBudget = () => {
    if (!overview) return;
    if (process.resourceUsage().maxRSS * 1024 > 500000000)
      throw new Error(
        "Overview exceeded the 500,000,000-byte total process RSS limit",
      );
    if ((performance.now() - started) / 1000 >= 600)
      throw new Error("Overview exceeded the 600-second generation limit");
  };
  checkOverviewBudget();
  const renderer = createWorldRenderer({
    onNativeBatch: commandRecorder
      ? (batch) => commandRecorder.recordBatch(batch)
      : null,
    lowMemory: overview,
    nativeOverview: overview,
    directTerrainOverview:
      pixelsPerTile === 1 &&
      !commandRecorder &&
      process.env.EXPLORETV_DISABLE_DIRECT_TERRAIN !== "1",
    waterfallRegistry,
    assetDir: config.assetDir,
    inputEncoding: config.inputEncoding,
  });
  const canvas = createCanvas(1, 1),
    tileCanvas = config.tilesPath ? createCanvas(1, 1) : null;
  const sourceHashes = {};
  for (const relative of [
    "scripts/export-world.mjs",
    "scripts/export-overview.mjs",
    "scripts/prepared-world.mjs",
    "scripts/prepared-world-tape.mjs",
    "scripts/direct-terrain-overview.mjs",
    "scripts/direct-slope-overview-frame.mjs",
    "scripts/overview-rgba-arena.mjs",
    "scripts/downsample-rgba.mjs",
    "scripts/reduce-overview-canvas.mjs",
    "scripts/overview-fast-path.mjs",
    "scripts/raw-overview-frame.mjs",
    "scripts/slope-overview-frame.mjs",
    "scripts/compact-waterfall-registry.mjs",
    "scripts/png-stream.mjs",
    "scripts/png-rgba-node.mjs",
    "scripts/raw-texture-cache.mjs",
    "scripts/process-memory.mjs",
    "scripts/native-reducer.mjs",
    "scripts/native-reducer.c",
    "scripts/native-blitter.mjs",
    "scripts/native-blitter.c",
    "scripts/software-overview.mjs",
    "scripts/scene-frame-interner.mjs",
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
    "core/liquid-mixed-halfbrick.mjs",
    "core/static-waterfalls.mjs",
    "core/scene-batches.mjs",
    "core/liquid-composite.mjs",
    "core/liquid-shimmer.mjs",
    "core/liquid-special-context.mjs",
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
    compressionSeconds = 0,
    readbackAndReductionSeconds = 0,
    skippedReadbackChunks = 0,
    regionDecodeSeconds = 0,
    garbageCollectionSeconds = 0,
    nativeFinalizationSeconds = 0,
    chunksSinceMajorGc = 0,
    canvasPendingMajorGc = false;
  const overviewGc = {
    nativeOverviewInterval: 4,
    canvasInterval: 2,
    nativeOverviewChunks: 0,
    canvasChunks: 0,
    chunkMajorCollections: 0,
    chunkMinorCollections: 0,
    bandMajorCollections: 0,
  };
  const nativeMemoryTrimming = {
    ...nativeReducerStatus.nativeMemoryTrim,
    calls: 0,
    releasedCalls: 0,
    seconds: 0,
  };
  const yieldForNativeFinalization = async (major = false) => {
    // Keep this macrotask yield AFTER collection and BEFORE allocator trimming
    // or budget checks, so N-API finalizers can release dead native surfaces.
    const finalizeStarted = performance.now();
    await new Promise(setImmediate);
    nativeFinalizationSeconds += (performance.now() - finalizeStarted) / 1000;
    if (major && nativeMemoryTrimming.available) {
      const trimStarted = performance.now();
      const result = trimNativeMemory();
      nativeMemoryTrimming.calls++;
      if (result.released) nativeMemoryTrimming.releasedCalls++;
      nativeMemoryTrimming.seconds += (performance.now() - trimStarted) / 1000;
    }
  };
  const memorySamples = [];
  const preparedPixelHash = commandRecorder ? createHash("sha256") : null;
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
    // Keep chunk-local plans, tile objects and N-API readbacks out of the
    // suspended outer loop before collection and its required macrotask yield.
    const renderChunk = async (x, y, width, height, currentRows) => {
      const core = { x, y, width, height };
      commandRecorder?.beginChunk(core);
      const regionStarted = performance.now();
      const region = readIndexedRegion(
        world,
        index,
        paddedWorldRect(world, core),
      );
      regionDecodeSeconds += (performance.now() - regionStarted) / 1000;
      const renderStarted = performance.now();
      const drawn = await renderer.drawRegion(region, canvas, {
        core,
        count: true,
        overview: pixelsPerTile === 1,
        coreSurface: overview,
      });
      let rgba;
      const readbackAndReductionStarted = performance.now();
      let data;
      if (drawn.softwareOverview) {
        const software = drawn.softwareOverview;
        data = boxDownsampleRgbaNative(
          software.pixels,
          width * 16,
          height * 16,
          16,
          drawn.directTerrainOverview
            ? {
                safe: drawn.directTerrainOverview.safe,
                rgba: drawn.directTerrainOverview.pixels,
                widthTiles: width,
              }
            : drawn.opaqueOverview
              ? {
                  safe: drawn.opaqueOverview.safe,
                  rgba: drawn.opaqueOverview.rgba,
                  widthTiles: drawn.opaqueOverview.widthTiles,
                  offsetX: core.x - region.rect.x,
                  offsetY: core.y - region.rect.y,
                }
              : null,
        );
        if (software.canvasCommands) {
          // Native cells already contain the exact area mean. Only cells touched
          // by a complex draw read the independently composited Canvas pixels.
          // Each readback request is row-sized; GC/finalization controls when
          // the resulting native allocations are actually released.
          mergeCanvasOverviewRows(
            canvas,
            data,
            software.unsafe,
            width,
            height,
            drawn.readbackX,
            drawn.readbackY,
          );
        } else skippedReadbackChunks++;
      } else if (overview && drawn.rasterizedCommands === 0) {
        // No ordinary draw reached the core. Its compositor background is
        // opaque black; exact opaque-frame means are applied below as usual.
        // Avoid allocating and reading a full-detail native ImageData for it.
        data = Buffer.alloc(width * height * pixelsPerTile * pixelsPerTile * 4);
        for (let i = 3; i < data.length; i += 4) data[i] = 255;
        skippedReadbackChunks++;
      } else {
        rgba = canvas
          .getContext("2d")
          .getImageData(
            drawn.readbackX,
            drawn.readbackY,
            width * 16,
            height * 16,
          );
        const fullData = Buffer.from(
          rgba.data.buffer,
          rgba.data.byteOffset,
          rgba.data.byteLength,
        );
        data = overview
          ? boxDownsampleRgbaNative(
              fullData,
              width * 16,
              height * 16,
              16 / pixelsPerTile,
              drawn.directTerrainOverview
                ? {
                    safe: drawn.directTerrainOverview.safe,
                    rgba: drawn.directTerrainOverview.pixels,
                    widthTiles: width,
                  }
                : drawn.opaqueOverview
                  ? {
                      ...drawn.opaqueOverview,
                      offsetX: core.x - region.rect.x,
                      offsetY: core.y - region.rect.y,
                    }
                  : null,
            )
          : fullData;
      }
      if (drawn.opaqueOverview)
        applyOpaqueOverview(data, core, region, drawn.opaqueOverview);
      if (drawn.directTerrainOverview) {
        const { safe, pixels } = drawn.directTerrainOverview;
        assert.equal(pixelsPerTile, 1);
        assert.equal(safe.length, width * height);
        assert.equal(pixels.length, data.length);
        // These complete cells were proven unaffected by every command left
        // to the general renderer. Their ordered raw compositing and reduction
        // use the same integer kernels; copy only that proven subset.
        for (let cell = 0; cell < safe.length; cell++) {
          if (!safe[cell]) continue;
          const i = cell * 4;
          data[i] = pixels[i];
          data[i + 1] = pixels[i + 1];
          data[i + 2] = pixels[i + 2];
          data[i + 3] = pixels[i + 3];
        }
      }
      commandRecorder?.endChunk(data, drawn.softwareOverview?.pixels ?? null);
      readbackAndReductionSeconds +=
        (performance.now() - readbackAndReductionStarted) / 1000;
      const chunkRowBytes = width * pixelsPerTile * 4;
      for (let py = 0; py < currentRows; py++)
        data.copy(
          band,
          py * rowBytes + (x - rect.x) * pixelsPerTile * 4,
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
      // Return only primitives: plans, frames and readbacks must not survive in
      // the outer loop while it collects and waits for native finalization.
      return {
        seconds: (performance.now() - renderStarted) / 1000,
        softwareOverview:
          pixelsPerTile === 1 &&
          (!!drawn.softwareOverview ||
            (!!drawn.directTerrainOverview && drawn.rasterizedCommands === 0)),
      };
    };
    for (let y = rect.y; y < rect.y + rect.height; y += config.bandTiles) {
      throwIfAborted(signal);
      const height = Math.min(config.bandTiles, rect.y + rect.height - y),
        currentRows = height * pixelsPerTile;
      let bandCells = 0;
      for (let x = rect.x; x < rect.x + rect.width; x += config.chunkTiles) {
        throwIfAborted(signal);
        const width = Math.min(config.chunkTiles, rect.x + rect.width - x);
        const rendered = await renderChunk(x, y, width, height, currentRows);
        renderSeconds += rendered.seconds;
        bandCells += width * height;
        chunks++;
        if (overview) {
          if (rendered.softwareOverview) overviewGc.nativeOverviewChunks++;
          else overviewGc.canvasChunks++;
          chunksSinceMajorGc++;
          // A full-Canvas chunk needs the original two-chunk collection bound.
          // Keep that bound until the next major GC even if a following chunk
          // returns to the native path; module availability alone proves none
          // of these allocation lifetimes.
          canvasPendingMajorGc ||= !rendered.softwareOverview;
          const majorGcInterval = canvasPendingMajorGc
              ? overviewGc.canvasInterval
              : overviewGc.nativeOverviewInterval,
            major = chunksSinceMajorGc >= majorGcInterval;
          const gcStarted = performance.now();
          if (global.gc) {
            global.gc({ type: major ? "major" : "minor" });
            if (major) {
              overviewGc.chunkMajorCollections++;
              chunksSinceMajorGc = 0;
              canvasPendingMajorGc = false;
            } else overviewGc.chunkMinorCollections++;
          }
          garbageCollectionSeconds += (performance.now() - gcStarted) / 1000;
          await yieldForNativeFinalization(
            major && typeof global.gc === "function",
          );
          checkOverviewBudget();
        }
      }
      assert.equal(
        bandCells,
        rect.width * height,
        "Band coverage must be complete and non-overlapping",
      );
      throwIfAborted(signal);
      const compressionStarted = performance.now();
      preparedPixelHash?.update(band.subarray(0, rowBytes * currentRows));
      await writer.writeRows(
        band.subarray(0, rowBytes * currentRows),
        currentRows,
      );
      compressionSeconds += (performance.now() - compressionStarted) / 1000;
      checkOverviewBudget();
      processedCells += bandCells;
      writtenRows += currentRows;
      const memory = sampleProcessMemory();
      memorySamples.push({
        writtenRows,
        ...memory,
        osPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      });
      peakRssBytes = Math.max(peakRssBytes, memory.rss);
      const progress = {
        phase: "export",
        processedCells,
        totalCells: rect.width * rect.height,
        writtenRows,
        totalRows: pixelHeight,
        chunks,
        elapsedSeconds: +((performance.now() - started) / 1000).toFixed(2),
        rssMiB: Math.round(memory.rss / 1048576),
        rssCurrentAvailable: memory.rssCurrentAvailable,
        rssSource: memory.rssSource,
      };
      writeFileSync(
        `${config.outputPath}.progress.json`,
        JSON.stringify(progress, null, 2),
      );
      await onProgress(progress);
      checkOverviewBudget();
      const gcStarted = performance.now();
      if (global.gc) {
        global.gc();
        if (overview) {
          overviewGc.bandMajorCollections++;
          chunksSinceMajorGc = 0;
          canvasPendingMajorGc = false;
        }
      }
      garbageCollectionSeconds += (performance.now() - gcStarted) / 1000;
      if (overview)
        await yieldForNativeFinalization(typeof global.gc === "function");
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
    checkOverviewBudget();
    const png = await writer.finish({ beforePublish: checkOverviewBudget });
    checkOverviewBudget();
    if (tilesTemporary) renameSync(tilesTemporary, config.tilesPath);
    const report = {
      preparedWorldPixelSha256: preparedPixelHash?.digest("hex") ?? null,
      schema: overview
        ? "exploretv-direct-overview-export-v1"
        : "exploretv-full-resolution-export-v1",
      worldSha256,
      worldDimensions: { width: world.width, height: world.height },
      worldRect: rect,
      fullWorld:
        !config.region ||
        (rect.x === 0 &&
          rect.y === 0 &&
          rect.width === world.width &&
          rect.height === world.height),
      pixelsPerTile,
      renderPixelsPerTile: 16,
      reduction: overview
        ? {
            method: "integer-area-premultiplied-alpha",
            factor: 16 / pixelsPerTile,
            colorSpace:
              "encoded-sRGB (same composited byte space as full export)",
            inputPixelsPerOutput: (16 / pixelsPerTile) ** 2,
            fullResolutionFileWritten: false,
            fullResolutionTilesWritten: false,
            fullResolutionImageAllocated: false,
            compositeBeforeReduction: true,
          }
        : null,
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
      fullResolutionRgbaBytes: rect.width * rect.height * 16 * 16 * 4,
      peakSampledRssBytes: Math.max(peakRssBytes, sampleProcessMemory().rss),
      memorySampling: getProcessMemorySamplingStatus(),
      nativeReducer: nativeReducerStatus,
      osPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      renderSeconds: +renderSeconds.toFixed(2),
      timingMeaning:
        "Runtime is exporter wall time; render includes prepare/draw/readback/reduction. Phase times exclude pauses for native finalization.",
      compressionSeconds: +compressionSeconds.toFixed(2),
      readbackAndReductionSeconds: +readbackAndReductionSeconds.toFixed(2),
      downsampleSeconds: +readbackAndReductionSeconds.toFixed(2),
      readbackAndReductionMeaning:
        "Includes all Canvas readback, reduction, blank-output initialization and opaque-mean merging, for every backend. downsampleSeconds is a compatibility alias; older reports excluded full-Canvas readback and are not phase-comparable.",
      skippedReadbackChunks,
      regionDecodeSeconds: +regionDecodeSeconds.toFixed(3),
      garbageCollectionSeconds: +garbageCollectionSeconds.toFixed(3),
      majorGcInterval: !overview
        ? null
        : overviewGc.canvasChunks === 0
          ? overviewGc.nativeOverviewInterval
          : overviewGc.nativeOverviewChunks === 0
            ? overviewGc.canvasInterval
            : null,
      overviewGc: overview
        ? {
            ...overviewGc,
            meaning:
              "When GC is available, at most 4 chunks between major collections for actual 1px software-overview cores; any Canvas fallback lowers the pending interval to 2 until collection. A major collection also follows each output band. Collection counts include only GC calls actually made.",
          }
        : null,
      nativeFinalizationSeconds: +nativeFinalizationSeconds.toFixed(3),
      nativeMemoryTrimming: {
        ...nativeMemoryTrimming,
        seconds: +nativeMemoryTrimming.seconds.toFixed(3),
      },
      memorySamples,
      runtimeSeconds: +((performance.now() - started) / 1000).toFixed(2),
      inputEncoding: config.inputEncoding,
      resourceLimits: overview
        ? {
            rssBytes: 500000000,
            runtimeSeconds: 600,
            preferredRssBytes: 300000000,
            renderingProcesses: 1,
            childProcesses: 0,
          }
        : null,
      preparationSeconds: {
        worldReadHash: worldReadHashSeconds,
        worldParse: worldParseSeconds,
        rowIndex: rowIndexSeconds,
        waterfalls: waterfallRegistry.buildMilliseconds / 1000,
      },
      environment: {
        node: process.version,
        platform: platform(),
        arch: arch(),
        release: release(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpus: cpus().length,
        availableParallelism: availableParallelism(),
        rendererWorkers: 1,
        nodeArguments: [...process.execArgv],
        allocator: {
          requestedArenaMax: process.env.MALLOC_ARENA_MAX ?? null,
          requestedMmapThreshold: process.env.MALLOC_MMAP_THRESHOLD_ ?? null,
          glibcArenaMaxTunable:
            process.env.GLIBC_TUNABLES?.split(":")
              .find((value) => value.startsWith("glibc.malloc.arena_max="))
              ?.slice("glibc.malloc.arena_max=".length) ?? null,
          glibcMmapThresholdTunable:
            process.env.GLIBC_TUNABLES?.split(":")
              .find((value) => value.startsWith("glibc.malloc.mmap_threshold="))
              ?.slice("glibc.malloc.mmap_threshold=".length) ?? null,
          scope: "startup environment; only applicable to the glibc allocator",
          effectiveArenaCount: null,
        },
        processCpuSeconds:
          (process.cpuUsage(cpuStarted).user +
            process.cpuUsage(cpuStarted).system) /
          1e6,
      },
      sourceHashes,
      ordinaryBlockIds: [...ORDINARY_BLOCKS],
      storedFrameTileIds: [...STORED_FRAME_TILES],
      ...stats,
      frameCache: stats.frameCache ? { ...stats.frameCache } : null,
      frameMetadataCache: stats.frameMetadataCache
        ? { ...stats.frameMetadataCache }
        : null,
      frameKeyInterner: { ...stats.frameKeyInterner },
      nativeOverview: stats.nativeOverview ? { ...stats.nativeOverview } : null,
      sharedDetailedRgba: stats.sharedDetailedRgba
        ? { ...stats.sharedDetailedRgba }
        : null,
      directTerrainOverview: stats.directTerrainOverviewStats
        ? structuredClone(stats.directTerrainOverviewStats)
        : null,
      rawTextureCache: stats.rawTextureCache
        ? structuredClone(stats.rawTextureCache)
        : null,
      pngDecodeCache: stats.pngDecodeCache ? { ...stats.pngDecodeCache } : null,
      limitations: [
        `Static fullbright composition at 16 pixels per tile, exported at ${pixelsPerTile} pixels per tile, without dynamic lighting.`,
        "Uses the same supported sprite, wall, paint and static-liquid paths as the overview renderer; it does not add unsupported game objects.",
        "Missing sources, invalid crops, unsupported tile types, and unsupported liquid neighborhoods are recorded. Black can represent empty space or an omitted feature.",
        ...(overview
          ? [
              "Area reduction uses all composited source pixels but small details can blend away at the selected overview scale; use the full-detail export to inspect individual pixels.",
              "Render coverage and unsupported-feature limitations are unchanged; reduced output is not a separate map-palette rendering.",
            ]
          : [
              "PNG dimensions are standards-valid but exceed the dimension/pixel budgets of many ordinary viewers; use the optional ordinary-size tile files for compatibility.",
            ]),
      ],
    };
    checkOverviewBudget();
    writeFileSync(`${config.outputPath}.json`, JSON.stringify(report, null, 2));
    checkOverviewBudget();
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
    checkOverviewBudget();
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
            osPeakRssBytes: process.resourceUsage().maxRSS * 1024,
            runtimeSeconds: (performance.now() - started) / 1000,
            completePngRetainedForDiagnostics: existsSync(config.outputPath),
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
