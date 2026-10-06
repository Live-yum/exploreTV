import test from "node:test";
import assert from "node:assert/strict";
import {
  planStaticObject,
  STATIC_OBJECT_TILES,
} from "../core/static-objects.mjs";

const region = Object.freeze({ rect: Object.freeze({ x: 101, y: 601 }) });
const tile = (type, frameX, frameY) =>
  Object.freeze({ type, frameX, frameY, active: true, shape: 0 });
const geometry = (s) => [s.sx, s.sy, s.sw, s.sh, s.offsetX, s.offsetY, s.flipX];

test("stalactite segments preserve saved variants and align without furniture offset", () => {
  const t = tile(165, 684, 90);
  const result = planStaticObject(region, 1, 0, t);
  assert.deepEqual(geometry(result), [684, 90, 16, 16, 0, 0, false]);
  assert.equal(result.asset, "Tiles_165.png");
  assert.equal(result.opacity, 1);
  assert.equal(t.frameX, 684);
  assert.equal(t.frameY, 90);
});

test("pots, statues and Bast statues retain atlas rows and use a two-pixel draw offset", () => {
  for (const [id, sx, sy] of [
    [28, 90, 1314],
    [105, 1962, 90],
    [506, 18, 36],
  ]) {
    assert.deepEqual(
      geometry(planStaticObject(region, 0, 0, tile(id, sx, sy))),
      [sx, sy, 16, 16, 0, 2, false],
    );
  }
});

test("small-pile atlas wrapping applies only to the two-cell strip", () => {
  const cases = [
    [1890, 18, 1890, 18],
    [1908, 18, 0, 36],
    [2322, 18, 414, 36],
    [3816, 18, 0, 54],
    [1908, 0, 1908, 0],
  ];
  for (const [fx, fy, sx, sy] of cases) {
    assert.deepEqual(
      geometry(planStaticObject(region, 0, 0, tile(185, fx, fy))),
      [sx, sy, 16, 16, 0, 2, false],
    );
  }
});

test("second large-pile atlas wraps complete 36-pixel object rows", () => {
  for (const [fx, fy, sx, sy] of [
    [1872, 18, 1872, 18],
    [1890, 0, 0, 36],
    [2952, 18, 1062, 54],
  ]) {
    assert.deepEqual(
      geometry(planStaticObject(region, 0, 0, tile(187, fx, fy))),
      [sx, sy, 16, 16, 0, 2, false],
    );
  }
  assert.deepEqual(
    geometry(planStaticObject(region, 0, 0, tile(186, 1872, 18))),
    [1872, 18, 16, 16, 0, 2, false],
  );
});

test("long moss retains all four attachment origins at zero wind", () => {
  for (const [fy, dx, dy] of [
    [0, -2, 2],
    [36, -2, 2],
    [54, -2, -2],
    [90, -2, -2],
    [108, -2, -1],
    [126, -2, 0],
    [162, 2, 0],
    [198, 2, 0],
  ]) {
    const result = planStaticObject(region, 0, 0, tile(184, 176, fy));
    assert.deepEqual(geometry(result), [176, fy, 20, 16, dx, dy, false]);
    assert.equal(result.fidelity, "static-zero-wind");
  }
});

test("tall plants use full-height sprites and world-coordinate parity across region boundaries", () => {
  for (const id of [73, 74, 113]) {
    const t = tile(id, 90, 0);
    const left = planStaticObject(region, 1, 0, t);
    const adjacentRegion = { rect: { x: 102, y: 601 } };
    const right = planStaticObject(adjacentRegion, 0, 0, t);
    assert.deepEqual(geometry(left), [90, 0, 16, 32, 0, -12, true]);
    assert.deepEqual(left, right);
    assert.equal(planStaticObject(region, 0, 0, t).flipX, false);
  }
});

test("exposed gems move only floor-attached atlas rows", () => {
  assert.equal(planStaticObject(region, 0, 0, tile(178, 108, 36)).offsetY, 2);
  assert.equal(planStaticObject(region, 0, 0, tile(178, 108, 54)).offsetY, 0);
  assert.equal(planStaticObject(region, 0, 0, tile(178, 108, 198)).offsetY, 0);
});

test("unsupported families fall through and malformed saved frames are explicit", () => {
  assert.equal(planStaticObject(region, 0, 0, tile(171, 0, 0)), null);
  for (const id of STATIC_OBJECT_TILES) {
    for (const [x, y] of [
      [null, 0],
      [0, null],
      [-1, 0],
      [0, -1],
      [0.5, 0],
    ]) {
      assert.match(
        planStaticObject(region, 0, 0, tile(id, x, y)).unsupported,
        /saved frame/,
      );
    }
  }
  assert.match(
    planStaticObject(region, 0, 0, tile(184, 0, 216)).unsupported,
    /direction/,
  );
  assert.ok(Object.isFrozen(STATIC_OBJECT_TILES));
});
