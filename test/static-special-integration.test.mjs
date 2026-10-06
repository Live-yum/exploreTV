import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { record } from "./fixture.mjs";
import {
  Reader,
  decodeRecord,
  openWorld,
  extractSceneRegion,
} from "../core/world.mjs";
import { planScene, renderScene } from "../core/renderer.mjs";
import { prepareSceneFrames } from "../core/scene-frames.mjs";
import { registerTextureSource } from "../core/assets.mjs";
import { decodePngRgba } from "../core/png-rgba.mjs";
import { saveFragment, loadFragment } from "../core/fragment.mjs";
import { STATIC_SPECIAL_OBJECT_ASSETS } from "../core/static-special-objects.mjs";

const fixtureRect = { x: 100, y: 200, width: 16, height: 16 };
const origin = { x: 106, y: 207 };
const frameTable = new Uint8Array(754);
for (const type of [237, 597, 617, 711]) frameTable[type] = 1;
const index = (r, x, y) => (x - r.rect.x) * r.rect.height + y - r.rect.y;
function fixture(type, { style = 0, direction = 0, wall = false } = {}) {
  const r = {
    rect: { ...fixtureRect },
    version: 315,
    important: frameTable,
    source: {
      signature: "relogic",
      name: "Special integration",
      id: 1,
      width: 300,
      height: 400,
    },
    raw: Array.from({ length: 256 }, () =>
      record({ type: null, wall: wall ? 1 : 0 }),
    ),
    cells: [],
  };
  const width = type === 711 ? 2 : 3,
    height = type === 237 || type === 711 ? 2 : 4;
  for (let col = 0; col < width; col++)
    for (let row = 0; row < height; row++)
      r.raw[index(r, origin.x + col, origin.y + row)] = record({
        type,
        frame: [
          style * width * 18 + col * 18,
          direction * height * 18 + row * 18,
        ],
        wall: wall ? 1 : 0,
      });
  r.cells = r.raw.map((raw) => decodeRecord(new Reader(raw), frameTable).tile);
  return r;
}
function putBlock(r, x, y) {
  const i = index(r, x, y);
  r.raw[i] = record({ type: 1, wall: r.cells[i].wall });
  r.cells[i] = decodeRecord(new Reader(r.raw[i]), frameTable).tile;
}
function select(full, rect) {
  const cells = [],
    raw = [];
  for (let x = rect.x; x < rect.x + rect.width; x++)
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      const i = index(full, x, y);
      cells.push({ ...full.cells[i] });
      raw.push(full.raw[i].slice());
    }
  return { ...full, rect: { ...rect }, cells, raw, context: full };
}
const assetsPromise = (async () => {
  const assets = new Map();
  for (const name of Object.keys(STATIC_SPECIAL_OBJECT_ASSETS)) {
    const path = new URL(`../example/assets/${name}`, import.meta.url);
    const bytes = readFileSync(path);
    assets.set(
      name,
      registerTextureSource(await loadImage(bytes), {
        pngBytes: bytes,
        rawRgba: decodePngRgba(bytes),
      }),
    );
  }
  // Constant opaque atlases isolate ordering from unrelated adjacency rules.
  for (const [name, color] of [
    ["Tiles_1.png", "#2080d0"],
    ["Wall_1.png", "#183028"],
  ]) {
    const canvas = createCanvas(512, 512),
      ctx = canvas.getContext("2d");
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 512, 512);
    const bytes = canvas.toBuffer("image/png");
    assets.set(
      name,
      registerTextureSource(canvas, {
        pngBytes: bytes,
        rawRgba: decodePngRgba(bytes),
      }),
    );
  }
  return assets;
})();
async function draw(region, options = {}) {
  const plan = planScene(region, { paintEnabled: true, ...options });
  assert.equal(
    plan.support.unsupportedTiles,
    0,
    JSON.stringify(plan.unsupportedCells),
  );
  assert.equal(
    plan.contextOmissions.length,
    0,
    JSON.stringify(plan.contextOmissions),
  );
  const assets = await assetsPromise;
  const frames = prepareSceneFrames(plan, assets, createCanvas, {
    inputEncoding: "tconvert-game-raw",
    opaqueScene: true,
  });
  assert.equal(
    frames.support.unsupportedCommands,
    0,
    JSON.stringify(frames.support),
  );
  const canvas = createCanvas(plan.width, plan.height),
    ctx = canvas.getContext("2d");
  const result = renderScene(ctx, plan, assets, {
    strict: true,
    sceneFrames: frames,
  });
  assert.equal(result.skippedEffects, 0);
  frames.dispose();
  return { plan, canvas, ctx };
}
function diffPixels(expected, actual, width) {
  let count = 0,
    first = null;
  for (let i = 0; i < expected.length; i += 4)
    if (expected.slice(i, i + 4).some((v, j) => v !== actual[i + j])) {
      count++;
      first ??= {
        x: (i / 4) % width,
        y: Math.floor(i / 4 / width),
        expected: [...expected.slice(i, i + 4)],
        actual: [...actual.slice(i, i + 4)],
      };
    }
  return { count, first };
}
async function assertCrop(full, rect, label, options = {}) {
  const before = JSON.stringify({ cells: full.cells, raw: full.raw });
  const fullDraw = await draw(full, options),
    selection = select(full, rect),
    part = await draw(selection, options);
  const expected = fullDraw.ctx.getImageData(
    (rect.x - full.rect.x) * 16,
    (rect.y - full.rect.y) * 16,
    rect.width * 16,
    rect.height * 16,
  ).data;
  const actual = part.ctx.getImageData(
    0,
    0,
    rect.width * 16,
    rect.height * 16,
  ).data;
  const difference = diffPixels(expected, actual, rect.width * 16);
  assert.equal(difference.count, 0, `${label}: ${JSON.stringify(difference)}`);
  assert.equal(JSON.stringify({ cells: full.cells, raw: full.raw }), before);
  const restored = loadFragment(saveFragment(selection));
  assert.deepEqual(restored.cells, selection.cells);
  assert.deepEqual(restored.raw, selection.raw);
  assert.equal(restored.raw.length, rect.width * rect.height);
  assert.equal(restored.context, undefined);
  assert.equal(
    part.plan.support.tiles,
    selection.cells.filter(
      (t) => t.active && (options.revealInvisible || !t.invisibleBlock),
    ).length,
  );
  return { fullDraw, part, selection };
}

test("selection context reproduces actual special sprites with external owners and no duplicate overlays", async () => {
  for (const type of [237, 597, 617, 711]) {
    const r = fixture(type, {
      style: type === 597 ? 10 : type === 617 ? 27 : 0,
      direction: type === 617 ? 1 : 0,
    });
    for (const rect of [
      { x: 106, y: 203, width: 3, height: 4 }, // Altar orb, owner entirely below selection.
      { x: 105, y: 206, width: 1, height: 6 }, // Left extra overhang.
      { x: 107, y: 208, width: 1, height: 1 }, // Origin excluded, middle child selected.
      { x: 106, y: type === 711 ? 209 : 211, width: 3, height: 1 }, // Downward body overhang.
    ])
      await assertCrop(r, rect, `type ${type} ${JSON.stringify(rect)}`);
  }
});

for (const type of [597, 617, 711])
  test(`type ${type} external body keeps its world drawing order behind an opaque lower tile`, async () => {
    const r = fixture(type),
      floorY = origin.y + (type === 711 ? 2 : 4);
    putBlock(r, origin.x, floorY);
    const { part } = await assertCrop(
      r,
      { x: origin.x, y: floorY, width: 1, height: 1 },
      `type ${type} bottom body must not cover selected floor`,
    );
    assert.ok(
      part.plan.support.contextCommands > 0,
      "exercise an intersecting external body",
    );
    assert.equal(
      part.plan.support.staticSpecialObjects,
      0,
      "external body must not count as selected object",
    );
  });

test("behind-object extras stay above walls and below opaque ordinary tiles", async () => {
  const r = fixture(711, { wall: true });
  putBlock(r, origin.x - 1, origin.y);
  const result = await assertCrop(
    r,
    { x: origin.x - 1, y: origin.y, width: 1, height: 2 },
    "rainbow halo occlusion",
  );
  const p = result.fullDraw.plan;
  const halo = p.commands.findIndex((c) => c.role === "rainbow-halo");
  assert.ok(halo > p.commands.findLastIndex((c) => c.kind === "wall"));
  assert.ok(
    halo < p.commands.findIndex((c) => c.kind === "tile" && c.type === 1),
  );
  const actual = result.part.ctx.getImageData(0, 0, 16, 16).data;
  for (let i = 0; i < actual.length; i += 4)
    assert.deepEqual([...actual.slice(i, i + 4)], [32, 128, 208, 255]);
});

test("over-tiles orb survives an opaque selected tile even when its emitting cell is outside", async () => {
  const r = fixture(237, { wall: true });
  putBlock(r, origin.x + 1, origin.y - 3);
  const { part } = await assertCrop(
    r,
    { x: origin.x + 1, y: origin.y - 3, width: 1, height: 1 },
    "orb over selected opaque tile",
  );
  const p = part.plan,
    orb = p.commands.findIndex((c) => c.role === "altar-orb");
  assert.ok(
    orb > p.commands.findIndex((c) => c.type === 1 && c.kind === "tile"),
  );
  assert.equal(p.commands.filter((c) => c.role === "altar-orb").length, 1);
  assert.equal(p.commands[orb].contextOnly, true);
  const pixels = part.ctx.getImageData(0, 0, 16, 16).data;
  assert.ok(
    pixels.some((v, i) => i % 4 === 0 && v > 32),
    "orb must actually change opaque foreground pixels",
  );
});

test("overlapping selected and external relic halos preserve world owner order", async () => {
  const r = fixture(617, { style: 1 }),
    right = fixture(617, { style: 4 });
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 4; y++) {
      const from = index(right, origin.x + x, origin.y + y),
        to = index(r, origin.x + 3 + x, origin.y + y);
      r.raw[to] = right.raw[from].slice();
      r.cells[to] = { ...right.cells[from] };
    }
  const { part } = await assertCrop(
    r,
    { x: origin.x + 3, y: origin.y, width: 3, height: 4 },
    "adjacent relic over-tiles ordering",
  );
  assert.ok(
    part.plan.commands.some((c) => c.role === "relic-halo" && c.contextOnly),
  );
});

test("external pylon visibility and fullbright child coating match the full scene", async () => {
  for (const revealInvisible of [false, true]) {
    const r = fixture(597, { style: 10 }),
      i = index(r, origin.x + 1, origin.y + 1);
    r.raw[i] = record({
      type: 597,
      frame: [558, 18],
      paint: 7,
      invisibleBlock: true,
      fullbrightBlock: true,
    });
    r.cells[i] = decodeRecord(new Reader(r.raw[i]), frameTable).tile;
    const { part } = await assertCrop(
      r,
      { x: origin.x, y: origin.y - 1, width: 3, height: 1 },
      "external pylon coating",
      { revealInvisible },
    );
    const glows = part.plan.commands.filter((c) => c.role === "pylon-halo");
    if (revealInvisible) {
      assert.ok(glows.length > 0);
      assert.ok(glows.every((c) => c.paintId === 0 && c.fullbrightBlock));
    } else assert.equal(glows.length, 0);
  }
});

test(
  "actual-map selection fragment preserves only its selected raw records",
  {
    skip: !existsSync(
      new URL("../fixtures/example-world.wld", import.meta.url),
    ),
  },
  () => {
    const w = openWorld(
      readFileSync(new URL("../fixtures/example-world.wld", import.meta.url)),
    );
    for (const rect of [
      { x: 1374, y: 1104, width: 1, height: 1 },
      { x: 836, y: 850, width: 1, height: 1 },
      { x: 4550, y: 489, width: 1, height: 1 },
      { x: 1845, y: 998, width: 1, height: 1 },
    ]) {
      const region = extractSceneRegion(w, rect),
        raw = region.raw.map((b) => b.slice()),
        cells = structuredClone(region.cells);
      const plan = planScene(region, { paintEnabled: true });
      assert.ok(plan.support.contextCommands > 0, JSON.stringify(rect));
      const out = loadFragment(saveFragment(region));
      assert.deepEqual(out.raw, raw);
      assert.deepEqual(out.cells, cells);
      assert.equal(out.raw.length, 1);
      assert.equal(out.context, undefined);
      assert.deepEqual(region.raw, raw);
      assert.deepEqual(region.cells, cells);
    }
  },
);
