import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { registerTextureSource, ASSET_LIMITS } from "../core/assets.mjs";
import {
  ORDINARY_BLOCKS,
  OVERVIEW_FRAME_RECIPE_VERSION,
  overviewFrameRecipe,
  overviewFrameRecipeIds,
} from "../core/overview-frame-recipes.mjs";
import { createNodePngRgbaDecoder } from "./png-rgba-node.mjs";
import { prepareRawOverviewFrame } from "./raw-overview-frame.mjs";
import { prepareCanonicalSlopeOverviewFrame } from "./direct-slope-overview-frame.mjs";
import { nativeBlitterStatus } from "./native-blitter.mjs";
import {
  OVERVIEW_FRAME_PACK_SCHEMA,
  OVERVIEW_FRAME_PACK_BAKE_VERSION,
  OVERVIEW_FRAME_PACK_RECORD_BYTES,
  OVERVIEW_FRAME_PACK_LIMITS as LIMITS,
  overviewFramePackSha256 as sha256,
  overviewFramePackRuleHashes,
  overviewFramePackBaker,
  readOverviewFramePackFile,
} from "./overview-frame-pack-format.mjs";

/** Resource compilation only: no world input, scene planner or world cache. */
export function buildOverviewFramePack({
  assetDir,
  outputDir,
  pageBytes = 65536,
} = {}) {
  const started = performance.now();
  if (
    typeof assetDir !== "string" ||
    typeof outputDir !== "string" ||
    !Number.isSafeInteger(pageBytes) ||
    pageBytes < 8192 ||
    pageBytes > LIMITS.pageBytes ||
    pageBytes % 4096
  )
    throw new Error("Invalid overview frame pack build arguments");
  if (existsSync(outputDir))
    throw new Error("Overview frame pack output already exists");
  if (!nativeBlitterStatus.available)
    throw new Error(
      "Prepare the native overview renderer before compiling frames",
    );
  const ruleHashes = overviewFramePackRuleHashes();
  const ordinary = new Set(ORDINARY_BLOCKS);
  const inputs = readdirSync(assetDir)
    .flatMap((name) => {
      const match = /^(Tiles|Wall)_(0|[1-9][0-9]*)\.png$/.exec(name);
      if (!match) return [];
      const type = Number(match[2]),
        kind = match[1] === "Tiles" ? "tile" : "wall";
      return (kind === "tile" ? ordinary.has(type) : type > 0 && type <= 65535)
        ? [{ name, type, kind }]
        : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (!inputs.length || inputs.length > LIMITS.sources)
    throw new Error("Overview frame pack source count outside contract");
  const staging = `${outputDir}.building-${randomUUID()}`;
  mkdirSync(staging, { recursive: true });
  try {
    const decoder = createNodePngRgbaDecoder(),
      sources = [],
      rows = [],
      pages = [],
      unique = new Map();
    let page = new Uint8Array(pageBytes),
      used = 0,
      logicalPixelBytes = 0;
    const flush = () => {
      if (!used) return;
      const bytes = page.slice(0, used),
        file = `page-${String(pages.length).padStart(5, "0")}.bin`;
      if (pages.length >= LIMITS.pages)
        throw new Error("Overview frame pack page limit exceeded");
      writeFileSync(join(staging, file), bytes, { flag: "wx" });
      pages.push({ file, bytes: used, sha256: sha256(bytes) });
      page = new Uint8Array(pageBytes);
      used = 0;
    };
    for (const input of inputs) {
      const png = readOverviewFramePackFile(
        join(assetDir, input.name),
        ASSET_LIMITS.encodedBytes,
      );
      const raw = decoder.decode(png);
      const sourceIndex = sources.length;
      sources.push({
        name: input.name,
        sha256: sha256(png),
        bytes: png.byteLength,
        width: raw.width,
        height: raw.height,
      });
      const image = registerTextureSource(
        Object.freeze({ width: raw.width, height: raw.height }),
        { pngBytes: png, rawRgba: raw },
      );
      const ids = overviewFrameRecipeIds({
        tileTypes: input.kind === "tile" ? [input.type] : [],
        wallTypes: input.kind === "wall" ? [input.type] : [],
      });
      for (const recipeId of ids) {
        const recipe = overviewFrameRecipe(recipeId);
        const frame = recipe.clip
          ? prepareCanonicalSlopeOverviewFrame(
              { ...recipe, dx: 0, dy: 0 },
              image,
            )
          : prepareRawOverviewFrame(recipe, image);
        if (!frame || frame.unsupported)
          throw new Error(
            `${input.name} recipe ${recipeId}: ${frame?.unsupported ?? "frame preparation failed"}`,
          );
        const flags =
          (frame.uvFlipApplied ? 1 : 0) |
          (frame.mean ? 2 : 0) |
          ((frame.clipShape ?? 0) << 8);
        const mean = frame.mean
          ? new DataView(frame.mean.buffer, frame.mean.byteOffset, 4).getUint32(
              0,
              true,
            )
          : 0;
        const payload = new Uint8Array(
          frame.base.byteLength + (frame.additive?.byteLength ?? 0),
        );
        payload.set(frame.base);
        if (frame.additive) payload.set(frame.additive, frame.base.byteLength);
        logicalPixelBytes += payload.byteLength;
        const key = `${frame.width},${frame.height},${flags},${mean},${frame.additive ? 1 : 0}:${sha256(payload)}`;
        let location = unique.get(key);
        if (!location) {
          if (used + payload.byteLength > pageBytes) flush();
          location = {
            pageId: pages.length,
            baseOffset: used,
            additiveOffset: frame.additive
              ? used + frame.base.byteLength
              : 0xffffffff,
          };
          page.set(payload, used);
          used += payload.byteLength;
          unique.set(key, location);
        }
        rows.push({
          recipeId,
          sourceIndex,
          ...location,
          width: frame.width,
          height: frame.height,
          flags,
          mean,
        });
        if (rows.length > LIMITS.frames)
          throw new Error("Overview frame pack frame limit exceeded");
      }
    }
    flush();
    rows.sort((a, b) => a.recipeId - b.recipeId);
    const index = new Uint8Array(
        rows.length * OVERVIEW_FRAME_PACK_RECORD_BYTES,
      ),
      view = new DataView(index.buffer);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i],
        p = i * OVERVIEW_FRAME_PACK_RECORD_BYTES;
      view.setUint32(p, r.recipeId, true);
      view.setUint16(p + 4, r.sourceIndex, true);
      view.setUint16(p + 6, r.pageId, true);
      view.setUint32(p + 8, r.baseOffset, true);
      view.setUint32(p + 12, r.additiveOffset, true);
      view.setUint16(p + 16, r.width, true);
      view.setUint16(p + 18, r.height, true);
      view.setUint32(p + 20, r.flags, true);
      view.setUint32(p + 24, r.mean, true);
    }
    writeFileSync(join(staging, "index.bin"), index, { flag: "wx" });
    const pixelBytes = pages.reduce((sum, p) => sum + p.bytes, 0);
    if (pixelBytes > LIMITS.pixelBytes)
      throw new Error("Overview frame pack pixel limit exceeded");
    const afterRuleHashes = overviewFramePackRuleHashes();
    if (
      Object.entries(ruleHashes).some(
        ([path, hash]) => afterRuleHashes[path] !== hash,
      )
    )
      throw new Error(
        "Overview frame pack preparation sources changed during compilation",
      );
    const sourceHashes = Object.fromEntries(
      sources.map((s) => [s.name, s.sha256]),
    );
    const manifest = {
      schema: OVERVIEW_FRAME_PACK_SCHEMA,
      bakeVersion: OVERVIEW_FRAME_PACK_BAKE_VERSION,
      recipeVersion: OVERVIEW_FRAME_RECIPE_VERSION,
      inputEncoding: "tconvert-game-raw",
      opaqueScene: true,
      baker: overviewFramePackBaker(),
      ruleHashes,
      sources,
      frames: rows.length,
      uniqueFrames: unique.size,
      logicalPixelBytes,
      pixelBytes,
      pageBytes,
      index: {
        file: "index.bin",
        bytes: index.byteLength,
        sha256: sha256(index),
        recordBytes: OVERVIEW_FRAME_PACK_RECORD_BYTES,
      },
      pages,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    if (manifestBytes.byteLength > LIMITS.manifestBytes)
      throw new Error("Overview frame pack manifest limit exceeded");
    writeFileSync(join(staging, "manifest.json"), manifestBytes, {
      flag: "wx",
    });
    const report = {
      schema: "exploretv-overview-frame-pack-build-v1",
      elapsedSeconds: (performance.now() - started) / 1000,
      processElapsedSeconds: process.uptime(),
      osPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      candidateSlots: rows.length,
      uniqueFrames: unique.size,
      logicalPixelBytes,
      pixelBytes,
      onDiskBytes: pixelBytes + index.byteLength + manifestBytes.byteLength,
      indexBytes: index.byteLength,
      manifestSha256: sha256(manifestBytes),
      pageCount: pages.length,
      sourceHashes,
      ruleHashes,
      recipeVersion: OVERVIEW_FRAME_RECIPE_VERSION,
      baker: manifest.baker,
      node: process.version,
      scope:
        "Resource compilation only. Runtime starts from a fresh process and includes manifest/index/page reads; changing source textures requires recompilation. onDiskBytes excludes this reporting JSON. OS peak includes the whole compiler process lifetime.",
    };
    writeFileSync(
      join(staging, "build-report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { flag: "wx" },
    );
    renameSync(staging, outputDir);
    return report;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [assetDir, outputDir, ...extra] = process.argv.slice(2);
  if (!assetDir || !outputDir || extra.length)
    throw new Error(
      "Usage: node scripts/build-overview-frame-pack.mjs <assetDir> <outputDir>",
    );
  console.log(
    JSON.stringify(buildOverviewFramePack({ assetDir, outputDir }), null, 2),
  );
}
