import test from "node:test";
import assert from "node:assert/strict";
import { createHalfbrickLiquidSampler } from "../core/liquid-halfbrick.mjs";
import { createStaticWaterfallRegistry } from "../core/static-waterfalls.mjs";
import { planLiquids } from "../core/liquid.mjs";
import { isSolidOrSlopedTile } from "../core/tile-solidity.mjs";

const empty = Object.freeze({ active: false, type: 0, shape: 0, liquid: 0 });
const block = (shape = 0, extra = {}) =>
  Object.freeze({ active: true, type: 1, shape, liquid: 0, ...extra });
const wet = (liquid = 255, liquidKind = 1, extra = {}) =>
  Object.freeze({ ...empty, liquid, liquidKind, ...extra });
const opts = {
  enabled: true,
  layer: "foreground",
  worldSurface: 30,
  isSolid: isSolidOrSlopedTile,
};
function fixture(overrides = {}) {
  const records = {
    "120,80": block(1),
    "120,79": wet(1),
    "119,80": wet(),
    "121,80": empty,
    ...overrides,
  };
  const solid = block(),
    getTile = (x, y) => records[`${x},${y}`] ?? solid;
  const context = { rect: { x: 119, y: 79, width: 3, height: 3 }, cells: [] };
  for (let x = 119; x <= 121; x++)
    for (let y = 79; y <= 81; y++) context.cells.push(getTile(x, y));
  const region = {
    rect: { x: 120, y: 80, width: 1, height: 1 },
    cells: [records["120,80"]],
    context,
    getWorldTile: getTile,
  };
  return {
    records,
    region,
    world: { width: 260, height: 260, worldSurface: 30, getTile },
  };
}
const sample = (f, waterfallRegistry) =>
  createHalfbrickLiquidSampler(f.region, {
    ...opts,
    ...(waterfallRegistry === undefined ? {} : { waterfallRegistry }),
  })(120, 80);
const normal = (p) => p.commands.filter((c) => !c.drawBeforeTiles);

test("complete registered and capped registries affect only the behind pass", () => {
  const f = fixture(),
    before = JSON.stringify(f.records);
  const complete = createStaticWaterfallRegistry(f.world, {
    maxWaterfalls: 10,
  });
  const capped = createStaticWaterfallRegistry(f.world, { maxWaterfalls: 0 });
  assert.equal(complete.scanComplete, true);
  assert.equal(complete.hasOrigin(120, 80), true);
  assert.equal(capped.scanComplete, true);
  assert.equal(capped.hasOrigin(120, 80), false);
  const yes = sample(f, complete),
    no = sample(f, capped);
  assert.equal(yes.supported, true);
  assert.equal(yes.waterfallDecision, "registered-suppress-behind");
  assert.equal(yes.commands.length, 1);
  assert.equal(yes.normalDrawn, true);
  assert.equal(yes.commands[0].sh, 8);
  assert.ok(yes.commands.every((c) => !c.drawBeforeTiles));
  assert.equal(no.waterfallDecision, "snapshot-not-registered");
  assert.equal(no.commands.filter((c) => c.drawBeforeTiles).length, 16);
  assert.deepEqual(normal(no), yes.commands);
  assert.equal(JSON.stringify(f.records), before);
});

test("incomplete registry cannot be treated as negative membership or replaced by a local fresh guess", () => {
  const f = fixture({ "120,79": wet(16) });
  assert.equal(sample(f).waterfallDecision, "fresh-scan-ineligible");
  const incomplete = createStaticWaterfallRegistry({
    ...f.world,
    getTile: (x, y) => (x === 2 && y === 2 ? null : f.world.getTile(x, y)),
  });
  assert.equal(incomplete.scanComplete, false);
  assert.equal(incomplete.hasOrigin(120, 80), undefined);
  assert.deepEqual(sample(f, incomplete), {
    supported: false,
    reason: "halfbrick-waterfall-state-required",
  });
});

test("authoritative positive membership overrides local ineligibility while still preserving normal geometry", () => {
  const f = fixture({ "120,79": wet(255) });
  const previous = sample(f);
  assert.equal(previous.waterfallDecision, "fresh-scan-ineligible");
  const registered = sample(f, { hasOrigin: () => true });
  assert.equal(registered.waterfallDecision, "registered-suppress-behind");
  assert.deepEqual(registered.commands, normal(previous));
});

test("registry suppression retains normal upper-half for dry/full raw values but does not invent it for partial raw liquid", () => {
  for (const amount of [0, 127, 255]) {
    const f = fixture({
      "120,80": block(1, { liquid: amount, liquidKind: amount ? 1 : 0 }),
    });
    const before = JSON.stringify(f.records);
    const p = sample(f, { hasOrigin: () => true });
    assert.equal(p.normalDrawn, amount !== 127);
    assert.equal(p.commands.length, amount === 127 ? 0 : 1);
    assert.ok(p.commands.every((c) => !c.drawBeforeTiles));
    assert.equal(JSON.stringify(f.records), before);
    assert.equal(f.records["120,80"].liquid, amount);
  }
});

test("source-short-circuited branches do not query a registry whose value cannot affect them", () => {
  const mustNotRead = {
    hasOrigin() {
      throw new Error("Unexpected registry read");
    },
  };
  const noHigh = sample(fixture({ "119,80": wet(160) }), mustNotRead);
  assert.equal(noHigh.supported, true);
  assert.equal(noHigh.waterfallDecision, "no-high-side");
  const walled = sample(
    fixture({ "120,80": block(1, { wall: 1 }) }),
    mustNotRead,
  );
  assert.equal(walled.normalDrawn, true);
  assert.equal(walled.commands.length, 1);
  assert.equal(walled.waterfallDecision, "not-needed");
});

test("registry membership is queried at world coordinates with its receiver and strict tri-state contract", () => {
  const f = fixture();
  const registry = {
    calls: [],
    answer: false,
    hasOrigin(x, y) {
      this.calls.push([x, y]);
      return this.answer;
    },
  };
  assert.equal(sample(f, registry).supported, true);
  assert.deepEqual(registry.calls, [[120, 80]]);
  for (const value of [undefined, null, 0, 1, "false"])
    assert.equal(
      sample(f, { hasOrigin: () => value }).reason,
      "halfbrick-waterfall-state-required",
    );
  assert.throws(() => sample(f, {}), /must provide hasOrigin/);
  assert.equal(sample(f).reason, "halfbrick-waterfall-state-required");
});

test("main planner forwards registry and preserves independent normal-pass accounting", () => {
  const f = fixture();
  const p = planLiquids(f.region, {
    ...opts,
    waterfallRegistry: { hasOrigin: () => true },
  });
  assert.equal(p.support.unsupported, 0);
  assert.equal(p.support.liquidCells, 0);
  assert.equal(p.support.shapeCandidateCells, 1);
  assert.equal(p.support.drawn, 1);
  assert.equal(p.support.visibleLevelDrawn, 1);
  assert.equal(p.commands.length, 1);
  assert.equal(p.commands[0].drawBeforeTiles, undefined);
});

test("mixed halfbrick integration shares the registry and never bypasses incomplete membership", () => {
  const f = fixture({ "121,81": wet(255, 2) });
  const before = JSON.stringify(f.records);
  const yes = planLiquids(f.region, {
    ...opts,
    waterfallRegistry: { hasOrigin: () => true },
  });
  const no = planLiquids(f.region, {
    ...opts,
    waterfallRegistry: { hasOrigin: () => false },
  });
  const missing = planLiquids(f.region, {
    ...opts,
    waterfallRegistry: { hasOrigin: () => undefined },
  });
  assert.equal(yes.support.unsupported, 0);
  assert.equal(yes.support.mixedHalfbrickResolved, 1);
  assert.equal(yes.support.mixedHalfbrickDrawn, 1);
  assert.equal(yes.support.shapeDrawn, 1);
  assert.equal(yes.support.visibleLevelDrawn, 1);
  assert.equal(yes.commands.length, 1);
  assert.deepEqual(normal(no), yes.commands);
  assert.equal(no.support.gradientShapeCells, 1);
  assert.equal(no.support.gradientRows, 16);
  assert.equal(no.support.clampedShapeCells, 1);
  assert.equal(
    missing.support.unsupportedByReason[
      "mixed-halfbrick-waterfall-state-required"
    ],
    1,
  );
  assert.equal(missing.commands.length, 0);
  assert.equal(missing.support.mixedHalfbrickResolved, 0);
  assert.equal(JSON.stringify(f.records), before);
  for (const p of [yes, no, missing]) {
    assert.equal(
      p.support.evaluatedCells,
      p.support.drawn +
        p.support.skippedSolid +
        p.support.skippedOccluded +
        p.support.unsupported,
    );
    assert.equal(p.support.commandCount, p.commands.length);
  }
});

test("a registered mixed halfbrick without north liquid resolves as source occlusion rather than a fake water sprite", () => {
  const f = fixture({ "120,79": empty, "121,81": wet(255, 2) });
  const p = planLiquids(f.region, {
    ...opts,
    waterfallRegistry: { hasOrigin: () => true },
  });
  assert.equal(p.support.unsupported, 0);
  assert.equal(p.support.mixedHalfbrickResolved, 1);
  assert.equal(p.support.mixedHalfbrickDrawn, 0);
  assert.equal(p.support.skippedOccluded, 1);
  assert.equal(p.commands.length, 0);
  assert.equal(p.support.liquidCells, 0);
});
