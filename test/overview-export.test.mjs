import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { createCanvas } from "@napi-rs/canvas";
import { fixtureWorld, record } from "./fixture.mjs";
import { parseExportCli, exportWorld } from "../scripts/export-world.mjs";
import {
  parseOverviewCli,
  exportOverview,
} from "../scripts/export-overview.mjs";
import { boxDownsampleRgba } from "../scripts/downsample-rgba.mjs";
import { nativeBlitterStatus } from "../scripts/native-blitter.mjs";

function writeTexture(assetDir, name, width, height, pixel) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      png.data.set(pixel(x, y), (y * width + x) * 4);
  writeFileSync(join(assetDir, name), PNG.sync.write(png));
}

function setup(t, { width = 131, height = 35, cell } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "exploretv-overview-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worldPath = join(dir, "source.wld"),
    assetDir = join(dir, "assets");
  mkdirSync(assetDir);
  const columns = Array.from({ length: width }, (_, x) =>
    Array.from({ length: height }, (_, y) =>
      record(
        cell
          ? cell(x, y)
          : {
              type: y >= 10 && y <= 20 ? null : (x + y) % 7 === 0 ? 0 : 1,
              wall: 1,
              liquid: y >= 13 && y <= 18 ? 255 : 0,
              shape: y < 8 && (x + y) % 11 === 0 ? 2 : 0,
              paint: y < 8 && x % 13 === 0 ? 2 : 0,
              wallPaint: x % 17 === 0 ? 3 : 0,
            },
      ),
    ),
  );
  const source = fixtureWorld({ width, height, columns }).bytes;
  writeFileSync(worldPath, source);
  for (const [name, w, h, seed] of [
    ["Tiles_1.png", 288, 270, 1],
    ["Tiles_0.png", 288, 270, 17],
    ["Wall_1.png", 468, 180, 31],
    ["water_0.png", 48, 1328, 47],
  ])
    writeTexture(assetDir, name, w, h, (x, y) => [
      (x * 7 + seed) % 256,
      (y * 5 + seed) % 256,
      (x + y + seed) % 256,
      255,
    ]);
  return { dir, worldPath, assetDir, width, height, source };
}

function overviewConfig(fixture, name = "overview.png", flags = []) {
  return parseOverviewCli([
    fixture.worldPath,
    fixture.assetDir,
    join(fixture.dir, name),
    ...flags,
  ]);
}

async function fullExport(fixture, name = "full.png", flags = []) {
  const config = parseExportCli([
    fixture.worldPath,
    fixture.assetDir,
    join(fixture.dir, name),
    "--chunk-tiles",
    "252",
    "--band-tiles",
    "32",
    ...flags,
  ]);
  await exportWorld(config);
  return PNG.sync.read(readFileSync(config.outputPath));
}

// Deliberately independent of boxDownsampleRgba and Canvas resizing. Compute
// coverage and associated color directly from the decoded full PNG bytes.
function referenceReduction(image, pixelsPerTile, rect = null) {
  const factor = 16 / pixelsPerTile,
    sx = rect ? rect.x * 16 : 0,
    sy = rect ? rect.y * 16 : 0,
    width = rect ? rect.width * pixelsPerTile : image.width / factor,
    height = rect ? rect.height * pixelsPerTile : image.height / factor,
    result = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0, 0];
      for (let dy = 0; dy < factor; dy++)
        for (let dx = 0; dx < factor; dx++) {
          const i =
            ((sy + y * factor + dy) * image.width + sx + x * factor + dx) * 4;
          const alpha = image.data[i + 3];
          for (let c = 0; c < 3; c++) sum[c] += image.data[i + c] * alpha;
          sum[3] += alpha;
        }
      const out = (y * width + x) * 4;
      for (let c = 0; c < 3; c++)
        result[out + c] = sum[3] ? Math.round(sum[c] / sum[3]) : 0;
      result[out + 3] = Math.round(sum[3] / (factor * factor));
    }
  return result;
}

function pixel(image, x, y) {
  return [
    ...image.data.subarray(
      (y * image.width + x) * 4,
      (y * image.width + x + 1) * 4,
    ),
  ];
}

function assertNear(actual, expected, tolerance = 2) {
  actual.forEach((value, i) =>
    assert.ok(
      Math.abs(value - expected[i]) <= tolerance,
      `channel ${i}: ${actual} differs from ${expected}`,
    ),
  );
}

test("direct overview equals independently reduced full PNG at every scale across odd chunk and band seams", async (t) => {
  const fixture = setup(t),
    full = await fullExport(fixture);
  for (const [pixelsPerTile, chunkTiles, bandTiles] of [
    [1, 128, 32],
    [2, 17, 7],
    [4, 63, 16],
    [8, 32, 13],
  ]) {
    const config = overviewConfig(fixture, `overview-${pixelsPerTile}.png`, [
      "--pixels-per-tile",
      String(pixelsPerTile),
      "--chunk-tiles",
      String(chunkTiles),
      "--band-tiles",
      String(bandTiles),
    ]);
    const progress = [];
    const result = await exportOverview(config, {
      onProgress: (update) => progress.push({ ...update }),
    });
    const output = PNG.sync.read(readFileSync(config.outputPath));
    assert.equal(output.width, fixture.width * pixelsPerTile);
    assert.equal(output.height, fixture.height * pixelsPerTile);
    assert.deepEqual(output.data, referenceReduction(full, pixelsPerTile));
    assert.equal(result.pixelsPerTile, pixelsPerTile);
    assert.equal(result.processedCells, fixture.width * fixture.height);
    assert.equal(result.writtenRows, output.height);
    assert.equal(result.png.rows, output.height);
    assert.equal(result.png.width, output.width);
    assert.equal(result.png.height, output.height);
    assert.equal(result.fullWorld, true);
    assert.deepEqual(result.worldRect, {
      x: 0,
      y: 0,
      width: fixture.width,
      height: fixture.height,
    });
    assert.equal(
      result.chunks,
      Math.ceil(fixture.width / chunkTiles) *
        Math.ceil(fixture.height / bandTiles),
    );
    assert.deepEqual(result.missingCommands, {});
    assert.deepEqual(result.invalidCommands, {});
    assert.deepEqual(result.effectFailures, {});
    assert.equal(
      result.bandBufferBytes,
      output.width * Math.min(bandTiles, fixture.height) * pixelsPerTile * 4,
    );
    assert.equal(result.rawRgbaBytes, output.width * output.height * 4);
    assert.equal(progress.length, Math.ceil(fixture.height / bandTiles));
    progress.forEach((update, i) => {
      const tileRows = Math.min((i + 1) * bandTiles, fixture.height);
      assert.equal(update.writtenRows, tileRows * pixelsPerTile);
      assert.equal(update.totalRows, output.height);
      assert.equal(update.processedCells, fixture.width * tileRows);
    });
    const report = JSON.parse(
      readFileSync(`${config.outputPath}.json`, "utf8"),
    );
    assert.equal(report.pixelsPerTile, pixelsPerTile);
    assert.equal(report.png.sha256, result.png.sha256);
    assert.equal(
      JSON.parse(readFileSync(`${config.outputPath}.progress.json`, "utf8"))
        .phase,
      "done",
    );
    assert.equal(existsSync(`${config.outputPath}.partial`), false);
  }
  assert.deepEqual(
    readdirSync(fixture.dir)
      .filter((name) => name.endsWith(".png"))
      .sort(),
    [
      "full.png",
      "overview-1.png",
      "overview-2.png",
      "overview-4.png",
      "overview-8.png",
    ],
  );
});

test("region export retains world-aligned edges and exact full-extent regions are marked fullWorld", async (t) => {
  const fixture = setup(t, { width: 19, height: 13 }),
    full = await fullExport(fixture),
    region = { x: 3, y: 5, width: 13, height: 7 };
  for (const [name, rect, chunkTiles, bandTiles] of [
    ["region.png", region, 5, 3],
    ["region-alternate.png", region, 8, 2],
    ["exact-world.png", { x: 0, y: 0, width: 19, height: 13 }, 6, 5],
  ]) {
    const config = overviewConfig(fixture, name, [
      "--pixels-per-tile",
      "2",
      "--region",
      `${rect.x},${rect.y},${rect.width},${rect.height}`,
      "--chunk-tiles",
      String(chunkTiles),
      "--band-tiles",
      String(bandTiles),
    ]);
    const report = await exportOverview(config),
      output = PNG.sync.read(readFileSync(config.outputPath));
    assert.equal(output.width, rect.width * 2);
    assert.equal(output.height, rect.height * 2);
    assert.deepEqual(output.data, referenceReduction(full, 2, rect));
    assert.deepEqual(report.worldRect, rect);
    assert.equal(report.fullWorld, name === "exact-world.png");
  }
  const outside = overviewConfig(fixture, "outside.png", [
    "--region",
    "1,0,19,13",
  ]);
  await assert.rejects(exportOverview(outside), /outside world/i);
  assert.equal(existsSync(outside.outputPath), false);
  assert.equal(existsSync(`${outside.outputPath}.partial`), false);
});

test("box reduction averages premultiplied coverage before unpremultiplying and rounds only the result", () => {
  const source = Buffer.from([
    255, 0, 0, 255, 0, 255, 255, 0, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 64,
    0, 0, 255, 128, 128, 0, 0, 255, 64, 0, 0, 255,
  ]);
  const unchanged = Buffer.from(source);
  const output = boxDownsampleRgba(source, 4, 2, 2);
  assert.ok(Buffer.isBuffer(output));
  assert.deepEqual([...output], [145, 37, 73, 112, 112, 0, 0, 255]);
  assert.deepEqual(source, unchanged);
  assert.deepEqual(
    [
      ...boxDownsampleRgba(
        Buffer.from([255, 1, 2, 0, 3, 255, 4, 0, 5, 6, 255, 0, 7, 8, 9, 0]),
        2,
        2,
        2,
      ),
    ],
    [0, 0, 0, 0],
  );
  // A byte view must not accidentally include its surrounding backing buffer.
  const padded = Buffer.concat([
    Buffer.alloc(12, 255),
    source,
    Buffer.alloc(8, 255),
  ]);
  assert.deepEqual(
    boxDownsampleRgba(padded.subarray(12, 12 + source.length), 4, 2, 2),
    output,
  );
});

test("box reduction preserves one-pixel light and alpha coverage instead of point sampling", () => {
  const opaque = Buffer.alloc(16 * 16 * 4);
  for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
  opaque.set([255, 255, 255, 255], (7 * 16 + 3) * 4);
  assert.deepEqual([...boxDownsampleRgba(opaque, 16, 16, 16)], [1, 1, 1, 255]);
  const transparent = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < transparent.length; i += 4)
    transparent.set([0, 255, 0, 0], i);
  transparent.set([255, 0, 0, 255], (7 * 16 + 3) * 4);
  assert.deepEqual(
    [...boxDownsampleRgba(transparent, 16, 16, 16)],
    [255, 0, 0, 1],
  );
});

test("direct one-pixel-per-tile export retains thin texture lines across chunk and band boundaries", async (t) => {
  const fixture = setup(t, { width: 7, height: 5, cell: () => ({ type: 1 }) });
  writeTexture(fixture.assetDir, "Tiles_1.png", 288, 270, (x) =>
    x % 18 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255],
  );
  const config = overviewConfig(fixture, "thin.png", [
    "--chunk-tiles",
    "3",
    "--band-tiles",
    "2",
  ]);
  await exportOverview(config);
  const output = PNG.sync.read(readFileSync(config.outputPath));
  assert.equal(output.width, 7);
  assert.equal(output.height, 5);
  for (let y = 0; y < output.height; y++)
    for (let x = 0; x < output.width; x++)
      assert.deepEqual(pixel(output, x, y), [16, 16, 16, 255]);
});

test("overview preserves raw tconvert source-over and zero-alpha additive channels, and standard-straight remains distinct", async (t) => {
  const fixture = setup(t, {
    width: 5,
    height: 3,
    cell: (x) => ({ type: x % 2 ? 0 : 1, wall: 1 }),
  });
  writeTexture(fixture.assetDir, "Wall_1.png", 468, 180, () => [
    10, 40, 90, 255,
  ]);
  writeTexture(fixture.assetDir, "Tiles_1.png", 288, 270, () => [
    80, 40, 20, 128,
  ]);
  writeTexture(fixture.assetDir, "Tiles_0.png", 288, 270, () => [
    80, 40, 20, 0,
  ]);
  const outputs = new Map();
  for (const encoding of ["tconvert-game-raw", "standard-straight"]) {
    const flags = ["--input-encoding", encoding],
      full = await fullExport(fixture, `${encoding}-full.png`, flags),
      config = overviewConfig(fixture, `${encoding}.png`, [
        ...flags,
        "--chunk-tiles",
        "2",
        "--band-tiles",
        "2",
      ]);
    const result = await exportOverview(config),
      output = PNG.sync.read(readFileSync(config.outputPath));
    assert.equal(result.inputEncoding, encoding);
    assert.deepEqual(result.effectFailures, {});
    assert.deepEqual(output.data, referenceReduction(full, 1));
    outputs.set(encoding, output);
  }
  const raw = outputs.get("tconvert-game-raw"),
    straight = outputs.get("standard-straight");
  assertNear(pixel(raw, 2, 1), [85, 60, 65, 255]);
  assertNear(pixel(straight, 2, 1), [45, 40, 55, 255]);
  assertNear(pixel(raw, 1, 1), [90, 80, 110, 255]);
  assertNear(pixel(straight, 1, 1), [10, 40, 90, 255]);
  assert.notDeepEqual(raw.data, straight.data);
});

test("overview CLI accepts bounded defaults and supported flags but refuses invalid scales and full-export-only flags", () => {
  assert.deepEqual(parseOverviewCli(["--help"]), { help: true });
  const defaults = parseOverviewCli(["w", "a", "out"]);
  assert.equal(defaults.pixelsPerTile, 1);
  assert.equal(defaults.bandTiles, 48);
  assert.equal(defaults.chunkTiles, 128);
  assert.equal(defaults.compressionLevel, 6);
  assert.equal(defaults.inputEncoding, "tconvert-game-raw");
  for (const scale of [1, 2, 4, 8]) {
    const scaled = parseOverviewCli([
      "w",
      "a",
      "out",
      "--pixels-per-tile",
      String(scale),
    ]);
    assert.equal(scaled.pixelsPerTile, scale);
    assert.equal(scaled.bandTiles, 48);
    assert.equal(scaled.chunkTiles, scale === 1 ? 128 : 120);
    const overridden = parseOverviewCli([
      "w",
      "a",
      "out",
      "--pixels-per-tile",
      String(scale),
      "--band-tiles",
      "17",
      "--chunk-tiles",
      "51",
    ]);
    assert.equal(overridden.bandTiles, 17);
    assert.equal(overridden.chunkTiles, 51);
  }
  const configured = parseOverviewCli([
    "--pixels-per-tile",
    "4",
    "w",
    "a",
    "out",
    "--region",
    "2,3,5,7",
    "--band-tiles",
    "1",
    "--chunk-tiles",
    "252",
    "--compression-level",
    "0",
    "--input-encoding",
    "standard-straight",
    "--expect-world-sha256",
    "A".repeat(64),
  ]);
  assert.deepEqual(configured.region, { x: 2, y: 3, width: 5, height: 7 });
  assert.equal(configured.expectedWorldSha256, "a".repeat(64));
  for (const args of [
    [],
    ["w", "a"],
    ["w", "a", "out", "extra"],
    ...["0", "3", "16", "-1", "1.5", "2x", "Infinity", "NaN"].map((scale) => [
      "w",
      "a",
      "out",
      "--pixels-per-tile",
      scale,
    ]),
    ...[
      ["--workers"],
      ["--workers", "0"],
      ["--workers", "5"],
      ["--workers", "2x"],
      ["--pixels-per-tile"],
      ["--pixels-per-tile", "--region", "0,0,1,1"],
      ["--band-tiles", "0"],
      ["--band-tiles", "129"],
      ["--chunk-tiles", "0"],
      ["--chunk-tiles", "253"],
      ["--region", "0,0,0,2"],
      ["--region", "-1,0,1,1"],
      ["--region", "0,0,1.5,2"],
      ["--expect-world-sha256", "bad"],
      ["--compression-level", "10"],
      ["--input-encoding", "unknown"],
      ["--tiles", "pieces"],
      ["--unknown", "yes"],
    ].map((flags) => ["w", "a", "out", ...flags]),
  ])
    assert.throws(
      () => parseOverviewCli(args),
      `must reject ${JSON.stringify(args)}`,
    );
});

test("cancelled overview removes its partial PNG, records reduced-row progress and can retry", async (t) => {
  const fixture = setup(t, { width: 7, height: 5 }),
    config = overviewConfig(fixture, "cancelled.png", [
      "--pixels-per-tile",
      "2",
      "--chunk-tiles",
      "3",
      "--band-tiles",
      "2",
    ]),
    controller = new AbortController();
  await assert.rejects(
    exportOverview(config, {
      signal: controller.signal,
      onProgress: () =>
        controller.abort(new Error("test overview cancellation")),
    }),
    /test overview cancellation/,
  );
  assert.equal(existsSync(config.outputPath), false);
  assert.equal(existsSync(`${config.outputPath}.json`), false);
  assert.ok(
    readdirSync(fixture.dir).every((name) => !name.includes(".partial")),
  );
  const progress = JSON.parse(
    readFileSync(`${config.outputPath}.progress.json`, "utf8"),
  );
  assert.equal(progress.phase, "aborted");
  assert.equal(progress.writtenRows, 4);
  assert.equal(progress.processedCells, 14);
  const result = await exportOverview(config);
  assert.equal(result.png.width, 14);
  assert.equal(result.png.height, 10);
  assert.equal(result.png.rows, 10);
});

test("pre-abort, hash mismatch and invalid programmatic scale create no output state", async (t) => {
  const fixture = setup(t, { width: 2, height: 2 }),
    config = overviewConfig(fixture),
    controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  await assert.rejects(
    exportOverview(config, { signal: controller.signal }),
    /already cancelled/,
  );
  const hash = createHash("sha256").update(fixture.source).digest("hex"),
    mismatch = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
  await assert.rejects(
    exportOverview({ ...config, expectedWorldSha256: mismatch }),
    /SHA-256 mismatch/,
  );
  await assert.rejects(exportOverview({ ...config, pixelsPerTile: 16 }));
  assert.deepEqual(readdirSync(fixture.dir).sort(), ["assets", "source.wld"]);
});

test("overview refuses existing output and partial files without changing their data or sidecars", async (t) => {
  const fixture = setup(t, { width: 2, height: 2 });
  for (const existing of ["output", "partial"]) {
    const config = overviewConfig(fixture, `${existing}.png`),
      owned =
        existing === "output"
          ? config.outputPath
          : `${config.outputPath}.partial`;
    writeFileSync(owned, `previous ${existing} bytes`);
    writeFileSync(
      `${config.outputPath}.progress.json`,
      '{"phase":"export","writtenRows":1}',
    );
    writeFileSync(`${config.outputPath}.json`, '{"previous":true}');
    await assert.rejects(
      exportOverview(config),
      existing === "output" ? /already exists/i : /EEXIST/,
    );
    assert.equal(readFileSync(owned, "utf8"), `previous ${existing} bytes`);
    assert.equal(
      readFileSync(`${config.outputPath}.progress.json`, "utf8"),
      '{"phase":"export","writtenRows":1}',
    );
    assert.equal(
      readFileSync(`${config.outputPath}.json`, "utf8"),
      '{"previous":true}',
    );
    if (existing === "partial")
      assert.equal(existsSync(config.outputPath), false);
  }
});

test("overview does not overwrite an output created while it is streaming", async (t) => {
  const fixture = setup(t, { width: 3, height: 3 }),
    config = overviewConfig(fixture, "race.png", ["--band-tiles", "2"]);
  let created = false;
  await assert.rejects(
    exportOverview(config, {
      onProgress: () => {
        if (created) return;
        created = true;
        writeFileSync(config.outputPath, "another writer owns this output");
      },
    }),
    /appeared during export|EEXIST/,
  );
  assert.equal(
    readFileSync(config.outputPath, "utf8"),
    "another writer owns this output",
  );
  assert.equal(existsSync(`${config.outputPath}.partial`), false);
  assert.equal(existsSync(`${config.outputPath}.json`), false);
});

test("overview verifier rejects forged world scope and every recorded source or texture hash", async (t) => {
  const fixture = setup(t, { width: 3, height: 3 }),
    config = overviewConfig(fixture, "verified.png", ["--region", "1,1,2,2"]);
  const report = await exportOverview(config),
    reportPath = `${config.outputPath}.json`,
    originalReport = readFileSync(reportPath),
    verifierPath = fileURLToPath(
      new URL("../scripts/verify-overview.mjs", import.meta.url),
    );
  const invoke = () => {
    const run = spawnSync(
      process.execPath,
      [verifierPath, fixture.worldPath, fixture.assetDir, config.outputPath],
      {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    assert.ifError(run.error);
    assert.equal(run.signal, null, `verifier terminated: ${run.signal}`);
    return run;
  };
  const verifyGenuine = () => {
    const run = invoke();
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, "passed");
    assert.deepEqual(result.worldRect, { x: 1, y: 1, width: 2, height: 2 });
    assert.equal(
      result.verifiedSourceFiles,
      Object.keys(report.sourceHashes).length,
    );
    assert.equal(
      result.verifiedTextures,
      Object.keys(report.assetHashes).length,
    );
    assert.ok(result.patches.every((patch) => patch.differentBytes === 0));
  };
  assert.equal(report.fullWorld, false);
  verifyGenuine();
  const fakeHash = (hash) => (hash[0] === "0" ? "1" : "0") + hash.slice(1),
    usedAsset = Object.keys(report.assetHashes)[0];
  assert.ok(usedAsset, "the synthetic export must exercise texture provenance");
  assert.ok(report.sourceHashes["core/paint.mjs"]);
  assert.equal(report.assetHashes["water_0.png"], undefined);
  for (const [name, mutate, error] of [
    [
      "cropped report claiming fullWorld",
      (value) => {
        value.fullWorld = true;
      },
      /AssertionError/,
    ],
    [
      "forged world dimensions",
      (value) => {
        value.worldDimensions.width += 1;
      },
      /AssertionError/,
    ],
    [
      "rectangle outside the actual world",
      (value) => {
        value.worldRect.x += 1;
      },
      /AssertionError/,
    ],
    [
      "required exporter source hash",
      (value) => {
        value.sourceHashes["scripts/export-overview.mjs"] = fakeHash(
          value.sourceHashes["scripts/export-overview.mjs"],
        );
      },
      /Source provenance: scripts\/export-overview\.mjs/,
    ],
    // A non-required source entry must be checked too, not merely the names
    // on the verifier's minimum-provenance allowlist.
    [
      "other recorded source hash",
      (value) => {
        value.sourceHashes["core/paint.mjs"] = fakeHash(
          value.sourceHashes["core/paint.mjs"],
        );
      },
      /Source provenance: core\/paint\.mjs/,
    ],
    [
      "native compositor source hash",
      (value) => {
        value.sourceHashes["scripts/native-blitter.c"] = fakeHash(
          value.sourceHashes["scripts/native-blitter.c"],
        );
      },
      /Source provenance: scripts\/native-blitter\.c/,
    ],
    [
      "rendered texture hash",
      (value) => {
        value.assetHashes[usedAsset] = fakeHash(value.assetHashes[usedAsset]);
      },
      /Texture provenance:/,
    ],
    // This fixture contains no water. An existing but unused recorded asset
    // must still be validated, even when no sampled patch requests it.
    [
      "unsampled recorded texture hash",
      (value) => {
        value.assetHashes["water_0.png"] = "0".repeat(64);
      },
      /Texture provenance: water_0\.png/,
    ],
  ]) {
    const forged = JSON.parse(originalReport);
    mutate(forged);
    try {
      writeFileSync(reportPath, JSON.stringify(forged));
      const run = invoke();
      assert.notEqual(
        run.status,
        0,
        `${name} was incorrectly accepted: ${run.stdout}`,
      );
      assert.match(
        run.stderr,
        error,
        `${name} failed for an unexpected reason`,
      );
    } finally {
      writeFileSync(reportPath, originalReport);
    }
  }
  verifyGenuine();
});

test("blank overview cores skip native readback at every supported scale", async (t) => {
  const fixture = setup(t, {
    width: 29,
    height: 23,
    cell: () => ({ type: null }),
  });
  for (const pixelsPerTile of [1, 2, 4, 8]) {
    const config = overviewConfig(fixture, `blank-${pixelsPerTile}.png`, [
      "--pixels-per-tile",
      String(pixelsPerTile),
      "--chunk-tiles",
      "11",
      "--band-tiles",
      "7",
    ]);
    const report = await exportOverview(config);
    assert.equal(report.skippedReadbackChunks, report.chunks);
    const image = PNG.sync.read(readFileSync(config.outputPath));
    assert.equal(image.width, fixture.width * pixelsPerTile);
    assert.equal(image.height, fixture.height * pixelsPerTile);
    for (let i = 0; i < image.data.length; i += 4)
      assert.deepEqual(
        Array.from(image.data.subarray(i, i + 4)),
        [0, 0, 0, 255],
      );
  }
});

test(
  "overview major GC follows actual native or Canvas chunks and yields after collection",
  { skip: !nativeBlitterStatus.available && nativeBlitterStatus.reason },
  async (t) => {
    const fixture = setup(t, {
      width: 18,
      height: 4,
      cell: () => ({ type: 1 }),
    });
    const previousGc = Object.getOwnPropertyDescriptor(globalThis, "gc"),
      calls = [],
      events = [];
    let pendingFinalizer = false;
    Object.defineProperty(globalThis, "gc", {
      configurable: true,
      writable: true,
      value(options) {
        assert.equal(
          pendingFinalizer,
          false,
          "the preceding collection must have reached its finalizer macrotask",
        );
        const id = events.length;
        calls.push(options?.type ?? "band-or-setup");
        events.push(["collect", id]);
        pendingFinalizer = true;
        setImmediate(() => {
          pendingFinalizer = false;
          events.push(["finalize", id]);
        });
      },
    });
    t.after(() => {
      if (previousGc) Object.defineProperty(globalThis, "gc", previousGc);
      else delete globalThis.gc;
    });
    for (const [scale, inputEncoding] of [
      [1, "tconvert-game-raw"],
      [2, "tconvert-game-raw"],
      [4, "tconvert-game-raw"],
      [8, "tconvert-game-raw"],
      [1, "standard-straight"],
    ]) {
      calls.length = events.length = 0;
      const config = overviewConfig(
        fixture,
        `gc-${scale}-${inputEncoding}.png`,
        [
          "--pixels-per-tile",
          String(scale),
          "--input-encoding",
          inputEncoding,
          "--chunk-tiles",
          "2",
          "--band-tiles",
          "2",
        ],
      );
      const report = await exportOverview(config),
        native = scale === 1 && inputEncoding === "tconvert-game-raw",
        perBand = native
          ? [
              "minor",
              "minor",
              "minor",
              "major",
              "minor",
              "minor",
              "minor",
              "major",
              "minor",
            ]
          : [
              "minor",
              "major",
              "minor",
              "major",
              "minor",
              "major",
              "minor",
              "major",
              "minor",
            ],
        chunkCalls = calls.filter((type) => type !== "band-or-setup");
      assert.deepEqual(chunkCalls, [...perBand, ...perBand]);
      assert.equal(report.chunks, 18);
      assert.equal(report.majorGcInterval, native ? 4 : 2);
      assert.equal(report.overviewGc.nativeOverviewChunks, native ? 18 : 0);
      assert.equal(report.overviewGc.canvasChunks, native ? 0 : 18);
      assert.equal(report.overviewGc.chunkMajorCollections, native ? 4 : 8);
      assert.equal(report.overviewGc.chunkMinorCollections, native ? 14 : 10);
      assert.equal(report.overviewGc.bandMajorCollections, 2);
      // Native availability alone used to select the larger interval for 2/4/8.
      if (inputEncoding === "tconvert-game-raw")
        assert.equal(report.nativeOverview.available, true);
      assert.equal(pendingFinalizer, false);
      assert.equal(events.length, calls.length * 2);
      for (let i = 0; i < events.length; i += 2) {
        assert.equal(events[i][0], "collect");
        assert.deepEqual(events[i + 1], ["finalize", events[i][1]]);
      }
    }
  },
);

test("overview readback and reduction timing includes full Canvas readback for every fallback", async (t) => {
  const fixture = setup(t, {
    width: 12,
    height: 2,
    cell: () => ({ type: 1 }),
  });
  // A translucent frame cannot use the final-opaque-mean shortcut, so the 1px
  // straight-alpha case also exercises a real full-core Canvas readback.
  writeTexture(fixture.assetDir, "Tiles_1.png", 288, 270, (x, y) => [
    x % 128,
    y % 128,
    (x + y) % 128,
    128,
  ]);
  const probe = createCanvas(1, 1),
    prototype = Object.getPrototypeOf(probe.getContext("2d")),
    readImageData = prototype.getImageData;
  let clock = 0,
    coreReadbacks = 0;
  t.mock.method(performance, "now", () => clock);
  t.mock.method(prototype, "getImageData", function (...args) {
    const result = readImageData.apply(this, args);
    // Prepared frames are at most 64 pixels wide. Only the 96x32 destination
    // core contributes this controlled elapsed time; no busy-wait is needed.
    if (this.canvas.width === 96 && this.canvas.height === 32) {
      clock += 125;
      coreReadbacks++;
    }
    return result;
  });
  for (const [scale, inputEncoding] of [
    [2, "tconvert-game-raw"],
    [4, "tconvert-game-raw"],
    [8, "tconvert-game-raw"],
    [1, "standard-straight"],
  ]) {
    clock = coreReadbacks = 0;
    const report = await exportOverview(
      overviewConfig(fixture, `readback-${scale}-${inputEncoding}.png`, [
        "--pixels-per-tile",
        String(scale),
        "--input-encoding",
        inputEncoding,
        "--chunk-tiles",
        "6",
        "--band-tiles",
        "2",
      ]),
    );
    assert.equal(coreReadbacks, 2);
    assert.equal(report.readbackAndReductionSeconds, 0.25);
    assert.equal(report.downsampleSeconds, report.readbackAndReductionSeconds);
    assert.equal(report.renderSeconds, 0.25);
    assert.match(report.readbackAndReductionMeaning, /compatibility alias/);
    assert.match(
      report.readbackAndReductionMeaning,
      /older reports.*not phase-comparable/,
    );
  }
});
