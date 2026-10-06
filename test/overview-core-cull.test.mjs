import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { createCanvas } from "@napi-rs/canvas";
import { createWorldRenderer } from "../scripts/world-render-engine.mjs";

// All planners, frame conversion and command accounting remain active. Compare
// the optimized draw to the ordinary renderer before any overview reduction.
test("core-only native draws retain translucent walls, slopes, liquids and overhangs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "exploretv-core-cull-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const assetDir = join(dir, "assets");
  mkdirSync(assetDir);
  for (const [name, width, height, seed] of [
    ["Tiles_1.png", 288, 270, 7],
    ["Wall_1.png", 468, 180, 17],
    ["water_0.png", 48, 1328, 31],
    ["Tiles_4.png", 88, 500, 47],
  ]) {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const alpha = [0, 1, 127, 254, 255][(x + y) % 5];
        png.data.set(
          [
            (x * 7 + seed) % 256,
            (y * 5 + seed) % 256,
            (x + y + seed) % 256,
            alpha,
          ],
          (y * width + x) * 4,
        );
      }
    writeFileSync(join(assetDir, name), PNG.sync.write(png));
  }
  const width = 35,
    height = 29;
  const cells = Array.from({ length: width * height }, (_, i) => {
    const x = Math.floor(i / height),
      y = i % height;
    return {
      active: y < 13 || y > 17,
      type: (x + y) % 13 === 0 ? 4 : 1,
      frameX: (x + y) % 13 === 0 ? 22 : null,
      frameY: (x + y) % 13 === 0 ? 264 : null,
      wall: 1,
      wallPaint: x % 4 === 0 ? 26 : 0,
      paint: y % 5 === 0 ? 2 : 0,
      shape: (x + y) % 13 !== 0 && x % 3 === 0 ? y % 6 : 0,
      liquid: y >= 14 && y <= 16 ? 255 : 0,
      liquidType: 0,
    };
  });
  const region = {
    rect: { x: 100, y: 200, width, height },
    cells,
    version: 269,
  };
  for (const core of [
    { x: 110, y: 210, width: 11, height: 9 },
    { x: 100, y: 200, width: 3, height: 5 },
    { x: 131, y: 224, width: 4, height: 5 },
  ]) {
    const render = async (lowMemory, coreSurface = false) => {
      const renderer = createWorldRenderer({ assetDir, lowMemory }),
        canvas = createCanvas(1, 1);
      try {
        if (lowMemory) {
          // Reuse one backing store through occupied → empty → occupied
          // scenes, so stale pixels/state cannot hide behind a fresh canvas.
          await renderer.drawRegion(region, canvas, { core, coreSurface });
          const empty = {
            ...region,
            cells: region.cells.map(() => ({ active: false })),
          };
          await renderer.drawRegion(empty, canvas, { core, coreSurface });
          const black = canvas
            .getContext("2d")
            .getImageData(0, 0, canvas.width, canvas.height).data;
          for (let i = 0; i < black.length; i += 4)
            assert.deepEqual(
              Array.from(black.subarray(i, i + 4)),
              [0, 0, 0, 255],
            );
        }
        const drawn = await renderer.drawRegion(region, canvas, {
          core,
          count: true,
          coreSurface,
        });
        return {
          pixels: Buffer.from(
            canvas
              .getContext("2d")
              .getImageData(
                drawn.readbackX,
                drawn.readbackY,
                core.width * 16,
                core.height * 16,
              ).data,
          ),
          stats: structuredClone(renderer.stats),
        };
      } finally {
        renderer.dispose();
        canvas.width = canvas.height = 1;
      }
    };
    const baseline = await render(false),
      optimized = await render(true);
    assert.deepEqual(optimized.pixels, baseline.pixels);
    const coreOnly = await render(true, true);
    assert.deepEqual(coreOnly.pixels, baseline.pixels);
    assert.ok(optimized.stats.earlyCulledHaloCommands > 0);
    assert.equal(baseline.stats.earlyCulledHaloCommands, 0);
    assert.equal(baseline.stats.culledOutsideCoreCommands, 0);
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
      assert.deepEqual(optimized.stats[name], baseline.stats[name], name);
    assert.equal(
      optimized.stats.plannedCommands,
      optimized.stats.renderedCommands,
    );
  }
});

test("core surfaces reject oversized or invalid rectangles before canvas allocation", async () => {
  const renderer = createWorldRenderer({
    assetDir: "/unused",
    lowMemory: true,
  });
  const canvas = createCanvas(1, 1);
  const region = {
    rect: { x: 10, y: 20, width: 1, height: 1 },
    cells: [{ active: false }],
    version: 269,
  };
  try {
    for (const core of [
      { x: 10, y: 20, width: 100000000, height: 100000000 },
      { x: 9, y: 20, width: 1, height: 1 },
      { x: 10, y: 20, width: 0, height: 1 },
      { x: 10.1, y: 20, width: 1, height: 1 },
      { x: 10, y: NaN, width: 1, height: 1 },
    ]) {
      await assert.rejects(
        renderer.drawRegion(region, canvas, { core, coreSurface: true }),
        /Core surface/,
      );
      assert.equal(canvas.width, 1);
      assert.equal(canvas.height, 1);
    }
  } finally {
    renderer.dispose();
  }
});
