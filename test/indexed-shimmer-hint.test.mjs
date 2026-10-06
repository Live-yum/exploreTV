import test from "node:test";
import assert from "node:assert/strict";
import { planSceneLiquids } from "../core/liquid-composite.mjs";
import { isSolidOrSlopedTile } from "../core/tile-solidity.mjs";

const air = Object.freeze({
  active: false,
  type: 0,
  shape: 0,
  wall: 0,
  liquid: 0,
  liquidKind: 0,
});
const shimmer = Object.freeze({ ...air, liquid: 255, liquidKind: 4 });
const options = {
  enabled: true,
  layer: "foreground",
  isSolid: isSolidOrSlopedTile,
};

function makeRegion({
  x = 10,
  y = 20,
  width = 3,
  height = 3,
  hint,
  wet = null,
} = {}) {
  const metrics = { scans: 0, reads: 0 };
  const source = {
    width: 64,
    height: 64,
    worldSurface: 10,
  };
  const raw = (wx, wy) =>
    wx < 0 || wy < 0 || wx >= source.width || wy >= source.height
      ? null
      : wet && wx === wet.x && wy === wet.y
        ? shimmer
        : air;
  const cells = Array.from({ length: width * height }, (_, i) =>
    raw(x + Math.floor(i / height), y + (i % height)),
  );
  cells.some = function (predicate) {
    metrics.scans++;
    return Array.prototype.some.call(this, predicate);
  };
  const region = {
    rect: { x, y, width, height },
    cells,
    source,
    indexedShimmerPossible: hint,
    getWorldTile(wx, wy) {
      metrics.reads++;
      return raw(wx, wy);
    },
  };
  return { region, metrics, raw };
}

test("proven shimmer absence preserves the full plan without scans or outside reads", () => {
  const reference = makeRegion();
  const indexed = makeRegion({ hint: false });
  assert.deepEqual(
    planSceneLiquids(indexed.region, options),
    planSceneLiquids(reference.region, options),
  );
  assert.deepEqual(indexed.metrics, { scans: 0, reads: 0 });
  assert.equal(reference.metrics.scans, 1);
  assert.equal(reference.metrics.reads, 55);
  assert.deepEqual(
    planSceneLiquids(indexed.region, { ...options, getWorldTile: null }),
    planSceneLiquids(reference.region, options),
  );
  assert.deepEqual(indexed.metrics, { scans: 0, reads: 0 });
});

test("true or absent hints retain detection of sources exactly eleven rows above", () => {
  const wet = { x: 10, y: 9 };
  const reference = makeRegion({ wet });
  const expected = planSceneLiquids(reference.region, options);
  assert.ok(expected.support.shimmer);
  for (const hint of [undefined, true, 0, "false"]) {
    const indexed = makeRegion({ hint, wet });
    assert.deepEqual(planSceneLiquids(indexed.region, options), expected);
    assert.equal(indexed.metrics.scans, 1);
    assert.ok(indexed.metrics.reads > 0);
  }
});

test("a source twelve rows above remains outside the existing detection window", () => {
  const wet = { x: 10, y: 8 };
  const reference = makeRegion({ wet });
  const indexed = makeRegion({ hint: false, wet });
  const expected = planSceneLiquids(reference.region, options);
  assert.equal(expected.support.shimmer, undefined);
  assert.deepEqual(planSceneLiquids(indexed.region, options), expected);
  assert.deepEqual(indexed.metrics, { scans: 0, reads: 0 });
});

test("saved selection context defeats an absence hint for the indexed region", () => {
  const wet = { x: 10, y: 19 };
  const make = (hint) => {
    const item = makeRegion({ hint, wet });
    item.region.context = {
      rect: { x: 9, y: 19, width: 5, height: 5 },
      cells: Array.from({ length: 25 }, (_, i) =>
        item.raw(9 + Math.floor(i / 5), 19 + (i % 5)),
      ),
    };
    return item;
  };
  const reference = make(undefined),
    indexed = make(false);
  const expected = planSceneLiquids(reference.region, options);
  assert.ok(expected.support.shimmer);
  assert.deepEqual(planSceneLiquids(indexed.region, options), expected);
  assert.equal(indexed.metrics.scans, 1);
});

test("an explicit reader override defeats a hint and retains its falling source", () => {
  const reference = makeRegion(),
    indexed = makeRegion({ hint: false });
  let reads = 0;
  const override = (x, y) => {
    reads++;
    return x === 10 && y === 19 ? shimmer : air;
  };
  const overridden = { ...options, getWorldTile: override };
  const expected = planSceneLiquids(reference.region, overridden);
  assert.ok(expected.support.shimmer);
  const previousReads = reads;
  assert.deepEqual(planSceneLiquids(indexed.region, overridden), expected);
  assert.ok(reads > previousReads);
  assert.equal(indexed.metrics.scans, 1);
  assert.equal(indexed.metrics.reads, 0);
});

test("absence hints match ordinary detection at both world boundaries", () => {
  for (const [x, y] of [
    [0, 0],
    [0, 1],
    [61, 61],
  ]) {
    const reference = makeRegion({ x, y });
    const indexed = makeRegion({ x, y, hint: false });
    assert.deepEqual(
      planSceneLiquids(indexed.region, options),
      planSceneLiquids(reference.region, options),
    );
    assert.deepEqual(indexed.metrics, { scans: 0, reads: 0 });
  }
});
