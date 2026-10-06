import test from "node:test";
import assert from "node:assert/strict";
import { createSceneFrameInterner } from "../scripts/scene-frame-interner.mjs";
import { createSceneCommandIndex } from "../scripts/scene-command-index.mjs";
import { sceneFrameKey } from "../core/scene-frames.mjs";

const tile = (extra = {}) => ({
  kind: "tile",
  type: 1,
  asset: "Tiles_1.png",
  sx: 0,
  sy: 0,
  sw: 16,
  sh: 16,
  paintId: 0,
  ...extra,
});

test("ordinary numeric IDs preserve all frame fields without string dictionaries", () => {
  const cache = createSceneFrameInterner({ numericIds: true });
  const ids = new Map();
  for (const wall of [false, true])
    for (const type of [0, 1, 511, 1023])
      for (let x = 0; x < 16; x++)
        for (let y = 0; y < 16; y++)
          for (const paintId of [0, 1, 15, 31])
            for (const sh of wall ? [32] : [8, 16]) {
              const c = tile({
                kind: wall ? "wall" : "tile",
                type,
                asset: `${wall ? "Wall" : "Tiles"}_${type}.png`,
                sx: x * (wall ? 36 : 18),
                sy: y * (wall ? 36 : 18),
                sw: wall ? 32 : 16,
                sh,
                paintId,
              });
              const id = cache.key(c);
              assert.ok(Number.isSafeInteger(id) && id > 0 && id <= 2 ** 25);
              assert.ok(
                !ids.has(id),
                "each exact accepted frame gets a distinct ID",
              );
              ids.set(id, sceneFrameKey(c));
              assert.equal(
                cache.key({ ...c, dx: 100, dy: -10, opacity: 0.25 }),
                id,
              );
            }
  assert.equal(cache.stats.entries, 0);
  assert.equal(cache.stats.assetEntries, 8);
  assert.equal(cache.stats.fallbacks, 0);
});

test("numeric IDs remain stable across bounded namespace resets and keep fallback keys disjoint", () => {
  const cache = createSceneFrameInterner({
    numericIds: true,
    maxEntries: 1,
    maxBytes: 128,
  });
  const first = cache.key(tile());
  cache.key(tile({ type: 2, asset: "Tiles_2.png" }));
  assert.equal(cache.key(tile()), first);
  for (const extra of [
    { asset: "Tiles_01.png" },
    { type: "1" },
    { sx: -18 },
    { sx: 1 },
    { paintId: 32 },
    { vertexColor: [1, 2, 3, 4] },
    { sw: 17 },
    { sh: 32 },
  ]) {
    const c = tile(extra);
    assert.equal(cache.key(c), sceneFrameKey(c));
    assert.equal(typeof cache.key(c), "string");
  }
  assert.ok(cache.stats.assetEntries <= 1);
  assert.ok(cache.stats.estimatedBytes <= 128);
  cache.dispose();
  assert.throws(() => cache.key(tile()), /disposed/);
});

test("per-scene indices support frozen and duplicate commands and reject foreign records", () => {
  const a = tile(),
    b = Object.freeze(tile({ sx: 18 })),
    commands = [a, b, a];
  const before = Reflect.ownKeys(a);
  const index = createSceneCommandIndex(commands);
  assert.equal(index.indexOf(a), 2);
  assert.equal(index.indexOf(b), 1);
  index.set(a, 123);
  index.set(b, "fallback");
  assert.equal(index.get(a), 123);
  assert.equal(index.get(b), "fallback");
  assert.equal(index.indexOf({ ...a }), -1);
  assert.equal(index.get({}), undefined);
  assert.throws(() => index.set({}, 1), /absent/);
  index.dispose();
  index.dispose();
  assert.deepEqual(Reflect.ownKeys(a), before);
  assert.throws(() => index.get(a), /disposed/);
});

test("index views are independent and clean up validation failures", () => {
  const a = tile();
  const first = createSceneCommandIndex([a]);
  const second = createSceneCommandIndex([a]);
  first.set(a, 1);
  second.set(a, 2);
  assert.equal(first.get(a), 1);
  assert.equal(second.get(a), 2);
  first.dispose();
  assert.equal(second.get(a), 2);
  second.dispose();
  const before = Reflect.ownKeys(a);
  assert.throws(() => createSceneCommandIndex([a, null]), /entry/);
  assert.deepEqual(Reflect.ownKeys(a), before);
  assert.throws(() => createSceneCommandIndex(new Array(131073)), /budget/);
});

test("numeric frame identity honors texture re-registration in frame, metadata and native caches", async () => {
  const { createCanvas } = await import("@napi-rs/canvas");
  const { registerTextureSource } = await import("../core/assets.mjs");
  const { prepareSceneFrames, createSceneFrameCache } = await import(
    "../core/scene-frames.mjs"
  );
  const { createOverviewFrameMetadataCache } = await import(
    "../scripts/overview-fast-path.mjs"
  );
  const { createSoftwareOverview } = await import(
    "../scripts/software-overview.mjs"
  );
  const c = tile({ dx: 0, dy: 0, dw: 16, dh: 16 }),
    plan = { width: 16, height: 16, commands: [c] };
  const interner = createSceneFrameInterner({ numericIds: true }),
    id = interner.key(c),
    keys = new Map([[c, id]]);
  const source = createCanvas(16, 16),
    assets = new Map([[c.asset, source]]);
  const frameCache = createSceneFrameCache(),
    metadata = createOverviewFrameMetadataCache(),
    software = createSoftwareOverview();
  const region = { rect: { x: 0, y: 0, width: 1, height: 1 } };
  try {
    for (const color of [
      [127, 64, 31, 255],
      [11, 42, 225, 255],
    ]) {
      const pixels = new Uint8Array(16 * 16 * 4);
      for (let i = 0; i < pixels.length; i += 4) pixels.set(color, i);
      registerTextureSource(source, {
        pngBytes: new Uint8Array(),
        rawRgba: { width: 16, height: 16, data: pixels },
      });
      const view = metadata.view(assets, createCanvas, "tconvert-game-raw");
      assert.equal(
        view.get(c, id),
        undefined,
        "old source registration cannot provide metadata",
      );
      const frames = prepareSceneFrames(plan, assets, createCanvas, {
        frameCache,
        keyCache: keys,
        inputEncoding: "tconvert-game-raw",
        opaqueScene: true,
      });
      try {
        const frame = frames.resolve(c);
        assert.deepEqual(
          [...frame.base.getContext("2d").getImageData(0, 0, 1, 1).data],
          color,
        );
        assert.deepEqual(
          [...view.remember(c, id, frame, { mean: true }).mean],
          color,
        );
        const native = software.begin(plan, region.rect, region, assets, keys);
        if (native) {
          native.preparationCommands(plan.commands);
          native.drawBatch(plan.commands, frames);
          assert.deepEqual([...native.pixels.subarray(0, 4)], color);
          native.finish();
        }
      } finally {
        frames.dispose();
      }
    }
    assert.equal(
      interner.key(c),
      id,
      "source version does not change logical frame ID",
    );
  } finally {
    frameCache.dispose();
    metadata.dispose();
    software.dispose();
    interner.dispose();
    source.width = source.height = 1;
  }
});
