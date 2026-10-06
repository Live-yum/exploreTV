import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { createCanvas } from "@napi-rs/canvas";
import { createWorldRenderer } from "../scripts/world-render-engine.mjs";
import { nativeBlitterStatus } from "../scripts/native-blitter.mjs";
import { nativeReducerStatus } from "../scripts/native-reducer.mjs";
import { boxDownsampleRgba } from "../scripts/downsample-rgba.mjs";
import { applyOpaqueOverview } from "../scripts/overview-fast-path.mjs";

const nativeAvailable =
  nativeBlitterStatus.available && nativeReducerStatus.available;
const logicalCounters = [
  "plannedCommands",
  "renderedCommands",
  "commandCounts",
  "missingCommands",
  "invalidCommands",
  "effectFailures",
  "unsupportedTiles",
  "liquidUnsupported",
  "sourceHiddenTiles",
  "assetFailures",
  "assetHashes",
  "maxPlanCommands",
];

function assetFixture(t) {
  const assetDir = mkdtempSync(join(tmpdir(), "exploretv-direct-engine-"));
  t.after(() => rmSync(assetDir, { recursive: true, force: true }));
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
        // Raw RGB can exceed alpha, exercising both base and additive draws.
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
  return assetDir;
}

function terrainRegion(width = 24, height = 20) {
  return {
    rect: { x: 100, y: 200, width, height },
    source: { width: 8400, height: 2400, worldSurface: 649 },
    version: 315,
    cells: Array.from({ length: width * height }, () => ({
      active: true,
      type: 1,
      frameX: null,
      frameY: null,
      shape: 0,
      wall: 1,
      liquid: 0,
      liquidKind: 0,
    })),
  };
}

function put(region, x, y, extra) {
  const i = x * region.rect.height + y;
  region.cells[i] = { ...region.cells[i], ...extra };
}

// Reconstruct the general compositor's detailed pixels before independently
// reducing them. The new direct result may replace only its proven safe cells.
function reducedPixels(drawn, canvas, core, region) {
  const width = core.width * 16,
    height = core.height * 16;
  let detailed = null;
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
  } else if (drawn.rasterizedCommands !== 0)
    detailed = canvas
      .getContext("2d")
      .getImageData(drawn.readbackX, drawn.readbackY, width, height).data;
  let data;
  if (detailed)
    data = Buffer.from(boxDownsampleRgba(detailed, width, height, 16));
  else {
    data = Buffer.alloc(core.width * core.height * 4);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
  }
  if (drawn.opaqueOverview)
    applyOpaqueOverview(data, core, region, drawn.opaqueOverview);
  if (drawn.directTerrainOverview) {
    const { safe, pixels } = drawn.directTerrainOverview;
    assert.equal(safe.length, core.width * core.height);
    assert.equal(pixels.length, data.length);
    for (let i = 0; i < safe.length; i++)
      if (safe[i]) data.set(pixels.subarray(i * 4, i * 4 + 4), i * 4);
  }
  return data;
}

async function draw(assetDir, region, core, options = {}) {
  const omissions = [],
    renderer = createWorldRenderer({
      assetDir,
      lowMemory: true,
      nativeOverview: true,
      onOmission: (...value) => omissions.push(value),
      ...options,
    }),
    canvas = createCanvas(1, 1),
    getContext = canvas.getContext.bind(canvas);
  let contextCalls = 0;
  canvas.getContext = (...args) => {
    contextCalls++;
    return getContext(...args);
  };
  try {
    const drawn = await renderer.drawRegion(region, canvas, {
      core,
      count: true,
      overview: true,
      coreSurface: true,
    });
    const pixels = reducedPixels(drawn, canvas, core, region);
    return {
      pixels,
      drawn,
      stats: structuredClone(renderer.stats),
      omissions: omissions.sort(
        (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2],
      ),
      canvasSize: [canvas.width, canvas.height],
      contextCalls,
    };
  } finally {
    renderer.dispose();
    canvas.width = canvas.height = 1;
  }
}

function equivalent(actual, expected) {
  assert.deepEqual(actual.pixels, expected.pixels);
  assert.deepEqual(actual.drawn.plan, expected.drawn.plan);
  assert.equal(actual.drawn.coreCommands, expected.drawn.coreCommands);
  assert.deepEqual(actual.omissions, expected.omissions);
  for (const name of logicalCounters)
    assert.deepEqual(actual.stats[name], expected.stats[name], name);
}

test(
  "direct terrain bypasses all general frame work while preserving complete logical counts",
  {
    skip: !nativeAvailable,
  },
  async (t) => {
    const assetDir = assetFixture(t),
      region = terrainRegion(12, 10),
      core = { x: 102, y: 202, width: 8, height: 6 },
      baseline = await draw(assetDir, region, core),
      actual = await draw(assetDir, region, core, {
        directTerrainOverview: true,
      });
    equivalent(actual, baseline);
    assert.equal(baseline.drawn.directTerrainOverview, null);
    assert.equal(baseline.stats.directTerrainOverviewStats, null);
    assert.ok(actual.drawn.directTerrainOverview.handledCount > 0);
    assert.ok(
      actual.drawn.directTerrainOverview.safe.every((value) => value === 1),
    );
    assert.equal(actual.drawn.softwareOverview, null);
    assert.equal(actual.drawn.opaqueOverview, null);
    assert.equal(actual.drawn.rasterizedCommands, 0);
    assert.equal(actual.stats.frameKeyInterner.calls, 0);
    assert.equal(actual.stats.maxPreparedBytes, 0);
    assert.equal(actual.stats.nativeOverview.nativeCommands, 0);
    assert.deepEqual(actual.canvasSize, [1, 1]);
    assert.equal(actual.contextCalls, 0);
    assert.ok(actual.stats.directTerrainOverviewStats.handledCommands > 0);
    assert.ok(actual.stats.stageMilliseconds.directTerrain > 0);
  },
);

test(
  "direct terrain retains exact mixed slopes, liquid, torch overhangs and shared wall boundaries",
  {
    skip: !nativeAvailable,
  },
  async (t) => {
    const assetDir = assetFixture(t),
      region = terrainRegion(),
      core = { x: 103, y: 203, width: 18, height: 14 };
    for (let shape = 1; shape <= 5; shape++)
      put(region, 5 + shape, 6, { shape });
    // This external owner's 20px torch enters the core by two pixels.
    put(region, 2, 7, { type: 4, frameX: 0, frameY: 0 });
    put(region, 12, 8, { paint: 26, wallPaint: 2 });
    for (let x = 5; x <= 7; x++)
      for (let y = 10; y <= 12; y++)
        put(region, x, y, { active: false, liquid: 255, liquidKind: 1 });
    const before = structuredClone(region),
      baseline = await draw(assetDir, region, core),
      actual = await draw(assetDir, region, core, {
        directTerrainOverview: true,
      });
    equivalent(actual, baseline);
    assert.deepEqual(region, before);
    const direct = actual.drawn.directTerrainOverview;
    assert.ok(direct.handledCount > 0);
    assert.ok(direct.safe.includes(0));
    assert.ok(direct.safe.includes(1));
    assert.ok(
      actual.drawn.plan.commands.some(
        (c, i) => c.kind === "wall" && !direct.handled[i],
      ),
    );
    assert.ok(actual.stats.frameKeyInterner.calls > 0);
    assert.ok(
      actual.stats.frameKeyInterner.calls <
        baseline.stats.frameKeyInterner.calls,
    );
  },
);

test(
  "direct terrain leaves missing, corrupt, invalid and unsupported sources on the original diagnostic path",
  {
    skip: !nativeAvailable,
  },
  async (t) => {
    const assetDir = assetFixture(t),
      region = terrainRegion(),
      core = { x: 103, y: 203, width: 18, height: 14 };
    const corrupt = PNG.sync.write(new PNG({ width: 16, height: 16 })),
      idat = corrupt.indexOf(Buffer.from("IDAT"));
    assert.ok(idat > 0);
    corrupt[idat + 4] ^= 1;
    writeFileSync(join(assetDir, "Tiles_0.png"), corrupt);
    writeFileSync(
      join(assetDir, "Tiles_59.png"),
      PNG.sync.write(new PNG({ width: 1, height: 1 })),
    );
    put(region, 5, 5, { type: 0 });
    put(region, 7, 5, { type: 2 });
    put(region, 9, 5, { type: 59 });
    put(region, 11, 5, { paint: 33 });
    put(region, 13, 5, { type: 999, frameX: 0, frameY: 0 });
    put(region, 15, 5, { type: 373, frameX: 0, frameY: 0 });
    put(region, 17, 5, { active: false, liquid: 128, liquidKind: 99 });
    const baseline = await draw(assetDir, region, core),
      actual = await draw(assetDir, region, core, {
        directTerrainOverview: true,
      });
    equivalent(actual, baseline);
    assert.ok(actual.stats.assetFailures["Tiles_0.png"]);
    assert.equal(actual.stats.missingCommands["Tiles_0.png"], 1);
    assert.equal(actual.stats.missingCommands["Tiles_2.png"], 1);
    assert.equal(actual.stats.invalidCommands["Tiles_59.png"], 1);
    assert.equal(actual.stats.effectFailures["unknown-paint-id"], 1);
    assert.ok(actual.drawn.directTerrainOverview.handledCount > 0);
    assert.ok(actual.stats.plannedCommands > actual.stats.renderedCommands);
  },
);

test(
  "recording retains the original native batch stream even when direct terrain is requested",
  {
    skip: !nativeAvailable,
  },
  async (t) => {
    const assetDir = assetFixture(t),
      region = terrainRegion(12, 10),
      core = { x: 102, y: 202, width: 8, height: 6 };
    let batches = 0;
    const actual = await draw(assetDir, region, core, {
      directTerrainOverview: true,
      onNativeBatch: () => batches++,
    });
    assert.equal(actual.drawn.directTerrainOverview, null);
    assert.equal(actual.stats.directTerrainOverviewStats, null);
    assert.ok(batches > 0);
    assert.ok(actual.stats.frameKeyInterner.calls > 0);
  },
);
