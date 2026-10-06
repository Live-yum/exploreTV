import assert from "node:assert/strict";
import test from "node:test";
import { registerTextureSource } from "../core/assets.mjs";
import {
  prepareSceneFrames,
  splitPremultipliedRGBA,
} from "../core/scene-frames.mjs";

// Capture the actual straight bytes passed to Canvas. Comparing before Skia's
// premultiplication also catches differences that low-alpha readback can hide.
function recordingCanvas(width, height) {
  const canvas = { width, height, pixels: null };
  const context = {
    createImageData(w, h) {
      assert.equal(w, width);
      assert.equal(h, height);
      return { data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(image, x, y) {
      assert.equal(x, 0);
      assert.equal(y, 0);
      canvas.pixels = new Uint8ClampedArray(image.data);
    },
  };
  canvas.getContext = (kind) => {
    assert.equal(kind, "2d");
    return context;
  };
  return canvas;
}

function source(width, height, data) {
  return registerTextureSource(
    { width, height },
    {
      pngBytes: new Uint8Array(),
      rawRgba: { width, height, data },
    },
  );
}

function command(extra = {}) {
  return {
    asset: "source",
    kind: "tile",
    type: 1,
    paintId: 0,
    sx: 0,
    sy: 0,
    sw: 1,
    sh: 1,
    dx: 0,
    dy: 0,
    dw: 1,
    dh: 1,
    ...extra,
  };
}

test("raw identity preparation exactly matches the original split oracle before Canvas conversion", () => {
  const sourceWidth = 67,
    sourceHeight = 66,
    width = 64,
    height = 64;
  const sx = 2,
    sy = 1;
  for (let alphaGroup = 0; alphaGroup < 16; alphaGroup++) {
    const raw = new Uint8ClampedArray(sourceWidth * sourceHeight * 4).fill(199);
    const expectedBase = new Uint8ClampedArray(width * height * 4);
    const expectedAdditive = new Uint8ClampedArray(expectedBase.length);
    let hasAdditive = false;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const pixel = y * width + x,
          channel = pixel % 256;
        const alpha = alphaGroup * 16 + Math.floor(pixel / 256);
        const rgba = Uint8ClampedArray.of(
          channel,
          (channel * 13) % 256,
          255 - channel,
          alpha,
        );
        raw.set(rgba, ((y + sy) * sourceWidth + x + sx) * 4);
        // This public function remains unchanged by the fast-path implementation.
        const split = splitPremultipliedRGBA(rgba, { opaqueScene: true });
        expectedBase.set(split.base, pixel * 4);
        if (split.additive) {
          expectedAdditive.set(split.additive, pixel * 4);
          hasAdditive = true;
        }
      }
    const savedRaw = new Uint8ClampedArray(raw);
    const assets = new Map([
      ["source", source(sourceWidth, sourceHeight, raw)],
    ]);
    for (const paintId of [0, 31]) {
      const c = command({
        sx,
        sy,
        sw: width,
        sh: height,
        dw: width,
        dh: height,
        paintId,
        flipX: paintId === 31,
        flipY: true,
      });
      const frames = prepareSceneFrames(
        { commands: [c] },
        assets,
        recordingCanvas,
        {
          inputEncoding: "tconvert-game-raw",
          opaqueScene: true,
        },
      );
      const frame = frames.resolve(c);
      assert.deepEqual(
        frame.base.pixels,
        expectedBase,
        `base alpha group ${alphaGroup}, paint ${paintId}`,
      );
      assert.deepEqual(
        frame.additive?.pixels ?? null,
        hasAdditive ? expectedAdditive : null,
        `additive alpha group ${alphaGroup}, paint ${paintId}`,
      );
      assert.equal(
        frame.uvFlipApplied,
        false,
        "ordinary frames defer flips until drawing",
      );
      assert.equal(frames.support.preparedFrames, 1);
      assert.equal(frames.support.additiveFrames, hasAdditive ? 1 : 0);
      assert.equal(
        frames.support.bytes,
        width * height * 4 * (hasAdditive ? 2 : 1),
      );
      frames.dispose();
    }
    assert.deepEqual(
      raw,
      savedRaw,
      "preparing never changes the registered raw source",
    );
  }
});

test("raw identity rejects late alpha-zero excess without materializing a partial frame", () => {
  for (const paintId of [0, 31]) {
    const raw = Uint8ClampedArray.of(20, 40, 80, 255, 60, 30, 15, 0);
    const assets = new Map([["source", source(2, 1, raw)]]);
    const c = command({ paintId, sw: 2, dw: 2 });
    let materialized = 0;
    const frames = prepareSceneFrames(
      { commands: [c] },
      assets,
      (w, h) => {
        materialized++;
        return recordingCanvas(w, h);
      },
      { inputEncoding: "tconvert-game-raw", opaqueScene: false },
    );
    assert.equal(
      frames.resolve(c).unsupported,
      "premultiplied-excess-needs-opaque-scene",
    );
    assert.equal(frames.support.preparedFrames, 0);
    assert.equal(frames.support.additiveFrames, 0);
    assert.equal(frames.support.bytes, 0);
    assert.equal(frames.support.unsupportedCommands, 1);
    assert.equal(
      frames.support.reasons["premultiplied-excess-needs-opaque-scene"],
      1,
    );
    assert.equal(materialized, 0);
    frames.dispose();
  }
});

test("transparent raw identity keeps representable low-alpha pixels and no additive surface", () => {
  const raw = Uint8ClampedArray.of(
    0,
    0,
    0,
    0,
    1,
    1,
    0,
    1,
    60,
    30,
    15,
    180,
    255,
    255,
    255,
    255,
  );
  const expected = new Uint8ClampedArray(raw.length);
  for (let i = 0; i < raw.length; i += 4)
    expected.set(splitPremultipliedRGBA(raw.subarray(i, i + 4)).base, i);
  for (const paintId of [0, 31]) {
    const c = command({ paintId, sw: 4, dw: 4 });
    const assets = new Map([["source", source(4, 1, raw)]]);
    const frames = prepareSceneFrames(
      { commands: [c] },
      assets,
      recordingCanvas,
      {
        inputEncoding: "tconvert-game-raw",
        opaqueScene: false,
      },
    );
    const frame = frames.resolve(c);
    assert.deepEqual(frame.base.pixels, expected);
    assert.equal(frame.additive, null);
    assert.equal(frames.support.preparedFrames, 1);
    assert.equal(frames.support.additiveFrames, 0);
    assert.equal(frames.support.bytes, raw.length);
    assert.equal(frames.support.unsupportedCommands, 0);
    frames.dispose();
  }
});
