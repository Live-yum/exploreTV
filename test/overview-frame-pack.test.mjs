import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { registerTextureSource, textureSource } from "../core/assets.mjs";
import {
  overviewFrameRecipe,
  overviewFrameRecipeId,
  overviewFrameRecipeIds,
} from "../core/overview-frame-recipes.mjs";
import { buildOverviewFramePack } from "../scripts/build-overview-frame-pack.mjs";
import { openOverviewFramePack } from "../scripts/overview-frame-pack.mjs";
import { overviewFramePackSha256 as sha256 } from "../scripts/overview-frame-pack-format.mjs";
import { prepareRawOverviewFrame } from "../scripts/raw-overview-frame.mjs";
import { prepareCanonicalSlopeOverviewFrame } from "../scripts/direct-slope-overview-frame.mjs";
import { createRawTextureCache } from "../scripts/raw-texture-cache.mjs";

function fixture(t, { opaque = false, build = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "exploretv-frame-pack-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const assetDir = join(directory, "assets"),
    outputDir = join(directory, "pack");
  mkdirSync(assetDir);
  const sources = new Map();
  for (const [name, width, height] of [
    ["Tiles_1.png", 234, 90],
    ["Wall_2.png", 468, 180],
  ]) {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const alpha = opaque ? 255 : [0, 1, 17, 127, 254, 255][i % 6];
      data.set(
        opaque
          ? [73, 119, 203, alpha]
          : [(i * 13) & 255, (i * 31) & 255, (i * 71) & 255, alpha],
        i * 4,
      );
    }
    const pngBytes = PNG.sync.write(
      { width, height, data },
      { colorType: 6, inputColorType: 6 },
    );
    writeFileSync(join(assetDir, name), pngBytes);
    const image = registerTextureSource(Object.freeze({ width, height }), {
      pngBytes,
      rawRgba: { width, height, data },
    });
    sources.set(name, { image, pngBytes });
  }
  const report = build
    ? buildOverviewFramePack({ assetDir, outputDir, pageBytes: 8192 })
    : null;
  const open = () => {
    const pack = openOverviewFramePack({ packDir: outputDir });
    t.after(() => pack.dispose());
    for (const [name, { image, pngBytes }] of sources)
      assert.equal(
        pack.bindVerifiedSource(
          image,
          name,
          sha256(pngBytes),
          pngBytes.byteLength,
        ),
        true,
      );
    return pack;
  };
  return { directory, assetDir, outputDir, sources, report, open };
}
const ids = () => overviewFrameRecipeIds({ tileTypes: [1], wallTypes: [2] });
const commandFor = (shape = 0, variant = 0) =>
  overviewFrameRecipe(overviewFrameRecipeId("tile", 1, variant, shape));
function updateManifest(outputDir, change) {
  const path = join(outputDir, "manifest.json"),
    manifest = JSON.parse(readFileSync(path, "utf8"));
  change(manifest);
  writeFileSync(path, JSON.stringify(manifest));
}

test("resource-only pack reproduces all wall and six tile shapes, including additive bytes and paint 31", (t) => {
  const { report, sources, open } = fixture(t),
    pack = open();
  assert.equal(report.candidateSlots, 116);
  assert.equal(Object.keys(report.sourceHashes).length, 2);
  assert.ok(report.elapsedSeconds > 0 && report.osPeakRssBytes > 0);
  assert.equal(pack.stats.frames, 116);
  assert.equal(pack.stats.uniqueFrames, report.uniqueFrames);
  assert.equal(pack.stats.logicalPixelBytes, report.logicalPixelBytes);
  assert.equal(pack.stats.indexBytes, 116 * 32);
  const pages = new Map();
  let additiveFrames = 0;
  for (const id of ids()) {
    const c = overviewFrameRecipe(id),
      source = sources.get(c.asset).image;
    const descriptor = pack.lookup(source, id, c);
    assert.ok(descriptor, `recipe ${id}`);
    assert.equal(pack.lookup(source, c), descriptor);
    assert.equal(pack.lookup(source, { ...c, paintId: 31 }), descriptor);
    if (!pages.has(descriptor.pageId))
      pages.set(descriptor.pageId, pack.readPage(descriptor));
    const page = pages.get(descriptor.pageId),
      actual = pack.frame(descriptor, page);
    const expected = c.clip
      ? prepareCanonicalSlopeOverviewFrame({ ...c, dx: 0, dy: 0 }, source)
      : prepareRawOverviewFrame(c, source);
    assert.deepEqual(actual.base, expected.base, `${id} base`);
    assert.deepEqual(actual.additive, expected.additive, `${id} additive`);
    assert.deepEqual(actual.mean, expected.mean, `${id} mean`);
    assert.equal(actual.uvFlipApplied, !!expected.uvFlipApplied);
    assert.equal(actual.clipShape, expected.clipShape);
    assert.equal(actual.width, expected.width);
    assert.equal(actual.height, expected.height);
    assert.equal(actual.base.buffer, page.buffer);
    assert.equal(page.byteOffset, 0);
    assert.equal(page.buffer.byteLength, descriptor.pageBytes);
    if (actual.additive) {
      additiveFrames++;
      assert.equal(actual.additive.buffer, page.buffer);
    }
  }
  assert.ok(additiveFrames > 64);
  assert.equal(pack.stats.pageReads, pages.size);
  assert.equal(pack.stats.pageBytesRead, pack.stats.pixelBytes);
  assert.equal(pack.stats.validationFailures, 0);
});

test("opaque means and duplicate content are exact; runtime never owns a second page cache", (t) => {
  const { open, report, sources } = fixture(t, { opaque: true }),
    pack = open();
  assert.equal(report.uniqueFrames, 7);
  assert.ok(report.pixelBytes < report.logicalPixelBytes);
  const c = commandFor(),
    descriptor = pack.lookup(sources.get(c.asset).image, c);
  const first = pack.readPage(descriptor),
    second = pack.readPage(descriptor);
  assert.notEqual(first.buffer, second.buffer);
  assert.deepEqual(first, second);
  assert.deepEqual(
    [...pack.frame(descriptor, first).mean],
    [73, 119, 203, 255],
  );
  assert.equal(pack.stats.pageReads, 2);
  assert.equal(pack.stats.pageBytesRead, 2 * descriptor.pageBytes);
  assert.throws(() => pack.frame(descriptor, first.slice()), /unverified page/);
  assert.throws(() => pack.frame({ ...descriptor }, first), /unverified page/);
  assert.throws(
    () => pack.readPage({ ...descriptor }),
    /foreign page descriptor/,
  );
  pack.dispose();
  assert.throws(() => pack.readPage(descriptor), /disposed/);
});

test("recipe lookup rejects changed shader, crop, shape, asset, registration and source identity", (t) => {
  const { open, sources } = fixture(t),
    pack = open(),
    c = commandFor();
  const { image, pngBytes } = sources.get(c.asset),
    id = overviewFrameRecipeId("tile", 1, 0);
  assert.ok(pack.lookup(image, id, c));
  for (const edit of [
    { asset: "Wall_2.png" },
    { sx: c.sx + 1 },
    { sw: 15 },
    { dh: 15 },
    { type: 2 },
    { kind: "liquid" },
    { paintId: 2 },
    { paintId: NaN },
    { opacity: 0.5 },
    { opacity: NaN },
    { flipX: true },
    { flipY: true },
    { vertexColor: [1, 1, 1, 1] },
    { vertexColors: [] },
    { shape: 2 },
    {
      clip: [
        [0, 0],
        [16, 16],
        [0, 15],
      ],
    },
  ]) {
    assert.equal(
      pack.lookup(image, { ...c, ...edit }),
      null,
      JSON.stringify(edit),
    );
    assert.equal(
      pack.lookup(image, id, { ...c, ...edit }),
      null,
      JSON.stringify(edit),
    );
  }
  assert.equal(
    pack.lookup(image, overviewFrameRecipeId("tile", 1, 1), c),
    null,
  );
  assert.equal(pack.lookup(sources.get("Wall_2.png").image, c), null);
  const unrelated = registerTextureSource(
    { width: image.width, height: image.height },
    { pngBytes },
  );
  assert.equal(pack.lookup(unrelated, c), null);
  assert.equal(
    pack.bindVerifiedSource(
      unrelated,
      c.asset,
      "0".repeat(64),
      pngBytes.length,
    ),
    false,
  );
  registerTextureSource(image, { pngBytes });
  assert.equal(pack.lookup(image, c), null);
});

test("compiled source snapshots avoid eager atlas decoding but preserve lazy fallback and hashes", (t) => {
  const { open, sources, assetDir } = fixture(t),
    pack = open();
  writeFileSync(
    join(assetDir, "uncovered.png"),
    sources.get("Tiles_1.png").pngBytes,
  );
  const cache = createRawTextureCache({ assetDir, framePack: pack });
  t.after(() => cache.dispose());
  const assets = cache.assetsFor(["Tiles_1.png", "Wall_2.png"]);
  t.after(() => assets.dispose());
  assert.equal(cache.stats.rawDecodes, 0);
  assert.equal(cache.stats.rawBytes, 0);
  assert.equal(cache.stats.compiledSourceSnapshots, 2);
  assert.equal(
    cache.assetHashes["Tiles_1.png"],
    pack.stats.sourceHashes["Tiles_1.png"],
  );
  const source = assets.assets.get("Tiles_1.png"),
    c = commandFor();
  assert.ok(pack.lookup(source, c));
  assert.ok(textureSource(source).rawRgba.data.length > 0);
  assert.equal(cache.stats.rawDecodes, 1);
  const other = cache.assetsFor(["uncovered.png", "absent.png"]);
  t.after(() => other.dispose());
  assert.equal(other.assets.size, 1);
  assert.equal(cache.stats.rawDecodes, 2);
  assert.equal(pack.lookup(other.assets.get("uncovered.png"), c), null);
});

test("changed or malformed PNG snapshots cannot inherit old compiled validation", (t) => {
  const { open, sources, assetDir } = fixture(t),
    pack = open();
  writeFileSync(
    join(assetDir, "Tiles_1.png"),
    sources.get("Wall_2.png").pngBytes,
  );
  const broken = Buffer.from(sources.get("Wall_2.png").pngBytes);
  broken[broken.length - 1] ^= 1;
  writeFileSync(join(assetDir, "Wall_2.png"), broken);
  const cache = createRawTextureCache({ assetDir, framePack: pack });
  t.after(() => cache.dispose());
  const view = cache.assetsFor(["Tiles_1.png", "Wall_2.png"]);
  t.after(() => view.dispose());
  assert.equal(cache.stats.compiledSourceSnapshots, 0);
  assert.equal(view.assets.has("Tiles_1.png"), true);
  assert.equal(view.assets.has("Wall_2.png"), false);
  assert.match(cache.assetFailures["Wall_2.png"], /CRC|checksum/i);
  assert.equal(pack.lookup(view.assets.get("Tiles_1.png"), commandFor()), null);
  assert.equal(pack.stats.validationFailures, 2);
});

test("pack pages are size checked and hashed at read time; previously verified pages remain immutable snapshots", (t) => {
  const { outputDir, open, sources } = fixture(t),
    pack = open(),
    c = commandFor();
  const descriptor = pack.lookup(sources.get(c.asset).image, c),
    verified = pack.readPage(descriptor);
  const path = join(
      outputDir,
      `page-${String(descriptor.pageId).padStart(5, "0")}.bin`,
    ),
    broken = Buffer.from(verified);
  broken[0] ^= 1;
  writeFileSync(path, broken);
  assert.throws(() => pack.readPage(descriptor), /page hash/);
  assert.equal(
    pack.frame(descriptor, verified).base[0],
    verified[descriptor.baseOffset],
  );
  writeFileSync(path, broken.subarray(1));
  assert.throws(() => pack.readPage(descriptor), /file size/);
  assert.equal(pack.stats.validationFailures, 2);
});

test("manifest binds pixel preparation rules, encoding, source crop and index content", (t) => {
  const { outputDir } = fixture(t);
  const manifestPath = join(outputDir, "manifest.json"),
    original = readFileSync(manifestPath);
  for (const change of [
    (m) => {
      m.inputEncoding = "standard-straight";
    },
    (m) => {
      m.bakeVersion++;
    },
    (m) => {
      m.ruleHashes[Object.keys(m.ruleHashes)[0]] = "0".repeat(64);
    },
    (m) => {
      m.baker.canvasVersion = "changed";
    },
    (m) => {
      m.sources[0].width = 16;
    },
    (m) => {
      m.index.sha256 = "0".repeat(64);
    },
    (m) => {
      m.pages[0].file = "../outside.bin";
    },
    (m) => {
      m.logicalPixelBytes++;
    },
  ]) {
    updateManifest(outputDir, change);
    assert.throws(
      () => openOverviewFramePack({ packDir: outputDir }),
      /Invalid overview frame pack/,
    );
    writeFileSync(manifestPath, original);
  }
  const indexPath = join(outputDir, "index.bin"),
    index = readFileSync(indexPath);
  index[0] ^= 1;
  writeFileSync(indexPath, index);
  assert.throws(
    () => openOverviewFramePack({ packDir: outputDir }),
    /index hash/,
  );
  assert.throws(
    () =>
      openOverviewFramePack({
        packDir: outputDir,
        inputEncoding: "standard-straight",
      }),
    /input encoding/,
  );
});

test("compiler refuses existing output and invalid source crops without publishing a partial package", (t) => {
  const { directory, assetDir, outputDir } = fixture(t, { build: false });
  writeFileSync(
    join(assetDir, "Tiles_1.png"),
    PNG.sync.write({ width: 16, height: 16, data: Buffer.alloc(1024) }),
  );
  assert.throws(
    () => buildOverviewFramePack({ assetDir, outputDir }),
    /source-crop-outside-texture/,
  );
  assert.deepEqual(readdirSync(directory), ["assets"]);
  mkdirSync(outputDir);
  assert.throws(
    () => buildOverviewFramePack({ assetDir, outputDir }),
    /already exists/,
  );
});
