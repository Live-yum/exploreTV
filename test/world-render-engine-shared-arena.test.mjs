import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import { createCanvas } from "@napi-rs/canvas";
import { createWorldRenderer } from "../scripts/world-render-engine.mjs";
import { nativeBlitterStatus } from "../scripts/native-blitter.mjs";
import { nativeReducerStatus } from "../scripts/native-reducer.mjs";
import { boxDownsampleRgba } from "../scripts/downsample-rgba.mjs";
import { applyOpaqueOverview } from "../scripts/overview-fast-path.mjs";

const nativeOptions = {
  skip: !nativeBlitterStatus.available || !nativeReducerStatus.available,
};

function assets(t) {
  const path = mkdtempSync(join(tmpdir(), "exploretv-shared-engine-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  for (const [name, width, height] of [
    ["Tiles_1.png", 288, 270],
    ["Wall_1.png", 468, 180],
    ["water_0.png", 48, 1360],
    ["Liquid_0.png", 16, 16],
  ]) {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        png.data.set(
          [
            (x * 7 + 31) & 255,
            (y * 5 + 43) & 255,
            (x + y + 71) & 255,
            [0, 127, 255][(x + y) % 3],
          ],
          (y * width + x) * 4,
        );
    writeFileSync(join(path, name), PNG.sync.write(png));
  }
  return path;
}

function scene(width, height, mixed = true) {
  const region = {
    rect: { x: 100, y: 200, width, height },
    version: 315,
    source: { width: 8400, height: 2400, worldSurface: 649 },
    cells: Array.from({ length: width * height }, () => ({
      active: true,
      type: 1,
      shape: 0,
      wall: 1,
      liquid: 0,
      liquidKind: 0,
    })),
  };
  if (mixed) {
    const put = (x, y, extra) =>
      Object.assign(region.cells[x * height + y], extra);
    put(6, 5, { shape: 2 });
    put(9, 6, { paint: 2 });
    // A four-row PointClamp continuation requires the ordinary Canvas path.
    put(12, 8, { shape: 1, wall: 0, liquid: 127, liquidKind: 1 });
    put(12, 7, { active: false, wall: 0, liquid: 200, liquidKind: 1 });
    put(11, 8, { active: false, wall: 0, liquid: 120, liquidKind: 1 });
  }
  return region;
}

// Read the returned software buffer AFTER drawRegion's finally/finish. Its
// shared arena lease must remain valid until the next draw invalidates it.
function output(drawn, canvas, core, region) {
  const width = core.width * 16,
    height = core.height * 16;
  let detailed;
  if (drawn.softwareOverview) {
    const software = drawn.softwareOverview;
    detailed = Buffer.from(software.pixels);
    if (software.canvasCommands) {
      const fallback = canvas
        .getContext("2d")
        .getImageData(drawn.readbackX, drawn.readbackY, width, height).data;
      for (let y = 0; y < core.height; y++)
        for (let x = 0; x < core.width; x++) {
          if (!software.unsafe[y * core.width + x]) continue;
          for (let row = 0; row < 16; row++) {
            const start = ((y * 16 + row) * width + x * 16) * 4;
            detailed.set(fallback.subarray(start, start + 64), start);
          }
        }
    }
  } else if (drawn.rasterizedCommands)
    detailed = canvas
      .getContext("2d")
      .getImageData(drawn.readbackX, drawn.readbackY, width, height).data;
  const reduced = detailed
    ? Buffer.from(boxDownsampleRgba(detailed, width, height, 16))
    : Buffer.alloc(core.width * core.height * 4);
  if (!detailed) for (let i = 3; i < reduced.length; i += 4) reduced[i] = 255;
  if (drawn.opaqueOverview)
    applyOpaqueOverview(reduced, core, region, drawn.opaqueOverview);
  if (drawn.directTerrainOverview) {
    const { safe, pixels } = drawn.directTerrainOverview;
    for (let i = 0; i < safe.length; i++)
      if (safe[i]) reduced.set(pixels.subarray(i * 4, i * 4 + 4), i * 4);
  }
  return reduced;
}

test(
  "engine serializes shared detailed pixels across mixed cores while preserving completed direct output",
  nativeOptions,
  async (t) => {
    const assetDir = assets(t),
      baseline = createWorldRenderer({
        assetDir,
        lowMemory: true,
        nativeOverview: true,
      }),
      actual = createWorldRenderer({
        assetDir,
        lowMemory: true,
        nativeOverview: true,
        directTerrainOverview: true,
      }),
      expectedCanvas = createCanvas(1, 1),
      actualCanvas = createCanvas(1, 1);
    let sharedBuffer, previousDirect;
    assert.equal(baseline.stats.sharedDetailedRgba, null);
    assert.equal(
      baseline.stats.nativeOverview.liveFrameByteLimit,
      8 * 1024 * 1024,
    );
    assert.equal(
      actual.stats.nativeOverview.liveFrameByteLimit,
      2 * 1024 * 1024,
    );
    try {
      for (const [width, height, mixed] of [
        [24, 20, true],
        [32, 24, true],
        [20, 16, true],
        [24, 20, false],
      ]) {
        const region = scene(width, height, mixed),
          core = { x: 103, y: 203, width: width - 6, height: height - 6 },
          options = { core, count: true, overview: true, coreSurface: true },
          expected = await baseline.drawRegion(region, expectedCanvas, options),
          drawn = await actual.drawRegion(region, actualCanvas, options);
        if (previousDirect)
          assert.deepEqual(
            Buffer.from(previousDirect.pixels),
            previousDirect.copy,
          );
        assert.deepEqual(
          output(drawn, actualCanvas, core, region),
          output(expected, expectedCanvas, core, region),
        );
        assert.deepEqual(drawn.plan, expected.plan);
        assert.equal(drawn.coreCommands, expected.coreCommands);
        assert.ok(drawn.directTerrainOverview);
        previousDirect = {
          pixels: drawn.directTerrainOverview.pixels,
          copy: Buffer.from(drawn.directTerrainOverview.pixels),
        };
        if (mixed) {
          assert.ok(drawn.softwareOverview.canvasCommands > 0);
          const buffer = drawn.softwareOverview.pixels.buffer;
          if (sharedBuffer)
            assert.equal(
              buffer,
              sharedBuffer,
              "Different core sizes reuse one allocation",
            );
          sharedBuffer = buffer;
        } else assert.equal(drawn.softwareOverview, null);
        assert.equal(actual.stats.nativeOverview.bufferBytes, 0);
        assert.equal(actual.stats.directTerrainOverviewStats.bufferBytes, 0);
        assert.equal(
          actual.stats.sharedDetailedRgba.bufferBytes,
          6 * 1024 * 1024,
        );
        assert.equal(actual.stats.sharedDetailedRgba.allocations, 1);
        assert.equal(
          actual.stats.sharedDetailedRgba.activeBytes,
          mixed ? core.width * core.height * 1024 : 0,
        );
        assert.ok(
          actual.stats.nativeOverview.peakLiveFrameBytes <= 2 * 1024 * 1024,
        );
        for (const field of [
          "plannedCommands",
          "renderedCommands",
          "commandCounts",
          "assetHashes",
          "missingCommands",
          "invalidCommands",
          "effectFailures",
          "liquidUnsupported",
          "unsupportedTiles",
        ])
          assert.deepEqual(actual.stats[field], baseline.stats[field], field);
      }
    } finally {
      actual.dispose();
      baseline.dispose();
      expectedCanvas.width = expectedCanvas.height = 1;
      actualCanvas.width = actualCanvas.height = 1;
    }
    assert.equal(actual.stats.sharedDetailedRgba.bufferBytes, 0);
    assert.equal(actual.stats.sharedDetailedRgba.activeBytes, 0);
    assert.equal(
      actual.stats.sharedDetailedRgba.acquisitions,
      actual.stats.sharedDetailedRgba.releases,
    );
    actual.dispose();
  },
);

test(
  "recording keeps the original independent backing and 8 MiB generic frame budget",
  nativeOptions,
  async (t) => {
    const assetDir = assets(t);
    let batches = 0;
    const renderer = createWorldRenderer({
        assetDir,
        lowMemory: true,
        nativeOverview: true,
        directTerrainOverview: true,
        onNativeBatch(batch) {
          batches++;
          assert.ok(batch.descriptors.length);
        },
      }),
      canvas = createCanvas(1, 1),
      region = scene(24, 20),
      core = { x: 103, y: 203, width: 18, height: 14 };
    try {
      const drawn = await renderer.drawRegion(region, canvas, {
        core,
        overview: true,
        count: true,
        coreSurface: true,
      });
      assert.equal(drawn.directTerrainOverview, null);
      assert.equal(renderer.stats.directTerrainOverviewStats, null);
      assert.equal(renderer.stats.sharedDetailedRgba, null);
      assert.equal(
        renderer.stats.nativeOverview.liveFrameByteLimit,
        8 * 1024 * 1024,
      );
      assert.ok(renderer.stats.nativeOverview.bufferBytes > 0);
      assert.ok(batches > 0);
      assert.ok(
        output(drawn, canvas, core, region).some(
          (value, i) => i % 4 !== 3 && value !== 0,
        ),
      );
    } finally {
      renderer.dispose();
      canvas.width = canvas.height = 1;
    }
  },
);

test(
  "an engine omission callback failure releases the current pixel lease before retry",
  nativeOptions,
  async (t) => {
    const assetDir = assets(t),
      expectedError = new Error("Injected omission callback failure"),
      renderer = createWorldRenderer({
        assetDir,
        lowMemory: true,
        nativeOverview: true,
        directTerrainOverview: true,
        onOmission(_x, _y, reason) {
          if (reason === 4) throw expectedError;
        },
      }),
      canvas = createCanvas(1, 1),
      region = scene(24, 20, false),
      core = { x: 103, y: 203, width: 18, height: 14 },
      options = { core, count: true, overview: true, coreSurface: true };
    // Tiles_0 is absent. Its valid geometry reaches software.begin(), then the
    // engine's metadata preflight calls onOmission outside the native view API.
    region.cells[8 * region.rect.height + 7].type = 0;
    try {
      await assert.rejects(
        renderer.drawRegion(region, canvas, options),
        (error) => error === expectedError,
      );
      assert.ok(renderer.stats.sharedDetailedRgba.acquisitions >= 2);
      assert.equal(renderer.stats.sharedDetailedRgba.activeBytes, 0);
      assert.equal(
        renderer.stats.sharedDetailedRgba.acquisitions,
        renderer.stats.sharedDetailedRgba.releases,
      );
      region.cells[8 * region.rect.height + 7].type = 1;
      const drawn = await renderer.drawRegion(region, canvas, options);
      assert.ok(drawn.directTerrainOverview);
      assert.equal(drawn.softwareOverview, null);
      assert.equal(
        output(drawn, canvas, core, region).length,
        core.width * core.height * 4,
      );
      assert.equal(renderer.stats.sharedDetailedRgba.activeBytes, 0);
      assert.equal(renderer.stats.sharedDetailedRgba.allocations, 1);
    } finally {
      renderer.dispose();
      canvas.width = canvas.height = 1;
    }
  },
);
