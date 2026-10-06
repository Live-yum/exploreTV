import { createRawTextureCache } from "./raw-texture-cache.mjs";
import { createSoftwareOverview } from "./software-overview.mjs";
import { createDirectTerrainOverview } from "./direct-terrain-overview.mjs";
import { createOverviewRgbaArena } from "./overview-rgba-arena.mjs";
import { createSceneFrameInterner } from "./scene-frame-interner.mjs";
import { createSceneCommandIndex } from "./scene-command-index.mjs";
import { createOverviewGeometryAnalysis } from "./overview-geometry.mjs";
import { createNodeOverviewTerrainPlanner } from "./overview-terrain-wasm.mjs";
import { createNodePngRgbaDecoder } from "./png-rgba-node.mjs";
import { createCompactStaticWaterfallRegistry } from "./compact-waterfall-registry.mjs";
import {
  prepareOpaqueOverview,
  createOverviewFrameMetadataCache,
} from "./overview-fast-path.mjs";
import { createStaticWaterfallRegistry } from "../core/static-waterfalls.mjs";
import { sceneFrameReservedBytes } from "../core/scene-batches.mjs";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  Reader,
  decodeRecord,
  validateRect,
  getWorldTileAccessor,
} from "../core/world.mjs";
import { planScene, planOverviewBand, renderScene } from "../core/renderer.mjs";
import { materializeOverviewCommand } from "../core/overview-command-buffer.mjs";
import { decodePngRgba } from "../core/png-rgba.mjs";
import { registerTextureSource, textureMemoryBytes } from "../core/assets.mjs";
import {
  prepareSceneFrames,
  sceneFrameKey,
  createSceneFrameCache,
} from "../core/scene-frames.mjs";

export const HALO_TILES = 10;
const TRACKED_COMMAND = 1;
const HIDDEN_COMMAND = 2;
const OUTSIDE_CORE_COMMAND = 4;
export function paddedWorldRect(world, rect, padding = HALO_TILES) {
  validateRect(rect, world.width, world.height);
  const x = Math.max(0, rect.x - padding),
    y = Math.max(0, rect.y - padding);
  const padded = {
    x,
    y,
    width: Math.min(world.width, rect.x + rect.width + padding) - x,
    height: Math.min(world.height, rect.y + rect.height + padding) - y,
  };
  validateRect(padded, world.width, world.height);
  return padded;
}
/** Sparse RLE checkpoints support scanline-order output without rereading entire columns. */
export function buildRowIndex(world, stride = 16) {
  if (!Number.isSafeInteger(stride) || stride < 1 || stride > 128)
    throw new Error("Invalid row-index stride");
  const bands = Math.ceil(world.height / stride),
    offsets = new Uint32Array(world.width * bands),
    starts = new Uint16Array(world.width * bands);
  const r = new Reader(world.bytes, world.sections[2]);
  let shimmerMinX = world.width,
    shimmerMaxX = -1;
  let shimmerMinY = world.height,
    shimmerMaxY = -1;
  for (let x = 0; x < world.width; x++) {
    r.pos = world.columns[x];
    let next = 0;
    for (let y = 0; y < world.height; ) {
      const offset = r.pos,
        rec = decodeRecord(r, world.important, false),
        end = y + rec.repeats + 1;
      if (rec.tile.liquid > 0 && rec.tile.liquidKind === 4) {
        shimmerMinX = Math.min(shimmerMinX, x);
        shimmerMaxX = Math.max(shimmerMaxX, x);
        shimmerMinY = Math.min(shimmerMinY, y);
        shimmerMaxY = Math.max(shimmerMaxY, end - 1);
      }
      while (next < end) {
        const i = x * bands + Math.floor(next / stride);
        offsets[i] = offset;
        starts[i] = y;
        next += stride;
      }
      y = end;
    }
  }
  return {
    stride,
    bands,
    offsets,
    starts,
    bytes: offsets.byteLength + starts.byteLength,
    shimmerBounds:
      shimmerMaxX < 0
        ? null
        : Object.freeze({
            minX: shimmerMinX,
            maxX: shimmerMaxX,
            minY: shimmerMinY,
            maxY: shimmerMaxY,
          }),
  };
}
/** Random read using the same validated sparse index, never a whole-column decode. */
export function readIndexedTile(world, index, x, y) {
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= world.width ||
    y >= world.height
  )
    return null;
  const i = x * index.bands + Math.floor(y / index.stride);
  const r = new Reader(world.bytes, world.sections[2]);
  r.pos = index.offsets[i];
  let start = index.starts[i];
  while (start <= y) {
    const rec = decodeRecord(r, world.important, false);
    start += rec.repeats + 1;
    if (y < start) return Object.freeze(rec.tile);
  }
  return null;
}

/** Bounded per-region RLE cursors amortize consecutive off-rectangle neighbor reads. */
export function createIndexedTileAccessor(world, index) {
  const columns = new Map();
  return (x, y) => {
    if (
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= world.width ||
      y >= world.height
    )
      return null;
    let state = columns.get(x);
    if (!state || y < state.start || y >= state.end + index.stride) {
      const i = x * index.bands + Math.floor(y / index.stride),
        reader = new Reader(world.bytes, world.sections[2]);
      reader.pos = index.offsets[i];
      state = {
        reader,
        start: index.starts[i],
        end: index.starts[i],
        tile: null,
      };
      columns.set(x, state);
      if (columns.size > 256) columns.delete(columns.keys().next().value);
    }
    while (y >= state.end) {
      const record = decodeRecord(state.reader, world.important, false);
      state.start = state.end;
      state.end += record.repeats + 1;
      state.tile = Object.freeze(record.tile);
    }
    return state.tile;
  };
}

export function readIndexedRegion(world, index, rect) {
  validateRect(rect, world.width, world.height);
  const fallbackTile = createIndexedTileAccessor(world, index);
  const cells = new Array(rect.width * rect.height),
    r = new Reader(world.bytes, world.sections[2]);
  for (let dx = 0; dx < rect.width; dx++) {
    const i = (rect.x + dx) * index.bands + Math.floor(rect.y / index.stride);
    r.pos = index.offsets[i];
    for (let y = index.starts[i]; y < rect.y + rect.height; ) {
      const rec = decodeRecord(r, world.important, false),
        end = y + rec.repeats + 1;
      for (
        let yy = Math.max(y, rect.y);
        yy < Math.min(end, rect.y + rect.height);
        yy++
      )
        cells[dx * rect.height + yy - rect.y] = rec.tile;
      y = end;
    }
  }
  return {
    rect,
    cells,
    ...(index.shimmerBounds !== undefined
      ? {
          indexedShimmerPossible:
            index.shimmerBounds !== null &&
            index.shimmerBounds.maxX >= rect.x - 1 &&
            index.shimmerBounds.minX <= rect.x + rect.width &&
            index.shimmerBounds.maxY >= rect.y - 11 &&
            index.shimmerBounds.minY < rect.y + rect.height,
        }
      : {}),
    version: world.version,
    important: world.important,
    treeContext: world.treeContext,
    herbContext: world.herbContext,
    getWorldTile: (x, y) => {
      if (
        Number.isSafeInteger(x) &&
        Number.isSafeInteger(y) &&
        x >= rect.x &&
        x < rect.x + rect.width &&
        y >= rect.y &&
        y < rect.y + rect.height
      )
        return cells[(x - rect.x) * rect.height + y - rect.y];
      return fallbackTile(x, y);
    },
    source: {
      signature: world.signature,
      name: world.name,
      id: world.id,
      width: world.width,
      height: world.height,
      worldSurface: world.worldSurface,
    },
  };
}
/** Explicit whole-world static registry: cap differs from a game viewport. */
export function createWorldWaterfallRegistry(world, { compact = false } = {}) {
  const started = performance.now();
  // The source scan excludes the outer world edge; tiny synthetic worlds have
  // no interior origin candidates, and need no fabricated neighbor records.
  if (world.width < 3 || world.height < 3)
    return {
      model: "fresh-static-empty-interior",
      scanComplete: true,
      viewport: { x: 0, y: 0, width: world.width, height: world.height },
      maxWaterfalls: 100000,
      requiredAssets: [],
      failures: [],
      origins: [],
      stats: {
        eligible: 0,
        registered: 0,
        capped: 0,
        commands: 0,
        unsupportedOrigins: 0,
      },
      hasOrigin: () => false,
      commandsFor: () => [],
      buildMilliseconds: 0,
    };
  const registry = (
    compact
      ? createCompactStaticWaterfallRegistry
      : createStaticWaterfallRegistry
  )(
    {
      width: world.width,
      height: world.height,
      worldSurface: world.worldSurface,
      getTile: getWorldTileAccessor(world),
    },
    {
      viewport: { x: 0, y: 0, width: world.width, height: world.height },
      quality: 1,
      maxWaterfalls: 100000,
      maxCommands: 1048576,
      waterStyle: 0,
      frame: 0,
      slowFrame: 0,
    },
  );
  return {
    ...registry,
    ...(compact
      ? {
          compactStorageBytes: registry.compactStorageBytes,
          compactTemplateCount: registry.compactTemplateCount,
        }
      : {}),
    buildMilliseconds: performance.now() - started,
  };
}

export function createWorldRenderer({
  assetDir,
  inputEncoding = "tconvert-game-raw",
  waterfallRegistry = null,
  onOmission = () => {},
  cacheFrames = true,
  lowMemory = false,
  nativeOverview = false,
  directTerrainOverview = false,
  compactTerrainOverview = false,
  onNativeBatch = null,
}) {
  const frameCache = cacheFrames
    ? createSceneFrameCache(
        lowMemory ? { maxFrames: 2048, maxBytes: 2 * 1024 * 1024 } : {},
      )
    : null;
  const frameMetadataCache = lowMemory
    ? createOverviewFrameMetadataCache()
    : null;
  const frameInterner = createSceneFrameInterner({ numericIds: lowMemory });
  const lazyRaw = lowMemory && inputEncoding === "tconvert-game-raw";
  const useDirectTerrain =
    lazyRaw && nativeOverview && directTerrainOverview && !onNativeBatch;
  const detailedRgbaArena = useDirectTerrain
    ? createOverviewRgbaArena({ maxBytes: 6 * 1024 * 1024 })
    : null;
  const softwareRenderer =
    lazyRaw && nativeOverview
      ? createSoftwareOverview({
          onNativeBatch,
          ...(useDirectTerrain
            ? { maxFrameBytes: 2 * 1024 * 1024, detailedRgbaArena }
            : {}),
        })
      : null;
  const directTerrainRenderer = useDirectTerrain
    ? createDirectTerrainOverview({
        detailedRgbaArena,
        resolvedCellMask:
          process.env.EXPLORETV_ENABLE_RESOLVED_CELL_MASK === "1" &&
          process.env.EXPLORETV_DISABLE_RESOLVED_CELL_MASK !== "1",
      })
    : null;
  const useCompactTerrain = useDirectTerrain && compactTerrainOverview;
  const terrainPlanner =
    useCompactTerrain && process.env.EXPLORETV_DISABLE_TERRAIN_WASM !== "1"
      ? createNodeOverviewTerrainPlanner()
      : null;
  const pngDecoder = lowMemory && !lazyRaw ? createNodePngRgbaDecoder() : null;
  const stats = {
    pngDecodeCache: pngDecoder?.stats ?? null,
    frameCache: frameCache?.stats ?? null,
    frameMetadataCache: frameMetadataCache?.stats ?? null,
    frameKeyInterner: frameInterner.stats,
    nativeOverview: softwareRenderer?.stats ?? null,
    directTerrainOverviewStats: directTerrainRenderer?.stats ?? null,
    compactTerrainPlanning: useCompactTerrain,
    terrainWasm: terrainPlanner?.stats ?? null,
    plannerPhaseMilliseconds: {
      walls: 0,
      liquids: 0,
      tiles: 0,
      layers: 0,
      total: 0,
      wasmPacking: 0,
      wasmPlanning: 0,
    },
    compactTerrainCommands: 0,
    compactTerrainFrames: 0,
    materializedTerrainCommands: 0,
    peakCompactTerrainBytes: 0,
    sharedDetailedRgba: detailedRgbaArena?.stats ?? null,
    skippedFramePreparationCommands: 0,
    stageMilliseconds: {
      plan: 0,
      assets: 0,
      batches: 0,
      prepareFrames: 0,
      validate: 0,
      draw: 0,
      opaqueOverview: 0,
      nativePartition: 0,
      sharedGeometry: 0,
      keyGeneration: 0,
      directTerrain: 0,
    },
    opaqueOverview: { eligibleTiles: 0, skippedCommands: 0, totalCommands: 0 },
    waterfalls: waterfallRegistry
      ? {
          model: waterfallRegistry.model,
          viewport: waterfallRegistry.viewport,
          maxWaterfalls: waterfallRegistry.maxWaterfalls,
          scanComplete: waterfallRegistry.scanComplete,
          stats: waterfallRegistry.stats,
          failures: waterfallRegistry.failures,
          buildMilliseconds: waterfallRegistry.buildMilliseconds,
          compactStorageBytes: waterfallRegistry.compactStorageBytes ?? null,
        }
      : null,
    assetCacheBytes: 0,
    peakAssetCacheBytes: 0,
    maxChunkCells: 0,
    maxPlanCommands: 0,
    maxPreparedBytes: 0,
    renderedCommands: 0,
    plannerCulledCommands: 0,
    earlyCulledHaloCommands: 0,
    generationCulledHaloCommands: 0,
    culledOutsideCoreCommands: 0,
    plannedCommands: 0,
    assetHashes: {},
    assetFailures: {},
    commandCounts: {},
    missingCommands: {},
    invalidCommands: {},
    effectFailures: {},
    liquidUnsupported: {},
    unsupportedTiles: {},
    sourceHiddenTiles: {},
  };
  const {
    assetHashes,
    assetFailures,
    commandCounts,
    missingCommands,
    invalidCommands,
    effectFailures,
    liquidUnsupported,
    unsupportedTiles,
  } = stats;
  const rawTextures = lazyRaw
    ? createRawTextureCache({
        assetDir,
        assetHashes,
        assetFailures,
        maxRawBytes: 8 * 1024 * 1024,
      })
    : null;
  stats.rawTextureCache = rawTextures?.stats ?? null;
  if (rawTextures) stats.pngDecodeCache = rawTextures.stats.pngDecodeCache;
  const assetCache = new Map(),
    MAX_ASSET_CACHE = (lowMemory ? 16 : 80) * 1024 * 1024;
  const add = (map, key, n = 1) => {
    map[key] = (map[key] || 0) + n;
  };
  const options = {
    paintEnabled: true,
    liquids: {
      enabled: true,
      frame: 0,
      waterfallFrame: 0,
      waterStyle: 0,
      layer: "foreground",
      ...(waterfallRegistry ? { waterfallRegistry } : {}),
    },
  };
  async function assetsFor(plan) {
    if (rawTextures) return rawTextures.assetsFor(plan.requiredAssets);
    const assets = new Map();
    for (const name of plan.requiredAssets) {
      let entry = assetCache.get(name);
      if (entry) {
        assetCache.delete(name);
        assetCache.set(name, entry);
      } else if (existsSync(join(assetDir, name))) {
        try {
          if (statSync(join(assetDir, name)).size > 8 * 1024 * 1024)
            throw new Error("PNG encoded size outside budget");
          const pngBytes = readFileSync(join(assetDir, name));
          const rawRgba = pngDecoder
            ? pngDecoder.decode(pngBytes)
            : decodePngRgba(pngBytes);
          // Raw-channel rendering always uses prepared frames. It never draws
          // the full atlas directly, so a second native decoded atlas is wasteful.
          const source =
            lowMemory && inputEncoding === "tconvert-game-raw"
              ? { width: rawRgba.width, height: rawRgba.height }
              : await loadImage(pngBytes);
          const image = registerTextureSource(source, {
            pngBytes,
            rawRgba,
          });
          entry = {
            image,
            bytes:
              lowMemory && inputEncoding === "tconvert-game-raw"
                ? rawRgba.data.byteLength + pngBytes.byteLength
                : textureMemoryBytes(image),
          };
          assetHashes[name] = createHash("sha256")
            .update(pngBytes)
            .digest("hex");
          assetCache.set(name, entry);
          stats.assetCacheBytes += entry.bytes;
        } catch (error) {
          assetFailures[name] = error.message;
        }
      }
      if (entry) assets.set(name, entry.image);
    }
    stats.peakAssetCacheBytes = Math.max(
      stats.peakAssetCacheBytes,
      stats.assetCacheBytes,
    );
    for (const [name, entry] of assetCache) {
      if (stats.assetCacheBytes <= MAX_ASSET_CACHE) break;
      assetCache.delete(name);
      stats.assetCacheBytes -= entry.bytes;
    }
    return { assets, dispose() {} };
  }
  function inCore(c, region, rect) {
    const x = c.x + region.rect.x,
      y = c.y + region.rect.y;
    return (
      x >= rect.x &&
      y >= rect.y &&
      x < rect.x + rect.width &&
      y < rect.y + rect.height
    );
  }
  function invalidCrop(c, asset) {
    return (
      c.sx < 0 ||
      c.sy < 0 ||
      c.sx + c.sw > (asset.naturalWidth ?? asset.width) ||
      c.sy + c.sh > (asset.naturalHeight ?? asset.height)
    );
  }
  // prepareSceneFrames has a hard 512-frame/8-MiB bound. Partition contiguous
  // command groups to retain draw order without silently dropping rare frames.
  function commandBatches(plan, keyCache) {
    const batches = [];
    let commands = [],
      keys = new Set(),
      reserved = 0;
    for (const c of plan.commands) {
      const key = keyCache.get(c),
        hasKey = keys.has(key),
        extra = hasKey ? 0 : sceneFrameReservedBytes(c);
      if (
        commands.length &&
        ((!hasKey && keys.size >= 450) || reserved + extra > 7 * 1024 * 1024)
      ) {
        batches.push(commands);
        commands = [];
        keys = new Set();
        reserved = 0;
      }
      if (!keys.has(key)) {
        keys.add(key);
        reserved += sceneFrameReservedBytes(c);
      }
      commands.push(c);
    }
    if (commands.length) batches.push(commands);
    return batches;
  }
  async function drawRegion(
    region,
    canvas,
    {
      core = region.rect,
      count = false,
      overview = false,
      coreSurface = false,
    } = {},
  ) {
    let stageStarted = performance.now();
    if (
      lowMemory &&
      coreSurface &&
      (![core.x, core.y, core.width, core.height].every(Number.isSafeInteger) ||
        core.width < 1 ||
        core.height < 1 ||
        core.x < region.rect.x ||
        core.y < region.rect.y ||
        core.x + core.width > region.rect.x + region.rect.width ||
        core.y + core.height > region.rect.y + region.rect.height)
    )
      throw new RangeError(
        "Core surface must be a positive integer rectangle contained by the scene",
      );
    // A returned native view remains readable through export reduction. Only
    // the next draw invalidates it and permits direct to reuse the same arena.
    if (directTerrainRenderer) softwareRenderer.releasePixels();
    const left = (core.x - region.rect.x) * 16,
      top = (core.y - region.rect.y) * 16,
      right = left + core.width * 16,
      bottom = top + core.height * 16;
    const compactOverview = overview && useCompactTerrain;
    const terrainFrames = compactOverview
      ? terrainPlanner?.plan(region, options)
      : null;
    const plan = (compactOverview ? planOverviewBand : planScene)(
      region,
      overview
        ? {
            ...options,
            ...(terrainFrames ? { overviewTerrainFrames: terrainFrames } : {}),
            ...(terrainFrames && terrainPlanner?.liquidCandidates
              ? { overviewLiquidCandidates: terrainPlanner.liquidCandidates }
              : {}),
            outputBounds: {
              x: left,
              y: top,
              width: right - left,
              height: bottom - top,
            },
          }
        : lowMemory && coreSurface
          ? { ...options, emissionCore: core }
          : options,
    );
    const plannerCulledCommands = plan.culledCommands ?? 0;
    stats.plannerCulledCommands += plannerCulledCommands;
    stats.generationCulledHaloCommands +=
      plan.generationCulling?.culledCommands ?? 0;
    stats.earlyCulledHaloCommands +=
      plan.generationCulling?.culledCommands ?? 0;
    stats.stageMilliseconds.plan += performance.now() - stageStarted;
    if (plan.planningMilliseconds)
      for (const [name, value] of Object.entries(plan.planningMilliseconds))
        stats.plannerPhaseMilliseconds[name] += value;
    if (terrainPlanner?.stats.phaseMilliseconds) {
      stats.plannerPhaseMilliseconds.wasmPacking =
        terrainPlanner.stats.phaseMilliseconds.packing;
      stats.plannerPhaseMilliseconds.wasmPlanning =
        terrainPlanner.stats.phaseMilliseconds.planning;
    }
    if (plan.compactTerrain) {
      stats.compactTerrainCommands +=
        plan.compactTerrain.records.length / plan.compactTerrain.stride;
      stats.compactTerrainFrames += plan.compactTerrain.frames.length;
      stats.peakCompactTerrainBytes = Math.max(
        stats.peakCompactTerrainBytes,
        plan.compactTerrain.records.buffer.byteLength,
      );
    }
    stageStarted = performance.now();
    const assetView = await assetsFor(plan);
    const useCoreSurface = lowMemory && coreSurface;
    let ctx = null,
      contextSaved = false,
      softwareOverview = null,
      directTerrain = null,
      keyCache = null;
    try {
      const assets = assetView.assets;
      stats.stageMilliseconds.assets += performance.now() - stageStarted;
      if (overview && directTerrainRenderer) {
        stageStarted = performance.now();
        // This bounded pass validates its handled commands against the same
        // complete asset view. Failed or complex draws remain in the general
        // pipeline, and its safe pixels include cross-boundary terrain draws.
        directTerrain = directTerrainRenderer.render(
          plan,
          core,
          region,
          assets,
        );
        stats.stageMilliseconds.directTerrain +=
          performance.now() - stageStarted;
      }
      let coreCommandCount = 0;
      if (count) {
        stats.maxChunkCells = Math.max(
          stats.maxChunkCells,
          region.cells.length,
        );
        stats.maxPlanCommands = Math.max(
          stats.maxPlanCommands,
          plan.generationCulling?.logicalCommands ??
            plan.commands.length + plannerCulledCommands,
        );
        for (const c of plan.sourceHiddenCells || [])
          if (
            c.x >= core.x &&
            c.y >= core.y &&
            c.x < core.x + core.width &&
            c.y < core.y + core.height
          )
            add(stats.sourceHiddenTiles, c.type);
        for (const c of plan.unsupportedCells)
          if (
            c.x >= core.x &&
            c.y >= core.y &&
            c.x < core.x + core.width &&
            c.y < core.y + core.height
          ) {
            add(unsupportedTiles, c.type);
            onOmission(c.x, c.y, 1);
          }
        for (const c of plan.support.liquidDrawing.unsupportedCoordinates)
          if (
            c.x >= core.x &&
            c.y >= core.y &&
            c.x < core.x + core.width &&
            c.y < core.y + core.height
          ) {
            add(liquidUnsupported, c.reason);
            onOmission(c.x, c.y, 2);
          }
      }
      const outsideCore = (c) =>
        lowMemory &&
        Number.isFinite(c.dx) &&
        Number.isFinite(c.dy) &&
        Number.isFinite(c.dw) &&
        Number.isFinite(c.dh) &&
        c.dw > 0 &&
        c.dh > 0 &&
        (c.dx + c.dw + 1 <= left ||
          c.dy + c.dh + 1 <= top ||
          c.dx - 1 >= right ||
          c.dy - 1 >= bottom);
      // Consume direct handled indices in the original plan domain before
      // assigning the compact index domain for remaining generic commands.
      stageStarted = performance.now();
      const renderCommands = lowMemory ? [] : plan.commands;
      for (let i = 0; i < plan.commands.length; i++) {
        const token = plan.commands[i];
        const compact =
          typeof token === "number" && token < 0 ? plan.compactTerrain : null;
        const at = compact ? (-token - 1) * compact.stride : 0;
        const c = compact ? compact.frames[compact.records[at]] : token;
        const ownerX = compact ? compact.records[at + 3] : c.x;
        const ownerY = compact ? compact.records[at + 4] : c.y;
        const ownerInCore = compact
          ? ownerX + region.rect.x >= core.x &&
            ownerY + region.rect.y >= core.y &&
            ownerX + region.rect.x < core.x + core.width &&
            ownerY + region.rect.y < core.y + core.height
          : inCore(c, region, core);
        const outside = compact
          ? compact.records[at + 1] + c.dw + 1 <= left ||
            compact.records[at + 2] + c.dh + 1 <= top ||
            compact.records[at + 1] - 1 >= right ||
            compact.records[at + 2] - 1 >= bottom
          : outsideCore(c);
        if (lowMemory && !ownerInCore && outside) {
          stats.earlyCulledHaloCommands++;
          continue;
        }
        if (ownerInCore) {
          coreCommandCount++;
          if (count) {
            stats.plannedCommands++;
            add(commandCounts, c.kind);
          }
        }
        if (directTerrain?.handled[i]) {
          // The direct pass proved the full source/crop/effect valid. Preserve
          // logical owner counts while skipping all repeated frame-key work.
          if (count && ownerInCore) stats.renderedCommands++;
          continue;
        }
        if (lowMemory) {
          renderCommands.push(
            compact ? materializeOverviewCommand(plan, token) : c,
          );
          if (compact) stats.materializedTerrainCommands++;
        }
      }
      const renderPlan = lowMemory
        ? { ...plan, commands: renderCommands }
        : plan;
      // Direct already partitions most commands. Avoid a second indexed
      // analysis allocation for its small generic residual; retain the shared
      // path for recording, generic-only and direct-fallback views.
      keyCache =
        lowMemory && !directTerrain
          ? createSceneCommandIndex(renderCommands)
          : new Map();
      for (const c of renderCommands) keyCache.set(c, frameInterner.key(c));
      stats.stageMilliseconds.keyGeneration += performance.now() - stageStarted;
      if (directTerrain && renderCommands.length === 0)
        return {
          plan,
          coreCommands: coreCommandCount,
          opaqueOverview: null,
          softwareOverview: null,
          directTerrainOverview: directTerrain,
          // No draw reached the general backing surface. The caller starts
          // with opaque black and applies the proven direct 1px cells below.
          rasterizedCommands: 0,
          readbackX: useCoreSurface ? 0 : left,
          readbackY: useCoreSurface ? 0 : top,
        };
      const metadata = frameMetadataCache?.view(
        assets,
        createCanvas,
        inputEncoding,
      );
      stageStarted = performance.now();
      const analysis =
        overview && softwareRenderer && !directTerrain
          ? createOverviewGeometryAnalysis(renderPlan, core, region, keyCache)
          : null;
      stats.stageMilliseconds.sharedGeometry +=
        performance.now() - stageStarted;
      stageStarted = performance.now();
      const opaqueOverview = overview
        ? prepareOpaqueOverview(renderPlan, assets, createCanvas, {
            frameCache,
            inputEncoding,
            keyCache,
            metadata,
            analysis,
          })
        : null;
      stats.stageMilliseconds.opaqueOverview +=
        performance.now() - stageStarted;
      if (opaqueOverview)
        for (const key of Object.keys(stats.opaqueOverview))
          stats.opaqueOverview[key] += opaqueOverview[key];
      stageStarted = performance.now();
      softwareOverview =
        overview && softwareRenderer
          ? softwareRenderer.begin(
              renderPlan,
              core,
              region,
              assets,
              keyCache,
              analysis,
            )
          : null;
      stats.stageMilliseconds.nativePartition +=
        performance.now() - stageStarted;
      // Fully native cores require no Canvas backing allocation or clear.
      // Mixed cores retain the original translated-core Canvas semantics.
      if (!softwareOverview || softwareOverview.unsafe.includes(1)) {
        const surfaceWidth = useCoreSurface ? core.width * 16 : plan.width;
        const surfaceHeight = useCoreSurface ? core.height * 16 : plan.height;
        if (canvas.width !== surfaceWidth) canvas.width = surfaceWidth;
        if (canvas.height !== surfaceHeight) canvas.height = surfaceHeight;
        ctx = canvas.getContext("2d");
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, surfaceWidth, surfaceHeight);
        if (useCoreSurface) {
          ctx.save();
          contextSaved = true;
          ctx.translate(-left, -top);
        }
      }
      let preparationCommands = renderPlan.commands;
      let preparationFlags = null;
      const rememberKeys = metadata ? new Set() : null;
      if (metadata) {
        stageStarted = performance.now();
        preparationCommands = [];
        preparationFlags = new Uint8Array(renderPlan.commands.length);
        const validations = new Map();
        for (const c of renderPlan.commands) {
          const tracked = count && inCore(c, region, core),
            key = keyCache.get(c);
          let validation = validations.get(key);
          // One key normally identifies one exact source crop. Compare the
          // original fields as well, so unusual key-string collisions retain
          // the old per-command source/crop checks and failure precedence.
          const previous = validation?.command;
          if (
            !previous ||
            (typeof key !== "number" &&
              (previous.asset !== c.asset ||
                previous.sx !== c.sx ||
                previous.sy !== c.sy ||
                previous.sw !== c.sw ||
                previous.sh !== c.sh))
          ) {
            const asset = assets.get(c.asset),
              missing = !asset,
              invalid = !missing && invalidCrop(c, asset);
            validation = {
              command: c,
              missing,
              invalid,
              known: missing || invalid ? null : metadata.get(c, key),
            };
            validations.set(key, validation);
          }
          if (validation.missing) {
            if (tracked) {
              add(missingCommands, c.asset);
              onOmission(c.x + region.rect.x, c.y + region.rect.y, 4);
            }
            continue;
          }
          if (validation.invalid) {
            if (tracked) {
              add(invalidCommands, c.asset);
              onOmission(c.x + region.rect.x, c.y + region.rect.y, 8);
            }
            continue;
          }
          const known = validation.known;
          if (known?.unsupported) {
            if (tracked) {
              add(effectFailures, known.unsupported);
              onOmission(c.x + region.rect.x, c.y + region.rect.y, 16);
            }
            continue;
          }
          const hidden = opaqueOverview?.skip.has(c),
            outside = !hidden && outsideCore(c);
          if (known && (hidden || outside)) {
            // Cached validation remains authoritative after native surfaces
            // have been evicted. Hidden/halo commands keep logical accounting
            // without materializing a surface that will never be drawn.
            if (outside) stats.culledOutsideCoreCommands++;
            if (tracked) stats.renderedCommands++;
            stats.skippedFramePreparationCommands++;
            continue;
          }
          // Never-seen hidden frames still pass through the original preparer
          // once, so an omitted effect cannot disappear from the report.
          if (!known) rememberKeys.add(key);
          preparationFlags[preparationCommands.length] =
            (tracked ? TRACKED_COMMAND : 0) |
            (hidden ? HIDDEN_COMMAND : 0) |
            (outside ? OUTSIDE_CORE_COMMAND : 0);
          preparationCommands.push(c);
        }
        // No command needs these records after preflight. The compact flags
        // below retain only the owner/visibility decisions for each batch.
        validations.clear();
        stats.stageMilliseconds.validate += performance.now() - stageStarted;
      }
      stageStarted = performance.now();
      const batches = commandBatches(
        { ...renderPlan, commands: preparationCommands },
        keyCache,
      );
      let rasterizedCommands = 0,
        validationOffset = 0;
      stats.stageMilliseconds.batches += performance.now() - stageStarted;
      for (const commands of batches) {
        stageStarted = performance.now();
        const part = { ...renderPlan, commands };
        const preparedPart = softwareOverview
          ? {
              ...part,
              commands: softwareOverview.preparationCommands(commands),
            }
          : part;
        const frames = prepareSceneFrames(preparedPart, assets, createCanvas, {
          frameCache,
          keyCache,
          inputEncoding: inputEncoding,
          opaqueScene: true,
        });
        stats.stageMilliseconds.prepareFrames +=
          performance.now() - stageStarted;
        stageStarted = performance.now();
        // The single opaque scene was initialized above. Keep it between batches.
        const frameView = { ...frames, opaqueScene: false };
        // renderScene rejects an entire asset if ANY crop is invalid. Filter the
        // invalid commands explicitly and report each instead of losing valid ones.
        const valid = [];
        for (const c of commands) {
          const flags = preparationFlags
              ? preparationFlags[validationOffset++]
              : 0,
            tracked = preparationFlags
              ? !!(flags & TRACKED_COMMAND)
              : count && inCore(c, region, core);
          // The metadata path already preflighted every source/crop before
          // deciding which commands require native preparation.
          if (!metadata) {
            const asset = assets.get(c.asset);
            if (!asset) {
              if (tracked) {
                add(missingCommands, c.asset);
                onOmission(c.x + region.rect.x, c.y + region.rect.y, 4);
              }
              continue;
            }
            if (invalidCrop(c, asset)) {
              if (tracked) {
                add(invalidCommands, c.asset);
                onOmission(c.x + region.rect.x, c.y + region.rect.y, 8);
              }
              continue;
            }
          }
          const resolved =
            softwareOverview?.resolveCached(c) ?? frames.resolve(c);
          if (rememberKeys?.size) {
            const key = keyCache.get(c);
            if (rememberKeys.delete(key)) {
              metadata.remember(c, key, resolved);
            }
          }
          if (resolved?.unsupported) {
            if (tracked) {
              add(effectFailures, resolved.unsupported);
              onOmission(c.x + region.rect.x, c.y + region.rect.y, 16);
            }
            continue;
          }
          const hidden = preparationFlags
            ? !!(flags & HIDDEN_COMMAND)
            : opaqueOverview?.skip.has(c);
          if (!hidden) {
            // Retained neighbor overhangs and every core owner preserve their
            // validated draw decision, including boundary antialiasing margins.
            const outside = preparationFlags
              ? !!(flags & OUTSIDE_CORE_COMMAND)
              : outsideCore(c);
            if (outside) stats.culledOutsideCoreCommands++;
            else valid.push(c);
          }
          if (tracked) stats.renderedCommands++;
        }
        stats.stageMilliseconds.validate += performance.now() - stageStarted;
        stageStarted = performance.now();
        rasterizedCommands += valid.length;
        const canvasCommands = softwareOverview
          ? softwareOverview.drawBatch(valid, frames)
          : valid;
        if (canvasCommands.length)
          renderScene(ctx, { ...part, commands: canvasCommands }, assets, {
            strict: true,
            sceneFrames: frameView,
          });
        stats.stageMilliseconds.draw += performance.now() - stageStarted;
        stats.maxPreparedBytes = Math.max(
          stats.maxPreparedBytes,
          frames.support.bytes,
        );
        frames.dispose();
      }
      return {
        plan,
        coreCommands: coreCommandCount,
        opaqueOverview,
        softwareOverview,
        directTerrainOverview: directTerrain,
        rasterizedCommands,
        readbackX: useCoreSurface ? 0 : left,
        readbackY: useCoreSurface ? 0 : top,
      };
    } catch (error) {
      // No caller can consume an output from a failed draw. Release only this
      // view's pixels; a reentrant replacement may already own the arena.
      softwareOverview?.releasePixels();
      throw error;
    } finally {
      softwareOverview?.finish();
      keyCache?.dispose?.();
      if (contextSaved) ctx.restore();
      assetView.dispose();
      if (rawTextures) {
        stats.assetCacheBytes = rawTextures.stats.retainedBytes;
        stats.peakAssetCacheBytes = rawTextures.stats.peakLiveBytes;
      }
    }
  }

  return {
    drawRegion,
    stats,
    dispose() {
      frameCache?.dispose();
      frameMetadataCache?.dispose();
      frameInterner.dispose();
      softwareRenderer?.dispose();
      directTerrainRenderer?.dispose();
      terrainPlanner?.dispose();
      detailedRgbaArena?.dispose();
      pngDecoder?.clear();
      rawTextures?.dispose();
      assetCache.clear();
      stats.assetCacheBytes = 0;
    },
  };
}
