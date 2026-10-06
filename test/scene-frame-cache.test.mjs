import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { registerTextureSource } from "../core/assets.mjs";
import {
  prepareSceneFrames,
  createSceneFrameCache,
  splitPremultipliedRGBA,
} from "../core/scene-frames.mjs";
import { paintPixelRGBA } from "../core/paint.mjs";
import { multiplyStaticVertexColor } from "../core/static-blocks.mjs";
import { renderScene } from "../core/renderer.mjs";
function texture(seed = 0) {
  const canvas = createCanvas(16, 16),
    ctx = canvas.getContext("2d"),
    pixels = ctx.createImageData(16, 16);
  for (let i = 0; i < pixels.data.length; i += 4)
    pixels.data.set(
      [
        (i * 17 + seed) % 256,
        (i * 13 + seed) % 256,
        (i * 11 + seed) % 256,
        [0, 1, 2, 63, 128, 254, 255][(i / 4) % 7],
      ],
      i,
    );
  ctx.putImageData(pixels, 0, 0);
  registerTextureSource(canvas, {
    pngBytes: new Uint8Array(),
    rawRgba: { width: 16, height: 16, data: pixels.data },
  });
  return canvas;
}
const command = (extra = {}) => ({
  kind: "tile",
  asset: "source",
  type: 1,
  sx: 0,
  sy: 0,
  sw: 16,
  sh: 16,
  dx: 0,
  dy: 0,
  dw: 16,
  dh: 16,
  ...extra,
});
const plan = (commands) => ({ width: 32, height: 32, commands, warnings: [] });
const rgba = (canvas) =>
  canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
const frameData = (frame) =>
  frame?.unsupported
    ? frame
    : frame
      ? {
          base: rgba(frame.base),
          additive: frame.additive ? rgba(frame.additive) : null,
          width: frame.width,
          height: frame.height,
          uvFlipApplied: frame.uvFlipApplied,
        }
      : null;
function draw(p, assets, options) {
  const frames = prepareSceneFrames(p, assets, createCanvas, options),
    canvas = createCanvas(p.width, p.height);
  renderScene(canvas.getContext("2d"), p, assets, {
    strict: true,
    sceneFrames: frames,
  });
  return { frames, data: rgba(canvas) };
}
test("cached output is byte-identical for every paint, alpha edge, mask, shape, flip, opacity and encoding", () => {
  const assets = new Map([["source", texture()]]),
    frameCache = createSceneFrameCache();
  const clips = [
    undefined,
    [
      [0, 0],
      [16, 0],
      [16, 16],
    ],
    [
      [0, 0],
      [0, 16],
      [16, 16],
    ],
    [
      [0, 16],
      [16, 0],
      [16, 16],
    ],
    [
      [0, 0],
      [16, 0],
      [0, 16],
    ],
  ];
  for (const inputEncoding of ["standard-straight", "tconvert-game-raw"])
    for (const opaqueScene of [false, true]) {
      for (const type of [1, 0, 59])
        for (let paintId = 0; paintId <= 31; paintId++) {
          const commands = clips.map((clip, i) =>
            command({
              type,
              paintId,
              clip,
              kind: i % 2 ? "wall" : "tile",
              flipX: !!(i % 2),
              flipY: !!(i % 3),
              opacity: 0.15 + i * 0.17,
              vertexColor: [201, 156, 237, 191],
              dx: i,
              dy: i,
              dw: 16 + i,
              dh: i === 4 ? 8 : 16,
            }),
          );
          const p = plan(commands),
            options = { inputEncoding, opaqueScene };
          const plain = draw(p, assets, options),
            cold = draw(p, assets, { ...options, frameCache }),
            warm = draw(p, assets, { ...options, frameCache });
          assert.deepEqual(cold.data, plain.data);
          assert.deepEqual(warm.data, plain.data);
          assert.deepEqual(cold.frames.support, plain.frames.support);
          assert.deepEqual(warm.frames.support, plain.frames.support);
          for (const c of commands)
            assert.deepEqual(
              frameData(warm.frames.resolve(c)),
              frameData(plain.frames.resolve(c)),
            );
          plain.frames.dispose();
          cold.frames.dispose();
          warm.frames.dispose();
        }
    }
  assert.ok(frameCache.stats.hits > 100);
  frameCache.dispose();
});
test("corner/liquid color domains, translation, UV flips and encoding remain exact", () => {
  const assets = new Map([["source", texture()]]),
    frameCache = createSceneFrameCache();
  for (const inputEncoding of ["standard-straight", "tconvert-game-raw"])
    for (const opaqueScene of [false, true])
      for (let i = 0; i < 32; i++) {
        const vertexColors = {
          topLeft: [255, 0, 127, 0],
          topRight: [91, 231, 11, 64],
          bottomRight: [201, 3, 52, 255],
          bottomLeft: [19, 203, 111, 127],
        };
        const base = command({
          kind: "liquid",
          paintId: i,
          vertexColors,
          vertexDomain: { x: 0, y: 0, width: 24, height: 24 },
          dw: 16,
          dh: 8,
          dx: i % 4,
          dy: i % 6,
          flipX: !!(i % 2),
          flipY: !!(i % 3),
          interpolation: "triangles-tl-br",
          inputEncoding,
          opacity: 0.35,
        });
        const translated = {
          ...base,
          dx: base.dx + 2,
          dy: base.dy + 3,
          vertexDomain: { x: 2, y: 3, width: 24, height: 24 },
        };
        const p = plan([base, translated]),
          options = { inputEncoding, opaqueScene };
        const plain = draw(p, assets, options),
          cold = draw(p, assets, { ...options, frameCache }),
          warm = draw(p, assets, { ...options, frameCache });
        assert.deepEqual(warm.data, plain.data);
        assert.deepEqual(cold.data, plain.data);
        assert.deepEqual(warm.frames.support, plain.frames.support);
        plain.frames.dispose();
        cold.frames.dispose();
        warm.frames.dispose();
      }
  frameCache.dispose();
});
test("source identity, registration, canvas factory and opaque/encoding context isolate cache entries", () => {
  const source = texture(),
    assets = new Map([["source", source]]),
    p = plan([command()]),
    frameCache = createSceneFrameCache();
  const options = {
    inputEncoding: "tconvert-game-raw",
    opaqueScene: true,
    frameCache,
  };
  let f = prepareSceneFrames(p, assets, createCanvas, options),
    original = f.resolve(p.commands[0]);
  f.dispose();
  f = prepareSceneFrames(p, assets, createCanvas, options);
  assert.equal(f.resolve(p.commands[0]), original);
  f.dispose();
  assets.set("source", texture(31));
  f = prepareSceneFrames(p, assets, createCanvas, options);
  assert.notEqual(f.resolve(p.commands[0]), original);
  f.dispose();
  assets.set("source", source);
  registerTextureSource(source, {
    pngBytes: new Uint8Array(),
    rawRgba: { width: 16, height: 16, data: new Uint8ClampedArray(1024) },
  });
  f = prepareSceneFrames(p, assets, createCanvas, options);
  assert.notEqual(f.resolve(p.commands[0]), original);
  f.dispose();
  const wrapped = (w, h) => createCanvas(w, h);
  f = prepareSceneFrames(p, assets, wrapped, options);
  assert.equal(frameCache.stats.misses, 4);
  f.dispose();
  frameCache.dispose();
});
test("LRU eviction and cache disposal never invalidate live borrowers; bounds are enforced", () => {
  const assets = new Map([["source", texture()]]),
    p = plan([command()]),
    frameCache = createSceneFrameCache({ maxFrames: 1, maxBytes: 2048 });
  const options = {
    inputEncoding: "tconvert-game-raw",
    opaqueScene: true,
    frameCache,
  };
  const first = prepareSceneFrames(p, assets, createCanvas, options),
    borrowed = first.resolve(p.commands[0]);
  const second = prepareSceneFrames(p, assets, createCanvas, options);
  assert.equal(second.resolve(p.commands[0]), borrowed);
  const otherPlan = plan([command({ paintId: 26 })]),
    other = prepareSceneFrames(otherPlan, assets, createCanvas, options);
  assert.equal(frameCache.stats.bypasses, 1);
  assert.equal(frameCache.stats.frames, 1);
  assert.ok(frameCache.stats.bytes <= 2048);
  other.dispose();
  first.dispose();
  assert.equal(borrowed.base.width, 16);
  frameCache.dispose();
  frameCache.dispose();
  assert.equal(borrowed.base.width, 16);
  assert.equal(frameCache.stats.bytes, 0);
  second.dispose();
  second.dispose();
  assert.equal(borrowed.base.width, 1);
  assert.throws(
    () => prepareSceneFrames(p, assets, createCanvas, options),
    /disposed/,
  );
});
test("LRU evicts only released entries and per-plan budgets/failures match uncached behavior", () => {
  const assets = new Map([["source", texture()]]),
    p = plan([
      command(),
      command({ paintId: 26 }),
      command({ paintId: 99 }),
      command({ sx: 33 }),
    ]);
  for (const maxFrames of [1, 2, 4])
    for (const maxBytes of [100, 2048, 4096, 8192]) {
      const frameCache = createSceneFrameCache({
          maxFrames: 1,
          maxBytes: 2048,
        }),
        options = {
          inputEncoding: "tconvert-game-raw",
          opaqueScene: true,
          maxFrames,
          maxBytes,
        };
      for (let i = 0; i < 3; i++) {
        const plain = prepareSceneFrames(p, assets, createCanvas, options),
          cached = prepareSceneFrames(p, assets, createCanvas, {
            ...options,
            frameCache,
          });
        assert.deepEqual(cached.support, plain.support);
        assert.deepEqual(cached.warnings, plain.warnings);
        for (const c of p.commands)
          assert.deepEqual(
            frameData(cached.resolve(c)),
            frameData(plain.resolve(c)),
          );
        plain.dispose();
        cached.dispose();
        assert.ok(frameCache.stats.frames <= 1);
        assert.ok(frameCache.stats.bytes <= 2048);
      }
      frameCache.dispose();
    }
});

test("released LRU entries are evicted, clear is reusable, and oversized entries bypass retention", () => {
  const assets = new Map([["source", texture()]]);
  const frameCache = createSceneFrameCache({ maxFrames: 2, maxBytes: 4096 });
  const options = {
    inputEncoding: "tconvert-game-raw",
    opaqueScene: true,
    frameCache,
  };
  const prepare = (paintId) => {
    const p = plan([command({ paintId })]);
    const frames = prepareSceneFrames(p, assets, createCanvas, options);
    return { frames, frame: frames.resolve(p.commands[0]) };
  };
  const first = prepare(0);
  first.frames.dispose();
  const second = prepare(26);
  second.frames.dispose();
  const touch = prepare(0);
  touch.frames.dispose();
  const third = prepare(27);
  third.frames.dispose();
  assert.equal(first.frame.base.width, 16);
  assert.equal(second.frame.base.width, 1);
  assert.equal(frameCache.stats.evictions, 1);
  frameCache.clear();
  assert.equal(first.frame.base.width, 1);
  assert.equal(third.frame.base.width, 1);
  const afterClear = prepare(0);
  afterClear.frames.dispose();
  assert.equal(afterClear.frame.base.width, 16);
  frameCache.dispose();
  const small = createSceneFrameCache({ maxFrames: 1, maxBytes: 4 });
  const p = plan([command()]);
  const frames = prepareSceneFrames(p, assets, createCanvas, {
    ...options,
    frameCache: small,
  });
  const frame = frames.resolve(p.commands[0]);
  assert.equal(frame.base.width, 16);
  assert.equal(small.stats.bytes, 0);
  assert.equal(small.stats.bypasses, 1);
  frames.dispose();
  assert.equal(frame.base.width, 1);
  small.dispose();
  for (const bad of [
    { maxFrames: 0 },
    { maxFrames: 8193 },
    { maxBytes: 0 },
    { maxBytes: 33554433 },
  ])
    assert.throws(() => createSceneFrameCache(bad), /budget/);
  assert.throws(
    () => prepareSceneFrames(p, assets, createCanvas, { frameCache: {} }),
    /Invalid reusable/,
  );
});

test("raw paint 0/31 identity shortcut matches the independent shader oracle for every channel/alpha pair", () => {
  const materialized = (data) => {
    const canvas = createCanvas(64, 64),
      ctx = canvas.getContext("2d");
    const image = ctx.createImageData(64, 64);
    image.data.set(data);
    ctx.putImageData(image, 0, 0);
    const result = rgba(canvas);
    canvas.width = canvas.height = 1;
    return result;
  };
  for (let alphaGroup = 0; alphaGroup < 16; alphaGroup++) {
    const source = createCanvas(64, 64),
      raw = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < 4096; i++) {
      const channel = i % 256,
        alpha = alphaGroup * 16 + Math.floor(i / 256);
      raw.set([channel, (channel * 13) % 256, 255 - channel, alpha], i * 4);
    }
    registerTextureSource(source, {
      pngBytes: new Uint8Array(),
      rawRgba: { width: 64, height: 64, data: raw },
    });
    const assets = new Map([["source", source]]);
    for (const paintId of [0, 31])
      for (const vertexColor of [undefined, [201, 156, 237, 191]]) {
        const c = command({
          sw: 64,
          sh: 64,
          dw: 64,
          dh: 64,
          paintId,
          vertexColor,
        });
        const p = plan([c]),
          frames = prepareSceneFrames(p, assets, createCanvas, {
            inputEncoding: "tconvert-game-raw",
            opaqueScene: true,
          });
        const base = new Uint8ClampedArray(raw.length),
          additive = new Uint8ClampedArray(raw.length);
        let hasAdditive = false;
        for (let i = 0; i < raw.length; i += 4) {
          const painted = paintPixelRGBA(raw.subarray(i, i + 4), paintId, {
            inputEncoding: "tconvert-game-raw",
            alphaMode: "scene-premultiplied",
          });
          assert.deepEqual(painted, raw.subarray(i, i + 4));
          const tinted = vertexColor
            ? multiplyStaticVertexColor(painted, vertexColor)
            : painted;
          const split = splitPremultipliedRGBA(tinted, { opaqueScene: true });
          base.set(split.base, i);
          if (split.additive) {
            additive.set(split.additive, i);
            hasAdditive = true;
          }
        }
        const frame = frames.resolve(c);
        assert.deepEqual(rgba(frame.base), materialized(base));
        assert.deepEqual(
          frame.additive ? rgba(frame.additive) : null,
          hasAdditive ? materialized(additive) : null,
        );
        frames.dispose();
      }
    source.width = source.height = 1;
  }
});
