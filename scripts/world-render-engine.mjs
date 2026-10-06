import { createRawTextureCache } from "./raw-texture-cache.mjs";
import { createNodePngRgbaDecoder } from "./png-rgba-node.mjs";
import { createCompactStaticWaterfallRegistry } from "./compact-waterfall-registry.mjs";
import { prepareOpaqueOverview } from "./overview-fast-path.mjs";
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
import { planScene, renderScene } from "../core/renderer.mjs";
import { decodePngRgba } from "../core/png-rgba.mjs";
import { registerTextureSource, textureMemoryBytes } from "../core/assets.mjs";
import {
  prepareSceneFrames,
  sceneFrameKey,
  createSceneFrameCache,
} from "../core/scene-frames.mjs";

export const HALO_TILES = 10;
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
  for (let x = 0; x < world.width; x++) {
    r.pos = world.columns[x];
    let next = 0;
    for (let y = 0; y < world.height; ) {
      const offset = r.pos,
        rec = decodeRecord(r, world.important, false),
        end = y + rec.repeats + 1;
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
}) {
  const frameCache = cacheFrames
    ? createSceneFrameCache(
        lowMemory ? { maxFrames: 2048, maxBytes: 2 * 1024 * 1024 } : {},
      )
    : null;
  const lazyRaw = lowMemory && inputEncoding === "tconvert-game-raw";
  const pngDecoder = lowMemory && !lazyRaw ? createNodePngRgbaDecoder() : null;
  const stats = {
    pngDecodeCache: pngDecoder?.stats ?? null,
    frameCache: frameCache?.stats ?? null,
    stageMilliseconds: {
      plan: 0,
      assets: 0,
      batches: 0,
      prepareFrames: 0,
      validate: 0,
      draw: 0,
      opaqueOverview: 0,
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
        extra = keys.has(key) ? 0 : sceneFrameReservedBytes(c);
      if (
        commands.length &&
        ((!keys.has(key) && keys.size >= 450) ||
          reserved + extra > 7 * 1024 * 1024)
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
    const left = (core.x - region.rect.x) * 16,
      top = (core.y - region.rect.y) * 16,
      right = left + core.width * 16,
      bottom = top + core.height * 16;
    const plan = planScene(region, options);
    stats.stageMilliseconds.plan += performance.now() - stageStarted;
    stageStarted = performance.now();
    const assetView = await assetsFor(plan);
    const useCoreSurface = lowMemory && coreSurface;
    const ctx = canvas.getContext("2d");
    let contextSaved = false;
    try {
      const assets = assetView.assets;
      stats.stageMilliseconds.assets += performance.now() - stageStarted;
      // A same-size resize discards the backing store even when dimensions do
      // not change. Reuse it; the opaque fill below replaces every scene pixel.
      const surfaceWidth = useCoreSurface ? core.width * 16 : plan.width;
      const surfaceHeight = useCoreSurface ? core.height * 16 : plan.height;
      if (canvas.width !== surfaceWidth) canvas.width = surfaceWidth;
      if (canvas.height !== surfaceHeight) canvas.height = surfaceHeight;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, surfaceWidth, surfaceHeight);
      if (useCoreSurface) {
        // Planning keeps the complete halo. Translate the same ordered draws
        // onto a core-sized surface; its device clip replaces the later crop.
        ctx.save();
        contextSaved = true;
        ctx.translate(-left, -top);
      }
      const coreCommands = plan.commands.filter((c) => inCore(c, region, core));
      if (count) {
        stats.maxChunkCells = Math.max(
          stats.maxChunkCells,
          region.cells.length,
        );
        stats.maxPlanCommands = Math.max(
          stats.maxPlanCommands,
          plan.commands.length,
        );
        for (const c of coreCommands) {
          stats.plannedCommands++;
          add(commandCounts, c.kind);
        }
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
      // A private, immutable plan is used only during this draw. Intern each full
      // frame key once instead of rebuilding it at batching, validation and draw.
      const keyCache = new Map(),
        internedKeys = new Map();
      for (const c of plan.commands) {
        const key = sceneFrameKey(c);
        if (!internedKeys.has(key)) internedKeys.set(key, key);
        keyCache.set(c, internedKeys.get(key));
      }
      stageStarted = performance.now();
      const opaqueOverview = overview
        ? prepareOpaqueOverview(plan, assets, createCanvas, {
            frameCache,
            inputEncoding,
            keyCache,
          })
        : null;
      stats.stageMilliseconds.opaqueOverview +=
        performance.now() - stageStarted;
      if (opaqueOverview)
        for (const key of Object.keys(stats.opaqueOverview))
          stats.opaqueOverview[key] += opaqueOverview[key];
      stageStarted = performance.now();
      const batches = commandBatches(plan, keyCache);
      let rasterizedCommands = 0;
      stats.stageMilliseconds.batches += performance.now() - stageStarted;
      for (const commands of batches) {
        stageStarted = performance.now();
        const part = { ...plan, commands };
        const frames = prepareSceneFrames(part, assets, createCanvas, {
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
          const tracked = count && inCore(c, region, core),
            asset = assets.get(c.asset);
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
          const resolved = frames.resolve(c);
          if (resolved?.unsupported) {
            if (tracked) {
              add(effectFailures, resolved.unsupported);
              onOmission(c.x + region.rect.x, c.y + region.rect.y, 16);
            }
            continue;
          }
          if (!opaqueOverview?.skip.has(c)) {
            // Neighbor tiles still participate in planning and validation. Only
            // native draws whose destination cannot touch the exported core are
            // omitted; overhanging sprites and boundary antialiasing stay intact.
            const outside =
              lowMemory &&
              [c.dx, c.dy, c.dw, c.dh].every(Number.isFinite) &&
              c.dw > 0 &&
              c.dh > 0 &&
              (c.dx + c.dw + 1 <= left ||
                c.dy + c.dh + 1 <= top ||
                c.dx - 1 >= right ||
                c.dy - 1 >= bottom);
            if (outside) stats.culledOutsideCoreCommands++;
            else valid.push(c);
          }
          if (tracked) stats.renderedCommands++;
        }
        stats.stageMilliseconds.validate += performance.now() - stageStarted;
        stageStarted = performance.now();
        rasterizedCommands += valid.length;
        renderScene(ctx, { ...part, commands: valid }, assets, {
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
        coreCommands: coreCommands.length,
        opaqueOverview,
        rasterizedCommands,
        readbackX: useCoreSurface ? 0 : left,
        readbackY: useCoreSurface ? 0 : top,
      };
    } finally {
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
      pngDecoder?.clear();
      rawTextures?.dispose();
      assetCache.clear();
      stats.assetCacheBytes = 0;
    },
  };
}
