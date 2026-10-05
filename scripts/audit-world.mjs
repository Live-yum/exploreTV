/** Bounded planner-only inventory: actual rules, source crops and per-cell omissions. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { openWorld } from "../core/world.mjs";
import { planScene } from "../core/renderer.mjs";
import { inspectPng } from "../core/assets.mjs";
import {
  buildRowIndex,
  readIndexedRegion,
  paddedWorldRect,
} from "./world-render-engine.mjs";
const [file, assetsDir, out] = process.argv.slice(2);
if (!out)
  throw Error("Usage: audit-world.mjs world.wld asset-directory report.json");
const start = performance.now(),
  bytes = readFileSync(file),
  world = openWorld(bytes),
  index = buildRowIndex(world),
  assets = new Map();
const result = {
  worldSha256: createHash("sha256").update(bytes).digest("hex"),
  width: world.width,
  height: world.height,
  processedCells: 0,
  visibleActiveCells: 0,
  plannedTileCells: 0,
  unsupportedTiles: {},
  unsupportedReasons: {},
  sourceHidden: {},
  liquidUnsupported: {},
  missingAssets: {},
  invalidCrops: {},
  requiredAssets: [],
  exampleCoordinates: {},
};
const add = (m, k, n = 1) => (m[k] = (m[k] || 0) + n);
for (let x = 0; x < world.width; x += 128) {
  for (let y = 0; y < world.height; y += 128) {
    const core = {
        x,
        y,
        width: Math.min(128, world.width - x),
        height: Math.min(128, world.height - y),
      },
      region = readIndexedRegion(world, index, paddedWorldRect(world, core));
    const p = planScene(region, {
        paintEnabled: true,
        liquids: {
          enabled: true,
          frame: 0,
          waterfallFrame: 0,
          waterStyle: 0,
          layer: "foreground",
        },
      }),
      planned = new Set();
    const inside = (wx, wy) =>
      wx >= x && wy >= y && wx < x + core.width && wy < y + core.height;
    for (const c of p.commands) {
      const wx = c.x + region.rect.x,
        wy = c.y + region.rect.y;
      if (!inside(wx, wy)) continue;
      if (c.kind === "tile") planned.add(wx + "," + wy);
      if (!assets.has(c.asset)) {
        const path = join(assetsDir, c.asset);
        try {
          const b = readFileSync(path);
          assets.set(c.asset, {
            ...inspectPng(b),
            file: c.asset,
            bytes: b.length,
            sha256: createHash("sha256").update(b).digest("hex"),
          });
        } catch (e) {
          assets.set(c.asset, {
            file: c.asset,
            error: e.code === "ENOENT" ? "missing" : e.message,
          });
        }
      }
      const a = assets.get(c.asset);
      if (a.error) add(result.missingAssets, c.asset);
      else if (
        c.sx < 0 ||
        c.sy < 0 ||
        c.sx + c.sw > a.width ||
        c.sy + c.sh > a.height
      )
        add(result.invalidCrops, c.asset);
    }
    for (let dx = 0; dx < core.width; dx++)
      for (let dy = 0; dy < core.height; dy++) {
        const t =
          region.cells[
            (x + dx - region.rect.x) * region.rect.height +
              y +
              dy -
              region.rect.y
          ];
        if (t.active && !t.invisibleBlock) result.visibleActiveCells++;
      }
    result.plannedTileCells += planned.size;
    for (const c of p.unsupportedCells)
      if (inside(c.x, c.y)) {
        add(result.unsupportedTiles, c.type);
        add(result.unsupportedReasons, c.reason || "unimplemented-type");
        result.exampleCoordinates[c.type] ??= { x: c.x, y: c.y };
      }
    for (const c of p.sourceHiddenCells || [])
      if (inside(c.x, c.y)) add(result.sourceHidden, c.type);
    for (const c of p.support.liquidDrawing.unsupportedCoordinates)
      if (inside(c.x, c.y)) add(result.liquidUnsupported, c.reason);
    result.processedCells += core.width * core.height;
  }
  if (x % 1024 === 0)
    console.log(
      JSON.stringify({
        xThrough: Math.min(x + 128, world.width),
        processedCells: result.processedCells,
        seconds: Math.round((performance.now() - start) / 1000),
      }),
    );
}
const hidden = Object.values(result.sourceHidden).reduce((a, b) => a + b, 0),
  unsupported = Object.values(result.unsupportedTiles).reduce(
    (a, b) => a + b,
    0,
  );
if (
  result.visibleActiveCells !==
  result.plannedTileCells + hidden + unsupported
)
  throw Error("Visible Tile accounting mismatch");
if (result.processedCells !== world.width * world.height)
  throw Error("Incomplete audit");
result.sourceHashes = {};
for (const n of [
  "world",
  "world-tree-context",
  "renderer",
  "static-nature",
  "cobweb-shapes",
  "static-objects",
  "static-blocks",
  "static-trees",
  "static-misc",
  "static-furniture-next",
  "liquid",
  "liquid-visible-level",
  "paint",
  "scene-frames",
])
  result.sourceHashes[n] = createHash("sha256")
    .update(readFileSync(new URL("../core/" + n + ".mjs", import.meta.url)))
    .digest("hex");
if (
  result.visibleActiveCells !==
  result.plannedTileCells +
    Object.values(result.unsupportedTiles).reduce((a, b) => a + b, 0) +
    Object.values(result.sourceHidden).reduce((a, b) => a + b, 0)
)
  throw Error("Visible Tile accounting mismatch");
result.requiredAssets = [...assets.values()].sort((a, b) =>
  a.file.localeCompare(b.file),
);
result.runtimeSeconds = (performance.now() - start) / 1000;
result.peakRssKiB = process.resourceUsage().maxRSS;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    processedCells: result.processedCells,
    plannedTileCells: result.plannedTileCells,
    unsupportedTiles: Object.values(result.unsupportedTiles).reduce(
      (a, b) => a + b,
      0,
    ),
    missingAssets: result.missingAssets,
    invalidCrops: result.invalidCrops,
    requiredAssets: result.requiredAssets.length,
    runtimeSeconds: result.runtimeSeconds,
  }),
);
