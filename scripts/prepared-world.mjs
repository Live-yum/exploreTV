import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { availableParallelism, arch, platform, release } from "node:os";
import { createPngWriter } from "./png-stream.mjs";
import { LIMITS } from "../core/world.mjs";
import { nativeBlitterStatus } from "./native-blitter.mjs";
import { nativeReducerStatus, trimNativeMemory } from "./native-reducer.mjs";
import {
  sampleProcessMemory,
  getProcessMemorySamplingStatus,
} from "./process-memory.mjs";
import {
  createWorldTapeRecorder,
  readWorldTapeManifest,
  replayWorldTapeChunks,
} from "./prepared-world-tape.mjs";

const isCli =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) process.env.DISABLE_SYSTEM_FONTS_LOAD ??= "1";

const HASH = /^[0-9a-f]{64}$/;
const SOURCE = /^(core|scripts)\/[a-z][a-z0-9-]*\.(mjs|c)$/;
const ASSET = /^[A-Za-z0-9_-]+\.png$/;

function checkAbort(signal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Cancelled");
}

/** Hash immutable input bytes through a bounded slab, including cache binding
 * verification in online latency without keeping whole files in memory. */
export function hashBoundedFile(path, maxBytes) {
  const fd = openSync(path, "r");
  try {
    const expected = fstatSync(fd).size;
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > maxBytes)
      throw new Error("Input file exceeds hash verification budget: " + path);
    const hash = createHash("sha256"),
      slab = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const n = readSync(
        fd,
        slab,
        0,
        Math.min(slab.length, maxBytes - total + 1),
        null,
      );
      if (!n) break;
      total += n;
      if (total > maxBytes)
        throw new Error("Input grew beyond hash verification budget: " + path);
      hash.update(slab.subarray(0, n));
    }
    if (total !== expected || fstatSync(fd).size !== expected)
      throw new Error("Input changed during hash verification: " + path);
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function requireNative() {
  if (!nativeBlitterStatus.available || !nativeReducerStatus.available)
    throw new Error(
      "Prepared world export requires native modules; run npm run prepare:overview first",
    );
}

/** Compile a WORLD-SPECIFIC instruction tape while producing its first image.
 * This is explicitly separate from world-independent native module preparation.
 * No existing directory is replaced, and an incomplete tape has no manifest. */
export async function prepareWorld(
  { worldPath, assetDir, directory, flags = [] },
  { signal, onProgress = () => {} } = {},
) {
  const started = performance.now();
  checkAbort(signal);
  requireNative();
  if (typeof directory !== "string" || !directory)
    throw new Error("Provide a prepared-world directory");
  if (existsSync(directory))
    throw new Error(
      "Prepared-world directory already exists; choose a new path",
    );
  // Keep the replay process independent of the planner, PNG texture decoder,
  // Canvas/Skia and font initialization. Only compilation needs those modules.
  const { exportOverview, parseOverviewCli } = await import(
    "./export-overview.mjs"
  );
  const preview = join(directory, "preview.png");
  const config = parseOverviewCli([worldPath, assetDir, preview, ...flags]);
  if (
    config.help ||
    config.pixelsPerTile !== 1 ||
    config.inputEncoding !== "tconvert-game-raw"
  )
    throw new Error(
      "World preparation currently supports 1 px/tile, tconvert-game-raw only",
    );
  mkdirSync(dirname(directory), { recursive: true });
  // Exclusive reservation also prevents a concurrent preparer from taking it.
  mkdirSync(directory);
  let recorder;
  try {
    recorder = createWorldTapeRecorder(directory);
    const report = await exportOverview(config, {
      signal,
      commandRecorder: recorder,
      onProgress: (p) => onProgress({ ...p, phase: "prepare-world" }),
    });
    checkAbort(signal);
    report.executionMode = "compile-world-and-render";
    report.preparedWorld = {
      scope:
        "world-specific, source-bound ordered native commands and exact residual cells",
      dependencyLockSha256: hashBoundedFile(
        new URL("../package-lock.json", import.meta.url),
        2 * 1024 ** 2,
      ),
      firstPreparationSeconds: (performance.now() - started) / 1000,
      rgbaSha256: report.preparedWorldPixelSha256,
      includesFirstImage: true,
      noWorldIndependentLatencyClaim: true,
      inputAssetStates: {},
    };
    for (const name of new Set([
      ...Object.keys(report.assetHashes),
      ...Object.keys(report.assetFailures),
      ...Object.keys(report.missingCommands),
      ...Object.keys(report.invalidCommands),
    ])) {
      if (!ASSET.test(name)) throw new Error("Invalid recorded texture name");
      const path = join(assetDir, name);
      report.preparedWorld.inputAssetStates[name] = existsSync(path)
        ? hashBoundedFile(path, 8 * 1024 ** 2)
        : null;
    }
    verifyPreparedWorldBindings(report, { worldPath, assetDir, signal });
    report.preparedWorld.firstPreparationSeconds =
      (performance.now() - started) / 1000;
    report.preparedWorld.firstPreparationTiming =
      "Compilation, first PNG and input validation through manifest publication start; preparation.json and the process benchmark include final publication and shutdown.";
    // The tape retains the logical coverage and omission evidence from this
    // exact compilation, separately from the subsequent replay's timings.
    const manifest = recorder.finalize(report);
    const result = {
      schema: "exploretv-world-preparation-v1",
      directory,
      preview,
      runtimeSeconds: (performance.now() - started) / 1000,
      osPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      worldSha256: report.worldSha256,
      rgbaSha256: report.preparedWorldPixelSha256,
      tape: { ...recorder.stats },
      scope: report.preparedWorld.scope,
      memorySampling: getProcessMemorySamplingStatus(),
    };
    writeFileSync(`${preview}.json`, JSON.stringify(report, null, 2));
    writeFileSync(
      join(directory, "preparation.json"),
      JSON.stringify(result, null, 2),
    );
    return { ...result, manifest };
  } catch (error) {
    // Publication commits a complete usable tape. A later summary-write error
    // must not remove its first image or claim to have rolled back that tape.
    if (recorder?.stats.finalized) throw error;
    recorder?.abort();
    // Only remove files this call owns. Preserve unexpected concurrently added
    // files, so a failed preparation cannot recursively delete another writer.
    for (const path of [
      preview,
      `${preview}.json`,
      `${preview}.progress.json`,
      `${preview}.partial`,
    ])
      rmSync(path, { force: true });
    try {
      rmdirSync(directory);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOTEMPTY" && cleanupError.code !== "ENOENT")
        throw cleanupError;
    }
    throw error;
  }
}

/** Reject stale inputs before opening the output PNG, even when the package's
 * own frames/commands are internally valid. Recompile after any such change. */
export function verifyPreparedWorldBindings(
  report,
  { worldPath, assetDir, signal } = {},
) {
  if (
    !report ||
    report.pixelsPerTile !== 1 ||
    report.inputEncoding !== "tconvert-game-raw" ||
    !HASH.test(report.worldSha256 ?? "") ||
    !HASH.test(report.preparedWorld?.rgbaSha256 ?? "")
  )
    throw new Error("Invalid prepared-world source report");
  checkAbort(signal);
  if (hashBoundedFile(worldPath, LIMITS.fileBytes) !== report.worldSha256)
    throw new Error(
      "Prepared world is stale: world SHA-256 differs; prepare the new world first",
    );
  if (!statSync(assetDir).isDirectory())
    throw new Error("PNG path must be a directory");
  const assets = Object.entries(report.assetHashes ?? {}),
    sources = Object.entries(report.sourceHashes ?? {});
  if (!sources.length || sources.length > 128 || assets.length > 512)
    throw new Error("Invalid prepared-world provenance size");
  const requiredSources = [
    "core/renderer.mjs",
    "scripts/export-world.mjs",
    "scripts/software-overview.mjs",
    "scripts/scene-command-index.mjs",
    "scripts/overview-geometry.mjs",
    "scripts/native-blitter.c",
    "scripts/native-reducer.c",
    "scripts/prepared-world-tape.mjs",
    "scripts/prepared-world.mjs",
  ];
  for (const name of requiredSources)
    if (!report.sourceHashes[name])
      throw new Error(
        "Prepared world is missing required source provenance: " + name,
      );
  for (const [name, hash] of sources) {
    checkAbort(signal);
    if (!SOURCE.test(name) || !HASH.test(hash))
      throw new Error("Invalid prepared-world source name/hash");
    if (
      hashBoundedFile(new URL("../" + name, import.meta.url), 2 * 1024 ** 2) !==
      hash
    )
      throw new Error(
        "Prepared world is stale: renderer source changed: " + name,
      );
  }
  for (const [name, hash] of assets) {
    checkAbort(signal);
    if (!ASSET.test(name) || !HASH.test(hash))
      throw new Error("Invalid prepared-world texture name/hash");
    if (hashBoundedFile(join(assetDir, name), 8 * 1024 ** 2) !== hash)
      throw new Error("Prepared world is stale: texture changed: " + name);
  }
  const states = Object.entries(report.preparedWorld.inputAssetStates ?? {});
  if (
    states.length > 512 ||
    !report.preparedWorld.inputAssetStates ||
    assets.some(
      ([name, hash]) => report.preparedWorld.inputAssetStates[name] !== hash,
    )
  )
    throw new Error("Invalid prepared-world texture state count or coverage");
  for (const collection of [
    report.assetFailures,
    report.missingCommands,
    report.invalidCommands,
  ])
    for (const name of Object.keys(collection ?? {}))
      if (!Object.hasOwn(report.preparedWorld.inputAssetStates, name))
        throw new Error(
          "Prepared world is missing a failed texture state: " + name,
        );
  for (const [name, hash] of states) {
    checkAbort(signal);
    if (!ASSET.test(name) || (hash !== null && !HASH.test(hash)))
      throw new Error("Invalid prepared-world texture state");
    if (Object.hasOwn(report.assetHashes, name)) continue; // Already byte-verified above.
    const path = join(assetDir, name);
    // Missing/failed sources are part of the snapshot too. Adding a previously
    // absent texture must rebuild the tape instead of silently replaying holes.
    if (
      hash === null
        ? existsSync(path)
        : !existsSync(path) || hashBoundedFile(path, 8 * 1024 ** 2) !== hash
    )
      throw new Error(
        "Prepared world is stale: missing/failed texture state changed: " +
          name,
      );
  }
  if (
    hashBoundedFile(
      new URL("../package-lock.json", import.meta.url),
      2 * 1024 ** 2,
    ) !== report.preparedWorld.dependencyLockSha256
  )
    throw new Error("Prepared world is stale: dependency lock changed");
  return {
    worldSha256: report.worldSha256,
    verifiedTextures: assets.length,
    verifiedSources: sources.length,
  };
}

export async function exportPreparedWorld(
  { directory, worldPath, assetDir, outputPath, compressionLevel = 6 },
  { signal, onProgress = () => {} } = {},
) {
  const started = performance.now(),
    cpuStarted = process.cpuUsage();
  checkAbort(signal);
  requireNative();
  if (
    !Number.isInteger(compressionLevel) ||
    compressionLevel < 0 ||
    compressionLevel > 9
  )
    throw new Error("compressionLevel must be 0..9");
  if (existsSync(outputPath))
    throw new Error("Output PNG already exists; choose a new path");
  // The replay iterator verifies both payloads once. This first bounded index
  // read validates source bindings before opening an output, without a second
  // complete payload scan.
  const manifest = readWorldTapeManifest(directory, { verifyFiles: false }),
    source = manifest.report;
  const binding = verifyPreparedWorldBindings(source, {
    worldPath,
    assetDir,
    signal,
  });
  const verificationSeconds = (performance.now() - started) / 1000;
  const rect = source.worldRect,
    bandTiles = source.bandTiles,
    chunkTiles = source.chunkTiles;
  const dimensions = source.worldDimensions;
  if (
    !rect ||
    ![rect.x, rect.y, rect.width, rect.height, bandTiles, chunkTiles].every(
      Number.isSafeInteger,
    ) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    rect.width > 8400 ||
    rect.height > 2400 ||
    bandTiles < 1 ||
    bandTiles > 128 ||
    chunkTiles < 1 ||
    chunkTiles > 252 ||
    !dimensions ||
    ![dimensions.width, dimensions.height].every(Number.isSafeInteger) ||
    dimensions.width < 1 ||
    dimensions.width > 8400 ||
    dimensions.height < 1 ||
    dimensions.height > 2400 ||
    rect.x + rect.width > dimensions.width ||
    rect.y + rect.height > dimensions.height ||
    source.fullWorld !==
      (rect.x === 0 &&
        rect.y === 0 &&
        rect.width === dimensions.width &&
        rect.height === dimensions.height)
  )
    throw new Error("Invalid prepared-world layout");
  const rowBytes = rect.width * 4,
    band = Buffer.allocUnsafe(rowBytes * Math.min(bandTiles, rect.height));
  const hash = createHash("sha256"),
    memorySamples = [];
  let writer,
    chunks = 0,
    processedCells = 0,
    writtenRows = 0,
    compressionSeconds = 0,
    expectedX = rect.x,
    expectedY = rect.y,
    replayStats = null;
  mkdirSync(dirname(outputPath), { recursive: true });
  const checkBudget = () => {
    checkAbort(signal);
    if (process.resourceUsage().maxRSS * 1024 > 500000000)
      throw new Error("Prepared export exceeded the 500 MB process RSS limit");
    if ((performance.now() - started) / 1000 >= 600)
      throw new Error("Prepared export exceeded 600 seconds");
  };
  try {
    writer = await createPngWriter({
      path: outputPath,
      width: rect.width,
      height: rect.height,
      compressionLevel,
      signal,
    });
    for await (const { core, data, stats } of replayWorldTapeChunks(
      directory,
    )) {
      checkBudget();
      const h = Math.min(bandTiles, rect.y + rect.height - expectedY),
        w = Math.min(chunkTiles, rect.x + rect.width - expectedX);
      if (
        expectedY >= rect.y + rect.height ||
        core.x !== expectedX ||
        core.y !== expectedY ||
        core.width !== w ||
        core.height !== h ||
        data.length !== w * h * 4
      )
        throw new Error(
          "Prepared-world chunks must cover the exact scope once in scanline order",
        );
      for (let y = 0; y < h; y++)
        band.set(
          data.subarray(y * w * 4, (y + 1) * w * 4),
          y * rowBytes + (core.x - rect.x) * 4,
        );
      expectedX += w;
      chunks++;
      processedCells += w * h;
      replayStats = stats;
      if (expectedX === rect.x + rect.width) {
        const rows = band.subarray(0, rowBytes * h);
        hash.update(rows);
        const compressionStarted = performance.now();
        await writer.writeRows(rows, h);
        compressionSeconds += (performance.now() - compressionStarted) / 1000;
        writtenRows += h;
        expectedY += h;
        expectedX = rect.x;
        const memory = sampleProcessMemory();
        memorySamples.push({ writtenRows, ...memory });
        const progress = {
          phase: "replay-world",
          processedCells,
          totalCells: rect.width * rect.height,
          writtenRows,
          totalRows: rect.height,
          chunks,
          elapsedSeconds: (performance.now() - started) / 1000,
          rssMiB: Math.round(memory.rss / 1048576),
          rssSource: memory.rssSource,
        };
        writeFileSync(
          `${outputPath}.progress.json`,
          JSON.stringify(progress, null, 2),
        );
        await onProgress(progress);
        if (global.gc) global.gc();
        await new Promise(setImmediate);
        trimNativeMemory();
      } else if (chunks % 8 === 0) {
        if (global.gc) global.gc({ type: "minor" });
        await new Promise(setImmediate);
      }
    }
    if (
      writtenRows !== rect.height ||
      processedCells !== rect.width * rect.height ||
      expectedX !== rect.x
    )
      throw new Error("Prepared-world tape ended before full coverage");
    const rgbaSha256 = hash.digest("hex");
    if (rgbaSha256 !== source.preparedWorld.rgbaSha256)
      throw new Error(
        "Prepared-world replay pixel hash differs from its exact compilation",
      );
    const png = await writer.finish({ beforePublish: checkBudget });
    const cpu = process.cpuUsage(cpuStarted);
    const result = {
      schema: "exploretv-direct-overview-export-v1",
      executionMode: "prepared-command-replay",
      worldSha256: source.worldSha256,
      worldDimensions: source.worldDimensions,
      worldRect: rect,
      fullWorld: source.fullWorld,
      pixelsPerTile: 1,
      renderPixelsPerTile: 16,
      inputEncoding: source.inputEncoding,
      reduction: source.reduction,
      png,
      processedCells,
      writtenRows,
      chunks,
      bandTiles,
      chunkTiles,
      haloTiles: source.haloTiles,
      sourceHashes: source.sourceHashes,
      assetHashes: source.assetHashes,
      plannedCommands: source.plannedCommands,
      renderedCommands: source.renderedCommands,
      commandCounts: source.commandCounts,
      unsupportedTiles: source.unsupportedTiles,
      sourceHiddenTiles: source.sourceHiddenTiles,
      liquidUnsupported: source.liquidUnsupported,
      missingCommands: source.missingCommands,
      invalidCommands: source.invalidCommands,
      effectFailures: source.effectFailures,
      assetFailures: source.assetFailures,
      waterfalls: source.waterfalls,
      ordinaryBlockIds: source.ordinaryBlockIds,
      storedFrameTileIds: source.storedFrameTileIds,
      logicalEvidence:
        "Coverage/omission counts are retained from this exact source-bound compilation; replay verifies the complete output hash.",
      preparedWorld: {
        directory,
        schema: manifest.schema,
        firstPreparationSeconds: source.preparedWorld.firstPreparationSeconds,
        rgbaSha256,
        verificationSeconds,
        binding,
        reusedWorldSpecificPreparation: true,
        timing:
          "Online runtime includes all current input/source/cache hash verification, native replay, reduction, compression and writes. World-specific compilation is reported separately.",
      },
      replay: replayStats ? { ...replayStats } : null,
      nativeOverview: { ...nativeBlitterStatus },
      nativeReducer: { ...nativeReducerStatus },
      runtimeSeconds: (performance.now() - started) / 1000,
      compressionSeconds,
      osPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      bandBufferBytes: band.length,
      memorySamples,
      memorySampling: getProcessMemorySamplingStatus(),
      environment: {
        node: process.version,
        platform: platform(),
        arch: arch(),
        release: release(),
        availableParallelism: availableParallelism(),
        rendererWorkers: 1,
        processCpuSeconds: (cpu.user + cpu.system) / 1e6,
      },
      limitations: [
        ...source.limitations,
        "This is a prepared-world replay measurement, not first-time rendering of a previously unseen world. Any world, texture, renderer or lockfile change requires a new preparation.",
      ],
    };
    writeFileSync(`${outputPath}.json`, JSON.stringify(result, null, 2));
    writeFileSync(
      `${outputPath}.progress.json`,
      JSON.stringify(
        {
          phase: "done",
          png,
          processedCells,
          writtenRows,
          runtimeSeconds: result.runtimeSeconds,
          rgbaSha256,
        },
        null,
        2,
      ),
    );
    return result;
  } catch (error) {
    if (writer) {
      await writer.abort(error);
      writeFileSync(
        `${outputPath}.progress.json`,
        JSON.stringify(
          {
            phase: "aborted",
            processedCells,
            writtenRows,
            message: error.message,
          },
          null,
          2,
        ),
      );
    }
    throw error;
  }
}

const USAGE = `Usage:
  npm run prepare:world -- <world.wld> <png-directory> <new-cache-directory> [overview options]
  npm run export:prepared -- <world.wld> <png-directory> <cache-directory> <output.png> [--compression-level 0..9]

prepare performs and TIMES the world-specific planning/texture work once, saves
ordered native instructions and unique frames, and also writes preview.png.
replay verifies current world, texture, renderer and cache hashes, then executes
the prepared instructions. It does not copy the first PNG. Exact 1 px/tile only.
Existing output directories/files are refused. Reprepare after an input change.`;

if (isCli) {
  const controller = new AbortController(),
    interrupt = () => controller.abort(new Error("Cancelled by signal"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (args.includes("--help") || mode === "--help") console.log(USAGE);
    else {
      const options = {
        signal: controller.signal,
        onProgress: (p) => console.log(JSON.stringify(p)),
      };
      let result;
      if (mode === "prepare" && args.length >= 3)
        result = await prepareWorld(
          {
            worldPath: args[0],
            assetDir: args[1],
            directory: args[2],
            flags: args.slice(3),
          },
          options,
        );
      else if (
        mode === "replay" &&
        (args.length === 4 ||
          (args.length === 6 &&
            args[4] === "--compression-level" &&
            /^[0-9]$/.test(args[5])))
      )
        result = await exportPreparedWorld(
          {
            worldPath: args[0],
            assetDir: args[1],
            directory: args[2],
            outputPath: args[3],
            compressionLevel: args[5] === undefined ? 6 : Number(args[5]),
          },
          options,
        );
      else throw new Error(USAGE);
      console.log(
        JSON.stringify({
          phase: "done",
          mode,
          runtimeSeconds: result.runtimeSeconds,
          directory: result.directory,
          png: result.png ?? result.preview,
          osPeakRssBytes: result.osPeakRssBytes,
        }),
      );
    }
  } catch (error) {
    console.error("prepared-world: " + error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
