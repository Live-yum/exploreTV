import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { openWorld, extractRegion } from "../core/world.mjs";
import {
  saveFragment,
  loadFragment,
  restoreIntoRegion,
} from "../core/fragment.mjs";
import { planScene } from "../core/renderer.mjs";
const path = process.argv[2];
if (!path)
  throw new Error(
    "Usage: npm run test:real -- /path/to/world.wld [expected-sha256]",
  );
const bytes = readFileSync(path),
  sha256 = createHash("sha256").update(bytes).digest("hex");
if (process.argv[3]) assert.equal(sha256, process.argv[3]);
const start = performance.now(),
  world = openWorld(bytes),
  parseMs = performance.now() - start;
const checks = [];
for (const [x, y, w, h] of [
  [0, 0, 1, 1],
  [world.width - 2, world.height - 2, 2, 2],
  [Math.floor(world.width / 2) - 32, Math.floor(world.height / 3) - 20, 64, 40],
]) {
  const rect = { x, y, width: w, height: h },
    region = extractRegion(world, rect),
    saved = saveFragment(region),
    loaded = loadFragment(saved),
    restored = restoreIntoRegion(region, loaded, 0, 0);
  assert.deepEqual(loaded.cells, region.cells);
  assert.deepEqual(loaded.raw, region.raw);
  assert.deepEqual(restored.raw, region.raw);
  const plan = planScene(region);
  checks.push({
    rect,
    tiles: region.raw.length,
    fragmentBytes: Buffer.byteLength(saved),
    requiredAssets: plan.requiredAssets,
    support: plan.support,
  });
}
assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
const report = {
  sha256,
  bytes: bytes.length,
  version: world.version,
  width: world.width,
  height: world.height,
  records: world.records,
  indexBytes: world.columns.byteLength,
  parseMs,
  checks,
  limitations:
    "Tile data only. No pixel-exact rendering oracle; no furniture contents or entity sections.",
};
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/real-world-report.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
