import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compareOverviewBenchmarks,
  OVERVIEW_BASELINE_COMMIT,
} from "../scripts/compare-overview-benchmarks.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const main = "12389011ce9be374328e331837f1f16645ddb5fb";
const pr3 = "105e4f3eee2889ae5110615a656636b88462f7fa";
const pr4 = "ce473e50868d7746a67a9b452807e310c548c48b";

test("prepared marker runs all three pinned baselines and candidate in one sequential job", () => {
  const workflow = read("../.github/workflows/export-prepared.yml");
  assert.ok(workflow.includes("'[benchmark-prepared]'"));
  for (const [name, commit] of [
    ["MAIN", main],
    ["PR3", pr3],
    ["PR4", pr4],
  ])
    assert.ok(workflow.includes(`${name}_COMMIT: ${commit}`));
  assert.ok(
    workflow.includes(
      'for entry in "main:$MAIN_COMMIT" "pr3:$PR3_COMMIT" "pr4:$PR4_COMMIT"; do',
    ),
  );
  assert.equal(workflow.includes("matrix:"), false);
  const phases = [
    "Measure pinned main, PR3 and PR4 sequentially on this runner",
    "Measure current first-seen world without persistent world cache",
    "Compare complete candidate export against each pinned baseline",
    "Separately measure first world preparation and prepared replay",
    "Separately time 4200-pixel WebP sharing copy after all generation measurements",
  ].map((name) => workflow.indexOf("- name: " + name));
  assert.ok(phases.every((offset) => offset >= 0));
  assert.deepEqual(
    phases,
    [...phases].sort((a, b) => a - b),
  );
  assert.ok(
    workflow.includes(
      'test "$(git -C "$baseline" rev-parse HEAD)" = "$commit"',
    ),
  );
  assert.ok(
    workflow.includes("assert.deepEqual(current.packages[path], entry"),
  );
  assert.ok(
    workflow.includes(
      "npm run prepare:overview\n              node scripts/check-overview-native.mjs",
    ),
  );
  assert.ok(
    workflow.includes('artifacts/baseline-$label/world-1px.png" --example'),
  );
  assert.ok(
    workflow.includes("artifacts/current-cold/world-1px.png --example"),
  );
  assert.ok(workflow.includes("candidate, candidateCommit, checked"));
  assert.ok(workflow.includes("All four exports"));
  for (const label of ["main", "pr3", "pr4"])
    assert.ok(workflow.includes(`artifacts/baseline-${label}/*.json`));
  for (const name of [
    "renderer-emission-core",
    "renderer-output-bounds",
    "scene-frame-id",
    "world-validation-memo",
    "overview-shared-geometry",
    "integration-benchmark-workflow",
  ])
    assert.ok(workflow.includes(`test/${name}.test.mjs`));
});

test("standalone overview workflow retains coverage and compares against integrated main", () => {
  const workflow = read("../.github/workflows/export-overview.yml");
  assert.equal(
    OVERVIEW_BASELINE_COMMIT,
    "fae6f52a5227cef3f6544f383d074f10da84e1e0",
  );
  assert.ok(workflow.includes(`BASELINE_COMMIT: ${OVERVIEW_BASELINE_COMMIT}`));
  for (const name of [
    "world-validation-memo",
    "renderer-slope-polygons",
    "scene-frame-id",
    "renderer-emission-core",
    "overview-shared-geometry",
  ])
    assert.ok(workflow.includes(`test/${name}.test.mjs`));
});

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

test("comparator labels each verified pinned baseline without overwriting provenance", () => {
  for (const pin of [main, pr3, pr4]) {
    const comparison = compareOverviewBenchmarks(
      fixture(),
      fixture(240, 280000000),
      "a".repeat(40),
      pin,
    );
    assert.equal(comparison.baselineCommit, pin);
    assert.equal(comparison.independentRegionsPerRun, 13);
    assert.equal(comparison.savedSeconds, 60);
  }
  assert.throws(() =>
    compareOverviewBenchmarks(fixture(), fixture(), "a".repeat(40), "pr3"),
  );
});
