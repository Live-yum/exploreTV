import test from "node:test";
import assert from "node:assert/strict";
import { sceneFrameKey } from "../core/scene-frames.mjs";
import {
  createSceneFrameInterner,
  SCENE_FRAME_INTERN_LIMITS,
} from "../scripts/scene-frame-interner.mjs";

const tile = (extra = {}) => ({
  asset: "Tiles_1.png",
  kind: "tile",
  type: 1,
  sx: 0,
  sy: 0,
  sw: 16,
  sh: 16,
  paintId: 0,
  dx: 0,
  dy: 0,
  dw: 16,
  dh: 16,
  ...extra,
});
const outcome = (key, command) => {
  try {
    return { key: key(command) };
  } catch (error) {
    return { name: error.name, message: error.message };
  }
};

test("numeric frame interning preserves crop, kind, type, height and paint identity", () => {
  const interner = createSceneFrameInterner();
  const expectedKeys = new Set();
  for (const kind of ["tile", "wall"])
    for (const type of [0, 1, 255, 1023])
      for (const frameX of [0, 1, 7, 15])
        for (const frameY of [0, 1, 7, 15])
          for (const paintId of [0, 1, 15, 31])
            for (const sh of kind === "wall" ? [32] : [8, 16]) {
              const wall = kind === "wall";
              const command = tile({
                asset: `${wall ? "Wall" : "Tiles"}_${type}.png`,
                kind,
                type,
                sx: frameX * (wall ? 36 : 18),
                sy: frameY * (wall ? 36 : 18),
                sw: wall ? 32 : 16,
                sh,
                paintId,
              });
              const expected = sceneFrameKey(command);
              assert.ok(
                !expectedKeys.has(expected),
                "fixture keys are distinct",
              );
              expectedKeys.add(expected);
              assert.equal(interner.key(command), expected);
              assert.equal(interner.key({ ...command }), expected);
            }
  assert.equal(expectedKeys.size, 768);
  assert.equal(interner.stats.entries, expectedKeys.size);
  assert.equal(interner.stats.hits, expectedKeys.size);
  assert.equal(interner.stats.fallbacks, 0);
});

test("interning uses the public key's exact normalization and ignored-field semantics", () => {
  const interner = createSceneFrameInterner();
  const expected = sceneFrameKey(tile());
  for (const paintId of [undefined, null, false, "", NaN, -0, 0n])
    assert.equal(interner.key(tile({ paintId })), expected);
  assert.equal(
    interner.key(
      tile({
        dx: 999,
        dy: -100,
        dw: 32,
        dh: 99,
        opacity: 0.25,
        flipX: true,
        flipY: true,
        clip: [
          [0, 0],
          [16, 0],
          [0, 16],
        ],
        ownerType: 999,
        fidelity: "unrelated-diagnostic",
        vertexColor: false,
        vertexColors: null,
      }),
    ),
    expected,
  );
  const zero = tile({ type: -0, asset: "Tiles_0.png", sx: -0, sy: -0 });
  assert.equal(interner.key(zero), sceneFrameKey(zero));
  assert.equal(interner.stats.fallbacks, 0);
});

test("unclear names and field values use the unchanged formatter without numeric aliasing", () => {
  const interner = createSceneFrameInterner();
  const unusual = [
    { asset: "Tiles_01.png" },
    { asset: "Tiles_+1.png" },
    { asset: "Tiles_1.0.png" },
    { asset: "Tiles_1.PNG" },
    { asset: "Tiles_1.png:tile:1" },
    { asset: "Tiles_2.png" },
    { asset: "Wall_1.png" },
    { asset: "water_1.png" },
    { asset: 1 },
    { kind: "wall" },
    { kind: "tile:1" },
    { type: "1" },
    { type: new Number(1) },
    { type: -1 },
    { type: 1.5 },
    { type: NaN },
    { type: Infinity },
    { type: 1024, asset: "Tiles_1024.png" },
    { type: 2 ** 32 + 1 },
    { type: null },
    { type: undefined },
    { sx: "18" },
    { sx: new Number(18) },
    { sx: 1 },
    { sx: -18 },
    { sx: 288 },
    { sy: 1.5 },
    { sy: Infinity },
    { sy: NaN },
    { sw: "16" },
    { sw: 8 },
    { sh: "8" },
    { sh: 32 },
    { paintId: "1" },
    { paintId: 1n },
    { paintId: new Number(1) },
    { paintId: -1 },
    { paintId: 32 },
    { paintId: Infinity },
    { vertexColor: [255, 255, 255, 255] },
    { vertexColor: [] },
    { vertexColor: { unsupported: true } },
    { asset: Symbol("asset") },
    { type: Symbol("type") },
  ];
  interner.key(tile());
  for (const extra of unusual) {
    const command = tile(extra);
    assert.deepEqual(
      outcome(interner.key, command),
      outcome(sceneFrameKey, command),
    );
  }
  for (const command of [null, undefined, 7, "command", {}])
    assert.deepEqual(
      outcome(interner.key, command),
      outcome(sceneFrameKey, command),
    );
  assert.equal(interner.stats.fallbacks, unusual.length + 5);
  assert.equal(interner.stats.entries, 1);
});

test("corner color domains and tint changes retain the complete public key", () => {
  const interner = createSceneFrameInterner();
  const colors = {
    topLeft: [255, 255, 255, 255],
    topRight: [128, 64, 32, 255],
    bottomRight: [1, 2, 3, 128],
    bottomLeft: [0, 0, 0, 0],
  };
  for (const extra of [
    { vertexColors: colors },
    { vertexColors: colors, flipX: true },
    {
      vertexColors: colors,
      dx: 3.5,
      vertexDomain: { x: 0, y: 0, width: 32, height: 32 },
    },
    {
      vertexColors: colors,
      interpolation: "bilinear",
      inputEncoding: "standard-straight",
    },
    { vertexColor: [128, 255, 0, 64] },
  ]) {
    const command = tile(extra);
    assert.equal(interner.key(command), sceneFrameKey(command));
  }
  assert.equal(interner.stats.fallbacks, 5);
  assert.equal(interner.stats.entries, 0);
});

test("dictionary resets keep both namespaces and strings bounded", () => {
  for (const limits of [
    { maxEntries: 5, maxBytes: 4096 },
    { maxEntries: 8192, maxBytes: 512 },
  ]) {
    const interner = createSceneFrameInterner(limits);
    for (let type = 0; type < 40; type++) {
      const command = tile({ asset: `Tiles_${type}.png`, type });
      assert.equal(interner.key(command), sceneFrameKey(command));
      assert.equal(interner.key({ ...command }), sceneFrameKey(command));
      assert.ok(
        interner.stats.entries + interner.stats.assetEntries <=
          limits.maxEntries,
      );
      assert.ok(interner.stats.estimatedBytes <= limits.maxBytes);
    }
    assert.ok(interner.stats.clears > 0);
    assert.equal(interner.stats.hits, 40);
  }
  const tiny = createSceneFrameInterner({ maxEntries: 1, maxBytes: 1 });
  assert.equal(tiny.key(tile()), sceneFrameKey(tile()));
  assert.equal(tiny.stats.bypasses, 1);
  assert.equal(tiny.stats.entries + tiny.stats.assetEntries, 0);
});

test("invalid budgets and use after disposal are explicit", () => {
  for (const value of [
    0,
    -1,
    1.5,
    Infinity,
    SCENE_FRAME_INTERN_LIMITS.maxEntries + 1,
  ])
    assert.throws(
      () => createSceneFrameInterner({ maxEntries: value }),
      /interner budget/,
    );
  for (const value of [
    0,
    -1,
    1.5,
    Infinity,
    SCENE_FRAME_INTERN_LIMITS.maxBytes + 1,
  ])
    assert.throws(
      () => createSceneFrameInterner({ maxBytes: value }),
      /interner budget/,
    );
  const interner = createSceneFrameInterner();
  interner.key(tile());
  interner.dispose();
  interner.dispose();
  assert.equal(interner.stats.entries, 0);
  assert.equal(interner.stats.assetEntries, 0);
  assert.equal(interner.stats.estimatedBytes, 0);
  assert.throws(() => interner.key(tile()), /interner is disposed/);
});
