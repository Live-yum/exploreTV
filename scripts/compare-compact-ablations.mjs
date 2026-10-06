import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareOverviewBenchmarks,
  summarizeOverviewPhases,
  verifyOverviewSourceProvenance,
} from "./compare-overview-benchmarks.mjs";

const MODES = {
  default: { wasm: true, mask: true },
  compactJs: { wasm: false, mask: true },
  compactUnmasked: { wasm: true, mask: false },
};

/** Compare only feature switches on the same immutable candidate source. */
export function compareCompactAblations(runs, commit, { checkout } = {}) {
  const base = runs.default,
    result = {};
  for (const [name, mode] of Object.entries(MODES)) {
    const run = runs[name];
    assert.ok(run, `Missing ablation run: ${name}`);
    const checked = compareOverviewBenchmarks(base, run, commit, commit);
    assert.deepEqual(
      run.render.sourceHashes,
      base.render.sourceHashes,
      "Same candidate source hashes",
    );
    assert.ok(Object.keys(run.render.sourceHashes ?? {}).length > 0);
    assert.deepEqual(
      run.render.environment.nodeArguments,
      base.render.environment.nodeArguments,
    );
    assert.deepEqual(
      run.render.environment.allocator,
      base.render.environment.allocator,
    );
    assert.equal(
      run.render.compactTerrainPlanning,
      true,
      `${name}: compact planning must remain enabled`,
    );
    assert.ok(
      run.render.compactTerrainCommands > 0,
      `${name}: compact commands must execute`,
    );
    const direct = run.render.directTerrainOverviewStats;
    assert.equal(
      direct?.available,
      true,
      `${name}: direct native renderer must execute`,
    );
    assert.equal(
      direct.resolvedCellMask,
      mode.mask,
      `${name}: resolved-cell mask mode`,
    );
    assert.equal(
      direct.binarySha256,
      base.render.directTerrainOverviewStats.binarySha256,
      "Same native compositor binary",
    );
    assert.equal(
      run.render.nativeOverview.binarySha256,
      base.render.nativeOverview.binarySha256,
      "Same generic native binary",
    );
    if (mode.wasm) {
      assert.equal(
        run.render.terrainWasm?.available,
        true,
        `${name}: WASM must execute`,
      );
      assert.ok(run.render.terrainWasm.regions > 0);
      assert.equal(
        run.render.terrainWasm.fallbackRegions,
        0,
        `${name}: no unexpected WASM fallback`,
      );
      assert.equal(
        run.render.terrainWasm.binarySha256,
        base.render.terrainWasm.binarySha256,
        "Same WASM binary",
      );
    } else {
      assert.equal(
        run.render.terrainWasm,
        null,
        "JS ablation must deliberately disable WASM, not silently fail to load it",
      );
      assert.equal(run.render.plannerPhaseMilliseconds.wasmPacking, 0);
      assert.equal(run.render.plannerPhaseMilliseconds.wasmPlanning, 0);
    }
    if (mode.mask)
      assert.ok(
        direct.maskedBlitPixelsSkipped > 0,
        `${name}: mask must skip measured work`,
      );
    else {
      assert.equal(direct.maskedBlitPixelsSkipped, 0);
      assert.equal(direct.blitPixelsToResolvedCells, 0);
    }
    const provenance = checkout
      ? verifyOverviewSourceProvenance(run.render, checkout, commit)
      : null;
    result[name] = {
      mode: {
        compactPlanning: true,
        terrainWasm: mode.wasm,
        resolvedCellMask: mode.mask,
      },
      endToEndSeconds: checked.candidate.endToEndSeconds,
      conservativeAggregatePeakRssBytes:
        checked.candidate.conservativeAggregatePeakRssBytes,
      preferredRuntimePassed: checked.preferredRuntimePassed,
      preferredMemoryPassed: checked.preferredMemoryPassed,
      preferredTargetsPassed: checked.preferredTargetsPassed,
      correctnessPassed: checked.correctnessPassed,
      protectiveBudgetsPassed: checked.protectiveBudgetsPassed,
      deltaFromDefaultSeconds: +(
        run.timing.endToEndSeconds - base.timing.endToEndSeconds
      ).toFixed(3),
      deltaFromDefaultPeakBytes:
        run.timing.conservativeAggregatePeakRssBytes -
        base.timing.conservativeAggregatePeakRssBytes,
      phases: summarizeOverviewPhases(run.render),
      ...(provenance
        ? {
            provenance: {
              commit: provenance.commit,
              tree: provenance.tree,
              verifiedSourceFiles: provenance.verifiedSourceFiles,
            },
          }
        : {}),
    };
  }
  return {
    schema: "exploretv-compact-ablation-comparison-v1",
    candidateCommit: commit,
    method:
      "Pinned main, default candidate, compact JS without terrain WASM, then compact WASM without the resolved-cell mask run sequentially in one CI job on the same runner. " +
      "The three candidate runs use one exact source commit and identical prepared native binaries, each in a fresh complete cold process. " +
      "Each independently verifies the full 20,160,000-pixel RGBA hash, 13 regions, texture identities and omission diagnostics. " +
      "One sequential sample per mode; OS file caches and run-order effects are uncontrolled. Small differences are observations, not a statistically established improvement.",
    deltaMeaning:
      "A positive deltaFromDefaultSeconds means disabling the feature took longer in this single sample; a negative value means that sample was faster. Nested phase timings are not additive.",
    preferredRuntimeSeconds: 60,
    preferredRssBytes: 300000000,
    runs: result,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [defaultDir, jsDir, unmaskedDir, commit, checkout, ...extra] =
    process.argv.slice(2);
  if (
    !defaultDir ||
    !jsDir ||
    !unmaskedDir ||
    !commit ||
    !checkout ||
    extra.length
  )
    throw new Error(
      "Usage: node compare-compact-ablations.mjs default-dir compact-js-dir compact-unmasked-dir candidate-commit candidate-checkout",
    );
  const load = (directory) => {
    const read = (name) =>
      JSON.parse(readFileSync(join(directory, name), "utf8"));
    return {
      timing: read("cold-benchmark.json"),
      render: read("world-1px.png.json"),
      fidelity: read("world-1px.png.fidelity.json"),
    };
  };
  const report = compareCompactAblations(
    {
      default: load(defaultDir),
      compactJs: load(jsDir),
      compactUnmasked: load(unmaskedDir),
    },
    commit,
    { checkout },
  );
  writeFileSync(
    join(defaultDir, "ablation-summary.json"),
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const label = {
      default: "Compact + WASM + mask",
      compactJs: "Compact + JS + mask",
      compactUnmasked: "Compact + WASM, no mask",
    };
    const status = (value) => (value ? "passed" : "not met");
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "\n## Same-commit feature ablations\n\n" +
        "| Mode | Complete time | Conservative total peak | < 60 s | < 300 MB | Both |\n|---|---:|---:|---|---|---|\n" +
        Object.entries(report.runs)
          .map(
            ([name, run]) =>
              `| ${label[name]} | ${run.endToEndSeconds.toFixed(3)} s | ${(run.conservativeAggregatePeakRssBytes / 1e6).toFixed(2)} MB | ${status(run.preferredRuntimePassed)} | ${status(run.preferredMemoryPassed)} | ${status(run.preferredTargetsPassed)} |\n`,
          )
          .join("") +
        "\nAll three modes passed full-image, 13-region, asset, omission and exact-commit source checks. " +
        "These are single sequential samples; small differences and ordering effects do not establish a repeatable speedup. " +
        "Raw JSON reports and the ablation summary are retained; the two additional verified PNGs are not uploaded.\n",
    );
  }
  console.log(JSON.stringify(report));
}
