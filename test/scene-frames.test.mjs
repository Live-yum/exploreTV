import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { paintPixelRGBA } from "../core/paint.mjs";
import {
  prepareSceneFrames,
  splitPremultipliedRGBA,
} from "../core/scene-frames.mjs";
import { renderScene, planScene } from "../core/renderer.mjs";
function texture(rgba, w = 32, h = 32) {
  const c = createCanvas(w, h),
    x = c.getContext("2d"),
    d = x.createImageData(w, h);
  for (let i = 0; i < d.data.length; i += 4) d.data.set(rgba, i);
  x.putImageData(d, 0, 0);
  return c;
}
const command = (overrides = {}) => ({
  kind: "wall",
  asset: "Wall_1.png",
  type: 1,
  sx: 0,
  sy: 0,
  sw: 1,
  sh: 1,
  dx: 0,
  dy: 0,
  dw: 1,
  dh: 1,
  paintId: 0,
  ...overrides,
});
const plan = (commands) => ({ commands, warnings: [], width: 1, height: 1 });
function render(commands, assets, options) {
  const p = plan(commands),
    f = prepareSceneFrames(p, assets, createCanvas, options),
    c = createCanvas(1, 1);
  const result = renderScene(c.getContext("2d"), p, assets, {
    strict: true,
    sceneFrames: f,
  });
  return {
    rgba: Array.from(c.getContext("2d").getImageData(0, 0, 1, 1).data),
    frames: f,
    result,
  };
}
const near = (actual, expected) =>
  actual.forEach((n, i) =>
    assert.ok(Math.abs(n - expected[i]) <= 2, `${actual} != ${expected}`),
  );
test("scene shader-domain adapter preserves association and super-alpha outputs", () => {
  assert.deepEqual(
    [
      ...paintPixelRGBA([128, 128, 128, 128], 26, {
        inputEncoding: "tconvert-game-raw",
        alphaMode: "scene-premultiplied",
      }),
    ],
    [192, 192, 192, 128],
  );
  assert.deepEqual(
    [
      ...paintPixelRGBA([60, 30, 15, 180], 0, {
        inputEncoding: "standard-straight",
        alphaMode: "scene-premultiplied",
      }),
    ],
    [42, 21, 11, 180],
  );
  assert.deepEqual(
    [
      ...paintPixelRGBA([60, 30, 15, 180], 0, {
        inputEncoding: "tconvert-game-raw",
        alphaMode: "scene-premultiplied",
      }),
    ],
    [60, 30, 15, 180],
  );
});
test("opaque scene preserves painted super-alpha without flattening sprites", () => {
  const assets = new Map([
    ["Wall_1.png", texture([128, 128, 128, 128])],
    ["background", texture([10, 80, 150, 255])],
  ]);
  const commands = [command({ asset: "background" }), command({ paintId: 26 })];
  const r = render(commands, assets, {
    inputEncoding: "tconvert-game-raw",
    opaqueScene: true,
  });
  near(r.rgba, [197, 232, 255, 255]);
  assert.equal(r.frames.support.additiveFrames, 1);
  assert.equal(r.result.skippedEffects, 0);
});
test("transparent scene refuses super-alpha and draws no wrong fallback", () => {
  const assets = new Map([["Wall_1.png", texture([128, 128, 128, 128])]]);
  const r = render([command({ paintId: 26 })], assets, {
    inputEncoding: "tconvert-game-raw",
    opaqueScene: false,
  });
  assert.equal(r.result.skippedEffects, 1);
  assert.deepEqual(r.rgba, [0, 0, 0, 0]);
  assert.ok(
    r.frames.support.reasons["premultiplied-excess-needs-opaque-scene"],
  );
});
test("tile and liquid layering remains sequential after a painted wall", () => {
  const assets = new Map([
    ["Wall_1.png", texture([128, 128, 128, 128])],
    ["tile", texture([200, 20, 10, 128])],
    ["water_0.png", texture([20, 40, 200, 255])],
  ]);
  const cmds = [
    command({ paintId: 26 }),
    command({ kind: "tile", asset: "tile" }),
    command({ kind: "liquid", asset: "water_0.png", opacity: 0.6 }),
  ];
  const r = render(cmds, assets, {
    inputEncoding: "standard-straight",
    opaqueScene: true,
  });
  const wall = [
    ...paintPixelRGBA([128, 128, 128, 128], 26, {
      wall: true,
      inputEncoding: "standard-straight",
      alphaMode: "scene-premultiplied",
    }),
  ];
  const under = wall
    .slice(0, 3)
    .map((v, i) => ([200, 20, 10][i] * 128) / 255 + (1 - 128 / 255) * v);
  near(r.rgba, [
    ...under.map((v, i) => Math.round(0.6 * [20, 40, 200][i] + 0.4 * v)),
    255,
  ]);
});
test("unpainted raw game channels are not multiplied by alpha twice", () => {
  const assets = new Map([["Wall_1.png", texture([60, 30, 15, 180])]]);
  const r = render([command()], assets, {
    inputEncoding: "tconvert-game-raw",
    opaqueScene: true,
  });
  near(r.rgba, [60, 30, 15, 255]);
});
test("frame cache limits and unknown paint stay explicit and bounded", () => {
  const p = plan([command(), command({ sx: 1 }), command({ paintId: 99 })]),
    assets = new Map([["Wall_1.png", texture([100, 50, 20, 255])]]);
  const f = prepareSceneFrames(p, assets, createCanvas, {
    inputEncoding: "tconvert-game-raw",
    maxFrames: 1,
    maxBytes: 8,
  });
  assert.equal(f.support.preparedFrames, 1);
  assert.equal(f.support.unsupportedCommands, 2);
  assert.ok(f.support.bytes <= 8);
  assert.throws(() => splitPremultipliedRGBA([200, 150, 100, 128]), /opaque/);
});
test("planner carries separate wall and block paint and requested liquid layer", () => {
  const r = {
    rect: { x: 0, y: 0, width: 1, height: 1 },
    cells: [
      { active: true, type: 1, paint: 13, wall: 1, wallPaint: 26, liquid: 0 },
    ],
  };
  const p = planScene(r, { paintEnabled: true });
  assert.deepEqual(
    p.commands.map((c) => [c.kind, c.paintId]),
    [
      ["wall", 26],
      ["tile", 13],
    ],
  );
  const before = JSON.stringify(r);
  prepareSceneFrames(p, new Map(), createCanvas, { opaqueScene: true });
  assert.equal(JSON.stringify(r), before);
});
