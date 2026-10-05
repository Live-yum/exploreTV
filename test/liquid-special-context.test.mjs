import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { createSpecialLiquidContextSampler } from "../core/liquid-special-context.mjs";
import { createVisibleLiquidSampler } from "../core/liquid-visible-level.mjs";
import { isSolidOrSlopedTile } from "../core/tile-solidity.mjs";
import { planLiquids } from "../core/liquid.mjs";
import { renderScene } from "../core/renderer.mjs";

const empty = () => ({ active: false, type: 0, shape: 0, liquid: 0 });
const block = (shape = 0, type = 1) => ({
  active: true,
  type,
  shape,
  liquid: 0,
});
const wet = (liquid = 255, liquidKind = 1, extra = {}) => ({
  ...empty(),
  liquid,
  liquidKind,
  ...extra,
});
const lily = (liquid = 255, extra = {}) =>
  wet(liquid, 1, { active: true, type: 518, frameX: 36, frameY: 18, ...extra });
const opts = { worldSurface: 300, layer: "foreground" };
function make(own = wet(), overrides = {}, fill = block(), options = {}) {
  const records = { "100,100": own, ...overrides };
  const getWorldTile = (x, y) =>
    records[`${x},${y}`] ?? (typeof fill === "function" ? fill(x, y) : fill);
  const context = { rect: { x: 99, y: 99, width: 3, height: 3 }, cells: [] };
  for (let x = 99; x <= 101; x++)
    for (let y = 99; y <= 101; y++) context.cells.push(getWorldTile(x, y));
  const region = {
    rect: { x: 100, y: 100, width: 1, height: 1 },
    cells: [own],
    context,
    getWorldTile,
  };
  return {
    records,
    region,
    sample: createSpecialLiquidContextSampler(region, { ...opts, ...options }),
  };
}
const crop = (command) => [
  command.sx,
  command.sy,
  command.sw,
  command.sh,
  command.dx,
  command.dy,
];

test("lily cache adaptation preserves liquid levels, walls and active records rather than replacing them with air", () => {
  const fill = (x, y) => (y > 100 ? block() : empty());
  const leaf = lily(255, { wall: 1 });
  const fixture = make(wet(127), { "99,100": wet(), "101,100": leaf }, fill);
  const before = JSON.stringify(fixture.records);
  const p = fixture.sample(100, 100);
  assert.equal(p.supported, true);
  assert.deepEqual(crop(p.commands[0]), [16, 0, 16, 12, 0, 4]);
  const equivalent = make(
    wet(127),
    { "99,100": wet(), "101,100": { ...leaf, type: 3 } },
    fill,
  );
  const source = createVisibleLiquidSampler(equivalent.region, {
    ...opts,
    isSolid: isSolidOrSlopedTile,
  })(100, 100);
  assert.deepEqual(p.commands, [source.command]);
  const erased = make(
    wet(127),
    { "99,100": wet(), "101,100": empty() },
    fill,
  ).sample(100, 100);
  assert.notDeepEqual(crop(p.commands[0]), crop(erased.commands[0]));
  assert.equal(JSON.stringify(fixture.records), before);
  assert.equal(leaf.type, 518);
  assert.equal(leaf.liquid, 255);
});

test("extended lily dependencies use the same proved cache fields beyond immediate context", () => {
  const fixture = make(wet(), { "102,100": lily() }, wet());
  const prior = createVisibleLiquidSampler(fixture.region, {
    ...opts,
    isSolid: isSolidOrSlopedTile,
  })(100, 100);
  assert.equal(prior.reason, "visible-special-tile-neighborhood");
  const current = fixture.sample(100, 100);
  assert.equal(current.supported, true);
  assert.equal(current.commands.length, 1);
  assert.equal(current.commands[0].asset, "water_0.png");
});

test("wet lily underlay records exact saved crop and capped liquid displacement without duplicating a Tile sprite", () => {
  const capped = make(lily(255, { frameX: 306, frameY: 36 })).sample(100, 100);
  assert.deepEqual(capped.lilyUnderlay, {
    asset: "Tiles_518.png",
    sx: 306,
    sy: 36,
    sw: 16,
    sh: 16,
    dx: 0,
    dy: -8,
    dw: 16,
    dh: 16,
  });
  const open = make(lily(), { "100,99": empty() }).sample(100, 100);
  assert.equal(open.lilyUnderlay.dy, -12);
  const partial = make(lily(127)).sample(100, 100);
  assert.equal(partial.lilyUnderlay.dy, -4);
  assert.ok(
    capped.commands.every(
      (c) => c.kind === "liquid" && !c.asset.startsWith("Tiles_"),
    ),
  );
  assert.equal(capped.commands[0].layer, "foreground");
});

test("lily sprite visibility, style, dry state and background ordering remain explicit limitations", () => {
  for (const [tile, options, reason] of [
    [lily(0), {}, "special-dry-lily-context"],
    [lily(255, { frameX: 37 }), {}, "special-lily-sprite-context"],
    [lily(255, { frameY: 54 }), {}, "special-lily-sprite-context"],
    [lily(255, { shape: 1 }), {}, "special-lily-sprite-context"],
    [lily(255, { invisibleBlock: true }), {}, "special-lily-sprite-context"],
    [lily(255, { inactive: true }), {}, "special-lily-actuation-context"],
    [lily(), { layer: "background" }, "special-lily-background-layer"],
  ]) {
    const p = make(tile, { "99,100": wet() }, block(), options).sample(
      100,
      100,
    );
    assert.deepEqual(p, { supported: false, reason });
  }
});

test("sloped platforms remain non-solid and do not become a solid-slope liquid mask", () => {
  for (const shape of [2, 3]) {
    const p = make(wet(127, 1, { active: true, type: 19, shape })).sample(
      100,
      100,
    );
    assert.equal(p.supported, true);
    assert.deepEqual(crop(p.commands[0]), [16, 0, 16, 8, 0, 8]);
    assert.equal(p.commands[0].asset, "water_0.png");
    assert.equal(p.commands[0].drawBeforeTiles, undefined);
    assert.equal(p.commands[0].clip, undefined);
  }
  const halfPlatform = make(wet(127, 1, { active: true, type: 19, shape: 1 }), {
    "100,99": wet(),
  }).sample(100, 100);
  assert.equal(halfPlatform.commands[0].sh, 16);
  assert.ok(halfPlatform.commands[0].visibleLiquidLevel < 1);
});

test("mixed normal cells retain their raw liquid type even when another kind raises visible level", () => {
  for (const [kind, asset] of [
    [1, "water_0.png"],
    [2, "water_1.png"],
    [3, "water_11.png"],
  ]) {
    const neighborKind = kind === 1 ? 2 : 1;
    const p = make(wet(255, kind), {
      "101,100": wet(255, neighborKind),
    }).sample(100, 100);
    assert.equal(p.supported, true);
    assert.equal(p.contextRule, "raw-seed-mixed-normal");
    assert.equal(p.commands[0].asset, asset);
    assert.equal(p.commands[0].liquidType, kind - 1);
  }
  const incomingHoney = make(wet(86, 1), { "100,99": wet(255, 3) }).sample(
    100,
    100,
  ).commands[0];
  assert.equal(incomingHoney.asset, "water_0.png");
  assert.equal(incomingHoney.liquidType, 0);
  assert.equal(incomingHoney.liquidLevel, 86);
  assert.equal(
    incomingHoney.visibleLiquidLevel,
    Math.fround(1 - Math.fround(1 / 3)),
  );
  assert.equal(incomingHoney.opacity, 0.6);
});

test("dry mixed halfbricks never choose an arbitrary neighbor or drop their behind pass", () => {
  const p = make(block(1), {
    "99,100": wet(255, 1),
    "101,100": wet(255, 2),
  }).sample(100, 100);
  assert.deepEqual(p, {
    supported: false,
    reason: "special-mixed-behind-liquid-context",
  });
});

test("ordinary solid slopes beside lilies preserve the established source atlas geometry and clamp split", () => {
  const fields = [
    "asset",
    "sx",
    "sy",
    "sw",
    "sh",
    "dx",
    "dy",
    "dw",
    "dh",
    "opacity",
    "layer",
    "sourceSampling",
  ];
  const selected = (c) => Object.fromEntries(fields.map((k) => [k, c[k]]));
  for (const shape of [2, 3, 4, 5]) {
    const surrounding = {
      "100,99": wet(),
      "99,100": wet(),
      "101,100": lily(),
      "100,101": wet(),
    };
    const p = make(block(shape), surrounding).sample(100, 100);
    const ordinary = make(block(shape), {
      ...surrounding,
      "101,100": wet(255, 1, { active: true, type: 3 }),
    });
    const prior = planLiquids(ordinary.region, {
      ...opts,
      enabled: true,
      isSolid: isSolidOrSlopedTile,
    });
    assert.equal(p.supported, true);
    assert.deepEqual(p.commands.map(selected), prior.commands.map(selected));
  }
});

test("runtime Bubble, unimplemented Grate and unknown/missing data continue to reject", () => {
  for (const [neighbor, reason] of [
    [block(0, 379), "special-bubble-runtime-solid"],
    [block(0, 546), "special-grate-context"],
    [block(0, 999), "special-unknown-solid-neighborhood"],
    [wet(255, 4), "special-shimmer-context"],
    [wet(256), "special-invalid-liquid-level"],
    [wet(255, 9), "special-unknown-liquid-kind"],
  ])
    assert.deepEqual(make(wet(), { "101,100": neighbor }).sample(100, 100), {
      supported: false,
      reason,
    });
  const partial = { rect: { x: 1, y: 1, width: 1, height: 1 }, cells: [wet()] };
  assert.equal(
    createSpecialLiquidContextSampler(partial, opts)(1, 1).reason,
    "special-missing-context",
  );
  assert.equal(
    make(wet(), {}, block(), { worldSurface: undefined }).sample(100, 100)
      .reason,
    "special-world-surface-unknown",
  );
});

test("lily underlay is drawn once before the authentic foreground liquid sample", () => {
  const p = make(lily(), { "100,99": empty() }).sample(100, 100);
  const water = p.commands[0],
    leaf = p.lilyUnderlay;
  const atlas = createCanvas(48, 1360),
    a = atlas.getContext("2d");
  a.fillStyle = "rgb(0,0,255)";
  a.fillRect(water.sx, water.sy, water.sw, water.sh);
  const leafAtlas = createCanvas(324, 90),
    l = leafAtlas.getContext("2d");
  l.fillStyle = "rgb(0,255,0)";
  l.fillRect(leaf.sx, leaf.sy, leaf.sw, leaf.sh);
  const commands = [
    { ...leaf, kind: "tile", dy: leaf.dy + 16 },
    { ...water, dy: water.dy + 16 },
  ];
  const output = createCanvas(16, 32),
    ctx = output.getContext("2d");
  const rendered = renderScene(
    ctx,
    { width: 16, height: 32, commands, warnings: [] },
    new Map([
      ["water_0.png", atlas],
      ["Tiles_518.png", leafAtlas],
    ]),
    { strict: true },
  );
  assert.equal(rendered.drawn, 2);
  assert.deepEqual([...ctx.getImageData(8, 8, 1, 1).data], [0, 255, 0, 255]);
  const pixel = [...ctx.getImageData(8, 17, 1, 1).data];
  assert.ok(Math.abs(pixel[1] - 102) <= 1);
  assert.ok(Math.abs(pixel[2] - 153) <= 1);
  assert.equal(pixel[3], 255);
});
