import test from "node:test";
import assert from "node:assert/strict";
import { planScene } from "../core/renderer.mjs";

const blockFrames = [
  [162, 54],
  [108, 54],
  [216, 0],
  [18, 72],
  [162, 0],
  [0, 72],
  [108, 72],
  [18, 36],
  [108, 0],
  [90, 0],
  [18, 54],
  [72, 0],
  [0, 54],
  [0, 0],
  [18, 0],
  [18, 18],
];
const neighbors = [
  [0, -1, 1],
  [-1, 0, 2],
  [1, 0, 4],
  [0, 1, 8],
];
const tile = (extra = {}) => ({
  active: true,
  type: 1,
  frameX: null,
  frameY: null,
  shape: 0,
  wall: 0,
  ...extra,
});
const makeRegion = () => ({
  rect: { x: 100, y: 200, width: 3, height: 3 },
  cells: Array.from({ length: 9 }, () => tile({ active: false })),
});

test("ordinary planning preserves every mask at interior and region edges", () => {
  for (const type of [0, 1, 404])
    for (const [x, y] of [
      [1, 1],
      [0, 1],
      [2, 1],
      [1, 0],
      [1, 2],
      [0, 0],
    ])
      for (let mask = 0; mask < 16; mask++) {
        const r = makeRegion();
        r.cells[x * 3 + y] = tile({ type });
        let bounded = 0;
        for (const [dx, dy, bit] of neighbors) {
          const nx = x + dx,
            ny = y + dy;
          if (mask & bit && nx >= 0 && nx < 3 && ny >= 0 && ny < 3) {
            r.cells[nx * 3 + ny] = tile({ type });
            bounded |= bit;
          }
        }
        // A neighboring world/context cell must not change the established
        // region-edge framing rule in either the fast or the general planner.
        r.getWorldTile = () => tile({ type });
        const command = planScene(r).commands.find(
          (c) => c.x === x && c.y === y,
        );
        assert.deepEqual([command.sx, command.sy], blockFrames[bounded]);
        assert.equal(command.asset, `Tiles_${type}.png`);
      }
});

test("ordinary adjacency retains visibility, identity and actuated-neighbor semantics", () => {
  const r = makeRegion();
  r.cells[4] = tile({ paint: 7 });
  r.cells[3] = tile({ invisibleBlock: true });
  r.cells[1] = tile({ inactive: true, shape: 3 });
  r.cells[7] = tile({ type: "1" });
  r.cells[5] = tile({ active: false });
  for (const revealInvisible of [false, true]) {
    const p = planScene(r, { paintEnabled: true, revealInvisible });
    const c = p.commands.find((c) => c.x === 1 && c.y === 1);
    assert.deepEqual([c.sx, c.sy], blockFrames[revealInvisible ? 3 : 2]);
    assert.equal(c.paintId, 7);
    assert.equal(c.fidelity, "approximate");
  }
});

test("ordinary shapes are independent mutable commands and consume the full budget", () => {
  const r = makeRegion();
  r.cells[1] = tile({ shape: 2 });
  r.cells[4] = tile({ shape: 2 });
  r.cells[7] = tile({ shape: 1 });
  const p = planScene(r);
  assert.equal(p.support.shapes, 3);
  assert.equal(p.support.approximateTiles, 3);
  assert.deepEqual(
    [p.commands[2].sh, p.commands[2].dh, p.commands[2].dy],
    [8, 8, 24],
  );
  p.commands[0].clip[0][0] = 7;
  assert.equal(p.commands[1].clip[0][0], 0);
  assert.throws(
    () => planScene(r, { maxCommands: 2 }),
    /command budget exceeded/,
  );
});

test("wall framing preserves hidden neighbors, cross-material joins and unusual IDs", () => {
  const r = makeRegion();
  r.cells[4] = tile({ active: false, wall: 7 });
  r.cells[3] = tile({ active: false, wall: 318 });
  r.cells[1] = tile({ active: false, wall: 9, invisibleWall: true });
  r.cells[7] = tile({ active: false, wall: 65535 });
  r.cells[5] = tile({ active: false, wall: 0 });
  for (const revealInvisible of [false, true]) {
    const p = planScene(r, { revealInvisible });
    const c = p.commands.find((c) => c.x === 1 && c.y === 1);
    assert.deepEqual([c.sx, c.sy], revealInvisible ? [36, 72] : [324, 0]);
    assert.ok(p.requiredAssets.includes("Wall_65535.png"));
    assert.equal(p.support.hiddenWalls, revealInvisible ? 0 : 2);
  }
});
