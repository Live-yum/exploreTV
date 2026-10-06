import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { fixtureWorld, record } from "./fixture.mjs";
import { parseCli } from "../scripts/render-full-world.mjs";

const script = fileURLToPath(
  new URL("../scripts/render-full-world.mjs", import.meta.url),
);
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "exploretv-full-world-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const world = join(dir, "world.wld"),
    assets = join(dir, "textures"),
    out = join(dir, "output");
  mkdirSync(assets);
  return { dir, world, assets, out };
}
function run(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 30000,
  });
}

test("full-world CLI requires explicit paths and rejects unsafe or oversized details", () => {
  assert.deepEqual(parseCli(["--help"]), { help: true });
  assert.throws(() => parseCli([]), /Provide world/);
  for (const detail of [
    "../escape:0,0,2,2",
    "x:0,0,253,1",
    "x:0,0,0,1",
    "x:-1,0,1,1",
  ])
    assert.throws(() =>
      parseCli(["world", "assets", "out", "--detail", detail]),
    );
  assert.throws(
    () =>
      parseCli([
        "world",
        "assets",
        "out",
        "--detail",
        "a:0,0,1,1",
        "--detail",
        "A:0,0,1,1",
      ]),
    /Duplicate/,
  );
  assert.throws(
    () => parseCli(["world", "assets", "out", "--expect-world-sha256", "bad"]),
    /64 hexadecimal/,
  );
  assert.throws(
    () => parseCli(["world", "assets", "out", "--input-encoding", "guess"]),
    /Unknown input encoding/,
  );
});

test("full-world CLI rejects hash mismatch and outside-world details before output", (t) => {
  const { world, assets, out } = setup(t);
  writeFileSync(world, fixtureWorld().bytes);
  const mismatch = run(
    world,
    assets,
    out,
    "--expect-world-sha256",
    "0".repeat(64),
  );
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /SHA-256 mismatch/);
  assert.equal(existsSync(out), false);
  const outside = run(world, assets, out, "--detail", "edge:2,0,1,1");
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /outside world/);
  assert.equal(existsSync(out), false);
});

test("full-world render accounts for missing and unsupported cells across chunk boundaries", (t) => {
  const { world, assets, out } = setup(t);
  const width = 260,
    height = 3;
  const columns = Array.from({ length: width }, (_, x) => [
    record({ type: x === 1 ? 0 : x === 258 ? 5 : 1, repeats: height - 1 }),
  ]);
  const source = fixtureWorld({ width, height, columns }).bytes;
  writeFileSync(world, source);
  const atlas = new PNG({ width: 288, height: 270 });
  for (let y = 0; y < atlas.height; y++)
    for (let x = 0; x < atlas.width; x++) {
      const i = (y * atlas.width + x) * 4;
      atlas.data.set([(x * 7) % 256, (y * 5) % 256, (x + y) % 256, 255], i);
    }
  writeFileSync(join(assets, "Tiles_1.png"), PNG.sync.write(atlas));
  const result = run(world, assets, out, "--detail", "boundary:126,0,4,3");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(
    readFileSync(join(out, "full-world-coverage.json")),
  );
  assert.equal(report.processedCells, width * height);
  assert.equal(report.chunkCount, 3);
  assert.equal(report.plannedCommands, 777);
  assert.equal(report.renderedCommands, 774);
  assert.deepEqual(report.missingCommands, { "Tiles_0.png": 3 });
  assert.deepEqual(report.unsupportedTiles, [{ id: 5, count: 3 }]);
  assert.deepEqual(report.coverageMask.paletteIndexCounts, {
    0: 774,
    1: 3,
    4: 3,
  });
  assert.deepEqual(report.invalidCommands, {});
  assert.deepEqual(report.effectFailures, {});
  assert.equal(
    report.worldSha256,
    createHash("sha256").update(source).digest("hex"),
  );
  assert.equal(
    report.rendererProvenance.sourceHashes["scripts/render-full-world.mjs"],
    createHash("sha256").update(readFileSync(script)).digest("hex"),
  );
  const overview = PNG.sync.read(readFileSync(join(out, "full-world.png")));
  assert.equal(overview.width, width);
  assert.equal(overview.height, height);
  // Interior cells at either side of a 128-tile chunk boundary have identical
  // neighbors and must use identical crops from the synthetic gradient atlas.
  for (let y = 0; y < height; y++) {
    const left = (y * width + 127) * 4,
      right = (y * width + 128) * 4;
    assert.deepEqual(
      overview.data.subarray(left, left + 4),
      overview.data.subarray(right, right + 4),
    );
  }
  const detail = PNG.sync.read(
    readFileSync(join(out, "full-world-detail-boundary.png")),
  );
  assert.equal(detail.width, 64);
  assert.equal(detail.height, 48);
  const mask = PNG.sync.read(
    readFileSync(join(out, "full-world-coverage.png")),
  );
  assert.equal(mask.data[(0 * width + 1) * 4 + 3], 190);
  assert.equal(mask.data[(0 * width + 2) * 4 + 3], 0);
});

test("inventory-only lists required inputs without creating images", (t) => {
  const { world, assets, out } = setup(t);
  writeFileSync(world, fixtureWorld().bytes);
  const result = run(world, assets, out, "--inventory-only");
  assert.equal(result.status, 0, result.stderr);
  const inventory = JSON.parse(
    readFileSync(join(out, "full-world-inventory.json")),
  );
  assert.equal(inventory.totalCells, 6);
  assert.equal(inventory.requiredTextures.length, 2);
  assert.equal(existsSync(join(out, "full-world.png")), false);
});
