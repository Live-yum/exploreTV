import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { endianness } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  clearOpaque,
  composeInto,
  nativeBlitterStatus,
} from "./native-blitter.mjs";
import {
  boxDownsampleRgbaNative,
  nativeReducerStatus,
} from "./native-reducer.mjs";

export const WORLD_TAPE_SCHEMA = "exploretv-prepared-world-tape-v1";
export const WORLD_TAPE_LIMITS = Object.freeze({
  maxTotalBytes: 512 * 1024 * 1024,
  maxChunkBytes: 16 * 1024 * 1024,
  maxFrameBytes: 64 * 64 * 4,
  maxFrameCacheBytes: 8 * 1024 * 1024,
  maxFrames: 32768,
  maxChunks: 65536,
  maxIndexBytes: 8 * 1024 * 1024,
  maxReportBytes: 2 * 1024 * 1024,
  maxManifestBytes: 12 * 1024 * 1024,
  maxBatchCommands: 8192,
  maxChunkCommands: 262144,
});
const RECORD_BYTES = 48;
const COMMAND_RECORD = 1;
const OVERRIDE_RECORD = 2;
const FRAME_FILE = "frames.bin";
const COMMAND_FILE = "commands.bin";
const MANIFEST_FILE = "manifest.json";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const isHash = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const bytesView = (value) => {
  if (
    !(value instanceof Uint8Array || value instanceof Uint8ClampedArray) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.buffer.detached === true
  )
    throw new TypeError("World tape requires attached, nonshared byte arrays");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
};
const integer = (value, minimum, maximum, name) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`Invalid world-tape ${name}`);
  return value;
};
function budgets(options = {}) {
  const result = {};
  for (const name of [
    "maxTotalBytes",
    "maxChunkBytes",
    "maxFrames",
    "maxChunks",
    "maxIndexBytes",
  ])
    result[name] = integer(
      options[name] ?? WORLD_TAPE_LIMITS[name],
      1,
      WORLD_TAPE_LIMITS[name],
      name,
    );
  return result;
}
function checkedCore(core, maxChunkBytes) {
  if (!core || typeof core !== "object")
    throw new TypeError("Invalid world-tape core");
  const copy = {
    x: integer(core.x, 0, 0x3fffffff, "core x"),
    y: integer(core.y, 0, 0x3fffffff, "core y"),
    width: integer(core.width, 1, 512, "core width"),
    height: integer(core.height, 1, 512, "core height"),
  };
  if (copy.width * copy.height * 1024 > maxChunkBytes)
    throw new RangeError(
      "World-tape detailed core exceeds the chunk byte budget",
    );
  return copy;
}
function requireKernels(required) {
  if (
    required &&
    (!nativeBlitterStatus.available || !nativeReducerStatus.available)
  )
    throw new Error(
      "Prepared-world replay requires prepared native blitter and reducer kernels",
    );
}
function writeAll(fd, data) {
  let offset = 0;
  while (offset < data.length) {
    const count = writeSync(fd, data, offset, data.length - offset);
    if (!count) throw new Error("World-tape write made no progress");
    offset += count;
  }
}
function openRegular(path, maximum, expected = null) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      !Number.isSafeInteger(stat.size) ||
      stat.size > maximum ||
      (expected !== null && stat.size !== expected)
    )
      throw new Error("World-tape file size or type differs from its manifest");
    return { fd, length: stat.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function readRange(fd, position, length) {
  const data = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(
      fd,
      data,
      offset,
      length - offset,
      position + offset,
    );
    if (!count) throw new Error("Truncated world-tape file");
    offset += count;
  }
  return data;
}
function hashFile(path, length, maximum) {
  const { fd } = openRegular(path, maximum, length),
    hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (let offset = 0; offset < length; ) {
      const wanted = Math.min(buffer.length, length - offset),
        count = readSync(fd, buffer, 0, wanted, offset);
      if (!count) throw new Error("Truncated world-tape file");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    if (readSync(fd, buffer, 0, 1, length))
      throw new Error("World-tape file grew during validation");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
function inflateChecked(compressed, rawLength, hash) {
  const result = inflateRawSync(compressed, {
    maxOutputLength: Math.max(1, rawLength),
    info: true,
  });
  if (
    result.buffer.length !== rawLength ||
    result.engine.bytesWritten !== compressed.length ||
    sha256(result.buffer) !== hash
  )
    throw new Error(
      "World-tape record hash, length, or deflate boundary mismatch",
    );
  return result.buffer;
}

/**
 * Record already validated native batches. Frame sources are immutable prepared
 * pixels, as in createSoftwareOverview; their object identities avoid repeat
 * hashing while SHA-256 deduplicates different objects with identical bytes.
 * Every batch is copied/compressed/written synchronously before its borrowed
 * source buffers are released. Only bounded frame/chunk indexes remain live.
 * An existing output directory (e.g. containing preview.png) is accepted, but
 * existing tape files are never overwritten. Only manifest publication commits
 * the tape; abort removes exactly this recorder's files and leaves other output.
 */
export function createWorldTapeRecorder(directory, options = {}) {
  requireKernels(options.requireNative !== false);
  const limits = budgets(options),
    root = resolve(directory),
    frames = [],
    chunks = [],
    byHash = new Map(),
    identities = new WeakMap(),
    frameHash = createHash("sha256"),
    commandHash = createHash("sha256"),
    owned = [],
    stats = {
      frames: 0,
      chunks: 0,
      commands: 0,
      batches: 0,
      overrides: 0,
      frameFileBytes: 0,
      commandFileBytes: 0,
      manifestBytes: 0,
      totalBytes: 0,
      indexBytes: 0,
      decodedFrameBytes: 0,
      deduplicatedFrames: 0,
      peakChunkEncodedBytes: 0,
      peakChunkRawBytes: 0,
      finalized: false,
      stageMilliseconds: {
        frameHashAndWrite: 0,
        commandWrite: 0,
        overrides: 0,
      },
    };
  let frameFd = null,
    commandFd = null,
    current = null,
    closed = false;
  const abort = () => {
    if (stats.finalized || closed) return;
    closed = true;
    current = null;
    for (const fd of [frameFd, commandFd])
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
    frameFd = commandFd = null;
    for (const path of owned) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  };
  const checkOpen = () => {
    if (closed) throw new Error("World-tape recorder is closed");
  };
  const guarded =
    (callback) =>
    (...args) => {
      checkOpen();
      try {
        return callback(...args);
      } catch (error) {
        abort();
        throw error;
      }
    };
  const reserve = (bytes) => {
    if (stats.totalBytes + bytes > limits.maxTotalBytes)
      throw new RangeError("World-tape total byte budget exceeded");
  };
  const indexEntry = (entry) => {
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (stats.indexBytes + bytes > limits.maxIndexBytes)
      throw new RangeError("World-tape persistent index byte budget exceeded");
    stats.indexBytes += bytes;
  };
  try {
    mkdirSync(root, { recursive: true });
    for (const name of [FRAME_FILE, COMMAND_FILE, MANIFEST_FILE])
      if (existsSync(join(root, name)))
        throw new Error("World-tape output already exists");
    frameFd = openSync(join(root, FRAME_FILE), "wx");
    owned.push(join(root, FRAME_FILE));
    commandFd = openSync(join(root, COMMAND_FILE), "wx");
    owned.push(join(root, COMMAND_FILE));
  } catch (error) {
    abort();
    throw error;
  }

  const frameFor = (source) => {
    const data = bytesView(source);
    if (
      !data.length ||
      data.length > WORLD_TAPE_LIMITS.maxFrameBytes ||
      data.length % 4
    )
      throw new RangeError("World-tape frame exceeds the 64x64 RGBA budget");
    const cached = identities.get(source);
    if (cached !== undefined) return cached;
    const hash = sha256(data),
      key = `${data.length}:${hash}`;
    let id = byHash.get(key);
    if (id !== undefined) {
      identities.set(source, id);
      stats.deduplicatedFrames++;
      return id;
    }
    if (frames.length >= limits.maxFrames)
      throw new RangeError("World-tape frame index count budget exceeded");
    const compressed = deflateRawSync(data, { level: 1 }),
      entry = {
        offset: stats.frameFileBytes,
        length: compressed.length,
        decodedBytes: data.length,
        sha256: hash,
      };
    reserve(compressed.length);
    indexEntry(entry);
    writeAll(frameFd, compressed);
    frameHash.update(compressed);
    id = frames.length;
    frames.push(entry);
    byHash.set(key, id);
    identities.set(source, id);
    stats.frames++;
    stats.frameFileBytes += compressed.length;
    stats.totalBytes += compressed.length;
    stats.decodedFrameBytes += data.length;
    return id;
  };
  const appendRecord = (type, raw, count) => {
    if (current.rawBytes + raw.length > limits.maxChunkBytes)
      throw new RangeError("World-tape decoded chunk byte budget exceeded");
    const compressed = deflateRawSync(raw, { level: 1 }),
      header = Buffer.alloc(RECORD_BYTES);
    header.writeUInt8(type, 0);
    header.writeUInt32LE(raw.length, 4);
    header.writeUInt32LE(compressed.length, 8);
    header.writeUInt32LE(count, 12);
    Buffer.from(sha256(raw), "hex").copy(header, 16);
    const length = header.length + compressed.length;
    if (current.length + length > limits.maxChunkBytes)
      throw new RangeError("World-tape encoded chunk byte budget exceeded");
    reserve(length);
    writeAll(commandFd, header);
    writeAll(commandFd, compressed);
    commandHash.update(header).update(compressed);
    current.hash.update(header).update(compressed);
    current.length += length;
    current.rawBytes += raw.length;
    stats.commandFileBytes += length;
    stats.totalBytes += length;
  };
  return {
    stats,
    beginChunk: guarded((core) => {
      if (current) throw new Error("World-tape previous chunk is unfinished");
      if (chunks.length >= limits.maxChunks)
        throw new RangeError("World-tape chunk count budget exceeded");
      current = {
        core: checkedCore(core, limits.maxChunkBytes),
        offset: stats.commandFileBytes,
        length: 0,
        rawBytes: 0,
        commands: 0,
        batches: 0,
        hash: createHash("sha256"),
      };
    }),
    recordBatch: guarded(({ descriptors, sources, width, height }) => {
      if (!current) throw new Error("World-tape batch has no active chunk");
      if (
        width !== current.core.width * 16 ||
        height !== current.core.height * 16 ||
        !(descriptors instanceof Int32Array) ||
        !(descriptors.buffer instanceof ArrayBuffer) ||
        descriptors.buffer.detached === true ||
        descriptors.length % 8 ||
        descriptors.length / 8 > WORLD_TAPE_LIMITS.maxBatchCommands ||
        !Array.isArray(sources) ||
        sources.length > WORLD_TAPE_LIMITS.maxBatchCommands
      )
        throw new TypeError("Invalid world-tape native batch");
      const count = descriptors.length / 8;
      if (!count) return;
      if (current.commands + count > WORLD_TAPE_LIMITS.maxChunkCommands)
        throw new RangeError("World-tape chunk command count budget exceeded");
      // Resolve array getters before reading descriptor or source views.
      const views = sources.map((source) => source);
      if (descriptors.buffer.detached === true)
        throw new Error("Detached world-tape descriptors");
      for (let i = 0; i < descriptors.length; i += 8) {
        const id = descriptors[i],
          w = descriptors[i + 1],
          h = descriptors[i + 2];
        if (
          id < 0 ||
          id >= views.length ||
          w < 1 ||
          h < 1 ||
          w > 64 ||
          h > 64 ||
          bytesView(views[id]).length !== w * h * 4 ||
          ![descriptors[i + 5], descriptors[i + 6], descriptors[i + 7]].every(
            (v) => v === 0 || v === 1,
          )
        )
          throw new TypeError(
            "Invalid world-tape frame dimensions, index, flip, or blend",
          );
      }
      let started = performance.now();
      const global = new Map();
      for (let i = 0; i < descriptors.length; i += 8) {
        const id = descriptors[i];
        if (!global.has(id)) global.set(id, frameFor(views[id]));
      }
      stats.stageMilliseconds.frameHashAndWrite += performance.now() - started;
      started = performance.now();
      const raw = Buffer.allocUnsafe(descriptors.byteLength);
      for (let i = 0; i < descriptors.length; i++)
        raw.writeInt32LE(
          i % 8 === 0 ? global.get(descriptors[i]) : descriptors[i],
          i * 4,
        );
      appendRecord(COMMAND_RECORD, raw, count);
      current.commands += count;
      current.batches++;
      stats.commands += count;
      stats.batches++;
      stats.stageMilliseconds.commandWrite += performance.now() - started;
    }),
    endChunk: guarded((finalRGBA, nativePixels = null) => {
      if (!current) throw new Error("World-tape end has no active chunk");
      const started = performance.now(),
        final = bytesView(finalRGBA),
        core = current.core,
        cells = core.width * core.height;
      if (final.length !== cells * 4)
        throw new RangeError("Invalid world-tape final chunk dimensions");
      if (nativePixels === null && current.commands)
        throw new Error(
          "A recorded native batch requires its native reduction pixels",
        );
      let reduced;
      if (nativePixels !== null) {
        const native = bytesView(nativePixels);
        if (native.length !== cells * 1024)
          throw new RangeError("Invalid world-tape native core dimensions");
        reduced = boxDownsampleRgbaNative(
          native,
          core.width * 16,
          core.height * 16,
          16,
        );
      }
      const overrides = Buffer.allocUnsafe(cells * 8);
      let count = 0;
      for (let cell = 0; cell < cells; cell++) {
        const p = cell * 4;
        if (final[p + 3] !== 255)
          throw new Error(
            "World-tape output must have an opaque scene background",
          );
        if (
          final[p] === (reduced?.[p] ?? 0) &&
          final[p + 1] === (reduced?.[p + 1] ?? 0) &&
          final[p + 2] === (reduced?.[p + 2] ?? 0) &&
          final[p + 3] === (reduced?.[p + 3] ?? 255)
        )
          continue;
        const offset = count++ * 8;
        overrides.writeUInt32LE(cell, offset);
        final.copy(overrides, offset + 4, p, p + 4);
      }
      appendRecord(OVERRIDE_RECORD, overrides.subarray(0, count * 8), count);
      const entry = {
        core,
        offset: current.offset,
        length: current.length,
        rawBytes: current.rawBytes,
        commands: current.commands,
        batches: current.batches,
        overrides: count,
        sha256: current.hash.digest("hex"),
        rgbaSha256: sha256(final),
      };
      indexEntry(entry);
      chunks.push(entry);
      stats.chunks++;
      stats.overrides += count;
      stats.peakChunkEncodedBytes = Math.max(
        stats.peakChunkEncodedBytes,
        current.length,
      );
      stats.peakChunkRawBytes = Math.max(
        stats.peakChunkRawBytes,
        current.rawBytes,
      );
      stats.stageMilliseconds.overrides += performance.now() - started;
      current = null;
    }),
    finalize: guarded((report) => {
      if (current)
        throw new Error("Cannot finalize an unfinished world-tape chunk");
      if (!chunks.length)
        throw new Error("Cannot finalize an empty world tape");
      if (!report || typeof report !== "object" || Array.isArray(report))
        throw new TypeError("World-tape export report is required");
      const reportJson = JSON.stringify(report);
      if (Buffer.byteLength(reportJson) > WORLD_TAPE_LIMITS.maxReportBytes)
        throw new RangeError("World-tape report byte budget exceeded");
      const manifest = {
        schema: WORLD_TAPE_SCHEMA,
        version: 1,
        native: {
          blitterSourceSha256: nativeBlitterStatus.sourceSha256,
          reducerSourceSha256: nativeReducerStatus.sourceSha256,
        },
        report: JSON.parse(reportJson),
        limits,
        frames,
        chunks,
        files: {
          frames: {
            name: FRAME_FILE,
            bytes: stats.frameFileBytes,
            sha256: frameHash.digest("hex"),
          },
          commands: {
            name: COMMAND_FILE,
            bytes: stats.commandFileBytes,
            sha256: commandHash.digest("hex"),
          },
        },
      };
      const raw = Buffer.from(JSON.stringify(manifest));
      if (raw.length > WORLD_TAPE_LIMITS.maxManifestBytes)
        throw new RangeError("World-tape manifest byte budget exceeded");
      reserve(raw.length);
      closeSync(frameFd);
      frameFd = null;
      closeSync(commandFd);
      commandFd = null;
      const temporary = join(root, `${MANIFEST_FILE}.pending-${randomUUID()}`),
        fd = openSync(temporary, "wx");
      owned.push(temporary);
      try {
        writeAll(fd, raw);
      } finally {
        closeSync(fd);
      }
      // Atomic exclusive publication: an unexpected existing manifest wins.
      linkSync(temporary, join(root, MANIFEST_FILE));
      stats.manifestBytes = raw.length;
      stats.totalBytes += raw.length;
      stats.finalized = true;
      closed = true;
      // The complete manifest is now committed; cleanup must not turn a
      // successfully published tape into a partial abort.
      try {
        unlinkSync(temporary);
      } catch {}
      return manifest;
    }),
    abort,
  };
}

/** Read only the bounded index; verifyFiles streams each payload with 64 KiB. */
export function readWorldTapeManifest(directory, options = {}) {
  const limits = budgets(options),
    root = resolve(directory),
    opened = openRegular(
      join(root, MANIFEST_FILE),
      WORLD_TAPE_LIMITS.maxManifestBytes,
    );
  let manifest;
  try {
    manifest = JSON.parse(
      readRange(opened.fd, 0, opened.length).toString("utf8"),
    );
  } finally {
    closeSync(opened.fd);
  }
  if (
    !manifest ||
    manifest.schema !== WORLD_TAPE_SCHEMA ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.frames) ||
    !Array.isArray(manifest.chunks) ||
    !manifest.report ||
    typeof manifest.report !== "object" ||
    Array.isArray(manifest.report) ||
    !manifest.files ||
    manifest.frames.length > limits.maxFrames ||
    !manifest.chunks.length ||
    manifest.chunks.length > limits.maxChunks
  )
    throw new Error("Invalid world-tape manifest schema or index counts");
  let total = opened.length,
    indexBytes = 0;
  for (const [kind, name] of [
    ["frames", FRAME_FILE],
    ["commands", COMMAND_FILE],
  ]) {
    const file = manifest.files[kind];
    if (!file || file.name !== name || !isHash(file.sha256))
      throw new Error("Invalid world-tape payload identity");
    total += integer(file.bytes, 0, limits.maxTotalBytes, "payload file bytes");
  }
  if (total > limits.maxTotalBytes)
    throw new RangeError("World-tape total byte budget exceeded");
  const checkIndexBytes = (entry) => {
    indexBytes += Buffer.byteLength(JSON.stringify(entry));
    if (indexBytes > limits.maxIndexBytes)
      throw new RangeError("World-tape persistent index byte budget exceeded");
  };
  let offset = 0;
  for (const frame of manifest.frames) {
    if (!frame || frame.offset !== offset || !isHash(frame.sha256))
      throw new Error("Invalid world-tape frame offset or hash");
    integer(
      frame.length,
      1,
      WORLD_TAPE_LIMITS.maxFrameBytes + 256,
      "compressed frame length",
    );
    integer(
      frame.decodedBytes,
      4,
      WORLD_TAPE_LIMITS.maxFrameBytes,
      "decoded frame length",
    );
    if (frame.decodedBytes % 4)
      throw new Error("Invalid world-tape RGBA frame length");
    offset += frame.length;
    checkIndexBytes(frame);
  }
  if (offset !== manifest.files.frames.bytes)
    throw new Error("World-tape frame index does not cover its file");
  offset = 0;
  for (const chunk of manifest.chunks) {
    if (
      !chunk ||
      chunk.offset !== offset ||
      !isHash(chunk.sha256) ||
      !isHash(chunk.rgbaSha256)
    )
      throw new Error("Invalid world-tape chunk offset or hash");
    const core = checkedCore(chunk.core, limits.maxChunkBytes);
    integer(
      chunk.length,
      RECORD_BYTES + 2,
      limits.maxChunkBytes,
      "compressed chunk length",
    );
    integer(chunk.rawBytes, 0, limits.maxChunkBytes, "decoded chunk length");
    integer(
      chunk.commands,
      0,
      WORLD_TAPE_LIMITS.maxChunkCommands,
      "chunk commands",
    );
    integer(chunk.batches, 0, chunk.commands, "chunk batches");
    integer(chunk.overrides, 0, core.width * core.height, "chunk overrides");
    if (chunk.rawBytes !== chunk.commands * 32 + chunk.overrides * 8)
      throw new Error(
        "World-tape decoded chunk byte count differs from its index",
      );
    offset += chunk.length;
    checkIndexBytes(chunk);
  }
  if (offset !== manifest.files.commands.bytes)
    throw new Error("World-tape chunk index does not cover its file");
  if (
    Buffer.byteLength(JSON.stringify(manifest.report)) >
    WORLD_TAPE_LIMITS.maxReportBytes
  )
    throw new RangeError("World-tape report byte budget exceeded");
  if (options.verifyFiles !== false)
    for (const file of [manifest.files.frames, manifest.files.commands])
      if (
        hashFile(join(root, file.name), file.bytes, limits.maxTotalBytes) !==
        file.sha256
      )
        throw new Error("World-tape payload file hash mismatch");
  return manifest;
}

/**
 * Replay native compositions, not a stored final PNG. Frames are independently
 * inflated and verified; command records retain recording order. The LRU and
 * current native submission share one strict frame-pixel budget. A submission
 * flushes before acquiring a frame that would exceed it. The detailed core is
 * bounded by maxChunkBytes; one completed 1-pixel-per-tile chunk is yielded.
 * The caller must additionally validate report input/source fingerprints against
 * the requested world, textures and rendering options before publishing output.
 */
export async function* replayWorldTapeChunks(directory, options = {}) {
  requireKernels(options.requireNative !== false);
  const limits = budgets(options),
    maxFrameBytes = integer(
      options.maxFrameBytes ?? WORLD_TAPE_LIMITS.maxFrameCacheBytes,
      1,
      WORLD_TAPE_LIMITS.maxFrameCacheBytes,
      "frame cache bytes",
    ),
    root = resolve(directory),
    manifest = readWorldTapeManifest(root, options),
    cache = new Map(),
    stats = {
      chunks: 0,
      commands: 0,
      nativeBatches: 0,
      overrides: 0,
      framesDecoded: 0,
      frameCacheHits: 0,
      frameBytes: 0,
      peakFrameBytes: 0,
      peakActiveFrameBytes: 0,
      peakCoreBytes: 0,
      peakRecordBytes: 0,
      stageMilliseconds: {
        readAndInflate: 0,
        frames: 0,
        compose: 0,
        reduce: 0,
      },
    };
  if (
    options.requireNative !== false &&
    (manifest.native?.blitterSourceSha256 !==
      nativeBlitterStatus.sourceSha256 ||
      manifest.native?.reducerSourceSha256 !== nativeReducerStatus.sourceSha256)
  )
    throw new Error("World-tape native kernel source identity is stale");
  let frameFd = null,
    commandFd = null,
    backing = null;
  try {
    frameFd = openRegular(
      join(root, FRAME_FILE),
      limits.maxTotalBytes,
      manifest.files.frames.bytes,
    ).fd;
    commandFd = openRegular(
      join(root, COMMAND_FILE),
      limits.maxTotalBytes,
      manifest.files.commands.bytes,
    ).fd;
    const getFrame = (id, active) => {
      let value = cache.get(id);
      if (value) {
        cache.delete(id);
        cache.set(id, value);
        stats.frameCacheHits++;
        return value;
      }
      const entry = manifest.frames[id];
      if (!entry || entry.decodedBytes > maxFrameBytes)
        throw new RangeError(
          "World-tape frame is invalid or exceeds the live frame cache budget",
        );
      for (const [oldId, old] of cache) {
        if (stats.frameBytes + entry.decodedBytes <= maxFrameBytes) break;
        if (!active.has(oldId)) {
          cache.delete(oldId);
          stats.frameBytes -= old.length;
        }
      }
      if (stats.frameBytes + entry.decodedBytes > maxFrameBytes)
        throw new RangeError("World-tape active frame budget exceeded");
      const started = performance.now(),
        compressed = readRange(frameFd, entry.offset, entry.length);
      value = inflateChecked(compressed, entry.decodedBytes, entry.sha256);
      // Own exactly the logical frame bytes, never a larger pooled backing store.
      if (value.byteOffset !== 0 || value.buffer.byteLength !== value.length)
        value = Uint8Array.from(value);
      cache.set(id, value);
      stats.frameBytes += value.length;
      stats.peakFrameBytes = Math.max(stats.peakFrameBytes, stats.frameBytes);
      stats.framesDecoded++;
      stats.stageMilliseconds.frames += performance.now() - started;
      return value;
    };
    for (let index = 0; index < manifest.chunks.length; index++) {
      const chunk = manifest.chunks[index],
        core = chunk.core,
        width = core.width * 16,
        height = core.height * 16,
        detailedBytes = width * height * 4;
      if (!backing || backing.length < detailedBytes)
        backing = Buffer.allocUnsafe(detailedBytes);
      stats.peakCoreBytes = Math.max(stats.peakCoreBytes, backing.length);
      const pixels = backing.subarray(0, detailedBytes);
      clearOpaque(pixels);
      let started = performance.now();
      const encoded = readRange(commandFd, chunk.offset, chunk.length);
      if (sha256(encoded) !== chunk.sha256)
        throw new Error("World-tape compressed chunk hash mismatch");
      stats.stageMilliseconds.readAndInflate += performance.now() - started;
      let offset = 0,
        batches = 0,
        commands = 0,
        overrides = null,
        rawBytes = 0;
      while (offset < encoded.length) {
        if (encoded.length - offset < RECORD_BYTES)
          throw new Error("Truncated world-tape record header");
        const type = encoded[offset],
          rawLength = encoded.readUInt32LE(offset + 4),
          compressedLength = encoded.readUInt32LE(offset + 8),
          count = encoded.readUInt32LE(offset + 12),
          hash = encoded.subarray(offset + 16, offset + 48).toString("hex");
        if (
          encoded[offset + 1] ||
          encoded[offset + 2] ||
          encoded[offset + 3] ||
          ![COMMAND_RECORD, OVERRIDE_RECORD].includes(type) ||
          overrides !== null ||
          rawLength > limits.maxChunkBytes - rawBytes ||
          compressedLength < 2 ||
          compressedLength > encoded.length - offset - RECORD_BYTES
        )
          throw new Error("Invalid world-tape record header or order");
        if (
          (type === COMMAND_RECORD &&
            (!count ||
              count > WORLD_TAPE_LIMITS.maxBatchCommands ||
              rawLength !== count * 32)) ||
          (type === OVERRIDE_RECORD &&
            (count > core.width * core.height || rawLength !== count * 8))
        )
          throw new Error("Invalid world-tape record count or decoded length");
        started = performance.now();
        const raw = inflateChecked(
          encoded.subarray(
            offset + RECORD_BYTES,
            offset + RECORD_BYTES + compressedLength,
          ),
          rawLength,
          hash,
        );
        offset += RECORD_BYTES + compressedLength;
        rawBytes += rawLength;
        stats.peakRecordBytes = Math.max(stats.peakRecordBytes, raw.length);
        stats.stageMilliseconds.readAndInflate += performance.now() - started;
        if (type === OVERRIDE_RECORD) {
          overrides = raw;
          continue;
        }
        batches++;
        commands += count;
        if (batches > chunk.batches || commands > chunk.commands)
          throw new Error(
            "World-tape command records exceed their chunk index",
          );
        const descriptors =
            endianness() === "LE" && raw.byteOffset % 4 === 0
              ? new Int32Array(raw.buffer, raw.byteOffset, raw.length / 4)
              : Int32Array.from({ length: raw.length / 4 }, (_, i) =>
                  raw.readInt32LE(i * 4),
                ),
          active = new Map(),
          sources = [];
        let begin = 0,
          activeBytes = 0;
        const flush = (end) => {
          if (end === begin) return;
          const composeStarted = performance.now();
          composeInto(
            pixels,
            width,
            height,
            descriptors.subarray(begin * 8, end * 8),
            sources,
          );
          stats.stageMilliseconds.compose += performance.now() - composeStarted;
          stats.nativeBatches++;
          active.clear();
          sources.length = 0;
          activeBytes = 0;
          begin = end;
        };
        for (let command = 0; command < count; command++) {
          const position = command * 8,
            id = descriptors[position],
            entry = manifest.frames[id];
          if (
            id < 0 ||
            !entry ||
            descriptors[position + 1] < 1 ||
            descriptors[position + 1] > 64 ||
            descriptors[position + 2] < 1 ||
            descriptors[position + 2] > 64 ||
            descriptors[position + 1] * descriptors[position + 2] * 4 !==
              entry.decodedBytes ||
            ![
              descriptors[position + 5],
              descriptors[position + 6],
              descriptors[position + 7],
            ].every((v) => v === 0 || v === 1)
          )
            throw new Error(
              "Invalid world-tape command frame dimensions, index, flip, or blend",
            );
          let local = active.get(id);
          if (local === undefined) {
            if (activeBytes + entry.decodedBytes > maxFrameBytes)
              flush(command);
            const frame = getFrame(id, active);
            local = sources.length;
            active.set(id, local);
            sources.push(frame);
            activeBytes += frame.length;
            stats.peakActiveFrameBytes = Math.max(
              stats.peakActiveFrameBytes,
              activeBytes,
            );
          }
          descriptors[position] = local;
        }
        flush(count);
      }
      if (
        overrides === null ||
        overrides.length !== chunk.overrides * 8 ||
        commands !== chunk.commands ||
        batches !== chunk.batches ||
        rawBytes !== chunk.rawBytes
      )
        throw new Error("World-tape chunk record totals differ from its index");
      started = performance.now();
      const data = boxDownsampleRgbaNative(pixels, width, height, 16);
      let previous = -1;
      for (let position = 0; position < overrides.length; position += 8) {
        const cell = overrides.readUInt32LE(position);
        if (
          cell <= previous ||
          cell >= core.width * core.height ||
          overrides[position + 7] !== 255
        )
          throw new Error("Invalid world-tape override order, index, or alpha");
        overrides.copy(data, cell * 4, position + 4, position + 8);
        previous = cell;
      }
      if (sha256(data) !== chunk.rgbaSha256)
        throw new Error(
          "Replayed world-tape pixels differ from their prepared reference",
        );
      stats.stageMilliseconds.reduce += performance.now() - started;
      stats.chunks++;
      stats.commands += commands;
      stats.overrides += chunk.overrides;
      yield { core: { ...core }, data, index, stats };
    }
  } finally {
    if (frameFd !== null) closeSync(frameFd);
    if (commandFd !== null) closeSync(commandFd);
    cache.clear();
    backing = null;
    stats.frameBytes = 0;
  }
}
