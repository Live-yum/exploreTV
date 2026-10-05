import test from "node:test";
import assert from "node:assert/strict";
import { createStaticWaterfallRegistry } from "../core/static-waterfalls.mjs";
import { compactWaterfallRegistry } from "../scripts/compact-waterfall-registry.mjs";

const empty = Object.freeze({ active: false, shape: 0, liquid: 0 });
const block = (shape = 0, type = 1) => ({
  active: true,
  shape,
  type,
  liquid: 0,
});
const wet = (liquidKind = 1) => ({ ...empty, liquid: 255, liquidKind });
const extent = { x: 0, y: 0, width: 260, height: 260 };
function build(records = {}, options = {}) {
  return createStaticWaterfallRegistry(
    {
      ...extent,
      worldSurface: 40,
      getTile: (x, y) => records[`${x},${y}`] ?? empty,
    },
    options,
  );
}
function richRegistry() {
  const records = {};
  for (const [x, kind] of [
    [63, 1],
    [80, 2],
    [100, 3],
    [127, 4],
    [150, 1],
  ]) {
    records[`${x},63`] = block(1);
    records[`${x - 1},63`] = wet(kind);
    records[`${x + 1},80`] = wet();
  }
  records["151,65"] = block(0, 160);
  records["64,65"] = block(2);
  records["190,63"] = block(0, 196);
  records["200,63"] = block(0, 460);
  records["210,63"] = block(0, 717);
  return build(records, {
    discoColor: [2, 128, 255],
    timeForVisualEffects: 81.25,
  });
}

test("compact registry preserves metadata, rich commands, order, membership and seams", () => {
  const original = richRegistry(),
    compact = compactWaterfallRegistry(original);
  for (const [key, value] of Object.entries(original))
    if (typeof value !== "function") assert.deepEqual(compact[key], value);
  assert.deepEqual(compact.commandsFor(extent), original.commandsFor(extent));
  for (let x = 0; x < 260; x++)
    for (const y of [0, 63, 64, 259])
      assert.equal(compact.hasOrigin(x, y), original.hasOrigin(x, y));
  let seed = 123456789;
  const random = (max) =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % max;
  const rectangles = [];
  for (const x of [0, 1, 62, 63, 64, 65, 126, 127, 128, 129, 258, 259])
    for (const y of [0, 62, 63, 64, 65, 127, 128, 259])
      rectangles.push({ x, y, width: 1, height: 1 });
  for (let i = 0; i < 200; i++) {
    const x = random(260),
      y = random(260);
    rectangles.push({
      x,
      y,
      width: 1 + random(260 - x),
      height: 1 + random(260 - y),
    });
  }
  for (const rectangle of rectangles)
    assert.deepEqual(
      compact.commandsFor(rectangle),
      original.commandsFor(rectangle),
      JSON.stringify(rectangle),
    );
  assert.ok(Object.isFrozen(compact));
  assert.ok(Object.isFrozen(compact.origins));
  assert.ok(compact.compactStorageBytes < original.stats.commands * 100);
});

test("empty, incomplete and unsupported registries retain original behavior", () => {
  const incomplete = createStaticWaterfallRegistry({
    ...extent,
    worldSurface: 40,
    getTile: () => null,
  });
  const unsupported = build({
    "63,63": block(1),
    "62,63": wet(),
    "64,64": block(0, 379),
  });
  for (const original of [build(), incomplete, unsupported]) {
    const compact = compactWaterfallRegistry(original);
    assert.deepEqual(compact.commandsFor(extent), original.commandsFor(extent));
    assert.equal(compact.hasOrigin(63, 63), original.hasOrigin(63, 63));
    assert.deepEqual(compact.failures, original.failures);
  }
});

test("rectangle validation matches the original registry", () => {
  const original = richRegistry(),
    compact = compactWaterfallRegistry(original);
  for (const rect of [
    null,
    {},
    { ...extent, x: -1 },
    { ...extent, width: 0 },
    { ...extent, x: 1 },
    { ...extent, y: 0.5 },
    { ...extent, height: Infinity },
  ]) {
    assert.throws(() => original.commandsFor(rect), RangeError);
    assert.throws(() => compact.commandsFor(rect), RangeError);
  }
  assert.throws(
    () =>
      compactWaterfallRegistry({ ...original, viewport: { ...extent, x: 1 } }),
    /whole-world/,
  );
});

test("numeric leaves preserve floats, large integers, negative zero, optional fields and nested domains", () => {
  const source = [
    {
      dx: 0,
      dy: 0,
      dw: 16,
      dh: 16,
      worldX: 0,
      worldY: 0,
      opacity: -0,
      large: 2 ** 40 + 1,
      vertexDomain: { x: 0.25, y: -7.5, width: 20, height: 30 },
      vertexColors: { topLeft: [1, 2, 3, 4] },
      optional: undefined,
    },
    {
      dx: 16,
      dy: 16,
      dw: 16,
      dh: 16,
      worldX: 1,
      worldY: 1,
      opacity: 0.6,
      large: -(2 ** 40) - 1,
      vertexDomain: { x: 1.25, y: -8.5, width: 21, height: 31 },
      vertexColors: { topLeft: [1, 2, 3, 5] },
    },
  ];
  const original = {
    viewport: extent,
    origins: [],
    scanComplete: true,
    commandsFor: (rect) =>
      source
        .filter(
          (c) =>
            c.dx < (rect.x + rect.width) * 16 &&
            c.dy < (rect.y + rect.height) * 16 &&
            c.dx + c.dw > rect.x * 16 &&
            c.dy + c.dh > rect.y * 16,
        )
        .map((c) => ({
          ...c,
          dx: c.dx - rect.x * 16,
          dy: c.dy - rect.y * 16,
          x: c.worldX - rect.x,
          y: c.worldY - rect.y,
        })),
  };
  const compact = compactWaterfallRegistry(original);
  assert.deepEqual(compact.commandsFor(extent), original.commandsFor(extent));
  const rect = { x: 1, y: 1, width: 1, height: 1 };
  assert.deepEqual(compact.commandsFor(rect), original.commandsFor(rect));
  const output = compact.commandsFor(extent);
  output[0].vertexColors.topLeft[0] = 200;
  assert.equal(compact.commandsFor(extent)[0].vertexColors.topLeft[0], 1);
});
