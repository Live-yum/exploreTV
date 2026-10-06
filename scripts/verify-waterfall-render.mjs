import fs from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { openWorld, extractRegion } from "../core/world.mjs";
import { saveFragment, loadFragment } from "../core/fragment.mjs";
import {
  createWorldRenderer,
  createWorldWaterfallRegistry,
  buildRowIndex,
  readIndexedRegion,
  paddedWorldRect,
} from "../scripts/world-render-engine.mjs";
const bytes = fs.readFileSync("fixtures/example-world.wld"),
  hash = createHash("sha256").update(bytes).digest("hex"),
  world = openWorld(bytes),
  index = buildRowIndex(world),
  registry = createWorldWaterfallRegistry(world);
assert.equal(registry.failures.length, 0);
assert.equal(registry.scanComplete, true);
const engine = createWorldRenderer({
    assetDir: "example/assets",
    waterfallRegistry: registry,
  }),
  results = [];
async function render(rect, count = false) {
  const padded = paddedWorldRect(world, rect),
    region = readIndexedRegion(world, index, padded),
    canvas = createCanvas(1, 1),
    out = await engine.drawRegion(region, canvas, { core: rect, count });
  const crop = createCanvas(rect.width * 16, rect.height * 16);
  crop
    .getContext("2d")
    .drawImage(
      canvas,
      (rect.x - padded.x) * 16,
      (rect.y - padded.y) * 16,
      rect.width * 16,
      rect.height * 16,
      0,
      0,
      rect.width * 16,
      rect.height * 16,
    );
  return { canvas: crop, plan: out.plan };
}
for (const [name, x, y, width=28, height=28] of [
  ["water", 65, 918],
  ["lava", 100, 1942],
  ["honey", 312, 1986],
  ["rain", 906, 281],
  ["shimmer", 789, 840, 85, 40],
]) {
  const rect = { x, y, width, height },
    full = await render(rect, true),
    tiled = createCanvas(width*16, height*16),
    context = tiled.getContext("2d");
  for (let dx = 0; dx < width; dx += 14)
    for (let dy = 0; dy < height; dy += 14) {
      const part = await render({
        x: x + dx,
        y: y + dy,
        width: Math.min(14,width-dx),
        height: Math.min(14,height-dy),
      });
      context.drawImage(part.canvas, dx * 16, dy * 16);
    }
  const a = full.canvas.getContext("2d").getImageData(0, 0, width*16, height*16).data,
    b = context.getImageData(0, 0, width*16, height*16).data;
  let different = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) different++;
  assert.equal(different, 0, name + " seams");
  const region = extractRegion(world, rect),
    round = loadFragment(saveFragment(region));
  assert.deepEqual(round.raw, region.raw);
  assert.deepEqual(round.cells, region.cells);
  fs.writeFileSync(
    "artifacts/waterfall-integrated-" + name + ".png",
    full.canvas.toBuffer("image/png"),
  );
  results.push({
    name,
    rect,
    seamDifferentBytes: different,
    waterfallCommands: full.plan.support.waterfalls.commands,
    roundtrip: true,
  });
}
for (const key of [
  "missingCommands",
  "invalidCommands",
  "effectFailures",
  "liquidUnsupported",
  "unsupportedTiles",
])
  assert.deepEqual(engine.stats[key], {}, key);
assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
fs.writeFileSync(
  "artifacts/waterfall-integrated-report.json",
  JSON.stringify(
    {
      worldSha256: hash,
      registry: {
        stats: registry.stats,
        buildMilliseconds: registry.buildMilliseconds,
        maxWaterfalls: registry.maxWaterfalls,
      },
      results,
      renderer: engine.stats,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    registry: registry.stats,
    results,
    peakFrames: engine.stats.maxPreparedBytes,
  }),
);
engine.dispose();
