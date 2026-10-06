import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { registerTextureSource } from "../core/assets.mjs";
import {
  sceneCommandBatches,
  sceneFrameReservedBytes,
  renderSceneBatched,
} from "../core/scene-batches.mjs";

const command = (i, overrides = {}) => ({
  asset: "atlas",
  kind: "tile",
  type: 1,
  sx: i,
  sy: 0,
  sw: 1,
  sh: 1,
  dx: i,
  dy: 0,
  dw: 1,
  dh: 1,
  ...overrides,
});
function atlas(width, pixel) {
  const image = createCanvas(width, 1),
    context = image.getContext("2d"),
    rgba = context.createImageData(width, 1);
  for (let x = 0; x < width; x++) rgba.data.set(pixel(x), x * 4);
  context.putImageData(rgba, 0, 0);
  registerTextureSource(image, {
    pngBytes: new Uint8Array(),
    rawRgba: { width, height: 1, data: rgba.data },
  });
  return image;
}
test("contiguous batches preserve all 600 distinct frames and dispose each cache", () => {
  const commands = Array.from({ length: 600 }, (_, i) => command(i));
  const batches = [...sceneCommandBatches(commands)];
  assert.deepEqual(
    batches.map((b) => b.length),
    [256, 256, 88],
  );
  assert.deepEqual(batches.flat(), commands);
  const assets = new Map([
      ["atlas", atlas(600, (x) => [x % 256, 40, 70, 255])],
    ]),
    output = createCanvas(600, 1),
    made = [];
  const result = renderSceneBatched(
    output.getContext("2d"),
    { commands, width: 600, height: 1, warnings: [] },
    assets,
    (w, h) => {
      const c = createCanvas(w, h);
      made.push(c);
      return c;
    },
    { inputEncoding: "tconvert-game-raw", opaqueScene: true, strict: true },
  );
  assert.equal(result.drawn, 600);
  assert.equal(result.skippedEffects, 0);
  assert.equal(result.paintSupport.batches, 3);
  assert.ok(result.paintSupport.peakBytes <= 8 * 1024 * 1024);
  assert.ok(made.every((c) => c.width === 1 && c.height === 1));
  const pixels = output.getContext("2d").getImageData(0, 0, 600, 1).data;
  for (let x = 0; x < 600; x++)
    assert.deepEqual(
      [...pixels.subarray(x * 4, x * 4 + 4)],
      [x % 256, 40, 70, 255],
    );
});
test("batch transitions do not clear accumulated background or reorder additive layers", () => {
  const assets = new Map([
    [
      "atlas",
      atlas(
        3,
        (x) =>
          [
            [20, 40, 80, 255],
            [30, 0, 0, 0],
            [0, 50, 0, 128],
          ][x],
      ),
    ],
  ]);
  const commands = [0, 1, 2].map((i) => command(i, { dx: 0 }));
  const output = createCanvas(1, 1);
  const result = renderSceneBatched(
    output.getContext("2d"),
    { commands, width: 1, height: 1, warnings: [] },
    assets,
    createCanvas,
    {
      inputEncoding: "tconvert-game-raw",
      opaqueScene: true,
      batch: { maxFrames: 1 },
    },
  );
  assert.equal(result.drawn, 3);
  assert.equal(result.skippedEffects, 0);
  const rgba = [...output.getContext("2d").getImageData(0, 0, 1, 1).data];
  [25, 70, 40, 255].forEach((v, i) =>
    assert.ok(Math.abs(rgba[i] - v) <= 2, `${rgba}`),
  );
});
test("corner-frame reservation uses rasterized destination dimensions", () => {
  assert.equal(
    sceneFrameReservedBytes(command(0, { vertexColors: {}, dw: 64, dh: 64 })),
    32768,
  );
  const cmds = Array.from({ length: 300 }, (_, i) =>
    command(i, { vertexColors: {}, dw: 64, dh: 64 }),
  );
  assert.deepEqual(
    [...sceneCommandBatches(cmds)].map((b) => b.length),
    [256, 44],
  );
  assert.throws(
    () => [...sceneCommandBatches(cmds, { maxBytes: 10 })],
    /budget/,
  );
});
test("errors dispose prepared surfaces and unsupported sources remain reported", () => {
  const made = [],
    assets = new Map([["atlas", atlas(2, () => [1, 2, 3, 255])]]);
  const plan = {
    width: 2,
    height: 1,
    warnings: [],
    commands: [command(0, { asset: "missing" }), command(0, { sw: 2, dw: 2 })],
  };
  const result = renderSceneBatched(
    createCanvas(2, 1).getContext("2d"),
    plan,
    assets,
    (w, h) => {
      const c = createCanvas(w, h);
      made.push(c);
      return c;
    },
    { inputEncoding: "tconvert-game-raw", opaqueScene: true },
  );
  assert.deepEqual(result.missingAssets, ["missing"]);
  assert.equal(result.drawn, 1);
  assert.ok(made.every((c) => c.width === 1 && c.height === 1));
  made.length = 0;
  assert.throws(
    () =>
      renderSceneBatched(
        createCanvas(2, 1).getContext("2d"),
        plan,
        assets,
        (w, h) => {
          const c = createCanvas(w, h);
          made.push(c);
          return c;
        },
        { inputEncoding: "tconvert-game-raw", opaqueScene: true, strict: true },
      ),
    /Missing textures/,
  );
  assert.ok(
    made.length > 0 && made.every((c) => c.width === 1 && c.height === 1),
  );
});
