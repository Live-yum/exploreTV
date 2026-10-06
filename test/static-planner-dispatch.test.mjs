import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { planScene, STATIC_TREE_TYPES } from "../core/renderer.mjs";
import {
  planStaticNature,
  STATIC_NATURE_TYPES,
} from "../core/static-nature.mjs";
import {
  planStaticObject,
  STATIC_OBJECT_TILES,
} from "../core/static-objects.mjs";
import { planStaticBlock, STATIC_BLOCK_TILES } from "../core/static-blocks.mjs";
import { planStaticMisc, STATIC_MISC_TILES } from "../core/static-misc.mjs";
import {
  planStaticFurnitureNext,
  STATIC_FURNITURE_NEXT_TILES,
} from "../core/static-furniture-next.mjs";
import {
  planStaticPlantsNext,
  STATIC_PLANTS_NEXT_TILES,
} from "../core/static-plants-next.mjs";
import {
  planStaticSpecialObject,
  STATIC_SPECIAL_OBJECT_TILES,
} from "../core/static-special-objects.mjs";

const tile = (type, extra = {}) => ({
  active: true,
  type,
  frameX: null,
  frameY: null,
  wall: 0,
  shape: 0,
  ...extra,
});
const region = (width, height, cells) => ({
  rect: { x: 100, y: 700, width, height },
  source: { width: 8400, height: 2400, worldSurface: 649 },
  cells,
});
function allTypes(extra = {}) {
  return region(
    29,
    26,
    Array.from({ length: 754 }, (_, i) => tile((i * 97) % 754, extra)),
  );
}
function specialObject(type, style = 0, direction = 0) {
  const width = type === 711 ? 2 : 3;
  const height = type === 237 || type === 711 ? 2 : 4;
  return region(
    width,
    height,
    Array.from({ length: width * height }, (_, i) =>
      tile(type, {
        frameX: style * width * 18 + Math.floor(i / height) * 18,
        frameY: direction * height * 18 + (i % height) * 18,
        paint: 3,
      }),
    ),
  );
}
function plantAndNature() {
  const r = region(
    9,
    12,
    Array.from({ length: 108 }, () => ({ active: false })),
  );
  const set = (x, y, t) => {
    r.cells[x * 12 + y] = t;
  };
  for (let y = 3; y < 8; y++) set(4, y, tile(80));
  set(4, 8, tile(53));
  set(3, 5, tile(80));
  set(3, 4, tile(80));
  set(6, 5, tile(51));
  set(7, 5, tile(1));
  set(2, 3, tile(52));
  set(2, 2, tile(2));
  set(6, 7, tile(656, { frameX: 0, frameY: 0 }));
  set(2, 8, tile(332));
  set(2, 9, tile(1));
  return r;
}
function treeScene() {
  const r = region(1, 1, [tile(5, { frameX: 22, frameY: 198 })]);
  r.rect.y = 500;
  r.treeContext = {
    treeX: [1923, 3451, 6191],
    treeTopVariations: [3, 0, 5, 4, 0, 2, 32, 3, 0, 0, 0, 0, 0],
    worldSurface: 649,
    worldWidth: 8400,
    worldHeight: 2400,
    hallowBG: 3,
  };
  r.getWorldTile = (x, y) =>
    x !== 100
      ? { active: false }
      : y < 520
        ? tile(5, { frameX: 0, frameY: 0 })
        : tile(2);
  return r;
}

// Tiny decoded regions from the public example world, SHA-256
// d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab. No world file is needed at test time.
const REAL_TILE_DEFAULTS = {
  active: false,
  type: 0,
  frameX: null,
  frameY: null,
  wall: 0,
  paint: 0,
  wallPaint: 0,
  liquid: 0,
  liquidKind: 0,
  shape: 0,
  wireRed: false,
  wireBlue: false,
  wireGreen: false,
  wireYellow: false,
  actuator: false,
  inactive: false,
  invisibleBlock: false,
  invisibleWall: false,
  fullbrightBlock: false,
  fullbrightWall: false,
};
const REAL_REGIONS = [
  {
    name: "cactus",
    rect: { x: 6432, y: 465, width: 5, height: 10 },
    source: { width: 8400, height: 2400, worldSurface: 649 },
    palette: [
      {},
      { active: true, type: 234, shape: 3 },
      { active: true, type: 199 },
      { active: true, wall: 2 },
      { active: true, type: 80 },
      { active: true, type: 234 },
      { active: true },
    ],
    indices: [
      0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 0, 4, 4, 4, 4, 0, 0, 5, 6, 3, 4, 4, 4, 4, 4,
      4, 5, 5, 5, 5, 0, 4, 4, 0, 0, 0, 5, 5, 5, 5, 0, 0, 0, 0, 0, 1, 5, 5, 5, 5,
    ],
  },
  {
    name: "special",
    rect: { x: 1373, y: 1103, width: 5, height: 6 },
    source: { width: 8400, height: 2400, worldSurface: 649 },
    palette: [
      { wall: 87 },
      { active: true, type: 226, wall: 87 },
      { active: true, type: 237, frameX: 0, frameY: 0, wall: 87 },
      { active: true, type: 237, frameX: 0, frameY: 18, wall: 87 },
      { active: true, type: 62, wall: 87 },
      { active: true, type: 237, frameX: 18, frameY: 0, wall: 87 },
      { active: true, type: 237, frameX: 18, frameY: 18, wall: 87 },
      { active: true, type: 237, frameX: 36, frameY: 0, wall: 87 },
      { active: true, type: 237, frameX: 36, frameY: 18, wall: 87 },
      { active: true, type: 61, frameX: 90, frameY: 0, wall: 87 },
      { active: true, type: 61, frameX: 0, frameY: 0, wall: 87 },
    ],
    indices: [
      0, 0, 1, 1, 2, 3, 4, 4, 4, 4, 5, 6, 0, 0, 0, 0, 7, 8, 4, 4, 4, 4, 4, 9, 4,
      0, 0, 0, 0, 10,
    ],
  },
  {
    name: "terrain",
    rect: { x: 4200, y: 641, width: 4, height: 4 },
    source: { width: 8400, height: 2400, worldSurface: 649 },
    palette: [{ wall: 2 }],
    indices: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
];

// A deterministic corpus, independent of local benchmark artifacts or assets.
// Every known ID is exercised with each shape and with/without saved frames.
export function* plannerDispatchCases() {
  for (const saved of [false, true])
    for (const shape of [-1, 0, 1, 2, 3, 4, 5, 6])
      yield [
        `all-${saved ? "saved" : "unsaved"}-shape-${shape}`,
        allTypes({ shape, ...(saved ? { frameX: 0, frameY: 0 } : {}) }),
        {},
      ];
  for (const [name, extra] of [
    ["negative-frame", { frameX: -18, frameY: 0 }],
    ["fractional-frame", { frameX: 0.5, frameY: 18 }],
    ["nan-frame", { frameX: NaN, frameY: Infinity }],
    ["missing-half-frame", { frameX: 18 }],
    ["saved-offset-frame", { frameX: 36, frameY: 18 }],
    ["saved-wrapped-frame", { frameX: 2034, frameY: 18 }],
    ["string-shape", { shape: "1" }],
    ["inactive", { active: false, wall: 2 }],
    [
      "coated-wired-actuated",
      {
        inactive: true,
        fullbrightBlock: true,
        fullbrightWall: true,
        wireRed: true,
        wireBlue: true,
        wireGreen: true,
        wireYellow: true,
        actuator: true,
        paint: 7,
        wallPaint: 3,
        wall: 2,
      },
    ],
  ])
    yield [name, allTypes(extra), { paintEnabled: true }];
  for (const revealInvisible of [false, true])
    yield [
      `invisible-${revealInvisible}`,
      allTypes({ invisibleBlock: true, invisibleWall: true, wall: 318 }),
      { revealInvisible },
    ];
  yield [
    "walls-only",
    allTypes({ wall: 3, paint: 5, wallPaint: 2 }),
    { tiles: false, paintEnabled: true },
  ];
  yield ["tiles-only", allTypes({ wall: 3 }), { walls: false }];
  yield [
    "bad-origin",
    { ...allTypes(), rect: { x: -1, y: 0, width: 29, height: 26 } },
    {},
  ];
  yield [
    "bad-context",
    { ...allTypes(), context: { rect: {}, cells: [] } },
    {},
  ];
  yield [
    "invalid-pulse",
    allTypes({ frameX: 0, frameY: 0 }),
    { mouseTextColor: -1 },
  ];
  yield [
    "invalid-flame-state",
    allTypes({ frameX: 0, frameY: 0 }),
    { flameState: { windSpeed: Infinity } },
  ];
  const unusual = [
    -1,
    -0,
    754,
    65535,
    2 ** 32 + 51,
    51.5,
    NaN,
    Infinity,
    -Infinity,
    "51",
    "237",
    "length",
    "constructor",
    "__proto__",
    null,
    undefined,
    false,
    true,
    {},
    new Number(51),
  ];
  yield [
    "strict-type-identity",
    region(
      unusual.length,
      1,
      unusual.map((type) => tile(type)),
    ),
    {},
  ];
  for (const [type, style, direction] of [
    [237, 0, 0],
    [597, 10, 0],
    [617, 27, 1],
    [711, 0, 0],
  ]) {
    const full = specialObject(type, style, direction);
    yield [`special-${type}`, full, { paintEnabled: true }];
    const crop = {
      ...full,
      rect: { ...full.rect, x: full.rect.x + 1, width: 1 },
      cells: full.cells.slice(full.rect.height, 2 * full.rect.height),
      context: full,
    };
    yield [`special-context-${type}`, crop, { paintEnabled: true }];
  }
  yield ["plant-and-nature", plantAndNature(), { paintEnabled: true }];
  yield ["tree-foliage", treeScene(), { paintEnabled: true }];
  for (const layer of ["foreground", "background"]) {
    const wet = region(
      3,
      3,
      Array.from({ length: 9 }, () =>
        tile(1, { active: false, liquid: 200, liquidKind: 1 }),
      ),
    );
    wet.cells[4] = tile(1, { shape: 1, wall: 2 });
    wet.cells[3] = tile(518, {
      frameX: 0,
      frameY: 0,
      liquid: 255,
      liquidKind: 1,
    });
    yield [`liquid-${layer}`, wet, { liquids: { enabled: true, layer } }];
  }
  yield [
    "waterfall-draw-order",
    plantAndNature(),
    {
      liquids: {
        enabled: true,
        waterfallRegistry: {
          model: "fresh-static",
          scanComplete: true,
          stats: { registered: 1 },
          hasOrigin: () => false,
          commandsFor: () => [
            {
              kind: "waterfall",
              asset: "Waterfall_0.png",
              sx: 0,
              sy: 0,
              sw: 16,
              sh: 16,
              dx: 16,
              dy: 16,
              dw: 16,
              dh: 16,
            },
          ],
        },
      },
    },
  ];
  for (const { name, rect, source, palette, indices } of REAL_REGIONS) {
    const real = {
      rect,
      source,
      cells: indices.map((i) => ({ ...REAL_TILE_DEFAULTS, ...palette[i] })),
    };
    yield [`real-${name}`, real, { paintEnabled: true }];
    yield [
      `real-${name}-liquids`,
      real,
      { paintEnabled: true, liquids: { enabled: true } },
    ];
  }
  for (const maxCommands of [1, 7, 8])
    yield [
      `flame-budget-${maxCommands}`,
      region(1, 1, [tile(33, { frameX: 0, frameY: 0 })]),
      { maxCommands },
    ];
  for (const maxCommands of [0, -1, 1.5, 131073, Infinity])
    yield [`invalid-budget-${maxCommands}`, allTypes(), { maxCommands }];
  for (const [name, r] of [
    ["null", null],
    ["missing", {}],
    ["oversized", region(513, 1, Array(513).fill(tile(1)))],
    ["wrong-cell-count", region(2, 2, [])],
  ])
    yield [`invalid-region-${name}`, r, {}];
}

// Preserve undefined and non-finite numbers instead of allowing JSON to hide a
// property/value difference. Hashes cover entire plans, including command order,
// geometry, assets, support counters, diagnostics and warnings (or exact errors).
export function serializePlan(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item === undefined) return { $undefined: true };
    if (
      typeof item === "number" &&
      (!Number.isFinite(item) || Object.is(item, -0))
    )
      return { $number: Object.is(item, -0) ? "-0" : String(item) };
    return item;
  });
}
export function outcome(planner, r, options) {
  try {
    return planner(r, options);
  } catch (error) {
    return { errorName: error.name, errorMessage: error.message };
  }
}

// Fixed full-plan fingerprints captured from the pre-dispatch renderer at
// 4b28af7. Do not regenerate these from the implementation under test.
const GOLDEN = {
  "all-unsaved-shape--1":
    "5f67be4a0f399560c11d0f188721f64a0dc6139e76e95198ec668321f1885823",
  "all-unsaved-shape-1":
    "ad89009376637fc961268a6de548093e571b4537247221fe3f6d394d79a048a1",
  "all-unsaved-shape-3":
    "2145309f42c64cafd321b44f993d66ec59a71da47576db68c4c056ba68a71c29",
  "all-unsaved-shape-5":
    "5833aaf4af6a975faf91e0ea454b54f5841a40634ad31e4dadbf4715079afea8",
  "all-saved-shape--1":
    "5f67be4a0f399560c11d0f188721f64a0dc6139e76e95198ec668321f1885823",
  "all-saved-shape-1":
    "2c03e509babdbd0986d086385318a5b7d1d73e00c96e804350c5b3a36df6081b",
  "all-saved-shape-3":
    "6702a04660ab91680b747f3686299dcfca0ae49a14460a16d7baf4a89066d431",
  "all-saved-shape-5":
    "1f35f1d71d0c80c6918a4cdf8383bd752cf967499cb3968ba406caf549a60e82",
  "negative-frame":
    "20370877221cf58dd81c272a4a6cd92ce1330122ef22c29a14e2b9c10ce48682",
  "nan-frame":
    "20370877221cf58dd81c272a4a6cd92ce1330122ef22c29a14e2b9c10ce48682",
  "saved-offset-frame":
    "b317ad92b01a8359827a27c10c79ad8e07f4a49c4a7a1e65db96891206258db7",
  "string-shape":
    "f895e9a7b7d65405f9d3204fd7f63c26bf8b4dbb3e5d1d2665acca95094350df",
  "coated-wired-actuated":
    "e549ca860df205411e40c495f1cb4c6195217d8b960ec86c3c93029eb9603309",
  "invisible-true":
    "be4cf27b52fcdabe89e9044136b11d866cf0ff2738884ac582dbc4b5d585a07b",
  "tiles-only":
    "76d1939aeb9fe7145f0f7911504484223d34c9f9fee0198de1b33a8514a8b1eb",
  "bad-context":
    "5ba879b7cd4f9cf5208d9b880596936b0abc240c9ca3ef3dc122f0510fa9d15c",
  "invalid-flame-state":
    "f791e38aa869f3a398f3f3a7aa2c9687e3a577a2194a6e65c253213f92a9bda0",
  "special-237":
    "b201f4092560a15a6d273e27f4c2206cec0835b6998016682633076c6846d8d7",
  "special-597":
    "3c6b81a3e79d8ba1c6d8f17e0df25f7db80c22b57c8c7437e6ef18954fc11307",
  "special-617":
    "d2215e94adb37a41f850930f27beda225b74bb0302fd729ec84a95463be6cd17",
  "special-711":
    "7a4e12bc09d0d3c3e62f7d82ecfbe92ba1ca2821f305480af5259123f4ef7fb5",
  "plant-and-nature":
    "3c28365ed1c10c3dba4b4f99f99e8143bb33f9a14894d37db04a740497e7d8d3",
  "liquid-foreground":
    "d51da91fa0bc1a95398a81141906b65d3a3986dbc44749f76ed95095e2059ab5",
  "waterfall-draw-order":
    "835015f57a138b6f205190b5011a93b88cce1460913a6a9eac6d1713a3980a7c",
  "real-cactus-liquids":
    "415431ae65d570d921c04732bd6fadf35abfa5ef55297dc73b6e7ebe04320525",
  "real-special-liquids":
    "0fcbff909dd245fccf380671ee9e743f1ea3277fb39bd3cd68499e996193f614",
  "real-terrain-liquids":
    "ae37104bb50d310f97754299059cae065c01a8cf99c104ef0c317fab75900c22",
  "flame-budget-7":
    "cd2480ae6a178115a4834d51a0de35f7a324c449fb398681137b14492c40ecf6",
  "invalid-budget-0":
    "2ae3c2a804059c5dffed6b2ada37bdebad45fe26924d515ae335b5f1cc33c729",
  "invalid-budget-1.5":
    "2ae3c2a804059c5dffed6b2ada37bdebad45fe26924d515ae335b5f1cc33c729",
  "invalid-budget-Infinity":
    "2ae3c2a804059c5dffed6b2ada37bdebad45fe26924d515ae335b5f1cc33c729",
  "invalid-region-missing":
    "16195d2417c10e82fe838fc2000eadd8be78260ce300f51d71b89cd3f2913849",
  "invalid-region-wrong-cell-count":
    "16195d2417c10e82fe838fc2000eadd8be78260ce300f51d71b89cd3f2913849",
  "all-unsaved-shape-0":
    "76d1939aeb9fe7145f0f7911504484223d34c9f9fee0198de1b33a8514a8b1eb",
  "all-unsaved-shape-2":
    "8b4e51ec094bacc94724718a8977efa8a952e118736c22c2d18eee01a7f6e848",
  "all-unsaved-shape-4":
    "cf106b3d305b8c4c83c835740bf6f547451caa46a57663266e3dfc469f745e6d",
  "all-unsaved-shape-6":
    "5f67be4a0f399560c11d0f188721f64a0dc6139e76e95198ec668321f1885823",
  "all-saved-shape-0":
    "2f519e3e07d742e2eb9b943f5ecec66b396ba320654756240f29ac281db7d0bf",
  "all-saved-shape-2":
    "114f8accdefef8c082811099e9658c2adb9c9504ed3d829bf14936489229cc69",
  "all-saved-shape-4":
    "b4b26b60c0b8052a4bc97082256141b4719a07759726ba7d929ca09ba60a592c",
  "all-saved-shape-6":
    "5f67be4a0f399560c11d0f188721f64a0dc6139e76e95198ec668321f1885823",
  "fractional-frame":
    "20370877221cf58dd81c272a4a6cd92ce1330122ef22c29a14e2b9c10ce48682",
  "missing-half-frame":
    "20370877221cf58dd81c272a4a6cd92ce1330122ef22c29a14e2b9c10ce48682",
  "saved-wrapped-frame":
    "e070887d169fe912351ff3958965076cde3cbae14926a53def17458834054517",
  inactive: "fc2b5c58d72e6ea9e810b53ceae8ed184b82318c445dc99cda25cef84cd09371",
  "invisible-false":
    "6a54f3441bbad772a224b075d1aede953bd6771c0eeb8002dc714fcaae2a1733",
  "walls-only":
    "96d831b93aeb1a0642055a9b26bf52076667b7c92cb04d4a5aa1a3d9c0341fb9",
  "bad-origin":
    "16b30bd4db8a8b7d841f2122178a1271a4bcd4f50b75902c686ede4c175f2f7a",
  "invalid-pulse":
    "6839ddabebfc58f57917b7534b2365dceb694d269db08a7b16a78395a018fe33",
  "strict-type-identity":
    "df444cb617685918ac2248d62f3bbce1b22c9cdf6f3f02c4b24939140ade1e5d",
  "special-context-237":
    "42547bf9a96ea46f8dce9aec87e272cb6ab849e6b339bc8037c7b5900f7fd81e",
  "special-context-597":
    "74fc17cb0d4ac792635d350faba66f1ce4f896f0acbf4685123336a968b78a04",
  "special-context-617":
    "88a9345b83ef6ec604f7c35a9b0bc74d7a8447ea10d37182dba802c2423c2f2f",
  "special-context-711":
    "0a23f8de118eddefc9e684cded67e052e024c1901de838fc296c6be8e73002b2",
  "tree-foliage":
    "7aaab3052432803602cf97af45dcdfe1d88843b13e6e950715d71abc1ef0726b",
  "liquid-background":
    "8414517ef818e77dcd312dfcebb3fdef6a18bae67b385f5eed7665d70217a356",
  "real-cactus":
    "20072ac56a8ee26a1a0b8b35a6db14593940f1129be12f0584b32b76b07876d9",
  "real-special":
    "e6595f1a66bdb992960c36c7eefba2ac9133e5aadb6198c5030bc7750f6c40e0",
  "real-terrain":
    "1b466e0538fbc0fda827b5cfb5c5555c261c5f6e787824cdbcbb45d4ca62a34b",
  "flame-budget-1":
    "cd2480ae6a178115a4834d51a0de35f7a324c449fb398681137b14492c40ecf6",
  "flame-budget-8":
    "3a7a2acff4e68682717dc6389d53a13c102d64741aea0c8055216f90d01aa727",
  "invalid-budget--1":
    "2ae3c2a804059c5dffed6b2ada37bdebad45fe26924d515ae335b5f1cc33c729",
  "invalid-budget-131073":
    "2ae3c2a804059c5dffed6b2ada37bdebad45fe26924d515ae335b5f1cc33c729",
  "invalid-region-null":
    "16195d2417c10e82fe838fc2000eadd8be78260ce300f51d71b89cd3f2913849",
  "invalid-region-oversized":
    "16195d2417c10e82fe838fc2000eadd8be78260ce300f51d71b89cd3f2913849",
};

for (const [name, r, options] of plannerDispatchCases()) {
  test(`static dispatch preserves full baseline plan: ${name}`, () => {
    const before = serializePlan(r);
    const actual = outcome(planScene, r, options);
    const digest = createHash("sha256")
      .update(serializePlan(actual))
      .digest("hex");
    assert.equal(digest, GOLDEN[name], name);
    assert.equal(
      serializePlan(r),
      before,
      "planning must not mutate its input",
    );
  });
}

test("planner allowlists remain exact first null guards for unrelated IDs", () => {
  const families = [
    [planStaticNature, STATIC_NATURE_TYPES],
    [planStaticObject, STATIC_OBJECT_TILES],
    [planStaticBlock, STATIC_BLOCK_TILES],
    [planStaticMisc, STATIC_MISC_TILES],
    [planStaticFurnitureNext, STATIC_FURNITURE_NEXT_TILES],
    [planStaticPlantsNext, STATIC_PLANTS_NEXT_TILES],
    [planStaticSpecialObject, STATIC_SPECIAL_OBJECT_TILES],
  ];
  for (const [planner, types] of families) {
    assert.equal(planner(null, NaN, NaN, null), null);
    for (let type = 0; type < 754; type++)
      if (!types.includes(type))
        assert.equal(
          planner(null, NaN, NaN, tile(type)),
          null,
          `${planner.name}: ${type}`,
        );
  }
});

// Any future allowlist change needs a review of dispatch and its baseline corpus,
// including newly introduced IDs outside the current 0..753 synthetic range.
test("static dispatch tracks the complete planner family declarations", () => {
  const families = [
    STATIC_SPECIAL_OBJECT_TILES,
    STATIC_PLANTS_NEXT_TILES,
    STATIC_FURNITURE_NEXT_TILES,
    STATIC_MISC_TILES,
    STATIC_TREE_TYPES,
    STATIC_NATURE_TYPES,
    STATIC_OBJECT_TILES,
    STATIC_BLOCK_TILES,
  ];
  assert.equal(
    createHash("sha256").update(JSON.stringify(families)).digest("hex"),
    "ee2244bacb8da30c839d1acdcf8cbe0dee6d48bf46f29a5374d249e2593b96e9",
  );
});
