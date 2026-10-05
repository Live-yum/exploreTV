import assert from "node:assert/strict";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PNG } from "pngjs";
import { createCanvas } from "@napi-rs/canvas";
import { openWorld, LIMITS } from "../core/world.mjs";
import {
  createWorldRenderer,
  createWorldWaterfallRegistry,
  buildRowIndex,
  readIndexedRegion,
  paddedWorldRect,
} from "./world-render-engine.mjs";
import { verifyExport } from "./verify-export.mjs";

const [worldPath, assetDir, pngPath, ...flags] = process.argv.slice(2);
if (!worldPath || !assetDir || !pngPath || flags.some((f) => f !== "--example"))
  throw new Error(
    "Usage: node scripts/verify-overview.mjs world.wld png-directory output.png [--example]",
  );
const started = performance.now();
const verification = await verifyExport(pngPath);
assert.ok(
  statSync(`${pngPath}.json`).size <= 16 * 1024 ** 2,
  "Report size budget",
);
const report = JSON.parse(readFileSync(`${pngPath}.json`));
assert.equal(report.schema, "exploretv-direct-overview-export-v1");
assert.ok([1, 2, 4, 8].includes(report.pixelsPerTile));
// This visual verifier intentionally decodes only ordinary-size overview PNGs.
// Large 2/4/8 px/tile outputs can still use the bounded streaming verifier above.
assert.ok(
  report.png.width * report.png.height * 4 <= 128 * 1024 ** 2,
  "Overview pixel comparison exceeds 128 MiB decode budget; use verify-export.mjs",
);
assert.ok(
  statSync(pngPath).size <= 144 * 1024 ** 2,
  "Encoded overview exceeds comparison budget",
);
assert.ok(
  statSync(worldPath).size <= LIMITS.fileBytes,
  "World file size budget exceeded",
);
const bytes = readFileSync(worldPath);
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  report.worldSha256,
);
const world = openWorld(bytes),
  index = buildRowIndex(world);
const image = PNG.sync.read(readFileSync(pngPath));
assert.equal(image.width, report.png.width);
assert.equal(image.height, report.png.height);
assert.deepEqual(report.worldDimensions, {
  width: world.width,
  height: world.height,
});
const scope = report.worldRect;
assert.ok(Object.values(scope).every(Number.isSafeInteger));
assert.ok(scope.x >= 0 && scope.y >= 0 && scope.width > 0 && scope.height > 0);
assert.ok(
  scope.x + scope.width <= world.width &&
    scope.y + scope.height <= world.height,
);
assert.equal(
  report.fullWorld,
  scope.x === 0 &&
    scope.y === 0 &&
    scope.width === world.width &&
    scope.height === world.height,
);
for (const name of [
  "scripts/export-world.mjs",
  "scripts/export-overview.mjs",
  "scripts/downsample-rgba.mjs",
  "scripts/world-render-engine.mjs",
  "core/world.mjs",
  "core/renderer.mjs",
])
  assert.ok(report.sourceHashes[name], `Required source provenance: ${name}`);
for (const [name, hash] of Object.entries(report.sourceHashes)) {
  assert.match(name, /^(core|scripts)\/[a-z][a-z0-9-]*\.mjs$/);
  assert.equal(
    createHash("sha256")
      .update(readFileSync(new URL("../" + name, import.meta.url)))
      .digest("hex"),
    hash,
    `Source provenance: ${name}`,
  );
}
for (const [name, hash] of Object.entries(report.assetHashes)) {
  assert.match(name, /^[A-Za-z0-9_-]+\.png$/);
  assert.ok(
    statSync(join(assetDir, name)).size <= 8 * 1024 ** 2,
    "PNG encoded size outside budget",
  );
  assert.equal(
    createHash("sha256")
      .update(readFileSync(join(assetDir, name)))
      .digest("hex"),
    hash,
    `Texture provenance: ${name}`,
  );
}
const width = Math.min(65, scope.width),
  height = Math.min(49, scope.height);
const sample = (name, x, y, w = width, h = height) => ({
  name,
  x,
  y,
  width: w,
  height: h,
});
const patches = [
  sample("top-left", scope.x, scope.y),
  sample("top-right", scope.x + scope.width - width, scope.y),
  sample("bottom-left", scope.x, scope.y + scope.height - height),
  sample(
    "bottom-right",
    scope.x + scope.width - width,
    scope.y + scope.height - height,
  ),
  sample(
    "center",
    scope.x + Math.floor((scope.width - width) / 2),
    scope.y + Math.floor((scope.height - height) / 2),
  ),
  sample(
    "render-seams",
    scope.x +
      Math.min(Math.max(0, report.chunkTiles - 17), scope.width - width),
    scope.y +
      Math.min(Math.max(0, report.bandTiles - 13), scope.height - height),
  ),
];
if (flags.includes("--example")) {
  assert.equal(
    report.worldSha256,
    "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab",
  );
  assert.equal(report.fullWorld, true);
  for (const [name, x, y, w, h] of [
    ["surface-and-forest", 4095, 480, 65, 65],
    ["water", 65, 918, 65, 49],
    ["lava", 100, 1942, 65, 49],
    ["honey", 312, 1986, 65, 49],
    ["rain", 906, 281, 65, 49],
    ["shimmer", 789, 840, 85, 40],
    ["mixed-halfbrick", 4630, 2000, 65, 49],
  ])
    patches.push(sample(name, x, y, w, h));
  for (const field of [
    "missingCommands",
    "invalidCommands",
    "effectFailures",
    "unsupportedTiles",
    "liquidUnsupported",
  ])
    assert.equal(Object.keys(report[field]).length, 0, `Example ${field}`);
}
const renderer = createWorldRenderer({
  assetDir,
  inputEncoding: report.inputEncoding,
  waterfallRegistry: createWorldWaterfallRegistry(world),
});
const canvas = createCanvas(1, 1),
  results = [];
try {
  for (const { name, ...core } of patches) {
    const region = readIndexedRegion(
      world,
      index,
      paddedWorldRect(world, core),
    );
    await renderer.drawRegion(region, canvas, { core });
    // Independent baseline: render the entire bounded patch at full detail,
    // then directly sum each source block. No production downsample helper.
    const rgba = canvas
      .getContext("2d")
      .getImageData(
        (core.x - region.rect.x) * 16,
        (core.y - region.rect.y) * 16,
        core.width * 16,
        core.height * 16,
      ).data;
    const scale = report.pixelsPerTile,
      factor = 16 / scale;
    let differentBytes = 0,
      comparedPixels = 0;
    for (let y = 0; y < core.height * scale; y++) {
      for (let x = 0; x < core.width * scale; x++) {
        const sums = [0, 0, 0];
        let alpha = 0;
        for (let dy = 0; dy < factor; dy++)
          for (let dx = 0; dx < factor; dx++) {
            const i =
              ((y * factor + dy) * core.width * 16 + (x * factor + dx)) * 4;
            for (let c = 0; c < 3; c++) sums[c] += rgba[i + c] * rgba[i + 3];
            alpha += rgba[i + 3];
          }
        const expected = [
          ...sums.map((n) => (alpha ? Math.round(n / alpha) : 0)),
          Math.round(alpha / (factor * factor)),
        ];
        const i =
          (((core.y - scope.y) * scale + y) * image.width +
            (core.x - scope.x) * scale +
            x) *
          4;
        for (let c = 0; c < 4; c++)
          if (image.data[i + c] !== expected[c]) differentBytes++;
        comparedPixels++;
      }
    }
    assert.equal(
      differentBytes,
      0,
      `${name}: direct output vs independently reduced full-detail baseline`,
    );
    results.push({ name, worldRect: core, comparedPixels, differentBytes });
  }
} finally {
  renderer.dispose();
  canvas.width = canvas.height = 1;
}
for (let i = 3; i < image.data.length; i += 4)
  assert.equal(image.data[i], 255, "Opaque scene alpha");
for (const [name, hash] of Object.entries(renderer.stats.assetHashes))
  assert.equal(hash, report.assetHashes[name], `Texture provenance: ${name}`);
const result = {
  schema: "exploretv-direct-overview-verification-v1",
  status: "passed",
  png: verification.png,
  worldSha256: report.worldSha256,
  worldRect: scope,
  verifiedSourceFiles: Object.keys(report.sourceHashes).length,
  verifiedTextures: Object.keys(report.assetHashes).length,
  pixelsPerTile: report.pixelsPerTile,
  processedCells: report.processedCells,
  patches: results,
  alphaRange: [255, 255],
  checks: [
    "Every PNG CRC, encoded hash, filtered scanline and dimension",
    "Full export rectangle and exact world-cell/row accounting",
    "All output alpha values",
    "Bounded full-detail patches independently area-reduced, including seams and world corners",
    "Matched real input, current source hashes and every recorded texture hash",
  ],
  wholeHighResolutionImageAllocated: false,
  runtimeSeconds: +((performance.now() - started) / 1000).toFixed(2),
};
writeFileSync(`${pngPath}.fidelity.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
