import assert from "node:assert/strict";
import test from "node:test";
import { planScene } from "../core/renderer.mjs";

const expectedPolygons = {
  2: [
    [0, 0],
    [16, 16],
    [0, 16],
  ],
  3: [
    [0, 16],
    [16, 0],
    [16, 16],
  ],
  4: [
    [0, 0],
    [16, 0],
    [0, 16],
  ],
  5: [
    [0, 0],
    [16, 0],
    [16, 16],
  ],
};

function region(shapes, stored = false) {
  return {
    rect: { x: 0, y: 0, width: shapes.length, height: 1 },
    cells: shapes.map((shape) => ({
      active: true,
      type: stored ? 21 : 1,
      frameX: stored ? 0 : null,
      frameY: stored ? 0 : null,
      wall: 0,
      shape,
    })),
  };
}

test("ordinary and stored-frame slopes retain every ordered triangle vertex", () => {
  for (const stored of [false, true]) {
    const shapes = [2, 3, 4, 5, "2", "3", "4", "5"];
    const plan = planScene(region(shapes, stored));
    assert.equal(plan.commands.length, shapes.length);
    assert.equal(plan.support.shapes, shapes.length);
    assert.equal(plan.support.unsupportedTiles, 0);
    for (let i = 0; i < shapes.length; i++)
      assert.deepEqual(plan.commands[i].clip, expectedPolygons[shapes[i]]);
  }
});

test("slope clips and each point remain independently mutable across commands and plans", () => {
  for (const stored of [false, true])
    for (const shape of [2, 3, 4, 5]) {
      const input = region([shape, shape], stored);
      const savedInput = JSON.stringify(input);
      const first = planScene(input),
        second = planScene(input);
      const clips = [...first.commands, ...second.commands].map(
        (command) => command.clip,
      );
      assert.equal(new Set(clips).size, 4);
      assert.equal(new Set(clips.flat()).size, 12);
      for (const clip of clips) {
        assert.equal(Object.isFrozen(clip), false);
        for (const point of clip) assert.equal(Object.isFrozen(point), false);
      }
      clips[0][0][0] = 123;
      clips[0][1].push(456);
      clips[0].pop();
      clips[0].push([789, 999]);
      for (const clip of clips.slice(1))
        assert.deepEqual(clip, expectedPolygons[shape]);
      assert.equal(JSON.stringify(input), savedInput);
      const future = planScene(input);
      for (const command of future.commands)
        assert.deepEqual(command.clip, expectedPolygons[shape]);
    }
});

test("slope lookup keeps existing noncanonical shape behavior", () => {
  const plan = planScene(region([2.5, "02", 0, 1, 6, -1]));
  assert.equal(plan.commands.length, 4);
  assert.equal(plan.commands[0].clip, undefined);
  assert.equal(plan.commands[1].clip, undefined);
  assert.equal(plan.commands[2].clip, undefined);
  assert.equal(plan.commands[3].clip, undefined);
  assert.deepEqual(
    [plan.commands[3].sh, plan.commands[3].dh, plan.commands[3].dy],
    [8, 8, 8],
  );
  assert.equal(plan.support.shapes, 3);
  assert.equal(plan.support.unsupportedTiles, 2);
});
