import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { planLiquids } from "../core/liquid.mjs";
import { planSceneLiquids } from "../core/liquid-composite.mjs";
import { planScene } from "../core/renderer.mjs";
import { renderSceneBatched } from "../core/scene-batches.mjs";
import { openWorld, extractSceneRegion } from "../core/world.mjs";
import { decodePngRgba } from "../core/png-rgba.mjs";
import { registerTextureSource } from "../core/assets.mjs";
const air = {
  active: false,
  type: 0,
  shape: 0,
  liquid: 0,
  liquidKind: 0,
  wall: 0,
};
const options = { enabled: true, layer: "foreground" };
test("ordinary liquid commands and diagnostics remain unchanged without Shimmer", () => {
  const tile = { ...air, liquid: 128, liquidKind: 1 };
  const region = {
    rect: { x: 10, y: 10, width: 1, height: 1 },
    cells: [tile],
    getWorldTile: () => air,
    source: { worldSurface: 300 },
  };
  assert.deepEqual(
    planSceneLiquids(region, options),
    planLiquids(region, options),
  );
  assert.deepEqual(
    planSceneLiquids(region, { enabled: false }),
    planLiquids(region, { enabled: false }),
  );
});
test("successful Shimmer replaces only its explicit failure and retains source bytes", () => {
  const tile = { ...air, liquid: 255, liquidKind: 4 };
  const region = {
    rect: { x: 10, y: 10, width: 1, height: 1 },
    cells: [tile],
    getWorldTile: (x, y) => (x === 10 && y === 10 ? tile : air),
    source: { worldSurface: 300 },
  };
  const saved = JSON.stringify(region.cells),
    old = planLiquids(region, options),
    p = planSceneLiquids(region, options);
  assert.equal(old.support.unsupportedByReason.shimmer, 1);
  assert.equal(p.support.unsupported, 0);
  assert.ok(!p.warnings.some(w => w.includes("liquid cells skipped")));
  assert.ok(p.commands.some((c) => c.shimmerPart === "base"));
  assert.equal(JSON.stringify(region.cells), saved);
});
test("a saved source outside the region still supplies its bounded dry trail", () => {
  const tile = { ...air, liquid: 255, liquidKind: 4 },
    r = {
      rect: { x: 10, y: 12, width: 1, height: 1 },
      cells: [air],
      getWorldTile: (x, y) => (x === 10 && y === 10 ? tile : air),
      source: { worldSurface: 300 },
    };
  const p = planSceneLiquids(r, options);
  assert.ok(p.commands.some((c) => c.shimmerPart === "base"));
  assert.equal(p.support.liquidCells, 0);
});
test("bundled actual Shimmer pond renders every frame through bounded batches", async () => {
  const world = openWorld(
    fs.readFileSync(new URL("../fixtures/example-world.wld", import.meta.url)),
  );
  const region = extractSceneRegion(world, {
    x: 789,
    y: 840,
    width: 85,
    height: 40,
  });
  const plan = planScene(region, { paintEnabled: true, liquids: options }),
    assets = new Map();
  for (const name of plan.requiredAssets) {
    const bytes = fs.readFileSync(
        new URL("../example/assets/" + name, import.meta.url),
      ),
      image = await loadImage(bytes);
    registerTextureSource(image, {
      pngBytes: bytes,
      rawRgba: decodePngRgba(bytes),
    });
    assets.set(name, image);
  }
  const canvas = createCanvas(plan.width, plan.height),
    result = renderSceneBatched(
      canvas.getContext("2d"),
      plan,
      assets,
      createCanvas,
      { inputEncoding: "tconvert-game-raw", opaqueScene: true, strict: true },
    );
  assert.equal(plan.support.liquidDrawing.shimmer.savedShimmerCells, 739);
  assert.equal(plan.support.liquidDrawing.shimmer.dryShapeCandidates, 24);
  assert.equal(plan.support.liquidDrawing.unsupported, 0);
  assert.equal(result.drawn, plan.commands.length);
  assert.equal(result.skippedEffects, 0);
  assert.ok(result.paintSupport.batches > 1);
  assert.ok(result.paintSupport.peakBytes <= 8 * 1024 * 1024);
  assert.deepEqual(result.missingAssets, []);
  assert.deepEqual(result.invalidAssets, []);
});
