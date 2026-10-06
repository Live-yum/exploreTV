import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const OVERVIEW_BASELINE_COMMIT =
  "18f8a8d65cd2af5f3b823ebaf1fcd41a718559a8";
const WORLD_SHA =
  "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab";
const PIXEL_SHA =
  "7564e85d94724f452cd76c03409fea512fb57966fb933303a6db832d4b86013e";

export function compareOverviewBenchmarks(
  baseline,
  candidate,
  candidateCommit,
) {
  assert.match(candidateCommit, /^[0-9a-f]{40}$/);
  for (const [name, run] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ]) {
    assert.equal(
      run.timing.targetPassed,
      true,
      `${name} must pass complete-process budgets`,
    );
    assert.equal(run.timing.lifetime.exitCode, 0);
    assert.ok(
      run.timing.endToEndSeconds > 0 && run.timing.endToEndSeconds < 600,
    );
    assert.ok(
      run.timing.conservativeAggregatePeakRssBytes > 0 &&
        run.timing.conservativeAggregatePeakRssBytes <= 500000000,
    );
    assert.equal(run.render.worldSha256, WORLD_SHA);
    assert.equal(run.render.fullWorld, true);
    assert.equal(run.render.processedCells, 20160000);
    assert.equal(run.timing.exporterSeconds, run.render.runtimeSeconds);
    assert.deepEqual(run.timing.environment, run.render.environment);
    assert.equal(run.fidelity.status, "passed");
    assert.equal(run.fidelity.png.sha256, run.render.png.sha256);
    assert.match(run.render.png.sha256, /^[0-9a-f]{64}$/);
    for (const key of [
      "assetFailures",
      "missingCommands",
      "invalidCommands",
      "effectFailures",
      "liquidUnsupported",
      "unsupportedTiles",
    ])
      assert.deepEqual(run.render[key], {}, `${name} has ${key}`);
    assert.equal(run.fidelity.wholeImagePixelSha256, PIXEL_SHA);
    assert.equal(run.fidelity.patches.length, 13);
    assert.equal(
      new Set(run.fidelity.patches.map((patch) => patch.name)).size,
      13,
    );
    for (const patch of run.fidelity.patches) {
      assert.equal(patch.differentBytes, 0);
      assert.ok(patch.comparedPixels > 0);
    }
    assert.equal(Object.keys(run.render.assetHashes).length, 384);
  }
  assert.deepEqual(candidate.render.assetHashes, baseline.render.assetHashes);
  assert.deepEqual(
    candidate.render.commandCounts,
    baseline.render.commandCounts,
  );
  for (const key of [
    "node",
    "platform",
    "arch",
    "release",
    "cpuModel",
    "logicalCpus",
    "availableParallelism",
  ])
    assert.equal(
      candidate.timing.environment[key],
      baseline.timing.environment[key],
      `Same-run environment ${key}`,
    );
  const baselineSeconds = baseline.timing.endToEndSeconds;
  const candidateSeconds = candidate.timing.endToEndSeconds;
  const baselineBytes = baseline.timing.conservativeAggregatePeakRssBytes;
  const candidateBytes = candidate.timing.conservativeAggregatePeakRssBytes;
  return {
    schema: "exploretv-overview-sequential-comparison-v1",
    baselineCommit: OVERVIEW_BASELINE_COMMIT,
    candidateCommit,
    method:
      "CI runs the pinned baseline then candidate sequentially on the same runner, with the identical lockfile and installed dependencies. Both use fresh processes and complete-lifetime RSS monitors. OS file-cache state is uncontrolled.",
    worldSha256: WORLD_SHA,
    wholeImagePixelSha256: PIXEL_SHA,
    pixels: 20160000,
    sourceTextures: 384,
    independentRegionsPerRun: 13,
    baseline: {
      endToEndSeconds: baselineSeconds,
      conservativeAggregatePeakRssBytes: baselineBytes,
    },
    candidate: {
      endToEndSeconds: candidateSeconds,
      conservativeAggregatePeakRssBytes: candidateBytes,
    },
    savedSeconds: +(baselineSeconds - candidateSeconds).toFixed(3),
    runtimeReductionPercent: +(
      (1 - candidateSeconds / baselineSeconds) *
      100
    ).toFixed(2),
    savedPeakBytes: baselineBytes - candidateBytes,
    memoryReductionPercent: +(
      (1 - candidateBytes / baselineBytes) *
      100
    ).toFixed(2),
    preferredRssBytes: 300000000,
    preferredMemoryPassed: candidateBytes < 300000000,
    environment: candidate.timing.environment,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [baselineDir, candidateDir, candidateCommit] = process.argv.slice(2);
  if (!baselineDir || !candidateDir || !candidateCommit)
    throw new Error(
      "Usage: node compare-overview-benchmarks.mjs baseline-dir candidate-dir candidate-commit",
    );
  const load = (dir) => {
    const read = (name) => JSON.parse(readFileSync(join(dir, name)));
    return {
      timing: read("cold-benchmark.json"),
      render: read("world-1px.png.json"),
      fidelity: read("world-1px.png.fidelity.json"),
    };
  };
  const comparison = compareOverviewBenchmarks(
    load(baselineDir),
    load(candidateDir),
    candidateCommit,
  );
  writeFileSync(
    join(candidateDir, "sequential-comparison.json"),
    JSON.stringify(comparison, null, 2),
    { flag: "wx" },
  );
  console.log(JSON.stringify(comparison));
}
