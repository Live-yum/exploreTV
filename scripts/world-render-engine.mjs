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
import { prepareSceneFrames, sceneFrameKey } from "../core/scene-frames.mjs";

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
        rec = decodeRecord(r, world.important),
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
export function readIndexedRegion(world, index, rect) {
  validateRect(rect, world.width, world.height);
  const cells = new Array(rect.width * rect.height),
    r = new Reader(world.bytes, world.sections[2]);
  for (let dx = 0; dx < rect.width; dx++) {
    const i = (rect.x + dx) * index.bands + Math.floor(rect.y / index.stride);
    r.pos = index.offsets[i];
    for (let y = index.starts[i]; y < rect.y + rect.height; ) {
      const rec = decodeRecord(r, world.important),
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
    getWorldTile: getWorldTileAccessor(world),
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
export function createWorldRenderer({
  assetDir,
  inputEncoding = "tconvert-game-raw",
  onOmission = () => {},
}) {
  const stats = {
    assetCacheBytes: 0,
    peakAssetCacheBytes: 0,
    maxChunkCells: 0,
    maxPlanCommands: 0,
    maxPreparedBytes: 0,
    renderedCommands: 0,
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
  const assetCache = new Map(),
    MAX_ASSET_CACHE = 80 * 1024 * 1024;
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
    },
  };
  async function assetsFor(plan) {
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
          const rawRgba = decodePngRgba(pngBytes);
          const image = registerTextureSource(await loadImage(pngBytes), {
            pngBytes,
            rawRgba,
          });
          entry = { image, bytes: textureMemoryBytes(image) };
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
    return assets;
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
  function commandBatches(plan) {
    const batches = [];
    let commands = [],
      keys = new Set(),
      reserved = 0;
    for (const c of plan.commands) {
      const key = sceneFrameKey(c),
        extra = keys.has(key) ? 0 : c.sw * c.sh * 8;
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
        reserved += c.sw * c.sh * 8;
      }
      commands.push(c);
    }
    if (commands.length) batches.push(commands);
    return batches;
  }
  async function drawRegion(
    region,
    canvas,
    { core = region.rect, count = false } = {},
  ) {
    const plan = planScene(region, options),
      assets = await assetsFor(plan),
      ctx = canvas.getContext("2d");
    canvas.width = plan.width;
    canvas.height = plan.height;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, plan.width, plan.height);
    const coreCommands = plan.commands.filter((c) => inCore(c, region, core));
    if (count) {
      stats.maxChunkCells = Math.max(stats.maxChunkCells, region.cells.length);
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
    for (const commands of commandBatches(plan)) {
      const part = { ...plan, commands };
      const frames = prepareSceneFrames(part, assets, createCanvas, {
        inputEncoding: inputEncoding,
        opaqueScene: true,
      });
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
        valid.push(c);
        if (tracked) stats.renderedCommands++;
      }
      renderScene(ctx, { ...part, commands: valid }, assets, {
        strict: true,
        sceneFrames: frameView,
      });
      stats.maxPreparedBytes = Math.max(
        stats.maxPreparedBytes,
        frames.support.bytes,
      );
      frames.dispose();
    }
    return { plan, coreCommands: coreCommands.length };
  }

  return {
    drawRegion,
    stats,
    dispose() {
      assetCache.clear();
      stats.assetCacheBytes = 0;
    },
  };
}
