// Linux acceptance harness. Compilation is instrumentation setup, outside generation.
import { spawn, spawnSync } from "node:child_process";
import {
  statfsSync,
  readdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
if (process.platform !== "linux")
  throw new Error(
    "The full-lifetime RSS acceptance harness requires Linux wait4",
  );
const root = process.argv[2] ?? "artifacts/direct-overview";
const fs = statfsSync(".");
if (fs.bavail * fs.bsize < 512 * 1024 ** 2)
  throw new Error("At least 512 MiB free disk required");
mkdirSync(root, { recursive: true });
if (
  existsSync(join(root, "world-1px.png")) ||
  existsSync(join(root, "lifetime-usage.json"))
)
  throw new Error("Choose a fresh benchmark output directory");
const monitor = resolve(root, "measure-process");
const build = spawnSync(
  "cc",
  [
    "-O2",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "scripts/measure-process.c",
    "-o",
    monitor,
  ],
  { encoding: "utf8", timeout: 30000, maxBuffer: 65536 },
);
if (build.error || build.status !== 0)
  throw new Error(
    `Could not build RSS monitor: ${build.error?.message ?? build.stderr}`,
  );
const started = Date.now();
const child = spawn(
  monitor,
  [
    join(root, "lifetime-usage.json"),
    process.execPath,
    "--max-old-space-size=96",
    "--max-semi-space-size=2",
    "--expose-gc",
    "scripts/export-overview.mjs",
    "fixtures/example-world.wld",
    "example/assets",
    join(root, "world-1px.png"),
    "--expect-world-sha256",
    "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab",
  ],
  { stdio: "inherit", detached: true },
);
let stopped = false,
  killTimer,
  peakAggregateRssBytes = 0,
  completeTreeSamples = 0,
  partialTreeSamples = 0,
  peakCompleteAggregateRssBytes = 0;
function directoryBytes(path) {
  let sum = 0;
  let names;
  try {
    names = readdirSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  for (const name of names) {
    const p = join(path, name);
    try {
      const stat = lstatSync(p);
      sum += stat.isDirectory() ? directoryBytes(p) : stat.size;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
  return sum;
}
function treeRss(pid, parent, seen = new Set()) {
  if (seen.has(pid)) return { bytes: 0, count: 0, complete: true };
  if (seen.size >= 16)
    throw new Error("Unexpected benchmark process-tree size");
  seen.add(pid);
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    // A sandbox can expose a different PID namespace through /proc. Never
    // attribute an unrelated process to this benchmark on a numeric PID alone.
    if (Number(status.match(/^PPid:\s+(\d+)/m)?.[1]) !== parent)
      return { bytes: 0, count: 0, complete: false };
    const value = {
      bytes: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024,
      count: 1,
      complete: true,
    };
    const children = readFileSync(
      `/proc/${pid}/task/${pid}/children`,
      "utf8",
    ).trim();
    if (children)
      for (const text of children.split(/\s+/)) {
        const child = treeRss(Number(text), pid, seen);
        value.bytes += child.bytes;
        value.count += child.count;
        value.complete &&= child.complete;
      }
    return value;
  } catch (error) {
    if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code))
      return { bytes: 0, count: 0, complete: false };
    throw error;
  }
}
function stop(reason) {
  if (stopped) return;
  stopped = true;
  const event = {
    reason,
    elapsedSeconds: (Date.now() - started) / 1000,
    peakAggregateRssBytes,
  };
  writeFileSync(
    join(root, "budget-event.json"),
    JSON.stringify(event, null, 2),
  );
  console.error("CI overview budget exceeded: " + JSON.stringify(event));
  child.kill("SIGTERM");
  killTimer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") console.error(error.message);
    }
  }, 10000);
}
const timer = setInterval(() => {
  try {
    const tree = treeRss(child.pid, process.pid);
    const aggregate = process.memoryUsage().rss + tree.bytes;
    if (tree.complete && tree.count >= 2) {
      completeTreeSamples++;
      peakCompleteAggregateRssBytes = Math.max(
        peakCompleteAggregateRssBytes,
        aggregate,
      );
    } else partialTreeSamples++;
    peakAggregateRssBytes = Math.max(peakAggregateRssBytes, aggregate);
    if (directoryBytes(root) > 128 * 1024 ** 2) stop("128 MiB output");
    if (aggregate > 500000000)
      stop("500,000,000 bytes complete process tree RSS");
    if (Date.now() - started >= 600000)
      stop("600 second cold end-to-end runtime");
  } catch (error) {
    stop("Resource monitor failed: " + error.message);
  }
}, 1000);
child.once("error", (error) => {
  clearInterval(timer);
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  clearInterval(timer);
  clearTimeout(killTimer);
  const endToEndSeconds = (Date.now() - started) / 1000;
  let lifetime = null,
    report = null,
    measurementError = null;
  try {
    lifetime = JSON.parse(readFileSync(join(root, "lifetime-usage.json")));
  } catch (error) {
    measurementError = error.message;
  }
  if (existsSync(join(root, "world-1px.png.json")))
    report = JSON.parse(readFileSync(join(root, "world-1px.png.json")));
  const harnessOsPeakRssBytes = process.resourceUsage().maxRSS * 1024;
  // Conservative peak sum, plus 1 MiB for the tiny monitoring/reporting tail.
  const monitoringTailReserveBytes = 1048576;
  const conservativeAggregatePeakRssBytes = lifetime
    ? Math.max(
        peakAggregateRssBytes,
        lifetime.exporterOsPeakRssBytes +
          lifetime.monitorOsPeakRssBytes +
          harnessOsPeakRssBytes +
          monitoringTailReserveBytes,
      )
    : null;
  const targetPassed =
    !stopped &&
    code === 0 &&
    signal === null &&
    lifetime?.exitCode === 0 &&
    report !== null &&
    endToEndSeconds < 600 &&
    conservativeAggregatePeakRssBytes <= 500000000;
  const timing = {
    schema: "exploretv-overview-cold-benchmark-v2",
    targetPassed,
    endToEndSeconds,
    exporterSeconds: report?.runtimeSeconds ?? null,
    targetSeconds: 600,
    targetRssBytes: 500000000,
    preferredRssBytes: 200000000,
    preferredMemoryPassed:
      conservativeAggregatePeakRssBytes !== null &&
      conservativeAggregatePeakRssBytes <= 200000000,
    conservativeAggregatePeakRssBytes,
    processTreeSamplingAvailable: completeTreeSamples > 0,
    completeTreeSamples,
    partialTreeSamples,
    sampledAggregatePeakRssBytes:
      completeTreeSamples > 0 ? peakCompleteAggregateRssBytes : null,
    partialTreeObservedPeakBytes: peakAggregateRssBytes,
    harnessOsPeakRssBytes,
    monitoringTailReserveBytes,
    lifetime,
    measurementError,
    exitCode: code,
    signal,
    includes: [
      "process startup",
      "world read/parse/index",
      "complete waterfall registry",
      "PNG decode",
      "cold frame caches",
      "all composition/reduction",
      "PNG compression/hash/write",
      "exporter shutdown",
    ],
    excludes: [
      "dependencies and benchmark-helper compilation",
      "separate correctness verification",
    ],
    cacheState:
      "Fresh process/application caches; OS file cache uncontrolled; no persistent reduced-texture cache.",
    memoryMeasurement:
      "Linux wait4 measures the entire exporter lifetime. getrusage measures the small native monitor and Node harness. Acceptance uses their conservative peak sum plus 1 MiB tail reserve, and samples their contemporaneous process-tree RSS every second. Native threads are included. If /proc sampling is unavailable or namespace-inconsistent, the exact lifetime conservative peak sum remains the acceptance measurement.",
    environment: report?.environment ?? null,
  };
  writeFileSync(
    join(root, "cold-benchmark.json"),
    JSON.stringify(timing, null, 2),
  );
  console.log(JSON.stringify({ phase: "cold-benchmark", ...timing }));
  process.exitCode = targetPassed ? 0 : 1;
});
process.once("SIGTERM", () => stop("Workflow cancellation"));
process.once("SIGINT", () => stop("User cancellation"));
