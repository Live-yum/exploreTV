import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openWorld, getWorldTileAccessor } from "../core/world.mjs";
import { createStaticWaterfallRegistry } from "../core/static-waterfalls.mjs";
import {
  compactWaterfallRegistry,
  createCompactStaticWaterfallRegistry,
} from "../scripts/compact-waterfall-registry.mjs";

const empty = Object.freeze({ active: false, shape: 0, liquid: 0 });
const block = (shape = 0, type = 1) => ({
  active: true,
  shape,
  type,
  liquid: 0,
});
const wet = (liquidKind = 1) => ({ ...empty, liquid: 255, liquidKind });
const extent = { x: 0, y: 0, width: 260, height: 260 };
function build(
  records = {},
  options = {},
  factory = createStaticWaterfallRegistry,
) {
  return factory(
    {
      ...extent,
      worldSurface: 40,
      getTile: (x, y) => records[`${x},${y}`] ?? empty,
    },
    options,
  );
}
function richRegistry(factory = createStaticWaterfallRegistry) {
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
  return build(
    records,
    {
      discoColor: [2, 128, 255],
      timeForVisualEffects: 81.25,
    },
    factory,
  );
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

function assertRegistryEqual(actual, expected, rectangles = [extent]) {
  for (const [key, value] of Object.entries(expected))
    if (typeof value !== "function") assert.deepEqual(actual[key], value, key);
  for (const rect of rectangles)
    assert.deepEqual(
      actual.commandsFor(rect),
      expected.commandsFor(rect),
      JSON.stringify(rect),
    );
  for (const { x, y } of expected.origins)
    assert.equal(actual.hasOrigin(x, y), expected.hasOrigin(x, y));
  assert.equal(actual.hasOrigin(0, 0), expected.hasOrigin(0, 0));
}

test("streaming registry preserves stable batch order, rich colors and bucket seams", () => {
  const original = richRegistry(),
    compact = richRegistry(createCompactStaticWaterfallRegistry);
  const rectangles = [extent];
  for (const x of [0, 1, 62, 63, 64, 65, 126, 127, 128, 129, 258, 259])
    for (const y of [0, 62, 63, 64, 65, 127, 128, 259])
      rectangles.push({
        x,
        y,
        width: Math.min(3, 260 - x),
        height: Math.min(3, 260 - y),
      });
  assertRegistryEqual(compact, original, rectangles);
  assert.ok(Object.isFrozen(compact));
  assert.ok(Object.isFrozen(compact.originPlans));
  assert.equal(
    compact.compactStorageBytes,
    compactWaterfallRegistry(original).compactStorageBytes,
  );
});

test("streaming storage grows beyond its first numeric page and retains late constants", () => {
  const records = {};
  for (let x = 30; x < 230; x += 8) {
    records[`${x},63`] = block(1);
    records[`${x - 1},63`] = wet(x < 100 ? 1 : x < 160 ? 4 : 2);
  }
  const original = build(records),
    compact = build(records, {}, createCompactStaticWaterfallRegistry);
  assert.ok(original.stats.commands > 1024);
  assertRegistryEqual(compact, original);
});

test("streaming storage commits successful origins atomically under caps and draw failures", () => {
  const records = {
    "63,63": block(1),
    "62,63": wet(),
    "64,65": block(0, 379),
    "100,63": block(1),
    "99,63": wet(4),
    "150,63": block(1),
    "149,63": wet(2),
    "151,66": wet(),
  };
  for (const options of [
    {},
    { maxCommands: 1 },
    { maxCommands: 5 },
    { maxCommands: 100 },
    { maxWaterfalls: 1 },
    { maxWaterfalls: 0 },
    { quality: 0 },
  ])
    assertRegistryEqual(
      build(records, options, createCompactStaticWaterfallRegistry),
      build(records, options),
    );
  const incomplete = { ...extent, worldSurface: 40, getTile: () => null };
  assertRegistryEqual(
    createCompactStaticWaterfallRegistry(incomplete),
    createStaticWaterfallRegistry(incomplete),
  );
  assertRegistryEqual(
    build({}, {}, createCompactStaticWaterfallRegistry),
    build(),
  );
});

test("streaming registry validates storage and whole-world origin", () => {
  assert.throws(() => build({}, { commandStore: {} }), /command store/);
  assert.throws(
    () =>
      build(
        {},
        { viewport: { ...extent, width: extent.width - 1 } },
        createCompactStaticWaterfallRegistry,
      ),
    /complete world dimensions/,
  );
  assert.throws(
    () =>
      build(
        {},
        { viewport: { ...extent, x: 1, width: 259 } },
        createCompactStaticWaterfallRegistry,
      ),
    /whole-world/,
  );
});

test(
  "real-world streaming output exactly matches object registry metadata and commands",
  {
    skip: !process.env.EXPLORETV_REAL_WATERFALL,
  },
  () => {
    const world = openWorld(readFileSync(process.env.EXPLORETV_REAL_WATERFALL));
    const dimensions = { x: 0, y: 0, width: world.width, height: world.height };
    const source = {
      ...dimensions,
      worldSurface: world.worldSurface,
      getTile: getWorldTileAccessor(world),
    };
    const options = {
      viewport: dimensions,
      quality: 1,
      maxWaterfalls: 100000,
      maxCommands: 1048576,
      waterStyle: 0,
      frame: 0,
      slowFrame: 0,
    };
    const original = createStaticWaterfallRegistry(source, options);
    const compact = createCompactStaticWaterfallRegistry(source, options);
    // Full command equality includes stable draw order and every nested color.
    // Additional stripes verify translation, clipping and duplicate bucket hits.
    const rectangles = [dimensions];
    for (let y = 0; y < world.height; y += 64)
      rectangles.push({
        x: 0,
        y,
        width: world.width,
        height: Math.min(64, world.height - y),
      });
    assertRegistryEqual(compact, original, rectangles);
  },
);
