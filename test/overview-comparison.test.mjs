import test from "node:test";
import assert from "node:assert/strict";
import {
  compareOverviewBenchmarks,
  OVERVIEW_BASELINE_COMMIT,
} from "../scripts/compare-overview-benchmarks.mjs";

function fixture(seconds = 300, bytes = 440000000) {
  const value = {
    timing: {
      targetPassed: true,
      endToEndSeconds: seconds,
      conservativeAggregatePeakRssBytes: bytes,
      lifetime: { exitCode: 0 },
      environment: {
        node: "v22",
        platform: "linux",
        arch: "x64",
        release: "test",
        cpuModel: "same CPU",
        logicalCpus: 4,
        availableParallelism: 4,
      },
    },
    render: {
      worldSha256:
        "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab",
      fullWorld: true,
      processedCells: 20160000,
      assetHashes: Object.fromEntries(
        Array.from({ length: 384 }, (_, i) => [`texture-${i}`, `${i}`]),
      ),
      commandCounts: {
        tile: 11161090,
        wall: 5200671,
        liquid: 1179913,
        waterfall: 82467,
      },
    },
    fidelity: {
      status: "passed",
      wholeImagePixelSha256:
        "7564e85d94724f452cd76c03409fea512fb57966fb933303a6db832d4b86013e",
      patches: Array.from({ length: 13 }, (_, i) => ({
        name: `patch-${i}`,
        comparedPixels: 100,
        differentBytes: 0,
      })),
    },
  };
  value.timing.exporterSeconds = seconds - 0.1;
  value.render.runtimeSeconds = value.timing.exporterSeconds;
  value.render.environment = structuredClone(value.timing.environment);
  value.render.png = { sha256: "b".repeat(64) };
  value.fidelity.png = { ...value.render.png };
  for (const key of [
    "assetFailures",
    "missingCommands",
    "invalidCommands",
    "effectFailures",
    "liquidUnsupported",
    "unsupportedTiles",
  ])
    value.render[key] = {};
  return value;
}
const commit = "a".repeat(40);
test("sequential overview comparison reports full-process improvements and strict preferred target", () => {
  const report = compareOverviewBenchmarks(
    fixture(),
    fixture(240, 280000000),
    commit,
  );
  assert.equal(report.baselineCommit, OVERVIEW_BASELINE_COMMIT);
  assert.equal(report.candidateCommit, commit);
  assert.equal(report.savedSeconds, 60);
  assert.equal(report.runtimeReductionPercent, 20);
  assert.equal(report.savedPeakBytes, 160000000);
  assert.equal(report.preferredMemoryPassed, true);
  assert.equal(report.preferredRuntimePassed, false);
  assert.equal(report.preferredTargetsPassed, false);
  assert.equal(
    compareOverviewBenchmarks(fixture(), fixture(310, 300000000), commit)
      .preferredMemoryPassed,
    false,
  );
  assert.ok(
    compareOverviewBenchmarks(fixture(), fixture(310), commit)
      .runtimeReductionPercent < 0,
  );
});
test("60-second and 300-MB goals are independent and both use strict boundaries", () => {
  for (const [seconds, bytes, runtime, memory, both] of [
    [59.999, 299999999, true, true, true],
    [60, 299999999, false, true, false],
    [59.999, 300000000, true, false, false],
    [60, 300000000, false, false, false],
    [121.266, 285085696, false, true, false],
  ]) {
    const report = compareOverviewBenchmarks(
      fixture(),
      fixture(seconds, bytes),
      commit,
    );
    assert.equal(report.preferredRuntimePassed, runtime);
    assert.equal(report.preferredMemoryPassed, memory);
    assert.equal(report.preferredTargetsPassed, both);
    assert.equal(report.correctnessPassed, true);
    assert.equal(report.protectiveBudgetsPassed, true);
  }
});
test("comparison rejects budget, fidelity, input and environment mismatches", () => {
  for (const mutate of [
    (r) => {
      r.fidelity.png.sha256 = "c".repeat(64);
    },
    (r) => {
      r.fidelity.patches[0].differentBytes = 1;
    },
    (r) => {
      r.fidelity.patches[0].comparedPixels = 0;
    },
    (r) => {
      r.fidelity.patches[0].name = r.fidelity.patches[1].name;
    },
    (r) => {
      r.render.missingCommands = { missing: 1 };
    },
    (r) => {
      r.render.runtimeSeconds = 1;
    },
    (r) => {
      r.render.environment.node = "different";
    },
    (r) => {
      r.timing.targetPassed = false;
    },
    (r) => {
      r.timing.lifetime.exitCode = 1;
    },
    (r) => {
      r.timing.endToEndSeconds = 600;
    },
    (r) => {
      r.timing.conservativeAggregatePeakRssBytes = 500000001;
    },
    (r) => {
      r.timing.environment.node = "other";
    },
    (r) => {
      r.render.fullWorld = false;
    },
    (r) => {
      r.render.worldSha256 = "other";
    },
    (r) => {
      r.render.processedCells--;
    },
    (r) => {
      r.render.assetHashes["texture-0"] = "changed";
    },
    (r) => {
      delete r.render.assetHashes["texture-0"];
    },
    (r) => {
      r.render.commandCounts.tile--;
    },
    (r) => {
      r.fidelity.status = "failed";
    },
    (r) => {
      r.fidelity.wholeImagePixelSha256 = "other";
    },
    (r) => {
      r.fidelity.patches.pop();
    },
  ]) {
    const candidate = fixture();
    mutate(candidate);
    assert.throws(() =>
      compareOverviewBenchmarks(fixture(), candidate, commit),
    );
  }
  assert.throws(() =>
    compareOverviewBenchmarks(fixture(), fixture(), "unverified"),
  );
});
