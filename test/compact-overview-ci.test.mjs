import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  OVERVIEW_BASELINE_COMMIT,
  summarizeOverviewPhases,
  verifyOverviewSourceProvenance,
} from "../scripts/compare-overview-benchmarks.mjs";

test("overview acceptance uses the integrated baseline, a title marker and one sequential runner", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/export-overview.yml", import.meta.url),
    "utf8",
  );
  assert.equal(
    OVERVIEW_BASELINE_COMMIT,
    "cbdf5b3c3b9f4952a2075a133f809b9b2d779d12",
  );
  assert.ok(workflow.includes(`BASELINE_COMMIT: ${OVERVIEW_BASELINE_COMMIT}`));
  assert.ok(
    workflow.includes("types: [opened, synchronize, reopened, edited]"),
  );
  assert.ok(
    workflow.includes("PR_TITLE: ${{ github.event.pull_request.title }}"),
  );
  assert.ok(workflow.includes('case "$PR_TITLE $message" in'));
  assert.ok(workflow.includes("'[export-overview]'"));
  assert.ok(workflow.includes("github.event.changes.title != null"));
  assert.equal(workflow.includes("matrix:"), false);
  const baseline = workflow.indexOf(
      "- name: Measure pinned baseline on this runner",
    ),
    candidate = workflow.indexOf("- run: node scripts/run-overview-ci.mjs\n"),
    comparison = workflow.indexOf("- name: Compare complete sequential runs");
  assert.ok(baseline > 0 && candidate > baseline && comparison > candidate);
  assert.ok(
    workflow.includes(
      '"$RUNNER_TEMP/exploretv-overview-baseline" "$GITHUB_WORKSPACE"',
    ),
  );
  assert.ok(
    workflow.includes(
      'artifacts/direct-overview-baseline/world-1px.png" --example',
    ),
  );
  assert.ok(
    workflow.includes("artifacts/direct-overview/world-1px.png --example"),
  );
  assert.ok(workflow.includes("artifacts/direct-overview-baseline/*.json"));
  assert.ok(workflow.includes("artifacts/direct-overview/*.json"));
});

test("source provenance verifies reported bytes against the exact measured Git commit", (t) => {
  const temporaryRoot = new URL("../artifacts/", import.meta.url);
  mkdirSync(temporaryRoot, { recursive: true });
  const checkout = mkdtempSync(new URL("source-provenance-", temporaryRoot));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  mkdirSync(join(checkout, "scripts"));
  mkdirSync(join(checkout, "core"));
  const sourceHashes = {};
  for (const name of [
    "scripts/export-overview.mjs",
    "scripts/world-render-engine.mjs",
    "core/renderer.mjs",
  ]) {
    const content = `// fixture ${name}\n`;
    writeFileSync(join(checkout, name), content);
    sourceHashes[name] = createHash("sha256").update(content).digest("hex");
  }
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    }).trim();
  git("init", "-q");
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "Fixture");
  const commit = git("rev-parse", "HEAD");
  const evidence = verifyOverviewSourceProvenance(
    { sourceHashes },
    checkout,
    commit,
  );
  assert.equal(evidence.commit, commit);
  assert.equal(evidence.tree, git("rev-parse", "HEAD^{tree}"));
  assert.equal(evidence.verifiedSourceFiles, 3);
  assert.deepEqual(evidence.sourceHashes, sourceHashes);

  // This represents an exporter run from edited source but attributed to HEAD.
  const changed = { ...sourceHashes, "core/renderer.mjs": "0".repeat(64) };
  assert.throws(
    () =>
      verifyOverviewSourceProvenance(
        { sourceHashes: changed },
        checkout,
        commit,
      ),
    /Exact-commit source identity: core\/renderer.mjs/,
  );
  assert.throws(() =>
    verifyOverviewSourceProvenance({ sourceHashes }, checkout, "b".repeat(40)),
  );
  assert.throws(() =>
    verifyOverviewSourceProvenance(
      { sourceHashes: { ...sourceHashes, "../outside": "0".repeat(64) } },
      checkout,
      commit,
    ),
  );
});

test("phase summary preserves nested measurements without counting them twice", () => {
  const summary = summarizeOverviewPhases({
    stageMilliseconds: { plan: 40000, directTerrain: 42000 },
    plannerPhaseMilliseconds: {
      walls: 10000,
      liquids: 6000,
      tiles: 15000,
      layers: 2000,
      total: 35000,
      wasmPacking: 1000,
      wasmPlanning: 3000,
    },
    directTerrainOverviewStats: {
      phaseMilliseconds: {
        scanAndBatch: 38000,
        scan: 18000,
        batch: 20000,
        prepare: 7100,
        compose: 10600,
      },
      totalCommands: 18612825,
      secondPassHits: 10875178,
      nativeBlitPixels: 5878880072,
      backend: "test",
    },
  });
  assert.equal(summary.stageMilliseconds.plan, 40000);
  assert.equal(summary.plannerPhaseMilliseconds.total, 35000);
  assert.equal(summary.plannerPhaseMilliseconds.wasmPlanning, 3000);
  assert.equal(summary.directPhaseMilliseconds.scanAndBatch, 38000);
  assert.equal(summary.directPhaseMilliseconds.prepare, 7100);
  assert.equal(summary.directCounters.nativeBlitPixels, 5878880072);
  assert.equal(summary.directCounters.backend, undefined);
  assert.match(summary.timingRelationships, /not an additive breakdown/);
  assert.deepEqual(summarizeOverviewPhases({}).plannerPhaseMilliseconds, {});
});
