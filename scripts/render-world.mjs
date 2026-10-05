import { decodePngRgba } from "../core/png-rgba.mjs";
import { registerTextureSource } from "../core/assets.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { openWorld, extractSceneRegion } from "../core/world.mjs";
import { saveFragment, loadFragment } from "../core/fragment.mjs";
import { prepareSceneFrames } from "../core/scene-frames.mjs";
import { planScene, renderScene } from "../core/renderer.mjs";
import assert from "node:assert/strict";
const [file, assetDir, x, y, width, height, ...flags] = process.argv.slice(2);
const effects = flags.includes("--effects");
if (!height)
  throw new Error(
    "Usage: node scripts/render-world.mjs world.wld asset-directory x y width height",
  );
const worldBytes = readFileSync(file),
  world = openWorld(worldBytes),
  region = extractSceneRegion(world, {
    x: +x,
    y: +y,
    width: +width,
    height: +height,
  }),
  plan = planScene(region, {
    paintEnabled: effects,
    liquids: {
      enabled: effects,
      frame: 0,
      waterfallFrame: 0,
      waterStyle: 0,
      layer: "foreground",
    },
  }),
  assets = new Map(),
  assetHashes = {};
for (const name of plan.requiredAssets) {
  const bytes = readFileSync(join(assetDir, name));
  assets.set(
    name,
    registerTextureSource(await loadImage(bytes), {
      pngBytes: bytes,
      rawRgba: decodePngRgba(bytes),
    }),
  );
  assetHashes[name] = createHash("sha256").update(bytes).digest("hex");
}
const canvas = createCanvas(plan.width, plan.height),
  context = canvas.getContext("2d"),
  sceneFrames = effects
    ? prepareSceneFrames(plan, assets, createCanvas, {
        inputEncoding: flags.includes("--straight")
          ? "standard-straight"
          : "tconvert-game-raw",
        opaqueScene: !flags.includes("--transparent"),
      })
    : null,
  result = renderScene(context, plan, assets, { strict: true, sceneFrames });
assert.ok(result.drawn > 0);
const fragment = saveFragment(region),
  reloaded = loadFragment(fragment);
assert.deepEqual(reloaded.raw, region.raw);
assert.deepEqual(reloaded.cells, region.cells);
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/private-scene.png", canvas.toBuffer("image/png"));
writeFileSync(
  "artifacts/private-scene-report.json",
  JSON.stringify(
    {
      worldSha256: createHash("sha256").update(worldBytes).digest("hex"),
      rect: region.rect,
      sourceVersion: region.version,
      signature: world.signature,
      worldSurface: world.worldSurface,
      effects,
      assetHashes,
      support: plan.support,
      ...result,
      fragmentRoundtrip: true,
      limitations:
        "Actual texture crops, no game screenshot oracle. Missing effects/objects reported. Private output: do not publish without authorization.",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      rect: region.rect,
      drawn: result.drawn,
      support: plan.support,
      paintSupport: result.paintSupport,
      missing: result.missingAssets,
      invalid: result.invalidAssets,
      roundtrip: true,
    },
    null,
    2,
  ),
);
