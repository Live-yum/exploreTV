import {
  isIntegerOverviewDraw,
  writeOverviewBounds,
} from "./overview-geometry.mjs";
export { isIntegerOverviewDraw } from "./overview-geometry.mjs";
import { textureSource } from "../core/assets.mjs";
import { createCanvas as defaultCreateCanvas } from "@napi-rs/canvas";
import { prepareRawOverviewFrame } from "./raw-overview-frame.mjs";
import {
  canonicalSlopeClip,
  prepareClippedOverviewFrame,
} from "./slope-overview-frame.mjs";
import {
  nativeBlitterStatus,
  clearOpaque,
  composeInto,
  prepareFramePixels,
  quantizeCanvasOpacity as quantizeNativeOpacity,
} from "./native-blitter.mjs";

// An integer, unscaled draw covers exactly its destination pixels. Complex
// draws are isolated by output cell, preserving the complete Canvas composition
// for every cell they might touch, including conservative antialiasing edges.
export const SOFTWARE_OVERVIEW_INTEGER = 1;
export const SOFTWARE_OVERVIEW_UNSAFE = 2;
export const SOFTWARE_OVERVIEW_SAFE = 4;
export const SOFTWARE_OVERVIEW_NATIVE =
  SOFTWARE_OVERVIEW_INTEGER | SOFTWARE_OVERVIEW_SAFE;

export function partitionSoftwareOverview(plan, core, region, analysis = null) {
  const width = core.width,
    height = core.height,
    left = (core.x - region.rect.x) * 16,
    top = (core.y - region.rect.y) * 16,
    geometry =
      analysis?.commands === plan.commands &&
      analysis.width === width &&
      analysis.height === height &&
      analysis.left === left &&
      analysis.top === top
        ? analysis
        : null,
    unsafe = geometry?.unsafe ?? new Uint8Array(width * height),
    rectangle = new Int32Array(4);
  let unsafeCells = geometry?.unsafeCells ?? 0;
  const bounds = (c) =>
    writeOverviewBounds(c, width, height, left, top, rectangle);
  if (!geometry)
    for (const command of plan.commands) {
      if (isIntegerOverviewDraw(command)) continue;
      if (!bounds(command)) {
        unsafe.fill(1);
        unsafeCells = unsafe.length;
        break;
      }
      const x0 = rectangle[0],
        y0 = rectangle[1],
        x1 = rectangle[2],
        y1 = rectangle[3];
      for (let y = y0; y < y1; y++) {
        const end = y * width + x1;
        for (let i = y * width + x0; i < end; i++)
          if (!unsafe[i]) {
            unsafe[i] = 1;
            unsafeCells++;
          }
      }
    }
  // A summed-area table makes overlap queries constant-time, including large
  // sprites. It is bounded by the same core as the unsafe bitmap; uniform cores
  // need no table. Only commands actually queried acquire a cached class.
  const stride = width + 1,
    prefix =
      unsafeCells && unsafeCells < unsafe.length
        ? new Uint32Array(stride * (height + 1))
        : null;
  if (prefix) {
    for (let y = 0; y < height; y++) {
      let rowSum = 0,
        source = y * width,
        destination = (y + 1) * stride + 1;
      for (let x = 0; x < width; x++, source++, destination++) {
        rowSum += unsafe[source];
        prefix[destination] = prefix[destination - stride] + rowSum;
      }
    }
  }
  // The opt-in indexed path stores one byte per command. Diagnostic commands
  // outside this plan use the original geometry calculation without retention.
  const classes = geometry
      ? new Uint8Array(plan.commands.length).fill(255)
      : null,
    fallbackClasses = geometry ? null : new Map(),
    classLimit = plan.commands.length;
  const classifyBounds = (flags, values, offset) => {
    const x0 = values[offset],
      y0 = values[offset + 1],
      x1 = values[offset + 2],
      y1 = values[offset + 3];
    if (x0 < x1 && y0 < y1) {
      const cells = (x1 - x0) * (y1 - y0),
        count = prefix
          ? prefix[y1 * stride + x1] -
            prefix[y0 * stride + x1] -
            prefix[y1 * stride + x0] +
            prefix[y0 * stride + x0]
          : unsafeCells
            ? cells
            : 0;
      if (count) flags |= SOFTWARE_OVERVIEW_UNSAFE;
      if (count < cells) flags |= SOFTWARE_OVERVIEW_SAFE;
    }
    return flags;
  };
  const classifyAt = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= classLimit)
      throw new RangeError("Invalid overview command index");
    if (!geometry) return classify(plan.commands[index]);
    if (classes[index] !== 255) return classes[index];
    geometry.coreBoundsAt(index, rectangle);
    return (classes[index] = classifyBounds(
      geometry.integer[index],
      rectangle,
      0,
    ));
  };
  const classify = (c) => {
    if (geometry) {
      const index = geometry.indexOf(c);
      if (index >= 0) return classifyAt(index);
    } else {
      const cached = fallbackClasses.get(c);
      if (cached !== undefined) return cached;
    }
    const flags = isIntegerOverviewDraw(c) ? SOFTWARE_OVERVIEW_INTEGER : 0;
    bounds(c);
    const result = classifyBounds(flags, rectangle, 0);
    if (fallbackClasses && fallbackClasses.size < classLimit)
      fallbackClasses.set(c, result);
    return result;
  };
  return {
    unsafe,
    unsafeCells,
    width,
    height,
    left,
    top,
    classify,
    classifyAt,
    touchesUnsafe(c) {
      return !!(classify(c) & SOFTWARE_OVERVIEW_UNSAFE);
    },
    shouldDrawNative(c) {
      return (
        (classify(c) & SOFTWARE_OVERVIEW_NATIVE) === SOFTWARE_OVERVIEW_NATIVE
      );
    },
  };
}

/**
 * Bounded premultiplied frame pixels + one reusable detailed core. This is an
 * optional Node export backend; no world-sized raster or worker is created.
 * Native frame readback is cached independently of Canvas frame lifetimes.
 */
const MAX_FRAME_PIXEL_BYTES = 64 * 64 * 4 * 2;
const MAX_BATCH_BLITS = 8192;
const NO_CURRENT_VIEW = () => {};

export function createSoftwareOverview({
  maxFrameBytes = 8 * 1024 * 1024,
  maxFrames = 4096,
  maxLiveFrameBytes = Math.max(maxFrameBytes, MAX_FRAME_PIXEL_BYTES),
  createCanvas = defaultCreateCanvas,
} = {}) {
  if (
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < 1 ||
    maxFrameBytes > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(maxFrames) ||
    maxFrames < 1 ||
    maxFrames > 8192 ||
    !Number.isSafeInteger(maxLiveFrameBytes) ||
    maxLiveFrameBytes < MAX_FRAME_PIXEL_BYTES ||
    maxLiveFrameBytes > 32 * 1024 * 1024 ||
    maxLiveFrameBytes < maxFrameBytes
  )
    throw new Error("Invalid software overview cache budget");
  const entries = new Map(),
    identities = new WeakMap();
  let nextIdentity = 1,
    backing = null,
    disposed = false;
  let releaseCurrentView = NO_CURRENT_VIEW;
  const stats = {
    available: nativeBlitterStatus.available,
    backend: nativeBlitterStatus.available
      ? "node-api-integer-compositor"
      : "canvas",
    reason: nativeBlitterStatus.reason,
    sourceSha256: nativeBlitterStatus.sourceSha256,
    binarySha256: nativeBlitterStatus.binarySha256,
    build: nativeBlitterStatus.build,
    kernel: nativeBlitterStatus.kernel,
    frameBytes: 0,
    peakFrameBytes: 0,
    frameEntries: 0,
    activeFrameBytes: 0,
    peakActiveFrameBytes: 0,
    liveFrameBytes: 0,
    peakLiveFrameBytes: 0,
    liveFrameByteLimit: maxLiveFrameBytes,
    nativeBatches: 0,
    nativeComposeMilliseconds: 0,
    clearMilliseconds: 0,
    maxBatchSources: 0,
    maxBatchBlits: 0,
    rawPreparedFrames: 0,
    rawPreparationFallbacks: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
    bufferBytes: 0,
    peakBufferBytes: 0,
    nativeCommands: 0,
    canvasCommands: 0,
    unsafeCells: 0,
    totalCells: 0,
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
  // Retained and active owners can refer to the same pixels. Count the union
  // once in liveFrameBytes, and separately expose bytes pinned by a preparation
  // view or an unsubmitted native batch. No opacity variant can bypass this cap.
  const releaseIfUnowned = (entry) => {
    if (!entry.retained && !entry.references && entry.live) {
      entry.live = false;
      stats.liveFrameBytes -= entry.bytes;
    }
  };
  const pin = (entry) => {
    if (entry.references++ === 0) {
      stats.activeFrameBytes += entry.bytes;
      stats.peakActiveFrameBytes = Math.max(
        stats.peakActiveFrameBytes,
        stats.activeFrameBytes,
      );
    }
  };
  const unpin = (entry) => {
    if (--entry.references === 0) {
      stats.activeFrameBytes -= entry.bytes;
      releaseIfUnowned(entry);
    }
  };
  const retire = (key, entry) => {
    entries.delete(key);
    entry.retained = false;
    stats.frameBytes -= entry.bytes;
    stats.frameEntries = entries.size;
    stats.evictions++;
    releaseIfUnowned(entry);
  };
  const makeRoom = (bytes) => {
    for (const [key, entry] of entries) {
      if (stats.liveFrameBytes + bytes <= maxLiveFrameBytes) break;
      if (!entry.references) retire(key, entry);
    }
    return stats.liveFrameBytes + bytes <= maxLiveFrameBytes;
  };
  const storePixels = (key, pixels) => {
    const bytes =
      pixels.base.buffer.byteLength + (pixels.additive?.buffer.byteLength ?? 0);
    if (
      bytes !== pixels.width * pixels.height * 4 * (pixels.additive ? 2 : 1) ||
      stats.liveFrameBytes + bytes > maxLiveFrameBytes
    )
      throw new Error(
        "Native overview frame backing allocation exceeds its reservation",
      );
    const entry = {
      ...pixels,
      bytes,
      retained: false,
      references: 0,
      live: true,
    };
    stats.liveFrameBytes += entry.bytes;
    stats.peakLiveFrameBytes = Math.max(
      stats.peakLiveFrameBytes,
      stats.liveFrameBytes,
    );
    if (entry.bytes <= maxFrameBytes) {
      for (const [oldKey, old] of entries) {
        if (
          stats.frameBytes + entry.bytes <= maxFrameBytes &&
          entries.size < maxFrames
        )
          break;
        retire(oldKey, old);
      }
      entry.retained = true;
      entries.set(key, entry);
      stats.frameBytes += entry.bytes;
      stats.peakFrameBytes = Math.max(stats.peakFrameBytes, stats.frameBytes);
      stats.frameEntries = entries.size;
    }
    return entry;
  };
  const framePixels = (
    key,
    resolveFrame,
    opacity,
    flush,
    command,
    assertOpen,
  ) => {
    assertOpen();
    let entry = entries.get(key);
    if (entry) {
      stats.hits++;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    }
    stats.misses++;
    const frame = resolveFrame();
    assertOpen();
    if (
      !frame?.base ||
      !Number.isSafeInteger(frame.width) ||
      !Number.isSafeInteger(frame.height) ||
      frame.width < 1 ||
      frame.width > 64 ||
      frame.height < 1 ||
      frame.height > 64 ||
      frame.base.width !== frame.width ||
      frame.base.height !== frame.height ||
      (frame.additive &&
        (frame.additive.width !== frame.width ||
          frame.additive.height !== frame.height))
    )
      throw new Error("Native overview requires a validated prepared frame");
    const reserved = frame.width * frame.height * 4 * (frame.additive ? 2 : 1);
    if (!makeRoom(reserved)) {
      flush();
      if (!makeRoom(reserved))
        throw new Error("Native overview active frame budget exhausted");
    }
    if (command.clip) {
      const clipped = prepareClippedOverviewFrame(frame, command, createCanvas);
      if (!clipped) throw new Error("Unsupported native overview clip");
      assertOpen();
      return storePixels(key, clipped);
    }
    const base = prepareFramePixels(frame.base, opacity);
    const additive = frame.additive
      ? prepareFramePixels(frame.additive, opacity)
      : null;
    assertOpen();
    return storePixels(key, {
      base,
      additive,
      width: frame.width,
      height: frame.height,
      uvFlipApplied: !!frame.uvFlipApplied,
    });
  };
  return {
    stats,
    begin(plan, core, region, assets, keyCache, analysis = null) {
      if (disposed) throw new Error("Software overview is disposed");
      releaseCurrentView();
      if (!nativeBlitterStatus.available) return null;
      const partition = partitionSoftwareOverview(plan, core, region, analysis);
      stats.unsafeCells += partition.unsafeCells;
      stats.totalCells += partition.unsafe.length;
      if (partition.unsafeCells === partition.unsafe.length) return null;
      const width = core.width * 16,
        height = core.height * 16;
      const bytes = width * height * 4;
      if (!backing || backing.length < bytes)
        backing = Buffer.allocUnsafe(bytes);
      stats.bufferBytes = backing.length;
      stats.peakBufferBytes = Math.max(stats.peakBufferBytes, backing.length);
      const pixels = backing.subarray(0, bytes);
      const clearStarted = performance.now();
      clearOpaque(pixels);
      stats.clearMilliseconds += performance.now() - clearStarted;
      const namespaces = new Map(),
        local = new Map(),
        borrowed = new Set(),
        needsPreparation = new Set();
      let borrowedBytes = 0,
        finished = false;
      // Leave room for at least one maximum-size new frame even when every
      // borrowed cache entry is needed again later in this preparation batch.
      const borrowLimit = Math.min(
        Math.floor(maxLiveFrameBytes / 2),
        maxLiveFrameBytes - MAX_FRAME_PIXEL_BYTES,
      );
      const releaseBorrowed = () => {
        for (const entry of borrowed) unpin(entry);
        borrowed.clear();
        local.clear();
        needsPreparation.clear();
        borrowedBytes = 0;
      };
      const assertOpen = () => {
        if (finished) throw new Error("Software overview view is finished");
      };
      const finish = () => {
        finished = true;
        // A callback created in begin can retain its shared closure context,
        // including the old command/key maps, partition and assets. Detach it
        // before the caller's between-chunk GC, using a module-scope no-op.
        // Finishing an older view must never detach a newer active view.
        if (releaseCurrentView === finish) releaseCurrentView = NO_CURRENT_VIEW;
        releaseBorrowed();
      };
      releaseCurrentView = finish;
      // Frame preparation is opacity-independent. Our cached premultiplied
      // pixels include the draw's global alpha, so BOTH cache levels qualify it.
      const pixelKey = (c) => {
        const key = keyCache.get(c);
        const opacity = c.opacity === undefined ? 1 : c.opacity;
        if (c.clip)
          return (
            key +
            ":slope:" +
            canonicalSlopeClip(c) +
            ":flip:" +
            Number(!!c.flipX) +
            Number(!!c.flipY) +
            ":alpha:" +
            quantizeNativeOpacity(opacity)
          );
        return opacity === 1
          ? key
          : key + ":alpha:" + quantizeNativeOpacity(opacity);
      };
      const fullKeyFor = (c) => {
        const key = pixelKey(c);
        let namespace = namespaces.get(c.asset);
        if (!namespace) {
          const source = assets.get(c.asset);
          namespace =
            [
              identity(source),
              identity(textureSource(source)),
              source.naturalWidth ?? source.width,
              source.naturalHeight ?? source.height,
            ].join(":") + ":";
          namespaces.set(c.asset, namespace);
        }
        return namespace + key;
      };
      const result = {
        pixels,
        unsafe: partition.unsafe,
        canvasCommands: 0,
        nativeCommands: 0,
        // Drawing is over, but pixels/unsafe remain readable for reduction.
        finish,
        preparationCommands(commands) {
          assertOpen();
          releaseBorrowed();
          try {
            const prepared = commands.filter((c) => {
              const classification = partition.classify(c);
              if (
                (classification & SOFTWARE_OVERVIEW_INTEGER) === 0 ||
                (classification & SOFTWARE_OVERVIEW_UNSAFE) !== 0
              )
                return true;
              const frameKey = keyCache.get(c);
              if (needsPreparation.has(frameKey)) return true;
              const key = pixelKey(c);
              if (local.has(key)) return false;
              const fullKey = fullKeyFor(c);
              assertOpen();
              let entry = entries.get(fullKey),
                createdRaw = false;
              const reserved = c.sw * c.sh * 8;
              if (
                !entry &&
                !c.clip &&
                borrowedBytes + reserved <= borrowLimit &&
                makeRoom(reserved)
              ) {
                let raw = null;
                try {
                  raw = prepareRawOverviewFrame(c, assets.get(c.asset));
                } catch {
                  /* Preserve the ordinary preparer's failure/omission path. */
                }
                assertOpen();
                if (raw && !raw.unsupported) {
                  entry = storePixels(fullKey, raw);
                  stats.misses++;
                  stats.rawPreparedFrames++;
                  createdRaw = true;
                } else stats.rawPreparationFallbacks++;
              }
              if (!entry || borrowedBytes + entry.bytes > borrowLimit) {
                // One missing variant requires the opacity-independent prepared
                // frame. Further variants of that key need no lookup or pinning.
                needsPreparation.add(frameKey);
                return true;
              }
              if (entry.retained) {
                entries.delete(fullKey);
                entries.set(fullKey, entry);
              }
              local.set(key, entry);
              if (!borrowed.has(entry)) {
                borrowed.add(entry);
                borrowedBytes += entry.bytes;
                pin(entry);
              }
              if (!createdRaw) stats.hits++;
              return false;
            });
            // User-supplied providers may finish/supersede this view reentrantly.
            assertOpen();
            return prepared;
          } catch (error) {
            finish();
            throw error;
          }
        },
        resolveCached(c) {
          assertOpen();
          const classification = partition.classify(c);
          if (
            (classification & SOFTWARE_OVERVIEW_INTEGER) === 0 ||
            (classification & SOFTWARE_OVERVIEW_UNSAFE) !== 0
          )
            return null;
          return local.get(pixelKey(c)) ?? null;
        },
        drawBatch(commands, frames) {
          assertOpen();
          const canvasCommands = [],
            sources = [],
            sourceIds = new Map(),
            staged = new Map(),
            stagedEntries = new Set();
          let descriptors,
            n = 0,
            completed = false;
          const clearStaged = () => {
            for (const entry of stagedEntries) unpin(entry);
            stagedEntries.clear();
            staged.clear();
            sources.length = 0;
            sourceIds.clear();
            n = 0;
          };
          const flush = () => {
            assertOpen();
            if (!n) return;
            try {
              const composeStarted = performance.now();
              composeInto(
                pixels,
                width,
                height,
                descriptors.subarray(0, n),
                sources,
              );
              stats.nativeComposeMilliseconds +=
                performance.now() - composeStarted;
              result.nativeCommands += n / 8;
              stats.nativeCommands += n / 8;
              stats.nativeBatches++;
              stats.maxBatchSources = Math.max(
                stats.maxBatchSources,
                sources.length,
              );
              stats.maxBatchBlits = Math.max(stats.maxBatchBlits, n / 8);
            } finally {
              clearStaged();
            }
          };
          const get = (c) => {
            const key = pixelKey(c);
            let entry = staged.get(key);
            if (entry) return entry;
            entry =
              local.get(key) ??
              framePixels(
                fullKeyFor(c),
                () => frames.resolve(c),
                c.opacity === undefined ? 1 : c.opacity,
                flush,
                c,
                assertOpen,
              );
            assertOpen();
            staged.set(key, entry);
            if (!stagedEntries.has(entry)) {
              stagedEntries.add(entry);
              pin(entry);
            }
            return entry;
          };
          const append = (data, frame, c, blend, flipX, flipY) => {
            let id = sourceIds.get(data);
            if (id === undefined) {
              id = sources.length;
              sources.push(data);
              sourceIds.set(data, id);
            }
            descriptors[n++] = id;
            descriptors[n++] = frame.width;
            descriptors[n++] = frame.height;
            descriptors[n++] = c.dx - partition.left;
            descriptors[n++] = c.dy - partition.top;
            descriptors[n++] = flipX;
            descriptors[n++] = flipY;
            descriptors[n++] = blend;
          };
          try {
            descriptors = new Int32Array(
              Math.min(commands.length * 2, MAX_BATCH_BLITS) * 8,
            );
            for (const c of commands) {
              const classification = partition.classify(c);
              if (classification & SOFTWARE_OVERVIEW_UNSAFE)
                canvasCommands.push(c);
              if (
                (classification & SOFTWARE_OVERVIEW_NATIVE) !==
                SOFTWARE_OVERVIEW_NATIVE
              )
                continue;
              // Reserve room for both a base and additive blit before borrowing
              // its pixels. The source count cannot exceed the blit count.
              if (n + 16 > descriptors.length) flush();
              const entry = get(c);
              if (entry.width !== c.dw || entry.height !== c.dh)
                throw new Error(
                  "Native overview frame dimensions changed after planning",
                );
              const flipX = Number(!!c.flipX && !entry.uvFlipApplied);
              const flipY = Number(!!c.flipY && !entry.uvFlipApplied);
              append(entry.base, entry, c, 0, flipX, flipY);
              if (entry.additive)
                append(entry.additive, entry, c, 1, flipX, flipY);
            }
            flush();
            result.canvasCommands += canvasCommands.length;
            stats.canvasCommands += canvasCommands.length;
            completed = true;
            return canvasCommands;
          } finally {
            clearStaged();
            releaseBorrowed();
            if (!completed) finish();
          }
        },
      };
      return result;
    },
    dispose() {
      disposed = true;
      releaseCurrentView();
      for (const [key, entry] of entries) retire(key, entry);
      backing = null;
      stats.frameBytes = 0;
      stats.frameEntries = 0;
      stats.bufferBytes = 0;
    },
  };
}
