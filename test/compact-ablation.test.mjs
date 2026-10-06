import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareCompactAblations } from "../scripts/compare-compact-ablations.mjs";

const commit = "a".repeat(40);
function fixture(seconds, bytes, wasm, mask) {
  const environment = {
    node: "v22",
    platform: "linux",
    arch: "x64",
    release: "test",
    cpuModel: "same CPU",
    logicalCpus: 4,
    availableParallelism: 4,
    nodeArguments: ["--max-old-space-size=48"],
    allocator: { requestedArenaMax: "2" },
  };
  const render = {
    worldSha256:
      "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab",
    fullWorld: true,
    processedCells: 20160000,
    runtimeSeconds: seconds - 0.1,
    environment,
    png: { sha256: "b".repeat(64) },
    assetHashes: Object.fromEntries(
      Array.from({ length: 384 }, (_, i) => [`texture-${i}`, `${i}`]),
    ),
    commandCounts: {
      tile: 11161090,
      wall: 5200671,
      liquid: 1179913,
      waterfall: 82467,
    },
    sourceHashes: { "core/renderer.mjs": "c".repeat(64) },
    compactTerrainPlanning: true,
    compactTerrainCommands: 100,
    nativeOverview: { binarySha256: "d".repeat(64) },
    terrainWasm: wasm
      ? {
          available: true,
          regions: 3300,
          fallbackRegions: 0,
          binarySha256: "e".repeat(64),
        }
      : null,
    plannerPhaseMilliseconds: {
      wasmPacking: wasm ? 1000 : 0,
      wasmPlanning: wasm ? 1200 : 0,
    },
    directTerrainOverviewStats: {
      available: true,
      binarySha256: "d".repeat(64),
      resolvedCellMask: mask,
      maskedBlitPixelsSkipped: mask ? 200 : 0,
      blitPixelsToResolvedCells: mask ? 180 : 0,
      nativeBlitPixels: mask ? 1000 : 1200,
    },
  };
  for (const key of [
    "assetFailures",
    "missingCommands",
    "invalidCommands",
    "effectFailures",
    "liquidUnsupported",
    "unsupportedTiles",
  ])
    render[key] = {};
  return {
    timing: {
      targetPassed: true,
      endToEndSeconds: seconds,
      exporterSeconds: render.runtimeSeconds,
      conservativeAggregatePeakRssBytes: bytes,
      lifetime: { exitCode: 0 },
      environment: structuredClone(environment),
    },
    render,
    fidelity: {
      status: "passed",
      png: { ...render.png },
      wholeImagePixelSha256:
        "7564e85d94724f452cd76c03409fea512fb57966fb933303a6db832d4b86013e",
      patches: Array.from({ length: 13 }, (_, i) => ({
        name: `patch-${i}`,
        comparedPixels: 100,
        differentBytes: 0,
      })),
    },
  };
}
function runs() {
  return {
    default: fixture(90, 270000000, true, true),
    compactJs: fixture(89.8, 268000000, false, true),
    compactUnmasked: fixture(94.2, 269000000, true, false),
  };
}

test("same-commit ablation reports both directions without claiming statistical significance", () => {
  const report = compareCompactAblations(runs(), commit);
  assert.equal(report.candidateCommit, commit);
  assert.equal(report.runs.compactJs.deltaFromDefaultSeconds, -0.2);
  assert.equal(report.runs.compactUnmasked.deltaFromDefaultSeconds, 4.2);
  assert.equal(report.runs.compactJs.deltaFromDefaultPeakBytes, -2000000);
  assert.deepEqual(report.runs.compactJs.mode, {
    compactPlanning: true,
    terrainWasm: false,
    resolvedCellMask: true,
  });
  assert.match(report.method, /One sequential sample/);
  assert.match(report.method, /not a statistically established improvement/);
  assert.ok(JSON.stringify(report).length < 32768);
});

test("each ablation independently reports strict runtime and memory targets", () => {
  const input = runs();
  input.default = fixture(59.999, 299999999, true, true);
  input.compactJs = fixture(60, 299999999, false, true);
  input.compactUnmasked = fixture(59.999, 300000000, true, false);
  const report = compareCompactAblations(input, commit);
  assert.equal(report.runs.default.preferredTargetsPassed, true);
  assert.equal(report.runs.compactJs.preferredRuntimePassed, false);
  assert.equal(report.runs.compactJs.preferredMemoryPassed, true);
  assert.equal(report.runs.compactUnmasked.preferredRuntimePassed, true);
  assert.equal(report.runs.compactUnmasked.preferredMemoryPassed, false);
  for (const name of ["compactJs", "compactUnmasked"])
    assert.equal(report.runs[name].preferredTargetsPassed, false);
});

test("ablation comparison rejects wrong modes, source or binary changes, omissions and incomplete fidelity", () => {
  for (const mutate of [
    (r) => {
      r.default.render.compactTerrainPlanning = false;
    },
    (r) => {
      r.default.render.terrainWasm.available = false;
    },
    (r) => {
      r.default.render.terrainWasm.fallbackRegions = 1;
    },
    (r) => {
      r.compactJs.render.terrainWasm = { available: false };
    },
    (r) => {
      r.compactJs.render.plannerPhaseMilliseconds.wasmPacking = 1;
    },
    (r) => {
      r.compactUnmasked.render.directTerrainOverviewStats.resolvedCellMask = true;
    },
    (r) => {
      r.compactUnmasked.render.directTerrainOverviewStats.maskedBlitPixelsSkipped = 1;
    },
    (r) => {
      r.compactJs.render.sourceHashes["core/renderer.mjs"] = "f".repeat(64);
    },
    (r) => {
      r.compactJs.render.directTerrainOverviewStats.binarySha256 = "f".repeat(
        64,
      );
    },
    (r) => {
      r.compactUnmasked.render.terrainWasm.binarySha256 = "f".repeat(64);
    },
    (r) => {
      r.compactJs.render.missingCommands = { missing: 1 };
    },
    (r) => {
      r.compactUnmasked.fidelity.patches.pop();
    },
    (r) => {
      r.compactJs.fidelity.wholeImagePixelSha256 = "f".repeat(64);
    },
    (r) => {
      r.compactUnmasked.timing.environment.node = "different";
    },
  ]) {
    const input = runs();
    mutate(input);
    assert.throws(() => compareCompactAblations(input, commit));
  }
  assert.throws(() => compareCompactAblations(runs(), "unverified"));
  assert.throws(() =>
    compareCompactAblations(runs(), commit, { checkout: process.cwd() }),
  );
});

test("Actions runs the two exact-head ablations sequentially and retains JSON without extra PNG uploads", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/export-overview.yml", import.meta.url),
    "utf8",
  );
  const primary = workflow.indexOf("- name: Compare complete sequential runs"),
    js = workflow.indexOf(
      "- name: Measure the same compact candidate with terrain WASM disabled",
    ),
    unmasked = workflow.indexOf(
      "- name: Measure the same compact candidate with the resolved-cell mask disabled",
    ),
    comparison = workflow.indexOf(
      "- name: Compare complete same-commit feature ablations",
    );
  assert.ok(
    primary > 0 && js > primary && unmasked > js && comparison > unmasked,
  );
  assert.ok(workflow.includes('EXPLORETV_DISABLE_TERRAIN_WASM: "1"'));
  assert.ok(workflow.includes('EXPLORETV_DISABLE_RESOLVED_CELL_MASK: "1"'));
  for (const mode of ["compact-js", "compact-unmasked"]) {
    assert.ok(
      workflow.includes(`node scripts/run-overview-ci.mjs artifacts/${mode}`),
    );
    assert.ok(
      workflow.includes(
        `example/assets artifacts/${mode}/world-1px.png --example`,
      ),
    );
    assert.ok(workflow.includes(`artifacts/${mode}/*.json`));
    assert.equal(
      workflow.includes(`            artifacts/${mode}/world-1px.png\n`),
      false,
    );
  }
  assert.ok(workflow.includes('"$(git rev-parse HEAD)" "$GITHUB_WORKSPACE"'));
});
