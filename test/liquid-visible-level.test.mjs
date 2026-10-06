import test from "node:test";
import assert from "node:assert/strict";
import { createVisibleLiquidSampler } from "../core/liquid-visible-level.mjs";

const empty = Object.freeze({ active: false, shape: 0, liquid: 0 });
const block = Object.freeze({ active: true, type: 1, shape: 0, liquid: 0 });
const wet = (liquid = 255, liquidKind = 1, extra = {}) =>
  Object.freeze({ ...empty, liquid, liquidKind, ...extra });
const options = { isSolid: (tile) => tile.type === 1, worldSurface: 300 };
function make(cells, fill = block, opts = {}, origin = { x: 100, y: 100 }) {
  const get = (x, y) =>
    cells[`${x},${y}`] ?? (typeof fill === "function" ? fill(x, y) : fill);
  const region = {
    rect: { ...origin, width: 1, height: 1 },
    cells: [get(origin.x, origin.y)],
    getWorldTile: get,
  };
  return createVisibleLiquidSampler(region, { ...options, ...opts });
}
const crop = (result) => {
  assert.equal(result.supported, true);
  assert.ok(result.command);
  const { sx, sy, sw, sh, dx, dy } = result.command;
  return [sx, sy, sw, sh, dx, dy];
};

test("walled wet and dry halfbricks below even one liquid byte draw the upper half", () => {
  for (const amount of [0, 1, 127, 255]) {
    const t = wet(amount, 1, { ...block, shape: 1, wall: 1, liquid: amount });
    const result = make({ "100,100": t, "100,99": wet(1) })(100, 100);
    assert.deepEqual(crop(result), [16, 56, 16, 8, 0, 0]);
    assert.equal(result.behindTileSuppressed, true);
    assert.equal(result.command.liquidLevel, amount);
    assert.equal(result.command.visibleLiquidLevel, 1);
    assert.equal(t.liquid, amount);
  }
});
test("an unwalled partial halfbrick hides the normal pass but does not suppress the behind pass", () => {
  const result = make({
    "100,100": wet(127, 1, { ...block, shape: 1, liquid: 127 }),
    "100,99": wet(),
  })(100, 100);
  assert.deepEqual(result, {
    supported: true,
    occluded: true,
    behindTileSuppressed: false,
  });
});
test("a full unwalled halfbrick remains visible and still needs its separate behind pass", () => {
  const result = make({
    "100,100": wet(255, 1, { ...block, shape: 1, liquid: 255 }),
    "100,99": wet(),
  })(100, 100);
  assert.deepEqual(crop(result), [16, 56, 16, 8, 0, 0]);
  assert.equal(result.behindTileSuppressed, false);
});
test("known solid slopes block the normal renderer without a made-up triangle", () => {
  for (const shape of [0, 2, 3, 4, 5]) {
    const result = make({
      "100,100": wet(255, 1, { ...block, shape, liquid: 255 }),
    })(100, 100);
    assert.equal(result.occluded, true);
    assert.equal(result.command, undefined);
  }
});
test("minimum quarter-cell source geometry differs from raw-byte flat fill", () => {
  const result = make({ "100,100": wet(1) })(100, 100);
  assert.deepEqual(crop(result), [16, 0, 16, 4, 0, 12]);
  assert.equal(result.command.fidelity, "static-source-visible-level");
});
test("weighted top smoothing uses both side levels before quantizing pixels", () => {
  const fill = (x, y) => (y > 100 ? block : empty);
  const result = make(
    { "99,100": wet(), "100,100": wet(127), "101,100": wet() },
    fill,
  )(100, 100);
  // Raw missing height is ~8px. The two full side cells halve it to ~4px.
  assert.deepEqual(crop(result), [16, 0, 16, 12, 0, 4]);
});
test("concave corner atlas offsets preserve source ordering and use the normal clock", () => {
  for (const [side, sx] of [
    [-1, 12],
    [1, 20],
  ]) {
    const cells = {
      "100,100": wet(),
      "100,99": wet(127),
      [`${100 + side},100`]: wet(127),
      [`${100 + side},99`]: empty,
    };
    // Corner quantization truncates 7.9686 to 7; the offset is 48+7-4.
    const result = make(cells, block, { frame: 2, waterfallFrame: 7 })(
      100,
      100,
    );
    assert.deepEqual(crop(result), [sx, 211, 16, 16, 0, 0]);
  }
});
test("two same-kind raw neighbors bridge a dry cell; unequal kinds do not", () => {
  const bridged = make({
    "99,100": wet(),
    "100,100": empty,
    "101,100": wet(1),
  })(100, 100);
  assert.deepEqual(crop(bridged), [16, 0, 16, 9, 0, 7]);
  assert.equal(bridged.command.liquidLevel, 0);
  const mixed = make({
    "99,100": wet(),
    "100,100": empty,
    "101,100": wet(1, 2),
  })(100, 100);
  assert.equal(mixed.occluded, true);
});
test("water, lava and honey have different finite falling lengths", () => {
  for (const [kind, length, firstWeight] of [
    [1, 10, Math.fround(1 - Math.fround(1 / 11))],
    [2, 3, 0.75],
    [3, 2, Math.fround(1 - Math.fround(1 / 3))],
  ]) {
    const sample = make({ "100,99": wet(255, kind) }, empty);
    const first = sample(100, 100);
    assert.deepEqual(crop(first), [16, 32, 16, 16, 0, 0]);
    assert.equal(first.command.opacity, firstWeight);
    assert.equal(first.command.visibleLiquidLevel, firstWeight);
    assert.ok(sample(100, 99 + length).command);
    assert.equal(sample(100, 100 + length).occluded, true);
  }
});
test("a solid interrupts falling liquid and partial raw cells reset source alpha", () => {
  const stopped = make({ "100,98": wet(), "100,99": block }, empty)(100, 100);
  assert.equal(stopped.occluded, true);
  const fed = make({ "100,99": wet(), "100,100": wet(1) }, empty)(100, 100);
  assert.equal(fed.command.opacity, 1);
  assert.equal(
    fed.command.visibleLiquidLevel,
    Math.fround(1 - Math.fround(1 / 11)),
  );
});
test("frozen clocks, surface band, style and front alpha stay explicit", () => {
  const cells = { "100,100": wet(127, 2) };
  const first = make(cells, block, {
    frame: 2,
    waterfallFrame: 3,
    lavaOpacity: 0.4,
    layer: "foreground",
  })(100, 100).command;
  assert.equal(first.asset, "water_1.png");
  assert.equal(first.sy, 240);
  assert.equal(first.opacity, 0.95 * 0.4);
  const surface = make({ "100,100": wet(127) }, block, {
    worldSurface: 120,
    waterStyle: 13,
  })(100, 100).command;
  assert.equal(surface.sy, 1280);
  assert.equal(surface.asset, "water_13.png");
  const local = make(
    { "100,100": wet() },
    block,
    {},
    { x: 98, y: 99 },
  )(100, 100).command;
  assert.deepEqual([local.x, local.y, local.dx, local.dy], [2, 1, 32, 16]);
});
test("missing context and unknown active material remain explicit failures", () => {
  const region = { rect: { x: 1, y: 1, width: 1, height: 1 }, cells: [wet()] };
  assert.deepEqual(createVisibleLiquidSampler(region, options)(1, 1), {
    supported: false,
    reason: "visible-missing-context",
  });
  const unknown = make(
    { "100,100": wet(), "101,100": { ...block, type: 999 } },
    block,
    { isSolid: (t) => (t.type === 1 ? true : undefined) },
  )(100, 100);
  assert.equal(unknown.reason, "visible-unknown-solid-neighborhood");
  const special = make({
    "100,100": wet(),
    "101,100": { ...block, type: 379 },
  })(100, 100);
  assert.equal(special.reason, "visible-special-tile-neighborhood");
});
test("shimmer and malformed data never become water or an invalid crop", () => {
  assert.equal(
    make({ "100,100": wet(255, 4) })(100, 100).reason,
    "visible-shimmer",
  );
  assert.equal(
    make({ "100,100": wet(256) })(100, 100).reason,
    "visible-invalid-liquid-level",
  );
  assert.equal(
    make({ "100,100": wet(255, 8) })(100, 100).reason,
    "visible-unknown-liquid-kind",
  );
  assert.equal(
    make({ "100,100": wet(255, 1, { shape: 6 }) })(100, 100).reason,
    "visible-invalid-shape",
  );
  assert.equal(
    make({ "100,100": wet() }, block, { worldSurface: undefined })(100, 100)
      .reason,
    "visible-world-surface-unknown",
  );
  assert.throws(
    () => make({}, block, { waterStyle: 14 }),
    /Invalid water atlas/,
  );
});
test("sampler retains immutable input and deterministic results after other queries", () => {
  const input = Object.freeze({
    "100,100": wet(127),
    "99,100": wet(),
    "101,100": wet(),
  });
  const before = JSON.stringify(input),
    sample = make(input);
  const first = sample(100, 100);
  sample(99, 100);
  sample(101, 100);
  assert.deepEqual(sample(100, 100), first);
  assert.equal(JSON.stringify(input), before);
});
test("unbounded partial-liquid dependencies are rejected instead of filled by a guessed boundary", () => {
  const sample = make({}, (x) => (x === 100 ? wet(1) : empty));
  assert.deepEqual(sample(100, 100), {
    supported: false,
    reason: "visible-dependency-depth",
  });
});
