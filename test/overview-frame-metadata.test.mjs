import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { PNG } from "pngjs";
import { registerTextureSource } from "../core/assets.mjs";
import { createSceneFrameCache, sceneFrameKey } from "../core/scene-frames.mjs";
import {
  applyOpaqueOverview,
  createOverviewFrameMetadataCache,
  prepareOpaqueOverview,
} from "../scripts/overview-fast-path.mjs";
import { createWorldRenderer } from "../scripts/world-render-engine.mjs";
import { boxDownsampleRgba } from "../scripts/downsample-rgba.mjs";

function texture(rgb, width = 32) {
  const canvas = createCanvas(width, 16),
    ctx = canvas.getContext("2d"),
    pixels = ctx.createImageData(width, 16);
  for (let i = 0; i < pixels.data.length; i += 4)
    pixels.data.set([...rgb, 255], i);
  ctx.putImageData(pixels, 0, 0);
  registerTextureSource(canvas, {
    pngBytes: new Uint8Array(),
    rawRgba: { width, height: 16, data: pixels.data },
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
  paintId: 0,
  ...extra,
});

test("opaque tinted means survive native-frame eviction without re-preparing a canvas", () => {
  const assets = new Map([["source", texture([43, 81, 109])]]),
    frameCache = createSceneFrameCache({ maxFrames: 1, maxBytes: 1024 }),
    metadataCache = createOverviewFrameMetadataCache();
  const prepare = (c) =>
    prepareOpaqueOverview(
      { width: 16, height: 16, commands: [c] },
      assets,
      createCanvas,
      {
        frameCache,
        metadata: metadataCache.view(assets, createCanvas, "tconvert-game-raw"),
      },
    );
  try {
    const first = prepare(command({ vertexColor: [255, 255, 255, 255] }));
    prepare(command({ sx: 16, vertexColor: [255, 255, 255, 255] }));
    assert.equal(frameCache.stats.evictions, 1);
    const misses = frameCache.stats.misses,
      again = prepare(command({ vertexColor: [255, 255, 255, 255] }));
    assert.deepEqual(again.rgba, first.rgba);
    assert.equal(again.eligibleTiles, 1);
    assert.equal(frameCache.stats.misses, misses);
    assert.equal(metadataCache.stats.hits, 1);
  } finally {
    frameCache.dispose();
    metadataCache.dispose();
  }
});

test("metadata isolates source identity, registration, factory and encoding", () => {
  const source = texture([31, 47, 79]),
    assets = new Map([["source", source]]),
    cache = createOverviewFrameMetadataCache(),
    c = command(),
    key = sceneFrameKey(c),
    initial = cache.view(assets, createCanvas, "tconvert-game-raw");
  try {
    initial.remember(c, key, { unsupported: "unknown-paint-id" });
    assert.equal(
      cache.view(assets, createCanvas, "tconvert-game-raw").get(c, key)
        .unsupported,
      "unknown-paint-id",
    );
    assert.equal(
      cache.view(assets, createCanvas, "standard-straight").get(c, key),
      undefined,
    );
    assert.equal(
      cache
        .view(assets, (w, h) => createCanvas(w, h), "tconvert-game-raw")
        .get(c, key),
      undefined,
    );
    assets.set("source", texture([89, 97, 113]));
    assert.equal(
      cache.view(assets, createCanvas, "tconvert-game-raw").get(c, key),
      undefined,
    );
    assets.set("source", source);
    registerTextureSource(source, {
      pngBytes: new Uint8Array(),
      rawRgba: {
        width: 32,
        height: 16,
        data: new Uint8ClampedArray(32 * 16 * 4),
      },
    });
    assert.equal(
      cache.view(assets, createCanvas, "tconvert-game-raw").get(c, key),
      undefined,
    );
  } finally {
    cache.dispose();
  }
});

test("metadata bounds entries and bytes and retries transient preparation failures", () => {
  const assets = new Map([["source", texture([31, 47, 79])]]),
    cache = createOverviewFrameMetadataCache({ maxEntries: 1, maxBytes: 1024 }),
    c = command(),
    d = command({ sx: 16 }),
    key = sceneFrameKey(c),
    otherKey = sceneFrameKey(d);
  try {
    let view = cache.view(assets, createCanvas, "tconvert-game-raw");
    view.remember(c, key, { unsupported: "unknown-paint-id" });
    view.remember(d, otherKey, { unsupported: "unknown-paint-id" });
    assert.equal(cache.stats.entries, 1);
    assert.equal(cache.stats.evictions, 1);
    assert.ok(cache.stats.estimatedBytes <= 1024);
    view = cache.view(assets, createCanvas, "tconvert-game-raw");
    assert.equal(view.get(c, key), undefined);
    view.remember(c, key, { unsupported: "paint-frame-preparation-failed" });
    assert.equal(view.get(c, key), undefined);
    assert.equal(
      cache.view(assets, createCanvas, "tconvert-game-raw").get(c, key),
      undefined,
    );
    view.remember(c, "x".repeat(1024), null);
    assert.equal(cache.stats.bypasses, 1);
    assert.ok(cache.stats.peakEstimatedBytes <= 1024);
  } finally {
    cache.dispose();
  }
  assert.equal(cache.stats.entries, 0);
  assert.throws(
    () => cache.view(assets, createCanvas, "tconvert-game-raw"),
    /disposed/,
  );
});

function createAssets(t) {
  const dir = mkdtempSync(join(tmpdir(), "exploretv-overview-metadata-")),
    assetDir = join(dir, "assets");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(assetDir);
  for (const [name, width, height, color] of [
    ["Tiles_1.png", 288, 270, [60, 90, 120, 255]],
    ["Wall_1.png", 468, 180, [100, 50, 25, 127]],
    ["Tiles_4.png", 88, 100, [200, 100, 0, 255]],
  ]) {
    const png = new PNG({ width, height });
    for (let i = 0; i < png.data.length; i += 4) png.data.set(color, i);
    writeFileSync(join(assetDir, name), PNG.sync.write(png));
  }
  return assetDir;
}

test("hidden frames and halo commands preserve pixels and all logical omission counters", async (t) => {
  const assetDir = createAssets(t),
    width = 14,
    height = 14,
    cells = Array.from({ length: width * height }, () => ({
      active: true,
      type: 1,
      wall: 1,
      shape: 0,
      liquid: 0,
    }));
  // Exercise each omission path in the exported core, plus an unsupported
  // halo frame which must not be counted as a successful culled native draw.
  cells[6 * height + 6] = { ...cells[0], type: 2 };
  cells[7 * height + 6] = { ...cells[0], paint: 33 };
  cells[6 * height + 7] = {
    ...cells[0],
    type: 4,
    frameX: 0,
    frameY: 999,
  };
  cells[0] = { ...cells[0], paint: 33 };
  const region = { rect: { x: 0, y: 0, width, height }, cells, version: 269 },
    core = { x: 5, y: 5, width: 4, height: 4 };
  const render = async (lowMemory, repeats) => {
    const renderer = createWorldRenderer({ assetDir, lowMemory }),
      canvas = createCanvas(1, 1);
    try {
      const snapshots = [];
      let pixels;
      for (let i = 0; i < repeats; i++) {
        const drawn = await renderer.drawRegion(region, canvas, {
          core,
          count: true,
          overview: lowMemory,
          coreSurface: lowMemory,
        });
        pixels = boxDownsampleRgba(
          canvas
            .getContext("2d")
            .getImageData(
              drawn.readbackX,
              drawn.readbackY,
              core.width * 16,
              core.height * 16,
            ).data,
          core.width * 16,
          core.height * 16,
          16,
        );
        if (drawn.opaqueOverview)
          applyOpaqueOverview(pixels, core, region, drawn.opaqueOverview);
        snapshots.push(structuredClone(renderer.stats));
      }
      return { pixels, snapshots };
    } finally {
      renderer.dispose();
      canvas.width = canvas.height = 1;
    }
  };
  const baseline = await render(false, 2),
    optimized = await render(true, 2);
  assert.deepEqual(optimized.pixels, baseline.pixels);
  for (let i = 0; i < 2; i++) {
    for (const name of [
      "plannedCommands",
      "renderedCommands",
      "commandCounts",
      "missingCommands",
      "invalidCommands",
      "effectFailures",
      "unsupportedTiles",
      "liquidUnsupported",
    ])
      assert.deepEqual(
        optimized.snapshots[i][name],
        baseline.snapshots[i][name],
        name,
      );
  }
  assert.equal(optimized.snapshots[0].missingCommands["Tiles_2.png"], 1);
  assert.equal(optimized.snapshots[0].invalidCommands["Tiles_4.png"], 1);
  assert.equal(optimized.snapshots[0].effectFailures["unknown-paint-id"], 1);
  assert.equal(
    optimized.snapshots[1].frameCache.misses,
    optimized.snapshots[0].frameCache.misses,
  );
  assert.ok(
    optimized.snapshots[1].skippedFramePreparationCommands >
      optimized.snapshots[0].skippedFramePreparationCommands,
  );
  assert.equal(
    optimized.snapshots[1].culledOutsideCoreCommands,
    optimized.snapshots[0].culledOutsideCoreCommands * 2,
  );
});
