import { sceneFrameKey } from "../core/scene-frames.mjs";

export const SCENE_FRAME_INTERN_LIMITS = Object.freeze({
  maxEntries: 8192,
  maxBytes: 4 * 1024 * 1024,
});

/**
 * By default, intern the exact public frame key for common terrain/wall crops. A small
 * integer identifies their complete key fields; no array or string is built on
 * a hit. Other command families retain the original key formatter unchanged.
 *
 * Opt-in numericIds returns the collision-free slot itself for common frames,
 * with fallback strings kept in a disjoint key domain. Its hit counters describe
 * asset-namespace reuse, not cached strings. Source identity stays downstream.
 *
 * Both asset namespaces and frame strings count toward the limits. A full
 * dictionary is cleared as a unit, avoiding LRU mutation on every tile. Keys
 * depend on command values only, so prepared-texture invalidation remains the
 * responsibility of the existing source-aware frame caches.
 */
export function createSceneFrameInterner({
  maxEntries = SCENE_FRAME_INTERN_LIMITS.maxEntries,
  maxBytes = SCENE_FRAME_INTERN_LIMITS.maxBytes,
  numericIds = false,
} = {}) {
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > SCENE_FRAME_INTERN_LIMITS.maxEntries ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > SCENE_FRAME_INTERN_LIMITS.maxBytes
  )
    throw new RangeError("Invalid scene frame interner budget");
  const assets = new Map(),
    frames = new Map();
  let disposed = false;
  const stats = {
    numericIds: numericIds === true,
    lookupDomain:
      numericIds === true ? "canonical-asset-namespace" : "exact-frame-key",
    calls: 0,
    hits: 0,
    misses: 0,
    fallbacks: 0,
    clears: 0,
    bypasses: 0,
    entries: 0,
    assetEntries: 0,
    estimatedBytes: 0,
    peakEntries: 0,
    peakEstimatedBytes: 0,
  };
  const clear = () => {
    assets.clear();
    frames.clear();
    stats.entries = 0;
    stats.assetEntries = 0;
    stats.estimatedBytes = 0;
  };
  const fallback = (command) => {
    stats.fallbacks++;
    return sceneFrameKey(command);
  };
  const remember = (asset, namespace, slot, key) => {
    // Include a conservative per-entry allowance with retained UTF-16 payloads.
    // This bounds the dictionary, not the JS engine's process-wide heap/RSS.
    const keyBytes = key.length * 2 + 64,
      assetBytes = asset.length * 2 + 64;
    let extraEntries = assets.has(asset) ? 1 : 2,
      extraBytes = keyBytes + (extraEntries === 2 ? assetBytes : 0);
    if (
      stats.entries + stats.assetEntries + extraEntries > maxEntries ||
      stats.estimatedBytes + extraBytes > maxBytes
    ) {
      clear();
      stats.clears++;
      extraEntries = 2;
      extraBytes = keyBytes + assetBytes;
    }
    if (extraEntries > maxEntries || extraBytes > maxBytes) {
      stats.bypasses++;
      return;
    }
    if (!assets.has(asset)) {
      assets.set(asset, namespace);
      stats.assetEntries++;
    }
    frames.set(slot, key);
    stats.entries++;
    stats.estimatedBytes += extraBytes;
    stats.peakEntries = Math.max(
      stats.peakEntries,
      stats.entries + stats.assetEntries,
    );
    stats.peakEstimatedBytes = Math.max(
      stats.peakEstimatedBytes,
      stats.estimatedBytes,
    );
  };
  return {
    stats,
    key(c) {
      if (disposed) throw new Error("Scene frame interner is disposed");
      stats.calls++;
      if (
        !c ||
        c.vertexColor ||
        c.vertexColors ||
        (c.kind !== "tile" && c.kind !== "wall") ||
        typeof c.asset !== "string" ||
        !Number.isInteger(c.type) ||
        c.type < 0 ||
        c.type > 1023
      )
        return fallback(c);
      const wall = c.kind === "wall",
        step = wall ? 36 : 18;
      if (
        c.sw !== (wall ? 32 : 16) ||
        (wall ? c.sh !== 32 : c.sh !== 16 && c.sh !== 8) ||
        typeof c.sx !== "number" ||
        typeof c.sy !== "number"
      )
        return fallback(c);
      const frameX = c.sx / step,
        frameY = c.sy / step,
        paint = c.paintId || 0;
      if (
        !Number.isInteger(frameX) ||
        !Number.isInteger(frameY) ||
        frameX < 0 ||
        frameX > 15 ||
        frameY < 0 ||
        frameY > 15 ||
        !Number.isInteger(paint) ||
        paint < 0 ||
        paint > 31
      )
        return fallback(c);
      let namespace = assets.get(c.asset);
      if (!namespace) {
        // Parse each retained canonical asset name once. In particular, reject
        // alternate spellings such as Tiles_01.png before using a numeric slot.
        const match = /^(Tiles|Wall)_(0|[1-9][0-9]{0,3})\.png$/.exec(c.asset);
        if (
          !match ||
          (match[1] === "Wall") !== wall ||
          Number(match[2]) !== c.type
        )
          return fallback(c);
        namespace = {
          type: c.type,
          wall,
          base: c.type * 32768 + Number(wall),
        };
      } else if (namespace.type !== c.type || namespace.wall !== wall)
        return fallback(c);
      // type:10, frameY:4, frameX:4, paint:5, short-height:1, wall:1.
      // Every accepted field has its own bits; the result stays below 2^25.
      const slot =
        namespace.base +
        frameY * 2048 +
        frameX * 128 +
        paint * 4 +
        (c.sh === 8 ? 2 : 0);
      // Canonical ordinary fields have a collision-free, stable 25-bit ID.
      // Keep it numeric through validation/preparation/composition; unlike the
      // public string-key mode, no per-frame dictionary or formatting is needed.
      // Other families retain a string key, a disjoint Map key domain.
      if (numericIds === true) {
        if (assets.has(c.asset)) stats.hits++;
        else {
          stats.misses++;
          const bytes = c.asset.length * 2 + 64;
          if (
            stats.assetEntries + 1 > maxEntries ||
            stats.estimatedBytes + bytes > maxBytes
          ) {
            clear();
            stats.clears++;
          }
          if (bytes <= maxBytes) {
            assets.set(c.asset, namespace);
            stats.assetEntries++;
            stats.estimatedBytes += bytes;
            stats.peakEntries = Math.max(stats.peakEntries, stats.assetEntries);
            stats.peakEstimatedBytes = Math.max(
              stats.peakEstimatedBytes,
              stats.estimatedBytes,
            );
          } else stats.bypasses++;
        }
        return slot + 1;
      }
      const cached = frames.get(slot);
      if (cached !== undefined) {
        stats.hits++;
        return cached;
      }
      stats.misses++;
      const key = sceneFrameKey(c);
      remember(c.asset, namespace, slot, key);
      return key;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
    },
  };
}
