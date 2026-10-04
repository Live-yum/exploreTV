import test from "node:test";
import assert from "node:assert/strict";
import { planLiquids } from "../core/liquid.mjs";
const empty = () => ({ active: false, liquid: 0, shape: 0 });
const wet = (liquid = 255, liquidKind = 1, extra = {}) => ({
  ...empty(),
  liquid,
  liquidKind,
  ...extra,
});
const region = (cells, width = 1, height = cells.length, x = 0, y = 0) => ({
  rect: { x, y, width, height },
  cells,
});
const opts = { enabled: true, worldSurface: 100, isSolid: (t) => t.type === 1 };
test("disabled by default and inputs remain untouched", () => {
  const r = region([Object.freeze(wet())]);
  Object.freeze(r.cells);
  assert.deepEqual(planLiquids(r).commands, []);
  const before = JSON.stringify(r);
  planLiquids(r, opts);
  assert.equal(JSON.stringify(r), before);
});
test("storage kinds map to modern texture assets and shimmer is explicitly skipped", () => {
  for (const [kind, asset] of [
    [1, "water_0.png"],
    [2, "water_1.png"],
    [3, "water_11.png"],
  ]) {
    const p = planLiquids(region([wet(255, kind)]), opts);
    assert.equal(p.commands[0].asset, asset);
    assert.deepEqual(p.requiredAssets, [asset]);
  }
  const p = planLiquids(region([wet(255, 4)], 1, 1, 30, 40), opts);
  assert.deepEqual(p.commands, []);
  assert.deepEqual(p.support.unsupportedCoordinates, [
    { x: 30, y: 40, reason: "shimmer" },
  ]);
});
test("flat byte fill is deterministic and explicitly approximate", () => {
  for (const [level, h] of [
    [1, 1],
    [127, 8],
    [128, 9],
    [255, 16],
  ]) {
    const c = planLiquids(region([wet(level)]), opts).commands[0];
    assert.deepEqual([c.sh, c.dh, c.dy], [h, h, 16 - h]);
    assert.equal(c.fidelity, "flat-fill-approximation");
  }
});
test("column-major cells use selected-local coordinates", () => {
  const p = planLiquids(
    region([empty(), wet(), wet(), empty()], 2, 2, 99, 101),
    opts,
  );
  assert.deepEqual(
    p.commands.map((c) => [c.dx, c.dy, c.worldX, c.worldY]),
    [
      [0, 16, 99, 102],
      [16, 0, 100, 101],
    ],
  );
});
test("context determines topology without emitting outside selection", () => {
  const r = region([wet()], 1, 1, 1, 1);
  r.context = region(
    Array.from({ length: 9 }, () => wet()),
    3,
    3,
  );
  const p = planLiquids(r, { ...opts, waterfallFrame: 3 });
  assert.equal(p.commands.length, 1);
  assert.equal(p.commands[0].sy, 48 + 240);
  assert.equal(p.support.missingContextCells, 0);
});
test("side atlas uses normal animation and central atlas uses waterfall clock", () => {
  const r = region([wet(), wet()], 2, 1);
  const p = planLiquids(r, { ...opts, frame: 2, waterfallFrame: 7 });
  assert.deepEqual(
    p.commands.map((c) => [c.sx, c.sy]),
    [
      [0, 160],
      [32, 160],
    ],
  );
  assert.equal(
    planLiquids(region([wet()]), { ...opts, frame: 2, waterfallFrame: 7 })
      .commands[0].sy,
    16 + 560,
  );
});
test("surface row uses fixed atlas Y and source metadata fallback", () => {
  const r = region([wet()], 1, 1, 1, 100);
  r.context = region(
    [empty(), wet(), empty(), wet(), empty(), wet()],
    3,
    2,
    0,
    99,
  );
  r.source = { worldSurface: 100 };
  const p = planLiquids(r, { enabled: true, waterfallFrame: 3 });
  assert.equal(p.commands[0].sy, 1280);
  assert.equal(p.support.worldSurfaceKnown, true);
  assert.ok(
    planLiquids(region([wet()]), { enabled: true }).warnings.some((w) =>
      w.includes("worldSurface"),
    ),
  );
});
test("front/background opacity is explicit; style and alpha validated", () => {
  const r = region([wet(255, 2)]);
  assert.equal(
    planLiquids(r, { ...opts, lavaOpacity: 0.5 }).commands[0].opacity,
    0.5,
  );
  assert.equal(
    planLiquids(r, { ...opts, lavaOpacity: 0.5, layer: "foreground" })
      .commands[0].opacity,
    0.475,
  );
  assert.equal(
    planLiquids(region([wet()]), { ...opts, waterStyle: 13 }).commands[0].asset,
    "water_13.png",
  );
  assert.throws(() => planLiquids(r, { ...opts, waterStyle: 11 }), RangeError);
});
test("shapes, special neighbors, unknown solids, and mixed liquids are counted", () => {
  for (const [extra, reason] of [
    [{ active: true, shape: 1 }, "halfbrick-neighborhood"],
    [{ active: true, shape: 2 }, "slope-neighborhood"],
    [{ active: true, type: 518 }, "special-tile-neighborhood"],
  ]) {
    assert.equal(
      planLiquids(region([wet(255, 1, extra)]), opts).support
        .unsupportedByReason[reason],
      1,
    );
  }
  assert.equal(
    planLiquids(region([wet(255, 1, { active: true, type: 777 })]), {
      enabled: true,
    }).support.unsupported,
    1,
  );
  assert.equal(
    planLiquids(region([wet(), wet(255, 2)]), opts).support.unsupportedByReason[
      "mixed-liquid-neighborhood"
    ],
    2,
  );
  assert.equal(
    planLiquids(region([wet(255, 1, { active: true, type: 1 })]), opts).support
      .skippedSolid,
    1,
  );
});
test("actuated solids do not occlude and platform is not assumed solid", () => {
  assert.equal(
    planLiquids(
      region([wet(255, 1, { active: true, type: 1, inactive: true })]),
      opts,
    ).support.drawn,
    1,
  );
  assert.equal(
    planLiquids(region([wet(255, 1, { active: true, type: 19 })]), {
      enabled: true,
    }).support.drawn,
    1,
  );
});
