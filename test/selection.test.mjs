import test from "node:test";
import assert from "node:assert/strict";
import { rectangleFromDrag, moveRectangle } from "../core/selection.mjs";
test("drag maps scaled pixels to world cells in both directions", () => {
  const view = { x: 100, y: 200, width: 64, height: 40 },
    a = { x: 72, y: 90 },
    b = { x: 288, y: 315 };
  const expected = { x: 106, y: 208, width: 20, height: 21 };
  assert.deepEqual(rectangleFromDrag(a, b, view, 720, 450), expected);
  assert.deepEqual(rectangleFromDrag(b, a, view, 720, 450), expected);
  assert.deepEqual(
    rectangleFromDrag(
      { x: a.x / 2, y: a.y / 2 },
      { x: b.x / 2, y: b.y / 2 },
      view,
      360,
      225,
    ),
    expected,
  );
});
test("drag is clamped and click selects one tile; nonfinite coordinates fail", () => {
  const v = { x: 0, y: 0, width: 10, height: 8 };
  assert.deepEqual(
    rectangleFromDrag({ x: -50, y: -20 }, { x: 999, y: 999 }, v, 100, 80),
    v,
  );
  assert.deepEqual(
    rectangleFromDrag({ x: 10, y: 10 }, { x: 10, y: 10 }, v, 100, 80),
    { x: 1, y: 1, width: 1, height: 1 },
  );
  assert.throws(() =>
    rectangleFromDrag({ x: NaN, y: 0 }, { x: 0, y: 0 }, v, 100, 80),
  );
});
test("viewport panning clamps to world boundaries", () => {
  assert.deepEqual(
    moveRectangle({ x: 0, y: 2, width: 10, height: 8 }, -10, 100, 20, 20),
    { x: 0, y: 12, width: 10, height: 8 },
  );
});
