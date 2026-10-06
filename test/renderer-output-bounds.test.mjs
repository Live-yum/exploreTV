import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { planScene, renderScene } from "../core/renderer.mjs";
import { prepareSceneFrames } from "../core/scene-frames.mjs";

const tile = (extra = {}) => ({
  active: true,
  type: 1,
  frameX: null,
  frameY: null,
  shape: 0,
  wall: 1,
  liquid: 0,
  liquidKind: 0,
  ...extra,
});
const air = () => tile({ active: false, wall: 0 });
const emptyRegion = (width = 12, height = 10) => ({
  rect: { x: 100, y: 200, width, height },
  source: { width: 8400, height: 2400, worldSurface: 649 },
  cells: Array.from({ length: width * height }, air),
});
function mixedScene() {
  const r = emptyRegion(22, 18),
    h = r.rect.height;
  for (let x = 0; x < r.rect.width; x++)
    for (let y = 0; y < h; y++)
      r.cells[x * h + y] = tile({
        shape: x % 3 === 0 ? y % 6 : 0,
        paint: y % 5 === 0 ? 2 : 0,
        wallPaint: x % 4 === 0 ? 26 : 0,
        ...(y >= 6 && y <= 8
          ? { active: false, liquid: 255, liquidKind: 1 }
          : {}),
      });
  const set = (x, y, value) => (r.cells[x * h + y] = value);
  set(0, 0, tile({ type: 999, frameX: 0, frameY: 0 }));
  set(1, 0, tile({ type: 373, frameX: 0, frameY: 0 }));
  set(2, 0, tile({ invisibleBlock: true, invisibleWall: true }));
  set(3, 0, tile({ wall: 318 }));
  set(21, 17, tile({ active: false, liquid: 128, liquidKind: 99 }));
  set(4, 4, tile({ type: 4, frameX: 22, frameY: 264 }));
  // Both regular and queued overhang sprites cross the output boundaries.
  for (const [type, ox, oy, height] of [
    [237, 3, 9, 2],
    [617, 12, 3, 4],
  ])
    for (let x = 0; x < 3; x++)
      for (let y = 0; y < height; y++)
        set(
          ox + x,
          oy + y,
          tile({
            type,
            frameX: x * 18,
            frameY: y * 18,
          }),
        );
  return r;
}
function textures(plan) {
  const sizes = new Map();
  for (const c of plan.commands) {
    const old = sizes.get(c.asset) || [1, 1];
    sizes.set(c.asset, [
      Math.max(old[0], Math.ceil(c.sx + c.sw)),
      Math.max(old[1], Math.ceil(c.sy + c.sh)),
    ]);
  }
  const assets = new Map();
  let seed = 0;
  for (const [name, [width, height]] of sizes) {
    const canvas = createCanvas(width, height),
      ctx = canvas.getContext("2d"),
      image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        image.data.set(
          [
            (x * 7 + seed) % 256,
            (y * 11 + seed) % 256,
            (x + y * 3 + seed) % 256,
            [0, 1, 127, 254, 255][(x + y) % 5],
          ],
          i,
        );
      }
    ctx.putImageData(image, 0, 0);
    assets.set(name, canvas);
    seed += 31;
  }
  return assets;
}
function pixels(plan, assets, bounds) {
  const canvas = createCanvas(plan.width, plan.height),
    ctx = canvas.getContext("2d"),
    frames = prepareSceneFrames(plan, assets, createCanvas, {
      opaqueScene: true,
      inputEncoding: "standard-straight",
    });
  try {
    const result = renderScene(ctx, plan, assets, {
      strict: true,
      sceneFrames: frames,
    });
    assert.equal(result.skippedEffects, 0);
    return Buffer.from(
      ctx.getImageData(bounds.x, bounds.y, bounds.width, bounds.height).data,
    );
  } finally {
    frames.dispose();
    canvas.width = canvas.height = 1;
  }
}

test("output bounds preserve cropped pixels, owner commands and full source diagnostics", () => {
  const region = mixedScene(),
    options = { paintEnabled: true, liquids: { enabled: true } },
    full = planScene(region, options),
    assets = textures(full);
  assert.equal("culledCommands" in full, false);
  assert.ok(full.support.unsupportedTiles > 0);
  assert.ok(full.support.sourceHiddenTiles > 0);
  assert.ok(full.support.hiddenTiles > 0);
  assert.ok(full.support.liquidDrawing.unsupported > 0);
  assert.ok(full.commands.some((c) => c.specialLayer));
  for (const outputBounds of [
    { x: 5 * 16, y: 4 * 16, width: 8 * 16, height: 6 * 16 },
    { x: 0, y: 0, width: 48, height: 80 },
    { x: 18 * 16, y: 14 * 16, width: 64, height: 64 },
    { x: 83, y: 67, width: 99, height: 79 },
  ]) {
    const bounded = planScene(region, { ...options, outputBounds });
    assert.ok(bounded.culledCommands > 0);
    assert.equal(
      bounded.commands.length + bounded.culledCommands,
      full.commands.length,
    );
    for (const field of [
      "support",
      "warnings",
      "unsupportedCells",
      "sourceHiddenCells",
      "contextOmissions",
      "width",
      "height",
      "paintEnabled",
    ])
      assert.deepEqual(bounded[field], full[field], field);
    const ownerTouches = (c) =>
      c.x * 16 < outputBounds.x + outputBounds.width &&
      c.y * 16 < outputBounds.y + outputBounds.height &&
      c.x * 16 + 16 > outputBounds.x &&
      c.y * 16 + 16 > outputBounds.y;
    assert.deepEqual(
      bounded.commands.filter(ownerTouches),
      full.commands.filter(ownerTouches),
    );
    assert.deepEqual(bounded.requiredAssets, full.requiredAssets);
    assert.deepEqual(
      pixels(bounded, assets, outputBounds),
      pixels(full, assets, outputBounds),
    );
    assert.throws(
      () =>
        planScene(region, {
          ...options,
          outputBounds,
          maxCommands: full.commands.length - 1,
        }),
      /command budget/,
    );
  }
});

test("ordinary terrain and wall guards cover every sub-tile crop offset", () => {
  const region = emptyRegion(7, 7);
  for (let shape = 0; shape <= 5; shape++) {
    region.cells = region.cells.map(() => tile({ shape }));
    const full = planScene(region);
    for (let offset = 0; offset < 16; offset++) {
      for (const outputBounds of [
        { x: 32 + offset, y: 47 - offset, width: 1, height: 17 },
        { x: 47 - offset, y: 32 + offset, width: 17, height: 1 },
      ]) {
        const bounded = planScene(region, { outputBounds });
        // Use pixel rectangles as the oracle, independent of the planner's
        // integer owner intervals. All terrain shapes retain a full-tile box;
        // walls extend eight pixels past their tile on every side.
        const expected = full.commands.filter((c) => {
          const wall = c.kind === "wall",
            left = c.x * 16 - (wall ? 8 : 0),
            top = c.y * 16 - (wall ? 8 : 0),
            size = wall ? 32 : 16;
          return (
            left + size + 1 > outputBounds.x &&
            top + size + 1 > outputBounds.y &&
            left - 1 < outputBounds.x + outputBounds.width &&
            top - 1 < outputBounds.y + outputBounds.height
          );
        });
        assert.deepEqual(bounded.commands, expected);
        assert.equal(
          bounded.culledCommands,
          full.commands.length - expected.length,
        );
        assert.deepEqual(bounded.support, full.support);
        assert.deepEqual(bounded.requiredAssets, full.requiredAssets);
      }
    }
  }
});

test("wall guards retain dependency names for nonnumeric wall identifiers", () => {
  const region = emptyRegion();
  region.cells[0] = tile({ active: false, wall: "length" });
  const full = planScene(region),
    bounded = planScene(region, {
      outputBounds: { x: 64, y: 64, width: 16, height: 16 },
    });
  assert.equal(bounded.culledCommands, 1);
  assert.equal(bounded.commands.length, 0);
  assert.deepEqual(bounded.requiredAssets, ["Wall_length.png"]);
  assert.deepEqual(bounded.requiredAssets, full.requiredAssets);
  assert.deepEqual(bounded.support, full.support);
});

test("output culling retains displaced core owners, one-pixel guards and unknown geometry", () => {
  const region = emptyRegion(),
    outputBounds = { x: 64, y: 64, width: 32, height: 32 };
  const command = (id, extra) => ({
    id,
    kind: "waterfall",
    asset: "Waterfall_0.png",
    x: 0,
    y: 0,
    sx: 0,
    sy: 0,
    sw: 16,
    sh: 16,
    dx: 0,
    dy: 0,
    dw: 16,
    dh: 16,
    ...extra,
  });
  const commands = [
    command("core-owner-displaced", { x: 4, y: 4, dx: 160, dy: 128 }),
    command("left-pad", { dx: 48, dy: 64 }),
    command("top-pad", { dx: 64, dy: 48 }),
    command("right-pad", { dx: 96, dy: 64 }),
    command("bottom-pad", { dx: 64, dy: 96 }),
    command("left-outside", { dx: 47, dy: 64 }),
    command("top-outside", { dx: 64, dy: 47 }),
    command("right-outside", { dx: 97, dy: 64 }),
    command("bottom-outside", { dx: 64, dy: 97 }),
    command("unknown-owner", { x: undefined }),
    command("fractional-owner", { x: 0.5 }),
    command("non-finite-destination", { dx: NaN }),
    command("zero-width", { dw: 0 }),
    command("negative-height", { dh: -16 }),
  ];
  const options = {
    liquids: {
      enabled: true,
      waterfallRegistry: {
        model: "test",
        scanComplete: true,
        stats: { registered: 1 },
        hasOrigin: () => false,
        commandsFor: () => commands,
      },
    },
  };
  const full = planScene(region, options),
    bounded = planScene(region, { ...options, outputBounds });
  assert.equal(bounded.culledCommands, 4);
  assert.deepEqual(
    bounded.commands.map((c) => c.id),
    commands.filter((c) => !c.id.endsWith("-outside")).map((c) => c.id),
  );
  assert.deepEqual(bounded.support, full.support);
  assert.deepEqual(bounded.warnings, full.warnings);
  assert.equal(bounded.support.waterfalls.commands, commands.length);
});

test("output bounds reject invalid or out-of-scene pixel rectangles", () => {
  const region = emptyRegion(2, 2);
  for (const outputBounds of [
    null,
    {},
    { x: 0, y: 0, width: 0, height: 1 },
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0.5, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 33, height: 1 },
    { x: 0, y: 31, width: 1, height: 2 },
    { x: 0, y: 0, width: Infinity, height: 1 },
  ])
    assert.throws(() => planScene(region, { outputBounds }), /Output bounds/);
  const bounded = planScene(region, {
    outputBounds: { x: 0, y: 0, width: 32, height: 32 },
  });
  const { culledCommands, ...unchanged } = bounded;
  assert.equal(culledCommands, 0);
  assert.deepEqual(unchanged, planScene(region));
});

test("output bounds retain assets used only by omitted walls, terrain and layered sprites", () => {
  const region = emptyRegion(),
    outputBounds = { x: 64, y: 64, width: 16, height: 16 };
  region.cells[0] = tile({ type: 59, wall: 2 });
  region.cells[20] = tile({ type: 33, frameX: 0, frameY: 0, wall: 0 });
  region.cells[44] = tile();
  const full = planScene(region),
    bounded = planScene(region, { outputBounds });
  assert.ok(bounded.culledCommands > 0);
  assert.ok(full.requiredAssets.includes("Tiles_59.png"));
  assert.ok(full.requiredAssets.includes("Wall_2.png"));
  assert.ok(full.commands.some((c) => c.ownerType === 33));
  assert.ok(bounded.commands.every((c) => c.ownerType !== 33));
  assert.ok(bounded.commands.every((c) => c.asset !== "Tiles_59.png"));
  assert.ok(bounded.commands.every((c) => c.asset !== "Wall_2.png"));
  assert.deepEqual(bounded.requiredAssets, full.requiredAssets);
  assert.deepEqual(bounded.support, full.support);
});
