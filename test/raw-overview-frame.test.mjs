import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { registerTextureSource } from "../core/assets.mjs";
import { prepareSceneFrames } from "../core/scene-frames.mjs";
import { renderScene } from "../core/renderer.mjs";
import { prepareRawOverviewFrame } from "../scripts/raw-overview-frame.mjs";
import { composeInto, prepareFramePixels } from "../scripts/native-blitter.mjs";
import { boxDownsampleRgba } from "../scripts/downsample-rgba.mjs";

const command = (extra = {}) => ({
  kind: "tile",
  asset: "source",
  type: 1,
  sx: 5,
  sy: 7,
  sw: 64,
  sh: 32,
  dx: 7,
  dy: 9,
  dw: 64,
  dh: 32,
  paintId: 0,
  ...extra,
});

function texture(width, height, pixel) {
  const canvas = createCanvas(width, height),
    context = canvas.getContext("2d"),
    image = context.createImageData(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      image.data.set(pixel(x, y), (y * width + x) * 4);
  context.putImageData(image, 0, 0);
  registerTextureSource(canvas, {
    pngBytes: new Uint8Array(),
    rawRgba: { width, height, data: image.data },
  });
  return canvas;
}

function representativeTexture() {
  return texture(80, 48, (x, y) => {
    if (x < 5 || x >= 69 || y < 7 || y >= 39) return [7, 11, 19, 255];
    const index = (y - 7) * 64 + x - 5,
      alpha = Math.floor(index / 8),
      sample = index % 8,
      values = [
        0,
        1,
        Math.max(0, alpha - 1),
        alpha,
        Math.min(255, alpha + 1),
        127,
        254,
        255,
      ];
    return [
      values[sample],
      values[(sample + 3) % 8],
      values[(sample + 5) % 8],
      alpha,
    ];
  });
}

function referenceFrames(c, source, options = {}) {
  return prepareSceneFrames(
    { width: 80, height: 48, commands: [c], warnings: [] },
    new Map(source ? [["source", source]] : []),
    createCanvas,
    { inputEncoding: "tconvert-game-raw", opaqueScene: true, ...options },
  );
}

function equalBytes(actual, expected, message) {
  assert.equal(actual.length, expected.length, message);
  let differences = 0;
  const examples = [];
  for (let i = 0; i < actual.length; i++)
    if (actual[i] !== expected[i]) {
      differences++;
      if (examples.length < 8) examples.push([i, actual[i], expected[i]]);
    }
  assert.equal(differences, 0, `${message}: ${JSON.stringify(examples)}`);
}

test("raw identity split matches Canvas premultiplied planes for all 256 alpha values and excess boundaries", () => {
  const source = representativeTexture();
  for (const paintId of [0, 31]) {
    const c = command({ paintId }),
      raw = prepareRawOverviewFrame(c, source),
      frames = referenceFrames(c, source);
    try {
      const frame = frames.resolve(c);
      assert.equal(frame.unsupported, undefined);
      assert.equal(raw.unsupported, undefined);
      equalBytes(
        raw.base,
        prepareFramePixels(frame.base),
        `paint ${paintId} base`,
      );
      assert.ok(raw.additive);
      equalBytes(
        raw.additive,
        prepareFramePixels(frame.additive),
        `paint ${paintId} additive`,
      );
      assert.equal(raw.width, 64);
      assert.equal(raw.height, 32);
      assert.equal(raw.uvFlipApplied, false);
      assert.equal(raw.bytes, 64 * 32 * 8);
      assert.equal(raw.mean, null);
    } finally {
      frames.dispose();
    }
  }
});

test("direct raw planes preserve full Canvas RGBA through opacity, flips, clipping and additive overlap", () => {
  const source = representativeTexture(),
    width = 80,
    height = 48,
    canvas = createCanvas(width, height),
    context = canvas.getContext("2d"),
    background = context.createImageData(width, height);
  for (let i = 0; i < background.data.length; i += 4)
    background.data.set(
      [(i * 17) % 256, (i * 31 + 71) % 256, (i * 53 + 131) % 256, 255],
      i,
    );
  const assets = new Map([["source", source]]);
  for (const paintId of [0, 31]) {
    const template = command({ paintId }),
      frames = referenceFrames(template, source);
    try {
      for (const opacity of [0, 1 / 255, 0.3, 0.499, 0.5, 0.8, 254 / 255, 1])
        for (const [flipX, flipY] of [
          [false, false],
          [true, false],
          [false, true],
          [true, true],
        ]) {
          const c = {
              ...template,
              opacity,
              flipX,
              flipY,
              dx: flipX ? -3 : 7,
              dy: flipY ? 23 : 9,
            },
            raw = prepareRawOverviewFrame(c, source),
            actual = new Uint8Array(background.data),
            sources = raw.additive ? [raw.base, raw.additive] : [raw.base],
            descriptors = [
              0,
              raw.width,
              raw.height,
              c.dx,
              c.dy,
              +flipX,
              +flipY,
              0,
            ];
          if (raw.additive)
            descriptors.push(
              1,
              raw.width,
              raw.height,
              c.dx,
              c.dy,
              +flipX,
              +flipY,
              1,
            );
          context.putImageData(background, 0, 0);
          // Two ordered draws exercise blending over an already changed opaque
          // destination, including source RGB above alpha and alpha-zero glow.
          for (let repeat = 0; repeat < 2; repeat++) {
            composeInto(
              actual,
              width,
              height,
              Int32Array.from(descriptors),
              sources,
            );
            renderScene(
              context,
              { width, height, commands: [c], warnings: [] },
              assets,
              {
                strict: true,
                sceneFrames: { ...frames, opaqueScene: false },
              },
            );
          }
          equalBytes(
            actual,
            context.getImageData(0, 0, width, height).data,
            `paint ${paintId}, opacity ${opacity}, flips ${flipX}/${flipY}`,
          );
        }
    } finally {
      frames.dispose();
    }
  }
  canvas.width = canvas.height = 1;
});

test("opaque means are exact pre-opacity frame metadata and never invented for holes or other sizes", () => {
  const source = texture(32, 32, (x, y) => [
      (x * 17 + y * 7) % 256,
      (x * 13 + y * 19) % 256,
      (x * 31 + y * 5) % 256,
      255,
    ]),
    c = command({
      sx: 8,
      sy: 7,
      sw: 16,
      sh: 16,
      dw: 16,
      dh: 16,
      opacity: 0.25,
    }),
    raw = prepareRawOverviewFrame(c, source),
    frames = referenceFrames(c, source);
  try {
    const expected = boxDownsampleRgba(
      frames.resolve(c).base.getContext("2d").getImageData(0, 0, 16, 16).data,
      16,
      16,
      16,
    );
    equalBytes(raw.mean, expected, "original prepared-frame mean");
    assert.ok(
      raw.base[3] < 255,
      "returned native byte planes include draw opacity",
    );
    assert.equal(raw.additive, null);
    assert.equal(
      prepareRawOverviewFrame({ ...c, sw: 8, dw: 8 }, source).mean,
      null,
    );
    const hole = texture(16, 16, (x, y) => [
      100,
      90,
      80,
      x === 8 && y === 8 ? 0 : 255,
    ]);
    assert.equal(
      prepareRawOverviewFrame({ ...c, sx: 0, sy: 0 }, hole).mean,
      null,
    );
  } finally {
    frames.dispose();
  }
});

test("unsupported frames retain original source, crop, paint and raw-provider failure precedence", () => {
  const source = representativeTexture();
  const cases = [
    [command(), null, "missing-source-texture"],
    [command({ sx: -1, paintId: 33 }), source, "invalid-frame-bounds"],
    [command({ sy: 0.5 }), source, "invalid-frame-bounds"],
    [command({ sw: 65 }), source, "invalid-frame-bounds"],
    [command({ sh: 0 }), source, "invalid-frame-bounds"],
    [command({ sx: 70, paintId: 33 }), source, "source-crop-outside-texture"],
    [command({ paintId: 33 }), source, "unknown-paint-id"],
    [command({ paintId: "0" }), source, "unknown-paint-id"],
    [command({ type: -1, paintId: 1 }), source, "unknown-tile-type"],
    [command({ type: 5, paintId: 1 }), source, "tree-paint-style"],
  ];
  const unregistered = createCanvas(80, 48);
  cases.push([command(), unregistered, "raw-png-bytes-required"]);
  const missingRaw = createCanvas(80, 48);
  registerTextureSource(missingRaw, {
    pngBytes: new Uint8Array(),
    rawError: "strict-import-failed",
  });
  cases.push([command(), missingRaw, "strict-import-failed"]);
  const throwing = createCanvas(80, 48);
  registerTextureSource(throwing, {
    pngBytes: new Uint8Array(),
    rawRgbaProvider: () => {
      throw Object.assign(new Error("provider"), { reason: "provider-failed" });
    },
  });
  cases.push([command(), throwing, "provider-failed"]);
  const mismatched = createCanvas(80, 48);
  registerTextureSource(mismatched, {
    pngBytes: new Uint8Array(),
    rawRgbaProvider: () => ({
      width: 81,
      height: 48,
      data: new Uint8Array(81 * 48 * 4),
    }),
  });
  cases.push([command(), mismatched, "paint-frame-preparation-failed"]);
  for (const [c, image, reason] of cases) {
    const frames = referenceFrames(c, image);
    try {
      assert.equal(frames.resolve(c).unsupported, reason);
      assert.deepEqual(prepareRawOverviewFrame(c, image), {
        unsupported: reason,
      });
    } finally {
      frames.dispose();
    }
  }
});

test("effects outside the identity contract delegate without accessing raw pixels", () => {
  let reads = 0;
  const source = createCanvas(80, 48);
  registerTextureSource(source, {
    pngBytes: new Uint8Array(),
    rawRgbaProvider: () => {
      reads++;
      throw new Error("Unexpected raw access");
    },
  });
  for (const extra of [
    { paintId: 1 },
    { paintId: 26 },
    { vertexColor: [255, 255, 255, 255] },
    { vertexColors: {} },
    { opacity: -1 },
    { opacity: 1.01 },
    { opacity: NaN },
    { opacity: null },
    { opacity: "1" },
  ])
    assert.equal(prepareRawOverviewFrame(command(extra), source), null);
  assert.equal(
    prepareRawOverviewFrame(command(), source, {
      inputEncoding: "standard-straight",
    }),
    null,
  );
  assert.throws(
    () =>
      prepareRawOverviewFrame(command(), source, { inputEncoding: "unknown" }),
    /Unknown asset channel encoding/,
  );
  assert.equal(reads, 0);
});

test("identity paints retain original unknown-type behavior and opaque-scene requirements", () => {
  const source = representativeTexture();
  for (const paintId of [0, 31]) {
    const c = command({ type: -1, paintId }),
      frames = referenceFrames(c, source);
    try {
      assert.equal(frames.resolve(c).unsupported, undefined);
      assert.equal(prepareRawOverviewFrame(c, source).unsupported, undefined);
    } finally {
      frames.dispose();
    }
  }
  const c = command(),
    frames = referenceFrames(c, source, { opaqueScene: false });
  try {
    assert.equal(
      frames.resolve(c).unsupported,
      "premultiplied-excess-needs-opaque-scene",
    );
    assert.deepEqual(
      prepareRawOverviewFrame(c, source, { opaqueScene: false }),
      { unsupported: "premultiplied-excess-needs-opaque-scene" },
    );
  } finally {
    frames.dispose();
  }
});
