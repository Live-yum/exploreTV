import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { registerTextureSource } from "../core/assets.mjs";
import {
  prepareSceneFrames,
  createSceneFrameCache,
} from "../core/scene-frames.mjs";
import { renderScene } from "../core/renderer.mjs";
import {
  prepareOpaqueOverview,
  applyOpaqueOverview,
} from "../scripts/overview-fast-path.mjs";
import { boxDownsampleRgba } from "../scripts/downsample-rgba.mjs";
function texture(pixel, width = 32, height = 32) {
  const canvas = createCanvas(width, height),
    ctx = canvas.getContext("2d"),
    image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      image.data.set(
        typeof pixel === "function" ? pixel(x, y) : pixel,
        (y * width + x) * 4,
      );
  ctx.putImageData(image, 0, 0);
  return registerTextureSource(canvas, {
    pngBytes: new Uint8Array(),
    rawRgba: { width, height, data: image.data },
  });
}
const command = (overrides = {}) => ({
  kind: "tile",
  asset: "opaque",
  type: 1,
  sx: 0,
  sy: 0,
  sw: 16,
  sh: 16,
  dx: 0,
  dy: 0,
  dw: 16,
  dh: 16,
  paintId: 0,
  ...overrides,
});
const assets = new Map([
  [
    "opaque",
    texture((x, y) => [(x * 5) % 256, (y * 7) % 256, ((x + y) * 3) % 256, 255]),
  ],
  ["alpha", texture([30, 60, 90, 128])],
  ["excess", texture([180, 200, 160, 128])],
  ["hole", texture((x, y) => [200, 80, 20, x === 8 && y === 8 ? 0 : 255])],
]);
function compare(
  commands,
  {
    width = 64,
    height = 48,
    core = { x: 0, y: 0, width: width / 16, height: height / 16 },
  } = {},
) {
  const plan = { width, height, commands, warnings: [] },
    cache = createSceneFrameCache(),
    opts = {
      frameCache: cache,
      inputEncoding: "tconvert-game-raw",
      opaqueScene: true,
    },
    fast = prepareOpaqueOverview(plan, assets, createCanvas, opts);
  const draw = (filter) => {
    const canvas = createCanvas(width, height),
      ctx = canvas.getContext("2d"),
      frames = prepareSceneFrames(plan, assets, createCanvas, opts);
    renderScene(ctx, { ...plan, commands: commands.filter(filter) }, assets, {
      sceneFrames: frames,
    });
    const raw = ctx.getImageData(
        core.x * 16,
        core.y * 16,
        core.width * 16,
        core.height * 16,
      ).data,
      out = boxDownsampleRgba(raw, core.width * 16, core.height * 16, 16);
    frames.dispose();
    canvas.width = canvas.height = 1;
    return out;
  };
  const baseline = draw(() => true),
    reduced = draw((c) => !fast.skip.has(c));
  applyOpaqueOverview(reduced, core, { rect: { x: 0, y: 0 } }, fast);
  assert.deepEqual(reduced, baseline);
  cache.dispose();
  return fast;
}
test("exact opaque final frames replace hidden background draws and deduplicate", () => {
  const commands = [
    command({ asset: "alpha", dw: 32, dh: 16, sw: 32 }),
    command(),
    command({ dx: 16 }),
  ];
  const fast = compare(commands);
  assert.equal(fast.eligibleTiles, 2);
  assert.equal(fast.skip.size, 3);
  assert.equal(fast.uniqueCandidateFrames, 1);
});
test("later transparent, additive, overlapping wall and tree spans block the shortcut", () => {
  for (const later of [
    command({ asset: "alpha", dx: 8, dy: 3 }),
    command({ asset: "excess", dx: 8 }),
    command({ kind: "wall", dx: 8, sw: 32, dw: 32 }),
    command({ dx: 15.5, dy: 0.5 }),
    command({ opacity: 0.5 }),
    command({
      clip: [
        [0, 0],
        [16, 16],
        [0, 16],
      ],
    }),
  ]) {
    const fast = compare([command(), command({ dx: 16 }), later]);
    assert.equal(fast.safe[0], 0);
  }
});
test("alpha holes, opacity, additive, clips, flips, and scaling remain fallback", () => {
  for (const c of [
    command({ asset: "hole" }),
    command({ asset: "alpha" }),
    command({ asset: "excess" }),
    command({ opacity: 0.9 }),
    command({
      clip: [
        [0, 0],
        [16, 16],
        [0, 16],
      ],
    }),
    command({ flipX: true }),
    command({ flipY: true }),
    command({ sw: 32 }),
    command({ dx: 0.5 }),
    command({ paintId: 26, asset: "alpha" }),
  ]) {
    const fast = compare([c]);
    assert.equal(fast.eligibleTiles, 0);
  }
});
test("paint and vertex tint are averaged after the actual prepared-frame conversion", () => {
  for (const effect of [
    { paintId: 26 },
    { paintId: 1 },
    { vertexColor: [100, 210, 75, 255] },
    {
      vertexColors: {
        topLeft: [255, 0, 0, 255],
        topRight: [0, 255, 0, 255],
        bottomLeft: [0, 0, 255, 255],
        bottomRight: [255, 255, 255, 255],
      },
    },
  ]) {
    const fast = compare([command(effect)]);
    assert.equal(fast.eligibleTiles, 1);
  }
});
test("earlier oversized wall is retained if any covered cell still needs it", () => {
  const commands = [
    command({ kind: "wall", asset: "alpha", sw: 32, sh: 32, dw: 32, dh: 32 }),
    command(),
  ];
  const fast = compare(commands);
  assert.equal(fast.skip.has(commands[0]), false);
  assert.equal(fast.skip.has(commands[1]), true);
});
test("core cropping applies only the matching padded-scene override cells", () => {
  compare(
    [command({ dx: 16, dy: 16 }), command({ dx: 32, dy: 16, paintId: 1 })],
    { core: { x: 1, y: 1, width: 2, height: 1 } },
  );
});
test("invalid geometry conservatively disables the shortcut", () => {
  const fast = prepareOpaqueOverview(
    { width: 16, height: 16, commands: [command(), command({ dx: NaN })] },
    assets,
    createCanvas,
  );
  assert.equal(fast.eligibleTiles, 0);
  assert.equal(fast.skip.size, 0);
});
test("seeded mixed stacks preserve exact reduced pixels across overlap and clipping", () => {
  let seed = 0x51afe;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const names = ["opaque", "alpha", "excess", "hole"];
  for (let scene = 0; scene < 80; scene++) {
    const commands = [];
    for (let i = 0; i < 18; i++) {
      const effect = random(8),
        c = command({
          asset: names[random(names.length)],
          dx: (random(6) - 1) * 8,
          dy: (random(6) - 1) * 8,
        });
      if (effect === 0) c.opacity = 0.6;
      if (effect === 1) {
        c.sw = 32;
        c.dw = 32;
      }
      if (effect === 2) {
        c.sh = 32;
        c.dh = 32;
        c.kind = "wall";
      }
      if (effect === 3)
        c.clip = [
          [0, 0],
          [16, 16],
          [0, 16],
        ];
      if (effect === 4) c.flipX = true;
      if (effect === 5) c.paintId = 26;
      if (effect === 6) c.dx += 0.25;
      commands.push(c);
    }
    // Some safe cells, with prior overlap, must survive the mixed-stack analysis.
    commands.push(command({ dx: 16, dy: 16, paintId: scene % 2 ? 1 : 0 }));
    compare(commands);
  }
});
