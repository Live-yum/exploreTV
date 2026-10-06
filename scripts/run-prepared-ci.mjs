// Linux lifetime measurement for two separate processes: world-specific first
// preparation (including its first PNG), followed by replay of that exact tape.
// Native modules must already be built; this harness never prepares them.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  sampleProcessMemory,
  getProcessMemorySamplingStatus,
} from "./process-memory.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const fixtureWorld = join(repository, "fixtures/example-world.wld");
const fixtureAssets = join(repository, "example/assets");
const fixtureSha256 =
  "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab";
const RSS_LIMIT = 500000000;
const PREFERRED_RSS = 300000000;
const TAIL_RESERVE = 1048576;
const HARD_SECONDS = 600;

export const USAGE = `Usage:
  node scripts/run-prepared-ci.mjs [new-output-directory]
    [--world world.wld] [--assets png-directory] [-- overview options]

Defaults: artifacts/prepared-world-benchmark, fixtures/example-world.wld,
example/assets. Overview options after -- apply to the FIRST world preparation;
the replay uses its recorded scope and the same compression level.

Run npm run prepare:overview beforehand. Native module builds are excluded.
This harness creates exactly one new world-specific prepared directory, runs
prepare and replay sequentially in fresh Node processes under Linux wait4,
and writes prepare-runtime.json and replay-runtime.json. Replay includes input,
renderer and tape verification; it does not copy preview.png.

First-world preparation has a 600-second target; prepared replay has a separate
60-second target. Each phase has a 500 MB conservative total RSS limit and a
300 MB preferred limit. The output directory must not already exist.`;

export function parsePreparedCi(argv, cwd = process.cwd()) {
  if (argv.includes("--help")) return { help: true };
  const args = [...argv];
  const output =
    args[0] && !args[0].startsWith("--")
      ? args.shift()
      : "artifacts/prepared-world-benchmark";
  let worldPath = fixtureWorld,
    assetDir = fixtureAssets,
    flags = [];
  while (args.length) {
    const flag = args.shift();
    if (flag === "--") {
      flags = args;
      break;
    }
    if (flag !== "--world" && flag !== "--assets")
      throw new Error(
        `Unknown harness option ${flag}; put overview options after --`,
      );
    const value = args.shift();
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${flag}`);
    if (flag === "--world") worldPath = resolve(cwd, value);
    else assetDir = resolve(cwd, value);
  }
  let compressionLevel = "6";
  for (let i = 0; i < flags.length; i++)
    if (flags[i] === "--compression-level") {
      compressionLevel = flags[i + 1];
      if (!/^[0-9]$/.test(compressionLevel ?? ""))
        throw new Error("compression-level must be 0..9");
    }
  if (worldPath === fixtureWorld && !flags.includes("--expect-world-sha256"))
    flags = ["--expect-world-sha256", fixtureSha256, ...flags];
  return {
    root: resolve(cwd, output),
    worldPath,
    assetDir,
    flags,
    compressionLevel,
  };
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
function readReport(path) {
  if (statSync(path).size > 4 * 1024 ** 2)
    throw new Error("Oversized runtime report: " + path);
  return JSON.parse(readFileSync(path, "utf8"));
}
function validBytes(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** The peak sum is conservative: component peaks need not occur together.
 * Unlike sampled /proc values, wait4 includes the complete child lifetime. */
export function conservativePeak(lifetime, harnessOsPeakRssBytes) {
  if (
    !lifetime ||
    !validBytes(lifetime.exporterOsPeakRssBytes) ||
    !validBytes(lifetime.monitorOsPeakRssBytes) ||
    !validBytes(harnessOsPeakRssBytes)
  )
    throw new Error("Invalid complete-lifetime RSS measurement");
  const total =
    lifetime.exporterOsPeakRssBytes +
    lifetime.monitorOsPeakRssBytes +
    harnessOsPeakRssBytes +
    TAIL_RESERVE;
  if (!Number.isSafeInteger(total))
    throw new Error("RSS measurement exceeds integer range");
  return total;
}

async function measurePhase({ mode, config, monitor, directory, controller }) {
  const firstPreparation = mode === "prepare";
  const phase = firstPreparation
    ? "first-world-preparation"
    : "prepared-world-replay";
  const outputPath = join(config.root, "replay.png");
  const lifetimePath = join(config.root, `${mode}-lifetime.json`);
  const reportPath = firstPreparation
    ? join(directory, "preparation.json")
    : `${outputPath}.json`;
  const args = firstPreparation
    ? ["prepare", config.worldPath, config.assetDir, directory, ...config.flags]
    : [
        "replay",
        config.worldPath,
        config.assetDir,
        directory,
        outputPath,
        "--compression-level",
        config.compressionLevel,
      ];
  if (controller.signal.aborted) throw controller.signal.reason;
  const started = performance.now();
  const child = spawn(
    monitor,
    [
      lifetimePath,
      process.execPath,
      "--max-old-space-size=48",
      "--max-semi-space-size=4",
      "--expose-gc",
      join(repository, "scripts/prepared-world.mjs"),
      ...args,
    ],
    {
      cwd: repository,
      stdio: "inherit",
      detached: true,
      env: {
        ...process.env,
        MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX ?? "2",
        MALLOC_MMAP_THRESHOLD_: process.env.MALLOC_MMAP_THRESHOLD_ ?? "131072",
        DISABLE_SYSTEM_FONTS_LOAD: process.env.DISABLE_SYSTEM_FONTS_LOAD ?? "1",
      },
    },
  );
  let stopReason = null,
    killTimer;
  const stop = (reason) => {
    if (stopReason !== null) return;
    stopReason = reason;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (!Number.isInteger(child.pid)) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") console.error(error.message);
      }
    }, 10000);
  };
  const interrupt = () =>
    stop(controller.signal.reason?.message ?? "Cancelled");
  controller.signal.addEventListener("abort", interrupt, { once: true });
  if (controller.signal.aborted) interrupt();
  const timer = setTimeout(
    () => stop(`${HARD_SECONDS}-second lifetime limit`),
    HARD_SECONDS * 1000,
  );
  const completion = await new Promise((done) => {
    child.once("error", (error) => done({ code: null, signal: null, error }));
    child.once("close", (code, signal) => done({ code, signal, error: null }));
  });
  clearTimeout(timer);
  clearTimeout(killTimer);
  controller.signal.removeEventListener("abort", interrupt);
  const endToEndSeconds = (performance.now() - started) / 1000;
  let lifetime = null,
    report = null,
    sourceReport = null;
  let measurementError = completion.error?.message ?? null;
  let conservativeAggregatePeakRssBytes = null;
  try {
    lifetime = readReport(lifetimePath);
    if (
      !Number.isFinite(lifetime.elapsedSeconds) ||
      lifetime.elapsedSeconds < 0 ||
      !Number.isInteger(lifetime.exitCode)
    )
      throw new Error("Invalid wait4 lifetime result");
    report = readReport(reportPath);
    sourceReport = firstPreparation
      ? readReport(join(directory, "preview.png.json"))
      : report;
    if (
      firstPreparation
        ? report.schema !== "exploretv-world-preparation-v1" ||
          !existsSync(join(directory, "manifest.json"))
        : report.executionMode !== "prepared-command-replay"
    )
      throw new Error("Missing or invalid completed phase report");
    if (!Number.isFinite(report.runtimeSeconds) || report.runtimeSeconds < 0)
      throw new Error("Invalid exporter runtime");
  } catch (error) {
    measurementError = [measurementError, error.message]
      .filter(Boolean)
      .join("; ");
  }
  // Include the harness's report-read/parse peak before adding the small JSON
  // reporting reserve. The second phase conservatively includes its earlier peak.
  const harnessMemory = sampleProcessMemory();
  const harnessOsPeakRssBytes = process.resourceUsage().maxRSS * 1024;
  try {
    conservativeAggregatePeakRssBytes = conservativePeak(
      lifetime,
      harnessOsPeakRssBytes,
    );
  } catch (error) {
    measurementError = [measurementError, error.message]
      .filter(Boolean)
      .join("; ");
  }
  const completed =
    !stopReason &&
    !measurementError &&
    completion.code === 0 &&
    completion.signal === null &&
    lifetime?.exitCode === 0;
  const targetSeconds = firstPreparation ? 600 : 60;
  const targetPassed =
    completed &&
    endToEndSeconds < targetSeconds &&
    conservativeAggregatePeakRssBytes <= RSS_LIMIT;
  const timing = {
    schema: "exploretv-prepared-world-phase-benchmark-v1",
    phase,
    completed,
    targetPassed,
    endToEndSeconds,
    exporterSeconds: report?.runtimeSeconds ?? null,
    targetSeconds,
    hardLimitSeconds: HARD_SECONDS,
    targetRssBytes: RSS_LIMIT,
    preferredRssBytes: PREFERRED_RSS,
    preferredMemoryPassed:
      completed && conservativeAggregatePeakRssBytes < PREFERRED_RSS,
    conservativeAggregatePeakRssBytes,
    harnessOsPeakRssBytes,
    monitoringTailReserveBytes: TAIL_RESERVE,
    lifetime,
    measurementError,
    exitCode: completion.code,
    signal: completion.signal,
    stopReason,
    worldSpecificPreparationIncluded: firstPreparation,
    reusedWorldSpecificPreparation: !firstPreparation,
    includesFirstImage: firstPreparation,
    worldSha256: report?.worldSha256 ?? null,
    rgbaSha256: firstPreparation
      ? (report?.rgbaSha256 ?? null)
      : (report?.preparedWorld?.rgbaSha256 ?? null),
    fullWorld: sourceReport?.fullWorld ?? null,
    worldRect: sourceReport?.worldRect ?? null,
    png: sourceReport?.png ?? null,
    preparedDirectory: directory,
    phaseReport: reportPath,
    nativeCompilationPerformed: false,
    includes: firstPreparation
      ? [
          "fresh process startup and native-module load",
          "world read/parse/index, waterfall registry and scene planning",
          "texture loading, frame preparation, composition and reduction",
          "world-specific instruction/frame tape construction and hashing",
          "first PNG compression/hash/write, manifest finalization and shutdown",
        ]
      : [
          "fresh process startup and native-module load",
          "current world, textures, renderer, lockfile and tape hash verification",
          "world-specific ordered command replay, composition and reduction",
          "PNG compression/hash/write, exact compiled-pixel verification and shutdown",
        ],
    excludes: [
      "dependency installation and world-independent native-module builds",
      "benchmark-helper compilation and harness setup",
      ...(firstPreparation
        ? []
        : ["the separately measured first world-specific preparation"]),
    ],
    cacheState: firstPreparation
      ? "No world-specific prepared directory exists before this phase. Fresh process/application caches; native modules are already built; OS file cache is uncontrolled. This phase creates the persistent world-specific instruction/frame tape."
      : "Fresh process/application caches reuse the single world-specific instruction/frame tape produced by the preceding phase. All bindings are verified in the timed replay. OS file cache is uncontrolled and may be warm after preparation; preview.png is not reused as the output.",
    memoryMeasurement:
      "Linux wait4 child lifetime RSS + native monitor getrusage peak + harness process lifetime peak + 1 MiB reporting reserve. These independently occurring peaks form a conservative upper bound, not a sampled simultaneous peak. Native threads are included; no /proc sampling is required. The sequential phase peaks are reported separately, never added together.",
    harnessMemorySampling: getProcessMemorySamplingStatus(),
    harnessRssSource: harnessMemory.rssSource,
    environment: sourceReport?.environment ?? null,
  };
  writeJson(join(config.root, `${mode}-runtime.json`), timing);
  console.log(
    JSON.stringify({
      phase,
      completed,
      targetPassed,
      endToEndSeconds,
      conservativeAggregatePeakRssBytes,
      report: join(config.root, `${mode}-runtime.json`),
    }),
  );
  return timing;
}

export async function runPreparedCi(config) {
  if (process.platform !== "linux")
    throw new Error("Prepared lifetime measurements require Linux wait4");
  if (existsSync(config.root))
    throw new Error(
      "Choose a fresh benchmark output directory; existing directories are never reused",
    );
  const [{ nativeBlitterStatus }, { nativeReducerStatus }] = await Promise.all([
    import("./native-blitter.mjs"),
    import("./native-reducer.mjs"),
  ]);
  if (!nativeBlitterStatus.available || !nativeReducerStatus.available)
    throw new Error(
      "Native modules must be built before measurement; run npm run prepare:overview first",
    );
  mkdirSync(dirname(config.root), { recursive: true });
  const space = statfsSync(dirname(config.root));
  if (space.bavail * space.bsize < 768 * 1024 ** 2)
    throw new Error(
      "At least 768 MiB free disk required for the bounded tape and two PNGs",
    );
  mkdirSync(config.root);
  const monitor = join(config.root, "measure-process");
  const build = spawnSync(
    "cc",
    [
      "-O2",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      join(repository, "scripts/measure-process.c"),
      "-o",
      monitor,
    ],
    {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 65536,
      env: { ...process.env, TMPDIR: process.env.TMPDIR ?? config.root },
    },
  );
  if (build.error || build.status !== 0)
    throw new Error(
      `Could not build wait4 monitor: ${build.error?.message ?? build.stderr}`,
    );
  const directory = join(config.root, "prepared-world");
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error("Benchmark cancelled by signal"));
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  let preparation = null,
    replay = null,
    failure = null;
  try {
    preparation = await measurePhase({
      mode: "prepare",
      config,
      monitor,
      directory,
      controller,
    });
    if (preparation.completed && !controller.signal.aborted)
      replay = await measurePhase({
        mode: "replay",
        config,
        monitor,
        directory,
        controller,
      });
    else failure = "First preparation did not complete; no replay was started";
  } catch (error) {
    failure = error.message;
  } finally {
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
  }
  const pixelsMatch =
    preparation?.completed === true &&
    replay?.completed === true &&
    /^[0-9a-f]{64}$/.test(preparation.rgbaSha256 ?? "") &&
    preparation.rgbaSha256 === replay.rgbaSha256 &&
    preparation.worldSha256 === replay.worldSha256;
  const result = {
    schema: "exploretv-prepared-world-benchmark-v1",
    targetPassed:
      !failure &&
      !!preparation?.targetPassed &&
      !!replay?.targetPassed &&
      pixelsMatch,
    pixelsMatch,
    failure,
    preparation,
    replay,
    preparedDirectory: directory,
    preparationDirectoriesCreated: 1,
    preparationRebuiltForReplay: false,
    nativeCompilationPerformed: false,
    sequentialPhases: true,
    separateExporterProcesses: true,
    timingScope:
      "First preparation is world-specific and includes the first image. Replay is measured separately in a fresh process with that persistent tape already available. This is not a sub-60-second first-render claim for an unseen world.",
  };
  writeJson(join(config.root, "prepared-benchmark.json"), result);
  console.log(
    JSON.stringify({
      phase: "prepared-benchmark",
      targetPassed: result.targetPassed,
      pixelsMatch,
      preparationSeconds: preparation?.endToEndSeconds ?? null,
      replaySeconds: replay?.endToEndSeconds ?? null,
      report: join(config.root, "prepared-benchmark.json"),
    }),
  );
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const config = parsePreparedCi(process.argv.slice(2));
    if (config.help) console.log(USAGE);
    else process.exitCode = (await runPreparedCi(config)).targetPassed ? 0 : 1;
  } catch (error) {
    console.error("prepared-ci: " + error.message);
    process.exitCode = 1;
  }
}
