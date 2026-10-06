import test from "node:test";
import assert from "node:assert/strict";
import { createMixedHalfbrickLiquidSampler } from "../core/liquid-mixed-halfbrick.mjs";
import { createVisibleLiquidSampler } from "../core/liquid-visible-level.mjs";
import { isSolidOrSlopedTile } from "../core/tile-solidity.mjs";
const empty = () => ({ active: false, liquid: 0, shape: 0 });
const solid = (shape = 0, extra = {}) => ({
  active: true,
  type: 1,
  liquid: 0,
  shape,
  ...extra,
});
const wet = (kind, amount = 255, extra = {}) => ({
  ...empty(),
  liquid: amount,
  liquidKind: kind,
  ...extra,
});
function make(overrides = {}, options = {}) {
  const tiles = { "100,200": solid(1), ...overrides },
    get = (x, y) => tiles[`${x},${y}`] ?? solid();
  const region = {
    rect: { x: 100, y: 200, width: 1, height: 1 },
    cells: [tiles["100,200"]],
    getWorldTile: get,
  };
  return {
    region,
    tiles,
    sample: createMixedHalfbrickLiquidSampler(region, {
      worldSurface: 100,
      layer: "foreground",
      ...options,
    }),
  };
}
const sample = (o, p) => make(o, p).sample(100, 200);

test("directional east honey overwrites west lava rather than generic liquid priority", () => {
  const r = sample({ "99,200": wet(2), "101,200": wet(3) });
  assert.equal(r.supported, true);
  assert.equal(r.primaryTexture, 11);
  assert.deepEqual(r.requiredAssets, ["Liquid_11.png"]);
  assert.equal(r.commands[0].opacity, 1);
  assert.equal(r.commands[0].liquidLevel, 0);
  assert.equal(
    sample({ "99,200": wet(3), "101,200": wet(2) }).primaryTexture,
    1,
  );
});

test("north and even a low south amount retain directional material precedence", () => {
  const north = sample({ "99,200": wet(2), "100,199": wet(3) });
  assert.equal(north.primaryTexture, 11);
  const south = sample({ "99,200": wet(3), "100,201": wet(2, 1) });
  assert.equal(south.primaryTexture, 1);
  assert.equal(south.commands[0].sh, 16);
});

test("diagonal mixed kinds do not leak into source behind-halfbrick selection", () => {
  const r = sample({ "101,200": wet(3), "99,201": wet(2) });
  assert.equal(r.primaryTexture, 11);
  assert.deepEqual(r.requiredAssets, ["Liquid_11.png"]);
});

test("water presence adds its source layer using primary lava opacity then zeroes inactive primary", () => {
  const r = sample({ "101,200": wet(2), "100,201": wet(1) });
  assert.equal(r.waterPresent, true);
  assert.equal(r.primaryTexture, 1);
  assert.deepEqual(r.layerDecisions, [
    { texture: 0, bottomByte: 255, role: "additional-water", emitted: true },
    { texture: 1, bottomByte: 0, role: "directional-primary", emitted: false },
  ]);
  assert.deepEqual(r.requiredAssets, ["Liquid_0.png"]);
  assert.equal(r.commands[0].opacity, 1);
  const transparent = sample(
    { "101,200": wet(2), "100,201": wet(1) },
    { lavaOpacity: 0.5 },
  );
  assert.equal(transparent.commands[0].opacity, 127 / 255);
});

test("explicit frozen alpha vector applies sequential byte quantization and source layer order", () => {
  const alpha = Array(15).fill(0);
  alpha[3] = 0.2;
  alpha[1] = 0.5;
  const r = sample(
    { "101,200": wet(2), "100,201": wet(1) },
    { waterStyle: 3, liquidStyleAlpha: alpha, lavaOpacity: 0.5 },
  );
  assert.deepEqual(
    r.commands.map((c) => [c.asset, c.opacity]),
    [
      ["Liquid_3.png", 127 / 255],
      ["Liquid_1.png", 63 / 255],
    ],
  );
  alpha[1] = 1;
  assert.equal(r.liquidStyleAlpha[1], 0.5);
});

test("wet north still produces unchanged normal upper-half geometry when a diagonal is mixed", () => {
  const { region, sample: run } = make({
    "100,199": wet(1),
    "101,201": wet(2),
  });
  const r = run(100, 200),
    normal = createVisibleLiquidSampler(region, {
      worldSurface: 100,
      layer: "foreground",
      isSolid: isSolidOrSlopedTile,
    })(100, 200);
  assert.equal(r.commands.length, 13);
  assert.equal(r.gradientRows, 12);
  assert.equal(r.primaryTexture, 0);
  assert.equal(r.normalDrawn, true);
  assert.deepEqual(r.commands.at(-1), normal.command);
  assert.equal(r.commands[0].opacity, (127 / 255) * (0.5 / 12));
});

test("sixteen-row mixed gradients preserve PointClamp and separate layer byte factors", () => {
  const alpha = Array(15).fill(0);
  alpha[0] = 1;
  alpha[1] = 0.5;
  const r = sample(
    { "100,199": wet(1), "101,200": wet(2) },
    { liquidStyleAlpha: alpha },
  );
  const behind = r.commands.filter((c) => c.drawBeforeTiles);
  assert.equal(behind.length, 32);
  assert.equal(r.clampedRows, 8);
  for (let i = 0; i < 16; i++) {
    assert.equal(behind[i].sy, Math.min(15, 4 + i));
    assert.equal(behind[i].opacity, (i + 0.5) / 16);
    assert.equal(behind[16 + i].opacity, ((127 / 255) * (i + 0.5)) / 16);
  }
  assert.equal(r.normalDrawn, true);
});

test("registered waterfalls suppress only the behind pass; excluded registrations retain it", () => {
  const o = { "99,200": empty(), "101,200": wet(3), "99,201": wet(2) };
  assert.equal(sample(o).reason, "mixed-halfbrick-waterfall-state-required");
  const yes = sample(o, { waterfallRegistry: { hasOrigin: () => true } });
  assert.equal(yes.supported, true);
  assert.deepEqual(yes.commands, []);
  assert.equal(yes.waterfallDecision, "registered-suppress-behind");
  const no = sample(o, { waterfallRegistry: { hasOrigin: () => false } });
  assert.equal(no.commands[0].asset, "Liquid_11.png");
  assert.equal(no.waterfallDecision, "snapshot-not-registered");
  assert.equal(
    sample(o, { waterfallRegistry: { hasOrigin: () => undefined } }).reason,
    "mixed-halfbrick-waterfall-state-required",
  );
  const withNorth = sample(
    { ...o, "100,199": wet(1) },
    { waterfallRegistry: { hasOrigin: () => true } },
  );
  assert.equal(withNorth.normalDrawn, true);
  assert.ok(withNorth.commands.every((c) => !c.drawBeforeTiles));
});

test("wall-suppressed behind layer still keeps original normal sampling", () => {
  const r = sample({
    "100,200": solid(1, { wall: 2 }),
    "100,199": wet(1),
    "101,201": wet(2),
  });
  assert.equal(r.commands.length, 1);
  assert.equal(r.normalDrawn, true);
  assert.equal(r.commands[0].drawBeforeTiles, undefined);
});

test("ordinary single-kind, wet targets, shimmer, special and unknown contexts remain explicit failures", () => {
  assert.equal(
    sample({ "99,200": wet(1) }).reason,
    "mixed-halfbrick-mixed-context-required",
  );
  assert.equal(
    sample({ "100,200": solid(1, { liquid: 1, liquidKind: 1 }) }).reason,
    "mixed-halfbrick-dry-active-shape-required",
  );
  assert.equal(
    sample({ "99,200": wet(4), "101,200": wet(2) }).reason,
    "mixed-halfbrick-shimmer-context",
  );
  assert.equal(
    sample({ "99,200": wet(1), "101,200": wet(2, 256) }).reason,
    "mixed-halfbrick-invalid-record",
  );
  assert.equal(
    sample({
      "99,200": wet(1),
      "101,200": wet(2),
      "101,199": solid(0, { type: 379 }),
    }).reason,
    "mixed-halfbrick-special-context",
  );
  assert.equal(
    sample({
      "99,200": wet(1),
      "101,200": wet(2),
      "101,199": solid(0, { type: 10000 }),
    }).reason,
    "mixed-halfbrick-unknown-solidity",
  );
});

test("missing normal dependency discards prepared behind layers and preserves all input records", () => {
  const { region, tiles } = make({ "100,199": wet(1), "101,201": wet(2) });
  const before = JSON.stringify(tiles);
  const get = region.getWorldTile;
  region.getWorldTile = (x, y) => (y === 198 ? null : get(x, y));
  const r = createMixedHalfbrickLiquidSampler(region, { worldSurface: 100 })(
    100,
    200,
  );
  assert.equal(r.supported, false);
  assert.equal(r.commands, undefined);
  assert.equal(JSON.stringify(tiles), before);
});
