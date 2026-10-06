import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { createCanvas } from "@napi-rs/canvas";
import { createWorldRenderer } from "../scripts/world-render-engine.mjs";
import { sceneFrameKey, prepareSceneFrames } from "../core/scene-frames.mjs";
import { renderScene } from "../core/renderer.mjs";
import { registerTextureSource } from "../core/assets.mjs";

const region = {
  rect: { x: 10, y: 20, width: 1, height: 1 },
  cells: [{ active: false, liquid: 0 }],
  version: 315,
};
const command = (extra) => ({
  kind: "waterfall",
  asset: "Tiles_1.png",
  type: 1,
  sx: 0,
  sy: 0,
  sw: 16,
  sh: 16,
  dx: 0,
  dy: 0,
  dw: 16,
  dh: 16,
  x: 0,
  y: 0,
  paintId: 0,
  ...extra,
});
function fixture(t, width = 512) {
  const path = mkdtempSync(join(tmpdir(), "exploretv-validation-memo-")),
    png = new PNG({ width, height: 16 });
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < width; x++)
      png.data.set(
        [(x * 3 + 7) % 128, (y * 5 + 13) % 128, (x + y * 7 + 31) % 128, 127],
        (y * width + x) * 4,
      );
  const bytes = PNG.sync.write(png);
  writeFileSync(join(path, "Tiles_1.png"), bytes);
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return { path, png, bytes };
}
function registry(commands) {
  return {
    model: "fixed-test-registry",
    scanComplete: true,
    stats: {},
    failures: [],
    hasOrigin: () => false,
    commandsFor: () => commands,
  };
}
function sourceAssets(f) {
  const source = registerTextureSource(
    { width: f.png.width, height: 16 },
    {
      pngBytes: f.bytes,
      rawRgba: {
        width: f.png.width,
        height: 16,
        data: f.png.data,
      },
    },
  );
  return new Map([["Tiles_1.png", source]]);
}
function oracle(f, commands) {
  const assets = sourceAssets(f),
    plan = { width: 16, height: 16, commands, warnings: [] },
    frames = prepareSceneFrames(plan, assets, createCanvas, {
      inputEncoding: "tconvert-game-raw",
      opaqueScene: true,
    }),
    canvas = createCanvas(16, 16);
  try {
    assert.equal(frames.support.unsupportedCommands, 0);
    renderScene(canvas.getContext("2d"), plan, assets, {
      strict: true,
      sceneFrames: frames,
    });
    return Buffer.from(canvas.getContext("2d").getImageData(0, 0, 16, 16).data);
  } finally {
    frames.dispose();
    canvas.width = canvas.height = 1;
  }
}

test("validation memo compares source crop fields when distinct inputs share a string frame key", async (t) => {
  const f = fixture(t, 8),
    valid = command({ sx: 1, sw: 6, dw: 6 }),
    invalid = { ...valid, sx: "1" },
    commands = [valid, invalid, { ...valid, dx: 5 }];
  assert.equal(sceneFrameKey(valid), sceneFrameKey(invalid));
  // Numeric 1 + 6 fits the eight-pixel source; string "1" + 6 does not.
  const renderer = createWorldRenderer({
      assetDir: f.path,
      lowMemory: true,
      waterfallRegistry: registry(commands),
    }),
    canvas = createCanvas(1, 1);
  try {
    const expected = oracle(f, [commands[0], commands[2]]);
    for (let repeat = 1; repeat <= 2; repeat++) {
      const drawn = await renderer.drawRegion(region, canvas, {
        core: region.rect,
        count: true,
        overview: true,
        coreSurface: true,
      });
      assert.deepEqual(drawn.plan.commands, commands);
      assert.deepEqual(
        Buffer.from(canvas.getContext("2d").getImageData(0, 0, 16, 16).data),
        expected,
      );
      assert.equal(renderer.stats.plannedCommands, repeat * 3);
      assert.equal(renderer.stats.renderedCommands, repeat * 2);
      assert.equal(renderer.stats.invalidCommands["Tiles_1.png"], repeat);
      assert.deepEqual(renderer.stats.effectFailures, {});
    }
  } finally {
    renderer.dispose();
    canvas.width = canvas.height = 1;
  }
});

test("transient preparation failures retry in later batches without becoming memoized success or failure", async (t) => {
  const f = fixture(t),
    target = command({ sw: 7, dw: 7 }),
    commands = [target];
  for (let i = 0; i < 450; i++) commands.push(command({ sx: i }));
  commands.push({ ...target, dx: 9 });
  const expected = oracle(f, commands.slice(1)),
    renderer = createWorldRenderer({
      assetDir: f.path,
      lowMemory: true,
      waterfallRegistry: registry(commands),
    }),
    canvas = createCanvas(1, 1),
    context = canvas.getContext("2d"),
    prototype = Object.getPrototypeOf(context),
    descriptor = Object.getOwnPropertyDescriptor(prototype, "createImageData"),
    original = prototype.createImageData;
  let attempts = 0;
  Object.defineProperty(prototype, "createImageData", {
    ...descriptor,
    value(...args) {
      if (args[0] === 7 && args[1] === 16 && ++attempts === 1)
        throw new Error("one deliberate transient frame allocation failure");
      return original.apply(this, args);
    },
  });
  try {
    const drawn = await renderer.drawRegion(region, canvas, {
      core: region.rect,
      count: true,
      overview: true,
      coreSurface: true,
    });
    assert.equal(
      attempts,
      2,
      "the same seven-pixel frame is retried in the second batch",
    );
    assert.equal(drawn.plan.commands.length, 452);
    assert.equal(renderer.stats.plannedCommands, 452);
    assert.equal(renderer.stats.renderedCommands, 451);
    assert.deepEqual(renderer.stats.effectFailures, {
      "paint-frame-preparation-failed": 1,
    });
    assert.deepEqual(
      Buffer.from(context.getImageData(0, 0, 16, 16).data),
      expected,
    );
    const before = renderer.stats.frameCache.misses;
    await renderer.drawRegion(region, canvas, {
      core: region.rect,
      count: true,
      overview: true,
      coreSurface: true,
    });
    assert.equal(renderer.stats.renderedCommands, 903);
    assert.equal(
      renderer.stats.effectFailures["paint-frame-preparation-failed"],
      1,
    );
    assert.equal(renderer.stats.frameCache.misses, before);
  } finally {
    Object.defineProperty(prototype, "createImageData", descriptor);
    renderer.dispose();
    canvas.width = canvas.height = 1;
  }
});
