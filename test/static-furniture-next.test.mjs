import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  openWorld,
  Reader,
  decodeRecord,
  getWorldTileAccessor,
} from "../core/world.mjs";
import { prepareSceneFrames } from "../core/scene-frames.mjs";
import {
  STATIC_FURNITURE_NEXT_TILES,
  planStaticFurnitureNext,
  readWorldHerbContext,
  isStaticHerbHarvestable,
} from "../core/static-furniture-next.mjs";

const tile = (type, frameX = 0, frameY = 0, extra = {}) => ({
  active: true,
  type,
  frameX,
  frameY,
  shape: 0,
  ...extra,
});
const region = (width = 5, height = 5) => ({
  rect: { x: 100, y: 700, width, height },
  cells: Array.from({ length: width * height }, () => ({
    active: false,
    type: 0,
    shape: 0,
  })),
  source: { width: 8400, height: 2400 },
  treeContext: { beachDistance: 380, worldWidth: 8400 },
});
const set = (r, x, y, t) => (r.cells[x * r.rect.height + y] = t);
const one = (t, r = region(), x = 2, y = 2, o = {}) =>
  planStaticFurnitureNext(r, x, y, t, o);
const geom = (c) => [c.sx, c.sy, c.sw, c.sh, c.offsetX, c.offsetY, c.flipX];
const herbState = (extra = {}) => ({
  dayTime: false,
  time: 15088,
  moonPhase: 6,
  bloodMoon: false,
  raining: false,
  cloudAlpha: 0,
  worldSurface: 649,
  remixWorld: false,
  worldHeight: 2400,
  worldWidth: 8400,
  ...extra,
});

test("furniture is an explicit allowlist, with bounded saved coordinates and shapes", () => {
  assert.equal(one(tile(999)), null);
  assert.equal(one(tile(597)), null); // pylon crystal still needs a separate draw path
  assert.equal(one(tile(617)), null); // do not claim a relic base is the full object
  assert.equal(one(tile(395)), null); // item frame needs the item entity section
  assert.match(one(tile(12, null, null)).unsupported, /saved frame/);
  assert.match(one(tile(12, -18, 0)).unsupported, /saved frame/);
  assert.match(one(tile(12, 0, 0, { shape: 1 })).unsupported, /half-block/);
  assert.match(
    planStaticFurnitureNext(null, 0, 0, tile(12)).unsupported,
    /coordinates/,
  );
  assert.match(
    one(
      tile(124, null, null),
      { rect: { x: 0, y: 0, width: 1, height: 1 } },
      0,
      0,
    ).unsupported,
    /coordinates/,
  );
});

test("normal furniture, paintings, hearts and shadow orbs keep source-confirmed stored crops", () => {
  for (const id of [
    12, 13, 29, 31, 50, 55, 86, 94, 106, 125, 141, 240, 241, 242, 245, 246,
  ]) {
    const result = one(tile(id, 18, 18));
    assert.deepEqual(geom(result.commands[0]), [18, 18, 16, 16, 0, 0, false]);
  }
});

test("anvils, altars, traps, logs and boulders retain their 18-pixel height", () => {
  for (const id of [16, 26, 77, 137, 138, 488, 664, 713, 714, 715, 716])
    assert.deepEqual(geom(one(tile(id, 18, 0)).commands[0]), [
      18,
      0,
      16,
      18,
      0,
      0,
      false,
    ]);
  for (const id of [411, 467, 469]) {
    assert.equal(one(tile(id, 18, 0)).commands[0].sh, 16);
    assert.equal(one(tile(id, 18, 18)).commands[0].sh, 18);
  }
  assert.equal(one(tile(114, 0, 18)).commands[0].sh, 18);
});

test("workstations and statues have the documented two-pixel floor offset", () => {
  for (const id of [
    85, 89, 93, 104, 134, 219, 220, 231, 305, 349, 354, 355, 377,
  ])
    assert.equal(one(tile(id)).commands[0].offsetY, 2);
  for (const id of [132, 135])
    assert.deepEqual(geom(one(tile(id)).commands[0]), [
      0,
      0,
      16,
      18,
      0,
      2,
      false,
    ]);
});

test("switch and geyser orientations have independent offsets", () => {
  for (const [fx, dx, dy] of [
    [0, 0, 2],
    [18, -2, 0],
    [36, 2, 0],
    [54, 0, 0],
  ])
    assert.deepEqual(geom(one(tile(136, fx)).commands[0]).slice(4, 6), [
      dx,
      dy,
    ]);
  assert.equal(one(tile(443, 36)).commands[0].offsetY, 2);
  assert.equal(one(tile(443, 72)).commands[0].offsetY, -2);
});

test("saved furniture atlas pages wrap on the source's type-specific dimensions", () => {
  for (const [id, fx, fy, sx, sy, sh, dy] of [
    [79, 18, 2034, 162, 18, 18, 0],
    [90, 18, 4032, 306, 0, 16, 0],
    [100, 18, 2034, 90, 18, 16, 2],
    [42, 0, 2034, 36, 18, 16, -2],
    [87, 2016, 18, 18, 54, 16, 0],
    [88, 4014, 18, 18, 90, 16, 0],
    [89, 2016, 18, 18, 54, 16, 2],
    [101, 2016, 54, 18, 126, 16, 0],
    [104, 2034, 72, 18, 162, 16, 2],
    [93, 18, 2016, 54, 18, 16, 2],
  ]) {
    assert.deepEqual(
      geom(one(tile(id, fx, fy)).commands[0]),
      [sx, sy, 16, sh, 0, dy, false],
      `type ${id}`,
    );
  }
});

test("hanging furniture uses zero-wind ceiling displacement across region boundaries", () => {
  assert.equal(one(tile(34, 36, 36)).commands[0].offsetY, -2);
  const r = region();
  set(r, 2, 0, tile(19, 0, 0));
  assert.equal(one(tile(91, 126, 18), r).commands[0].offsetY, -10);
  assert.equal(one(tile(42, 0, 18), r).commands[0].offsetY, -10);
  set(r, 2, 0, tile(19, 0, 0, { shape: 1 }));
  assert.equal(one(tile(91, 126, 18), r).commands[0].offsetY, -2);
  const missing = {
    ...r,
    rect: { x: 102, y: 702, width: 1, height: 1 },
    cells: [tile(91, 126, 18)],
  };
  assert.match(one(missing.cells[0], missing, 0, 0).unsupported, /ceiling/);
  missing.context = r;
  assert.equal(one(missing.cells[0], missing, 0, 0).commands[0].offsetY, -2);
});

test("bamboo, cattails and rising seaweed keep distinct mirroring rules", () => {
  for (const id of [519, 571]) {
    assert.deepEqual(geom(one(tile(id, 198, 0)).commands[0]), [
      198,
      0,
      16,
      16,
      0,
      2,
      true,
    ]);
    assert.equal(
      one(tile(id, 198, 0), region(), 1, 2).commands[0].flipX,
      false,
    );
  }
  assert.deepEqual(geom(one(tile(549, 126, 0)).commands[0]), [
    126,
    0,
    16,
    16,
    0,
    2,
    false,
  ]);
});

test("coral, beach piles, garden gnomes and dye plants preserve oversized crops", () => {
  for (const [id, fx, fy, expected] of [
    [81, 26, 0, [26, 0, 24, 26, -4, -8, true]],
    [324, 22, 66, [22, 66, 20, 20, -2, -2, true]],
    [567, 0, 0, [0, 0, 26, 18, -5, -2, true]],
    [567, 0, 20, [0, 20, 26, 18, -5, 0, true]],
    [227, 34, 0, [34, 0, 32, 38, -8, -20, true]],
    [227, 238, 0, [238, 0, 32, 38, -8, -6, true]],
  ])
    assert.deepEqual(geom(one(tile(id, fx, fy)).commands[0]), expected);
  assert.match(one(tile(227, 204, 0)).unsupported, /cactus root/);
  assert.match(one(tile(227, 1, 0)).unsupported, /dye-plant/);
});

test("herb atlas selection follows each species' saved world conditions", () => {
  const state = herbState();
  assert.equal(isStaticHerbHarvestable(0, 700, state), false);
  assert.equal(isStaticHerbHarvestable(1, 700, state), true);
  assert.equal(isStaticHerbHarvestable(2, 700, null), false);
  assert.equal(isStaticHerbHarvestable(6, 700, null), false);
  assert.equal(
    isStaticHerbHarvestable(3, 700, herbState({ moonPhase: 0 })),
    true,
  );
  assert.equal(
    isStaticHerbHarvestable(3, 700, herbState({ bloodMoon: true })),
    true,
  );
  assert.equal(
    isStaticHerbHarvestable(
      3,
      700,
      herbState({ bloodMoon: true, dayTime: true }),
    ),
    false,
  );
  assert.equal(
    isStaticHerbHarvestable(4, 700, herbState({ cloudAlpha: 0.1 })),
    true,
  );
  assert.equal(
    isStaticHerbHarvestable(5, 400, herbState({ time: 40501, raining: true })),
    false,
  );
  assert.equal(
    isStaticHerbHarvestable(5, 700, herbState({ time: 40501, raining: true })),
    true,
  );
  assert.equal(
    isStaticHerbHarvestable(5, 700, herbState({ time: 40500 })),
    false,
  );
  assert.equal(
    isStaticHerbHarvestable(
      5,
      2049,
      herbState({ time: 40501, raining: true, remixWorld: true }),
    ),
    true,
  );
  assert.equal(
    isStaticHerbHarvestable(
      5,
      2050,
      herbState({ time: 40501, raining: true, remixWorld: true }),
    ),
    false,
  );
  assert.equal(isStaticHerbHarvestable(0, 700, {}), null);
  const r = region();
  r.herbContext = state;
  assert.equal(one(tile(83, 0), r).commands[0].asset, "Tiles_83.png");
  assert.equal(one(tile(83, 18), r).commands[0].asset, "Tiles_84.png");
  assert.deepEqual(geom(one(tile(82, 18), r).commands[0]), [
    18,
    0,
    16,
    20,
    0,
    -2,
    true,
  ]);
  assert.match(one(tile(83, 0)).unsupported, /context/);
  assert.match(one(tile(84, 126)).unsupported, /species/);
  r.herbContext = herbState({ time: 40501 });
  assert.match(one(tile(83, 90), r).unsupported, /glow pulse/);
  assert.deepEqual(
    one(tile(83, 90), r, 2, 2, { mouseTextColor: 200 }).commands[0].vertexColor,
    [255, 200, 200, 100],
  );
  assert.equal(
    one(tile(83, 90, 0, { fullbrightBlock: true }), r).commands[0].vertexColor,
    undefined,
  );
});

test("coastal plants sample source biome tiles and resolve ties toward hallow", () => {
  const r = region();
  set(r, 2, 3, tile(53));
  assert.equal(one(tile(529, 18), r).commands[0].sy, 34); // within the beach distance
  r.rect.x = 500;
  assert.equal(one(tile(529, 18), r).commands[0].sy, 0);
  for (const [id, sy] of [
    [23, 136],
    [199, 102],
    [109, 68],
  ]) {
    set(r, 2, 3, tile(id));
    assert.equal(one(tile(529, 18), r).commands[0].sy, sy);
  }
  // Oasis source samples an inclusive four-column range even for a three-cell object.
  const wide = region(6, 6);
  set(wide, 1, 3, tile(23));
  set(wide, 4, 3, tile(109));
  assert.equal(one(tile(530, 18, 18), wide, 2, 2).commands[0].sy, 54);
  set(wide, 4, 3, tile(0));
  set(wide, 3, 3, tile(199));
  assert.equal(one(tile(530, 18, 18), wide, 2, 2).commands[0].sy, 90);
  const noHalo = {
    rect: { x: 500, y: 700, width: 1, height: 1 },
    cells: [tile(529, 0)],
  };
  assert.match(one(noHalo.cells[0], noHalo, 0, 0).unsupported, /halo/);
});

test("campfire saved off frames skip the seven running frames and flames use unpainted atlas", () => {
  const on = one(tile(215, 18, 18, { paint: 4 }));
  assert.equal(on.commands.length, 2);
  assert.equal(on.commands[1].asset, "Flame_15.png");
  assert.equal(on.commands[1].paintId, 0);
  assert.deepEqual(on.commands[1].vertexColor, [255, 255, 255, 0]);
  assert.deepEqual(geom(one(tile(215, 18, 54)).commands[0]), [
    18,
    306,
    16,
    16,
    0,
    2,
    false,
  ]);
  assert.equal(one(tile(215, 18, 54)).commands.length, 1);
  assert.deepEqual(
    one(tile(215, 5 * 54)).commands[1].vertexColor,
    [255, 0, 0, 0],
  );
});

test("glow furniture uses separately wrapped unpainted masks and premultiplied color", () => {
  const result = one(tile(79, 18, 27 * 36 + 18, { paint: 3 }));
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[1].asset, "Glow_53.png");
  assert.deepEqual(geom(result.commands[1]), [18, 18, 16, 18, 0, 0, false]);
  assert.equal(result.commands[1].paintId, 0);
  assert.deepEqual(result.commands[1].vertexColor, [250, 250, 250, 0]);
  assert.equal(one(tile(88, 25 * 54, 18)).commands[1].asset, "Glow_120.png");
  assert.deepEqual(
    one(tile(88, 25 * 54, 18)).commands[1].vertexColor,
    [100, 100, 100, 0],
  );
  assert.equal(one(tile(33, 18, 26 * 22)).commands.length, 1); // unlit candle state
});

test("visible unimplemented furniture flames are explicitly blocked, never reported as complete bodies", () => {
  for (const [id, asset] of [
    [33, "Flame_1.png"],
    [34, "Flame_3.png"],
    [42, "Flame_13.png"],
    [49, "Flame_5.png"],
    [93, "Flame_4.png"],
    [100, "Flame_2.png"],
  ]) {
    const result = one(tile(id));
    assert.match(result.unsupported, /flame overlay/);
    assert.equal(result.partial, true);
    assert.deepEqual(result.dependencies, [asset]);
    assert.equal(result.hidden, undefined);
    assert.ok(result.commands.length > 0); // reviewable body, not an admitted complete result
  }
});

test("missing furniture assets use the bounded shared failure path before canvas allocation", () => {
  const commands = [];
  for (let i = 0; i < 20; i++)
    commands.push({ ...one(tile(240, i * 18, 0)).commands[0], kind: "tile" });
  const frames = prepareSceneFrames(
    { commands },
    {},
    () => {
      throw new Error("must not allocate");
    },
    { inputEncoding: "tconvert-game-raw", opaqueScene: true, maxFrames: 4 },
  );
  assert.equal(frames.support.preparedFrames, 0);
  assert.equal(frames.support.bytes, 0);
  assert.equal(frames.support.reasons["missing-source-texture"], 4);
  assert.equal(frames.support.reasons["painted-frame-count-budget"], 16);
  frames.dispose();
});

test("all beam cardinal masks have their own validated atlas location", () => {
  const expected = [
    [162, 54],
    [108, 54],
    [216, 0],
    [18, 72],
    [162, 0],
    [0, 72],
    [108, 72],
    [18, 36],
    [108, 0],
    [90, 0],
    [18, 54],
    [72, 0],
    [0, 54],
    [0, 0],
    [18, 0],
    [18, 18],
  ];
  const offsets = [
    [0, -1],
    [-1, 0],
    [1, 0],
    [0, 1],
  ];
  for (let mask = 0; mask < 16; mask++) {
    const r = region();
    const t = tile(575, null, null);
    for (let i = 0; i < 4; i++)
      if (mask & (1 << i)) set(r, 2 + offsets[i][0], 2 + offsets[i][1], t);
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ])
      set(r, 2 + dx, 2 + dy, t);
    const c = one(t, r).commands[0];
    assert.deepEqual([c.sx, c.sy], expected[mask], `mask ${mask}`);
    assert.equal(c.sh, 18);
    assert.match(c.fidelity, /approximate/);
  }
});

test("beam full-mask corners, material boundaries, vertical solids and half-blocks are distinct", () => {
  const r = region();
  const t = tile(124, null, null);
  for (const [dx, dy] of [
    [0, -1],
    [-1, 0],
    [1, 0],
    [0, 1],
  ])
    set(r, 2 + dx, 2 + dy, t);
  assert.deepEqual(geom(one(t, r).commands[0]).slice(0, 2), [108, 18]);
  set(r, 1, 1, t);
  set(r, 3, 1, t);
  assert.deepEqual(geom(one(t, r).commands[0]).slice(0, 2), [108, 36]);
  const s = region();
  set(s, 2, 1, tile(1));
  set(s, 2, 3, tile(1));
  assert.deepEqual(geom(one(t, s).commands[0]).slice(0, 2), [90, 0]);
  assert.deepEqual(
    geom(one(tile(574, null, null), s).commands[0]).slice(0, 2),
    [162, 54],
  );
  set(s, 2, 1, tile(1, 0, 0, { shape: 1 }));
  set(s, 2, 3, tile(1, 0, 0, { shape: 1 }));
  assert.deepEqual(
    geom(one(tile(574, null, null), s).commands[0]).slice(0, 2),
    [108, 54],
  );
  set(s, 2, 1, tile(19, 0, 0, { shape: 1 }));
  assert.deepEqual(geom(one(t, s).commands[0]).slice(0, 2), [162, 54]);
});

test("beam framing honors source slope direction, coating parity, halo and marble row pitch", () => {
  const r = region();
  const t = tile(561, null, null);
  set(r, 2, 1, tile(1, 0, 0, { shape: 2, inactive: true }));
  const c = one(t, r).commands[0];
  assert.deepEqual(geom(c), [108, 66, 16, 20, 0, -2, false]);
  set(r, 2, 1, tile(1, 0, 0, { shape: 4 }));
  assert.equal(one(t, r).commands[0].sx, 162);
  set(r, 2, 1, tile(561, null, null, { invisibleBlock: true }));
  assert.equal(one(t, r).commands[0].sx, 162);
  assert.equal(one(t, r, 2, 2, { revealInvisible: true }).commands[0].sx, 108);
  assert.match(one(tile(124, 0, 0)).unsupported, /reconstructed/);
  assert.match(
    one(t, { rect: { x: 100, y: 700, width: 1, height: 1 }, cells: [t] }, 0, 0)
      .unsupported,
    /halo/,
  );
  set(r, 2, 1, tile(379));
  assert.match(one(tile(124, null, null), r).unsupported, /runtime/);
});

test("large anchored bodies partition the source sprite once without hiding child cells", () => {
  for (const id of [751, 752]) {
    const r = region();
    const all = [];
    for (let dx = 0; dx < 2; dx++)
      for (let dy = 0; dy < 2; dy++)
        set(
          r,
          1 + dx,
          1 + dy,
          tile(id, dx * 18, dy * 18, { paint: dx + dy === 0 ? 7 : 0 }),
        );
    for (let dx = 0; dx < 2; dx++)
      for (let dy = 0; dy < 2; dy++) {
        const result = one(r.cells[(1 + dx) * 5 + 1 + dy], r, 1 + dx, 1 + dy);
        assert.equal(result.hidden, undefined);
        assert.equal(result.commands.length, id === 752 && dy === 1 ? 3 : 1);
        assert.ok(result.commands.every(c => c.paintId === 7));
        if (id === 752) assert.ok(result.commands.every(c => c.sy + c.sh <= 36));
        all.push(...result.commands);
      }
    assert.equal(
      all.reduce((n, c) => n + c.sw * c.sh, 0),
      id === 751 ? 56 * 46 : 36 * 38,
    );
    const phase = id === 751 ? ((101 + 701 * 2) % 7) * 46 : 0;
    assert.deepEqual(
      [Math.min(...all.map((c) => c.sx)), Math.min(...all.map((c) => c.sy))],
      [0, phase],
    );
  }
  assert.match(one(tile(751, 18, 18)).unsupported, /origin/);
  assert.match(one(tile(752, 36, 0)).unsupported, /segment/);
});

function makeHeader(version) {
  const chunks = [],
    add = (size, write) => {
      const b = Buffer.alloc(size);
      write?.(b);
      chunks.push(b);
    };
  const i32 = (n) => add(4, (b) => b.writeInt32LE(n));
  const f64 = (n) => add(8, (b) => b.writeDoubleLE(n));
  add(1);
  add(1);
  add(24 + 4 + 16);
  i32(2400);
  i32(8400);
  add(4 + 5);
  add(1, (b) => (b[0] = 1));
  add(2 + (version >= 302 ? 1 : 0));
  add(8 + (version >= 284 ? 8 : 0) + 1 + 68 + 8);
  f64(649);
  f64(900);
  f64(40501);
  add(1, (b) => (b[0] = 1));
  i32(0);
  add(1, (b) => (b[0] = 1));
  add(1);
  add(8 + 1 + 11 + 7 + 3 + 4 + 2 + 20 + 8 + 1);
  add(1, (b) => (b[0] = 1));
  add(4);
  add(4, (b) => b.writeFloatLE(0.5));
  const bytes = Buffer.concat(chunks);
  return {
    version,
    width: 8400,
    height: 2400,
    bytes,
    sections: [0, bytes.length],
  };
}

test("herb header reader walks versioned date and flag fields with section-bounded reads", () => {
  for (const version of [269, 283, 284, 301, 302, 315, 326]) {
    const w = makeHeader(version),
      s = readWorldHerbContext(w);
    assert.deepEqual(
      [
        s.dayTime,
        s.time,
        s.moonPhase,
        s.bloodMoon,
        s.raining,
        s.cloudAlpha,
        s.remixWorld,
      ],
      [true, 40501, 0, true, true, 0.5, true],
    );
    assert.equal(s.provenance.endOffset, w.sections[1]);
  }
  const w = makeHeader(315);
  assert.throws(
    () => readWorldHerbContext({ ...w, width: 4200 }),
    /dimensions/,
  );
  assert.throws(() => readWorldHerbContext({ ...w, version: 327 }), /version/);
  assert.throws(
    () => readWorldHerbContext({ ...w, sections: [0, w.bytes.length - 1] }),
    /Truncated/,
  );
  const bad = makeHeader(315);
  bad.bytes.writeFloatLE(NaN, bad.bytes.length - 4);
  assert.throws(() => readWorldHerbContext(bad), /values/);
  assert.throws(
    () => readWorldHerbContext({ ...w, sections: [0, w.bytes.length + 1] }),
    /bounds/,
  );
  assert.throws(
    () => readWorldHerbContext({ ...w, bytes: undefined }),
    /bounds/,
  );
});

test(
  "public example world produces bounded source crops for every candidate cell",
  {
    skip: !existsSync(
      new URL("../fixtures/example-world.wld", import.meta.url),
    ),
  },
  () => {
    const w = openWorld(
      readFileSync(new URL("../fixtures/example-world.wld", import.meta.url)),
    );
    const herbContext = readWorldHerbContext(w),
      lookup = getWorldTileAccessor(w);
    assert.deepEqual(
      [
        herbContext.dayTime,
        herbContext.time,
        herbContext.moonPhase,
        herbContext.raining,
        herbContext.cloudAlpha,
      ],
      [false, 15088, 6, false, 0],
    );
    const ids = new Set(STATIC_FURNITURE_NEXT_TILES),
      frames = new Map(),
      counts = {},
      rejected = {},
      assets = new Map(),
      assetCrops = new Map();
    let supportedCells = 0;
    const reader = new Reader(w.bytes, w.sections[2]);
    for (let x = 0; x < w.width; x++) {
      reader.pos = w.columns[x];
      for (let y = 0; y < w.height; ) {
        const rec = decodeRecord(reader, w.important),
          t = rec.tile;
        if (t.active && ids.has(t.type))
          for (let yy = y; yy <= y + rec.repeats; yy++) {
            const r = {
              rect: { x, y: yy, width: 1, height: 1 },
              cells: [t],
              source: { width: w.width, height: w.height },
              treeContext: w.treeContext,
              herbContext,
              getWorldTile: lookup,
            };
            const result = one(t, r, 0, 0);
            counts[t.type] = (counts[t.type] || 0) + 1;
            if (result.unsupported) {
              rejected[result.unsupported] =
                (rejected[result.unsupported] || 0) + 1;
              continue;
            }
            supportedCells++;
            assert.ok(
              result.commands.length > 0,
              `type ${t.type} must not be faked empty`,
            );
            for (const c of result.commands) {
              assert.ok(
                [c.sx, c.sy, c.sw, c.sh, c.offsetX, c.offsetY].every(
                  Number.isFinite,
                ),
              );
              assert.ok(
                c.sx >= 0 &&
                  c.sy >= 0 &&
                  c.sw > 0 &&
                  c.sh > 0 &&
                  c.sw <= 64 &&
                  c.sh <= 64,
              );
              const key = [c.asset, c.sx, c.sy, c.sw, c.sh].join(":");
              frames.set(key, c);
              if (!assetCrops.has(c.asset)) assetCrops.set(c.asset, new Map());
              assetCrops
                .get(c.asset)
                .set(key, { sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh });
              if (!assets.has(c.asset)) {
                const path = new URL(
                  `../example/assets/${c.asset}`,
                  import.meta.url,
                );
                if (existsSync(path)) {
                  const png = readFileSync(path);
                  assets.set(c.asset, [
                    png.readUInt32BE(16),
                    png.readUInt32BE(20),
                  ]);
                } else assets.set(c.asset, null);
              }
              const size = assets.get(c.asset);
              if (size)
                assert.ok(
                  c.sx + c.sw <= size[0] && c.sy + c.sh <= size[1],
                  `${key} outside ${size}`,
                );
            }
          }
        y += rec.repeats + 1;
      }
    }
    assert.deepEqual(rejected, {
      "Furniture flame overlay requires source-confirmed frozen flame geometry": 1747,
    });
    assert.equal(counts[124], 1527);
    assert.equal(counts[571], 1675);
    assert.equal(counts[83], 1440);
    assert.ok(frames.size > 1500);
    const missing = [...assets]
      .filter(([, size]) => !size)
      .map(([name]) => name);
    const report = {
      worldSha256: createHash("sha256").update(w.bytes).digest("hex"),
      cells: Object.values(counts).reduce((a, b) => a + b, 0),
      supportedCells,
      types: Object.keys(counts).length,
      uniqueCrops: frames.size,
      assets: assets.size,
      checkedAssets: assets.size - missing.length,
      missingAssets: missing.sort(),
      rejected,
      typeCells: counts,
      requiredAssets: [...assetCrops]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([asset, crops]) => ({
          asset,
          minimumWidth: Math.max(
            ...[...crops.values()].map((c) => c.sx + c.sw),
          ),
          minimumHeight: Math.max(
            ...[...crops.values()].map((c) => c.sy + c.sh),
          ),
          uniqueCrops: crops.size,
          pngBounds: assets.get(asset),
          crops: [...crops.values()],
        })),
    };
    if (process.env.EXPLORETV_FURNITURE_CROP_REPORT === "1")
      writeFileSync(
        new URL("../artifacts/furniture-next-crops.json", import.meta.url),
        JSON.stringify(report, null, 2) + "\n",
      );
    console.log(
      JSON.stringify({
        furnitureNext: {
          cells: report.cells,
          supportedCells,
          uniqueCrops: frames.size,
          assets: assets.size,
          checkedAssets: report.checkedAssets,
          missingAssetCount: missing.length,
          rejected,
        },
      }),
    );
  },
);
