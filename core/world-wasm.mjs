import {
  FormatError,
  LIMITS,
  openWorld,
  extractRegion,
  extractSceneRegion,
  validateRect,
  getWorldTileAccessor,
} from "./world.mjs";
import { decodeUtf8 } from "./utf8.mjs";
import { readWorldTreeContext } from "./world-tree-context.mjs";
import { readWorldHerbContext } from "./static-furniture-next.mjs";

/** ABI 1: one bounded Wasm instance per open world, no shared mutable instances. */
export const WASM_ABI_VERSION = 1;
export const WASM_CELL_BYTES = 32;
export const DEFAULT_WASM_URL = new URL(
  "../wasm-core/dist/exploretv_wld_core.wasm",
  import.meta.url,
);
const handles = new WeakMap();
const now = () => globalThis.performance?.now?.() ?? Date.now();
const errors = [
  "",
  "Truncated data",
  "World file size budget exceeded",
  "Unsupported WLD version; supported 269–326",
  "Invalid WLD magic",
  "Not a world file",
  "Invalid section offsets or count",
  "Invalid frame table",
  "Header section mismatch",
  "Invalid string length",
  "World dimensions exceed budget",
  "Tile type outside frame table",
  "Negative RLE",
  "RLE crosses column",
  "Tile section length mismatch",
  "Rectangle outside world",
  "Region budget exceeded",
  "WASM memory allocation failed",
  "WASM world is not open",
];
function fail(code) {
  if (code) throw new FormatError(errors[code] || `WASM core error ${code}`);
}
function inputBytes(input) {
  const bytes = ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  if (bytes.length > LIMITS.fileBytes)
    throw new FormatError("World file size budget exceeded");
  return bytes;
}
function u32Copy(exports, pointer, length) {
  const view = new DataView(exports.memory.buffer, pointer >>> 0, length * 4);
  return Uint32Array.from({ length }, (_, i) => view.getUint32(i * 4, true));
}
function checkExports(exports) {
  for (const name of [
    "abi_version",
    "cell_bytes",
    "prepare",
    "open_world",
    "last_error",
    "meta_ptr",
    "columns_ptr",
    "sections_ptr",
    "important_ptr",
    "world_surface",
    "extract_region",
    "output_ptr",
    "output_len",
    "release",
  ])
    if (typeof exports[name] !== "function")
      throw new Error(`WASM core missing export ${name}`);
  if (
    !exports.memory?.buffer ||
    exports.abi_version() !== WASM_ABI_VERSION ||
    exports.cell_bytes() !== WASM_CELL_BYTES
  )
    throw new Error("Incompatible WLD WASM ABI");
}
function sourceMetadata(world) {
  return {
    signature: world.signature,
    name: world.name,
    id: world.id,
    width: world.width,
    height: world.height,
    ...(world.worldSurface === undefined
      ? {}
      : { worldSurface: world.worldSurface }),
  };
}
function openWithModule(input, module, runtime) {
  const started = now(),
    bytes = inputBytes(input);
  const instance = new runtime.Instance(module, {}),
    exports = instance.exports;
  checkExports(exports);
  try {
    const copyStarted = now(),
      pointer = exports.prepare(bytes.length) >>> 0;
    fail(exports.last_error());
    new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
    const parseStarted = now();
    fail(exports.open_world());
    const metadataStarted = now(),
      m = u32Copy(exports, exports.meta_ptr(), 13);
    if (
      m[12] !== WASM_CELL_BYTES ||
      m[9] < 3 ||
      m[9] > 32 ||
      m[10] > 4096 ||
      m[11] !== m[1] + 1
    )
      throw new Error("Invalid WASM metadata descriptor");
    const world = {
      signature: String.fromCharCode(...bytes.subarray(4, 11)),
      version: m[0],
      name: decodeUtf8(bytes.subarray(m[5], m[5] + m[6])),
      seed: decodeUtf8(bytes.subarray(m[7], m[7] + m[8])),
      id: m[3] | 0,
      width: m[1],
      height: m[2],
      worldSurface: undefined,
      bytes,
      important: new Uint8Array(
        exports.memory.buffer,
        exports.important_ptr() >>> 0,
        m[10],
      ).slice(),
      sections: Array.from(u32Copy(exports, exports.sections_ptr(), m[9])),
      columns: u32Copy(exports, exports.columns_ptr(), m[11]),
      records: m[4],
    };
    const surface = exports.world_surface();
    if (Number.isFinite(surface)) world.worldSurface = surface;
    try {
      world.treeContext = readWorldTreeContext(world);
    } catch (error) {
      world.treeContextUnavailableReason = String(error.message || error).slice(
        0,
        200,
      );
    }
    try {
      world.herbContext = readWorldHerbContext(world);
    } catch (error) {
      world.herbContextUnavailableReason = String(error.message || error).slice(
        0,
        200,
      );
    }
    handles.set(world, {
      exports,
      stats: {
        instanceMs: copyStarted - started,
        inputCopyMs: parseStarted - copyStarted,
        parseMs: metadataStarted - parseStarted,
        jsMetadataMs: now() - metadataStarted,
        totalOpenMs: now() - started,
      },
    });
    return Object.freeze(world);
  } catch (error) {
    exports.release();
    throw error;
  }
}

/** Compile once. Call openWorld synchronously for each independently owned world.
 * source may be wasm bytes, a WebAssembly.Module, or a fetchable URL.
 * No eval, dynamic JS code generation, shared memory, atomics, threads, or WASI.
 */
export async function loadWasmCore(
  source = DEFAULT_WASM_URL,
  { runtime = globalThis.WebAssembly } = {},
) {
  if (!runtime?.compile || !runtime?.Instance)
    throw new Error("WebAssembly is unavailable");
  let module;
  if (runtime.Module && source instanceof runtime.Module) module = source;
  else {
    if (typeof source === "string" || source instanceof URL) {
      const response = await fetch(source);
      if (!response.ok)
        throw new Error(`WASM download failed: ${response.status}`);
      source = await response.arrayBuffer();
    }
    module = await runtime.compile(source);
  }
  if (runtime.Module?.imports && runtime.Module.imports(module).length)
    throw new Error("WLD WASM core must not require imports");
  const probe = new runtime.Instance(module, {});
  checkExports(probe.exports);
  probe.exports.release();
  return Object.freeze({
    backend: "rust-wasm",
    abiVersion: WASM_ABI_VERSION,
    openWorld: (input) => openWithModule(input, module, runtime),
    extractRegion: extractRegionWasm,
    extractSceneRegion: extractSceneRegionWasm,
    disposeWorld: disposeWorldWasm,
  });
}

/** Startup-only fallback: malformed WLD input is never reinterpreted after a WASM
 * validation error. A missing/blocked binary or unsupported engine falls back to JS.
 */
export async function loadWorldEngine(source = DEFAULT_WASM_URL, options = {}) {
  try {
    return await loadWasmCore(source, options);
  } catch (error) {
    const fallbackReason = String(error.message || error).slice(0, 240);
    options.onFallback?.(fallbackReason);
    return Object.freeze({
      backend: "javascript",
      fallbackReason,
      openWorld,
      extractRegion,
      extractSceneRegion,
      disposeWorld: () => {},
    });
  }
}

export function extractRegionWasm(world, rect) {
  rect = validateRect(rect, world.width, world.height);
  const handle = handles.get(world);
  if (!handle) return extractRegion(world, rect);
  const started = now(),
    { exports } = handle;
  fail(exports.extract_region(rect.x, rect.y, rect.width, rect.height));
  const decoded = now(),
    length = exports.output_len(),
    count = rect.width * rect.height;
  if (length !== count * WASM_CELL_BYTES)
    throw new Error("Invalid WASM region descriptor");
  const pointer = exports.output_ptr() >>> 0;
  const packed = new Uint8Array(exports.memory.buffer, pointer, length);
  const view = new DataView(packed.buffer, pointer, length);
  const cells = new Array(count),
    raw = new Array(count);
  for (let i = 0, p = 0; i < count; i++, p += WASM_CELL_BYTES) {
    const flags = view.getUint16(p, true),
      framed = !!(flags & 2048);
    cells[i] = {
      active: !!(flags & 1),
      type: view.getUint16(p + 2, true),
      frameX: framed ? view.getInt16(p + 4, true) : null,
      frameY: framed ? view.getInt16(p + 6, true) : null,
      wall: view.getUint16(p + 8, true),
      paint: packed[p + 10],
      wallPaint: packed[p + 11],
      liquid: packed[p + 12],
      liquidKind: packed[p + 13],
      shape: packed[p + 14],
      wireRed: !!(flags & 2),
      wireBlue: !!(flags & 4),
      wireGreen: !!(flags & 8),
      wireYellow: !!(flags & 16),
      actuator: !!(flags & 32),
      inactive: !!(flags & 64),
      invisibleBlock: !!(flags & 128),
      invisibleWall: !!(flags & 256),
      fullbrightBlock: !!(flags & 512),
      fullbrightWall: !!(flags & 1024),
    };
    const rawLength = packed[p + 15];
    if (!rawLength || rawLength > 16)
      throw new Error("Invalid WASM record descriptor");
    raw[i] = packed.slice(p + 16, p + 16 + rawLength);
  }
  const result = {
    rect,
    version: world.version,
    important: world.important.slice(),
    cells,
    raw,
    source: sourceMetadata(world),
  };
  handle.stats.lastExtract = {
    coreMs: decoded - started,
    jsConversionMs: now() - decoded,
    totalMs: now() - started,
  };
  return result;
}

export function extractSceneRegionWasm(world, rect, padding = 12) {
  if (!Number.isSafeInteger(padding) || padding < 0 || padding > 16)
    throw new FormatError("Invalid render padding");
  const region = extractRegionWasm(world, rect);
  region.treeContext = world.treeContext;
  region.herbContext = world.herbContext;
  region.treeContextUnavailableReason = world.treeContextUnavailableReason;
  region.getWorldTile = getWorldTileAccessor(world);
  const x = Math.max(0, region.rect.x - padding),
    y = Math.max(0, region.rect.y - padding);
  const width =
    Math.min(world.width, region.rect.x + region.rect.width + padding) - x;
  const height =
    Math.min(world.height, region.rect.y + region.rect.height + padding) - y;
  if (
    width <= LIMITS.regionSide &&
    height <= LIMITS.regionSide &&
    width * height <= LIMITS.regionTiles
  )
    region.context = extractRegionWasm(world, { x, y, width, height });
  else
    region.contextUnavailableReason =
      "Render halo exceeds the bounded region budget";
  return region;
}

/** Disposed worlds remain readable via the original JS decoder. Returned regions
 * own their raw bytes, so replacing/disposal never invalidates a selection.
 */
export function disposeWorldWasm(world) {
  const handle = handles.get(world);
  if (!handle) return;
  handle.exports.release();
  handles.delete(world);
}
export function worldWasmStats(world) {
  const handle = handles.get(world);
  return handle
    ? {
        ...handle.stats,
        ...(handle.stats.lastExtract
          ? { lastExtract: { ...handle.stats.lastExtract } }
          : {}),
        memoryBytes: handle.exports.memory.buffer.byteLength,
      }
    : null;
}
