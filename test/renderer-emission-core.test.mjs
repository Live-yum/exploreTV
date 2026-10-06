import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { planScene, renderScene } from "../core/renderer.mjs";
import { prepareSceneFrames } from "../core/scene-frames.mjs";
import { registerTextureSource } from "../core/assets.mjs";

const tile = (type = 1, extra = {}) => ({
  active: true,
  type,
  frameX: null,
  frameY: null,
  shape: 0,
  wall: 1,
  ...extra,
});
function region(width = 18, height = 16, x = 100, y = 200) {
  return {
    rect: { x, y, width, height },
    cells: Array.from({ length: width * height }, () => tile()),
  };
}
function put(r, x, y, extra) {
  const i = x * r.rect.height + y;
  r.cells[i] = { ...r.cells[i], ...extra };
}
function coreOf(r, x = 6, y = 5, width = 5, height = 4) {
  return { x: r.rect.x + x, y: r.rect.y + y, width, height };
}
function diagnostics(plan) {
  const { commands, generationCulling, ...diagnostics } = plan;
  return diagnostics;
}
function inCore(c, r, core) {
  return (
    c.x + r.rect.x >= core.x &&
    c.y + r.rect.y >= core.y &&
    c.x + r.rect.x < core.x + core.width &&
    c.y + r.rect.y < core.y + core.height
  );
}
// Independent pixel-space envelope, including the original one-pixel guard.
// Deliberately use the full 16px tile envelope even for a half block.
function outsideEnvelope(c, r, core) {
  const wall = c.kind === "wall",
    size = wall ? 32 : 16,
    left = (core.x - r.rect.x) * 16,
    top = (core.y - r.rect.y) * 16,
    dx = c.x * 16 - (wall ? 8 : 0),
    dy = c.y * 16 - (wall ? 8 : 0);
  return (
    dx + size + 1 <= left ||
    dy + size + 1 <= top ||
    dx - 1 >= left + core.width * 16 ||
    dy - 1 >= top + core.height * 16
  );
}
function assertEquivalent(r, core, options = {}, isOrdinary = () => true) {
  const before = structuredClone(r),
    reference = planScene(r, options),
    actual = planScene(r, { ...options, emissionCore: core }),
    retained = reference.commands.filter(
      (c) => !isOrdinary(c) || !outsideEnvelope(c, r, core),
    );
  assert.deepEqual(
    actual.commands,
    retained,
    "ordered retained commands match the uncropped reference",
  );
  assert.deepEqual(diagnostics(actual), diagnostics(reference));
  assert.deepEqual(
    actual.commands.filter((c) => inCore(c, r, core)),
    reference.commands.filter((c) => inCore(c, r, core)),
    "all core owner commands survive",
  );
  assert.deepEqual(actual.generationCulling, {
    culledCommands: reference.commands.length - actual.commands.length,
    logicalCommands: reference.commands.length,
  });
  assert.deepEqual(
    r,
    before,
    "planning does not mutate source cells or context",
  );
  return { reference, actual };
}

test("emission core retains complete read context, support, assets and ordered commands at signed world coordinates", () => {
  for (const [x, y] of [
    [100, 200],
    [-25, -18],
    [0, 0],
  ]) {
    const r = region(18, 16, x, y),
      core = coreOf(r);
    r.cells.forEach((t, i) =>
      Object.assign(t, {
        shape: i % 6,
        paint: i % 32,
        wallPaint: (i * 3) % 32,
        inactive: i % 7 === 0,
        fullbrightBlock: i % 5 === 0,
        fullbrightWall: i % 11 === 0,
        invisibleBlock: i % 17 === 0,
        invisibleWall: i % 19 === 0,
        wireRed: i % 23 === 0,
      }),
    );
    // These texture names occur only in owners that cannot affect the core.
    put(r, 0, 0, {
      type: 2,
      wall: 2,
      invisibleBlock: false,
      invisibleWall: false,
    });
    for (const revealInvisible of [false, true])
      for (const paintEnabled of [false, true]) {
        const { actual } = assertEquivalent(r, core, {
          revealInvisible,
          paintEnabled,
        });
        assert.ok(actual.generationCulling.culledCommands > 400);
        assert.ok(actual.requiredAssets.includes("Tiles_2.png"));
        assert.ok(actual.requiredAssets.includes("Wall_2.png"));
        assert.equal(
          actual.commands.some((c) => c.asset === "Tiles_2.png"),
          false,
        );
        assert.equal(
          actual.commands.some((c) => c.asset === "Wall_2.png"),
          false,
        );
      }
  }
});

test("all four scene edges and the one-cell wall/antialiasing ring retain reference framing", () => {
  const r = region(12, 12);
  for (const [x, y] of [
    [0, 0],
    [9, 0],
    [0, 9],
    [9, 9],
    [4, 4],
  ]) {
    const core = coreOf(r, x, y, 3, 3),
      { actual } = assertEquivalent(r, core);
    assert.ok(actual.commands.some((c) => c.x === x && c.y === y));
    for (const [rx, ry] of [
      [x - 1, y],
      [x + 3, y],
      [x, y - 1],
      [x, y + 3],
    ])
      if (rx >= 0 && ry >= 0 && rx < 12 && ry < 12) {
        assert.equal(
          actual.commands.filter((c) => c.x === rx && c.y === ry).length,
          2,
        );
      }
  }
  const complete = planScene(r),
    explicit = planScene(r, { emissionCore: r.rect });
  assert.deepEqual(explicit.commands, complete.commands);
  assert.equal(explicit.generationCulling.culledCommands, 0);
  assert.equal(Object.hasOwn(complete, "generationCulling"), false);
});

test("stored frames, special layers, flames, trees, hidden emitters and waterfall ordering stay on their existing paths", () => {
  const r = region(24, 24),
    core = coreOf(r, 9, 8, 5, 4);
  r.source = { width: 8400, height: 2400, worldSurface: 649 };
  r.treeContext = {
    hallowBG: 3,
    treeX: [1923, 3451, 6191],
    treeTopVariations: [3, 0, 5, 4, 0, 2, 32, 3, 0, 0, 0, 0, 0],
  };
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 2; y++)
      put(r, x, y, { type: 237, frameX: x * 18, frameY: y * 18 });
  put(r, 1, 4, { type: 33, frameX: 0, frameY: 0 });
  put(r, 2, 4, { type: 21, frameX: 36, frameY: 18, shape: 2, paint: 31 });
  put(r, 3, 4, { type: 4, frameX: 0, frameY: 0 });
  put(r, 4, 4, { type: 373 });
  put(r, 5, 4, { type: 999 });
  put(r, 6, 4, { type: 1, frameX: 18, frameY: 18 });
  put(r, 18, 15, { type: 5, frameX: 22, frameY: 220 });
  for (let y = 16; y < 21; y++)
    put(r, 18, y, { type: 5, frameX: 0, frameY: 0 });
  put(r, 18, 21, { type: 109 });
  put(r, 10, 9, { active: false, liquid: 255, liquidKind: 1 });
  const waterfall = {
    kind: "waterfall",
    asset: "Waterfall_0.png",
    sx: 0,
    sy: 0,
    sw: 16,
    sh: 16,
    dx: 160,
    dy: 144,
    dw: 16,
    dh: 16,
    x: 10,
    y: 9,
  };
  const options = {
    paintEnabled: true,
    liquids: {
      enabled: true,
      layer: "foreground",
      worldSurface: 649,
      waterfallRegistry: {
        hasOrigin: () => false,
        commandsFor: () => [{ ...waterfall }],
        model: "test-registry",
        scanComplete: true,
        stats: {},
      },
    },
  };
  const { reference, actual } = assertEquivalent(
    r,
    core,
    options,
    (c) =>
      c.kind === "wall" || (c.kind === "tile" && c.fidelity === "approximate"),
  );
  assert.ok(reference.support.staticSpecialObjects > 0);
  assert.ok(reference.support.staticFlames > 0);
  assert.ok(reference.support.staticTrees > 0);
  assert.ok(reference.support.sourceHiddenTiles > 0);
  assert.ok(reference.support.unsupportedTiles >= 2);
  assert.ok(reference.commands.some((c) => c.kind === "liquid"));
  assert.ok(reference.commands.some((c) => c.kind === "waterfall"));
  assert.ok(actual.commands.some((c) => c.specialLayer === "over-tiles"));
  assert.ok(
    actual.commands.some((c) => c.treePart === "crown" && !inCore(c, r, core)),
  );
});

test("selection contexts retain exterior special owners and unresolved context diagnostics", () => {
  const context = region(24, 24, 96, 196);
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 2; y++)
      put(context, 8 + x, 20 + y, {
        type: 237,
        frameX: x * 18,
        frameY: y * 18,
      });
  put(context, 2, 6, { type: 597, frameX: 0, frameY: 0 });
  const r = region(16, 16, 100, 200);
  r.context = context;
  for (let x = 0; x < 16; x++)
    for (let y = 0; y < 16; y++)
      r.cells[x * 16 + y] = { ...context.cells[(x + 4) * 24 + y + 4] };
  const { reference } = assertEquivalent(
    r,
    coreOf(r),
    { paintEnabled: true },
    (c) =>
      c.kind === "wall" || (c.kind === "tile" && c.fidelity === "approximate"),
  );
  assert.ok(reference.support.contextCommands > 0);
  assert.ok(reference.contextOmissions.length > 0);
  assert.ok(
    reference.commands.some((c) => c.contextOnly && c.y >= r.rect.height),
  );
});

test("disabled tile and wall passes keep their full support and exact logical budgets", () => {
  const r = region(),
    core = coreOf(r);
  for (const tiles of [false, true])
    for (const walls of [false, true])
      assertEquivalent(r, core, { tiles, walls });
});

test("culling cannot waive logical command budgets or unsupported shape diagnostics", () => {
  const r = region(10, 10),
    core = coreOf(r, 4, 4, 1, 1);
  const reference = planScene(r),
    budget = reference.commands.length;
  assert.equal(
    planScene(r, { emissionCore: core, maxCommands: budget }).generationCulling
      .logicalCommands,
    budget,
  );
  assert.throws(
    () => planScene(r, { emissionCore: core, maxCommands: budget - 1 }),
    /command budget exceeded/,
  );
  put(r, 0, 0, { shape: 6 });
  put(r, 0, 1, { shape: -1 });
  const { actual } = assertEquivalent(r, core);
  assert.equal(actual.support.unsupportedTiles, 2);
});

test("malformed IDs and noncanonical shapes retain legacy commands while safe ordinary owners are omitted", () => {
  const r = region(16, 16),
    core = coreOf(r);
  for (const [y, shape] of ["2", "02", 2.5, NaN, "5"].entries())
    put(r, 0, y, { shape });
  for (const [y, wall] of ["1", 1.5, Infinity, -1, 1024].entries())
    put(r, 1, y, { wall });
  put(r, 2, 0, { type: "1" });
  put(r, 2, 1, { type: 1, frameX: 0, frameY: 0 });
  const reference = planScene(r),
    actual = planScene(r, { emissionCore: core });
  assert.deepEqual(diagnostics(actual), diagnostics(reference));
  for (const c of reference.commands) {
    const t = r.cells[c.x * r.rect.height + c.y],
      noncanonical =
        c.kind === "tile"
          ? !Number.isInteger(t.shape || 0)
          : !Number.isInteger(t.wall) || t.wall < 1 || t.wall > 1023;
    if (noncanonical)
      assert.deepEqual(
        actual.commands.find(
          (a) => a.kind === c.kind && a.x === c.x && a.y === c.y,
        ),
        c,
      );
  }
});

test("emission core rejects malformed, overflowing and uncontained coordinates before pruning", () => {
  const r = region(),
    valid = coreOf(r);
  for (const core of [
    null,
    false,
    {},
    { ...valid, x: NaN },
    { ...valid, y: Infinity },
    { ...valid, width: 0 },
    { ...valid, width: 1.5 },
    { ...valid, height: -1 },
    { ...valid, x: "106" },
    { ...valid, x: r.rect.x - 1 },
    { ...valid, width: r.rect.width },
    { ...valid, x: Number.MAX_SAFE_INTEGER },
  ])
    assert.throws(() => planScene(r, { emissionCore: core }), /Emission core/);
  for (const origin of [
    undefined,
    NaN,
    Infinity,
    "100",
    1.5,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const malformed = { ...r, rect: { ...r.rect, x: origin } };
    assert.throws(
      () => planScene(malformed, { emissionCore: valid }),
      /Emission core/,
    );
  }
});

function assetsForPixels() {
  const assets = new Map();
  for (const [name, seed] of [
    ["Tiles_1.png", 19],
    ["Wall_1.png", 47],
  ]) {
    const width = 512,
      height = 256,
      canvas = createCanvas(width, height),
      ctx = canvas.getContext("2d"),
      data = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        data.data.set(
          [
            (x * 7 + seed) % 256,
            (y * 3 + seed) % 256,
            (x + y + seed) % 256,
            [31, 127, 191, 255][(x + y) % 4],
          ],
          (y * width + x) * 4,
        );
    ctx.putImageData(data, 0, 0);
    assets.set(
      name,
      registerTextureSource(canvas, {
        pngBytes: canvas.toBuffer("image/png"),
        rawRgba: { width, height, data: new Uint8Array(data.data) },
      }),
    );
  }
  return assets;
}
function drawPixels(plan, assets, r, core) {
  const canvas = createCanvas(core.width * 16, core.height * 16),
    ctx = canvas.getContext("2d"),
    frames = prepareSceneFrames(plan, assets, createCanvas, {
      inputEncoding: "tconvert-game-raw",
      opaqueScene: true,
    });
  try {
    ctx.translate((r.rect.x - core.x) * 16, (r.rect.y - core.y) * 16);
    const result = renderScene(ctx, plan, assets, {
      sceneFrames: frames,
      strict: true,
    });
    assert.equal(result.skippedEffects, 0);
    return new Uint8Array(
      ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    );
  } finally {
    frames.dispose();
    canvas.width = canvas.height = 1;
  }
}
test("generation-time omission preserves fullbright painted raw/additive core pixels and private slope clips", () => {
  const r = region(14, 12, -10, -7),
    core = coreOf(r, 5, 4, 4, 3),
    assets = assetsForPixels();
  r.cells.forEach((t, i) =>
    Object.assign(t, {
      shape: i % 6,
      paint: [0, 26, 30, 31][i % 4],
      wallPaint: [0, 26, 30, 31][i % 4],
      fullbrightBlock: true,
      fullbrightWall: true,
    }),
  );
  const options = { paintEnabled: true },
    { reference, actual } = assertEquivalent(r, core, options);
  assert.deepEqual(
    drawPixels(actual, assets, r, core),
    drawPixels(reference, assets, r, core),
  );
  const other = planScene(r, { ...options, emissionCore: core }),
    sloped = actual.commands.filter((c) => c.clip),
    previous = structuredClone(other.commands.filter((c) => c.clip));
  assert.ok(sloped.length > 2);
  sloped[0].clip[0][0] = 999;
  assert.deepEqual(
    other.commands.filter((c) => c.clip),
    previous,
  );
  assert.notEqual(sloped[0].clip, sloped[1].clip);
  for (const canvas of assets.values()) canvas.width = canvas.height = 1;
});
