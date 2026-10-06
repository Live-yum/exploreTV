import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { planScene, planOverviewBand } from "../core/renderer.mjs";
import { materializeOverviewCommand } from "../core/overview-command-buffer.mjs";
import { createOverviewTerrainPlanner } from "../core/overview-wasm.mjs";
import { createNodeOverviewTerrainPlanner } from "../scripts/overview-terrain-wasm.mjs";

const wasmBytes = readFileSync(
  new URL("../wasm-core/dist/exploretv_wld_core.wasm", import.meta.url),
);
const module = new WebAssembly.Module(wasmBytes);
const neighbors = [
  [0, -1, 1],
  [-1, 0, 2],
  [1, 0, 4],
  [0, 1, 8],
];
const centerVariants = [
  [2, 0, 0],
  [0, 1, 4],
  [0, 3, 0],
];

function tile(extra = {}) {
  return {
    active: true,
    type: 1,
    wall: 1,
    shape: 0,
    frameX: null,
    frameY: null,
    liquid: 0,
    liquidKind: 0,
    ...extra,
  };
}

function region(width = 3, height = 3, x = 0, y = 0) {
  return {
    rect: { x, y, width, height },
    source: { width: 8400, height: 2400, worldSurface: 649 },
    version: 315,
    cells: Array.from({ length: width * height }, () => tile()),
  };
}

function publicPlan(plan) {
  const { compactTerrain, planningMilliseconds, ...rest } = plan;
  return {
    ...rest,
    commands: plan.commands.map((command) =>
      materializeOverviewCommand(plan, command),
    ),
  };
}

function equivalent(planner, input, options = {}, expectWasm = true) {
  const frames = planner.plan(input, options);
  if (expectWasm) assert.ok(frames instanceof Uint8Array);
  else assert.equal(frames, null);
  let expected;
  try {
    expected = planScene(input, options);
  } catch (error) {
    if (expectWasm) throw error;
    assert.throws(() => planOverviewBand(input, options), {
      name: error.name,
      message: error.message,
    });
    return { frames, error };
  }
  const actual = planOverviewBand(input, {
    ...options,
    ...(frames ? { overviewTerrainFrames: frames } : {}),
  });
  assert.deepEqual(publicPlan(actual), expected);
  return { frames, actual, expected };
}

test("actual WASM terrain masks match all 16 reference adjacencies and ordinary shapes", () => {
  const planner = createOverviewTerrainPlanner(module);
  try {
    for (const type of [0, 1, 404])
      for (let shape = 0; shape <= 5; shape++)
        for (let mask = 0; mask < 16; mask++) {
          const input = region();
          input.cells = input.cells.map(() =>
            tile({ active: false, wall: 0, type }),
          );
          input.cells[4] = tile({ type, shape, paint: 26, wallPaint: 31 });
          for (const [dx, dy, bit] of neighbors)
            if (mask & bit)
              input.cells[(1 + dx) * 3 + 1 + dy] = tile({
                type,
                wall: bit + 1,
              });
          const { frames } = equivalent(planner, input, { paintEnabled: true });
          assert.equal(frames[9], mask);
          assert.equal(frames[8], mask === 15 ? 16 : mask);
        }
  } finally {
    planner.dispose();
  }
});

test("actual WASM walls preserve every 3x3 center variation and signed world origins", () => {
  const planner = createOverviewTerrainPlanner(module);
  try {
    for (const offset of [0, -6, 8400])
      for (let x = 0; x < 3; x++)
        for (let y = 0; y < 3; y++) {
          const input = region(3, 3, offset + x, offset + y);
          input.cells[4].wall = 65535;
          const { frames } = equivalent(planner, input);
          assert.equal(
            frames[8],
            15 + centerVariants[(x + 1) % 3][(y + 1) % 3],
          );
        }
  } finally {
    planner.dispose();
  }
});

test("region boundaries ignore extra world accessors and preserve visibility and identity", () => {
  const planner = createOverviewTerrainPlanner(module);
  try {
    for (const [width, height] of [
      [1, 1],
      [1, 5],
      [5, 1],
      [2, 3],
      [5, 4],
    ]) {
      const input = region(width, height, -2, -1);
      input.getWorldTile = () => tile();
      for (let i = 0; i < input.cells.length; i++)
        Object.assign(input.cells[i], {
          invisibleBlock: i % 3 === 0,
          invisibleWall: i % 4 === 0,
          wall: i % 5 === 0 ? 318 : i % 2 ? 1 : 65535,
          inactive: i % 2 === 0,
          type: i % 5 === 0 ? 0 : 1,
        });
      for (const revealInvisible of [false, true])
        for (const options of [
          {},
          { tiles: false },
          { walls: false },
          { tiles: false, walls: false },
        ])
          equivalent(planner, input, { ...options, revealInvisible });
    }
    const input = region();
    input.cells[3] = tile({ invisibleBlock: true, wall: 318 });
    input.cells[1] = tile({
      inactive: true,
      shape: 3,
      wall: 9,
      invisibleWall: true,
    });
    input.cells[7] = tile({ type: 0, wall: 65535 });
    input.cells[5] = tile({ active: false, wall: 0 });
    for (const revealInvisible of [false, true]) {
      const { frames } = equivalent(planner, input, { revealInvisible });
      assert.equal(frames[9], revealInvisible ? 3 : 2);
      assert.equal(frames[8], revealInvisible ? 7 : 4);
    }
  } finally {
    planner.dispose();
  }
});

test("WASM and compact planning preserve crops, stored frames and fallback diagnostics", () => {
  const planner = createOverviewTerrainPlanner(module);
  try {
    const input = region(12, 10, 100, 200);
    input.cells[4 * 10 + 4] = tile({ type: 4, frameX: 0, frameY: 0 });
    input.cells[5 * 10 + 4] = tile({ type: 1, frameX: 18, frameY: 18 });
    input.cells[6 * 10 + 4] = tile({ shape: 2, paint: 26, wallPaint: 2 });
    input.cells[7 * 10 + 4] = tile({ shape: 6 });
    for (const options of [
      { paintEnabled: true },
      { outputBounds: { x: 48, y: 48, width: 64, height: 48 } },
      { emissionCore: { x: 103, y: 203, width: 4, height: 3 } },
      {
        emissionCore: { x: 103, y: 203, width: 4, height: 3 },
        outputBounds: { x: 16, y: 16, width: 32, height: 48 },
      },
    ])
      equivalent(planner, input, options);

    for (const extra of [
      { active: true, type: undefined },
      { active: true, type: null },
      { type: "0" },
      { type: 0.5 },
      { type: -1 },
      { type: 65536 },
      { type: NaN },
      { wall: "318" },
      { wall: -1 },
      { wall: 1.5 },
      { wall: 65536 },
    ]) {
      const invalid = region();
      invalid.cells[4].type = 0;
      invalid.cells[3] = tile(extra);
      equivalent(planner, invalid, {}, false);
    }
    for (const value of [null, undefined]) {
      const sparse = region();
      sparse.cells[3] = value;
      equivalent(planner, sparse);
    }
  } finally {
    planner.dispose();
  }
});

test("ambiguous region values retain JavaScript fallback instead of numeric coercion", () => {
  const planner = createOverviewTerrainPlanner(module);
  try {
    for (const [width, height, x, y] of [
      [3, 3, "1", 0],
      [3, 3, 0, 0.5],
      [3, 3, Number.MAX_SAFE_INTEGER, 0],
      [2, 3, Number.MAX_SAFE_INTEGER, 0],
      [3, 2, 0, Number.MAX_SAFE_INTEGER],
    ])
      equivalent(planner, region(width, height, x, y), {}, false);
    for (const invalid of [
      null,
      {},
      { rect: { width: 1, height: 1 }, cells: [] },
      { rect: { width: "1", height: 1 }, cells: [tile()] },
      {
        rect: { width: 513, height: 1 },
        cells: Array.from({ length: 513 }, tile),
      },
    ]) {
      assert.equal(planner.plan(invalid), null);
      assert.throws(
        () => planScene(invalid),
        /Invalid or oversized scene region/,
      );
    }
  } finally {
    planner.dispose();
  }
});

test("WASM workspace stays bounded, returns borrowed views and isolates renderer instances", () => {
  const first = createOverviewTerrainPlanner(module),
    second = createOverviewTerrainPlanner(module);
  try {
    const small = region(),
      initial = equivalent(first, small),
      materialized = publicPlan(initial.actual),
      secondView = second.plan(small),
      secondCopy = secondView.slice();
    assert.notEqual(initial.frames.buffer, secondView.buffer);
    const large = region(512, 128);
    large.cells[large.cells.length - 1].type = "1";
    assert.equal(first.plan(large), null);
    assert.equal(
      first.stats.peakWorkingBytes,
      65536 * 10,
      "Validation fallback still reports the workspace already allocated",
    );
    large.cells[large.cells.length - 1].type = 1;
    const output = first.plan(large);
    assert.equal(output.length, 65536 * 2);
    assert.equal(first.stats.peakWorkingBytes, 65536 * 10);
    assert.ok(first.stats.peakLinearMemoryBytes < 4 * 1024 * 1024);
    assert.deepEqual(
      publicPlan(initial.actual),
      materialized,
      "Compact plans retain no borrowed WASM output",
    );
    assert.deepEqual(
      secondView,
      secondCopy,
      "Different renderers do not share mutable linear memory",
    );
    assert.equal(first.plan(region(512, 129)), null);
    equivalent(first, small);
    first.dispose();
    first.dispose();
    assert.throws(() => first.plan(small), /disposed/);
    equivalent(second, small);
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("actual ABI rejects oversized workspaces and stale output after failed preparation", () => {
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const e = new WebAssembly.Instance(module, {}).exports;
  assert.equal(e.overview_abi_version(), 1);
  assert.equal(e.overview_plan(0, 0, 0), 1);
  assert.equal(e.overview_output_len(), 0);
  assert.ok(e.overview_prepare(3, 3) > 0);
  assert.equal(e.overview_plan(0, 0, 0), 0);
  assert.equal(e.overview_output_len(), 18);
  for (const [width, height] of [
    [0, 1],
    [513, 1],
    [512, 129],
    [0xffffffff, 0xffffffff],
  ]) {
    assert.equal(e.overview_prepare(width, height), 0);
    assert.equal(e.overview_output_len(), 0);
    assert.equal(e.overview_plan(0, 0, 0), 1);
  }
  assert.ok(e.overview_prepare(3, 3) > 0);
  assert.equal(e.overview_plan(3, 0, 0), 1);
  assert.equal(e.overview_output_len(), 0);
  assert.equal(e.overview_plan(0, 0, 1), 0);
  assert.equal(e.overview_output_len(), 18);
  assert.throws(() => e.memory.grow(2049), RangeError);
  e.overview_release();
  assert.equal(e.overview_output_len(), 0);
});

test("Node wrapper executes the checked-in WASM with verified build identity", () => {
  const planner = createNodeOverviewTerrainPlanner();
  try {
    assert.equal(planner.stats.available, true, planner.stats.reason);
    assert.equal(
      planner.stats.binarySha256,
      createHash("sha256").update(wasmBytes).digest("hex"),
    );
    assert.equal(planner.stats.build.overviewAbiVersion, 1);
    equivalent(planner, region());
  } finally {
    planner.dispose();
  }
});
