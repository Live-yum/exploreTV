import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  planScene,
  planOverviewBand,
  ORDINARY_BLOCKS,
} from "../core/renderer.mjs";
import { materializeOverviewCommand } from "../core/overview-command-buffer.mjs";
import {
  createOverviewTerrainPlanner,
  OVERVIEW_WASM_MAX_WORKING_BYTES,
} from "../core/overview-wasm.mjs";
import {
  overviewFrameRecipe,
  overviewFrameRecipeId,
  canonicalOverviewFrameRecipeId,
  overviewFrameRecipeIds,
  BLOCK_FRAME,
  WALL_GRID,
} from "../core/overview-frame-recipes.mjs";
const module = new WebAssembly.Module(
  readFileSync(
    new URL("../wasm-core/dist/exploretv_wld_core.wasm", import.meta.url),
  ),
);
const tile = (extra = {}) => ({
  active: true,
  type: 1,
  wall: 2,
  shape: 0,
  paint: 0,
  wallPaint: 0,
  frameX: null,
  frameY: null,
  liquid: 0,
  liquidKind: 0,
  ...extra,
});
const region = (width = 22, height = 18) => ({
  rect: { x: 100, y: 200, width, height },
  source: { width: 8400, height: 2400, worldSurface: 649 },
  cells: Array.from({ length: width * height }, () => tile()),
});
function publicPlan(plan) {
  const { compactTerrain, commandStream, planningMilliseconds, ...rest } = plan;
  const commands = commandStream
    ? Array.from(commandStream.tokens, (token) =>
        token < 0
          ? materializeOverviewCommand(plan, token)
          : commandStream.objects[token],
      )
    : plan.commands.map((token) => materializeOverviewCommand(plan, token));
  return { ...rest, commands };
}
function compare(planner, r, options = {}) {
  const masks = planner.plan(r, { ...options, overviewFrameStream: true });
  const actual = () =>
    planOverviewBand(r, {
      ...options,
      overviewTerrainFrames: masks ?? undefined,
      overviewLiquidCandidates: planner.liquidCandidates ?? undefined,
      overviewFrameStream: planner.frameStream,
    });
  let expected;
  try {
    expected = planScene(r, options);
  } catch (error) {
    assert.throws(actual, { name: error.name, message: error.message });
    return;
  }
  const plan = actual();
  assert.deepEqual(publicPlan(plan), expected);
  return plan;
}
test("frame recipe IDs enumerate bounded immutable terrain and share only identity pixels", () => {
  const ids = [
    ...overviewFrameRecipeIds({ wallTypes: [1, 65535], paintIds: [0, 31] }),
  ];
  assert.equal(ids.length, ORDINARY_BLOCKS.length * 16 * 6 * 2 + 2 * 20 * 2);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    const frame = overviewFrameRecipe(id),
      canonical = overviewFrameRecipe(canonicalOverviewFrameRecipeId(id));
    assert.ok(Object.isFrozen(frame));
    assert.equal(canonical.paintId, 0);
    assert.deepEqual({ ...frame, paintId: 0 }, canonical);
  }
  assert.ok(Object.isFrozen(BLOCK_FRAME) && BLOCK_FRAME.every(Object.isFrozen));
  assert.ok(Object.isFrozen(WALL_GRID) && WALL_GRID.every(Object.isFrozen));
  for (const args of [
    ["tile", 999, 0],
    ["wall", 0, 0],
    ["tile", 1, 16],
    ["tile", 1, 0, 6],
    ["tile", 1, 0, 0, 1],
  ])
    assert.throws(() => overviewFrameRecipeId(...args), RangeError);
});
test("WASM owns records, frame IDs and token order for ordinary owner streams", () => {
  const planner = createOverviewTerrainPlanner(module),
    r = region(148, 68);
  for (let i = 0; i < r.cells.length; i++)
    Object.assign(r.cells[i], {
      type: ORDINARY_BLOCKS[i % ORDINARY_BLOCKS.length],
      shape: i % 6,
      paint: i % 2 ? 31 : 0,
      wallPaint: i % 3 ? 0 : 31,
      wall: (i % 7) + 1,
    });
  const plan = compare(planner, r, {
    paintEnabled: true,
    outputBounds: { x: 160, y: 160, width: 2048, height: 768 },
  });
  assert.equal(plan.commands.length, 0);
  assert.equal(plan.commandStream.objects.length, 0);
  assert.ok(plan.commandStream.tokens.every((t) => t < 0));
  assert.equal(
    plan.compactTerrain.records.length,
    plan.commandStream.tokens.length * 5,
  );
  assert.equal(
    plan.compactTerrain.records.buffer,
    plan.commandStream.tokens.buffer,
  );
  assert.equal(
    plan.compactTerrain.records.buffer,
    plan.compactTerrain.recipeIds.buffer,
  );
  assert.ok(
    planner.stats.streamRecords > 0 && planner.stats.peakStreamOutputBytes > 0,
  );
  assert.ok(planner.stats.peakWorkingBytes < OVERVIEW_WASM_MAX_WORKING_BYTES);
  planner.dispose();
});
test("stream keeps every family, saved frame, paint, noncanonical shape and source diagnostic", () => {
  const planner = createOverviewTerrainPlanner(module);
  for (const saved of [false, true])
    for (const shape of [0, 1, 2, 3, 4, 5, 6, -1, "2", NaN]) {
      const r = region(128, 8);
      r.cells = r.cells.map((_, i) =>
        tile({
          type: i % 755,
          wall: i % 351,
          shape,
          paint: [0, 31, 26, 32, "31"][i % 5],
          wallPaint: [0, 31, 2, 99][i % 4],
          frameX: saved ? 0 : null,
          frameY: saved ? 0 : null,
          wireRed: i % 19 === 0,
          inactive: i % 11 === 0,
          fullbrightWall: i % 23 === 0,
          invisibleBlock: i % 13 === 0,
          invisibleWall: i % 17 === 0,
        }),
      );
      for (const paintEnabled of [false, true])
        compare(planner, r, { paintEnabled });
    }
  planner.dispose();
});
test("stream preserves waterfall and liquid placement around sparse special owners", () => {
  const planner = createOverviewTerrainPlanner(module);
  for (const layer of ["foreground", "background"]) {
    const r = region();
    for (let i = 0; i < r.cells.length; i++)
      if (i % 11 === 0) r.cells[i] = tile({ type: 4, frameX: 0, frameY: 0 });
      else if (i % 13 === 0)
        r.cells[i] = tile({
          active: false,
          wall: 3,
          liquid: 255,
          liquidKind: 1,
        });
      else if (i % 17 === 0) r.cells[i].paint = 26;
    const liquids = {
      enabled: true,
      layer,
      waterfallRegistry: {
        hasOrigin: () => false,
        commandsFor: () => [
          {
            kind: "waterfall",
            asset: "Waterfall_0.png",
            sx: 0,
            sy: 0,
            sw: 16,
            sh: 16,
            dx: 160,
            dy: 144,
            dw: 16,
            dh: 16,
            x: 10,
            y: 9,
          },
        ],
        model: "test",
        scanComplete: true,
        stats: {},
      },
    };
    for (const crop of [
      {},
      { outputBounds: { x: 83, y: 67, width: 99, height: 79 } },
      { emissionCore: { x: 107, y: 206, width: 6, height: 5 } },
    ])
      for (const tiles of [false, true])
        for (const walls of [false, true])
          compare(planner, r, {
            ...crop,
            liquids,
            tiles,
            walls,
            paintEnabled: true,
          });
  }
  planner.dispose();
});
test("stream keeps logical budgets before crop and retained output survives reuse and dispose", () => {
  const planner = createOverviewTerrainPlanner(module),
    r = region();
  for (const maxCommands of [1, 100, 791, 792, 793])
    compare(planner, r, {
      maxCommands,
      outputBounds: { x: 160, y: 160, width: 16, height: 16 },
    });
  const plan = compare(planner, r),
    saved = publicPlan(plan);
  const large = region(512, 128),
    largePlan = compare(planner, large);
  assert.equal(largePlan.commandStream.tokens.length, 131072);
  assert.ok(planner.stats.peakWorkingBytes < OVERVIEW_WASM_MAX_WORKING_BYTES);
  planner.dispose();
  assert.deepEqual(publicPlan(plan), saved);
});

test("raw stream ABI clears failed preparation and rejects unavailable masks and oversized merge input", () => {
  const e = new WebAssembly.Instance(module, {}).exports;
  assert.equal(e.overview_prepare_stream(), 0);
  assert.ok(e.overview_prepare(3, 3));
  assert.ok(e.overview_prepare_stream());
  assert.equal(e.overview_plan(0, 0, 0), 0);
  assert.equal(
    e.overview_plan_stream(
      3,
      -2147483648,
      2147483647,
      -2147483648,
      2147483647,
      -2147483648,
      2147483647,
      -2147483648,
      2147483647,
    ),
    0,
  );
  assert.equal(e.overview_stream_events(131073), 0);
  assert.equal(e.overview_plan(3, 0, 0), 1);
  assert.equal(e.overview_plan_stream(3, 0, 3, 0, 3, 0, 3, 0, 3), 1);
  assert.equal(e.overview_prepare(512, 129), 0);
  for (const name of [
    "records",
    "recipes",
    "wall_fallback",
    "tile_fallback",
    "wall_assets",
    "tile_assets",
    "tokens",
  ])
    assert.equal(e[`overview_stream_${name}_len`](), 0);
  assert.equal(e.overview_prepare_stream(), 0);
  assert.equal(e.overview_stream_merge(0), 1);
});

test("prepared stream rejects reuse after generation changes without invalidating owned plans", () => {
  const planner = createOverviewTerrainPlanner(module),
    r = region();
  planner.plan(r, { overviewFrameStream: true });
  const expired = planner.frameStream;
  planner.plan(r, { overviewFrameStream: false });
  assert.equal(planner.frameStream, null);
  assert.throws(
    () =>
      expired.generate({
        tileBounds: [0, 22, 0, 18],
        wallBounds: [0, 22, 0, 18],
      }),
    /Expired/,
  );
  const plan = compare(planner, r),
    owned = publicPlan(plan);
  assert.throws(() => planner.frameStream.finish([]), /Invalid/);
  planner.dispose();
  assert.deepEqual(publicPlan(plan), owned);
});
