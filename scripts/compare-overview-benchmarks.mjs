import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const OVERVIEW_BASELINE_COMMIT =
  "fae6f52a5227cef3f6544f383d074f10da84e1e0";
const WORLD_SHA =
  "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab";
const PIXEL_SHA =
  "7564e85d94724f452cd76c03409fea512fb57966fb933303a6db832d4b86013e";

// The verifier checks files in each checkout. This second check binds the
// measured report to immutable Git objects, so a named commit alone cannot
// accidentally attribute a dirty or different implementation to that commit.
export function verifyOverviewSourceProvenance(render, checkout, commit) {
  assert.match(commit, /^[0-9a-f]{40}$/);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], {
      maxBuffer: 32 * 1024 * 1024,
    });
  assert.equal(git("rev-parse", "HEAD").toString().trim(), commit);
  const sourceHashes = render.sourceHashes;
  assert.ok(sourceHashes && typeof sourceHashes === "object");
  for (const required of [
    "scripts/export-overview.mjs",
    "scripts/world-render-engine.mjs",
    "core/renderer.mjs",
  ])
    assert.ok(sourceHashes[required], `Required source identity: ${required}`);
  for (const [name, hash] of Object.entries(sourceHashes)) {
    assert.match(name, /^[A-Za-z0-9._/-]+$/);
    assert.ok(
      !name.split("/").some((part) => ["", ".", ".."].includes(part)),
      "Source identity must name a repository file",
    );
    assert.match(hash, /^[0-9a-f]{64}$/);
    const actual = createHash("sha256")
      .update(git("show", `${commit}:${name}`))
      .digest("hex");
    assert.equal(actual, hash, `Exact-commit source identity: ${name}`);
  }
  return {
    commit,
    tree: git("rev-parse", `${commit}^{tree}`).toString().trim(),
    verifiedSourceFiles: Object.keys(sourceHashes).length,
    sourceHashes: { ...sourceHashes },
  };
}

export function summarizeOverviewPhases(render) {
  const direct = render.directTerrainOverviewStats ?? {};
  return {
    stageMilliseconds: { ...render.stageMilliseconds },
    plannerPhaseMilliseconds: { ...render.plannerPhaseMilliseconds },
    directPhaseMilliseconds: { ...direct.phaseMilliseconds },
    directCounters: Object.fromEntries(
      Object.entries(direct).filter(([, value]) => typeof value === "number"),
    ),
    framePack: render.framePack ? { ...render.framePack } : null,
    wasmFrameStream: {
      enabled: render.wasmFrameStreamEnabled === true,
      commands: render.commandStreamCommands ?? 0,
      specialObjects: render.specialCommandObjects ?? 0,
      peakCommandStreamBytes: render.peakCommandStreamBytes ?? 0,
    },
    regionDecodeSeconds: render.regionDecodeSeconds ?? null,
    garbageCollectionSeconds: render.garbageCollectionSeconds ?? null,
    readbackAndReductionSeconds: render.readbackAndReductionSeconds ?? null,
    compressionSeconds: render.compressionSeconds ?? null,
    timingRelationships:
      "These are raw, overlapping phase measurements, not an additive breakdown. " +
      "Planner total contains its ordinary phases; wasmPacking and wasmPlanning " +
      "belong to the outer plan stage and may lie outside planner total. " +
      "Direct scanAndBatch contains scan and batch; frame prepare, clear and " +
      "compose are nested within direct work. Compare each named metric separately.",
  };
}

export function compareOverviewBenchmarks(
  baseline,
  candidate,
  candidateCommit,
  baselineCommit = OVERVIEW_BASELINE_COMMIT,
) {
  assert.match(candidateCommit, /^[0-9a-f]{40}$/);
  assert.match(baselineCommit, /^[0-9a-f]{40}$/);
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
    baselineCommit,
    candidateCommit,
    method:
      "CI runs the pinned baseline then candidate sequentially on the same runner with identical installed rendering dependencies. Both prepare the existing native kernels before timing and use exporter startup MALLOC_ARENA_MAX=2 and MALLOC_MMAP_THRESHOLD_=131072. The candidate's world-independent frame pack is built from source textures in a separately measured preparation step; loading, source verification and page reads remain inside the timed exporter. Explicit caller values are preserved; corresponding glibc tunables take precedence. Its report records requested allocator and Node settings, not an assumed effective arena count. The baseline retains its original launch configuration. Both use fresh processes and complete-lifetime RSS monitors. No world is pre-rendered. OS file-cache state is uncontrolled.",
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
    preferredRuntimeSeconds: 60,
    preferredRuntimePassed: candidateSeconds < 60,
    preferredTargetsPassed: candidateSeconds < 60 && candidateBytes < 300000000,
    correctnessPassed: true,
    protectiveBudgetsPassed: true,
    acceptanceMeaning:
      "Correctness and the 600-second/500-MB protective budgets are required " +
      "to compare completed runs. The 60-second runtime and 300-MB conservative " +
      "total peak goals are reported independently and jointly; a successful " +
      "workflow does not by itself mean those preferred goals were met.",
    phases: {
      baseline: summarizeOverviewPhases(baseline.render),
      candidate: summarizeOverviewPhases(candidate.render),
    },
    environment: candidate.timing.environment,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [
    baselineDir,
    candidateDir,
    candidateCommit,
    baselineCommit = OVERVIEW_BASELINE_COMMIT,
    baselineCheckout,
    candidateCheckout,
    ...extra
  ] = process.argv.slice(2);
  if (
    !baselineDir ||
    !candidateDir ||
    !candidateCommit ||
    extra.length ||
    Boolean(baselineCheckout) !== Boolean(candidateCheckout)
  )
    throw new Error(
      "Usage: node compare-overview-benchmarks.mjs baseline-dir candidate-dir " +
        "candidate-commit [baseline-commit [baseline-checkout candidate-checkout]]",
    );
  const load = (dir) => {
    const read = (name) => JSON.parse(readFileSync(join(dir, name)));
    return {
      timing: read("cold-benchmark.json"),
      render: read("world-1px.png.json"),
      fidelity: read("world-1px.png.fidelity.json"),
    };
  };
  const baseline = load(baselineDir),
    candidate = load(candidateDir);
  const comparison = compareOverviewBenchmarks(
    baseline,
    candidate,
    candidateCommit,
    baselineCommit,
  );
  if (baselineCheckout) {
    comparison.provenance = {
      baseline: verifyOverviewSourceProvenance(
        baseline.render,
        baselineCheckout,
        baselineCommit,
      ),
      candidate: verifyOverviewSourceProvenance(
        candidate.render,
        candidateCheckout,
        candidateCommit,
      ),
    };
  }
  writeFileSync(
    join(candidateDir, "sequential-comparison.json"),
    JSON.stringify(comparison, null, 2),
    { flag: "wx" },
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const status = (passed) => (passed ? "passed" : "not met");
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "## Complete panorama comparison\n\n" +
        `Baseline: \`${baselineCommit}\`; candidate: \`${candidateCommit}\`. ` +
        "Sequential fresh processes on the same runner; operating-system file caches are uncontrolled.\n\n" +
        "| Measurement | Pinned main | Candidate |\n|---|---:|---:|\n" +
        `| Complete process time | ${comparison.baseline.endToEndSeconds.toFixed(3)} s | ${comparison.candidate.endToEndSeconds.toFixed(3)} s |\n` +
        `| Conservative total peak | ${(comparison.baseline.conservativeAggregatePeakRssBytes / 1e6).toFixed(2)} MB | ${(comparison.candidate.conservativeAggregatePeakRssBytes / 1e6).toFixed(2)} MB |\n\n` +
        `Candidate < 60 seconds: **${status(comparison.preferredRuntimePassed)}**. ` +
        `Candidate < 300 MB: **${status(comparison.preferredMemoryPassed)}**. ` +
        `Both preferred goals: **${status(comparison.preferredTargetsPassed)}**.\n\n` +
        "All 20,160,000 pixels, 13 independent regions, 384 texture identities, " +
        "logical command counts and omission diagnostics passed. " +
        (comparison.provenance
          ? `Exact-commit source identities passed (${comparison.provenance.baseline.verifiedSourceFiles} baseline, ${comparison.provenance.candidate.verifiedSourceFiles} candidate). `
          : "") +
        "Raw timing, fidelity, lifetime and phase reports are retained in the artifact. " +
        "Nested phase timings must not be added together.\n",
    );
  }
  console.log(JSON.stringify(comparison));
}
