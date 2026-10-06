import { overviewFrameRecipe } from "./overview-frame-recipes.mjs";
/** Portable, import-free WASM ordinary terrain planning. One instance per renderer. */
import { classifyTileSolidity, SOURCE_TILE_COUNT } from "./tile-solidity.mjs";
export const OVERVIEW_WASM_ABI = 3;
export const OVERVIEW_WASM_MAX_WORKING_BYTES = 24 * 1024 * 1024;
const modulo3 = (n) => ((n % 3) + 3) % 3;
const materialSolidity = Uint8Array.from(
  { length: SOURCE_TILE_COUNT },
  (_, type) => {
    const value = classifyTileSolidity(type);
    return value === undefined ? 0 : value ? 2 : 1;
  },
);

function streamMetadata(tile) {
  if (!tile) return 0;
  const shape = tile.shape || 0,
    paint = tile.paint || 0,
    wallPaint = tile.wallPaint || 0;
  return (
    (Number.isInteger(shape) && shape >= 0 && shape <= 5 ? shape : 7) |
    (1 << 3) |
    (Number.isInteger(tile.frameX) &&
    Number.isInteger(tile.frameY) &&
    tile.frameX >= 0 &&
    tile.frameY >= 0
      ? 1 << 4
      : 0) |
    (tile.paint || tile.wallPaint ? 1 << 5 : 0) |
    (tile.liquid ? 1 << 6 : 0) |
    (tile.wireRed ||
    tile.wireBlue ||
    tile.wireGreen ||
    tile.wireYellow ||
    tile.actuator
      ? 1 << 7
      : 0) |
    (tile.inactive ? 1 << 8 : 0) |
    (tile.fullbrightBlock || tile.fullbrightWall ? 1 << 9 : 0) |
    (paint === 0 || paint === 31 ? 1 << 10 : 0) |
    (wallPaint === 0 || wallPaint === 31 ? 1 << 11 : 0)
  );
}
function liquidMetadata(tile, type) {
  if (!tile) return 0;
  const amount = tile.liquid ?? 0,
    kind = tile.liquidKind ?? 0,
    shape = tile.shape ?? 0;
  const valid =
    Number.isInteger(amount) &&
    amount >= 0 &&
    amount <= 255 &&
    Number.isInteger(kind) &&
    kind >= 0 &&
    kind <= 4 &&
    Number.isInteger(shape) &&
    shape >= 0 &&
    shape <= 5 &&
    typeof tile.active === "boolean" &&
    (tile.inactive === undefined || typeof tile.inactive === "boolean");
  // Preserve malformed values for reference diagnostics without invoking
  // user-value numeric coercions (BigInt/Symbol/object values included).
  if (!valid) return 1 << 14;
  const solidity =
    tile.active && !tile.inactive ? (materialSolidity[type] ?? 0) : 1;
  return (
    (amount & 255) |
    ((kind & 7) << 8) |
    ((shape & 7) << 11) |
    (1 << 14) |
    (tile.inactive ? 1 << 15 : 0) |
    (solidity ? 1 << 16 : 0) |
    (solidity === 2 ? 1 << 17 : 0) |
    (valid ? 1 << 18 : 0)
  );
}

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
    "overview_prepare_liquids",
    "overview_plan_liquids",
    "overview_liquid_output_ptr",
    "overview_liquid_output_len",
    "overview_liquid_fast_count",
    "overview_release",
    "overview_prepare_stream",
    "overview_plan_stream",
    "overview_stream_events",
    "overview_stream_merge",
    "overview_working_bytes",
  ])
    if (typeof e[name] !== "function")
      throw new Error(`Missing terrain WASM export: ${name}`);
  if (e.overview_abi_version() !== OVERVIEW_WASM_ABI || !e.memory?.buffer)
    throw new Error("Incompatible terrain WASM ABI");
  let disposed = false,
    liquidCandidates = null,
    frameStream = null,
    generation = 0;
  const stats = {
    available: true,
    backend: "wasm-ordinary-neighbourhoods",
    abiVersion: OVERVIEW_WASM_ABI,
    regions: 0,
    cells: 0,
    fallbackRegions: 0,
    liquidRegions: 0,
    liquidCandidateCells: 0,
    liquidFastCells: 0,
    peakWorkingBytes: 0,
    peakLinearMemoryBytes: e.memory.buffer.byteLength,
    streamRegions: 0,
    streamRecords: 0,
    streamCommands: 0,
    streamUniqueRecipes: 0,
    peakStreamOutputBytes: 0,
    phaseMilliseconds: { packing: 0, planning: 0 },
  };
  const recordWorkingBytes = () => {
    const bytes = e.overview_working_bytes() >>> 0;
    if (bytes > OVERVIEW_WASM_MAX_WORKING_BYTES)
      throw new Error("Terrain WASM workspace budget exceeded");
    stats.peakWorkingBytes = Math.max(stats.peakWorkingBytes, bytes);
    stats.peakLinearMemoryBytes = Math.max(
      stats.peakLinearMemoryBytes,
      e.memory.buffer.byteLength,
    );
  };
  const streamView = (field, Type = Uint32Array) =>
    new Type(
      e.memory.buffer,
      e[`overview_stream_${field}_ptr`]() >>> 0,
      e[`overview_stream_${field}_len`](),
    );
  const createStream = (height, ownGeneration) => {
    let generated = false,
      finished = false;
    const valid = () => {
      if (disposed || generation !== ownGeneration)
        throw new Error("Expired terrain WASM stream");
    };
    return {
      generate({
        tiles = true,
        walls = true,
        paintEnabled = false,
        revealInvisible = false,
        tileBounds,
        wallBounds,
      }) {
        valid();
        if (generated)
          throw new Error("Terrain WASM stream was already generated");
        const started = performance.now();
        if (
          e.overview_plan_stream(
            (tiles ? 1 : 0) |
              (walls ? 2 : 0) |
              (paintEnabled ? 4 : 0) |
              (revealInvisible ? 8 : 0),
            ...tileBounds,
            ...wallBounds,
          ) !== 0
        )
          throw new Error("Terrain WASM frame stream planning failed");
        generated = true;
        stats.streamRegions++;
        recordWorkingBytes();
        stats.phaseMilliseconds.planning += performance.now() - started;
        return {
          counts: new Uint32Array(
            e.memory.buffer,
            e.overview_stream_counts_ptr(),
            16,
          ).slice(),
          wallFallback: streamView("wall_fallback").slice(),
          tileFallback: streamView("tile_fallback").slice(),
          wallAssets: streamView("wall_assets").slice(),
          tileAssets: streamView("tile_assets").slice(),
        };
      },
      finish(groups) {
        valid();
        if (!generated || finished)
          throw new Error("Invalid terrain WASM stream finalization");
        const started = performance.now(),
          objects = [];
        for (const { commands, terrain = 0 } of groups) {
          const pointer = e.overview_stream_events(commands.length) >>> 0;
          if (!pointer)
            throw new Error("Terrain WASM special command budget exceeded");
          const events = new Int32Array(
            e.memory.buffer,
            pointer,
            commands.length * 2,
          );
          for (let i = 0; i < commands.length; i++) {
            const c = commands[i];
            events[i * 2] = terrain ? c.x * height + c.y : 0;
            events[i * 2 + 1] = objects.length;
            objects.push(c);
          }
          if (e.overview_stream_merge(terrain) !== 0)
            throw new Error("Terrain WASM command merge failed");
        }
        finished = true;
        recordWorkingBytes();
        const sourceRecords = streamView("records", Int32Array),
          sourceRecipes = streamView("recipes"),
          sourceTokens = streamView("tokens", Int32Array);
        const outputBytes =
            sourceRecords.byteLength +
            sourceRecipes.byteLength +
            sourceTokens.byteLength,
          buffer = new ArrayBuffer(outputBytes),
          records = new Int32Array(buffer, 0, sourceRecords.length),
          recipeIds = new Uint32Array(
            buffer,
            sourceRecords.byteLength,
            sourceRecipes.length,
          ),
          tokens = new Int32Array(
            buffer,
            sourceRecords.byteLength + sourceRecipes.byteLength,
            sourceTokens.length,
          );
        records.set(sourceRecords);
        recipeIds.set(sourceRecipes);
        tokens.set(sourceTokens);
        const frames = Object.freeze(
          Array.from(recipeIds, overviewFrameRecipe),
        );
        stats.streamRecords += records.length / 5;
        stats.streamCommands += tokens.length;
        stats.streamUniqueRecipes += recipeIds.length;
        stats.peakStreamOutputBytes = Math.max(
          stats.peakStreamOutputBytes,
          outputBytes,
        );
        stats.phaseMilliseconds.planning += performance.now() - started;
        return {
          compactTerrain: { records, stride: 5, frames, recipeIds },
          commandStream: { tokens, objects },
        };
      },
    };
  };
  return {
    stats,
    get frameStream() {
      return frameStream;
    },
    get liquidCandidates() {
      return liquidCandidates;
    },
    plan(
      region,
      { revealInvisible = false, liquids, overviewFrameStream = false } = {},
    ) {
      if (disposed) throw new Error("Terrain WASM planner is disposed");
      liquidCandidates = null;
      frameStream = null;
      generation++;
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
      // The ordinary liquid pass reads local/context cells. Context regions
      // retain the reference path; world-reader-dependent special cases also
      // remain reference candidates in this conservative classifier.
      const classifyLiquids = liquids?.enabled === true && !region.context;
      const liquidPointer = classifyLiquids
        ? e.overview_prepare_liquids() >>> 0
        : 0;
      if (classifyLiquids && !liquidPointer)
        throw new Error("Liquid WASM workspace allocation failed");
      const streamPointer =
        overviewFrameStream && !region.context
          ? e.overview_prepare_stream() >>> 0
          : 0;
      if (overviewFrameStream && !region.context && !streamPointer)
        throw new Error("Terrain WASM stream allocation failed");
      recordWorkingBytes();
      const input = new Uint32Array(e.memory.buffer, pointer, count * 2);
      const liquidInput = classifyLiquids
        ? new Uint32Array(e.memory.buffer, liquidPointer, count)
        : null;
      const streamInput = streamPointer
        ? new Uint32Array(e.memory.buffer, streamPointer, count * 2)
        : null;
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
        if (liquidInput) liquidInput[i] = liquidMetadata(t, type);
        if (streamInput) {
          streamInput[i * 2] = streamMetadata(t);
          streamInput[i * 2 + 1] =
            (t?.paint === 31 ? 31 : 0) | (t?.wallPaint === 31 ? 31 << 8 : 0);
        }
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
      if (classifyLiquids) {
        if (
          e.overview_plan_liquids() !== 0 ||
          e.overview_liquid_output_len() > count
        )
          throw new Error("Liquid WASM classification failed");
        liquidCandidates = new Uint32Array(
          e.memory.buffer,
          e.overview_liquid_output_ptr() >>> 0,
          e.overview_liquid_output_len(),
        );
        if (streamPointer) liquidCandidates = liquidCandidates.slice();
        stats.liquidRegions++;
        stats.liquidCandidateCells += liquidCandidates.length;
        stats.liquidFastCells += e.overview_liquid_fast_count();
      }
      stats.phaseMilliseconds.planning += performance.now() - packed;
      recordWorkingBytes();
      if (streamPointer) frameStream = createStream(h, generation);
      stats.regions++;
      stats.cells += count;
      // Borrowed only until the next call; planOverviewBand consumes it
      // synchronously and never stores it in the returned compact plan.
      const masks = new Uint8Array(
        e.memory.buffer,
        e.overview_output_ptr() >>> 0,
        count * 2,
      );
      return streamPointer ? masks.slice() : masks;
    },
    dispose() {
      if (!disposed) e.overview_release();
      disposed = true;
      frameStream = null;
      generation++;
      liquidCandidates = null;
    },
  };
}
