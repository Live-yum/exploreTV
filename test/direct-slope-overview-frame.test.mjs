import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { registerTextureSource } from "../core/assets.mjs";
import { renderScene } from "../core/renderer.mjs";
import { prepareSceneFrames } from "../core/scene-frames.mjs";
import { prepareCanonicalSlopeOverviewFrame } from "../scripts/direct-slope-overview-frame.mjs";
import {
  composeInto,
  quantizeCanvasOpacity,
} from "../scripts/native-blitter.mjs";

// Independent public planner geometry, not the adapter's recognition table.
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
  asset: "source",
  type: 1,
  paintId: 0,
  sx: 2,
  sy: 3,
  sw: 16,
  sh: 16,
  dx: 3,
  dy: 2,
  dw: 16,
  dh: 16,
  shape,
  clip: clips[shape],
  ...extra,
});

function sourceTexture() {
  const width = 20,
    height = 22,
    data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const alpha = ((y - 3) * 16 + x - 2) & 255;
      // The crop visits all 256 alpha values, including additive A=0 pixels.
      data.set(
        [255 - alpha, (alpha * 37 + 17) & 255, (x * 19 + y * 7) & 255, alpha],
        (y * width + x) * 4,
      );
    }
  return registerTextureSource(Object.freeze({ width, height }), {
    pngBytes: new Uint8Array(),
    rawRgba: { width, height, data },
  });
}

function background(width, height) {
  const bytes = new Uint8Array(width * height * 4);
  for (let i = 0; i < bytes.length; i += 4)
    bytes.set(
      [(i * 13) & 255, (i * 7 + 111) & 255, 255 - ((i * 3) & 255), 255],
      i,
    );
  return bytes;
}

function referenceFrames(commands, source, options = {}) {
  return prepareSceneFrames(
    { commands },
    new Map(source ? [["source", source]] : []),
    createCanvas,
    { inputEncoding: "tconvert-game-raw", opaqueScene: true, ...options },
  );
}

function renderOracle(canvas, initial, commands, source, frames) {
  const context = canvas.getContext("2d"),
    image = context.createImageData(canvas.width, canvas.height);
  image.data.set(initial);
  context.putImageData(image, 0, 0);
  const result = renderScene(
    context,
    { width: canvas.width, height: canvas.height, commands, warnings: [] },
    new Map([["source", source]]),
    { strict: true, sceneFrames: { ...frames, opaqueScene: false } },
  );
  assert.equal(result.drawn, commands.length);
  assert.equal(result.skippedEffects, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

function composePrepared(target, width, height, c, frame) {
  assert.equal(frame.uvFlipApplied, true);
  const sources = [frame.base],
    descriptors = [0, 16, 16, c.dx, c.dy, 0, 0, 0];
  if (frame.additive) {
    sources.push(frame.additive);
    descriptors.push(1, 16, 16, c.dx, c.dy, 0, 0, 1);
  }
  composeInto(target, width, height, Int32Array.from(descriptors), sources);
}

function equalPixels(actual, expected, label) {
  assert.equal(actual.length, expected.length, label);
  const a = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength),
    e = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  if (a.equals(e)) return;
  const index = a.findIndex((value, i) => value !== e[i]);
  assert.fail(
    `${label}: byte ${index}: actual ${a[index]}, expected ${e[index]}`,
  );
}

test("direct slope adapter matches complete Canvas draws across shapes, flips, raw excess and opacity thresholds", () => {
  const source = sourceTexture(),
    canvas = createCanvas(23, 21),
    initial = background(canvas.width, canvas.height),
    frames = referenceFrames([command()], source),
    opacities = [
      undefined,
      0,
      Number.EPSILON,
      (0.5 - 1e-6) / 255,
      0.5 / 255,
      (0.5 + 1e-6) / 255,
      1 / 255,
      (127.5 - 1e-6) / 255,
      0.5,
      (127.5 + 1e-6) / 255,
      0.6,
      0.95,
      (254.5 - 1e-6) / 255,
      254.5 / 255,
      (254.5 + 1e-6) / 255,
      1,
    ];
  try {
    for (let shape = 2; shape <= 5; shape++)
      for (const flipX of [false, true])
        for (const flipY of [false, true])
          for (const opacity of opacities) {
            const c = command(shape, {
                flipX,
                flipY,
                opacity,
                dx: flipX ? -3 : 3,
                dy: flipY ? 10 : 2,
              }),
              prepared = prepareCanonicalSlopeOverviewFrame(c, source),
              actual = initial.slice();
            assert.equal(prepared.unsupported, undefined);
            assert.equal(prepared.width, 16);
            assert.equal(prepared.height, 16);
            assert.equal(prepared.clipShape, shape);
            assert.equal(
              prepared.opacityByte,
              quantizeCanvasOpacity(opacity ?? 1),
            );
            assert.equal(prepared.mean, null);
            assert.ok(prepared.additive, "Raw RGB above alpha stays separate");
            assert.equal(
              prepared.bytes,
              prepared.base.byteLength + prepared.additive.byteLength,
            );
            composePrepared(actual, canvas.width, canvas.height, c, prepared);
            equalPixels(
              actual,
              renderOracle(canvas, initial, [c], source, frames),
              `shape ${shape}, flips ${flipX}/${flipY}, opacity ${opacity}`,
            );
          }
  } finally {
    frames.dispose();
    canvas.width = canvas.height = 1;
  }
});

test("direct slope adapter preserves original paint and vertex-tint composition in overlapping command order", () => {
  const source = sourceTexture(),
    canvas = createCanvas(35, 29),
    initial = background(canvas.width, canvas.height),
    commands = Array.from({ length: 32 }, (_, i) =>
      command(2 + (i % 4), {
        dx: ((i * 7) % 38) - 8,
        dy: ((i * 11) % 32) - 7,
        flipX: !!(i & 1),
        flipY: !!(i & 2),
        opacity: [0, 0.6, 0.95, 1][(i >> 2) % 4],
        paintId: [0, 1, 2, 26, 30, 31][i % 6],
        ...(i % 3 === 0 ? { vertexColor: [137, 255, 19, 111] } : {}),
        ...(i % 5 === 0 ? { kind: "wall", type: 21 } : {}),
      }),
    ),
    frames = referenceFrames(commands, source),
    actual = initial.slice();
  try {
    for (const c of commands) {
      const prepared = prepareCanonicalSlopeOverviewFrame(c, source);
      assert.equal(prepared.unsupported, undefined);
      assert.equal(prepared.mean, null);
      composePrepared(actual, canvas.width, canvas.height, c, prepared);
    }
    equalPixels(
      actual,
      renderOracle(canvas, initial, commands, source, frames),
      "ordered paint/tint slopes",
    );
  } finally {
    frames.dispose();
    canvas.width = canvas.height = 1;
  }
});

test("noncanonical and unsupported encodings delegate before raw access or Canvas allocation", () => {
  let reads = 0,
    allocations = 0;
  const source = registerTextureSource(
    { width: 20, height: 22 },
    {
      pngBytes: new Uint8Array(),
      rawRgbaProvider() {
        reads++;
        throw new Error("Unexpected raw read");
      },
    },
  );
  const options = {
    createCanvas() {
      allocations++;
      throw new Error("Unexpected Canvas");
    },
  };
  for (const extra of [
    { clip: null },
    {
      clip: [
        [0, 0],
        [15, 16],
        [0, 16],
      ],
    },
    { sw: 15 },
    { dh: 8 },
    { dx: 0.5 },
    { dy: Infinity },
    { dx: 2 ** 40 },
    { opacity: -1 },
    { opacity: 1.1 },
    { opacity: null },
    { opacity: NaN },
    { flipX: 1 },
    { vertexColors: {} },
  ])
    assert.equal(
      prepareCanonicalSlopeOverviewFrame(command(2, extra), source, options),
      null,
    );
  assert.equal(prepareCanonicalSlopeOverviewFrame(null, source, options), null);
  assert.equal(
    prepareCanonicalSlopeOverviewFrame(command(), source, {
      ...options,
      inputEncoding: "standard-straight",
    }),
    null,
  );
  assert.throws(
    () =>
      prepareCanonicalSlopeOverviewFrame(command(), source, {
        inputEncoding: "unknown",
      }),
    /Unknown asset channel encoding/,
  );
  assert.throws(
    () =>
      prepareCanonicalSlopeOverviewFrame(command(), source, {
        createCanvas: null,
      }),
    /Canvas factory/,
  );
  assert.equal(reads, 0);
  assert.equal(allocations, 0);
});

test("source, crop, paint, tint and opaque-scene failures retain original preparation reasons", () => {
  const source = sourceTexture(),
    corrupt = registerTextureSource(
      { width: 20, height: 22 },
      {
        pngBytes: new Uint8Array(),
        rawError: "strict-import-failed",
      },
    ),
    throwing = registerTextureSource(
      { width: 20, height: 22 },
      {
        pngBytes: new Uint8Array(),
        rawRgbaProvider() {
          throw Object.assign(new Error("Provider failed"), {
            reason: "provider-failed",
          });
        },
      },
    );
  const cases = [
    [command(), null, {}, "missing-source-texture"],
    [command(2, { sx: -1 }), source, {}, "invalid-frame-bounds"],
    [command(2, { sy: 0.5 }), source, {}, "invalid-frame-bounds"],
    [command(2, { sx: 10 }), source, {}, "source-crop-outside-texture"],
    [command(2, { paintId: 32 }), source, {}, "unknown-paint-id"],
    [command(2, { paintId: 1, type: -1 }), source, {}, "unknown-tile-type"],
    [
      command(2, { vertexColor: [0, 1, 2] }),
      source,
      {},
      "paint-frame-preparation-failed",
    ],
    [command(), corrupt, {}, "strict-import-failed"],
    [command(), throwing, {}, "provider-failed"],
    [
      command(),
      source,
      { opaqueScene: false },
      "premultiplied-excess-needs-opaque-scene",
    ],
  ];
  for (const [c, image, options, reason] of cases) {
    const frames = referenceFrames([c], image, options);
    try {
      assert.equal(frames.resolve(c).unsupported, reason);
      assert.deepEqual(prepareCanonicalSlopeOverviewFrame(c, image, options), {
        unsupported: reason,
      });
    } finally {
      frames.dispose();
    }
  }
});

test("every temporary Canvas is released on success and partial preparation/readback failures", () => {
  const source = sourceTexture();
  for (const failAt of [0, 2, 3]) {
    const canvases = [];
    const trackedFactory = (width, height) => {
      const canvas = createCanvas(width, height);
      canvases.push(canvas);
      if (canvases.length === failAt)
        canvas.getContext = () => {
          throw new Error("Injected context failure");
        };
      return canvas;
    };
    const result = prepareCanonicalSlopeOverviewFrame(command(), source, {
      createCanvas: trackedFactory,
    });
    if (failAt === 0) {
      assert.equal(result.unsupported, undefined);
      assert.equal(result.base.byteLength, 1024);
      assert.equal(result.additive.byteLength, 1024);
      assert.ok(
        result.base.some((v) => v !== 0),
        "Pixels outlive temporary surfaces",
      );
    } else if (failAt === 2)
      assert.deepEqual(result, {
        unsupported: "paint-frame-preparation-failed",
      });
    else assert.equal(result, null);
    assert.equal(canvases.length, failAt || 3);
    assert.ok(
      canvases.every((canvas) => canvas.width === 1 && canvas.height === 1),
    );
    assert.deepEqual([source.width, source.height], [20, 22]);
  }
});
