import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import { registerTextureSource } from "../core/assets.mjs";
import { prepareSceneFrames } from "../core/scene-frames.mjs";
import { createNodePngRgbaDecoder } from "../scripts/png-rgba-node.mjs";
import {
  composeInto,
  prepareFramePixels,
  quantizeCanvasOpacity,
} from "../scripts/native-blitter.mjs";
import {
  canonicalSlopeClip,
  prepareClippedOverviewFrame,
} from "../scripts/slope-overview-frame.mjs";

// Fixed source geometry from renderer.mjs, kept independent of the helper.
const clips = {
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
const command = (shape = 2, extra = {}) => ({
  kind: "tile",
  asset: "test.png",
  type: 1,
  paintId: 0,
  sx: 0,
  sy: 0,
  sw: 16,
  sh: 16,
  dx: 0,
  dy: 0,
  dw: 16,
  dh: 16,
  clip: clips[shape],
  ...extra,
});
function setPixels(canvas, bytes) {
  const ctx = canvas.getContext("2d"),
    image = ctx.createImageData(canvas.width, canvas.height);
  image.data.set(bytes);
  ctx.putImageData(image, 0, 0);
}
function equalPixels(actual, expected, label) {
  const a = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const e = Buffer.from(
    expected.buffer,
    expected.byteOffset,
    expected.byteLength,
  );
  if (a.equals(e)) return;
  const i = a.findIndex((value, i) => value !== e[i]);
  assert.fail(`${label}: byte ${i}, actual ${a[i]}, expected ${e[i]}`);
}
function drawOracle(ctx, frame, c) {
  ctx.save();
  try {
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = c.opacity === undefined ? 1 : c.opacity;
    ctx.globalCompositeOperation = "source-over";
    if (c.clip) {
      ctx.beginPath();
      c.clip.forEach(([x, y], i) =>
        ctx[i ? "lineTo" : "moveTo"](c.dx + x, c.dy + y),
      );
      ctx.closePath();
      ctx.clip();
    }
    const flipX = !!c.flipX && !frame.uvFlipApplied,
      flipY = !!c.flipY && !frame.uvFlipApplied;
    if (flipX || flipY) {
      ctx.translate(c.dx + (flipX ? c.dw : 0), c.dy + (flipY ? c.dh : 0));
      ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    }
    const x = flipX || flipY ? 0 : c.dx,
      y = flipX || flipY ? 0 : c.dy;
    ctx.drawImage(
      frame.base,
      0,
      0,
      frame.width,
      frame.height,
      x,
      y,
      c.dw,
      c.dh,
    );
    if (frame.additive) {
      ctx.globalCompositeOperation = "lighter";
      ctx.drawImage(
        frame.additive,
        0,
        0,
        frame.width,
        frame.height,
        x,
        y,
        c.dw,
        c.dh,
      );
    }
  } finally {
    ctx.restore();
  }
}
function drawNative(bytes, width, height, frame, c) {
  const sources = frame.additive ? [frame.base, frame.additive] : [frame.base];
  const descriptors = frame.additive
    ? [
        0,
        frame.width,
        frame.height,
        c.dx,
        c.dy,
        0,
        0,
        0,
        1,
        frame.width,
        frame.height,
        c.dx,
        c.dy,
        0,
        0,
        1,
      ]
    : [0, frame.width, frame.height, c.dx, c.dy, 0, 0, 0];
  composeInto(bytes, width, height, Int32Array.from(descriptors), sources);
}
function background(width, height, value) {
  const bytes = new Uint8Array(width * height * 4);
  for (let i = 0; i < bytes.length; i += 4) {
    bytes[i] = value;
    bytes[i + 1] = (value * 37 + 11) & 255;
    bytes[i + 2] = 255 - value;
    bytes[i + 3] = 255;
  }
  return bytes;
}
function rawFrame(data, width = 16, height = 16) {
  const source = registerTextureSource(
    { width, height },
    {
      pngBytes: new Uint8Array(),
      rawRgba: { width, height, data },
    },
  );
  const c = command(2, { sw: width, sh: height, dw: width, dh: height });
  const frames = prepareSceneFrames(
    { commands: [c] },
    new Map([[c.asset, source]]),
    createCanvas,
    {
      inputEncoding: "tconvert-game-raw",
      opaqueScene: true,
    },
  );
  return { frame: frames.resolve(c), dispose: () => frames.dispose() };
}

test("canonical slope recognition has strict geometry and fallback boundaries", () => {
  for (let shape = 2; shape <= 5; shape++)
    assert.equal(canonicalSlopeClip(command(shape)), shape);
  for (const extra of [
    { dx: 0.5 },
    { dy: NaN },
    { dx: 2 ** 40 },
    { sw: 15 },
    { dh: 8 },
    { sh: 8, dh: 8, clip: null },
    { opacity: null },
    { opacity: "1" },
    { opacity: Infinity },
    { opacity: -0.1 },
    { opacity: 1.1 },
    { flipX: 1 },
    { flipY: null },
    { vertexColors: {} },
    { clip: null },
    { clip: [] },
    {
      clip: [
        [0, 0],
        [15, 16],
        [0, 16],
      ],
    },
    {
      clip: [
        [0, 0, 0],
        [16, 16],
        [0, 16],
      ],
    },
    {
      clip: [
        ["0", 0],
        [16, 16],
        [0, 16],
      ],
    },
  ]) {
    const c = command(2, extra);
    assert.equal(canonicalSlopeClip(c), null);
    assert.equal(prepareClippedOverviewFrame(null, c, createCanvas), null);
  }
  assert.equal(canonicalSlopeClip(null), null);
  assert.throws(
    () => prepareClippedOverviewFrame(null, command(), createCanvas),
    /validated/,
  );
});

test("all four integer slope masks retain Skia's sixteen half-coverage edge pixels", () => {
  const base = createCanvas(16, 16),
    ctx = base.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 16, 16);
  const frame = { base, additive: null, width: 16, height: 16 };
  for (let shape = 2; shape <= 5; shape++) {
    const prepared = prepareClippedOverviewFrame(
        frame,
        command(shape),
        createCanvas,
      ),
      counts = {};
    for (let i = 0; i < prepared.base.length; i += 4) {
      const a = prepared.base[i + 3];
      assert.equal(prepared.base[i], a);
      assert.equal(prepared.base[i + 1], a);
      assert.equal(prepared.base[i + 2], a);
      counts[a] = (counts[a] || 0) + 1;
    }
    assert.deepEqual(counts, { 0: 120, 128: 16, 255: 120 });
    assert.equal(prepared.uvFlipApplied, true);
    assert.equal(prepared.opacityByte, 255);
    assert.equal(prepared.bytes, 1024);
  }
  base.width = base.height = 1;
});

test("clipped frame composition matches real source slope crops over opaque backgrounds", () => {
  const decoder = createNodePngRgbaDecoder(),
    target = createCanvas(16, 16),
    ctx = target.getContext("2d");
  for (const [type, sx, sy] of [
    [53, 0, 54],
    [1, 0, 72],
    [60, 18, 54],
  ]) {
    const asset = `Tiles_${type}.png`,
      pngBytes = readFileSync(
        new URL(`../example/assets/${asset}`, import.meta.url),
      );
    const raw = decoder.decode(pngBytes);
    const source = registerTextureSource(
      { width: raw.width, height: raw.height },
      { pngBytes, rawRgba: raw },
    );
    const c0 = command(2, { asset, type, sx, sy });
    const frames = prepareSceneFrames(
      { commands: [c0] },
      new Map([[asset, source]]),
      createCanvas,
      { inputEncoding: "tconvert-game-raw", opaqueScene: true },
    );
    const frame = frames.resolve(c0);
    for (let shape = 2; shape <= 5; shape++)
      for (const opacity of [1, 0.5, 0.6, 0.95]) {
        const c = command(shape, { asset, type, sx, sy, opacity }),
          prepared = prepareClippedOverviewFrame(frame, c, createCanvas);
        for (const value of [0, 1, 127, 128, 254, 255]) {
          const original = background(16, 16, value),
            actual = original.slice();
          setPixels(target, original);
          drawOracle(ctx, frame, c);
          drawNative(actual, 16, 16, prepared, c);
          equalPixels(
            actual,
            ctx.getImageData(0, 0, 16, 16).data,
            `${asset}, shape ${shape}, alpha ${opacity}, background ${value}`,
          );
        }
      }
    frames.dispose();
  }
  decoder.clear();
  target.width = target.height = 1;
});

test("diagonal coverage preserves every source alpha and low premultiplied RGB value", () => {
  const target = createCanvas(16, 16),
    ctx = target.getContext("2d");
  const base = createCanvas(16, 16),
    frame = { base, additive: null, width: 16, height: 16 };
  const source = new Uint8ClampedArray(1024);
  // Each diagonal visits every row once. Across sixteen blocks, all 256 alpha
  // values meet every low premultiplied channel value 0..15 (and blue 1..31).
  for (let block = 0; block < 16; block++)
    for (let low = 0; low < 16; low++) {
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          const a = block * 16 + y,
            i = (y * 16 + x) * 4;
          source[i] = a ? Math.round((Math.min(low, a) * 255) / a) : 0;
          source[i + 1] = a ? Math.round((Math.min(15 - low, a) * 255) / a) : 0;
          source[i + 2] = a
            ? Math.round((Math.min(low * 2 + 1, a) * 255) / a)
            : 0;
          source[i + 3] = a;
        }
      setPixels(base, source);
      for (let shape = 2; shape <= 5; shape++)
        for (const opacity of [1, 0.5, 0.6, 0.95]) {
          const c = command(shape, { opacity }),
            prepared = prepareClippedOverviewFrame(frame, c, createCanvas);
          for (const value of [0, 1, 2, 3, 7, 15, 31, 127, 128, 254, 255]) {
            const original = background(16, 16, value),
              actual = original.slice();
            setPixels(target, original);
            drawOracle(ctx, frame, c);
            drawNative(actual, 16, 16, prepared, c);
            equalPixels(
              actual,
              ctx.getImageData(0, 0, 16, 16).data,
              `alpha block ${block}, low ${low}, shape ${shape}, opacity ${opacity}, background ${value}`,
            );
          }
        }
    }
  base.width = base.height = target.width = target.height = 1;
});

test("sequential clips preserve flips, core-edge intersections, additive layers and alpha thresholds", () => {
  let state = 173;
  const byte = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
  const source = new Uint8Array(1024);
  for (let i = 0; i < source.length; i++) source[i] = byte();
  const { frame, dispose } = rawFrame(source);
  assert.ok(frame.additive);
  const width = 48,
    height = 40,
    target = createCanvas(width, height),
    ctx = target.getContext("2d");
  const actual = new Uint8Array(width * height * 4);
  for (let i = 0; i < actual.length; i++)
    actual[i] = i % 4 === 3 ? 255 : byte();
  setPixels(target, actual);
  const thresholds = [0, 1, 2, 15, 127, 128, 254].flatMap((n) => {
    const mid = (n + 0.5) / 255;
    return [mid - 1e-7, mid, mid + 1e-7];
  });
  for (let i = 0; i < 256 + thresholds.length; i++) {
    const c = command(2 + (i % 4), {
      dx: (byte() % (width + 24)) - 12,
      dy: (byte() % (height + 24)) - 12,
      flipX: !!(i & 4),
      flipY: !!(i & 8),
      opacity: i < 256 ? i / 255 : thresholds[i - 256],
    });
    const prepared = prepareClippedOverviewFrame(frame, c, createCanvas);
    assert.equal(prepared.opacityByte, quantizeCanvasOpacity(c.opacity));
    drawNative(actual, width, height, prepared, c);
    drawOracle(ctx, frame, c);
    equalPixels(
      actual,
      ctx.getImageData(0, 0, width, height).data,
      `sequential draw ${i}`,
    );
  }
  dispose();
  target.width = target.height = 1;
});

test("quantized opacity cache keys have identical clipped base and additive planes", () => {
  const raw = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    raw[i * 4] = (i * 7 + 11) & 255;
    raw[i * 4 + 1] = (i * 29 + 1) & 255;
    raw[i * 4 + 2] = (i * 61 + 127) & 255;
    raw[i * 4 + 3] = i;
  }
  const { frame, dispose } = rawFrame(raw);
  assert.ok(frame.additive);
  for (let shape = 2; shape <= 5; shape++)
    for (let alpha = 0; alpha <= 255; alpha++) {
      const expected = prepareClippedOverviewFrame(
        frame,
        command(shape, { opacity: alpha / 255 }),
        createCanvas,
      );
      for (const offset of [-0.49, 0, 0.49]) {
        const opacity = Math.max(0, Math.min(1, (alpha + offset) / 255));
        assert.equal(quantizeCanvasOpacity(opacity), alpha);
        const actual = prepareClippedOverviewFrame(
          frame,
          command(shape, { opacity }),
          createCanvas,
        );
        equalPixels(actual.base, expected.base, `base cache alpha ${alpha}`);
        equalPixels(
          actual.additive,
          expected.additive,
          `additive cache alpha ${alpha}`,
        );
      }
    }
  dispose();
});

test("half-bricks remain exact ordinary rectangular native draws", () => {
  const raw = new Uint8Array(16 * 8 * 4);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 29 + 7) & 255;
  const { frame, dispose } = rawFrame(raw, 16, 8);
  const target = createCanvas(16, 16),
    ctx = target.getContext("2d");
  for (const opacity of [1, 0.6, 0.95]) {
    const c = command(2, { clip: undefined, dy: 8, sh: 8, dh: 8, opacity });
    assert.equal(canonicalSlopeClip(c), null);
    const prepared = {
      width: 16,
      height: 8,
      base: prepareFramePixels(frame.base, opacity),
      additive: frame.additive
        ? prepareFramePixels(frame.additive, opacity)
        : null,
    };
    for (const value of [0, 127, 255]) {
      const original = background(16, 16, value),
        actual = original.slice();
      setPixels(target, original);
      drawOracle(ctx, frame, c);
      drawNative(actual, 16, 16, prepared, c);
      equalPixels(
        actual,
        ctx.getImageData(0, 0, 16, 16).data,
        `half-brick opacity ${opacity}, background ${value}`,
      );
    }
  }
  dispose();
  target.width = target.height = 1;
});
