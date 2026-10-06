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
import {
  planStaticPlantsNext,
  STATIC_PLANTS_NEXT_TILES,
} from "../core/static-plants-next.mjs";

const tile = (type, frameX = null, frameY = null, extra = {}) => ({
  active: true,
  type,
  frameX,
  frameY,
  shape: 0,
  liquid: 0,
  ...extra,
});
const region = (width = 9, height = 12) => ({
  rect: { x: 100, y: 700, width, height },
  cells: Array.from({ length: width * height }, () => ({
    active: false,
    type: 0,
    shape: 0,
    liquid: 0,
  })),
  source: { width: 8400, height: 2400 },
});
const set = (r, x, y, t) => (r.cells[x * r.rect.height + y] = t);
const one = (r, x, y, options = {}) =>
  planStaticPlantsNext(r, x, y, r.cells[x * r.rect.height + y], options);
const geom = (c) => [c.sx, c.sy, c.sw, c.sh, c.offsetX, c.offsetY, c.flipX];
function pillar(sand = 53) {
  const r = region();
  for (let y = 2; y <= 7; y++) set(r, 4, y, tile(80));
  set(r, 4, 8, tile(sand));
  return r;
}

test("explicit allowlist rejects malformed state without manufacturing hidden plants", () => {
  const r = region();
  assert.deepEqual(STATIC_PLANTS_NEXT_TILES, [80, 332, 380, 518, 656]);
  assert.equal(planStaticPlantsNext(r, 4, 4, tile(79)), null);
  assert.match(
    planStaticPlantsNext(null, 0, 0, tile(80)).unsupported,
    /coordinates/,
  );
  assert.match(
    planStaticPlantsNext(r, 4, 4, tile(518, 0, 0, { shape: 1 })).unsupported,
    /half-block/,
  );
  assert.match(
    planStaticPlantsNext(r, 4, 4, tile(656)).unsupported,
    /saved frame/,
  );
  assert.match(
    planStaticPlantsNext(r, 4, 4, tile(80, 0, 0)).unsupported,
    /non-persisted/,
  );
  assert.match(
    planStaticPlantsNext(r, 4, 4, tile(332, 0, 0)).unsupported,
    /non-persisted/,
  );
  assert.match(
    planStaticPlantsNext(r, 4, 4, tile(656, 26, 0)).unsupported,
    /unknown saved frame/,
  );
  assert.match(
    planStaticPlantsNext(r, 4, 4, tile(656, 0, 0, { active: false }))
      .unsupported,
    /not active/,
  );
});

test("cactus stems choose top, middle and rooted base across all four biomes", () => {
  for (const [sand, shift] of [
    [53, 0],
    [112, 54],
    [116, 108],
    [234, 162],
  ]) {
    const r = pillar(sand);
    assert.deepEqual(geom(one(r, 4, 2).commands[0]), [
      0,
      shift,
      16,
      16,
      0,
      2,
      false,
    ]);
    assert.deepEqual(geom(one(r, 4, 4).commands[0]), [
      0,
      18 + shift,
      16,
      16,
      0,
      2,
      false,
    ]);
    assert.deepEqual(geom(one(r, 4, 7).commands[0]), [
      0,
      36 + shift,
      16,
      16,
      0,
      2,
      false,
    ]);
  }
});

test("cactus tall arms retain distinct top, shaft, elbow and isolated twig crops", () => {
  for (const side of [-1, 1]) {
    const r = pillar();
    for (let y = 3; y <= 5; y++) set(r, 4 + side, y, tile(80));
    for (const [y, sy] of [
      [3, 0],
      [4, 18],
      [5, 36],
    ])
      assert.deepEqual(geom(one(r, 4 + side, y).commands[0]).slice(0, 2), [
        side === -1 ? 54 : 36,
        sy,
      ]);
    assert.deepEqual(geom(one(r, 4, 5).commands[0]).slice(0, 2), [
      side === -1 ? 72 : 18,
      36,
    ]);
    const twig = pillar();
    set(twig, 4 + side, 4, tile(80));
    assert.deepEqual(geom(one(twig, 4 + side, 4).commands[0]).slice(0, 2), [
      108,
      side === -1 ? 36 : 18,
    ]);
  }
});

test("cactus fork crowns, stem forks and dye fruit alter source topology", () => {
  const r = pillar();
  set(r, 3, 2, tile(80));
  set(r, 5, 2, tile(80));
  assert.deepEqual(geom(one(r, 4, 2).commands[0]).slice(0, 2), [90, 0]);
  set(r, 4, 1, tile(227, 204, 0));
  assert.deepEqual(geom(one(r, 4, 2).commands[0]).slice(0, 2), [90, 36]);
  set(r, 3, 5, tile(80));
  set(r, 5, 5, tile(80));
  assert.deepEqual(geom(one(r, 4, 5).commands[0]).slice(0, 2), [90, 36]);
});

test("cactus world accessor traverses beyond the selection without mutating saved tiles", () => {
  const full = region(9, 40);
  for (let y = 2; y < 32; y++) set(full, 4, y, tile(80));
  set(full, 4, 32, tile(234));
  const t = full.cells[4 * 40 + 2];
  const r = {
    rect: { x: 104, y: 702, width: 1, height: 1 },
    cells: [t],
    source: full.source,
  };
  assert.match(one(r, 0, 0).unsupported, /accessor\/halo/);
  r.getWorldTile = (wx, wy) => full.cells[(wx - 100) * 40 + wy - 700] ?? null;
  const before = JSON.stringify(full);
  for (const c of full.cells) Object.freeze(c);
  assert.deepEqual(geom(one(r, 0, 0).commands[0]).slice(0, 2), [0, 0]); // twenty-cell biome cutoff
  const bottom = {
    ...r,
    rect: { x: 104, y: 730, width: 1, height: 1 },
    cells: [full.cells[4 * 40 + 30]],
  };
  assert.deepEqual(geom(one(bottom, 0, 0).commands[0]).slice(0, 2), [0, 180]);
  assert.equal(JSON.stringify(full), before);
});

test("invalid cactus roots are explained rather than removed or replaced", () => {
  for (const root of [
    tile(1),
    tile(53, null, null, { shape: 1 }),
    tile(53, null, null, { inactive: true }),
  ]) {
    const r = pillar();
    set(r, 4, 8, root);
    const result = one(r, 4, 3);
    assert.match(result.unsupported, /intact sand root/);
    assert.equal(result.hidden, undefined);
    assert.equal(result.commands, undefined);
  }
});

test("cactus traversal remains bounded when an accessor never returns a root", () => {
  const t = tile(80),
    r = {
      rect: { x: 100, y: 100, width: 1, height: 1 },
      cells: [t],
      source: { height: Number.MAX_SAFE_INTEGER },
    };
  let calls = 0;
  r.getWorldTile = () => {
    calls++;
    return t;
  };
  assert.match(one(r, 0, 0).unsupported, /bounded world-height/);
  assert.ok(calls <= 8192);
});

test("all sixteen pile cardinal masks use fixed-variation source atlas cells", () => {
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
  const around = [
    [0, -1],
    [-1, 0],
    [1, 0],
    [0, 1],
  ];
  for (let mask = 0; mask < 16; mask++) {
    const r = region();
    set(r, 4, 4, tile(332));
    for (let i = 0; i < 4; i++)
      if (mask & (1 << i))
        set(r, 4 + around[i][0], 4 + around[i][1], tile(330 + i));
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ])
      set(r, 4 + dx, 4 + dy, tile(331));
    const c = one(r, 4, 4).commands[0];
    assert.deepEqual(geom(c), [...expected[mask], 16, 16, 0, 2, false]);
    assert.match(c.fidelity, /variation-zero/);
  }
});

test("coin pile full masks respect missing diagonal pairs and merge all coin metals", () => {
  for (const [missing, expected] of [
    [
      [4, 5],
      [108, 18],
    ],
    [
      [6, 7],
      [108, 36],
    ],
    [
      [4, 6],
      [180, 0],
    ],
    [
      [5, 7],
      [198, 0],
    ],
  ]) {
    const r = region();
    set(r, 4, 4, tile(332));
    const around = [
      [0, -1],
      [-1, 0],
      [1, 0],
      [0, 1],
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    around.forEach(([dx, dy], i) => {
      if (!missing.includes(i)) set(r, 4 + dx, 4 + dy, tile(330 + (i % 4)));
    });
    assert.deepEqual(geom(one(r, 4, 4).commands[0]).slice(0, 2), expected);
  }
});

test("coin pile framing honors coating, slope directions, half blocks and active flags", () => {
  const r = region();
  set(r, 4, 4, tile(332));
  set(r, 4, 3, tile(1, null, null, { shape: 1 }));
  assert.deepEqual(geom(one(r, 4, 4).commands[0]).slice(0, 2), [108, 54]);
  set(r, 4, 3, tile(19, null, null, { shape: 1 }));
  assert.deepEqual(geom(one(r, 4, 4).commands[0]).slice(0, 2), [162, 54]);
  set(r, 4, 3, tile(333, null, null, { shape: 4 }));
  assert.equal(one(r, 4, 4).commands[0].sx, 162);
  set(r, 4, 3, tile(333, null, null, { inactive: true }));
  assert.equal(one(r, 4, 4).commands[0].sx, 108); // source checks active(), not nactive()
  set(r, 4, 3, tile(333, null, null, { invisibleBlock: true }));
  assert.equal(one(r, 4, 4).commands[0].sx, 162);
  assert.equal(one(r, 4, 4, { revealInvisible: true }).commands[0].sx, 108);
  set(r, 4, 3, { active: false });
  set(r, 3, 4, tile(331, null, null, { shape: 1 }));
  assert.equal(one(r, 4, 4).commands[0].sx, 162);
  set(r, 3, 4, tile(332, null, null, { shape: 1 }));
  assert.equal(one(r, 4, 4).commands[0].sx, 216);
});

test("planter boxes recompute four horizontal joins while retaining the saved plant style", () => {
  for (const [left, right, sx] of [
    [false, false, 54],
    [false, true, 0],
    [true, false, 36],
    [true, true, 18],
  ]) {
    const r = region();
    set(r, 4, 4, tile(380, 0, 126));
    if (left) set(r, 3, 4, tile(380, 54, 18));
    if (right) set(r, 5, 4, tile(380, 54, 0));
    assert.deepEqual(geom(one(r, 4, 4).commands[0]), [
      sx,
      126,
      16,
      16,
      0,
      0,
      false,
    ]);
  }
  const r = region();
  set(r, 4, 4, tile(380, 18, 0));
  set(r, 3, 4, tile(380, 0, 0, { invisibleBlock: true }));
  assert.equal(one(r, 4, 4).commands[0].sx, 54);
  assert.equal(one(r, 4, 4, { revealInvisible: true }).commands[0].sx, 36);
  set(r, 4, 4, tile(380, 0, 144));
  assert.match(one(r, 4, 4).unsupported, /style/);
});

test("planter back rope uses both endpoints, the upper rope paint, and world coordinate phase", () => {
  const r = region();
  set(r, 4, 5, tile(380, 54, 0, { paint: 2 }));
  set(r, 4, 4, tile(380, 54, 0));
  set(r, 4, 3, tile(213, null, null, { paint: 7 }));
  set(r, 4, 6, tile(365, null, null, { paint: 4 }));
  const result = one(r, 4, 5);
  assert.equal(result.commands.length, 2);
  assert.deepEqual(geom(result.commands[0]), [
    90,
    ((104 + 705) % 3) * 18,
    16,
    16,
    0,
    0,
    false,
  ]);
  assert.equal(result.commands[0].paintId, 7);
  assert.equal(result.commands[0].asset, "Tiles_213.png");
  assert.equal(result.commands[0].role, "planter-back-rope");
  set(r, 4, 6, { active: false });
  assert.equal(one(r, 4, 5).commands.length, 1);
});

test("planter rope search stops at the combined six-cell span and reports missing halo", () => {
  const r = region();
  set(r, 4, 5, tile(380, 0, 0));
  for (let y = 1; y < 10; y++) if (y !== 5) set(r, 4, y, tile(1));
  set(r, 4, 1, tile(213));
  set(r, 4, 7, tile(213));
  assert.equal(one(r, 4, 5).commands.length, 2);
  set(r, 4, 7, tile(1));
  set(r, 4, 8, tile(213));
  assert.equal(one(r, 4, 5).commands.length, 1);
  const t = tile(380, 0, 0),
    small = { rect: { x: 104, y: 705, width: 1, height: 1 }, cells: [t] };
  assert.match(one(small, 0, 0).unsupported, /halo/);
  small.context = r;
  assert.equal(one(small, 0, 0).commands.length, 1);
});

test("lily pad stored crops track liquid levels with integer source rounding", () => {
  const r = region();
  for (const [liquid, dy] of [
    [0, 3],
    [15, 3],
    [16, 2],
    [47, 1],
    [48, 0],
    [134, -5],
    [255, -12],
  ]) {
    set(r, 4, 4, tile(518, 306, 36, { liquid }));
    assert.deepEqual(geom(one(r, 4, 4).commands[0]), [
      306,
      36,
      16,
      16,
      0,
      dy,
      false,
    ]);
  }
});

test("lily pad ceiling cap excludes actuated, shaped and solid-top blocks", () => {
  const r = region();
  set(r, 4, 4, tile(518, 0, 0, { liquid: 255 }));
  for (const [above, dy] of [
    [tile(1), -8],
    [tile(1, null, null, { inactive: true }), -12],
    [tile(1, null, null, { shape: 1 }), -12],
    [tile(380, 0, 0), -12],
    [tile(239), -12],
    [tile(379, null, null, { inactive: true }), -12],
    [tile(379, null, null, { shape: 1 }), -12],
  ]) {
    set(r, 4, 3, above);
    assert.equal(one(r, 4, 4).commands[0].offsetY, dy);
  }
  set(r, 4, 3, tile(379));
  assert.match(one(r, 4, 4).unsupported, /runtime solidity/);
});

test("dry lily pads use half-block liquid or slope support without moving their saved cell", () => {
  const r = region();
  set(r, 4, 4, tile(518, 0, 0));
  for (const [shape, liquid, inactive, dy] of [
    [1, 0, false, 8],
    [1, 255, false, 1],
    [2, 0, false, 7],
    [3, 0, false, 7],
    [4, 0, false, 3],
    [5, 0, false, 3],
    [1, 0, true, 3],
  ]) {
    set(r, 4, 5, tile(1, null, null, { shape, liquid, inactive }));
    assert.equal(one(r, 4, 4).commands[0].offsetY, dy);
  }
});

test("glow tulips have the 24 by 34 body and separately unpainted additive pulse layer", () => {
  const r = region();
  set(r, 4, 4, tile(656, 0, 0, { paint: 4 }));
  const before = JSON.stringify(r);
  const p = one(r, 4, 4, { mouseTextColor: 180 });
  assert.equal(p.commands.length, 2);
  for (const c of p.commands)
    assert.deepEqual(geom(c), [0, 0, 24, 34, -4, -16, true]);
  assert.equal(p.commands[1].asset, "Glow_329.png");
  assert.equal(p.commands[1].paintId, 0);
  assert.equal(p.commands[1].staticOverlay, true);
  assert.deepEqual(p.commands[1].vertexColor, [180, 180, 180, 0]);
  assert.deepEqual(one(r, 4, 4).commands[1].vertexColor, [255, 255, 255, 0]);
  assert.match(one(r, 4, 4, { mouseTextColor: 256 }).unsupported, /byte/);
  set(r, 5, 4, tile(656, 0, 0));
  assert.equal(one(r, 5, 4).commands[0].flipX, false);
  set(r, 5, 4, { active: false, type: 0, shape: 0, liquid: 0 });
  assert.equal(JSON.stringify(r), before);
});

const worldPath = new URL("../fixtures/example-world.wld", import.meta.url);
test(
  "actual fixture produces 905 nonempty supported plans and checks every original PNG crop",
  { skip: !existsSync(worldPath) },
  () => {
    const bytes = readFileSync(worldPath),
      sha = createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      sha,
      "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab",
    );
    const w = openWorld(bytes),
      getWorldTile = getWorldTileAccessor(w),
      reader = new Reader(w.bytes, w.sections[2]);
    assert.deepEqual(
      STATIC_PLANTS_NEXT_TILES.map((id) => w.important[id]),
      [0, 0, 1, 1, 1],
    );
    const counts = {},
      frames = new Map(),
      assets = new Map(),
      sourceFrames = {},
      planterChanged = [],
      examples = {};
    for (let x = 0; x < w.width; x++) {
      reader.pos = w.columns[x];
      for (let y = 0; y < w.height; ) {
        const { tile: t, repeats } = decodeRecord(reader, w.important);
        if (t.active && STATIC_PLANTS_NEXT_TILES.includes(t.type))
          for (let yy = y; yy <= y + repeats; yy++) {
            const before = JSON.stringify(t);
            Object.freeze(t);
            const r = {
              rect: { x, y: yy, width: 1, height: 1 },
              cells: [t],
              source: { width: w.width, height: w.height },
              getWorldTile,
            };
            const p = one(r, 0, 0);
            assert.equal(
              p.unsupported,
              undefined,
              `${x},${yy},${t.type}: ${p.unsupported}`,
            );
            assert.equal(p.hidden, undefined);
            assert.ok(p.commands.length > 0);
            counts[t.type] = (counts[t.type] || 0) + 1;
            const saved = `${t.frameX},${t.frameY}`;
            (sourceFrames[t.type] ??= {})[saved] =
              ((sourceFrames[t.type] ?? {})[saved] || 0) + 1;
            if (t.type === 380 && t.frameX !== p.commands.at(-1).sx)
              planterChanged.push([x, yy]);
            if (t.type === 80) assert.ok(p.commands[0].sy >= 162);
            (examples[t.type] ??= []).length < 8 &&
              examples[t.type].push({ x, y: yy, commands: p.commands });
            for (const c of p.commands) {
              assert.ok(
                [c.sx, c.sy, c.sw, c.sh, c.offsetX, c.offsetY].every(
                  Number.isSafeInteger,
                ),
              );
              assert.ok(c.sx >= 0 && c.sy >= 0 && c.sw > 0 && c.sh > 0);
              if (!assets.has(c.asset)) {
                const publicPath = new URL(
                    `../example/assets/${c.asset}`,
                    import.meta.url,
                  ),
                  privatePath = new URL(
                    `../fixtures/private/plants-next/${c.asset}`,
                    import.meta.url,
                  );
                const png = existsSync(publicPath)
                  ? readFileSync(publicPath)
                  : existsSync(privatePath)
                    ? readFileSync(privatePath)
                    : null;
                assert.ok(png, `Original asset unavailable: ${c.asset}`);
                assets.set(c.asset, {
                  width: png.readUInt32BE(16),
                  height: png.readUInt32BE(20),
                  sha256: createHash("sha256").update(png).digest("hex"),
                });
              }
              const size = assets.get(c.asset);
              assert.ok(
                c.sx + c.sw <= size.width && c.sy + c.sh <= size.height,
                `${c.asset} outside original PNG`,
              );
              frames.set([c.asset, c.sx, c.sy, c.sw, c.sh].join(":"), {
                asset: c.asset,
                sx: c.sx,
                sy: c.sy,
                sw: c.sw,
                sh: c.sh,
              });
            }
            assert.equal(JSON.stringify(t), before);
          }
        y += repeats + 1;
      }
    }
    assert.deepEqual(counts, { 80: 238, 332: 104, 380: 280, 518: 277, 656: 6 });
    assert.equal(frames.size, 78);
    assert.equal(assets.size, 6);
    assert.deepEqual(planterChanged, []);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha);
    const report = {
      worldSha256: sha,
      version: w.version,
      typeCells: counts,
      supportedCells: 905,
      commands: 911,
      uniqueCrops: frames.size,
      assets: Object.fromEntries(assets),
      savedFrames: sourceFrames,
      planterChanged,
      examples,
      crops: [...frames.values()],
      limitations:
        "Original PNG source-crop verification; fixed coin variation and glow pulse, zero wind. No game screenshot oracle or private game binary execution.",
    };
    if (process.env.EXPLORETV_PLANTS_CROP_REPORT === "1")
      writeFileSync(
        new URL("../artifacts/plants-next-crops.json", import.meta.url),
        JSON.stringify(report, null, 2) + "\n",
      );
    console.log(
      JSON.stringify({
        plantsNext: {
          supportedCells: 905,
          commands: 911,
          uniqueCrops: frames.size,
          assets: assets.size,
          mutatedCells: 0,
        },
      }),
    );
  },
);
