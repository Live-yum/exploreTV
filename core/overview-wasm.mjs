/** Portable, import-free WASM ordinary terrain planning. One instance per renderer. */
export const OVERVIEW_WASM_ABI = 1;
const modulo3 = (n) => ((n % 3) + 3) % 3;

export function createOverviewTerrainPlanner(
  module,
  { runtime = globalThis.WebAssembly } = {},
) {
  const instance = new runtime.Instance(module, {}),
    e = instance.exports;
  for (const name of [
    "overview_abi_version",
    "overview_prepare",
    "overview_plan",
    "overview_output_ptr",
    "overview_output_len",
    "overview_release",
  ])
    if (typeof e[name] !== "function")
      throw new Error(`Missing terrain WASM export: ${name}`);
  if (e.overview_abi_version() !== OVERVIEW_WASM_ABI || !e.memory?.buffer)
    throw new Error("Incompatible terrain WASM ABI");
  let disposed = false;
  const stats = {
    available: true,
    backend: "wasm-ordinary-neighbourhoods",
    abiVersion: OVERVIEW_WASM_ABI,
    regions: 0,
    cells: 0,
    fallbackRegions: 0,
    peakWorkingBytes: 0,
    peakLinearMemoryBytes: e.memory.buffer.byteLength,
    phaseMilliseconds: { packing: 0, planning: 0 },
  };
  return {
    stats,
    plan(region, { revealInvisible = false } = {}) {
      if (disposed) throw new Error("Terrain WASM planner is disposed");
      const r = region?.rect,
        w = r?.width,
        h = r?.height;
      // Unsupported values retain the public JS planner's exact validation and
      // diagnostics. Never coerce a string/fractional ID into a valid atlas type.
      if (
        !Number.isInteger(w) ||
        !Number.isInteger(h) ||
        w < 1 ||
        h < 1 ||
        w > 512 ||
        h > 512 ||
        w * h > 65536 ||
        region.cells?.length !== w * h ||
        !Number.isSafeInteger(r.x || 0) ||
        !Number.isSafeInteger(r.y || 0) ||
        !Number.isSafeInteger((r.x || 0) + (w - 1)) ||
        !Number.isSafeInteger((r.y || 0) + (h - 1))
      ) {
        stats.fallbackRegions++;
        return null;
      }
      const started = performance.now(),
        count = w * h;
      const pointer = e.overview_prepare(w, h) >>> 0;
      if (!pointer) throw new Error("Terrain WASM workspace allocation failed");
      stats.peakWorkingBytes = Math.max(stats.peakWorkingBytes, count * 10);
      stats.peakLinearMemoryBytes = Math.max(
        stats.peakLinearMemoryBytes,
        e.memory.buffer.byteLength,
      );
      const input = new Uint32Array(e.memory.buffer, pointer, count * 2);
      for (let i = 0; i < count; i++) {
        const t = region.cells[i];
        const type = t?.type ?? 0,
          wall = t?.wall ?? 0;
        if (
          (t?.active && t.type == null) ||
          !Number.isInteger(type) ||
          type < 0 ||
          type > 65535 ||
          !Number.isInteger(wall) ||
          wall < 0 ||
          wall > 65535
        ) {
          stats.phaseMilliseconds.packing += performance.now() - started;
          stats.fallbackRegions++;
          return null;
        }
        input[i * 2] =
          type | (t?.active ? 65536 : 0) | (t?.invisibleBlock ? 131072 : 0);
        input[i * 2 + 1] = wall | (t?.invisibleWall ? 65536 : 0);
      }
      const packed = performance.now();
      stats.phaseMilliseconds.packing += packed - started;
      if (
        e.overview_plan(
          modulo3(r.x || 0),
          modulo3(r.y || 0),
          revealInvisible ? 1 : 0,
        ) !== 0 ||
        e.overview_output_len() !== count * 2
      )
        throw new Error("Terrain WASM planning failed");
      stats.phaseMilliseconds.planning += performance.now() - packed;
      stats.regions++;
      stats.cells += count;
      // Borrowed only until the next call; planOverviewBand consumes it
      // synchronously and never stores it in the returned compact plan.
      return new Uint8Array(
        e.memory.buffer,
        e.overview_output_ptr() >>> 0,
        count * 2,
      );
    },
    dispose() {
      if (!disposed) e.overview_release();
      disposed = true;
    },
  };
}
