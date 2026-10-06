import test from "node:test";
import assert from "node:assert/strict";
import { compareFramePackBenchmarks } from "../scripts/compare-frame-pack-benchmarks.mjs";
import { OVERVIEW_FRAME_PACK_RULE_PATHS } from "../scripts/overview-frame-pack-format.mjs";

const hash = (letter) => letter.repeat(64);
const commit = "a".repeat(40);
function fixture(seconds, { pack, stream, peak = 280000000 }) {
  const environment = {
    node: "v22.23.3",
    platform: "linux",
    arch: "x64",
    release: "same-kernel",
    cpuModel: "same-CPU",
    logicalCpus: 4,
    availableParallelism: 4,
    nodeArguments: [
      "--max-old-space-size=48",
      "--max-semi-space-size=1",
      "--expose-gc",
    ],
    allocator: { requestedArenaMax: "2", requestedMmapThreshold: "131072" },
  };
  const assetHashes = Object.fromEntries(
    Array.from({ length: 384 }, (_, i) => [`texture-${i}.png`, hash("c")]),
  );
  const sourceHashes = {
    "scripts/export-overview.mjs": hash("a"),
    "scripts/world-render-engine.mjs": hash("b"),
    "core/renderer.mjs": hash("c"),
    "core/overview-frame-recipes.mjs": hash("d"),
    ...Object.fromEntries(
      OVERVIEW_FRAME_PACK_RULE_PATHS.map((path) => [path, hash("d")]),
    ),
  };
  const framePack = pack
    ? {
        available: true,
        manifestSha256: hash("e"),
        indexSha256: hash("f"),
        pagesSha256: [hash("1"), hash("2")],
        frames: 20,
        uniqueFrames: 18,
        pageCount: 2,
        logicalPixelBytes: 22000,
        pixelBytes: 20000,
        onDiskBytes: 25000,
        indexBytes: 640,
        validationFailures: 0,
        sourceVerifications: 1,
        ruleHashes: Object.fromEntries(
          OVERVIEW_FRAME_PACK_RULE_PATHS.map((path) => [path, hash("d")]),
        ),
        sourceHashes: { "texture-0.png": hash("c") },
      }
    : { available: false, reason: "disabled" };
  const png = { sha256: hash("3") };
  const render = {
    environment: structuredClone(environment),
    runtimeSeconds: seconds - 0.1,
    worldSha256:
      "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab",
    fullWorld: true,
    processedCells: 20160000,
    assetHashes,
    sourceHashes,
    png,
    compactTerrainPlanning: true,
    compactTerrainCommands: 100,
    wasmFrameStreamEnabled: stream,
    commandStreamCommands: stream ? 110 : 0,
    specialCommandObjects: 10,
    peakCommandStreamBytes: stream ? 440 : 0,
    terrainWasm: {
      available: true,
      regions: 10,
      streamRegions: stream ? 10 : 0,
      fallbackRegions: 0,
      binarySha256: hash("4"),
    },
    nativeOverview: { binarySha256: hash("5") },
    framePack,
    directTerrainOverviewStats: {
      available: true,
      binarySha256: hash("5"),
      resolvedCellMask: false,
      commandStreamCommands: stream ? 110 : 0,
      packFrameHits: pack ? 90 : 0,
      packFailures: 0,
      peakPackPageBytes: pack ? 25000 : 0,
      peakLiveFrameBytes: 50000,
      frameByteLimit: 4 * 1024 * 1024,
    },
    commandCounts: { tile: 80, wall: 20, liquid: 10 },
    assetFailures: {},
    missingCommands: {},
    invalidCommands: {},
    effectFailures: {},
    liquidUnsupported: {},
    unsupportedTiles: {},
  };
  return {
    timing: {
      targetPassed: true,
      endToEndSeconds: seconds,
      exporterSeconds: render.runtimeSeconds,
      conservativeAggregatePeakRssBytes: peak,
      lifetime: { exitCode: 0 },
      environment,
    },
    render,
    fidelity: {
      status: "passed",
      png: { ...png },
      wholeImagePixelSha256:
        "7564e85d94724f452cd76c03409fea512fb57966fb933303a6db832d4b86013e",
      patches: Array.from({ length: 13 }, (_, i) => ({
        name: `roi-${i}`,
        differentBytes: 0,
        comparedPixels: 256,
      })),
    },
  };
}
function runs() {
  return {
    default: fixture(100, { pack: true, stream: true }),
    dynamicFrames: fixture(105, { pack: false, stream: true }),
    legacyPlanning: fixture(110, { pack: true, stream: false }),
  };
}
function preparationFor(r) {
  const pack = r.default.render.framePack;
  return {
    manifestSha256: pack.manifestSha256,
    elapsedSeconds: 123,
    processElapsedSeconds: 123.5,
    osPeakRssBytes: 120000000,
    candidateSlots: pack.frames,
    ...Object.fromEntries(
      [
        "uniqueFrames",
        "pageCount",
        "logicalPixelBytes",
        "pixelBytes",
        "onDiskBytes",
        "indexBytes",
        "ruleHashes",
        "sourceHashes",
      ].map((key) => [key, pack[key]]),
    ),
  };
}

test("resource compilation is reported separately from complete new-world export and its goals", () => {
  const r = runs();
  const preparation = preparationFor(r);
  const result = compareFramePackBenchmarks(r, commit, { preparation });
  assert.equal(result.runs.default.endToEndSeconds, 100);
  assert.equal(result.resourcePreparation.elapsedSeconds, 123);
  assert.equal(result.runs.dynamicFrames.deltaFromDefaultSeconds, 5);
  assert.equal(result.runs.legacyPlanning.deltaFromDefaultSeconds, 10);
  assert.equal(result.runs.default.preferredRuntimePassed, false);
  assert.equal(result.runs.default.preferredMemoryPassed, true);
  assert.equal(result.runs.default.preferredTargetsPassed, false);
  assert.match(result.method, /page reads remain inside/);
});

test("the strict 300 MB target is not relaxed when an otherwise correct run crosses it", () => {
  const r = runs();
  r.default.timing.conservativeAggregatePeakRssBytes = 300000000;
  const result = compareFramePackBenchmarks(r, commit);
  assert.equal(result.runs.default.correctnessPassed, true);
  assert.equal(result.runs.default.preferredMemoryPassed, false);
});

test("ignored feature switches or zero executed stream work cannot pass an ablation", () => {
  for (const mutate of [
    (r) => {
      r.dynamicFrames.render.framePack = structuredClone(
        r.default.render.framePack,
      );
    },
    (r) => {
      r.legacyPlanning.render.wasmFrameStreamEnabled = true;
    },
    (r) => {
      r.default.render.commandStreamCommands = 0;
    },
    (r) => {
      r.default.render.terrainWasm.streamRegions = 0;
    },
    (r) => {
      r.default.render.directTerrainOverviewStats.commandStreamCommands = 0;
    },
    (r) => {
      r.dynamicFrames.render.terrainWasm.available = false;
    },
    (r) => {
      r.default.render.directTerrainOverviewStats.resolvedCellMask = true;
    },
  ]) {
    const r = runs();
    mutate(r);
    assert.throws(() => compareFramePackBenchmarks(r, commit));
  }
});

test("resource rule drift and different packed bytes are rejected even with matching output claims", () => {
  for (const mutate of [
    (r) => {
      r.default.render.framePack.ruleHashes["core/overview-frame-recipes.mjs"] =
        hash("1");
    },
    (r) => {
      r.legacyPlanning.render.framePack.pagesSha256[0] = hash("3");
    },
    (r) => {
      r.legacyPlanning.render.framePack.manifestSha256 = hash("4");
    },
    (r) => {
      r.default.render.framePack.sourceHashes["texture-0.png"] = hash("5");
    },
    (r) => {
      r.default.render.framePack.pagesSha256.pop();
    },
    (r) => {
      r.default.render.framePack.validationFailures = 1;
    },
    (r) => {
      r.default.render.framePack.ruleHashes["package-lock.json"] = hash("9");
    },
    (r) => {
      delete r.default.render.framePack.ruleHashes["scripts/native-blitter.c"];
    },
    (r) => {
      r.default.render.framePack.ruleHashes["../outside.mjs"] = hash("d");
    },
  ]) {
    const r = runs();
    mutate(r);
    assert.throws(() => compareFramePackBenchmarks(r, commit));
  }
});

test("page backing allocations and fallback pixels must fit the same live budget", () => {
  for (const name of ["peakPackPageBytes", "peakLiveFrameBytes"]) {
    const r = runs();
    r.default.render.directTerrainOverviewStats[name] = 4 * 1024 * 1024 + 1;
    assert.throws(
      () => compareFramePackBenchmarks(r, commit),
      /budget|bounded/,
    );
  }
  const r = runs();
  r.default.render.directTerrainOverviewStats.frameByteLimit = 8 * 1024 * 1024;
  assert.throws(
    () => compareFramePackBenchmarks(r, commit),
    /Unchanged live frame budget/,
  );
});

test("preparation metadata must describe the same sources and rules that the renderer consumed", () => {
  const r = runs();
  assert.throws(
    () =>
      compareFramePackBenchmarks(r, commit, {
        preparation: {
          ...preparationFor(r),
          sourceHashes: { "texture-0.png": hash("a") },
        },
      }),
    /Resource build/,
  );
});

test("resource preparation counters and memory are bound to the executed pack", () => {
  const r = runs();
  for (const [key, value] of Object.entries({
    candidateSlots: 19,
    uniqueFrames: 17,
    pageCount: 3,
    pixelBytes: 1,
    onDiskBytes: 1,
    indexBytes: 1,
    logicalPixelBytes: 1,
    osPeakRssBytes: -1,
    processElapsedSeconds: 122,
    manifestSha256: hash("a"),
  })) {
    const preparation = { ...preparationFor(r), [key]: value };
    assert.throws(() => compareFramePackBenchmarks(r, commit, { preparation }));
  }
});

test("per-mode source and binary substitutions cannot masquerade as an isolated feature measurement", () => {
  for (const mutate of [
    (r) => {
      r.dynamicFrames.render.sourceHashes["core/renderer.mjs"] = hash("f");
    },
    (r) => {
      r.legacyPlanning.render.terrainWasm.binarySha256 = hash("f");
    },
    (r) => {
      r.dynamicFrames.render.directTerrainOverviewStats.binarySha256 =
        hash("f");
    },
    (r) => {
      r.default.fidelity.patches[0].differentBytes = 1;
    },
  ]) {
    const r = runs();
    mutate(r);
    assert.throws(() => compareFramePackBenchmarks(r, commit));
  }
});
