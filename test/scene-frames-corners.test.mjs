import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { registerTextureSource } from "../core/assets.mjs";
import {
  prepareSceneFrames,
  sceneFrameKey,
  FRAME_LIMITS,
} from "../core/scene-frames.mjs";
import { renderScene } from "../core/renderer.mjs";
import { rasterizeShimmerCommand } from "../core/liquid-shimmer.mjs";

const rawTexture = (width, height, data) => {
  const canvas = createCanvas(width, height),
    ctx = canvas.getContext("2d"),
    pixels = ctx.createImageData(width, height);
  pixels.data.set(data);
  ctx.putImageData(pixels, 0, 0);
  const raw = { width, height, data: Uint8ClampedArray.from(data) };
  registerTextureSource(canvas, { pngBytes: new Uint8Array(), rawRgba: raw });
  return { canvas, raw };
};
const constant = (rgba) => ({
  topLeft: rgba,
  topRight: rgba,
  bottomLeft: rgba,
  bottomRight: rgba,
});
const command = (extra = {}) => ({
  kind: "liquid",
  asset: "source",
  sx: 0,
  sy: 0,
  sw: 2,
  sh: 2,
  dx: 0,
  dy: 0,
  dw: 2,
  dh: 2,
  opacity: 1,
  vertexColors: constant([255, 255, 255, 255]),
  interpolation: "triangles-tl-br",
  ...extra,
});
const plan = (commands, width = 2, height = 2) => ({
  commands,
  width,
  height,
  warnings: [],
});
const draw = (commands, assets, { width = 2, height = 2, ...options } = {}) => {
  const p = plan(commands, width, height),
    frames = prepareSceneFrames(p, assets, createCanvas, {
      inputEncoding: "tconvert-game-raw",
      opaqueScene: true,
      ...options,
    });
  const canvas = createCanvas(width, height),
    result = renderScene(canvas.getContext("2d"), p, assets, {
      strict: true,
      sceneFrames: frames,
    });
  return {
    frames,
    result,
    canvas,
    data: canvas.getContext("2d").getImageData(0, 0, width, height).data,
  };
};
const near = (actual, expected, tolerance = 2) =>
  actual.forEach((v, i) =>
    assert.ok(
      Math.abs(v - expected[i]) <= tolerance,
      `${actual} != ${expected} (channel ${i})`,
    ),
  );
const pixel = (data, width, x, y) => [
  ...data.slice((y * width + x) * 4, (y * width + x) * 4 + 4),
];
const fill = (rgba, count = 4) =>
  Array.from({ length: count }, () => rgba).flat();

test("corner preparation samples the source TL-BR triangles at native destination centers", () => {
  const { canvas } = rawTexture(2, 2, fill([255, 255, 255, 255]));
  const c = command({
    vertexColors: {
      topLeft: [0, 0, 0, 255],
      topRight: [0, 0, 0, 255],
      bottomLeft: [0, 0, 0, 255],
      bottomRight: [255, 255, 255, 255],
    },
  });
  const out = draw([c], new Map([["source", canvas]]));
  assert.equal(out.result.skippedEffects, 0);
  assert.deepEqual(
    [...out.data],
    [64, 64, 64, 255, 64, 64, 64, 255, 64, 64, 64, 255, 191, 191, 191, 255],
  );
  const frame = out.frames.resolve(c);
  assert.deepEqual(
    [frame.width, frame.height, frame.uvFlipApplied],
    [2, 2, true],
  );
  out.frames.dispose();
});

test("hidden RGB and very low source alpha survive corner interpolation without a second alpha multiply", () => {
  for (const sourceAlpha of [0, 1]) {
    const { canvas, raw } = rawTexture(2, 2, fill([60, 30, 16, sourceAlpha]));
    const before = [...raw.data],
      c = command({ vertexColors: constant([128, 128, 128, 255]) });
    const out = draw([c], new Map([["source", canvas]]));
    near(pixel(out.data, 2, 0, 0), [30, 15, 8, 255]);
    assert.equal(out.frames.support.additiveFrames, 1);
    assert.deepEqual([...raw.data], before);
    out.frames.dispose();
  }
});

test("prepared corner frame dimensions and baked XY UV flips avoid crop stretching and double flips", () => {
  const { canvas, raw } = rawTexture(
    2,
    2,
    [200, 10, 20, 32, 10, 180, 20, 64, 10, 20, 160, 96, 130, 140, 150, 128],
  );
  const c = command({
    dw: 4,
    dh: 6,
    flipX: true,
    flipY: true,
    opacity: 0.5,
    vertexColors: constant([255, 255, 255, 0]),
  });
  const out = draw([c], new Map([["source", canvas]]), { width: 4, height: 6 });
  const frame = out.frames.resolve(c);
  assert.deepEqual(
    [
      frame.width,
      frame.height,
      frame.base.width,
      frame.base.height,
      frame.uvFlipApplied,
    ],
    [4, 6, 4, 6, true],
  );
  near(pixel(out.data, 4, 0, 0), [65, 70, 75, 255]);
  near(pixel(out.data, 4, 3, 0), [5, 10, 80, 255]);
  near(pixel(out.data, 4, 0, 5), [5, 90, 10, 255]);
  near(pixel(out.data, 4, 3, 5), [100, 5, 10, 255]);
  const reference = rasterizeShimmerCommand(c, raw);
  for (let i = 0; i < out.data.length; i += 4)
    near(
      [...out.data.slice(i, i + 4)],
      [...reference.data.slice(i, i + 3)].map((v) => v * 0.5).concat(255),
    );
  out.frames.dispose();
});

test("UV flips affect texture coordinates while corner color ramps stay on destination vertices", () => {
  const { canvas } = rawTexture(
    2,
    2,
    [200, 200, 200, 255, 100, 100, 100, 255, 80, 80, 80, 255, 40, 40, 40, 255],
  );
  const vertices = {
    topLeft: [0, 0, 0, 255],
    bottomLeft: [0, 0, 0, 255],
    topRight: [255, 255, 255, 255],
    bottomRight: [255, 255, 255, 255],
  };
  const out = draw(
    [command({ flipX: true, vertexColors: vertices })],
    new Map([["source", canvas]]),
  );
  near(pixel(out.data, 2, 0, 0), [25, 25, 25, 255]);
  near(pixel(out.data, 2, 1, 0), [150, 150, 150, 255]);
  near(pixel(out.data, 2, 0, 1), [10, 10, 10, 255]);
  near(pixel(out.data, 2, 1, 1), [60, 60, 60, 255]);
  out.frames.dispose();
});

test("PointClamp row expansion retains the original vertex domain and its nonuniform gradient", () => {
  const { canvas } = rawTexture(
    2,
    2,
    [20, 20, 20, 255, 20, 20, 20, 255, 200, 100, 40, 255, 80, 160, 240, 255],
  );
  const vertices = {
    topLeft: [0, 0, 0, 255],
    topRight: [0, 0, 0, 255],
    bottomLeft: [255, 255, 255, 255],
    bottomRight: [255, 255, 255, 255],
  };
  const c = command({
    sy: 1,
    sh: 1,
    dy: 1,
    dh: 3,
    vertexDomain: { x: 0, y: 0, width: 2, height: 4 },
    vertexColors: vertices,
  });
  const out = draw([c], new Map([["source", canvas]]), { width: 2, height: 4 });
  assert.deepEqual(
    [out.frames.resolve(c).width, out.frames.resolve(c).height],
    [2, 3],
  );
  near(pixel(out.data, 2, 0, 1), [75, 38, 15, 255]);
  near(pixel(out.data, 2, 0, 2), [125, 63, 25, 255]);
  near(pixel(out.data, 2, 0, 3), [175, 88, 35, 255]);
  near(pixel(out.data, 2, 1, 3), [70, 140, 210, 255]);
  out.frames.dispose();
});

test("corner frame keys reuse translated domains but distinguish colors, clipped intervals, scales and UV flips", () => {
  const c = command({
      dx: 10,
      dy: 20,
      vertexDomain: { x: 10, y: 20, width: 2, height: 4 },
    }),
    key = sceneFrameKey(c);
  const translated = {
    ...c,
    dx: 110,
    dy: 220,
    vertexDomain: { x: 110, y: 220, width: 2, height: 4 },
  };
  assert.equal(sceneFrameKey(translated), key);
  assert.equal(
    sceneFrameKey(command()),
    sceneFrameKey(
      command({ vertexDomain: { x: 0, y: 0, width: 2, height: 2 } }),
    ),
  );
  for (const change of [
    { flipX: true },
    { flipY: true },
    { dw: 1 },
    { dh: 1 },
    { dy: 21 },
    { interpolation: "bilinear" },
    { vertexColors: constant([254, 255, 255, 255]) },
    { dx: 10.5 },
  ])
    assert.notEqual(sceneFrameKey({ ...c, ...change }), key);
  const source = rawTexture(2, 2, fill([255, 255, 255, 255])).canvas;
  const commands = [c, translated, { ...c, dy: 21 }, { ...c, flipY: true }];
  const frames = prepareSceneFrames(
    plan(commands),
    new Map([["source", source]]),
    createCanvas,
    { inputEncoding: "tconvert-game-raw" },
  );
  assert.equal(frames.support.preparedFrames, 3);
  assert.equal(frames.resolve(c), frames.resolve(translated));
  assert.notEqual(frames.resolve(c), frames.resolve(commands[2]));
  frames.dispose();
});

test("invalid corner metadata cannot reuse a valid cached frame and never silently falls back", () => {
  const source = rawTexture(2, 2, fill([100, 50, 20, 255])).canvas,
    c = command();
  const commands = [
    c,
    { ...c, dx: 0.5 },
    { ...c, interpolation: "bilinear" },
    { ...c, vertexDomain: { x: 1, y: 0, width: 2, height: 2 } },
    { ...c, vertexColors: constant([300, 0, 0, 255]) },
    { ...c, inputEncoding: "standard-straight" },
  ];
  const out = draw(commands, new Map([["source", source]]));
  assert.equal(out.frames.support.preparedFrames, 1);
  assert.equal(out.result.skippedEffects, 5);
  assert.deepEqual(out.frames.support.reasons, {
    "invalid-corner-frame-bounds": 1,
    "unsupported-corner-interpolation": 1,
    "invalid-corner-vertex-domain": 1,
    "invalid-corner-vertex-colors": 1,
    "corner-input-encoding-mismatch": 1,
  });
  const canvas = createCanvas(2, 2),
    result = renderScene(
      canvas.getContext("2d"),
      plan([c]),
      new Map([["source", source]]),
    );
  assert.equal(result.drawn, 0);
  assert.equal(result.skippedEffects, 1);
  assert.deepEqual(
    [...canvas.getContext("2d").getImageData(0, 0, 2, 2).data],
    Array(16).fill(0),
  );
  out.frames.dispose();
});

test("corner additive excess requires an opaque target while representable transparent colors remain valid", () => {
  const source = rawTexture(2, 2, fill([100, 50, 20, 255])).canvas;
  const failed = draw(
    [command({ vertexColors: constant([255, 255, 255, 0]) })],
    new Map([["source", source]]),
    { opaqueScene: false },
  );
  assert.equal(failed.result.skippedEffects, 1);
  assert.equal(
    failed.frames.support.reasons["premultiplied-excess-needs-opaque-scene"],
    1,
  );
  assert.deepEqual([...failed.data], Array(16).fill(0));
  failed.frames.dispose();
  const okay = draw(
    [command({ vertexColors: constant([128, 128, 128, 128]) })],
    new Map([["source", source]]),
    { opaqueScene: false },
  );
  assert.equal(okay.result.drawn, 1);
  assert.equal(okay.frames.support.additiveFrames, 0);
  assert.equal(okay.data[3], 128);
  okay.frames.dispose();
});

test("corner tint applies after paint and uniform vertex tint, with sequential premultiplied layer ordering", () => {
  const background = rawTexture(2, 2, fill([10, 80, 150, 255])).canvas,
    source = rawTexture(2, 2, fill([128, 128, 128, 128])).canvas;
  const bg = command({ asset: "bg", vertexColors: undefined }),
    painted = command({
      paintId: 26,
      vertexColor: [128, 128, 128, 128],
      vertexColors: constant([128, 128, 128, 128]),
    });
  const out = draw(
    [bg, painted],
    new Map([
      ["source", source],
      ["bg", background],
    ]),
  );
  // White paint: P=192,A=128. Two 128/255 tints quantize to P=48,A=32.
  near(pixel(out.data, 2, 0, 0), [
    48 + 10 * (223 / 255),
    48 + 80 * (223 / 255),
    48 + 150 * (223 / 255),
    255,
  ]);
  assert.equal(out.frames.support.additiveFrames, 1);
  out.frames.dispose();
});

test("eight mixed corner layers stay within the documented byte tolerance of ordered source-over math", () => {
  const inputs = [
    [70, 20, 40, 1],
    [5, 80, 10, 120],
    [20, 10, 90, 0],
    [50, 40, 20, 200],
    [10, 30, 40, 50],
    [60, 5, 30, 0],
    [40, 30, 20, 100],
    [10, 15, 20, 220],
  ];
  const assets = new Map(
    inputs.map((p, i) => ["t" + i, rawTexture(2, 2, fill(p)).canvas]),
  );
  const commands = inputs.map((_, i) =>
    command({
      asset: "t" + i,
      opacity: i % 2 ? 0.75 : 1,
      vertexColors: {
        topLeft: [180, 200, 150, 100],
        topRight: [240, 80, 100, 150],
        bottomLeft: [100, 220, 60, 80],
        bottomRight: [255, 150, 250, 220],
      },
    }),
  );
  const out = draw(commands, assets);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 2; x++) {
      const u = (x + 0.5) / 2,
        v = (y + 0.5) / 2,
        vc = commands[0].vertexColors;
      const color = [0, 1, 2, 3].map((i) =>
        u >= v
          ? vc.topLeft[i] * (1 - u) +
            vc.topRight[i] * (u - v) +
            vc.bottomRight[i] * v
          : vc.topLeft[i] * (1 - v) +
            vc.bottomLeft[i] * (v - u) +
            vc.bottomRight[i] * u,
      );
      let dest = [0, 0, 0, 255];
      for (let j = 0; j < inputs.length; j++) {
        const opacity = commands[j].opacity,
          src = inputs[j].map(
            (s, i) => Math.round((s * color[i]) / 255) * opacity,
          ),
          a = src[3] / 255;
        dest = dest.map((d, i) => Math.min(255, src[i] + d * (1 - a)));
      }
      near(pixel(out.data, 2, x, y), dest, 6);
    }
  assert.equal(out.result.skippedEffects, 0);
  out.frames.dispose();
});

test("expanded corner frame sizes count against unchanged byte and frame budgets", () => {
  assert.deepEqual(FRAME_LIMITS, {
    maxFrames: 512,
    maxBytes: 8 * 1024 * 1024,
    maxSide: 64,
  });
  const source = rawTexture(2, 2, fill([100, 50, 20, 255])).canvas,
    assets = new Map([["source", source]]);
  const c = command({ dw: 64, dh: 64 });
  const small = prepareSceneFrames(plan([c]), assets, createCanvas, {
    inputEncoding: "tconvert-game-raw",
    maxBytes: 32767,
  });
  assert.equal(small.support.reasons["painted-frame-byte-budget"], 1);
  assert.equal(small.support.bytes, 0);
  small.dispose();
  const fine = prepareSceneFrames(plan([c]), assets, createCanvas, {
    inputEncoding: "tconvert-game-raw",
    maxBytes: 32768,
  });
  assert.equal(fine.support.preparedFrames, 1);
  assert.equal(fine.support.bytes, 64 * 64 * 4);
  fine.dispose();
  const second = command({ vertexColors: constant([200, 255, 255, 255]) });
  const capped = prepareSceneFrames(
    plan([command(), second]),
    assets,
    createCanvas,
    { inputEncoding: "tconvert-game-raw", maxFrames: 1 },
  );
  assert.equal(capped.support.unsupportedCommands, 1);
  assert.equal(
    capped.resolve(second).unsupported,
    "painted-frame-count-budget",
  );
  capped.dispose();
});

test("ordinary prepared frames retain source crop sizes, old cache identity and unapplied UV flips", () => {
  const c = command({
    vertexColors: undefined,
    sw: 1,
    sh: 1,
    dw: 4,
    dh: 6,
    flipX: true,
  });
  const assets = new Map([
    ["source", rawTexture(2, 2, fill([90, 40, 20, 255])).canvas],
  ]);
  assert.equal(
    sceneFrameKey(c),
    sceneFrameKey({ ...c, dx: 100, dy: 200, dw: 8, dh: 9, flipX: false }),
  );
  const frames = prepareSceneFrames(plan([c]), assets, createCanvas, {
      inputEncoding: "tconvert-game-raw",
    }),
    prepared = frames.resolve(c);
  assert.deepEqual(
    [prepared.width, prepared.height, prepared.uvFlipApplied],
    [1, 1, false],
  );
  frames.dispose();
});

// Optional original-asset integration: assert the actual pond reaches prepared
// native frames without the corner metadata being lost at the renderer boundary.
test("actual frozen pond corner frames match the standalone raw-pixel compositor", async (t) => {
  const { existsSync, readFileSync } = await import("node:fs");
  const { loadImage } = await import("@napi-rs/canvas");
  const { openWorld, extractSceneRegion } = await import("../core/world.mjs");
  const { planShimmerLiquids, SHIMMER_ASSETS } = await import(
    "../core/liquid-shimmer.mjs"
  );
  const { decodePngRgba } = await import("../core/png-rgba.mjs");
  const worldFile = new URL("../fixtures/example-world.wld", import.meta.url),
    folder = new URL("../fixtures/private/shimmer/", import.meta.url);
  if (
    !existsSync(worldFile) ||
    Object.keys(SHIMMER_ASSETS).some((n) => !existsSync(new URL(n, folder)))
  )
    return t.skip("Private original fixture/assets unavailable");
  const world = openWorld(readFileSync(worldFile)),
    region = extractSceneRegion(world, {
      x: 789,
      y: 840,
      width: 85,
      height: 40,
    }),
    shimmer = planShimmerLiquids(region);
  const width = region.rect.width * 16,
    height = region.rect.height * 16,
    assets = new Map(),
    rawAssets = {};
  for (const name of shimmer.requiredAssets) {
    const png = readFileSync(new URL(name, folder)),
      source = await loadImage(png),
      raw = decodePngRgba(png);
    registerTextureSource(source, { pngBytes: png, rawRgba: raw });
    assets.set(name, source);
    rawAssets[name] = raw;
  }
  const background = rawTexture(1, 1, [17, 23, 31, 255]);
  assets.set("background", background.canvas);
  const commands = [
    command({
      asset: "background",
      sw: 1,
      sh: 1,
      dw: width,
      dh: height,
      vertexColors: undefined,
    }),
    ...shimmer.commands,
  ];
  const out = draw(commands, assets, { width, height });
  assert.equal(out.result.skippedEffects, 0);
  assert.equal(out.result.drawn, commands.length);
  assert.equal(out.frames.support.preparedFrames, 439);
  assert.ok(out.frames.support.bytes < 1024 * 1024);
  const expected = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < expected.length; i += 4)
    expected.set([17, 23, 31, 255], i);
  for (const c of shimmer.commands) {
    const sprite = rasterizeShimmerCommand(c, rawAssets[c.asset]);
    for (let y = 0; y < sprite.height; y++)
      for (let x = 0; x < sprite.width; x++) {
        const src = (y * sprite.width + x) * 4,
          dst = ((c.dy + y) * width + c.dx + x) * 4,
          a = sprite.data[src + 3] / 255;
        for (let channel = 0; channel < 4; channel++)
          expected[dst + channel] = Math.min(
            255,
            Math.round(
              sprite.data[src + channel] + expected[dst + channel] * (1 - a),
            ),
          );
      }
  }
  let maximumDifference = 0,
    different = 0;
  for (let i = 0; i < expected.length; i++) {
    const difference = Math.abs(expected[i] - out.data[i]);
    maximumDifference = Math.max(maximumDifference, difference);
    if (difference) different++;
  }
  assert.ok(
    maximumDifference <= 2,
    `actual pond max channel delta ${maximumDifference}`,
  );
  assert.ok(different < expected.length / 8);
  out.frames.dispose();
});
