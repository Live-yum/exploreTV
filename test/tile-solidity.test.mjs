import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTileSolidity,
  isSolidOrSlopedTile,
  SOURCE_TILE_COUNT,
  SOURCE_SOLID_TILE_TYPES,
  SOURCE_SOLID_TOP_TILE_TYPES,
  SOURCE_PLATFORM_TILE_TYPES,
} from "../core/tile-solidity.mjs";
import { planLiquids } from "../core/liquid.mjs";

test("complete pinned initialization accounts for all 754 vanilla IDs", () => {
  assert.equal(SOURCE_TILE_COUNT, 754);
  assert.equal(SOURCE_SOLID_TILE_TYPES.length, 324);
  assert.equal(SOURCE_SOLID_TOP_TILE_TYPES.length, 84);
  assert.equal(SOURCE_PLATFORM_TILE_TYPES.length, 7);
  const counts = { true: 0, false: 0, undefined: 0 };
  for (let type = 0; type < SOURCE_TILE_COUNT; type++)
    counts[classifyTileSolidity(type)]++;
  assert.deepEqual(counts, { true: 314, false: 439, undefined: 1 });
  for (const list of [
    SOURCE_SOLID_TILE_TYPES,
    SOURCE_SOLID_TOP_TILE_TYPES,
    SOURCE_PLATFORM_TILE_TYPES,
  ]) {
    assert.ok(Object.isFrozen(list));
    assert.equal(new Set(list).size, list.length);
    assert.deepEqual(
      [...list].sort((a, b) => a - b),
      list,
    );
  }
});

test("all three initialization ranges include both endpoints and preserve neighboring defaults", () => {
  for (const [start, end] of [
    [255, 268],
    [727, 732],
  ]) {
    for (let type = start; type <= end; type++)
      assert.equal(classifyTileSolidity(type), true, String(type));
  }
  for (const type of [254, 269, 733, 751, 752, 753])
    assert.equal(classifyTileSolidity(type), false, String(type));
  for (let type = 435; type <= 439; type++) {
    assert.equal(classifyTileSolidity(type), false);
    assert.equal(classifyTileSolidity(type, { includePlatforms: true }), true);
  }
});

test("closed doors and rolling cactus retain collision solidity independently of texture support", () => {
  for (const type of [10, 127, 130, 137, 138, 484, 664, 711, 716])
    assert.equal(classifyTileSolidity(type), true, String(type));
  for (const type of [3, 4, 5, 11, 12, 13, 51, 110, 128, 213, 518, 634])
    assert.equal(classifyTileSolidity(type), false, String(type));
});

test("solidTop is broader than platforms and remains excluded for liquid geometry", () => {
  assert.deepEqual(
    SOURCE_SOLID_TILE_TYPES.filter((type) =>
      SOURCE_SOLID_TOP_TILE_TYPES.includes(type),
    ),
    [19, 239, 380, 427, 435, 436, 437, 438, 439],
  );
  for (const type of [14, 16, 18, 19, 239, 275, 376, 380, 710])
    assert.equal(classifyTileSolidity(type), false, String(type));
  for (const type of SOURCE_PLATFORM_TILE_TYPES)
    assert.equal(classifyTileSolidity(type, { includePlatforms: true }), true);
  for (const type of [239, 380])
    assert.equal(classifyTileSolidity(type, { includePlatforms: true }), false);
  assert.equal(classifyTileSolidity(19, { includePlatforms: "yes" }), false);
  assert.equal(classifyTileSolidity(19, { includePlatforms: null }), false);
});

test("halfbricks and slopes remain solid while actuation and absent active tiles do not", () => {
  for (const shape of [0, 1, 2, 3, 4, 5]) {
    assert.equal(isSolidOrSlopedTile({ active: true, type: 484, shape }), true);
    assert.equal(
      isSolidOrSlopedTile({ active: true, type: 484, shape, inactive: true }),
      false,
    );
  }
  assert.equal(isSolidOrSlopedTile({ active: false, type: 999 }), false);
  assert.equal(
    isSolidOrSlopedTile({ active: true, type: 379, inactive: true }),
    false,
  );
});

test("runtime active stone and malformed or future IDs are unknown", () => {
  for (const type of [
    379,
    -1,
    754,
    65535,
    1.5,
    NaN,
    Infinity,
    "1",
    null,
    undefined,
  ]) {
    assert.equal(classifyTileSolidity(type), undefined);
    assert.equal(isSolidOrSlopedTile({ active: true, type }), undefined);
  }
  for (const tile of [
    null,
    undefined,
    {},
    { active: "true", type: 1 },
    { active: true, type: 1, inactive: "false" },
  ])
    assert.equal(isSolidOrSlopedTile(tile), undefined);
});

test("liquid planner accepts proved non-solids and occludes rolling cactus without changing cells", () => {
  const wet = { active: false, type: 0, shape: 0, liquid: 255, liquidKind: 1 };
  const neighbors = Array.from({ length: 9 }, () => ({
    active: false,
    shape: 0,
    liquid: 0,
  }));
  neighbors[4] = wet;
  neighbors[1] = { active: true, type: 12, shape: 0, liquid: 0 };
  const region = {
    rect: { x: 10, y: 10, width: 1, height: 1 },
    cells: [wet],
    context: { rect: { x: 9, y: 9, width: 3, height: 3 }, cells: neighbors },
  };
  const before = structuredClone(region);
  assert.equal(
    planLiquids(region, { enabled: true, worldSurface: 300 }).support
      .unsupported,
    1,
  );
  const p = planLiquids(region, {
    enabled: true,
    worldSurface: 300,
    isSolid: isSolidOrSlopedTile,
  });
  assert.equal(p.support.unsupported, 0);
  assert.equal(p.support.drawn, 1);
  assert.deepEqual(region, before);
  const rolling = { ...wet, active: true, type: 484 };
  const solidRegion = { ...region, cells: [rolling] };
  const hidden = planLiquids(solidRegion, {
    enabled: true,
    worldSurface: 300,
    isSolid: isSolidOrSlopedTile,
  });
  assert.equal(hidden.support.skippedSolid, 1);
  assert.equal(hidden.commands.length, 0);
});
