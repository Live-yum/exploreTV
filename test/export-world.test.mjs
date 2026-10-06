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
import { PNG } from "pngjs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { fixtureWorld, record } from "./fixture.mjs";
import {
  openWorld,
  extractRegion,
  decodeRecord,
  Reader,
} from "../core/world.mjs";
import { planScene, renderScene } from "../core/renderer.mjs";
import { decodePngRgba } from "../core/png-rgba.mjs";
import { registerTextureSource } from "../core/assets.mjs";
import { prepareSceneFrames } from "../core/scene-frames.mjs";
import { parseExportCli, exportWorld } from "../scripts/export-world.mjs";
import {
  verifyExport,
  verifyExportPng,
  verifyExportTiles,
} from "../scripts/verify-export.mjs";
import {
  buildRowIndex,
  readIndexedRegion,
  readIndexedTile,
} from "../scripts/world-render-engine.mjs";

function setup(t, width = 131, height = 35) {
  const dir = mkdtempSync(join(tmpdir(), "exploretv-export-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worldPath = join(dir, "source.wld"),
    assetDir = join(dir, "assets"),
    outputPath = join(dir, "world.png");
  mkdirSync(assetDir);
  const columns = Array.from({ length: width }, (_, x) =>
    Array.from({ length: height }, (_, y) =>
      record({
        type: y >= 10 && y <= 20 ? null : (x + y) % 7 === 0 ? 0 : 1,
        wall: 1,
        liquid: y >= 13 && y <= 18 ? 255 : 0,
        shape: y < 8 && (x + y) % 11 === 0 ? 2 : 0,
        paint: y < 8 && x % 13 === 0 ? 2 : 0,
        wallPaint: x % 17 === 0 ? 3 : 0,
      }),
    ),
  );
  const source = fixtureWorld({ width, height, columns }).bytes;
  writeFileSync(worldPath, source);
  for (const [name, w, h, seed] of [
    ["Tiles_1.png", 288, 270, 1],
    ["Tiles_0.png", 288, 270, 17],
    ["Wall_1.png", 468, 180, 31],
    ["water_0.png", 48, 1328, 47],
  ]) {
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        png.data.set(
          [
            (x * 7 + seed) % 256,
            (y * 5 + seed) % 256,
            (x + y + seed) % 256,
            255,
          ],
          i,
        );
      }
    writeFileSync(join(assetDir, name), PNG.sync.write(png));
  }
  const config = parseExportCli([
    worldPath,
    assetDir,
    outputPath,
    "--chunk-tiles",
    "32",
    "--band-tiles",
    "16",
  ]);
  return { dir, source, config, width, height };
}

test("streamed export matches independent whole-region renderer through odd tile and band edges", async (t) => {
  const { dir, source, config, width, height } = setup(t);
  config.tilesPath = join(dir, "pieces");
  const result = await exportWorld(config);
  const output = PNG.sync.read(readFileSync(config.outputPath));
  assert.equal(output.width, width * 16);
  assert.equal(output.height, height * 16);
  assert.equal(result.writtenRows, height * 16);
  assert.equal(result.processedCells, width * height);
  assert.equal(result.chunks, 15);
  assert.deepEqual(result.missingCommands, {});
  assert.deepEqual(result.invalidCommands, {});
  assert.deepEqual(result.effectFailures, {});
  const world = openWorld(source),
    region = extractRegion(world, { x: 0, y: 0, width, height }),
    plan = planScene(region, {
      paintEnabled: true,
      liquids: {
        enabled: true,
        frame: 0,
        waterfallFrame: 0,
        waterStyle: 0,
        layer: "foreground",
      },
    }),
    assets = new Map();
  for (const name of plan.requiredAssets) {
    const bytes = readFileSync(join(config.assetDir, name));
    assets.set(
      name,
      registerTextureSource(await loadImage(bytes), {
        pngBytes: bytes,
        rawRgba: decodePngRgba(bytes),
      }),
    );
  }
  const canvas = createCanvas(width * 16, height * 16),
    frames = prepareSceneFrames(plan, assets, createCanvas, {
      inputEncoding: "tconvert-game-raw",
      opaqueScene: true,
    });
  const rendered = renderScene(canvas.getContext("2d"), plan, assets, {
    strict: true,
    sceneFrames: frames,
  });
  assert.equal(rendered.skippedEffects, 0);
  const expected = canvas
    .getContext("2d")
    .getImageData(0, 0, canvas.width, canvas.height).data;
  assert.deepEqual(
    output.data,
    Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength),
  );
  frames.dispose();
  const manifest = JSON.parse(
      readFileSync(join(config.tilesPath, "manifest.json")),
    ),
    assembled = Buffer.alloc(output.data.length),
    coverage = new Uint8Array(width * height);
  for (const tile of manifest.tiles) {
    const image = PNG.sync.read(
      readFileSync(join(config.tilesPath, tile.file)),
    );
    assert.equal(image.width, tile.width);
    assert.equal(image.height, tile.height);
    for (let y = 0; y < tile.height; y++)
      image.data.copy(
        assembled,
        ((tile.y + y) * output.width + tile.x) * 4,
        y * tile.width * 4,
        (y + 1) * tile.width * 4,
      );
    for (
      let y = tile.worldRect.y;
      y < tile.worldRect.y + tile.worldRect.height;
      y++
    )
      for (
        let x = tile.worldRect.x;
        x < tile.worldRect.x + tile.worldRect.width;
        x++
      )
        coverage[y * width + x]++;
  }
  assert.ok(coverage.every((value) => value === 1));
  assert.deepEqual(assembled, output.data);
  const verification = await verifyExport(config.outputPath, {
    tilesPath: config.tilesPath,
  });
  assert.equal(verification.status, "passed");
  assert.equal(verification.exportReportMatched, true);
  assert.equal(verification.tiles.tiles, manifest.tiles.length);
  assert.equal(verification.png.rows, height * 16);
  const corruptPath = join(dir, "corrupt.png"),
    corrupt = readFileSync(config.outputPath);
  corrupt[41] ^= 1;
  writeFileSync(corruptPath, corrupt);
  await assert.rejects(verifyExportPng(corruptPath), /CRC/);
  const originalManifest = readFileSync(
    join(config.tilesPath, "manifest.json"),
  );
  manifest.tiles[0].x += 16;
  writeFileSync(
    join(config.tilesPath, "manifest.json"),
    JSON.stringify(manifest),
  );
  await assert.rejects(verifyExportTiles(config.tilesPath));
  writeFileSync(join(config.tilesPath, "manifest.json"), originalManifest);
});

test("RLE row index handles records crossing multiple checkpoint boundaries", () => {
  const world = openWorld(
    fixtureWorld({
      width: 3,
      height: 67,
      columns: [
        [record({ type: 1, repeats: 66 })],
        [record({ type: 0, repeats: 16 }), record({ type: 1, repeats: 49 })],
        [record({ type: 1, repeats: 32 }), record({ type: 0, repeats: 33 })],
      ],
    }).bytes,
  );
  const index = buildRowIndex(world);
  for (const rect of [
    { x: 0, y: 0, width: 3, height: 1 },
    { x: 0, y: 15, width: 3, height: 20 },
    { x: 1, y: 31, width: 2, height: 36 },
  ])
    assert.deepEqual(
      readIndexedRegion(world, index, rect).cells,
      extractRegion(world, rect).cells,
    );
});

test("small export preserves 16px detail, and cancellation removes PNG and tile partials", async (t) => {
  const { dir, config } = setup(t, 3, 5);
  config.bandTiles = 2;
  config.chunkTiles = 2;
  config.tilesPath = join(dir, "cancelled-tiles");
  const controller = new AbortController();
  await assert.rejects(
    exportWorld(config, {
      signal: controller.signal,
      onProgress: () => controller.abort(new Error("test cancellation")),
    }),
    /test cancellation/,
  );
  assert.equal(existsSync(config.outputPath), false);
  assert.equal(existsSync(config.tilesPath), false);
  assert.ok(readdirSync(dir).every((name) => !name.includes(".partial")));
  config.outputPath = join(dir, "complete.png");
  config.tilesPath = null;
  const result = await exportWorld(config);
  assert.equal(result.png.width, 48);
  assert.equal(result.png.height, 80);
  assert.equal(result.png.rows, 80);
});

test("export CLI rejects oversized bands, malformed rectangles, and invalid hash before rendering", () => {
  assert.deepEqual(parseExportCli(["--help"]), { help: true });
  for (const args of [
    ["--band-tiles", "33"],
    ["--chunk-tiles", "253"],
    ["--region", "0,0,0,2"],
    ["--expect-world-sha256", "bad"],
    ["--compression-level", "10"],
  ])
    assert.throws(() => parseExportCli(["w", "a", "out", ...args]));
});

test("refusing an existing partial preserves the earlier export's data and progress", async (t) => {
  const { config } = setup(t, 2, 2);
  const partial = `${config.outputPath}.partial`,
    progress = `${config.outputPath}.progress.json`;
  writeFileSync(partial, "owned by earlier export");
  writeFileSync(progress, '{"phase":"export","writtenRows":1}');
  await assert.rejects(exportWorld(config), /EEXIST/);
  assert.equal(readFileSync(partial, "utf8"), "owned by earlier export");
  assert.equal(
    readFileSync(progress, "utf8"),
    '{"phase":"export","writtenRows":1}',
  );
});

test("sparse indexed random reads equal full-column decoder at RLE/checkpoint/world boundaries", () => {
  const width = 37,
    height = 99;
  const columns = Array.from({ length: width }, (_, x) => [
    record({ type: x % 2, repeats: 18, wall: 1 }),
    record({ type: null, repeats: 33, liquid: 255 }),
    record({ type: 1, repeats: 45, paint: 2 }),
  ]);
  const world = openWorld(fixtureWorld({ width, height, columns }).bytes),
    expected = extractRegion(world, { x: 0, y: 0, width, height });
  for (const stride of [1, 7, 16, 64, 128]) {
    const index = buildRowIndex(world, stride),
      region = readIndexedRegion(world, index, {
        x: 5,
        y: 17,
        width: 17,
        height: 49,
      });
    for (let x = 0; x < width; x++)
      for (let y = 0; y < height; y++) {
        assert.deepEqual(
          readIndexedTile(world, index, x, y),
          expected.cells[x * height + y],
        );
        assert.deepEqual(
          region.getWorldTile(x, y),
          expected.cells[x * height + y],
        );
      }
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [width, 0],
      [0, height],
      [0.5, 2],
      [2, NaN],
    ])
      assert.equal(readIndexedTile(world, index, x, y), null);
  }
});

test("read-only record decode omits only unused raw copies and preserves parser cursor", () => {
  for (const options of [
    { type: 1, repeats: 37, wall: 2, paint: 3 },
    { type: null, repeats: 5, liquid: 128 },
    { type: 1, shape: 4, wireRed: true },
  ]) {
    const bytes = record(options),
      a = new Reader(bytes),
      b = new Reader(bytes),
      important = new Uint8Array(512);
    const original = decodeRecord(a, important),
      lean = decodeRecord(b, important, false);
    assert.deepEqual(lean.tile, original.tile);
    assert.equal(lean.repeats, original.repeats);
    assert.equal(lean.raw, null);
    assert.equal(a.pos, b.pos);
    assert.ok(original.raw instanceof Uint8Array);
  }
});
