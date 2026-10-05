import test from "node:test";
import assert from "node:assert/strict";
import {
  createStaticWaterfallRegistry,
  waterfallScanBounds,
  classifyTileDrawLayer,
} from "../core/static-waterfalls.mjs";

const empty = Object.freeze({ active: false, shape: 0, liquid: 0 });
const block = (shape = 0, type = 1, extra = {}) =>
  Object.freeze({ active: true, type, shape, liquid: 0, ...extra });
const wet = (amount = 255, kind = 1, extra = {}) =>
  Object.freeze({ ...empty, liquid: amount, liquidKind: kind, ...extra });
const full = { x: 0, y: 0, width: 260, height: 260 };
function build(records = {}, options = {}, dimensions = {}) {
  const world = {
    width: 260,
    height: 260,
    worldSurface: 30,
    getTile: (x, y) => records[`${x},${y}`] ?? empty,
    ...dimensions,
  };
  return createStaticWaterfallRegistry(world, options);
}
function fall(kind = 1, records = {}, options = {}) {
  return build(
    {
      "120,80": block(1),
      "119,80": wet(255, kind),
      "121,90": wet(),
      ...records,
    },
    options,
  );
}
const commands = (r) => r.commandsFor(full);

test("tile draw layers use material solidity and five overrides, including solid-top tiles", () => {
  for (const type of [1, 19, 380, 427, 546, 11, 470, 475, 78, 579])
    assert.equal(classifyTileDrawLayer(type), "solid");
  for (const type of [5, 14, 213])
    assert.equal(classifyTileDrawLayer(type), "non-solid");
  assert.equal(classifyTileDrawLayer(379), undefined);
  assert.equal(classifyTileDrawLayer(999), undefined);
});

test("fresh viewport bounds and quality follow native scan margins", () => {
  assert.deepEqual(
    waterfallScanBounds(
      1000,
      500,
      { x: 200, y: 200, width: 80, height: 40 },
      1,
    ),
    { x: 99, y: 99, width: 283, height: 163, distance: 100 },
  );
  assert.deepEqual(
    waterfallScanBounds(1000, 500, { x: 0, y: 0, width: 80, height: 40 }, 0),
    { x: 1, y: 1, width: 106, height: 61, distance: 25 },
  );
  assert.throws(
    () => waterfallScanBounds(100, 100, { x: 0, y: 0, width: 101, height: 1 }),
    RangeError,
  );
});

test("wet threshold and all raw registration paths are distinct from tile solidity", () => {
  assert.equal(fall(1, { "119,80": wet(160) }).stats.registered, 0);
  assert.equal(fall(1, { "119,80": wet(161) }).stats.registered, 1);
  assert.equal(fall(1, { "120,79": wet(16) }).stats.registered, 0);
  assert.equal(
    fall(1, { "120,79": block(0, 1, { liquid: 255, liquidKind: 1 }) }).stats
      .registered,
    1,
  );
  assert.equal(fall(1, { "121,80": block(2) }).stats.registered, 0);
  assert.equal(fall(1, { "121,80": block(1) }).hasOrigin(120, 80), true);
  assert.equal(
    fall(1, { "120,80": block(1, 1, { inactive: true }) }).hasOrigin(120, 80),
    true,
  );
});

test("registered origin cap uses column-major order shared across output chunks", () => {
  const r = build(
    { "80,80": block(1), "79,80": wet(), "120,80": block(1), "119,80": wet() },
    { maxWaterfalls: 1 },
  );
  assert.equal(r.stats.eligible, 2);
  assert.equal(r.stats.capped, 1);
  assert.equal(r.hasOrigin(80, 80), true);
  assert.equal(r.hasOrigin(120, 80), false);
  assert.equal(r.commandsFor({ x: 120, y: 80, width: 1, height: 1 }).length, 0);
  const zero = fall(1, {}, { quality: 0 });
  assert.equal(zero.stats.registered, 0);
  assert.equal(zero.stats.capped, 1);
});

test("fresh origin kind prioritizes lava, honey, then shimmer across raw neighbors", () => {
  assert.equal(fall(3, { "120,79": wet(0, 2) }).origins[0].type, 1);
  assert.equal(fall(4, { "120,79": wet(0, 3) }).origins[0].type, 14);
  assert.equal(fall(4).origins[0].type, 25);
});

test("waterfall body, initial turn, liquid endpoint and frozen frames retain original crops", () => {
  const r = fall(1, {}, { frame: 3 }),
    c = commands(r);
  assert.equal(r.failures.length, 0);
  assert.deepEqual(
    [c[0].asset, c[0].sx, c[0].sy, c[0].sw, c[0].sh, c[0].flipX],
    ["Waterfall_0.png", 112, 0, 16, 16, true],
  );
  assert.deepEqual([c[1].sx, c[1].sy, c[1].sw, c[1].sh], [96, 0, 16, 16]);
  assert.deepEqual(
    [c[2].sx, c[2].sy, c[2].sw, c[2].sh, c[2].dx, c[2].dy],
    [96, 24, 32, 16, 120 * 16, 81 * 16],
  );
  assert.equal(r.originPlans[0].reason, "liquid-end");
  assert.equal(c.at(-1).sh, 1);
  assert.equal(c.at(-1).worldY, 90);
  for (const cmd of c) assert.equal(cmd.opacity, 153 / 255);
});

test("left flow mirrors horizontal geometry and uses the other continuation overhang", () => {
  const r = build({ "120,80": block(1), "121,80": wet(), "119,90": wet() });
  const c = commands(r);
  assert.equal(c[0].flipX, undefined);
  assert.equal(c[1].worldX, 119);
  assert.equal(c[2].dx, 119 * 16);
  assert.equal(c[2].sw, 32);
});

test("water, lava, honey and style mapping use different alpha and clock rules", () => {
  const water = commands(
    fall(1, {}, { waterStyle: 12, frame: 2, slowFrame: 7 }),
  )[0];
  const lava = commands(fall(2, {}, { frame: 2, slowFrame: 7 }))[0];
  const honey = commands(fall(3, {}, { frame: 2, slowFrame: 7 }))[0];
  assert.equal(water.asset, "Waterfall_23.png");
  assert.equal(water.sx, 80);
  assert.equal(water.opacity, 153 / 255);
  assert.equal(lava.asset, "Waterfall_1.png");
  assert.equal(lava.sx, 240);
  assert.equal(lava.opacity, 1);
  assert.equal(honey.asset, "Waterfall_14.png");
  assert.equal(honey.opacity, 204 / 255);
  const surface = build({
    "120,10": block(1),
    "119,10": wet(),
    "121,20": wet(),
  });
  assert.equal(commands(surface)[0].opacity, 1);
});

test("slope descent emits eight original two-pixel atlas strips and turn geometry", () => {
  for (const shape of [2, 3]) {
    const r = fall(1, {
      "121,81": block(shape),
      "122,83": wet(),
      "120,83": wet(),
    });
    const strips = commands(r).filter(
      (c) => c.worldX === 121 && c.worldY === 80 && c.sw === 2,
    );
    assert.equal(strips.length, 8);
    assert.ok(strips.every((c) => c.sh === 8 && c.flipX));
    assert.deepEqual(
      strips.map((c) => c.sx),
      shape === 2
        ? [30, 28, 26, 24, 22, 20, 18, 16]
        : [16, 18, 20, 22, 24, 26, 28, 30],
    );
  }
});

test("contact colors, blocking tiles and 546 temporary draw solidity are reconstructed", () => {
  const colored = commands(fall(1, { "121,82": block(0, 262) }));
  assert.ok(colored.some((c) => c.asset === "Waterfall_15.png"));
  const disco = commands(
    fall(1, { "121,82": block(0, 160) }, { discoColor: [2, 128, 255] }),
  );
  assert.ok(
    disco.some(
      (c) => c.asset === "Waterfall_2.png" && c.vertexColor?.[0] === 1,
    ),
  );
  const blocked = commands(fall(1, { "120,80": block(1, 54) }));
  assert.equal(blocked[0].sh, 8);
  const passed = commands(fall(1, { "121,82": block(0, 546) }));
  assert.ok(passed.some((c) => c.worldY === 83));
});

test("origin membership is preserved across an atomic unsupported draw", () => {
  const r = fall(1, { "121,82": block(0, 379) });
  assert.equal(r.hasOrigin(120, 80), true);
  assert.equal(r.failures[0].reason, "waterfall-unknown-solidity");
  assert.deepEqual(commands(r), []);
  const missing = build({}, {}, { getTile: () => null });
  assert.equal(missing.scanComplete, false);
  assert.equal(missing.hasOrigin(120, 80), undefined);
});

test("rain origins honor cloud kinds, parity offsets, two layers and solid landing", () => {
  const r = build({
    "120,80": block(0, 196),
    "120,83": block(),
    "125,80": block(0, 460),
    "125,83": block(),
    "130,80": block(0, 717),
    "130,83": block(),
  });
  assert.deepEqual(
    r.origins.map((o) => [o.x, o.y, o.type]),
    [
      [120, 81, 11],
      [125, 81, 22],
      [130, 81, 26],
    ],
  );
  const c = commands(r),
    rain = c.filter((c) => c.originX === 120);
  assert.equal(rain.length, 6);
  assert.deepEqual(
    [rain[0], rain[3]].map((c) => [c.asset, c.sx, c.dx, c.dy]),
    [
      ["Waterfall_12.png", 36, 1920, 1296],
      ["Waterfall_11.png", 54, 1920, 1296],
    ],
  );
  assert.equal(rain[1].dx, 1921);
  assert.deepEqual(
    rain.map((c) => c.batchLayerStack),
    [0, 0, 0, 1, 1, 1],
  );
  assert.equal(c.filter((c) => c.originX === 125).length, 3);
  assert.ok(
    c.some((c) => c.asset === "Waterfall_26.png" && c.vertexColor?.[3] === 114),
  );
});

test("rain crops accumulate exactly and refuse invalid negative texture geometry", () => {
  const r = build({
    "120,80": block(0, 196),
    "120,82": wet(128),
    "120,83": wet(128),
  });
  assert.equal(r.failures[0].reason, "waterfall-rain-accumulated-crop");
  assert.equal(commands(r).length, 0);
});

test("frozen shimmer retains paired base/sparkle atlas crops and corner colors", () => {
  const c = commands(fall(4));
  assert.ok(c.length > 0);
  assert.equal(c.length % 2, 0);
  for (let i = 0; i < c.length; i += 2) {
    assert.equal(c[i].asset, "Waterfall_25.png");
    assert.equal(c[i + 1].sy, c[i].sy + 42);
    assert.ok(c[i].vertexColors.topLeft);
    assert.ok(c[i + 1].vertexColors.bottomRight);
    assert.equal(c[i].opacity, undefined);
  }
});

test("rectangle queries preserve overhangs, ordering and world-space crops across seams", () => {
  const r = fall(),
    all = commands(r),
    rect = { x: 120, y: 81, width: 1, height: 1 };
  const queried = r.commandsFor(rect);
  assert.ok(queried.some((c) => c.worldX === 121 && c.dx === 0 && c.sw === 32));
  assert.deepEqual(
    queried.map(({ dx, dy, x, y, ...c }) => ({
      ...c,
      dx: dx + rect.x * 16,
      dy: dy + rect.y * 16,
    })),
    all
      .filter(
        (c) =>
          c.dx < 1936 &&
          c.dx + c.dw > 1920 &&
          c.dy < 1312 &&
          c.dy + c.dh > 1296,
      )
      .map(({ x, y, ...c }) => c),
  );
});

test("distance fade, cloud-adjusted bound and all input records remain stable", () => {
  const cells = { "120,80": block(1), "119,80": wet() },
    before = JSON.stringify(cells);
  const r = build(cells),
    c = commands(r);
  assert.equal(r.traversalBound, 100);
  assert.equal(r.originPlans[0].steps, 100);
  assert.ok(c.at(-1).opacity < 0.1);
  assert.equal(JSON.stringify(cells), before);
  const large = build(
    { "120,80": block(1), "119,80": wet(), "122,80": block(0, 189) },
    { viewport: { x: 118, y: 78, width: 10, height: 10 } },
    { width: 16800, height: 260 },
  );
  assert.equal(large.traversalBound, 160);
  assert.equal(large.originPlans[0].steps, 160);
});

test("command and scan budgets fail explicitly without partial origin sprites", () => {
  const r = fall(1, {}, { maxCommands: 2 });
  assert.equal(r.hasOrigin(120, 80), true);
  assert.equal(r.failures[0].reason, "waterfall-command-budget");
  assert.equal(commands(r).length, 0);
  assert.throws(() => fall(1, {}, { maxCommands: 1048577 }), RangeError);
  assert.throws(
    () => build({}, {}, { width: 100000, height: 1000 }),
    /scan exceeds/,
  );
});
