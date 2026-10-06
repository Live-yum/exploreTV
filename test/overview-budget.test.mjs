import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureWorld, record } from "./fixture.mjs";
import {
  exportOverview,
  parseOverviewCli,
} from "../scripts/export-overview.mjs";
import { verifyExport } from "../scripts/verify-export.mjs";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "exploretv-overview-budget-")),
    worldPath = join(dir, "source.wld"),
    assetDir = join(dir, "assets"),
    outputPath = join(dir, "overview.png");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(assetDir);
  // One tiny empty chunk isolates terminal checks from scene complexity.
  const source = fixtureWorld({
    width: 2,
    height: 2,
    columns: Array.from({ length: 2 }, () => [
      record({ type: null, repeats: 1 }),
    ]),
  }).bytes;
  writeFileSync(worldPath, source);
  return {
    dir,
    source,
    config: parseOverviewCli([worldPath, assetDir, outputPath]),
  };
}

function assertUnpublishedFailure({ dir, config }) {
  assert.equal(existsSync(config.outputPath), false);
  assert.equal(existsSync(`${config.outputPath}.json`), false);
  assert.ok(readdirSync(dir).every((name) => !name.includes(".partial")));
  const progress = JSON.parse(
    readFileSync(`${config.outputPath}.progress.json`, "utf8"),
  );
  assert.equal(progress.phase, "aborted");
  assert.equal(progress.processedCells, 4);
  assert.equal(progress.writtenRows, 2);
}

test("overview rejects RSS overshoot introduced at the final progress callback", async (t) => {
  const fixture = setup(t),
    resourceUsage = process.resourceUsage.bind(process);
  let progressCalls = 0;
  await assert.rejects(
    exportOverview(fixture.config, {
      onProgress(progress) {
        progressCalls++;
        assert.equal(progress.writtenRows, progress.totalRows);
        t.mock.method(process, "resourceUsage", () => ({
          ...resourceUsage(),
          maxRSS: Math.floor(500000000 / 1024) + 1,
        }));
      },
    }),
    /500,000,000|RSS|memory/i,
  );
  assert.equal(progressCalls, 1);
  assertUnpublishedFailure(fixture);
});

test("overview rejects elapsed-time overshoot introduced at the final progress callback", async (t) => {
  const fixture = setup(t),
    now = performance.now.bind(performance);
  let offset = 0,
    progressCalls = 0;
  t.mock.method(performance, "now", () => now() + offset);
  await assert.rejects(
    exportOverview(fixture.config, {
      onProgress(progress) {
        progressCalls++;
        assert.equal(progress.writtenRows, progress.totalRows);
        offset = 600001;
      },
    }),
    /600|generation limit|runtime/i,
  );
  assert.equal(progressCalls, 1);
  assertUnpublishedFailure(fixture);
});

for (const keepReport of [true, false])
  test(`a complete overview PNG with aborted progress fails verification ${keepReport ? "with" : "without"} a source report`, async (t) => {
    const { config } = setup(t);
    await exportOverview(config);
    // A late resource failure may preserve a complete PNG for diagnostics,
    // including a failure after publication but before writing its report.
    // Neither valid bytes nor a matching report may override terminal abort.
    const progressPath = `${config.outputPath}.progress.json`,
      progress = JSON.parse(readFileSync(progressPath, "utf8"));
    writeFileSync(
      progressPath,
      JSON.stringify({
        ...progress,
        phase: "aborted",
        message:
          "Overview exceeded the 500,000,000-byte total process RSS limit",
      }),
    );
    if (!keepReport) rmSync(`${config.outputPath}.json`);
    await assert.rejects(
      verifyExport(config.outputPath, { reportPath: null }),
      /done|terminal|aborted|progress/i,
    );
  });

test("an in-budget overview retains normal success, verification and read-only source behavior", async (t) => {
  const { config, source } = setup(t),
    report = await exportOverview(config),
    progress = JSON.parse(
      readFileSync(`${config.outputPath}.progress.json`, "utf8"),
    ),
    verification = await verifyExport(config.outputPath, { reportPath: null });
  assert.equal(progress.phase, "done");
  assert.equal(report.processedCells, 4);
  assert.equal(report.writtenRows, 2);
  assert.equal(report.png.width, 2);
  assert.equal(report.png.height, 2);
  assert.equal(report.resourceLimits.rssBytes, 500000000);
  assert.equal(report.resourceLimits.preferredRssBytes, 300000000);
  assert.equal(report.resourceLimits.runtimeSeconds, 600);
  assert.equal(report.resourceLimits.renderingProcesses, 1);
  assert.equal(report.resourceLimits.childProcesses, 0);
  assert.equal(verification.status, "passed");
  assert.equal(verification.exportReportMatched, true);
  assert.deepEqual(readFileSync(config.worldPath), Buffer.from(source));
});
