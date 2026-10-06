import test from "node:test";
import assert from "node:assert/strict";
import {
  paintPixelRGBA,
  resolvePaintStyle,
  resolvePaintSettings,
  supportsPaint,
  UnsupportedPaintError,
} from "../core/paint.mjs";
const p = (rgba, id, opts) => [...paintPixelRGBA(rgba, id, opts)];
const rejects = (fn, reason) =>
  assert.throws(
    fn,
    (error) =>
      error instanceof UnsupportedPaintError && error.reason === reason,
  );

test("ordinary paints retain extrema and use exact half-way channel, not palette tint", () => {
  const expected = [
    [200, 50, 50],
    [200, 125, 50],
    [200, 200, 50],
    [125, 200, 50],
    [50, 200, 50],
    [50, 200, 125],
    [50, 200, 200],
    [50, 125, 200],
    [50, 50, 200],
    [125, 50, 200],
    [200, 50, 200],
    [200, 50, 125],
  ];
  expected.forEach((rgb, index) =>
    assert.deepEqual(p([200, 100, 50, 255], index + 1), [...rgb, 255]),
  );
});
test("deep paints lower minimum to 40 percent before computing intermediate channel", () => {
  const expected = [
    [200, 20, 20],
    [200, 110, 20],
    [200, 200, 20],
    [110, 200, 20],
    [20, 200, 20],
    [20, 200, 110],
    [20, 200, 200],
    [20, 110, 200],
    [20, 20, 200],
    [110, 20, 200],
    [200, 20, 200],
    [200, 20, 110],
  ];
  expected.forEach((rgb, index) =>
    assert.deepEqual(p([200, 100, 50, 255], index + 13), [...rgb, 255]),
  );
  assert.deepEqual(p([100, 100, 100, 255], 13), [100, 40, 40, 255]);
});
test("black white gray brown shadow and negative have distinct recovered formulas", () => {
  for (const [id, rgb] of [
    [25, [38, 38, 38]],
    [26, [234, 234, 234]],
    [27, [125, 125, 125]],
    [28, [200, 140, 98]],
    [29, [6, 6, 6]],
    [30, [55, 155, 205]],
  ]) {
    assert.deepEqual(p([200, 100, 50, 255], id), [...rgb, 255]);
  }
  assert.deepEqual(p([255, 0, 0, 255], 26), [255, 255, 255, 255]); // explicit target clamp
  assert.deepEqual(p([200, 100, 50, 255], 30, { wall: true }), [0, 0, 91, 255]);
  assert.deepEqual(p([1, 1, 1, 255], 30, { wall: true }), [189, 189, 189, 255]);
});
test("black remains black, ties and achromatic colors are well defined", () => {
  for (let id = 0; id <= 31; id++)
    assert.deepEqual(p([0, 0, 0, 255], id), [0, 0, 0, 255]);
  assert.deepEqual(p([0, 0, 0, 255], 30, { wall: true }), [0, 0, 0, 255]);
  assert.deepEqual(p([200, 200, 50, 255], 2), [200, 125, 50, 255]);
  assert.deepEqual(p([200, 50, 200, 255], 2), [200, 125, 50, 255]);
  assert.deepEqual(p([50, 200, 200, 255], 2), [200, 125, 50, 255]);
  for (let id = 1; id <= 12; id++)
    assert.deepEqual(p([128, 128, 128, 255], id), [128, 128, 128, 255]);
});
test("identity/old illuminant retain data without inventing a glow coating", () => {
  const original = Object.freeze([44, 55, 66, 128]);
  for (const id of [0, 31]) assert.deepEqual(p(original, id), original);
  assert.deepEqual(original, [44, 55, 66, 128]);
  const result = paintPixelRGBA([1, 2, 3, 255], 1);
  assert.ok(result instanceof Uint8ClampedArray);
});
test("default alpha policy is explicit, and transparent samples are canonical", () => {
  rejects(() => p([200, 100, 50, 128], 1), "semitransparent-alpha-provenance");
  for (let id = 1; id <= 30; id++)
    assert.deepEqual(p([200, 100, 50, 0], id), [0, 0, 0, 0]);
});
test("straight alpha adapter premultiplies first and rejects unrepresentable results", () => {
  assert.deepEqual(
    p([200, 100, 50, 128], 1, { alphaMode: "straight" }),
    [200, 50, 50, 128],
  );
  assert.deepEqual(
    p([200, 100, 50, 128], 14, { alphaMode: "straight" }),
    [200, 110, 20, 128],
  );
  assert.deepEqual(
    p([200, 100, 50, 128], 28, { alphaMode: "straight" }),
    [200, 140, 98, 128],
  );
  rejects(
    () => p([255, 0, 0, 128], 26, { alphaMode: "straight" }),
    "paint-exceeds-alpha",
  );
  rejects(
    () => p([255, 0, 0, 128], 30, { alphaMode: "straight" }),
    "paint-exceeds-alpha",
  );
  rejects(
    () => p([1, 1, 1, 128], 30, { alphaMode: "straight", wall: true }),
    "paint-exceeds-alpha",
  );
  assert.deepEqual(
    p([255, 255, 255, 128], 30, { alphaMode: "straight" }),
    [253, 253, 253, 128],
  );
});
test("raw premultiplied mode preserves output above alpha and is not ImageData", () => {
  assert.deepEqual(
    p([100, 50, 25, 128], 30, { alphaMode: "premultiplied" }),
    [155, 205, 230, 128],
  );
  assert.deepEqual(
    p([100, 50, 25, 128], 30, { alphaMode: "premultiplied", wall: true }),
    [0, 91, 141, 128],
  );
  rejects(
    () => p([200, 50, 25, 128], 1, { alphaMode: "premultiplied" }),
    "invalid-premultiplied-input",
  );
});
test("special hue/saturation mask is inclusive, invertible and preserves alpha", () => {
  const mask = {
    minHue: 0,
    maxHue: 0,
    minSat: 1,
    maxSat: 1,
    hueOffset: 0,
    invert: false,
  };
  assert.deepEqual(
    p([255, 0, 0, 255], 9, { specialSettings: mask }),
    [0, 0, 255, 255],
  );
  assert.deepEqual(
    p([255, 0, 0, 255], 9, { specialSettings: { ...mask, invert: true } }),
    [255, 0, 0, 255],
  );
  assert.deepEqual(
    p([0, 255, 0, 255], 9, { specialSettings: mask }),
    [0, 255, 0, 255],
  );
  // Deep paint bypasses special group masks.
  assert.deepEqual(
    p([255, 0, 0, 255], 21, { specialSettings: { ...mask, invert: true } }),
    [0, 0, 255, 255],
  );
  const shifted = { ...mask, minHue: 0.5, maxHue: 0.5, hueOffset: 0.5 };
  assert.deepEqual(
    p([255, 0, 0, 255], 9, { specialSettings: shifted }),
    [0, 0, 255, 255],
  );
  // Negative offset remains negative; it is not wrapped to +0.5.
  assert.deepEqual(
    p([255, 0, 0, 255], 9, {
      specialSettings: { ...shifted, hueOffset: -0.5 },
    }),
    [255, 0, 0, 255],
  );
});
test("C# dirt and mud routing protects masked substrate, trees fail explicitly", () => {
  assert.equal(resolvePaintSettings, resolvePaintStyle);
  const dirt = resolvePaintStyle(2, { paintId: 1 });
  assert.ok(dirt.supported);
  assert.deepEqual(p([200, 133, 100, 255], 1, dirt), [200, 133, 100, 255]);
  assert.deepEqual(p([200, 50, 0, 255], 1, dirt), [200, 0, 0, 255]);
  const mud = resolvePaintStyle(60, { paintId: 1 });
  assert.deepEqual(p([120, 90, 90, 255], 9, mud), [120, 90, 90, 255]);
  assert.equal(resolvePaintStyle(5).reason, "tree-paint-style");
  assert.equal(resolvePaintStyle(5, { paintId: 13 }).supported, true);
  assert.equal(resolvePaintStyle(2, { wall: true }).specialSettings, null);
  assert.equal(resolvePaintStyle(1).specialSettings, null);
});
test("malformed IDs, bytes and settings never produce silent invented colors", () => {
  for (const id of [-1, 32, 1.5, NaN, "1"]) {
    assert.equal(supportsPaint(id), false);
    rejects(() => p([0, 0, 0, 255], id), "unknown-paint-id");
  }
  assert.throws(() => p([0, 0, 0], 1), TypeError);
  assert.throws(() => p([256, 0, 0, 255], 1), TypeError);
  rejects(
    () => p([1, 2, 3, 255], 1, { alphaMode: "guess" }),
    "unknown-alpha-mode",
  );
  rejects(
    () => p([1, 2, 3, 255], 1, { specialSettings: { minHue: 0 } }),
    "invalid-special-settings",
  );
});

test("input encoding is explicit: TConvert raw PNG channels must not be multiplied twice", () => {
  const raw = { alphaMode: "straight", inputEncoding: "tconvert-game-raw" };
  assert.deepEqual(p([60, 30, 15, 180], 1, raw), [85, 21, 21, 180]);
  assert.deepEqual(
    p([60, 30, 15, 180], 1, {
      alphaMode: "straight",
      inputEncoding: "standard-straight",
    }),
    [60, 15, 15, 180],
  );
  assert.deepEqual(p([60, 30, 15, 180], 0, raw), [85, 43, 21, 180]);
  assert.deepEqual(p([60, 30, 15, 180], 31, raw), [85, 43, 21, 180]);
  assert.deepEqual(
    p([60, 30, 15, 180], 30, { ...raw, wall: true }),
    [101, 186, 228, 180],
  );
  rejects(() => p([60, 30, 15, 180], 30, raw), "paint-exceeds-alpha");
  rejects(() => p([200, 30, 15, 180], 1, raw), "invalid-premultiplied-input");
  rejects(
    () => p([60, 30, 15, 180], 1, { ...raw, inputEncoding: "guess" }),
    "unknown-input-encoding",
  );
});
