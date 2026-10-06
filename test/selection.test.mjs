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
test("H5 navigation, safe area, scroll, CSS zoom and DPR leave selected world origin unchanged", async () => {
  const { contentViewportBounds } = await import("../core/selection.mjs");
  const view = { x: 100, y: 200, width: 64, height: 40 };
  for (const windowTop of [0, 44, 88])
    for (const scroll of [0, 127, 511])
      for (const cssScale of [0.5, 1, 1.5])
        for (const dpr of [1, 2, 3]) {
          const native = {
              left: 20,
              top: 500 - scroll,
              width: 720 * cssScale,
              height: 450 * cssScale,
            },
            bounds = contentViewportBounds(native, windowTop);
          const normalized = (fx, fy) => ({
            x: native.left + native.width * fx,
            y: native.top + native.height * fy - windowTop,
          });
          const a = normalized(0.12, 0.22),
            b = normalized(0.42, 0.72);
          const rect = rectangleFromDrag(
            { x: a.x - bounds.left, y: a.y - bounds.top },
            { x: b.x - bounds.left, y: b.y - bounds.top },
            view,
            bounds.width,
            bounds.height,
          );
          assert.deepEqual(
            rect,
            { x: 107, y: 208, width: 20, height: 21 },
            `windowTop=${windowTop},scroll=${scroll},scale=${cssScale},dpr=${dpr}`,
          );
        }
});
test("native touch/query coordinates need no H5 navigation compensation", () => {
  const nativeBounds = { left: 12, top: 80, width: 320, height: 200 };
  const touch = { clientX: 172, clientY: 180 };
  assert.deepEqual(
    rectangleFromDrag(
      {
        x: touch.clientX - nativeBounds.left,
        y: touch.clientY - nativeBounds.top,
      },
      {
        x: touch.clientX - nativeBounds.left,
        y: touch.clientY - nativeBounds.top,
      },
      { x: 40, y: 50, width: 32, height: 20 },
      320,
      200,
    ),
    { x: 56, y: 60, width: 1, height: 1 },
  );
});
