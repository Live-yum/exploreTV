import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { ASSET_LIMITS, registerTextureSource } from "../core/assets.mjs";
import { createNodePngRgbaDecoder } from "./png-rgba-node.mjs";

export const RAW_TEXTURE_CACHE_LIMITS = Object.freeze({
  encodedBytes: 8 * 1024 * 1024,
  rawBytes: 8 * 1024 * 1024,
  entries: 512,
  activeEncodedBytes: 32 * 1024 * 1024,
  activeSnapshots: 512,
});

class RawTextureBudgetError extends Error {
  constructor(message) {
    super(message);
    this.code = "ERR_RAW_TEXTURE_BUDGET";
  }
}

function checkedFileSize(size) {
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > ASSET_LIMITS.encodedBytes
  )
    throw new Error("PNG encoded size outside budget");
  return size;
}

// readFileSync may allocate a growing file beyond the prior stat budget. Hold
// one descriptor, allocate only the checked length, and probe EOF explicitly.
function readBoundedSnapshot(path, size) {
  const fd = openSync(path, "r");
  try {
    if (checkedFileSize(fstatSync(fd).size) !== size)
      throw new RawTextureBudgetError(
        "PNG size changed after budget preflight",
      );
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const length = readSync(fd, bytes, offset, size - offset, null);
      if (!length)
        throw new RawTextureBudgetError("PNG ended before its preflight size");
      offset += length;
    }
    if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, null))
      throw new RawTextureBudgetError("PNG grew beyond its preflight size");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/**
 * Node-only immutable PNG snapshots with an independently bounded raw RGBA LRU.
 * An active plan keeps descriptors and compressed bytes, never decoded atlases.
 * Prepared-frame identity survives raw eviction because neither the descriptor
 * nor its texture registration changes. Reacquiring an evicted PNG snapshot
 * creates a new identity; older live plans still see their original bytes.
 *
 * Retained PNG and raw limits are hard bounds. A caller must dispose each assets
 * view when its plan ends. Active compressed snapshots may exceed the retained
 * PNG retention limit and are reported separately, including their union with
 * retention. Active snapshots also have a hard aggregate byte/count bound;
 * exceeding it aborts the whole assets view and releases partial borrows.
 * Oversized raw atlases bypass retention and live only in the current caller.
 * Decoder working buffers are transient, not included in retained-byte stats.
 */
export function createRawTextureCache({
  assetDir,
  maxEncodedBytes = RAW_TEXTURE_CACHE_LIMITS.encodedBytes,
  maxRawBytes = RAW_TEXTURE_CACHE_LIMITS.rawBytes,
  maxEntries = RAW_TEXTURE_CACHE_LIMITS.entries,
  maxActiveEncodedBytes = RAW_TEXTURE_CACHE_LIMITS.activeEncodedBytes,
  maxActiveSnapshots = RAW_TEXTURE_CACHE_LIMITS.activeSnapshots,
  assetHashes = {},
  assetFailures = {},
  framePack = null,
} = {}) {
  if (typeof assetDir !== "string")
    throw new Error("Invalid raw asset directory");
  if (
    !Number.isSafeInteger(maxEncodedBytes) ||
    maxEncodedBytes < 0 ||
    maxEncodedBytes > ASSET_LIMITS.encodedBytes ||
    !Number.isSafeInteger(maxRawBytes) ||
    maxRawBytes < 0 ||
    maxRawBytes > ASSET_LIMITS.decodedBytes ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > RAW_TEXTURE_CACHE_LIMITS.entries ||
    !Number.isSafeInteger(maxActiveEncodedBytes) ||
    maxActiveEncodedBytes < 0 ||
    maxActiveEncodedBytes > RAW_TEXTURE_CACHE_LIMITS.activeEncodedBytes ||
    !Number.isSafeInteger(maxActiveSnapshots) ||
    maxActiveSnapshots < 1 ||
    maxActiveSnapshots > RAW_TEXTURE_CACHE_LIMITS.activeSnapshots
  )
    throw new Error("Invalid raw texture cache budget");
  const decoder = createNodePngRgbaDecoder(),
    snapshots = new Map(),
    rawEntries = new Map(),
    active = new Map();
  let nextIdentity = 1,
    disposed = false;
  const stats = {
    retainedEncodedBytes: 0,
    peakRetainedEncodedBytes: 0,
    encodedEntries: 0,
    encodedHits: 0,
    encodedMisses: 0,
    encodedEvictions: 0,
    encodedBypasses: 0,
    activeEncodedBytes: 0,
    peakActiveEncodedBytes: 0,
    activeSnapshots: 0,
    peakActiveSnapshots: 0,
    activeEncodedByteLimit: maxActiveEncodedBytes,
    activeSnapshotLimit: maxActiveSnapshots,
    liveEncodedBytes: 0,
    peakLiveEncodedBytes: 0,
    rawBytes: 0,
    peakRawBytes: 0,
    rawEntries: 0,
    rawHits: 0,
    rawDecodes: 0,
    compiledSourceSnapshots: 0,
    rawEvictions: 0,
    rawBypasses: 0,
    retainedBytes: 0,
    peakRetainedBytes: 0,
    liveBytes: 0,
    peakLiveBytes: 0,
    pngDecodeCache: decoder.stats,
  };
  const update = () => {
    stats.encodedEntries = snapshots.size;
    stats.rawEntries = rawEntries.size;
    stats.activeSnapshots = active.size;
    stats.liveEncodedBytes = stats.retainedEncodedBytes;
    for (const entry of active.keys())
      if (!entry.retained) stats.liveEncodedBytes += entry.bytes;
    stats.retainedBytes = stats.retainedEncodedBytes + stats.rawBytes;
    stats.liveBytes = stats.liveEncodedBytes + stats.rawBytes;
    for (const [current, peak] of [
      ["retainedEncodedBytes", "peakRetainedEncodedBytes"],
      ["activeEncodedBytes", "peakActiveEncodedBytes"],
      ["activeSnapshots", "peakActiveSnapshots"],
      ["liveEncodedBytes", "peakLiveEncodedBytes"],
      ["rawBytes", "peakRawBytes"],
      ["retainedBytes", "peakRetainedBytes"],
      ["liveBytes", "peakLiveBytes"],
    ])
      stats[peak] = Math.max(stats[peak], stats[current]);
  };
  const assertActive = () => {
    if (disposed) throw new Error("Raw texture cache is disposed");
  };
  const assertBorrowBudget = (bytes, entry = null) => {
    if (entry && active.has(entry)) return;
    if (active.size >= maxActiveSnapshots)
      throw new RawTextureBudgetError(
        "Active PNG snapshot count exceeds budget",
      );
    if (bytes > maxActiveEncodedBytes - stats.activeEncodedBytes)
      throw new RawTextureBudgetError(
        "Active PNG snapshot bytes exceed budget",
      );
  };
  const evictRaw = (id, count = true) => {
    const raw = rawEntries.get(id);
    if (!raw) return;
    rawEntries.delete(id);
    stats.rawBytes -= raw.data.buffer.byteLength;
    if (count) stats.rawEvictions++;
  };
  const retainRaw = (id, raw) => {
    // In-place unfiltering retains its original scanline buffer, including
    // filter bytes and a possible single-byte zlib EOF sentinel.
    const bytes = raw.data.buffer.byteLength;
    if (bytes > maxRawBytes) {
      stats.rawBypasses++;
      update();
      return raw;
    }
    // Evict BEFORE insertion, so the actual retained high-water mark observes
    // the same byte bound, not merely an after-the-fact accounting limit.
    for (const key of rawEntries.keys()) {
      if (stats.rawBytes + bytes <= maxRawBytes && rawEntries.size < maxEntries)
        break;
      evictRaw(key);
    }
    rawEntries.set(id, raw);
    stats.rawBytes += bytes;
    update();
    return raw;
  };
  const decode = (bytes) => {
    const raw = decoder.decode(bytes);
    stats.rawDecodes++;
    return raw;
  };
  const readRaw = (entry) => {
    assertActive();
    const raw = rawEntries.get(entry.id);
    if (raw) {
      stats.rawHits++;
      rawEntries.delete(entry.id);
      rawEntries.set(entry.id, raw);
      return raw;
    }
    try {
      return retainRaw(entry.id, decode(entry.pngBytes));
    } catch (error) {
      assetFailures[entry.name] = error.message;
      throw error;
    }
  };
  const evictSnapshot = (name, entry) => {
    snapshots.delete(name);
    entry.retained = false;
    stats.retainedEncodedBytes -= entry.bytes;
    stats.encodedEvictions++;
    // Numeric keys keep the raw cache from retaining a compressed snapshot.
    // Its pixels can also be discarded when no active plan uses the snapshot.
    if (!active.has(entry)) evictRaw(entry.id);
  };
  const retainSnapshot = (entry) => {
    if (entry.bytes > maxEncodedBytes) {
      stats.encodedBypasses++;
      update();
      return;
    }
    for (const [name, old] of snapshots) {
      if (
        stats.retainedEncodedBytes + entry.bytes <= maxEncodedBytes &&
        snapshots.size < maxEntries
      )
        break;
      evictSnapshot(name, old);
    }
    snapshots.set(entry.name, entry);
    entry.retained = true;
    stats.retainedEncodedBytes += entry.bytes;
    update();
  };
  const load = (name) => {
    const cached = snapshots.get(name);
    if (cached) {
      assertBorrowBudget(cached.bytes, cached);
      stats.encodedHits++;
      snapshots.delete(name);
      snapshots.set(name, cached);
      return cached;
    }
    stats.encodedMisses++;
    const path = join(assetDir, name);
    if (!existsSync(path)) return null;
    try {
      const size = checkedFileSize(statSync(path).size);
      assertBorrowBudget(size);
      const pngBytes = readBoundedSnapshot(path, size),
        hash = createHash("sha256").update(pngBytes).digest("hex"),
        // A compiled source was strictly decoded by the bound baker. Only its
        // exact encoded snapshot can reuse that validation and dimensions.
        // Uncovered or changed bytes still take the original strict decoder.
        compiled = framePack?.sourceInfo(name, hash, pngBytes.byteLength),
        raw = compiled ? null : decode(pngBytes),
        dimensions = compiled ?? raw,
        entry = {
          id: nextIdentity++,
          name,
          pngBytes,
          bytes: pngBytes.byteLength,
          retained: false,
          image: null,
        };
      entry.image = registerTextureSource(
        Object.freeze({ width: dimensions.width, height: dimensions.height }),
        { pngBytes, rawRgbaProvider: () => readRaw(entry) },
      );
      if (compiled) {
        framePack.bindVerifiedSource(
          entry.image,
          name,
          hash,
          pngBytes.byteLength,
        );
        stats.compiledSourceSnapshots++;
      }
      assetHashes[name] = hash;
      delete assetFailures[name];
      if (raw) retainRaw(entry.id, raw);
      retainSnapshot(entry);
      return entry;
    } catch (error) {
      if (error instanceof RawTextureBudgetError) throw error;
      assetFailures[name] = error.message;
      return null;
    }
  };
  return {
    stats,
    assetHashes,
    assetFailures,
    assetsFor(requiredAssets) {
      assertActive();
      const assets = new Map(),
        borrowed = new Set();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        for (const entry of borrowed) {
          const count = active.get(entry);
          if (count > 1) active.set(entry, count - 1);
          else if (count === 1) {
            active.delete(entry);
            stats.activeEncodedBytes -= entry.bytes;
            if (!entry.retained) evictRaw(entry.id, false);
          }
        }
        borrowed.clear();
        assets.clear();
        update();
      };
      try {
        for (const name of requiredAssets) {
          if (assets.has(name)) continue;
          const entry = load(name);
          if (!entry) continue;
          assets.set(name, entry.image);
          borrowed.add(entry);
          const count = active.get(entry) || 0;
          active.set(entry, count + 1);
          if (!count) stats.activeEncodedBytes += entry.bytes;
          update();
        }
      } catch (error) {
        release();
        throw error;
      }
      return { assets, dispose: release };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of snapshots.values()) entry.retained = false;
      snapshots.clear();
      rawEntries.clear();
      stats.retainedEncodedBytes = 0;
      stats.rawBytes = 0;
      decoder.clear();
      // Live views still own their compressed snapshots until they dispose.
      update();
    },
  };
}
