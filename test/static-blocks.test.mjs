import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodePngRgba } from "../core/png-rgba.mjs";
import {
  planStaticBlock,
  multiplyStaticVertexColor,
  STATIC_SOLID_BLOCKS,
  STATIC_THORN_TILES,
} from "../core/static-blocks.mjs";
import { splitPremultipliedRGBA } from "../core/scene-frames.mjs";

const tile = (type, extra = {}) => ({
  type,
  active: true,
  frameX: null,
  frameY: null,
  shape: 0,
  ...extra,
});
function fixture(type, neighbors = {}) {
  const t = tile(type),
    cells = Array(9).fill(null);
  cells[4] = t;
  for (const [slot, value] of Object.entries(neighbors))
    cells[Number(slot)] = value;
  return {
    tile: t,
    region: { rect: { x: 50, y: 600, width: 3, height: 3 }, cells },
  };
}
const plan = (f, options) => planStaticBlock(f.region, 1, 1, f.tile, options);
const first = (p) => (Array.isArray(p) ? p[0] : p);

test("additional ordinary-material atlases decode and every static cardinal crop is real and nonempty", () => {
  for (const id of [158, 311, 321, 357, 369, 399, 495, 668]) {
    const atlas = decodePngRgba(readFileSync(new URL(`../example/assets/Tiles_${id}.png`, import.meta.url)));
    for (let mask = 0; mask < 16; mask++) {
      const neighbors = {};
      for (const [bit, slot] of [[1,3],[2,1],[4,7],[8,5]])
        if (mask & bit) neighbors[slot] = tile(id);
      const f = fixture(id, neighbors), before = JSON.stringify(f), c = first(plan(f));
      assert.equal(c.asset, `Tiles_${id}.png`);
      assert.equal(c.fidelity, "approximate-static-block");
      assert.ok(c.sx >= 0 && c.sy >= 0 && c.sx+c.sw <= atlas.width && c.sy+c.sh <= atlas.height);
      let nonempty = false;
      for (let y = c.sy; y < c.sy+c.sh; y++)
        for (let x = c.sx; x < c.sx+c.sw; x++)
          nonempty ||= atlas.data[(y*atlas.width+x)*4+3] !== 0;
      assert.ok(nonempty, `${id}, mask ${mask}`);
      assert.equal(JSON.stringify(f), before);
    }
  }
});

test("verified full blocks select real cardinal atlas sprites without inventing persisted frames", () => {
  for (const id of STATIC_SOLID_BLOCKS) {
    const f = fixture(id, {
      1: tile(id),
      3: tile(id),
      5: tile(id),
      7: tile(id),
    });
    const before = JSON.stringify(f);
    const c = first(plan(f));
    assert.deepEqual(
      [c.sx, c.sy, c.sw, c.sh, c.offsetX, c.offsetY],
      [18, 18, 16, 16, 0, 0],
    );
    assert.equal(c.asset, `Tiles_${id}.png`);
    assert.equal(c.fidelity, "approximate-static-block");
    assert.equal(JSON.stringify(f), before);
  }
});

test("isolated cracked brick and joined leaves retain distinct source frames", () => {
  const lone = first(plan(fixture(481)));
  assert.deepEqual([lone.sx, lone.sy], [162, 54]);
  const leaves = first(plan(fixture(384, { 7: tile(384) })));
  assert.deepEqual([leaves.sx, leaves.sy], [162, 0]);
  const crossMaterial = first(plan(fixture(384, { 7: tile(383) })));
  assert.deepEqual([crossMaterial.sx, crossMaterial.sy], [162, 54]);
});

test("thorn sprites are 18px high and connect only to their verified bottom anchors", () => {
  for (const [id, root] of [
    [32, 23],
    [69, 60],
    [352, 199],
    [655, 60],
  ]) {
    const down = plan(fixture(id, { 5: tile(root) }));
    assert.deepEqual([down.sx, down.sy, down.sw, down.sh], [108, 0, 16, 18]);
    const side = plan(fixture(id, { 7: tile(root) }));
    assert.deepEqual([side.sx, side.sy], [162, 54]);
    const wrong = plan(fixture(id, { 5: tile(1) }));
    assert.deepEqual([wrong.sx, wrong.sy], [162, 54]);
  }
});

test("hidden adjacent cells do not change a revealed cell's approximate silhouette", () => {
  const f = fixture(162, { 7: tile(162, { invisibleBlock: true }) });
  assert.deepEqual([first(plan(f)).sx, first(plan(f)).sy], [162, 54]);
  assert.deepEqual(
    [
      first(plan(f, { revealInvisible: true })).sx,
      first(plan(f, { revealInvisible: true })).sy,
    ],
    [162, 0],
  );
});

test("moss and ash grass retain their own unpainted static texture overlay", () => {
  for (const [id, asset, color] of [
    [381, "Glow_126.png", [150, 100, 50, 0]],
    [539, "Glow_263.png", [225, 0, 125, 0]],
    [633, "Glow_326.png", [255, 255, 255, 255]],
  ]) {
    const f = fixture(id);
    f.tile.paint = 26;
    const [base, overlay] = plan(f);
    assert.equal(overlay.asset, asset);
    assert.deepEqual(overlay.vertexColor, color);
    assert.equal(overlay.paintId, 0);
    assert.equal(overlay.staticOverlay, true);
    assert.deepEqual(
      [overlay.sx, overlay.sy, overlay.sw, overlay.sh],
      [base.sx, base.sy, base.sw, base.sh],
    );
  }
});

test("alpha-zero moss vertex colors preserve additive RGB through frame preparation", () => {
  const tinted = multiplyStaticVertexColor(
    [255, 128, 64, 200],
    [150, 100, 50, 0],
  );
  assert.deepEqual([...tinted], [150, 50, 13, 0]);
  const split = splitPremultipliedRGBA(tinted, { opaqueScene: true });
  assert.deepEqual([...split.base], [0, 0, 0, 0]);
  assert.ok(split.additive);
  assert.equal(split.additive[3], 150);
  assert.throws(() => splitPremultipliedRGBA(tinted), /opaque/i);
  assert.deepEqual(
    [...multiplyStaticVertexColor([20, 30, 40, 100])],
    [20, 30, 40, 100],
  );
});

test("unknown, stored-frame and unsupported thorn-shape inputs stay explicit", () => {
  assert.equal(plan(fixture(753)), null);
  assert.equal(plan(fixture(165)), null);
  const f = fixture(162);
  f.tile.frameX = 0;
  f.tile.frameY = 0;
  assert.match(plan(f).unsupported, /non-persisted/);
  for (const id of STATIC_THORN_TILES) {
    const f = fixture(id);
    f.tile.shape = 1;
    assert.match(plan(f).unsupported, /slopes/);
  }
  assert.throws(
    () => multiplyStaticVertexColor([0, 0, 0, 255], [256, 0, 0, 0]),
    RangeError,
  );
  assert.throws(() => multiplyStaticVertexColor([0, 0, NaN, 255]), RangeError);
});
