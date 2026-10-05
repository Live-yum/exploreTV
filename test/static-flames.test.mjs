import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { createCanvas } from "@napi-rs/canvas";
import {
  openWorld,
  Reader,
  decodeRecord,
  getWorldTileAccessor,
} from "../core/world.mjs";
import { registerTextureSource } from "../core/assets.mjs";
import { prepareSceneFrames } from "../core/scene-frames.mjs";
import { renderScene } from "../core/renderer.mjs";
import {
  planStaticFlames,
  nextStaticFlameInt,
  STATIC_FLAME_STATE,
  STATIC_FLAME_TILES,
  STATIC_FLAME_ASSETS,
} from "../core/static-flames.mjs";

const f32 = Math.fround;
const air = () => ({ active: false, type: 0, shape: 0 });
const tile = (type, frameX = 0, frameY = 0, extra = {}) => ({
  active: true,
  type,
  frameX,
  frameY,
  shape: 0,
  ...extra,
});
const one = (t, options = {}, wx = 100, wy = 700) =>
  planStaticFlames(
    { rect: { x: wx, y: wy, width: 1, height: 1 }, cells: [t] },
    0,
    0,
    t,
    options,
  );
function object(
  type,
  style,
  { off = false, wx = 100, wy = 700, above = air() } = {},
) {
  const width = type === 34 ? 3 : 1,
    height = type === 34 ? 3 : 2;
  const fx =
    type === 34 ? Math.floor(style / 37) * 108 + (off ? 54 : 0) : off ? 18 : 0;
  const fy = type === 34 ? (style % 37) * 54 : style * 36;
  const region = {
    rect: { x: wx, y: wy, width, height },
    cells: [],
    getWorldTile: (x, y) => (x === wx && y === wy - 1 ? above : null),
  };
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++)
      region.cells[x * height + y] = tile(type, fx + x * 18, fy + y * 18);
  return {
    region,
    plan: (x = 0, y = 0, options = {}) =>
      planStaticFlames(region, x, y, region.cells[x * height + y], options),
  };
}
const stylePlan = (type, style, options) =>
  [34, 42].includes(type)
    ? object(type, style).plan(0, 0, options)
    : one(
        tile(type, 0, style * { 33: 22, 49: 22, 93: 54, 100: 36 }[type]),
        options,
      );
const offsets = (p) => p.commands.map((c) => [c.offsetX, c.offsetY]);

// Independent arbitrary-precision source arithmetic used only by Node tests.
// Production code has no BigInt syntax or dependency.
function referenceRandom(low, high) {
  let seed = (BigInt(high) << 32n) | BigInt(low);
  const next = () => {
    seed = (seed * 25214903917n + 11n) & ((1n << 48n) - 1n);
    return seed >> 17n;
  };
  return {
    next(min, max) {
      const bound = BigInt(max - min);
      if ((bound & -bound) === bound)
        return Number((bound * next()) >> 31n) + min;
      let bits, value;
      do {
        bits = next();
        value = bits % bound;
      } while (bits - value + bound - 1n > 2147483647n);
      return Number(value) + min;
    },
    state: () => ({
      low: Number(seed & 0xffffffffn),
      high: Number(seed >> 32n),
    }),
  };
}

test("48-bit source RNG preserves high words, signed rejection and exclusive bounds without BigInt", () => {
  const source = readFileSync(
    new URL("../core/static-flames.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bBigInt\s*\(|\b\d+n\b/);
  for (const initial of [
    { low: 0, high: 0 },
    { low: 700, high: 100 },
    { low: 0xffffffff, high: 0xffffffff },
    { low: 0x80000000, high: 0x80010000 },
    { low: 3883674281, high: 43461 }, // First next31 = int.MaxValue, reject for bound21.
  ]) {
    const seed = { ...initial },
      reference = referenceRandom(seed.low, seed.high);
    const bounds = [
      [-10, 11],
      [-10, 1],
      [-1, 1],
      [0, 0],
      [90, 111],
      [-20, 1],
      [0, 1073741825],
    ];
    for (let k = 0; k < 200; k++) {
      const [min, max] = bounds[k % bounds.length];
      assert.equal(
        nextStaticFlameInt(seed, min, max),
        reference.next(min, max),
      );
      assert.deepEqual(seed, reference.state());
    }
  }
  for (const args of [
    [{}, 0, 5],
    [{ low: -1, high: 0 }, 0, 5],
    [{ low: 0, high: 0 }, 5, 4],
  ])
    assert.throws(() => nextStaticFlameInt(...args), /range or seed/);
});

test("frozen seed zero has independently calculated golden candle draw sequence", () => {
  assert.deepEqual(STATIC_FLAME_STATE, {
    tileFrameSeedLow: 0,
    tileFrameSeedHigh: 0,
    globalTimeWrappedHourly: 0,
    wind: 0,
  });
  const p = one(tile(33));
  const expectedIntegers = [
    [-8, -1],
    [0, -8],
    [0, -1],
    [0, -2],
    [-7, -9],
    [7, -8],
    [-10, -9],
  ];
  assert.deepEqual(
    offsets(p),
    expectedIntegers.map(([x, y]) => [
      f32(x * f32(0.15)),
      -4 + f32(y * f32(0.35)),
    ]),
  );
  assert.equal(p.sourceDrawCount, 7);
  for (const c of p.commands) {
    assert.deepEqual(
      [c.asset, c.sx, c.sy, c.sw, c.sh],
      ["Flame_1.png", 0, 0, 16, 20],
    );
    assert.deepEqual(c.vertexColor, [100, 100, 100, 0]);
    assert.equal(c.paintId, 0);
    assert.equal(c.staticOverlay, true);
  }
  assert.deepEqual(p, one(tile(33)));
  assert.notDeepEqual(offsets(p), offsets(one(tile(33), {}, 101, 700)));
});

test("source style recipes retain all distinct legacy counts and tint values", () => {
  for (const [type, styles] of [
    [
      33,
      [
        [0, 7, 100],
        [5, 7, 50],
        [6, 7, 50],
        [7, 7, 50],
        [8, 7, 50],
        [10, 7, 50],
        [12, 7, 50],
        [14, 8, 75],
        [16, 4, 75],
        [27, 1, 75],
        [28, 1, 75],
      ],
    ],
    [
      34,
      [
        [0, 7, 100],
        [8, 7, 50],
        [9, 3, 50],
        [11, 7, 50],
        [15, 7, 50],
        [17, 7, 50],
        [18, 8, 75],
        [20, 7, 50],
        [34, 1, 75],
        [35, 1, 75],
      ],
    ],
    [
      42,
      [
        [0, 0],
        [1, 7, 100],
        [2, 7, 50],
        [11, 7, 50],
        [29, 7, 100],
        [34, 1, 75],
        [35, 1, 75],
        [44, 7, 100],
      ],
    ],
    [
      93,
      [
        [0, 7, 100],
        [1, 3, 50],
        [2, 7, 50],
        [3, 7, 100],
        [4, 7, 50],
        [5, 7, 50],
        [9, 7, 50],
        [13, 8, 75],
        [28, 1, 75],
        [29, 1, 75],
      ],
    ],
    [
      100,
      [
        [0, 7, 100],
        [3, 3, 50],
        [6, 5, 75],
        [9, 7, 100],
        [11, 7, 50],
        [13, 8, 75],
        [28, 1, 75],
        [29, 1, 75],
      ],
    ],
    [49, [[0, 7, 100]]],
  ])
    for (const [style, count, shade] of styles) {
      const p = stylePlan(type, style);
      assert.equal(p.unsupported, undefined, `${type}:${style}`);
      assert.equal(p.commands.length, count, `${type}:${style}`);
      for (const c of p.commands)
        assert.deepEqual(
          c.vertexColor,
          [shade, shade, shade, 0],
          `${type}:${style}`,
        );
    }
});

test("actual hanging path preserves chandelier style9 and shared object seed across ROI boundaries", () => {
  const o = object(34, 9),
    p = o.plan();
  assert.deepEqual(offsets(p), [
    [-2, -2],
    [-2, -2],
    [-2, -2],
  ]);
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 3; y++) {
      assert.deepEqual(offsets(o.plan(x, y)), offsets(p));
      const t = o.region.cells[x * 3 + y];
      const sliced = {
        rect: { x: 100 + x, y: 700 + y, width: 1, height: 1 },
        cells: [t],
        context: o.region,
      };
      assert.deepEqual(planStaticFlames(sliced, 0, 0, t), o.plan(x, y));
    }
  const t = o.region.cells[8];
  assert.match(one(t, {}, 102, 702).unsupported, /anchor halo/);
  const incomplete = {
    rect: { x: 102, y: 702, width: 1, height: 1 },
    cells: [t],
    getWorldTile: (x, y) => (x === 100 && y === 700 ? o.region.cells[0] : null),
  };
  assert.match(
    planStaticFlames(incomplete, 0, 0, t).unsupported,
    /seed-selection halo/,
  );
});

test("every legacy jitter recipe matches source integer ranges and float multipliers", () => {
  // Each row is an independently transcribed source fact: types, style list,
  // draw count, X multiplier, Y multiplier, Y minimum, Y exclusive maximum.
  const facts = [
    [33, [5, 6, 7, 10], 7, 0.075, 0.075, -10, 11],
    [33, [8], 7, 0.3, 0.3, -10, 11],
    [33, [12], 7, 0.1, 0.15, -10, 1],
    [33, [14], 8, 0.1, 0.1, -10, 11],
    [33, [16], 4, 0.15, 0.15, -10, 11],
    [34, [8, 17, 20], 7, 0.075, 0.075, -10, 11],
    [34, [11], 7, 0.3, 0.3, -10, 11],
    [34, [15], 7, 0.1, 0.15, -10, 1],
    [34, [18], 8, 0.1, 0.1, -10, 11],
    [
      42,
      [1, 3, 6, 8, 19, 27, 29, 30, 31, 32, 36, 39, 44, 53, 57, 60, 62, 66, 69],
      7,
      0.15,
      0.35,
      -10,
      1,
    ],
    [42, [2, 16, 25], 7, 0.15, 0.1, -10, 1],
    [42, [11], 7, 0.075, 0.075, -10, 11],
    [93, [1], 3, 0.15, 0.15, -10, 11],
    [93, [2, 4], 7, 0.075, 0.075, -10, 11],
    [93, [3], 7, 0.2, 0.35, -20, 1],
    [93, [5], 7, 0.3, 0.3, -10, 11],
    [93, [9], 7, 0.1, 0.15, -10, 1],
    [93, [13], 8, 0.1, 0.1, -10, 11],
    [100, [3], 3, 0.05, 0.15, -10, 11],
    [100, [6], 5, 0.15, 0.15, -10, 11],
    [100, [9], 7, 0.3, 0.3, -10, 11],
    [100, [11], 7, 0.1, 0.15, -10, 1],
    [100, [13], 8, 0.1, 0.1, -10, 11],
  ];
  for (const [type, styles, count, mx, my, yMin, yMax] of facts)
    for (const style of styles) {
      const reference = referenceRandom(700, 100),
        baseY = type === 33 ? -4 : [34, 42].includes(type) ? -2 : 2;
      const expected = Array.from({ length: count }, () => [
        f32(reference.next(-10, 11) * f32(mx)),
        baseY + f32(reference.next(yMin, yMax) * f32(my)),
      ]);
      assert.deepEqual(
        offsets(stylePlan(type, style)),
        expected,
        `${type}:${style}`,
      );
    }
});

test("hanging visibility selects first visible seed, including the source zero-seed sentinel", () => {
  const o = object(34, 0);
  o.region.cells[0].invisibleBlock = true;
  const reference = one(tile(33), {}, 100, 701);
  assert.deepEqual(
    offsets(o.plan(2, 2)),
    offsets(reference).map(([x, y]) => [x, y + 2]),
  );
  assert.notDeepEqual(
    offsets(o.plan(2, 2, { revealInvisible: true })),
    offsets(o.plan(2, 2)),
  );
  const atOrigin = object(34, 0, { wx: 0, wy: 0 });
  assert.notDeepEqual(
    offsets(atOrigin.plan(0, 0)),
    offsets(atOrigin.plan(0, 1)),
  );
  assert.deepEqual(offsets(atOrigin.plan(0, 1)), offsets(atOrigin.plan(2, 2)));
});

test("lantern crop wrapping, ceiling platform displacement and source no-flame styles", () => {
  const p = object(42, 57).plan(0, 1);
  assert.equal(p.commands.length, 7);
  assert.deepEqual(
    [p.commands[0].sx, p.commands[0].sy, p.commands[0].sh],
    [36, 54, 16],
  );
  const platform = object(42, 57, { above: tile(19) }).plan(0, 1);
  assert.deepEqual(
    offsets(platform),
    offsets(p).map(([x, y]) => [x, y - 8]),
  );
  for (const shape of [1, 2, 3, 4, 5])
    assert.deepEqual(
      offsets(object(42, 57, { above: tile(19, 0, 0, { shape }) }).plan(0, 1)),
      offsets(p),
    );
  const noCeiling = object(42, 1);
  noCeiling.region.getWorldTile = undefined;
  assert.match(noCeiling.plan().unsupported, /ceiling anchor halo/);
  for (const style of [
    0, 4, 5, 7, 9, 10, 12, 13, 14, 15, 54, 55, 56, 58, 59, 61,
  ])
    assert.equal(object(42, style).plan().commands.length, 0, `style ${style}`);
});

test("single lamp random RGB and wrapped floor furniture preserve their actual call sites", () => {
  const p = stylePlan(93, 12);
  assert.equal(p.commands.length, 1);
  assert.deepEqual(p.commands[0].vertexColor, [100, 99, 100, 0]);
  assert.deepEqual(offsets(p), [
    [f32(-8 * f32(0.01)), 2 + f32(-10 * f32(0.01))],
  ]);
  assert.deepEqual(stylePlan(93, 13).commands[0].vertexColor, [75, 75, 75, 0]);
  for (const [type, style, sx, sy] of [
    [93, 47, 36, 540],
    [100, 57, 72, 36],
  ]) {
    const c = stylePlan(type, style).commands[0];
    assert.deepEqual([c.sx, c.sy], [sx, sy]);
  }
});

test("new furniture recipes freeze time colors and keep genuine zero-count styles", () => {
  for (const [type, base] of [
    [33, 43],
    [34, 50],
    [42, 50],
    [93, 44],
    [100, 44],
  ]) {
    for (const [relative, expected, count] of [
      [0, [150, 75, 75, 50], 1],
      [1, [200, 200, 200, 150], 3],
      [2, [170, 85, 85, 75], 1],
      [13, [191, 191, 191, 0], 1],
      [14, [200, 200, 200, 150], 1],
      [15, [63, 63, 63, 0], 1],
      [17, [200, 200, 200, 150], 1],
      [18, [63, 63, 63, 0], 1],
      [20, [63, 63, 63, 0], 1],
    ]) {
      const p = stylePlan(type, base + relative);
      assert.equal(p.commands.length, count, `${type}:${base + relative}`);
      for (const c of p.commands) assert.deepEqual(c.vertexColor, expected);
    }
    for (const relative of [4, 5, 6, 8, 9, 11]) {
      const p = stylePlan(type, base + relative);
      assert.equal(p.sourceDrawCount, 0);
      assert.deepEqual(p.commands, []);
    }
    const p = stylePlan(type, base, {
      state: { ...STATIC_FLAME_STATE, globalTimeWrappedHourly: 1 },
    });
    assert.deepEqual(p.commands[0].vertexColor, [150, 150, 150, 50]);
  }
});

test("switched-off sprites retain source commands and texture requirements for custom packs", () => {
  for (const t of [tile(33, 18), tile(93, 18), tile(100, 36)]) {
    const p = one(t);
    assert.equal(p.offState, true);
    assert.equal(p.commands.length, 7);
    assert.equal(p.commands[0].sx, t.frameX);
  }
  for (const type of [34, 42]) {
    const p = object(type, 1, { off: true }).plan();
    assert.equal(p.offState, true);
    assert.equal(p.commands.length, 7);
    const renderPlan = { commands: p.commands, warnings: [] };
    assert.throws(
      () => renderScene({}, renderPlan, {}, { strict: true }),
      /Missing textures/,
    );
  }
  assert.match(one(tile(49, 18)).unsupported, /texture bounds/);
});

test("procedural off-state atlas produces its exact tinted additive pixels through the scene adapter", () => {
  const source = createCanvas(36, 616),
    raw = new Uint8ClampedArray(36 * 616 * 4);
  for (let y = 594; y < 614; y++)
    for (let x = 18; x < 34; x++)
      raw.set([85, 170, 255, 255], (y * 36 + x) * 4);
  registerTextureSource(source, {
    pngBytes: new Uint8Array(),
    rawRgba: { width: 36, height: 616, data: raw },
  });
  const p = one(tile(33, 18, 594));
  const plan = {
    width: 48,
    height: 48,
    warnings: [],
    commands: p.commands.map((c) => ({
      ...c,
      kind: "tile",
      dx: 16 + c.offsetX,
      dy: 16 + c.offsetY,
      dw: c.sw,
      dh: c.sh,
    })),
  };
  const assets = new Map([["Flame_1.png", source]]);
  const frames = prepareSceneFrames(plan, assets, createCanvas, {
    inputEncoding: "tconvert-game-raw",
    opaqueScene: true,
  });
  const canvas = createCanvas(48, 48);
  const result = renderScene(canvas.getContext("2d"), plan, assets, {
    strict: true,
    sceneFrames: frames,
  });
  assert.equal(result.drawn, 1);
  assert.equal(result.skippedEffects, 0);
  const rgba = canvas.getContext("2d").getImageData(0, 0, 48, 48).data;
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 48; x++) {
      const i = (y * 48 + x) * 4;
      assert.deepEqual(
        [...rgba.subarray(i, i + 4)],
        x >= 16 && x < 32 && y >= 12 && y < 32
          ? [25, 50, 75, 255]
          : [0, 0, 0, 255],
      );
    }
  frames.dispose();
});

test("malformed coordinates, unknown styles, shapes and unfrozen state reject explicitly", () => {
  assert.equal(one(tile(4)), null);
  for (const t of [
    tile(33, -1),
    tile(33, 0, -22),
    tile(33, 0, 23),
    tile(34, 1),
    tile(33, 0, 64 * 22),
  ])
    assert.ok(one(t).unsupported);
  assert.match(one(tile(33, 0, 0, { shape: 1 })).unsupported, /half-block/);
  assert.match(
    planStaticFlames(null, 0, 0, tile(33)).unsupported,
    /coordinates/,
  );
  assert.match(
    one(tile(33), { state: { ...STATIC_FLAME_STATE, wind: 1 } }).unsupported,
    /zero wind/,
  );
  assert.match(
    one(tile(33), { state: { ...STATIC_FLAME_STATE, tileFrameSeedLow: -1 } })
      .unsupported,
    /frozen seed/,
  );
  assert.equal(one(tile(33, 0, 0, { invisibleBlock: true })).hidden, true);
  assert.equal(
    one(tile(33, 0, 0, { invisibleBlock: true }), { revealInvisible: true })
      .commands.length,
    7,
  );
});

const hashes = {
  "Flame_1.png":
    "eb39a5b75dad1d73579d91916e59c8a0e28cfa01b652755f1f0ee5c78182f39b",
  "Flame_2.png":
    "a2ae91df9448d8c41e43b82f9a632f2b08e2c0d8bd6a0c11b99963db001b6db9",
  "Flame_3.png":
    "e8d89570467e74dfc17cc588c54e9a3d18b57b5178629afc5b70dff3d7867677",
  "Flame_4.png":
    "9b0febccc0a81f0bb7d931d022277ebc674c2416aab4d33f4116f924bca39200",
  "Flame_5.png":
    "e661d5c8700c9283f52c99b880da20076315a27fa0473da3bd7096c76c731cfe",
  "Flame_13.png":
    "3b4def43c596a11e2eae1faf65542b33b3ab8486dd8d27c485679e60f98674e2",
};
function assetPath(name) {
  for (const directory of [
    "../example/assets/",
    "../fixtures/private/static-flames/",
  ]) {
    const path = new URL(directory + name, import.meta.url);
    if (existsSync(path)) return path;
  }
  return null;
}
const worldPath = new URL("../fixtures/example-world.wld", import.meta.url);
test(
  "pinned fixture: all1747 cells retain12229 commands, valid crops and unchanged off-state channels",
  {
    skip:
      !existsSync(worldPath) ||
      Object.keys(hashes).some((name) => !assetPath(name)),
  },
  () => {
    const bytes = readFileSync(worldPath);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab",
    );
    const w = openWorld(bytes),
      lookup = getWorldTileAccessor(w),
      assets = new Map();
    for (const type of STATIC_FLAME_TILES) {
      const a = STATIC_FLAME_ASSETS[type],
        b = readFileSync(assetPath(a.asset));
      assert.equal(
        createHash("sha256").update(b).digest("hex"),
        hashes[a.asset],
      );
      const png = PNG.sync.read(b);
      assert.deepEqual([png.width, png.height], [a.width, a.height]);
      assets.set(a.asset, png);
    }
    const counts = {},
      off = {},
      rejected = {},
      crops = {},
      rr = new Reader(w.bytes, w.sections[2]);
    let supportedCells = 0,
      commandCount = 0;
    for (let x = 0; x < w.width; x++) {
      rr.pos = w.columns[x];
      for (let y = 0; y < w.height; ) {
        const { tile: t, repeats } = decodeRecord(rr, w.important);
        if (t.active && STATIC_FLAME_TILES.includes(t.type))
          for (let yy = y; yy <= y + repeats; yy++) {
            counts[t.type] = (counts[t.type] || 0) + 1;
            const region = {
              rect: { x, y: yy, width: 1, height: 1 },
              cells: [t],
              getWorldTile: lookup,
            };
            const p = planStaticFlames(region, 0, 0, t);
            if (p.unsupported) {
              rejected[p.unsupported] = (rejected[p.unsupported] || 0) + 1;
              continue;
            }
            supportedCells++;
            commandCount += p.commands.length;
            if (p.offState) off[t.type] = (off[t.type] || 0) + 1;
            assert.equal(p.commands.length, p.sourceDrawCount);
            for (const c of p.commands) {
              const a = assets.get(c.asset);
              assert.ok(
                c.sx >= 0 &&
                  c.sy >= 0 &&
                  c.sx + c.sw <= a.width &&
                  c.sy + c.sh <= a.height,
              );
              const b = (crops[c.asset] ??= {
                minX: c.sx,
                minY: c.sy,
                maxX: 0,
                maxY: 0,
                commands: 0,
              });
              b.minX = Math.min(b.minX, c.sx);
              b.minY = Math.min(b.minY, c.sy);
              b.maxX = Math.max(b.maxX, c.sx + c.sw);
              b.maxY = Math.max(b.maxY, c.sy + c.sh);
              b.commands++;
              if (p.offState)
                for (let dy = 0; dy < c.sh; dy++)
                  for (let dx = 0; dx < c.sw; dx++) {
                    const i = ((c.sy + dy) * a.width + c.sx + dx) * 4;
                    assert.equal(
                      a.data[i] | a.data[i + 1] | a.data[i + 2] | a.data[i + 3],
                      0,
                    );
                  }
            }
          }
        y += repeats + 1;
      }
    }
    assert.deepEqual(counts, {
      33: 5,
      34: 1440,
      42: 108,
      49: 28,
      93: 78,
      100: 88,
    });
    assert.deepEqual(off, { 34: 1332, 42: 28, 93: 3 });
    assert.deepEqual(rejected, {});
    assert.equal(supportedCells, 1747);
    assert.equal(commandCount, 12229);
    mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
    writeFileSync(
      new URL("../artifacts/static-flames-audit.json", import.meta.url),
      JSON.stringify(
        {
          sourceRevision: "8255d34616c780af12079425ac92a0a7aed87d71",
          state: STATIC_FLAME_STATE,
          worldSha256: createHash("sha256").update(bytes).digest("hex"),
          counts,
          off,
          supportedCells,
          rejected,
          commandCount,
          crops,
          assets: hashes,
          oracle: "source facts and frozen planner, not a game screenshot",
        },
        null,
        2,
      ) + "\n",
    );
  },
);
