import { prepareSceneFrames, sceneFrameKey } from "../core/scene-frames.mjs";
import { textureSource } from "../core/assets.mjs";
import { prepareRawOverviewFrame } from "./raw-overview-frame.mjs";

export const OVERVIEW_METADATA_LIMITS = Object.freeze({
  entries: 8192,
  bytes: 4 * 1024 * 1024,
});

// These failures depend only on the immutable source/command represented by
// the cache key. Transient decoder/allocation failures and preparation budgets
// must be retried; retaining them would change later omission accounting.
const deterministicFailures = new Set([
  "invalid-frame-bounds",
  "source-crop-outside-texture",
  "corner-input-encoding-mismatch",
  "invalid-corner-frame-bounds",
  "unsupported-corner-interpolation",
  "invalid-corner-vertex-domain",
  "invalid-corner-vertex-colors",
  "unknown-paint-id",
  "unknown-tile-type",
  "tree-paint-style",
]);

/**
 * Bounded reusable metadata, independent of the much larger native frame LRU.
 * Entries contain only a validation result and (when requested) four mean bytes;
 * they never retain a canvas, source atlas or decoded PNG. The full key includes
 * source registration, dimensions, canvas factory and input encoding, matching
 * prepared-frame invalidation. A view interns lookups once per unique frame.
 */
export function createOverviewFrameMetadataCache({
  maxEntries = OVERVIEW_METADATA_LIMITS.entries,
  maxBytes = OVERVIEW_METADATA_LIMITS.bytes,
} = {}) {
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > OVERVIEW_METADATA_LIMITS.entries ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > OVERVIEW_METADATA_LIMITS.bytes
  )
    throw new Error("Invalid overview frame metadata budget");
  const entries = new Map(),
    identities = new WeakMap();
  let nextIdentity = 1,
    disposed = false;
  const stats = {
    entries: 0,
    estimatedBytes: 0,
    peakEstimatedBytes: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
    bypasses: 0,
  };
  const identity = (object) => {
    if (!object) return 0;
    let id = identities.get(object);
    if (!id) {
      id = nextIdentity++;
      identities.set(object, id);
    }
    return id;
  };
  const assertActive = () => {
    if (disposed) throw new Error("Overview frame metadata cache is disposed");
  };
  const remove = (key, entry) => {
    entries.delete(key);
    stats.entries--;
    stats.estimatedBytes -= entry.bytes;
  };
  return {
    stats,
    view(assets, createCanvas, inputEncoding) {
      assertActive();
      const namespaces = new Map(),
        local = new Map(),
        factory = identity(createCanvas);
      const keyFor = (c, key) => {
        let prefix = namespaces.get(c.asset);
        if (prefix === undefined) {
          const source = assets.get(c.asset);
          if (!source) return null;
          prefix =
            [
              identity(source),
              identity(textureSource(source)),
              factory,
              source.naturalWidth ?? source.width,
              source.naturalHeight ?? source.height,
              inputEncoding,
            ].join(":") + ":";
          namespaces.set(c.asset, prefix);
        }
        return prefix + key;
      };
      return {
        get(c, key) {
          assertActive();
          if (local.has(key)) return local.get(key);
          const fullKey = keyFor(c, key),
            entry = fullKey === null ? null : entries.get(fullKey);
          if (entry) {
            stats.hits++;
            entries.delete(fullKey);
            entries.set(fullKey, entry);
          } else stats.misses++;
          const value = entry?.value;
          local.set(key, value);
          return value;
        },
        remember(c, key, frame, { mean = false, meanValue = undefined } = {}) {
          assertActive();
          const previous = local.get(key),
            value = {
              unsupported: frame?.unsupported ?? null,
              mean:
                meanValue !== undefined
                  ? meanValue
                  : mean
                    ? frameMean(frame)
                    : previous?.mean,
            };
          if (
            value.unsupported &&
            !deterministicFailures.has(value.unsupported)
          ) {
            // The ordinary compositor may retry the same frame in a later
            // preparation, even within this scene. Do not make a transient
            // failure sticky in either cache tier.
            local.delete(key);
            return value;
          }
          local.set(key, value);
          const fullKey = keyFor(c, key);
          if (fullKey === null) return value;
          // This is a conservative retained-payload estimate, not a claim about
          // a particular JS engine's object overhead. Count and byte caps both
          // apply, including arbitrarily long corner-color/domain keys.
          const bytes = fullKey.length * 2 + 192;
          const old = entries.get(fullKey);
          if (old) remove(fullKey, old);
          if (bytes > maxBytes) {
            stats.bypasses++;
            return value;
          }
          for (const [oldKey, entry] of entries) {
            if (
              entries.size < maxEntries &&
              stats.estimatedBytes + bytes <= maxBytes
            )
              break;
            remove(oldKey, entry);
            stats.evictions++;
          }
          entries.set(fullKey, { value, bytes });
          stats.entries++;
          stats.estimatedBytes += bytes;
          stats.peakEstimatedBytes = Math.max(
            stats.peakEstimatedBytes,
            stats.estimatedBytes,
          );
          return value;
        },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      entries.clear();
      stats.entries = 0;
      stats.estimatedBytes = 0;
    },
  };
}

// Metadata follows a prepared frame's lifetime, including cache eviction. It
// never retains a frame or its native canvas after the owning cache releases it.
const opaqueMeans = new WeakMap();
function frameMean(frame) {
  if (
    !frame?.base ||
    frame.additive ||
    frame.width !== 16 ||
    frame.height !== 16
  )
    return null;
  if (opaqueMeans.has(frame)) return opaqueMeans.get(frame);
  const pixels = frame.base.getContext("2d").getImageData(0, 0, 16, 16).data;
  let r = 0,
    g = 0,
    b = 0,
    opaque = true;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] !== 255) {
      opaque = false;
      break;
    }
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
  }
  const mean = opaque
    ? Uint8Array.of(
        Math.round(r / 256),
        Math.round(g / 256),
        Math.round(b / 256),
        255,
      )
    : null;
  opaqueMeans.set(frame, mean);
  return mean;
}

/**
 * Exact 1-pixel-per-tile shortcut, applied AFTER ordinary fallback composition.
 * A cell qualifies only when the LAST command touching it is an aligned,
 * unscaled, unclipped, unflipped 16x16 frame proven opaque after paint/tint.
 * Every later command participates in the last-touch map, including transparent
 * sprites, liquids, additive effects, slopes and oversized wall/tree frames.
 * Earlier draws may be omitted only if their ENTIRE destination covers safe
 * cells. Other commands retain their original order and normal compositor.
 */
export function prepareOpaqueOverview(
  plan,
  assets,
  createCanvas,
  {
    frameCache = null,
    inputEncoding = "tconvert-game-raw",
    keyCache = null,
    metadata = null,
  } = {},
) {
  const widthTiles = plan.width / 16,
    heightTiles = plan.height / 16;
  if (
    !Number.isSafeInteger(widthTiles) ||
    !Number.isSafeInteger(heightTiles) ||
    widthTiles < 1 ||
    heightTiles < 1 ||
    widthTiles * heightTiles > 65536
  )
    throw new Error("Invalid opaque overview scene dimensions");
  const safe = new Uint8Array(widthTiles * heightTiles),
    rgba = new Uint8Array(safe.length * 4),
    skip = new Set(),
    result = {
      widthTiles,
      heightTiles,
      safe,
      rgba,
      skip,
      eligibleTiles: 0,
      candidateTiles: 0,
      uniqueCandidateFrames: 0,
      skippedCommands: 0,
      totalCommands: plan.commands.length,
    };
  // Invalid geometry cannot establish absence of overlap. Conservatively leave
  // all work to the ordinary compositor rather than infer a usable rectangle.
  if (
    plan.commands.some(
      (c) =>
        !Number.isFinite(c.dx) ||
        !Number.isFinite(c.dy) ||
        !Number.isFinite(c.dw) ||
        !Number.isFinite(c.dh) ||
        c.dw <= 0 ||
        c.dh <= 0,
    )
  )
    return result;
  const last = new Int32Array(safe.length).fill(-1),
    bounds = new Int32Array(plan.commands.length * 4);
  for (let i = 0; i < plan.commands.length; i++) {
    const c = plan.commands[i],
      offset = i * 4;
    // Fractional and clipped draws are expanded conservatively by a pixel to
    // avoid making any assumption about rasterizer edge coverage.
    const pad =
      c.clip ||
      !Number.isInteger(c.dx) ||
      !Number.isInteger(c.dy) ||
      !Number.isInteger(c.dw) ||
      !Number.isInteger(c.dh)
        ? 1
        : 0;
    const x0 = Math.max(0, Math.floor((c.dx - pad) / 16)),
      y0 = Math.max(0, Math.floor((c.dy - pad) / 16)),
      x1 = Math.min(widthTiles, Math.ceil((c.dx + c.dw + pad) / 16)),
      y1 = Math.min(heightTiles, Math.ceil((c.dy + c.dh + pad) / 16));
    bounds[offset] = x0;
    bounds[offset + 1] = y0;
    bounds[offset + 2] = x1;
    bounds[offset + 3] = y1;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) last[y * widthTiles + x] = i;
  }
  const groups = new Map();
  for (let i = 0; i < last.length; i++) {
    if (last[i] < 0) continue;
    const c = plan.commands[last[i]];
    if (
      c.dx !== (i % widthTiles) * 16 ||
      c.dy !== Math.floor(i / widthTiles) * 16 ||
      c.dw !== 16 ||
      c.dh !== 16 ||
      c.sw !== 16 ||
      c.sh !== 16 ||
      c.clip ||
      c.flipX ||
      c.flipY ||
      (c.opacity !== undefined && c.opacity !== 1)
    )
      continue;
    result.candidateTiles++;
    const key = keyCache?.get(c) ?? sceneFrameKey(c);
    let group = groups.get(key);
    if (!group) {
      group = { command: c, key, indices: [] };
      groups.set(key, group);
    }
    group.indices.push(i);
  }
  const unique = [...groups.values()];
  result.uniqueCandidateFrames = unique.length;
  const applyMean = (group, mean) => {
    if (!mean) return;
    for (const i of group.indices) {
      safe[i] = 1;
      rgba.set(mean, i * 4);
      result.eligibleTiles++;
    }
  };
  const unprepared = [];
  for (const group of unique) {
    const cached = metadata?.get(group.command, group.key);
    if (cached && (cached.mean !== undefined || cached.unsupported))
      applyMean(group, cached.mean);
    else {
      const source =
        assets instanceof Map
          ? assets.get(group.command.asset)
          : assets?.[group.command.asset];
      const raw = prepareRawOverviewFrame(group.command, source, {
        inputEncoding,
      });
      if (raw && !raw.unsupported) {
        metadata?.remember(group.command, group.key, raw, {
          meanValue: raw.mean,
        });
        applyMean(group, raw.mean);
      } else unprepared.push(group);
    }
  }
  // Candidate frames are exactly 16x16: 450 unique frames stay below both the
  // ordinary frame-count limit and the 8-MiB preparation byte limit.
  for (let start = 0; start < unprepared.length; start += 450) {
    const batch = unprepared.slice(start, start + 450),
      frames = prepareSceneFrames(
        { ...plan, commands: batch.map((g) => g.command) },
        assets,
        createCanvas,
        { frameCache, inputEncoding, opaqueScene: true, keyCache },
      );
    try {
      for (const group of batch) {
        const frame = frames.resolve(group.command),
          mean = metadata
            ? metadata.remember(group.command, group.key, frame, { mean: true })
                .mean
            : frameMean(frame);
        applyMean(group, mean);
      }
    } finally {
      frames.dispose();
    }
  }
  for (let i = 0; i < plan.commands.length; i++) {
    const offset = i * 4;
    let covered = true;
    outer: for (let y = bounds[offset + 1]; y < bounds[offset + 3]; y++)
      for (let x = bounds[offset]; x < bounds[offset + 2]; x++)
        if (!safe[y * widthTiles + x]) {
          covered = false;
          break outer;
        }
    if (covered) skip.add(plan.commands[i]);
  }
  result.skippedCommands = skip.size;
  return result;
}

/** Overwrite only proven cells in an already reduced 1-pixel-per-tile core. */
export function applyOpaqueOverview(data, core, region, prepared) {
  const offsetX = core.x - region.rect.x,
    offsetY = core.y - region.rect.y;
  if (
    data.length !== core.width * core.height * 4 ||
    ![offsetX, offsetY, core.width, core.height].every(Number.isSafeInteger) ||
    offsetX < 0 ||
    offsetY < 0 ||
    core.width < 1 ||
    core.height < 1 ||
    offsetX + core.width > prepared.widthTiles ||
    offsetY + core.height > prepared.heightTiles
  )
    throw new Error("Invalid opaque overview reduced core");
  for (let y = 0; y < core.height; y++)
    for (let x = 0; x < core.width; x++) {
      const i = (offsetY + y) * prepared.widthTiles + offsetX + x;
      if (prepared.safe[i]) {
        const source = i * 4,
          destination = (y * core.width + x) * 4;
        data[destination] = prepared.rgba[source];
        data[destination + 1] = prepared.rgba[source + 1];
        data[destination + 2] = prepared.rgba[source + 2];
        data[destination + 3] = prepared.rgba[source + 3];
      }
    }
  return data;
}
