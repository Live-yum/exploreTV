import test from "node:test";
import assert from "node:assert/strict";
import { planStaticTree } from "../core/static-trees.mjs";
import { readWorldTreeContext } from "../core/world-tree-context.mjs";
import { openWorld } from "../core/world.mjs";
import { fixtureWorld, Writer } from "./fixture.mjs";

const metadata = () => ({
  treeX: [1923, 3451, 6191],
  treeTopVariations: [3, 0, 5, 4, 0, 2, 32, 3, 0, 0, 0, 0, 0],
  worldSurface: 649,
  worldWidth: 8400,
  worldHeight: 2400,
  hallowBG: 3,
});
function scene({
  wx = 100,
  wy = 500,
  frameX = 22,
  frameY = 198,
  type = 5,
  floorType = 2,
  floorY = wy + 20,
  treeContext = metadata(),
  rootX = wx,
  paint = 0,
} = {}) {
  const tile = { active: true, type, frameX, frameY, paint, shape: 0 };
  const region = {
    rect: { x: wx, y: wy, width: 1, height: 1 },
    cells: [tile],
    source: { width: 8400, height: 2400, treeContext },
  };
  const getWorldTile = (x, y) => {
    if (x !== rootX) return { active: false, type: 0 };
    return y < floorY
      ? { ...tile, frameX: 0, frameY: 0 }
      : { active: true, type: floorType };
  };
  return {
    tile,
    region,
    getWorldTile,
    plan: () => planStaticTree(region, 0, 0, tile, { getWorldTile }),
  };
}

test("forest crown uses saved variation and inclusive world-boundary selection", () => {
  for (const [wx, style] of [
    [1923, 8],
    [1924, 0],
    [3451, 0],
    [3452, 10],
    [6191, 10],
    [6192, 9],
  ]) {
    const p = scene({ wx }).plan();
    assert.equal(p.supported, true);
    assert.equal(p.foliage.style, style);
    assert.ok(p.requiredAssets.includes(`Tree_Tops_${style}.png`));
    assert.deepEqual(p.commands[0], {
      kind: "tile",
      asset: "Tiles_5.png",
      sx: 22,
      sy: 198,
      sw: 20,
      sh: 20,
      dx: -2,
      dy: 0,
      dw: 20,
      dh: 20,
      x: 0,
      y: 0,
      type: 5,
      paintId: 0,
      flipX: false,
      flipY: false,
      treePart: "trunk",
      treeStyle: -1,
      foliageStyle: 0,
      fidelity: "source-static-tree",
    });
  }
});

test("jungle, snow and hallow foliage match ground, depth, world side and stored frame", () => {
  const jungle = scene({ floorType: 60, wy: 700 }).plan();
  assert.equal(jungle.biome, 5);
  assert.equal(jungle.foliage.style, 13);
  assert.equal(jungle.foliage.width, 116);
  assert.equal(jungle.foliage.height, 96);
  assert.equal(scene({ floorType: 147, wx: 4000 }).plan().foliage.style, 16);
  assert.equal(scene({ floorType: 147, wx: 6000 }).plan().foliage.style, 17);
  const hallow = scene({ wx: 107, floorType: 109, frameY: 220 }).plan();
  assert.equal(hallow.foliage.style, 20);
  assert.equal(hallow.foliage.frame, 16);
  assert.equal(hallow.foliage.height, 140);
  const crown = hallow.commands.filter((c) => c.treePart === "crown"),
    pixels = new Uint8Array(80 * 140);
  assert.equal(crown.length, 6);
  for (const c of crown) {
    assert.ok(c.sw <= 64 && c.sh <= 64);
    assert.equal(c.sx - 16 * 82, c.dx + 32);
    assert.equal(c.sy, c.dy + 124);
    for (let y = c.sy; y < c.sy + c.sh; y++)
      for (let x = c.sx - 16 * 82; x < c.sx - 16 * 82 + c.sw; x++)
        pixels[y * 80 + x]++;
  }
  assert.ok(pixels.every((n) => n === 1));
});

test("branch anchors resolve the neighboring main trunk and use dedicated branch atlases", () => {
  const left = scene({
    wx: 107,
    rootX: 108,
    frameX: 44,
    frameY: 242,
    floorType: 109,
  }).plan();
  assert.equal(left.root.x, 108);
  assert.equal(left.foliage.frame, 17);
  const c = left.commands.find((c) => c.treePart === "left-branch");
  assert.equal(c.asset, "Tree_Branches_20.png");
  assert.equal(c.sx, 0);
  assert.equal(c.sy, 17 * 42);
  assert.equal(c.dx, -24);
  assert.equal(c.dy, -12);
  const right = scene({
    wx: 107,
    rootX: 106,
    frameX: 66,
    frameY: 220,
    floorType: 109,
  })
    .plan()
    .commands.find((c) => c.treePart === "right-branch");
  assert.equal(right.sx, 42);
  assert.equal(right.dx, 0);
  assert.equal(right.dy, -12);
  assert.equal(
    scene({ frameX: 66, frameY: 22, rootX: 101 }).plan().root.x,
    101,
  );
  assert.equal(scene({ frameX: 88, frameY: 88, rootX: 99 }).plan().root.x, 99);
});

test("palms preserve negative bend offsets and distinguish coast from oasis crowns", () => {
  const coast = scene({
    type: 323,
    frameX: 132,
    frameY: -16,
    floorType: 53,
  }).plan();
  assert.equal(coast.supported, true);
  assert.equal(coast.foliage.style, 15);
  assert.ok(coast.commands.every((c) => c.treePart === "palm-crown"));
  assert.equal(coast.commands[0].sx, 164);
  assert.equal(coast.commands[0].dx, -48);
  assert.equal(coast.commands[0].dy, -64);
  const trunk = scene({
    type: 323,
    frameX: 22,
    frameY: -14,
    floorType: 53,
  }).plan().commands[0];
  assert.equal(trunk.dx, -16);
  assert.equal(trunk.sy, 0);
  const oasis = scene({
    type: 323,
    wx: 1000,
    frameX: 110,
    frameY: 6,
    floorType: 116,
  }).plan();
  assert.equal(oasis.biome, 6);
  assert.equal(oasis.foliage.style, 21);
  assert.equal(oasis.commands[0].sx, 116);
  assert.equal(oasis.commands[0].sy, 196);
  assert.equal(oasis.commands[0].dx, -42);
  assert.equal(oasis.commands[0].dy, -80);
});

test("missing root/style context is explicit and never silently chooses oak", () => {
  const s = scene();
  assert.equal(
    planStaticTree(s.region, 0, 0, s.tile).reason,
    "tree-root-context-required",
  );
  assert.equal(
    scene({ treeContext: {} }).plan().reason,
    "tree-forest-style-metadata-required",
  );
  assert.equal(
    scene({ paint: 1 }).plan().reason,
    "tree-paint-style-not-yet-supported",
  );
  const huge = scene({ floorY: 1500 });
  assert.equal(huge.plan().reason, "tree-root-scan-budget");
});

test("gem, vanity and ash trees use their own trunk/canopy atlases and static ash glow sprites", () => {
  for (let type = 583; type <= 589; type++) {
    const p = scene({ type, floorType: 1 }).plan();
    assert.equal(p.supported, true);
    assert.equal(p.foliage.style, type - 561);
    assert.equal(p.foliage.width, 116);
    assert.equal(p.commands[0].asset, `Tiles_${type}.png`);
    assert.equal(p.commands[0].sx, 22);
    assert.ok(p.requiredAssets.includes(`Tree_Tops_${type - 561}.png`));
  }
  for (const [type, style] of [
    [596, 29],
    [616, 30],
  ]) {
    const p = scene({ type, floorType: 2 }).plan();
    assert.equal(p.foliage.style, style);
    assert.equal(p.foliage.width, 118);
  }
  const ash = scene({ type: 634, floorType: 633 }).plan();
  assert.equal(ash.foliage.style, 31);
  assert.ok(ash.requiredAssets.includes("Glow_315.png"));
  assert.ok(ash.requiredAssets.includes("Glow_316.png"));
  const glow = ash.commands.filter((c) => c.treeGlow);
  assert.ok(glow.length > 1);
  assert.ok(glow.every((c) => c.paintId === 0));
  const branch = scene({
    type: 634,
    floorType: 633,
    frameX: 44,
    rootX: 101,
  }).plan();
  assert.ok(branch.requiredAssets.includes("Tree_Branches_31.png"));
  assert.ok(branch.requiredAssets.includes("Glow_317.png"));
});

function metadataWorld(version) {
  const fixture = fixtureWorld({ version, width: 100, height: 100 });
  const w = new Writer()
    .i32(0)
    .zero(version >= 302 ? 9 : 8)
    .zero(8 + (version >= 284 ? 8 : 0))
    .u8(0);
  [20, 40, 70, 3, 0, 5, 4].forEach((n) => w.i32(n));
  w.zero(48);
  const number = new Uint8Array(8);
  new DataView(number.buffer).setFloat64(0, 60, true);
  w.bytes(number);
  w.zero(23 + 8 + 1)
    .zero(11 + 7 + 3 + 4 + 2)
    .zero(20 + 8 + 1 + 1 + 4 + 4 + 12);
  w.bytes([0, 1, 2, 32, 3, 5, 6, 7]).zero(10);
  w.i32(2).str("甲").str("β").zero(16);
  w.i16(3).i32(9).i32(8).i32(7);
  if (version >= 289) w.i16(2).u16(4).u16(5);
  w.zero(19)
    .zero(6)
    .i32(2)
    .i32(11)
    .i32(22)
    .zero(13 + 4 + 5 + 1 + 7);
  w.i32(13);
  const variations = [3, 0, 5, 4, 1, 2, 32, 3, 0, 0, 0, 0, 0];
  variations.forEach((n) => w.i32(n));
  const before = fixture.bytes.subarray(0, fixture.widthOffset + 4),
    tiles = fixture.bytes.subarray(fixture.tileStart),
    flags = w.finish();
  const bytes = Uint8Array.from([...before, ...flags, ...tiles]);
  const view = new DataView(bytes.buffer);
  view.setInt32(
    fixture.sectionPointerOffset + 4,
    before.length + flags.length,
    true,
  );
  view.setInt32(fixture.sectionPointerOffset + 8, bytes.length, true);
  return { world: openWorld(bytes), variations };
}

test("tree header parser walks versioned dates, banner arrays and variable strings", () => {
  for (const version of [269, 284, 289, 302, 315, 326]) {
    const { world, variations } = metadataWorld(version),
      m = readWorldTreeContext(world);
    assert.deepEqual(m.treeX, [20, 40, 70]);
    assert.deepEqual(m.treeTopVariations, variations);
    assert.equal(m.worldSurface, 60);
    assert.equal(m.snowBG, 32);
    assert.equal(m.hallowBG, 3);
    assert.equal(m.provenance.endOffset, world.sections[1]);
  }
  const { world } = metadataWorld(315),
    m = readWorldTreeContext(world);
  new DataView(
    world.bytes.buffer,
    world.bytes.byteOffset,
    world.bytes.byteLength,
  ).setInt32(m.provenance.variationsOffset, 14, true);
  assert.throws(() => readWorldTreeContext(world), /variation/);
  assert.throws(
    () => readWorldTreeContext(openWorld(fixtureWorld().bytes)),
    /Truncated|metadata/,
  );
});
