import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import {
  planStaticNature,
  STATIC_VINE_TYPES,
  COBWEB_NO_ATTACH,
} from "../core/static-nature.mjs";
import { openWorld, extractSceneRegion } from "../core/world.mjs";
import { saveFragment, loadFragment } from "../core/fragment.mjs";
import { renderScene } from "../core/renderer.mjs";
import { prepareSceneFrames } from "../core/scene-frames.mjs";
import { registerTextureSource } from "../core/assets.mjs";
import { fixtureWorld, record } from "./fixture.mjs";

const air = () => ({ active: false, type: 0, shape: 0 });
const tile = (type, extra = {}) => ({
  active: true,
  type,
  shape: 0,
  frameX: null,
  frameY: null,
  ...extra,
});
const offsets = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];
function scene(type = 51, x = 39, y = 39) {
  const r = {
    rect: { x, y, width: 3, height: 3 },
    source: { width: 100, height: 100 },
    cells: Array.from({ length: 9 }, air),
  };
  r.cells[4] = tile(type);
  return r;
}
function neighbor(r, index, value) {
  const [dx, dy] = offsets[index];
  r.cells[(1 + dx) * 3 + 1 + dy] = value;
}
const plan = (r, options) => planStaticNature(r, 1, 1, r.cells[4], options);
const crop = (result) => [result.sx, result.sy];

test("unrelated nature types are not silently claimed and malformed inputs fail explicitly", () => {
  assert.equal(plan(scene(5)), null);
  assert.equal(plan(scene(636)), null);
  assert.equal(planStaticNature(null, 0, 0, tile(51)).reason, "invalid-region");
  const r = scene();
  r.cells[4].frameX = 0;
  assert.equal(plan(r).reason, "unexpected-stored-frame");
  r.cells[4].frameX = null;
  r.cells[4].shape = 1;
  assert.equal(plan(r).reason, "shaped-nature-tile");
});

test("cobweb attaches to ordinary blocks, vines, and eligible non-solid objects but not platforms or doors", () => {
  const r = scene();
  neighbor(r, 0, tile(1));
  neighbor(r, 1, tile(62));
  neighbor(r, 2, tile(185));
  assert.deepEqual(crop(plan(r)), [18, 36]); // N+W+E, open south.
  neighbor(r, 0, tile(19));
  neighbor(r, 1, tile(10));
  assert.deepEqual(crop(plan(r)), [162, 0]); // East only.
  assert.equal(plan(r).opacity, 0.5);
  assert.equal(plan(r).fidelity, "approximate-cobweb");
  assert.equal(plan(r).flipX, false);
});

test("the no-attach facts include all team-platform loop entries and known IDs fail closed beyond 753", () => {
  assert.equal(COBWEB_NO_ATTACH.length, 67);
  for (let id = 435; id <= 439; id++) {
    const r = scene();
    neighbor(r, 0, tile(id));
    assert.deepEqual(crop(plan(r)), [162, 54]);
  }
  const r = scene();
  neighbor(r, 0, tile(753));
  assert.equal(plan(r).supported, true);
  neighbor(r, 0, tile(754));
  assert.equal(plan(r).reason, "unknown-neighbor-type");
});

test("cardinal geometry covers isolated, terminal, straight, corner, and tee sprites", () => {
  for (const [directions, expected] of [
    [[], [162, 54]],
    [[0], [108, 54]],
    [[3], [108, 0]],
    [
      [0, 3],
      [90, 0],
    ],
    [
      [1, 2],
      [108, 72],
    ],
    [
      [0, 2],
      [0, 72],
    ],
    [
      [1, 3],
      [18, 54],
    ],
    [
      [0, 2, 3],
      [0, 0],
    ],
    [
      [0, 1, 3],
      [72, 0],
    ],
  ]) {
    const r = scene();
    for (const direction of directions) neighbor(r, direction, tile(51));
    assert.deepEqual(crop(plan(r)), expected);
  }
});

test("paired diagonal holes select the documented frame priority only when all cardinal sides connect", () => {
  for (const [missing, expected] of [
    [[], [18, 18]],
    [[4], [18, 18]],
    [
      [4, 5],
      [108, 18],
    ],
    [
      [6, 7],
      [108, 36],
    ],
    [
      [4, 6],
      [180, 0],
    ],
    [
      [5, 7],
      [198, 0],
    ],
    [
      [4, 5, 6, 7],
      [108, 18],
    ],
  ]) {
    const r = scene();
    for (let index = 0; index < 8; index++)
      neighbor(r, index, missing.includes(index) ? air() : tile(1));
    assert.deepEqual(crop(plan(r)), expected);
  }
  const r = scene();
  for (let i = 0; i < 4; i++) neighbor(r, i, tile(51));
  neighbor(r, 0, air());
  assert.deepEqual(crop(plan(r)), [18, 0]);
});

test("cobweb refuses shaped and invalid neighbors in cardinal and diagonal positions", () => {
  for (const index of [0, 7]) {
    for (let shape = 1; shape <= 5; shape++) {
      const r = scene();
      neighbor(r, index, tile(1, { shape }));
      assert.equal(plan(r).reason, "shaped-neighbor");
    }
  }
  const r = scene();
  neighbor(r, 0, tile(1, { shape: 6 }));
  assert.equal(plan(r).reason, "invalid-neighbor-shape");
});

test("actuated neighbors still frame as active while invisible neighbors obey reveal mode", () => {
  const r = scene();
  neighbor(r, 0, tile(1, { inactive: true }));
  assert.deepEqual(crop(plan(r)), [108, 54]);
  neighbor(r, 0, tile(1, { invisibleBlock: true }));
  assert.deepEqual(crop(plan(r)), [162, 54]);
  assert.deepEqual(crop(plan(r, { revealInvisible: true })), [108, 54]);
  r.cells[4].invisibleBlock = true;
  assert.equal(plan(r).reason, "invisible-block");
  assert.equal(plan(r, { revealInvisible: true }).supported, true);
});

test("a cropped region uses its world-aligned halo and never invents absent neighbors", () => {
  const full = scene();
  neighbor(full, 0, tile(1));
  neighbor(full, 3, tile(62));
  const cropped = {
    rect: { x: 40, y: 40, width: 1, height: 1 },
    source: full.source,
    cells: [full.cells[4]],
    context: full,
  };
  assert.deepEqual(
    planStaticNature(cropped, 0, 0, cropped.cells[0]),
    plan(full),
  );
  delete cropped.context;
  assert.equal(
    planStaticNature(cropped, 0, 0, cropped.cells[0]).reason,
    "missing-halo",
  );
  cropped.rect.x = 0;
  cropped.rect.y = 0;
  assert.equal(
    planStaticNature(cropped, 0, 0, cropped.cells[0]).reason,
    "world-boundary",
  );
  cropped.context = { rect: {}, cells: [] };
  assert.equal(
    planStaticNature(cropped, 0, 0, cropped.cells[0]).reason,
    "invalid-context",
  );
});

test("all seven source-verified vine families share zero-wind geometry and same-type adjacency", () => {
  assert.deepEqual(STATIC_VINE_TYPES, [52, 62, 115, 205, 382, 528, 638]);
  for (const type of STATIC_VINE_TYPES) {
    const r = scene(type);
    neighbor(r, 0, tile(type));
    neighbor(r, 3, tile(type));
    const result = plan(r);
    assert.deepEqual(crop(result), [90, 0]);
    assert.equal(result.offsetY, -4);
    assert.equal(result.offsetX, 0);
    assert.equal(result.flipX, true); // world x=40, local x=1.
    assert.equal(result.opacity, 1);
    assert.equal(result.fidelity, "static-vine-zero-wind");
    r.rect.x = 40;
    assert.equal(plan(r).flipX, false); // world x=41.
  }
  const r = scene(62);
  neighbor(r, 0, tile(60));
  neighbor(r, 3, tile(52));
  assert.deepEqual(crop(plan(r)), [162, 54]);
});

test("vine framing normalizes directional slopes and halfbricks without guessing cross-type merges", () => {
  const r = scene(62);
  neighbor(r, 0, tile(1, { shape: 1 }));
  assert.deepEqual(crop(plan(r)), [108, 54]); // Top halfbrick connects.
  neighbor(r, 0, tile(19, { shape: 1 }));
  assert.deepEqual(crop(plan(r)), [162, 54]); // Platform exception.
  neighbor(r, 0, tile(1, { shape: 2 }));
  neighbor(r, 3, tile(1, { shape: 4 }));
  assert.deepEqual(crop(plan(r)), [90, 0]);
  neighbor(r, 0, tile(62, { shape: 4 }));
  neighbor(r, 3, tile(62, { shape: 2 }));
  assert.deepEqual(crop(plan(r)), [162, 54]);
  neighbor(r, 1, tile(62, { shape: 2 }));
  neighbor(r, 2, tile(62, { shape: 3 }));
  assert.deepEqual(crop(plan(r)), [162, 54]);
  neighbor(r, 1, tile(62, { shape: 3 }));
  neighbor(r, 2, tile(62, { shape: 2 }));
  assert.deepEqual(crop(plan(r)), [108, 72]);
});

// A tiny independent Canvas consumer validates the planner's placement/flip
// contract. The host renderer owns actually applying that contract in its UI.
function drawPlannedSprite(context, image, p, x, y) {
  const dx = x * 16 + p.offsetX,
    dy = y * 16 + p.offsetY;
  context.save();
  context.globalAlpha = p.opacity;
  context.imageSmoothingEnabled = false;
  context.translate(dx + (p.flipX ? p.sw : 0), dy);
  context.scale(p.flipX ? -1 : 1, 1);
  context.drawImage(image, p.sx, p.sy, p.sw, p.sh, 0, 0, p.sw, p.sh);
  context.restore();
}

test("synthetic asymmetric pixels follow the returned world-parity flip and y-minus-four contract", () => {
  const r = scene(62);
  const p = plan(r),
    atlas = createCanvas(234, 90),
    c = atlas.getContext("2d");
  c.fillStyle = "#ff0000";
  c.fillRect(p.sx, p.sy, 8, 16);
  c.fillStyle = "#0000ff";
  c.fillRect(p.sx + 8, p.sy, 8, 16);
  const output = createCanvas(48, 48),
    ctx = output.getContext("2d");
  drawPlannedSprite(ctx, atlas, p, 1, 1);
  const pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
  assert.deepEqual(pixel(16, 12), [0, 0, 255, 255]);
  assert.deepEqual(pixel(31, 12), [255, 0, 0, 255]);
  assert.deepEqual(pixel(16, 11), [0, 0, 0, 0]);
  assert.deepEqual(pixel(16, 28), [0, 0, 0, 0]);
  ctx.clearRect(0, 0, 48, 48);
  r.rect.x++;
  drawPlannedSprite(ctx, atlas, plan(r), 1, 1);
  assert.deepEqual(pixel(16, 12), [255, 0, 0, 255]);
});

test("cobweb half opacity applies once to actual prepared premultiplied pixels over a wall", () => {
  const r = scene(),
    p = plan(r);
  const atlas = createCanvas(234, 90),
    raw = new Uint8ClampedArray(234 * 90 * 4);
  for (let y = p.sy; y < p.sy + 16; y++)
    for (let x = p.sx; x < p.sx + 16; x++)
      raw.set([100, 50, 0, 128], (y * 234 + x) * 4);
  registerTextureSource(atlas, {
    pngBytes: new Uint8Array(0),
    rawRgba: { width: 234, height: 90, data: raw },
  });
  const wall = createCanvas(16, 16),
    wallContext = wall.getContext("2d");
  wallContext.fillStyle = "rgb(20,40,80)";
  wallContext.fillRect(0, 0, 16, 16);
  const wallRaw = wallContext.getImageData(0, 0, 16, 16).data;
  registerTextureSource(wall, {
    pngBytes: new Uint8Array(0),
    rawRgba: { width: 16, height: 16, data: wallRaw },
  });
  const commands = [
    {
      kind: "wall",
      type: 1,
      asset: "Wall_1.png",
      sx: 0,
      sy: 0,
      sw: 16,
      sh: 16,
      dx: 0,
      dy: 0,
      dw: 16,
      dh: 16,
      paintId: 0,
    },
    {
      ...p,
      kind: "tile",
      type: 51,
      asset: "Tiles_51.png",
      dx: 0,
      dy: 0,
      dw: 16,
      dh: 16,
      paintId: 0,
    },
  ];
  const renderPlan = { width: 16, height: 16, commands, warnings: [] };
  const assets = new Map([
    ["Wall_1.png", wall],
    ["Tiles_51.png", atlas],
  ]);
  const frames = prepareSceneFrames(renderPlan, assets, createCanvas, {
    inputEncoding: "tconvert-game-raw",
    opaqueScene: true,
  });
  try {
    const output = createCanvas(16, 16);
    const report = renderScene(output.getContext("2d"), renderPlan, assets, {
      strict: true,
      sceneFrames: frames,
    });
    assert.equal(report.drawn, 2);
    const actual = [...output.getContext("2d").getImageData(0, 0, 1, 1).data];
    const expected = [
      50 + 20 * (1 - 64 / 255),
      25 + 40 * (1 - 64 / 255),
      80 * (1 - 64 / 255),
      255,
    ];
    actual.forEach((value, i) =>
      assert.ok(Math.abs(value - expected[i]) <= 2, `${actual} vs ${expected}`),
    );
  } finally {
    frames.dispose();
  }
});

test("planning never modifies source world bytes, Tile fields, or fragment serialization", () => {
  const { bytes } = fixtureWorld({
    width: 5,
    height: 5,
    version: 315,
    columns: Array.from({ length: 5 }, () =>
      Array.from({ length: 5 }, () =>
        record({ type: 62, paint: 7, red: true, fullbrightBlock: true }),
      ),
    ),
  });
  const original = bytes.slice(),
    world = openWorld(bytes);
  const region = extractSceneRegion(
    world,
    { x: 1, y: 1, width: 3, height: 3 },
    1,
  );
  const before = saveFragment(region),
    cells = structuredClone(region.cells);
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 3; y++)
      assert.equal(
        planStaticNature(region, x, y, region.cells[x * 3 + y]).supported,
        true,
      );
  assert.equal(saveFragment(region), before);
  assert.deepEqual(region.cells, cells);
  assert.deepEqual(bytes, original);
  assert.deepEqual(loadFragment(before).raw, region.raw);
});
