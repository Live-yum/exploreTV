import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareOverviewBenchmarks,
  summarizeOverviewPhases,
  verifyOverviewSourceProvenance,
} from "./compare-overview-benchmarks.mjs";
import { verifyOverviewFramePack } from "./verify-overview-frame-pack.mjs";

const MODES = {
  default: { pack: true, stream: true },
  dynamicFrames: { pack: false, stream: true },
  legacyPlanning: { pack: true, stream: false },
};

/** Isolate prepared pixels and WASM command emission without changing the source. */
export function compareFramePackBenchmarks(
  runs,
  commit,
  { checkout, preparation } = {},
) {
  const base = runs.default,
    result = {};
  let packIdentity = null;
  for (const [name, mode] of Object.entries(MODES)) {
    const run = runs[name];
    assert.ok(run, `Missing frame-pack experiment: ${name}`);
    const checked = compareOverviewBenchmarks(base, run, commit, commit);
    assert.deepEqual(
      run.render.sourceHashes,
      base.render.sourceHashes,
      "Same candidate source",
    );
    assert.deepEqual(
      run.render.environment.nodeArguments,
      base.render.environment.nodeArguments,
    );
    assert.deepEqual(
      run.render.environment.allocator,
      base.render.environment.allocator,
    );
    assert.equal(run.render.compactTerrainPlanning, true);
    assert.ok(run.render.compactTerrainCommands > 0);
    const wasm = run.render.terrainWasm,
      direct = run.render.directTerrainOverviewStats;
    assert.equal(
      wasm?.available,
      true,
      `${name}: neighbourhood WASM remains enabled`,
    );
    assert.ok(wasm.regions > 0);
    assert.equal(wasm.fallbackRegions, 0);
    assert.equal(wasm.binarySha256, base.render.terrainWasm.binarySha256);
    assert.equal(direct?.available, true);
    assert.equal(
      direct.binarySha256,
      base.render.directTerrainOverviewStats.binarySha256,
    );
    assert.equal(
      run.render.nativeOverview.binarySha256,
      base.render.nativeOverview.binarySha256,
    );
    assert.equal(
      direct.resolvedCellMask,
      false,
      "Experimental mask is held off in every mode",
    );
    assert.equal(
      run.render.wasmFrameStreamEnabled,
      mode.stream,
      `${name}: WASM command emission mode`,
    );
    if (mode.stream) {
      assert.ok(wasm.streamRegions > 0, `${name}: WASM emits ordinary frames`);
      assert.ok(
        direct.commandStreamCommands > 0,
        `${name}: direct consumes the stream`,
      );
      assert.ok(
        run.render.commandStreamCommands > 0,
        `${name}: the numeric command stream executes`,
      );
    } else {
      assert.equal(wasm.streamRegions, 0);
      assert.equal(direct.commandStreamCommands, 0);
      assert.equal(
        run.render.commandStreamCommands,
        0,
        "Legacy planning must not emit the new stream",
      );
    }
    assert.equal(
      Boolean(run.render.framePack?.available),
      mode.pack,
      `${name}: prepared frame mode`,
    );
    if (mode.pack) {
      const identity = verifyOverviewFramePack(run.render);
      if (packIdentity)
        assert.deepEqual(
          identity,
          packIdentity,
          "Both modes consume exactly the same frame pack",
        );
      else packIdentity = identity;
    } else {
      assert.equal(direct.packFrameHits, 0);
      assert.equal(direct.peakPackPageBytes, 0);
    }
    const provenance = checkout
      ? verifyOverviewSourceProvenance(run.render, checkout, commit)
      : null;
    result[name] = {
      mode: {
        precompiledFrames: mode.pack,
        wasmFrameStream: mode.stream,
        neighbourhoodWasm: true,
        resolvedCellMask: false,
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
  if (preparation) {
    assert.ok(
      Number.isFinite(preparation.elapsedSeconds) &&
        preparation.elapsedSeconds >= 0,
    );
    assert.equal(
      preparation.manifestSha256,
      packIdentity.manifestSha256,
      "Resource build and executed manifest",
    );
    assert.ok(
      Number.isFinite(preparation.processElapsedSeconds) &&
        preparation.processElapsedSeconds >= preparation.elapsedSeconds,
      "Complete resource compiler process measurement",
    );
    assert.ok(
      Number.isSafeInteger(preparation.osPeakRssBytes) &&
        preparation.osPeakRssBytes > 0,
      "Resource compiler OS peak RSS",
    );
    for (const [reportKey, packKey] of Object.entries({
      candidateSlots: "frames",
      uniqueFrames: "uniqueFrames",
      pageCount: "pageCount",
      logicalPixelBytes: "logicalPixelBytes",
      pixelBytes: "pixelBytes",
      onDiskBytes: "onDiskBytes",
      indexBytes: "indexBytes",
    }))
      assert.equal(
        preparation[reportKey],
        packIdentity[packKey],
        `Resource build ${reportKey}`,
      );
    assert.deepEqual(
      preparation.sourceHashes,
      packIdentity.sourceHashes,
      "Resource build and executed source textures",
    );
    assert.deepEqual(
      preparation.ruleHashes,
      packIdentity.ruleHashes,
      "Resource build and executed preparation rules",
    );
  }
  return {
    schema: "exploretv-frame-pack-comparison-v1",
    candidateCommit: commit,
    method:
      "Pinned main, default prepared frames plus WASM command stream, dynamic frames plus the same stream, then prepared frames plus legacy command planning run sequentially in one job. All candidate modes use one exact source commit, the same native/WASM binaries, fresh complete processes, unchanged heap/allocator settings and no mask. Neighbourhood/liquid WASM stays enabled in all three candidate modes. The world-independent resource build is measured separately; pack loading, texture identity checks and page reads remain inside cold export time. Each run checks all 20,160,000 pixels, 13 regions, source textures and omission diagnostics. One sample per mode; OS file-cache state and ordering effects are uncontrolled.",
    deltaMeaning:
      "Positive deltaFromDefaultSeconds means that mode was slower in this sample. Nested phase timings are not additive. Single-run differences do not establish a stable speedup.",
    preferredRuntimeSeconds: 60,
    preferredRssBytes: 300000000,
    packIdentity,
    resourcePreparation: preparation
      ? {
          ...preparation,
          timingScope:
            "Separate resource compiler measurement, not a world render. Rebuild after changing textures or preparation rules; exporter measurements include reading and using the result.",
        }
      : null,
    runs: result,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [
    defaultDir,
    dynamicDir,
    legacyDir,
    commit,
    checkout,
    preparationPath,
    ...extra
  ] = process.argv.slice(2);
  if (
    !defaultDir ||
    !dynamicDir ||
    !legacyDir ||
    !commit ||
    !checkout ||
    !preparationPath ||
    extra.length
  )
    throw new Error(
      "Usage: node compare-frame-pack-benchmarks.mjs default-dir dynamic-dir legacy-dir commit checkout build-report.json",
    );
  const load = (dir) => {
    const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
    return {
      timing: read("cold-benchmark.json"),
      render: read("world-1px.png.json"),
      fidelity: read("world-1px.png.fidelity.json"),
    };
  };
  const report = compareFramePackBenchmarks(
    {
      default: load(defaultDir),
      dynamicFrames: load(dynamicDir),
      legacyPlanning: load(legacyDir),
    },
    commit,
    {
      checkout,
      preparation: JSON.parse(readFileSync(preparationPath, "utf8")),
    },
  );
  writeFileSync(
    join(defaultDir, "frame-pack-comparison.json"),
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const labels = {
      default: "Prepared frames + WASM stream",
      dynamicFrames: "Dynamic frames + WASM stream",
      legacyPlanning: "Prepared frames + legacy command planning",
    };
    const status = (value) => (value ? "passed" : "not met");
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "\n## Prepared frame and command-stream experiments\n\n| Mode | Complete time | Conservative peak | <60 s | <300 MB |\n|---|---:|---:|---|---|\n" +
        Object.entries(report.runs)
          .map(
            ([name, run]) =>
              `| ${labels[name]} | ${run.endToEndSeconds.toFixed(3)} s | ${(run.conservativeAggregatePeakRssBytes / 1e6).toFixed(3)} MB | ${status(run.preferredRuntimePassed)} | ${status(run.preferredMemoryPassed)} |\n`,
          )
          .join("") +
        `\nResource compilation: ${report.resourcePreparation.elapsedSeconds.toFixed(3)} s, reported separately. All modes passed full-image, 13-region, texture, omission and exact-source checks. These are single sequential samples.\n`,
    );
  }
  console.log(JSON.stringify(report));
}
