import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { createCanvas } from "@napi-rs/canvas";
import { materializeOverviewCommand } from "../core/overview-command-buffer.mjs";
import { createWorldRenderer } from "../scripts/world-render-engine.mjs";
import { buildOverviewFramePack } from "../scripts/build-overview-frame-pack.mjs";
import { nativeBlitterStatus } from "../scripts/native-blitter.mjs";
import { nativeReducerStatus } from "../scripts/native-reducer.mjs";
import { boxDownsampleRgba } from "../scripts/downsample-rgba.mjs";
import { applyOpaqueOverview } from "../scripts/overview-fast-path.mjs";

const nativeOptions = {
  skip: !nativeBlitterStatus.available || !nativeReducerStatus.available,
};
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

function assets(t) {
  const root = new URL("../artifacts/", import.meta.url);
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(new URL("compact-engine-", root));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  for (const [name, width, height, seed] of [
    ["Tiles_1.png", 288, 270, 7],
    ["Wall_1.png", 468, 180, 17],
    ["water_0.png", 48, 1360, 31],
    ["Liquid_0.png", 16, 16, 43],
    ["Tiles_4.png", 88, 500, 47],
  ]) {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        png.data.set(
          [
            (x * 7 + seed) & 255,
            (y * 5 + seed) & 255,
            (x + y + seed) & 255,
            [0, 1, 127, 254, 255][(x + y) % 5],
          ],
          (y * width + x) * 4,
        );
    writeFileSync(join(path, name), PNG.sync.write(png));
  }
  return path;
}

function scene(width = 24, height = 20) {
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
  Object.assign(region.cells[x * region.rect.height + y], extra);
}

function publicPlan(plan) {
  const { compactTerrain, commandStream, planningMilliseconds, ...rest } = plan;
  const commands = commandStream
    ? Array.from(commandStream.tokens, (token) =>
        token < 0 ? token : commandStream.objects[token],
      )
    : plan.commands;
  return {
    ...rest,
    commands: commands.map((command) =>
      materializeOverviewCommand(plan, command),
    ),
  };
}

// Independently combine detailed generic/canvas cells and the direct result,
// then compare every returned RGBA byte. Read borrowed views before the next draw.
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
            const offset = ((y * 16 + row) * width + x * 16) * 4;
            detailed.set(fallback.subarray(offset, offset + 64), offset);
          }
        }
    }
  } else if (drawn.rasterizedCommands)
    detailed = canvas
      .getContext("2d")
      .getImageData(drawn.readbackX, drawn.readbackY, width, height).data;
  const pixels = detailed
    ? Buffer.from(boxDownsampleRgba(detailed, width, height, 16))
    : Buffer.alloc(core.width * core.height * 4);
  if (!detailed) for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  if (drawn.opaqueOverview)
    applyOpaqueOverview(pixels, core, region, drawn.opaqueOverview);
  if (drawn.directTerrainOverview) {
    const { safe, pixels: direct } = drawn.directTerrainOverview;
    for (let i = 0; i < safe.length; i++)
      if (safe[i]) pixels.set(direct.subarray(i * 4, i * 4 + 4), i * 4);
  }
  return pixels;
}

async function draw(assetDir, region, core, options = {}, drawOptions = {}) {
  const omissions = [],
    renderer = createWorldRenderer({
      assetDir,
      lowMemory: true,
      nativeOverview: true,
      directTerrainOverview: true,
      onOmission: (...values) => omissions.push(values),
      ...options,
    });
  const canvas = createCanvas(1, 1);
  try {
    const drawn = await renderer.drawRegion(region, canvas, {
      core,
      count: true,
      overview: true,
      coreSurface: true,
      ...drawOptions,
    });
    return {
      pixels: output(drawn, canvas, core, region),
      plan: publicPlan(drawn.plan),
      compact: !!drawn.plan.compactTerrain,
      compactCommands: drawn.plan.compactTerrain
        ? drawn.plan.compactTerrain.records.length /
          drawn.plan.compactTerrain.stride
        : 0,
      compactAllocatedBytes:
        drawn.plan.compactTerrain?.records.buffer.byteLength ?? 0,
      stats: structuredClone(renderer.stats),
      coreCommands: drawn.coreCommands,
      omissions: omissions.sort(
        (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2],
      ),
    };
  } finally {
    renderer.dispose();
    canvas.width = canvas.height = 1;
  }
}

function equivalent(actual, expected) {
  assert.deepEqual(actual.pixels, expected.pixels);
  assert.deepEqual(actual.plan, expected.plan);
  assert.equal(actual.coreCommands, expected.coreCommands);
  assert.deepEqual(actual.omissions, expected.omissions);
  for (const key of logicalCounters)
    assert.deepEqual(actual.stats[key], expected.stats[key], key);
}

test(
  "compact terrain and real WASM preserve complete pixels, owners and source identities",
  nativeOptions,
  async (t) => {
    const assetDir = assets(t),
      region = scene(12, 10),
      core = { x: 102, y: 202, width: 8, height: 6 },
      before = structuredClone(region),
      expected = await draw(assetDir, region, core),
      actual = await draw(assetDir, region, core, {
        compactTerrainOverview: true,
      });
    equivalent(actual, expected);
    assert.deepEqual(region, before);
    assert.equal(
      expected.compact,
      false,
      "Public renderer default retains object plans",
    );
    assert.equal(expected.stats.terrainWasm, null);
    assert.equal(
      actual.stats.terrainWasm.available,
      true,
      actual.stats.terrainWasm.reason,
    );
    assert.equal(actual.stats.terrainWasm.regions, 1);
    assert.ok(actual.compactCommands > 0);
    assert.ok(
      actual.stats.directTerrainOverviewStats.compactValidationReuses > 0,
    );
    assert.equal(actual.stats.materializedTerrainCommands, 0);
    assert.ok(actual.stats.commandStreamCommands > 0);
    assert.equal(actual.stats.specialCommandObjects, 0);
    assert.equal(
      actual.stats.peakCompactTerrainBytes,
      actual.compactAllocatedBytes,
    );
  },
);

test(
  "mixed slopes, paint, liquid and overhanging sprites retain fallback order and pixels",
  nativeOptions,
  async (t) => {
    const assetDir = assets(t),
      region = scene(),
      core = { x: 103, y: 203, width: 18, height: 14 };
    for (let shape = 1; shape <= 5; shape++)
      put(region, 5 + shape, 6, { shape });
    put(region, 2, 7, { type: 4, frameX: 0, frameY: 0 });
    put(region, 12, 8, { paint: 26, wallPaint: 2 });
    put(region, 13, 11, { shape: 1, wall: 0, liquid: 127, liquidKind: 1 });
    put(region, 13, 10, { active: false, wall: 0, liquid: 200, liquidKind: 1 });
    put(region, 12, 11, { active: false, wall: 0, liquid: 120, liquidKind: 1 });
    const expected = await draw(assetDir, region, core),
      actual = await draw(assetDir, region, core, {
        compactTerrainOverview: true,
      });
    equivalent(actual, expected);
    assert.ok(actual.stats.materializedTerrainCommands > 0);
    assert.ok(actual.stats.directTerrainOverviewStats.handledCommands > 0);
    assert.ok(actual.stats.renderedCommands > 0);
  },
);

test(
  "compact fallback retains missing, corrupt, invalid and unsupported diagnostics",
  nativeOptions,
  async (t) => {
    const assetDir = assets(t),
      region = scene(),
      core = { x: 103, y: 203, width: 18, height: 14 };
    const corrupt = PNG.sync.write(new PNG({ width: 16, height: 16 }));
    const idat = corrupt.indexOf(Buffer.from("IDAT"));
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
    put(region, 15, 5, { type: undefined });
    put(region, 17, 5, { active: false, liquid: 128, liquidKind: 99 });
    const expected = await draw(assetDir, region, core),
      actual = await draw(assetDir, region, core, {
        compactTerrainOverview: true,
      });
    equivalent(actual, expected);
    assert.equal(actual.stats.terrainWasm.fallbackRegions, 1);
    assert.equal(actual.stats.terrainWasm.regions, 0);
    assert.equal(actual.stats.missingCommands["Tiles_0.png"], 1);
    assert.equal(actual.stats.missingCommands["Tiles_2.png"], 1);
    assert.equal(actual.stats.invalidCommands["Tiles_59.png"], 1);
    assert.equal(actual.stats.effectFailures["unknown-paint-id"], 1);
    assert.ok(actual.stats.materializedTerrainCommands >= 4);
  },
);

test(
  "WASM disable, incompatible modes and ordinary detail calls keep their intended planner",
  nativeOptions,
  async (t) => {
    const assetDir = assets(t),
      region = scene(12, 10),
      core = { x: 102, y: 202, width: 8, height: 6 },
      expected = await draw(assetDir, region, core);
    const previous = process.env.EXPLORETV_DISABLE_TERRAIN_WASM;
    try {
      process.env.EXPLORETV_DISABLE_TERRAIN_WASM = "1";
      const actual = await draw(assetDir, region, core, {
        compactTerrainOverview: true,
      });
      equivalent(actual, expected);
      assert.equal(actual.compact, true);
      assert.equal(actual.stats.terrainWasm, null);
    } finally {
      if (previous === undefined)
        delete process.env.EXPLORETV_DISABLE_TERRAIN_WASM;
      else process.env.EXPLORETV_DISABLE_TERRAIN_WASM = previous;
    }
    for (const options of [
      { directTerrainOverview: false },
      { nativeOverview: false },
      { lowMemory: false },
      { inputEncoding: "standard-straight" },
    ]) {
      const actual = await draw(assetDir, region, core, {
        compactTerrainOverview: true,
        ...options,
      });
      assert.equal(actual.compact, false);
      assert.equal(actual.stats.compactTerrainPlanning, false);
      assert.equal(actual.stats.terrainWasm, null);
      assert.equal(actual.compactCommands, 0);
    }
    const detailed = await draw(
      assetDir,
      region,
      core,
      { compactTerrainOverview: true },
      { overview: false },
    );
    assert.equal(detailed.compact, false);
    assert.equal(detailed.stats.terrainWasm.regions, 0);
  },
);

test(
  "recording a compact-requested renderer preserves the full original native batch stream",
  nativeOptions,
  async (t) => {
    const assetDir = assets(t),
      region = scene(12, 10),
      core = { x: 102, y: 202, width: 8, height: 6 },
      expectedBatches = [],
      actualBatches = [];
    const record =
      (into) =>
      ({ descriptors, sources, width, height }) =>
        into.push({
          width,
          height,
          descriptors: Array.from(descriptors),
          sources: sources.map((source) => Buffer.from(source)),
        });
    const expected = await draw(assetDir, region, core, {
        onNativeBatch: record(expectedBatches),
      }),
      actual = await draw(assetDir, region, core, {
        compactTerrainOverview: true,
        onNativeBatch: record(actualBatches),
      });
    equivalent(actual, expected);
    assert.equal(actual.compact, false);
    assert.equal(actual.stats.terrainWasm, null);
    assert.ok(actualBatches.length > 0);
    assert.deepEqual(actualBatches, expectedBatches);
  },
);

test(
  "a failed compact draw releases pixels and permits a later render with the same WASM instance",
  nativeOptions,
  async (t) => {
    const assetDir = assets(t),
      region = scene(12, 10),
      core = { x: 102, y: 202, width: 8, height: 6 },
      failure = new Error("Injected omission failure"),
      renderer = createWorldRenderer({
        assetDir,
        lowMemory: true,
        nativeOverview: true,
        directTerrainOverview: true,
        compactTerrainOverview: true,
        onOmission(_x, _y, reason) {
          if (reason === 4) throw failure;
        },
      }),
      canvas = createCanvas(1, 1),
      options = { core, overview: true, count: true, coreSurface: true };
    try {
      put(region, 5, 5, { type: 0 });
      await assert.rejects(
        renderer.drawRegion(region, canvas, options),
        (error) => error === failure,
      );
      assert.equal(renderer.stats.sharedDetailedRgba.activeBytes, 0);
      put(region, 5, 5, { type: 1 });
      const drawn = await renderer.drawRegion(region, canvas, options),
        expected = await draw(assetDir, region, core);
      assert.deepEqual(output(drawn, canvas, core, region), expected.pixels);
      assert.equal(renderer.stats.terrainWasm.regions, 2);
    } finally {
      renderer.dispose();
      canvas.width = canvas.height = 1;
    }
  },
);

test(
  "disabling only the WASM frame stream preserves neighbourhood WASM and the legacy compact writer",
  nativeOptions,
  async (t) => {
    const assetDir = assets(t),
      region = scene(12, 10),
      core = { x: 102, y: 202, width: 8, height: 6 };
    const expected = await draw(assetDir, region, core, {
      compactTerrainOverview: true,
    });
    const previous = process.env.EXPLORETV_DISABLE_WASM_FRAME_STREAM;
    try {
      process.env.EXPLORETV_DISABLE_WASM_FRAME_STREAM = "1";
      const actual = await draw(assetDir, region, core, {
        compactTerrainOverview: true,
      });
      equivalent(actual, expected);
      assert.equal(actual.stats.terrainWasm.regions, 1);
      assert.equal(actual.stats.wasmFrameStreamEnabled, false);
      assert.equal(actual.stats.commandStreamCommands, 0);
      assert.ok(actual.compactCommands > 0);
    } finally {
      if (previous === undefined)
        delete process.env.EXPLORETV_DISABLE_WASM_FRAME_STREAM;
      else process.env.EXPLORETV_DISABLE_WASM_FRAME_STREAM = previous;
    }
  },
);

test(
  "absent default packs fall back, explicit bad paths fail, and the pack-disable control is independent",
  nativeOptions,
  async (t) => {
    const assetDir = assets(t),
      region = scene(12, 10),
      core = { x: 102, y: 202, width: 8, height: 6 };
    const options = {
      assetDir,
      lowMemory: true,
      nativeOverview: true,
      directTerrainOverview: true,
      compactTerrainOverview: true,
    };
    assert.throws(() =>
      createWorldRenderer({
        ...options,
        framePackDir: join(assetDir, "missing-explicit-pack"),
      }),
    );
    const actual = await draw(assetDir, region, core, {
      compactTerrainOverview: true,
    });
    assert.equal(actual.stats.framePack.available, false);
    assert.match(actual.stats.framePack.reason, /not found/);
    assert.ok(actual.stats.commandStreamCommands > 0);
    const previous = process.env.EXPLORETV_DISABLE_FRAME_PACK;
    try {
      process.env.EXPLORETV_DISABLE_FRAME_PACK = "1";
      const disabled = await draw(assetDir, region, core, {
        compactTerrainOverview: true,
        framePackDir: join(assetDir, "missing-explicit-pack"),
      });
      equivalent(disabled, actual);
      assert.equal(disabled.stats.framePack.available, false);
      assert.ok(disabled.stats.commandStreamCommands > 0);
    } finally {
      if (previous === undefined)
        delete process.env.EXPLORETV_DISABLE_FRAME_PACK;
      else process.env.EXPLORETV_DISABLE_FRAME_PACK = previous;
    }
  },
);

test(
  "real precompiled pages, dynamic frames and the legacy compact writer preserve exact pixels and counters",
  nativeOptions,
  async (t) => {
    const assetDir = assets(t),
      framePackDir = join(assetDir, "overview-frame-pack");
    buildOverviewFramePack({
      assetDir,
      outputDir: framePackDir,
      pageBytes: 8192,
    });
    const region = scene(12, 10),
      core = { x: 102, y: 202, width: 8, height: 6 };
    for (let shape = 1; shape < 6; shape++)
      put(region, 3 + shape, 4, { shape });
    const options = { compactTerrainOverview: true };
    const dynamic = await draw(assetDir, region, core, {
      ...options,
      precompiledTerrainFrames: false,
    });
    const packed = await draw(assetDir, region, core, options);
    const legacy = await draw(assetDir, region, core, {
      ...options,
      wasmFrameStream: false,
    });
    equivalent(packed, dynamic);
    equivalent(legacy, dynamic);
    assert.equal(packed.stats.framePack.available, true);
    assert.ok(packed.stats.directTerrainOverviewStats.packFrameHits > 0);
    assert.equal(packed.stats.directTerrainOverviewStats.packFailures, 0);
    assert.equal(packed.stats.framePack.validationFailures, 0);
    assert.equal(
      packed.stats.rawTextureCache.rawDecodes,
      0,
      "covered assets do not inflate their source atlases",
    );
    assert.ok(dynamic.stats.rawTextureCache.rawDecodes > 0);
    assert.equal(legacy.stats.commandStreamCommands, 0);
    assert.ok(legacy.stats.directTerrainOverviewStats.packFrameHits > 0);
    assert.ok(packed.stats.commandStreamCommands > 0);
    assert.ok(
      packed.stats.directTerrainOverviewStats.peakLiveFrameBytes <=
        4 * 1024 * 1024,
    );
    assert.equal(packed.stats.sharedDetailedRgba.allocations, 1);
    // A changed source invalidates only its package binding. The complete
    // diagnostic/resource identity result must still equal dynamic rendering.
    const changed = new PNG({ width: 288, height: 270 });
    changed.data.fill(91);
    writeFileSync(join(assetDir, "Tiles_1.png"), PNG.sync.write(changed));
    const changedPacked = await draw(assetDir, region, core, options);
    const changedDynamic = await draw(assetDir, region, core, {
      ...options,
      precompiledTerrainFrames: false,
    });
    equivalent(changedPacked, changedDynamic);
    assert.ok(changedPacked.stats.framePack.validationFailures > 0);
    assert.equal(
      changedPacked.stats.directTerrainOverviewStats.packFailures,
      0,
    );
    assert.ok(changedPacked.stats.rawTextureCache.rawDecodes > 0);
  },
);
