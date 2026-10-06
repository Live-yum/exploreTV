import { textureSource } from "../core/assets.mjs";
import { ORDINARY_BLOCKS } from "../core/renderer.mjs";
import { sceneFrameKey } from "../core/scene-frames.mjs";
import { prepareRawOverviewFrame } from "./raw-overview-frame.mjs";
import {
  nativeBlitterStatus,
  clearOpaque,
  composeInto,
  composeIntoMasked,
  quantizeCanvasOpacity,
} from "./native-blitter.mjs";
import { boxDownsampleRgbaNative } from "./native-reducer.mjs";
import { canonicalSlopeClip } from "./slope-overview-frame.mjs";
import { prepareCanonicalSlopeOverviewFrame } from "./direct-slope-overview-frame.mjs";

const MAX_COMMANDS = 131072;
const MAX_BATCH_BLITS = 8192;
const KEY_STRIDE = 2 ** 26;
const MAX_IDENTITY = Math.floor(Number.MAX_SAFE_INTEGER / KEY_STRIDE) - 1;
const OPAQUE_BLACK_WORD = new Uint32Array(
  Uint8Array.of(0, 0, 0, 255).buffer,
)[0];
const ordinary = new Uint8Array(Math.max(...ORDINARY_BLOCKS) + 1);
for (const type of ORDINARY_BLOCKS) ordinary[type] = 1;

// Restrict the shader and geometry, not the atlas filename. Identity paint has
// no type-dependent paint settings; every new source/crop is still checked by
// the same raw preparer used by the generic native backend.
function ordinaryCandidateSide(c, dx = c.dx, dy = c.dy) {
  const wall = c.kind === "wall",
    side = wall ? 32 : 16,
    paint = c.paintId === undefined ? 0 : c.paintId;
  if (
    (!wall &&
      (c.kind !== "tile" ||
        typeof c.type !== "number" ||
        ordinary[c.type] !== 1)) ||
    (c.shape !== undefined && c.shape !== 0) ||
    c.clip ||
    c.vertexColor ||
    c.vertexColors ||
    (c.opacity !== undefined && c.opacity !== 1) ||
    (paint !== 0 && paint !== 31) ||
    c.sw !== side ||
    c.sh !== side ||
    c.dw !== side ||
    c.dh !== side ||
    !Number.isSafeInteger(c.sx) ||
    !Number.isSafeInteger(c.sy) ||
    c.sx < 0 ||
    c.sy < 0 ||
    c.sx > 4095 ||
    c.sy > 4095 ||
    !Number.isSafeInteger(dx) ||
    !Number.isSafeInteger(dy) ||
    Math.abs(dx) > 0x3fffffff ||
    Math.abs(dy) > 0x3fffffff
  )
    return 0;
  return side;
}

// Preserve the short numeric-key path for ordinary terrain, but the same raw
// identity shader can also draw half bricks, liquid frames and small sprites.
// Their original command order and fractional opacity are not approximated.
function candidateKind(c, dx = c.dx, dy = c.dy) {
  const ordinarySide = ordinaryCandidateSide(c, dx, dy);
  if (ordinarySide) return ordinarySide;
  const opacity = c.opacity === undefined ? 1 : c.opacity,
    paint = c.paintId === undefined ? 0 : c.paintId;
  if (c.clip) {
    // A cached success must not alias string/invalid scalars in sceneFrameKey.
    // These restrictions only select a fast path; rejected commands retain the
    // original preparer's diagnostics, including unknown paint and bad tint.
    if (
      !Number.isSafeInteger(c.sx) ||
      !Number.isSafeInteger(c.sy) ||
      c.sx < 0 ||
      c.sy < 0 ||
      !Number.isInteger(paint) ||
      paint < 0 ||
      paint > 31 ||
      (c.type != null && (!Number.isSafeInteger(c.type) || c.type < 0))
    )
      return 0;
    if (c.vertexColor) {
      const v = c.vertexColor;
      if (
        (!Array.isArray(v) && !ArrayBuffer.isView(v)) ||
        v.length !== 4 ||
        !Number.isFinite(v[0]) ||
        v[0] < 0 ||
        v[0] > 255 ||
        !Number.isFinite(v[1]) ||
        v[1] < 0 ||
        v[1] > 255 ||
        !Number.isFinite(v[2]) ||
        v[2] < 0 ||
        v[2] > 255 ||
        !Number.isFinite(v[3]) ||
        v[3] < 0 ||
        v[3] > 255
      )
        return 0;
    }
    const shape = canonicalSlopeClip(
      c.dx === dx && c.dy === dy ? c : { ...c, dx, dy },
    );
    return shape === null ? 0 : -shape - 1;
  }
  if (
    c.clip ||
    c.vertexColor ||
    c.vertexColors ||
    (paint !== 0 && paint !== 31) ||
    !Number.isFinite(opacity) ||
    opacity < 0 ||
    opacity > 1 ||
    !Number.isSafeInteger(c.sx) ||
    !Number.isSafeInteger(c.sy) ||
    c.sx < 0 ||
    c.sy < 0 ||
    !Number.isSafeInteger(c.sw) ||
    !Number.isSafeInteger(c.sh) ||
    c.sw < 1 ||
    c.sh < 1 ||
    c.sw > 64 ||
    c.sh > 64 ||
    c.dw !== c.sw ||
    c.dh !== c.sh ||
    !Number.isSafeInteger(dx) ||
    !Number.isSafeInteger(dy) ||
    Math.abs(dx) > 0x3fffffff ||
    Math.abs(dy) > 0x3fffffff
  )
    return 0;
  return -1;
}

/**
 * Exact 1px/tile composition for the ordinary unscaled terrain shader.
 *
 * This is a partition of an already complete plan. Required assets, omissions,
 * owner counts and diagnostics remain the engine's responsibility. A handled
 * command has passed raw preparation and touches no unsafe core cell. All
 * commands which fail that proof stay in the generic renderer. Safe pixels
 * include even the candidates crossing an unsafe boundary, in original order.
 * Compact terrain arrives as numeric records and unique frame templates; no
 * per-command objects or prepared-frame strong references are materialized.
 * The first pass also proves final opaque tile means. The second pass submits
 * only commands touching a safe cell which still needs detailed composition;
 * a crossing wall stays one command while the native kernel skips resolved
 * and unsafe destination fragments. Proven means replace those cells during
 * reduction. A mean never substitutes for source validation.
 *
 * Retained frames, sources pinned by the current native batch, and conservative
 * UTF-16 bytes for extended string keys share ONE byte limit. Bounded CLOCK
 * eviction keeps a hit to one Map lookup plus a recent bit; only eviction
 * pressure moves Map entries. Pinned sources are never retired or promoted.
 * source and registration identities are weakly owned, never stringified.
 * Results own their small 1px array. The detailed native core is reused, bounded
 * independently, and never escapes the renderer. Recording is intentionally
 * left to the generic backend; callers must disable this path when recording.
 */
export function createDirectTerrainOverview({
  maxFrameBytes = 4 * 1024 * 1024,
  maxFrames = 8192,
  maxDetailedBytes = 6 * 1024 * 1024,
  inputEncoding = "tconvert-game-raw",
  detailedRgbaArena = null,
  // Fewer pixel operations did not beat unmasked composition in the complete
  // CI export. Keep this kernel available for measured A/B, explicitly opt-in.
  resolvedCellMask = false,
} = {}) {
  if (
    typeof resolvedCellMask !== "boolean" ||
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < 8192 ||
    maxFrameBytes > 4 * 1024 * 1024 ||
    !Number.isSafeInteger(maxFrames) ||
    maxFrames < 1 ||
    maxFrames > 8192 ||
    !Number.isSafeInteger(maxDetailedBytes) ||
    maxDetailedBytes < 1024 ||
    maxDetailedBytes > 6 * 1024 * 1024
  )
    throw new Error("Invalid direct terrain overview budget");
  if (
    inputEncoding !== "tconvert-game-raw" &&
    inputEncoding !== "standard-straight"
  )
    throw new Error("Unknown asset channel encoding");
  if (
    detailedRgbaArena !== null &&
    (typeof detailedRgbaArena.acquire !== "function" ||
      !Number.isSafeInteger(detailedRgbaArena.maxBytes) ||
      detailedRgbaArena.maxBytes < 4)
  )
    throw new TypeError("Invalid shared overview RGBA arena");

  const entries = new Map(),
    // Per-view compact frame references contain only slot/generation numbers.
    // Retiring an entry removes the sole unpinned strong reference from this
    // table; stale view slots can never keep its pixel planes alive.
    cacheSlots = new Array(maxFrames),
    cacheGenerations = new Uint32Array(maxFrames),
    freeCacheSlots = [];
  let nextCacheSlot = 0;
  let identities = new WeakMap(),
    nextIdentity = 1,
    backing = null,
    descriptors = null,
    disposed = false,
    rendering = false;
  const stats = {
    available: nativeBlitterStatus.available,
    backend: "direct-terrain-integer-compositor",
    reason: nativeBlitterStatus.reason,
    sourceSha256: nativeBlitterStatus.sourceSha256,
    binarySha256: nativeBlitterStatus.binarySha256,
    kernel: nativeBlitterStatus.kernel,
    frameByteLimit: maxFrameBytes,
    frameBytes: 0,
    peakFrameBytes: 0,
    liveFrameBytes: 0,
    peakLiveFrameBytes: 0,
    activeFrameBytes: 0,
    peakActiveFrameBytes: 0,
    frameEntries: 0,
    peakFrameEntries: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
    clockScans: 0,
    clockPromotions: 0,
    sourceInvalidations: 0,
    rawPreparedFrames: 0,
    preparationFailures: 0,
    budgetFallbacks: 0,
    extendedCandidates: 0,
    slopeCandidates: 0,
    slopePreparedFrames: 0,
    secondPassHits: 0,
    frameKeyLookups: 0,
    compactCommands: 0,
    compactFramesValidated: 0,
    compactValidationReuses: 0,
    compactSecondPassSlotHits: 0,
    compactSecondPassReloads: 0,
    compactSlotBytes: 0,
    peakCompactSlotBytes: 0,
    secondPassMisses: 0,
    secondPassFailures: 0,
    candidateCoreCommands: 0,
    candidateBlitPixels: 0,
    skippedBlitPixels: 0,
    nativeBlitPixels: 0,
    resolvedCellMask,
    // Exact counts over submitted planes only; whole-command skips above are
    // already measured separately and never enter the native kernel.
    blitPixelsToResolvedCells: 0,
    maskedBlitPixelsSkipped: 0,
    maskedUnsafeBlitPixelsSkipped: 0,
    skippedWallCommands: 0,
    skippedTileCommands: 0,
    skippedUnsafeCommands: 0,
    keptCrossOpaqueWallCommands: 0,
    opaqueCells: 0,
    nativeRequiredCells: 0,
    allNativeSkippedRenders: 0,
    nativeCommands: 0,
    nativeBlits: 0,
    nativeBatches: 0,
    maxBatchSources: 0,
    maxBatchBlits: 0,
    handledCommands: 0,
    totalCommands: 0,
    totalCells: 0,
    unsafeCells: 0,
    renders: 0,
    fallbackRenders: 0,
    bufferBytes: 0,
    peakBufferBytes: 0,
    sharedBufferBytes: 0,
    peakSharedBufferBytes: 0,
    phaseMilliseconds: {
      scanAndBatch: 0,
      scan: 0,
      batch: 0,
      prepare: 0,
      clear: 0,
      compose: 0,
      partition: 0,
      reduce: 0,
    },
  };
  const clearEntries = () => {
    entries.clear();
    cacheSlots.fill(undefined);
    cacheGenerations.fill(0);
    freeCacheSlots.length = nextCacheSlot = 0;
    stats.frameBytes = stats.liveFrameBytes = stats.frameEntries = 0;
  };
  const retire = (key, entry) => {
    entries.delete(key);
    cacheSlots[entry.slot] = undefined;
    freeCacheSlots.push(entry.slot);
    stats.frameBytes -= entry.bytes;
    stats.liveFrameBytes = stats.frameBytes;
    stats.frameEntries = entries.size;
    stats.evictions++;
  };

  return {
    stats,
    render(plan, core, region, assets) {
      if (disposed) throw new Error("Direct terrain overview is disposed");
      if (rendering)
        throw new Error("Direct terrain overview is not reentrant");
      if (
        !nativeBlitterStatus.available ||
        inputEncoding !== "tconvert-game-raw"
      )
        return null;
      const rect = region?.rect,
        commands = plan?.commands,
        compact = plan?.compactTerrain,
        records = compact?.records,
        templates = compact?.frames;
      if (
        compact &&
        (compact.stride !== 5 ||
          !(records instanceof Int32Array) ||
          !(records.buffer instanceof ArrayBuffer) ||
          records.buffer.detached === true ||
          records.length % 5 ||
          records.length / 5 > MAX_COMMANDS ||
          !Array.isArray(templates) ||
          templates.length > MAX_COMMANDS)
      )
        return null;
      if (
        !rect ||
        !core ||
        !Array.isArray(commands) ||
        commands.length > MAX_COMMANDS ||
        ![
          core.x,
          core.y,
          core.width,
          core.height,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
        ].every(Number.isSafeInteger) ||
        core.width < 1 ||
        core.height < 1 ||
        core.x < rect.x ||
        core.y < rect.y ||
        core.x + core.width > rect.x + rect.width ||
        core.y + core.height > rect.y + rect.height ||
        plan.width !== rect.width * 16 ||
        plan.height !== rect.height * 16 ||
        core.width * core.height * 1024 > maxDetailedBytes ||
        (detailedRgbaArena !== null &&
          core.width * core.height * 1024 > detailedRgbaArena.maxBytes)
      )
        return null;
      const width = core.width,
        height = core.height,
        pixelWidth = width * 16,
        pixelHeight = height * 16,
        byteLength = width * height * 1024,
        left = (core.x - rect.x) * 16,
        top = (core.y - rect.y) * 16;
      if (
        !Number.isSafeInteger(left) ||
        !Number.isSafeInteger(top) ||
        left > 0x3fffffff ||
        top > 0x3fffffff
      )
        return null;

      // Reset only between views, long before numeric namespace exhaustion.
      if (nextIdentity > MAX_IDENTITY - MAX_COMMANDS) {
        clearEntries();
        identities = new WeakMap();
        nextIdentity = 1;
      }
      rendering = true;
      stats.renders++;
      stats.totalCommands += commands.length;
      stats.totalCells += width * height;
      const handled = new Uint8Array(commands.length),
        unsafe = new Uint8Array(width * height),
        resolved = new Uint8Array(width * height),
        resolvedRgba = new Uint8Array(width * height * 4),
        resolvedWords = new Uint32Array(resolvedRgba.buffer),
        bounds = new Int32Array(4),
        namespaces = new Map(),
        // Negative entries retain only bounded numeric terrain keys. Extended
        // strings belong to the accounted success cache, never an uncharged
        // per-view failure Set which could otherwise retain many megabytes.
        failedKeys = new Set(),
        sources = [],
        pinned = [],
        // Validation and opaque means survive eviction as scalar metadata.
        // No template or command instance retains a prepared frame object.
        compactFlags = compact ? new Uint8Array(templates.length) : null,
        compactMeans = compact ? new Uint32Array(templates.length) : null,
        compactSlots = compact ? new Uint32Array(templates.length) : null,
        compactGenerations = compact ? new Uint32Array(templates.length) : null;
      stats.compactSlotBytes = compact ? templates.length * 13 : 0;
      stats.peakCompactSlotBytes = Math.max(
        stats.peakCompactSlotBytes,
        stats.compactSlotBytes,
      );
      let previousAsset,
        previousNamespace,
        unsafeCells = 0,
        opaqueCells = 0,
        used = 0,
        batchCommands = 0,
        detailed = null,
        detailedLease = null,
        useResolvedMask = false,
        scanFinished = false,
        batchStarted = null;
      const scanStarted = performance.now();

      const setBounds = (c, dx = c.dx, dy = c.dy) => {
        const { dw, dh } = c;
        if (
          !Number.isFinite(dx) ||
          !Number.isFinite(dy) ||
          !Number.isFinite(dw) ||
          !Number.isFinite(dh) ||
          dw <= 0 ||
          dh <= 0
        )
          return false;
        const pad =
          c.clip ||
          !Number.isInteger(dx) ||
          !Number.isInteger(dy) ||
          !Number.isInteger(dw) ||
          !Number.isInteger(dh)
            ? 1
            : 0;
        bounds[0] = Math.min(
          width,
          Math.max(0, Math.floor((dx - left - pad) / 16)),
        );
        bounds[1] = Math.min(
          height,
          Math.max(0, Math.floor((dy - top - pad) / 16)),
        );
        bounds[2] = Math.max(
          0,
          Math.min(width, Math.ceil((dx + dw - left + pad) / 16)),
        );
        bounds[3] = Math.max(
          0,
          Math.min(height, Math.ceil((dy + dh - top + pad) / 16)),
        );
        return true;
      };
      const markUnsafe = (c, dx, dy) => {
        if (!c || !setBounds(c, dx, dy)) {
          unsafe.fill(1);
          unsafeCells = unsafe.length;
          return;
        }
        for (let y = bounds[1]; y < bounds[3]; y++)
          for (
            let i = y * width + bounds[0], end = y * width + bounds[2];
            i < end;
            i++
          )
            if (!unsafe[i]) {
              unsafe[i] = 1;
              unsafeCells++;
            }
      };
      // This is queried only after candidateKind and frame validation.
      // Repeating the general finite/clip/fractional checks for every ordinary
      // tile was a substantial part of the previous partition pass.
      const setCandidateBounds = (c, destX = c.dx, destY = c.dy) => {
        const dx = destX - left,
          dy = destY - top,
          right = dx + c.sw,
          bottom = dy + c.sh;
        if (right <= 0 || bottom <= 0 || dx >= pixelWidth || dy >= pixelHeight)
          return false;
        bounds[0] = dx <= 0 ? 0 : dx >> 4;
        bounds[1] = dy <= 0 ? 0 : dy >> 4;
        bounds[2] = right >= pixelWidth ? width : (right + 15) >> 4;
        bounds[3] = bottom >= pixelHeight ? height : (bottom + 15) >> 4;
        return true;
      };
      const clearBatch = () => {
        for (const entry of pinned) entry.pinned = false;
        pinned.length = sources.length = 0;
        used = batchCommands = 0;
        stats.activeFrameBytes = 0;
      };
      const flush = () => {
        if (!used) return;
        const started = performance.now();
        try {
          if (useResolvedMask) {
            const masked = composeIntoMasked(
              detailed,
              pixelWidth,
              pixelHeight,
              descriptors.subarray(0, used),
              sources,
              resolved,
            );
            stats.blitPixelsToResolvedCells += masked.pixelsToResolvedCells;
            stats.maskedBlitPixelsSkipped += masked.pixelsSkipped;
            stats.maskedUnsafeBlitPixelsSkipped +=
              masked.pixelsSkipped - masked.pixelsToResolvedCells;
            stats.skippedBlitPixels += masked.pixelsSkipped;
            stats.nativeBlitPixels -= masked.pixelsSkipped;
          } else
            composeInto(
              detailed,
              pixelWidth,
              pixelHeight,
              descriptors.subarray(0, used),
              sources,
            );
          stats.nativeBatches++;
          stats.nativeCommands += batchCommands;
          stats.nativeBlits += used / 8;
          stats.maxBatchBlits = Math.max(stats.maxBatchBlits, used / 8);
          stats.maxBatchSources = Math.max(
            stats.maxBatchSources,
            sources.length,
          );
        } finally {
          stats.phaseMilliseconds.compose += performance.now() - started;
          clearBatch();
        }
      };
      const makeRoom = (bytes) => {
        if (
          stats.frameBytes + bytes <= maxFrameBytes &&
          entries.size < maxFrames
        )
          return true;
        // Moving a Map entry appends it to a live iterator. Bound the scan to
        // two visits per initial entry: one chance to clear/move a recent item,
        // then one chance to retire it. Pinned entries survive both attempts;
        // the caller flushes the existing batch before retrying when necessary.
        const scanLimit = entries.size * 2,
          iterator = entries.entries();
        for (let scans = 0; scans < scanLimit; scans++) {
          if (
            stats.frameBytes + bytes <= maxFrameBytes &&
            entries.size < maxFrames
          )
            return true;
          const current = iterator.next();
          if (current.done) break;
          const [key, entry] = current.value;
          stats.clockScans++;
          if (entry.pinned) continue;
          if (entry.recent) {
            entry.recent = false;
            entries.delete(key);
            entries.set(key, entry);
            stats.clockPromotions++;
          } else retire(key, entry);
        }
        return (
          stats.frameBytes + bytes <= maxFrameBytes && entries.size < maxFrames
        );
      };
      const namespaceFor = (asset) => {
        if (asset === previousAsset && previousNamespace !== undefined)
          return previousNamespace;
        let namespace = namespaces.get(asset);
        if (namespace === undefined) {
          const source =
            assets instanceof Map ? assets.get(asset) : assets?.[asset];
          const registration = source ? textureSource(source) : null;
          namespace = null;
          if (source && registration && namespaces.size < 8192) {
            const sourceWidth = source.naturalWidth ?? source.width,
              sourceHeight = source.naturalHeight ?? source.height;
            let identity = identities.get(source);
            if (
              !identity ||
              identity.registration !== registration ||
              identity.width !== sourceWidth ||
              identity.height !== sourceHeight
            ) {
              if (identity) stats.sourceInvalidations++;
              identity = {
                registration,
                width: sourceWidth,
                height: sourceHeight,
                id: nextIdentity++,
              };
              identities.set(source, identity);
            }
            namespace = {
              source,
              prefix: identity.id * KEY_STRIDE,
              extendedPrefix: "raw:" + identity.id + ":",
            };
          }
          if (namespaces.size < 8192) namespaces.set(asset, namespace);
        }
        previousAsset = asset;
        previousNamespace = namespace;
        return namespace;
      };
      const getFrame = (c, kind, secondPass = false) => {
        const namespace = namespaceFor(c.asset);
        if (!namespace) {
          stats.preparationFailures++;
          return null;
        }
        // 12-bit x/y, one size bit and one identity-paint bit. Source namespace
        // includes both image identity and raw registration/dimensions.
        const key =
          kind > 0
            ? namespace.prefix +
              c.sx +
              c.sy * 4096 +
              (kind === 32 ? 2 ** 24 : 0) +
              (c.paintId === 31 ? 2 ** 25 : 0)
            : kind === -1
              ? namespace.extendedPrefix +
                c.sx +
                "," +
                c.sy +
                "," +
                c.sw +
                "," +
                c.sh +
                "," +
                (c.paintId === 31 ? 31 : 0) +
                "," +
                quantizeCanvasOpacity(c.opacity === undefined ? 1 : c.opacity)
              : "slope:" +
                namespace.prefix +
                ":" +
                sceneFrameKey(c) +
                ":" +
                (-kind - 1) +
                ":" +
                Number(!!c.flipX) +
                Number(!!c.flipY) +
                ":" +
                quantizeCanvasOpacity(c.opacity === undefined ? 1 : c.opacity);
        if (typeof key === "string" && key.length > 1024) {
          stats.budgetFallbacks++;
          return null;
        }
        const keyBytes = typeof key === "string" ? key.length * 2 : 0;
        stats.frameKeyLookups++;
        const hit = entries.get(key);
        if (hit) {
          hit.recent = true;
          stats.hits++;
          if (secondPass) stats.secondPassHits++;
          return hit;
        }
        if (secondPass) stats.secondPassMisses++;
        if (typeof key === "number" && failedKeys.has(key)) return null;
        stats.misses++;
        // Reserve both complete planes, the optional four-byte opaque mean,
        // and the conservative string-key storage before preparing a frame.
        const reservation =
          c.sw * c.sh * 8 +
          (c.sw === 16 && c.sh === 16 && kind >= -1 ? 4 : 0) +
          keyBytes;
        if (reservation > maxFrameBytes) {
          stats.budgetFallbacks++;
          if (typeof key === "number" && failedKeys.size < 8192)
            failedKeys.add(key);
          return null;
        }
        if (!makeRoom(reservation)) {
          flush();
          if (!makeRoom(reservation))
            throw new Error("Direct terrain active frame budget exhausted");
        }
        let frame = null;
        const started = performance.now();
        try {
          frame =
            kind < -1
              ? prepareCanonicalSlopeOverviewFrame(
                  c.dx === undefined ? { ...c, dx: 0, dy: 0 } : c,
                  namespace.source,
                  {
                    inputEncoding,
                  },
                )
              : prepareRawOverviewFrame(c, namespace.source, { inputEncoding });
        } catch {
          // The unchanged generic preparer owns unsupported-frame diagnostics.
        } finally {
          stats.phaseMilliseconds.prepare += performance.now() - started;
        }
        if (!frame || frame.unsupported) {
          stats.preparationFailures++;
          if (typeof key === "number" && failedKeys.size < 8192)
            failedKeys.add(key);
          return null;
        }
        const bytes =
          frame.base.byteLength +
          (frame.additive?.byteLength ?? 0) +
          (frame.mean?.byteLength ?? 0) +
          keyBytes;
        if (bytes > reservation || stats.frameBytes + bytes > maxFrameBytes)
          throw new Error("Direct terrain frame exceeded its byte reservation");
        const slot = freeCacheSlots.length
          ? freeCacheSlots.pop()
          : nextCacheSlot++;
        const generation = (cacheGenerations[slot] + 1) >>> 0;
        cacheGenerations[slot] = generation;
        const entry = {
          ...frame,
          slot,
          generation,
          meanWord: frame.mean
            ? new Uint32Array(frame.mean.buffer, frame.mean.byteOffset, 1)[0]
            : 0,
          bytes,
          recent: true,
          pinned: false,
          baseId: -1,
          additiveId: -1,
        };
        entries.set(key, entry);
        cacheSlots[slot] = entry;
        stats.frameBytes += bytes;
        stats.liveFrameBytes = stats.frameBytes;
        stats.frameEntries = entries.size;
        stats.peakFrameBytes = Math.max(stats.peakFrameBytes, stats.frameBytes);
        stats.peakLiveFrameBytes = Math.max(
          stats.peakLiveFrameBytes,
          stats.frameBytes,
        );
        stats.peakFrameEntries = Math.max(stats.peakFrameEntries, entries.size);
        if (kind < -1) stats.slopePreparedFrames++;
        else stats.rawPreparedFrames++;
        return entry;
      };
      const append = (sourceId, c, frame, blend, destX, destY) => {
        descriptors[used++] = sourceId;
        descriptors[used++] = frame.width;
        descriptors[used++] = frame.height;
        descriptors[used++] = destX - left;
        descriptors[used++] = destY - top;
        descriptors[used++] = c.flipX && !frame.uvFlipApplied ? 1 : 0;
        descriptors[used++] = c.flipY && !frame.uvFlipApplied ? 1 : 0;
        descriptors[used++] = blend;
      };

      try {
        for (let i = 0; i < commands.length; i++) {
          const command = commands[i];
          let c,
            destX,
            destY,
            frameSlot = -1,
            flags = 0,
            meanWord = 0;
          if (typeof command === "number") {
            const at = (-command - 1) * 5;
            if (
              !compact ||
              !Number.isSafeInteger(command) ||
              command >= 0 ||
              at < 0 ||
              at + 5 > records.length ||
              (frameSlot = records[at]) < 0 ||
              frameSlot >= templates.length ||
              !(c = templates[frameSlot]) ||
              typeof c !== "object"
            ) {
              markUnsafe(null);
              break;
            }
            destX = records[at + 1];
            destY = records[at + 2];
            stats.compactCommands++;
            if (Math.abs(destX) > 0x3fffffff || Math.abs(destY) > 0x3fffffff) {
              markUnsafe(c, destX, destY);
              if (unsafeCells === unsafe.length) break;
              continue;
            }
            flags = compactFlags[frameSlot];
            if (flags) stats.compactValidationReuses++;
          } else {
            c = command;
            destX = c?.dx;
            destY = c?.dy;
          }
          if (!flags) {
            const kind = c ? candidateKind(c, destX, destY) : 0,
              entry = kind ? getFrame(c, kind) : null;
            if (frameSlot >= 0) stats.compactFramesValidated++;
            if (!entry) {
              if (frameSlot >= 0) compactFlags[frameSlot] = 128;
              markUnsafe(c, destX, destY);
              if (unsafeCells === unsafe.length) break;
              continue;
            }
            // Bit 1 is the validated additive-plane count. The remaining bits
            // preserve the extended/slope kind without retaining frame pixels.
            flags =
              (entry.additive ? 3 : 1) |
              (kind === -1 ? 4 : kind < -1 ? 8 | ((-kind - 1) << 4) : 0);
            meanWord = entry.mean ? entry.meanWord : 0;
            if (frameSlot >= 0) {
              compactFlags[frameSlot] = flags;
              compactMeans[frameSlot] = meanWord;
              compactSlots[frameSlot] = entry.slot + 1;
              compactGenerations[frameSlot] = entry.generation;
            }
          } else if (flags === 128) {
            markUnsafe(c, destX, destY);
            if (unsafeCells === unsafe.length) break;
            continue;
          } else meanWord = compactMeans[frameSlot];
          handled[i] = flags;
          if (flags & 12) stats.extendedCandidates++;
          if (flags & 8) stats.slopeCandidates++;
          const dx = destX - left,
            dy = destY - top;
          if (
            c.sw === 16 &&
            c.sh === 16 &&
            (dx & 15) === 0 &&
            (dy & 15) === 0
          ) {
            if (dx < 0 || dy < 0 || dx >= pixelWidth || dy >= pixelHeight)
              continue;
            const at = (dy >> 4) * width + (dx >> 4);
            if (
              !c.clip &&
              meanWord &&
              (c.opacity === undefined || c.opacity === 1)
            ) {
              if (!resolved[at]) opaqueCells++;
              resolved[at] = 1;
              resolvedWords[at] = meanWord;
            } else if (resolved[at]) {
              resolved[at] = 0;
              opaqueCells--;
            }
          } else if (opaqueCells && setCandidateBounds(c, destX, destY)) {
            // A later wall or nonaligned tile invalidates an earlier tile's
            // mean wherever it overlaps. Before any opaque tile is seen (the
            // usual wall pass), this loop is unnecessary.
            for (let y = bounds[1]; y < bounds[3]; y++)
              for (
                let at = y * width + bounds[0], end = y * width + bounds[2];
                at < end;
                at++
              )
                if (resolved[at]) {
                  resolved[at] = 0;
                  opaqueCells--;
                }
          }
        }
        if (unsafeCells === unsafe.length) {
          stats.fallbackRenders++;
          stats.unsafeCells += unsafeCells;
          return null;
        }
        const scanMilliseconds = performance.now() - scanStarted;
        stats.phaseMilliseconds.scan += scanMilliseconds;
        stats.phaseMilliseconds.scanAndBatch += scanMilliseconds;
        scanFinished = true;
        const partitionStarted = performance.now();
        for (let i = 0; i < unsafe.length; i++)
          if (unsafe[i]) {
            if (resolved[i]) opaqueCells--;
            // Unsafe results are ignored by the caller. Supplying opaque black
            // also lets the existing masked reducer avoid those unused pixels.
            resolved[i] = 2;
            resolvedWords[i] = OPAQUE_BLACK_WORD;
          }
        const stride = width + 1,
          nativeRequiredCells = unsafe.length - unsafeCells - opaqueCells,
          prefix = unsafeCells ? new Uint32Array(stride * (height + 1)) : null,
          nativePrefix =
            nativeRequiredCells && nativeRequiredCells < unsafe.length
              ? new Uint32Array(stride * (height + 1))
              : null;
        if (prefix || nativePrefix)
          for (let y = 0; y < height; y++) {
            let row = 0,
              nativeRow = 0;
            for (let x = 0; x < width; x++) {
              const source = y * width + x;
              const at = (y + 1) * stride + x + 1;
              if (prefix) {
                row += unsafe[source];
                prefix[at] = prefix[at - stride] + row;
              }
              if (nativePrefix) {
                nativeRow += resolved[source] ? 0 : 1;
                nativePrefix[at] = nativePrefix[at - stride] + nativeRow;
              }
            }
          }
        useResolvedMask = resolvedCellMask && !!(opaqueCells || unsafeCells);
        stats.opaqueCells += opaqueCells;
        stats.nativeRequiredCells += nativeRequiredCells;
        stats.phaseMilliseconds.partition +=
          performance.now() - partitionStarted;
        batchStarted = performance.now();
        let handledCount = 0;
        for (let i = 0; i < commands.length; i++) {
          const flags = handled[i];
          if (!flags) continue;
          const command = commands[i],
            compactAt = typeof command === "number" ? (-command - 1) * 5 : -1,
            frameSlot = compactAt >= 0 ? records[compactAt] : -1,
            c = frameSlot >= 0 ? templates[frameSlot] : command,
            destX = frameSlot >= 0 ? records[compactAt + 1] : c.dx,
            destY = frameSlot >= 0 ? records[compactAt + 2] : c.dy;
          if (!setCandidateBounds(c, destX, destY)) {
            handled[i] = 1;
            handledCount++;
            continue;
          }
          const x0 = bounds[0],
            y0 = bounds[1],
            x1 = bounds[2],
            y1 = bounds[3],
            cells = (x1 - x0) * (y1 - y0),
            unsafeCount = prefix
              ? prefix[y1 * stride + x1] -
                prefix[y0 * stride + x1] -
                prefix[y1 * stride + x0] +
                prefix[y0 * stride + x0]
              : 0,
            nativeCount = nativePrefix
              ? nativePrefix[y1 * stride + x1] -
                nativePrefix[y0 * stride + x1] -
                nativePrefix[y1 * stride + x0] +
                nativePrefix[y0 * stride + x0]
              : nativeRequiredCells
                ? cells
                : 0,
            kind = flags & 8 ? -(flags >> 4) - 1 : flags & 4 ? -1 : c.sw,
            dx = destX - left,
            dy = destY - top,
            clippedPixels =
              (Math.min(pixelWidth, dx + c.sw) - Math.max(0, dx)) *
              (Math.min(pixelHeight, dy + c.sh) - Math.max(0, dy)) *
              (flags & 2 ? 2 : 1);
          handled[i] = unsafeCount ? 0 : 1;
          if (!unsafeCount) handledCount++;
          stats.candidateCoreCommands++;
          stats.candidateBlitPixels += clippedPixels;
          if (!nativeCount) {
            stats.skippedBlitPixels += clippedPixels;
            if (c.kind === "wall") stats.skippedWallCommands++;
            else stats.skippedTileCommands++;
            if (unsafeCount === cells) stats.skippedUnsafeCommands++;
            continue;
          }
          if (c.kind === "wall" && cells > unsafeCount + nativeCount)
            stats.keptCrossOpaqueWallCommands++;
          let entry;
          if (frameSlot >= 0) {
            entry = cacheSlots[compactSlots[frameSlot] - 1];
            if (entry && entry.generation === compactGenerations[frameSlot]) {
              entry.recent = true;
              stats.hits++;
              stats.secondPassHits++;
              stats.compactSecondPassSlotHits++;
            } else {
              stats.compactSecondPassReloads++;
              entry = getFrame(c, kind, true);
              if (entry) {
                compactSlots[frameSlot] = entry.slot + 1;
                compactGenerations[frameSlot] = entry.generation;
              }
            }
          } else entry = getFrame(c, kind, true);
          if (!entry) {
            // A source which becomes unavailable after the validating pass
            // cannot leave stale "handled" flags in the engine. Nothing from
            // this view has escaped; the complete original plan can fall back.
            stats.secondPassFailures++;
            stats.fallbackRenders++;
            stats.unsafeCells += unsafeCells;
            return null;
          }
          if (!detailed) {
            if (detailedRgbaArena) {
              detailedLease = detailedRgbaArena.acquire(byteLength);
              detailed = detailedLease.pixels;
              stats.sharedBufferBytes = detailedRgbaArena.maxBytes;
              stats.peakSharedBufferBytes = Math.max(
                stats.peakSharedBufferBytes,
                stats.sharedBufferBytes,
              );
            } else {
              if (!backing || backing.length < byteLength)
                backing = Buffer.allocUnsafe(byteLength);
              detailed = backing.subarray(0, byteLength);
              stats.bufferBytes = backing.length;
              stats.peakBufferBytes = Math.max(
                stats.peakBufferBytes,
                backing.length,
              );
            }
            const started = performance.now();
            clearOpaque(detailed);
            stats.phaseMilliseconds.clear += performance.now() - started;
            descriptors ??= new Int32Array(MAX_BATCH_BLITS * 8);
          }
          const blits = entry.additive ? 2 : 1;
          if (used + blits * 8 > descriptors.length) flush();
          if (!entry.pinned) {
            entry.pinned = true;
            pinned.push(entry);
            stats.activeFrameBytes += entry.bytes;
            stats.peakActiveFrameBytes = Math.max(
              stats.peakActiveFrameBytes,
              stats.activeFrameBytes,
            );
            entry.baseId = sources.length;
            sources.push(entry.base);
            if (entry.additive) {
              entry.additiveId = sources.length;
              sources.push(entry.additive);
            }
          }
          append(entry.baseId, c, entry, 0, destX, destY);
          if (entry.additive)
            append(entry.additiveId, c, entry, 1, destX, destY);
          batchCommands++;
          stats.nativeBlitPixels += clippedPixels;
        }
        flush();
        const batchMilliseconds = performance.now() - batchStarted;
        stats.phaseMilliseconds.batch += batchMilliseconds;
        stats.phaseMilliseconds.scanAndBatch += batchMilliseconds;
        batchStarted = null;
        const safe = unsafe;
        for (let i = 0; i < safe.length; i++) safe[i] ^= 1;
        stats.handledCommands += handledCount;
        stats.unsafeCells += unsafeCells;
        const reduceStarted = performance.now();
        let pixels;
        if (detailed)
          pixels = boxDownsampleRgbaNative(
            detailed,
            pixelWidth,
            pixelHeight,
            16,
            opaqueCells || unsafeCells
              ? { safe: resolved, rgba: resolvedRgba, widthTiles: width }
              : null,
          );
        else {
          stats.allNativeSkippedRenders++;
          for (let i = 0; i < resolved.length; i++)
            if (!resolved[i]) resolvedWords[i] = OPAQUE_BLACK_WORD;
          pixels = resolvedRgba;
        }
        stats.phaseMilliseconds.reduce += performance.now() - reduceStarted;
        return {
          handled,
          safe,
          pixels,
          handledCount,
          safeCells: safe.length - unsafeCells,
          opaqueCells,
          nativeRequiredCells,
        };
      } finally {
        if (!scanFinished) {
          const milliseconds = performance.now() - scanStarted;
          stats.phaseMilliseconds.scan += milliseconds;
          stats.phaseMilliseconds.scanAndBatch += milliseconds;
        }
        if (batchStarted !== null) {
          const milliseconds = performance.now() - batchStarted;
          stats.phaseMilliseconds.batch += milliseconds;
          stats.phaseMilliseconds.scanAndBatch += milliseconds;
        }
        clearBatch();
        detailedLease?.release();
        stats.compactSlotBytes = 0;
        rendering = false;
      }
    },
    dispose() {
      if (rendering)
        throw new Error(
          "Cannot dispose direct terrain overview during rendering",
        );
      disposed = true;
      clearEntries();
      identities = new WeakMap();
      backing = descriptors = null;
      stats.bufferBytes = stats.activeFrameBytes = 0;
      stats.sharedBufferBytes = 0;
    },
  };
}
