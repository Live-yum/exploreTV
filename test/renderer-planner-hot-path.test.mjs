import test from "node:test";
import assert from "node:assert/strict";
import { planScene } from "../core/renderer.mjs";

test("precomputed slope geometry remains isolated between owners and scenes", () => {
  for (const shape of [2, 3, 4, 5]) {
    const region = {
      rect: { x: 100, y: 700, width: 2, height: 1 },
      cells: Array.from({ length: 2 }, () => ({
        active: true,
        type: 1,
        frameX: null,
        frameY: null,
        shape,
      })),
    };
    const plan = planScene(region),
      original = structuredClone(plan.commands[0].clip);
    plan.commands[0].clip[0][0] = 99;
    plan.commands[0].clip.push([99, 99]);
    assert.deepEqual(plan.commands[1].clip, original);
    assert.deepEqual(planScene(region).commands[0].clip, original);
  }
});
