import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { cobwebConnects } from "../core/cobweb-shapes.mjs";
import { COBWEB_NO_ATTACH, planStaticNature } from "../core/static-nature.mjs";
import {
  openWorld,
  extractSceneRegion,
  getWorldTileAccessor,
  Reader,
  decodeRecord,
} from "../core/world.mjs";
import { saveFragment, loadFragment } from "../core/fragment.mjs";
import { decodePngRgba } from "../core/png-rgba.mjs";
import { fixtureWorld, record } from "./fixture.mjs";

const noAttach = new Set(COBWEB_NO_ATTACH);
const offsets = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];
const tile = (type = 51, shape = 0, extra = {}) => ({
  active: true,
  type,
  shape,
  frameX: null,
  frameY: null,
  ...extra,
});
const air = () => ({ active: false, type: 0, shape: 0 });
const joins = (neighbor, direction, options) =>
  cobwebConnects(neighbor, direction, noAttach, options);
const connections = (neighbors, options) =>
  neighbors.map((n, i) => joins(n, i, options));
function scene(neighbors, center = tile(), x = 39, y = 39) {
  const r = {
    rect: { x, y, width: 3, height: 3 },
    cells: Array.from({ length: 9 }, air),
  };
  r.cells[4] = center;
  neighbors.forEach((n, i) => {
    const [dx, dy] = offsets[i];
    r.cells[(1 + dx) * 3 + 1 + dy] = n;
  });
  return r;
}
const plan = (r, options) => planStaticNature(r, 1, 1, r.cells[4], options);
const crop = (p) => [p.sx, p.sy];

// Exercise the unchanged host's frame selector with the helper's eight booleans.
// This is a test-only adapter, not a replacement for host input validation.
function frameFromConnections(neighbors, options, center = tile()) {
  return plan(
    scene(
      connections(neighbors, options).map((v) => (v ? tile() : air())),
      center,
    ),
    options,
  );
}

test("each cardinal face observes all six ordinary-block shapes", () => {
  // Columns: normal, half brick, game slopes 1, 2, 3, 4.
  const expected = [
    [true, true, true, true, false, false],
    [true, false, false, true, false, true],
    [true, false, true, false, true, false],
    [true, false, false, false, true, true],
  ];
  for (let direction = 0; direction < 4; direction++)
    for (let shape = 0; shape < 6; shape++)
      assert.equal(
        joins(tile(1, shape), direction),
        expected[direction][shape],
        `direction ${direction}, shape ${shape}`,
      );
});

test("side half bricks retain the actual same-type exception", () => {
  for (const direction of [1, 2]) {
    assert.equal(joins(tile(51, 1), direction), true);
    for (const type of [0, 1, 52, 63, 130, 131, 668, 697])
      assert.equal(joins(tile(type, 1), direction), false, `${type}`);
  }
});

test("shape normalization precedes no-attach filtering for every excluded type", () => {
  const platforms = [19, 427, 435, 436, 437, 438, 439];
  for (const type of COBWEB_NO_ATTACH) {
    if (platforms.includes(type)) continue;
    for (const shape of [1, 2, 3])
      assert.equal(joins(tile(type, shape), 0), true, `above ${type}/${shape}`);
    for (const shape of [4, 5])
      assert.equal(joins(tile(type, shape), 3), true, `below ${type}/${shape}`);
    assert.equal(joins(tile(type), 0), false);
    assert.equal(joins(tile(type), 3), false);
    for (let shape = 0; shape < 6; shape++)
      for (const direction of [1, 2, 4, 5, 6, 7])
        assert.equal(joins(tile(type, shape), direction), false);
  }
});

test("all platform types remain detached at all eight positions and six shapes", () => {
  for (const type of [19, 427, 435, 436, 437, 438, 439])
    for (let direction = 0; direction < 8; direction++)
      for (let shape = 0; shape < 6; shape++)
        assert.equal(joins(tile(type, shape), direction), false);
});

test("diagonal shape does not inherit either neighboring cardinal face test", () => {
  for (const direction of [4, 5, 6, 7])
    for (let shape = 0; shape < 6; shape++) {
      assert.equal(joins(tile(1, shape), direction), true);
      assert.equal(joins(tile(51, shape), direction), true);
      assert.equal(joins(tile(185, shape), direction), true);
      assert.equal(joins(tile(10, shape), direction), false);
    }
});

test("invisibility culls normalized neighbors last, independently in every direction", () => {
  const shapes = [1, 3, 2, 4, 5, 4, 3, 2];
  for (let direction = 0; direction < 8; direction++) {
    const n = tile(1, shapes[direction], { invisibleBlock: true });
    assert.equal(joins(n, direction), false);
    assert.equal(joins(n, direction, { revealInvisible: true }), true);
    assert.equal(joins(n, direction, { invisibleBlock: true }), true);
    assert.equal(
      joins({ ...n, invisibleBlock: false }, direction, {
        invisibleBlock: true,
      }),
      false,
    );
  }
  // The forced center-type path must not revive an invisible door half brick.
  assert.equal(joins(tile(10, 1, { invisibleBlock: true }), 0), false);
  assert.equal(
    joins(tile(10, 1, { invisibleBlock: true }), 0, { revealInvisible: true }),
    true,
  );
});

test("inactive data cannot attach; actuated active tiles still participate in framing", () => {
  for (let direction = 0; direction < 8; direction++) {
    assert.equal(joins(tile(51, 0, { active: false }), direction), false);
    assert.equal(
      joins(tile(51, 0, { inactive: true, actuator: true }), direction),
      true,
    );
  }
  assert.equal(joins({ active: false, type: 999, shape: 7 }, 0), false);
});

test("malformed or unknown data cannot silently become ordinary adjacency", () => {
  for (const direction of [-1, 8, 0.5, NaN])
    assert.throws(() => joins(tile(), direction), /direction/);
  for (const type of [-1, 754, NaN, 1.5, "1"])
    assert.throws(() => joins(tile(type), 0), /neighbor type/);
  for (const shape of [-1, 6, 7, 0.5, "1"])
    assert.throws(() => joins(tile(1, shape), 0), /neighbor shape/);
  assert.throws(() => joins(null, 0), /real cobweb neighbor/);
  assert.throws(() => cobwebConnects(tile(), 0), /no-attach facts/);
});

test("shaped neighbors cover every cardinal and diagonal attachment mask in the existing atlas", () => {
  const touching = [2, 3, 2, 4, 1, 2, 4, 5];
  const open = [4, 2, 3, 1, 1, 2, 4, 5];
  for (let mask = 0; mask < 256; mask++) {
    const neighbors = offsets.map((_, i) =>
      mask & (1 << i) ? tile(1, touching[i]) : tile(i < 4 ? 1 : 19, open[i]),
    );
    const expected = plan(
      scene(offsets.map((_, i) => (mask & (1 << i) ? tile() : air()))),
    );
    assert.deepEqual(frameFromConnections(neighbors), expected, `mask ${mask}`);
  }
});

test("paired corner holes and source priority survive shaped cardinal normalization", () => {
  for (const [missing, expected] of [
    [[], [18, 18]],
    [[4], [18, 18]],
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
    [
      [4, 5, 6, 7],
      [108, 18],
    ],
  ]) {
    const neighbors = [tile(10, 1), tile(1, 3), tile(1, 2), tile(10, 4)];
    for (let i = 4; i < 8; i++)
      neighbors.push(missing.includes(i) ? tile(427, 1) : tile(1, 5));
    assert.deepEqual(crop(frameFromConnections(neighbors)), expected);
  }
  const neighbors = Array.from({ length: 8 }, () => tile(1, 0));
  neighbors[4] = tile(1, 2, { invisibleBlock: true });
  neighbors[5] = tile(1, 3, { invisibleBlock: true });
  assert.deepEqual(crop(frameFromConnections(neighbors)), [108, 18]);
  assert.deepEqual(
    crop(frameFromConnections(neighbors, { revealInvisible: true })),
    [18, 18],
  );
});

test("ordinary neighborhoods remain identical for every known type in all eight directions", () => {
  for (let type = 0; type < 754; type++)
    for (let direction = 0; direction < 8; direction++) {
      const neighbors = Array.from({ length: 8 }, () => tile(51));
      neighbors[direction] = tile(type);
      assert.deepEqual(frameFromConnections(neighbors), plan(scene(neighbors)));
    }
});

test("all Tile fields, halo cells, raw bytes, and fragment round trips remain unchanged", () => {
  const columns = Array.from({ length: 5 }, (_, x) =>
    Array.from({ length: 5 }, (_, y) =>
      record({
        type: x === 2 && y === 2 ? 51 : 1,
        shape: x === 2 && y === 2 ? 0 : (x + y) % 6,
        wall: 257,
        paint: 7,
        wallPaint: 9,
        liquid: 127,
        liquidKind: 4,
        red: true,
        blue: true,
        green: true,
        yellow: true,
        actuator: true,
        inactive: true,
        invisibleBlock: true,
        invisibleWall: true,
        fullbrightBlock: true,
        fullbrightWall: true,
      }),
    ),
  );
  const { bytes } = fixtureWorld({
    width: 5,
    height: 5,
    version: 315,
    columns,
  });
  const beforeBytes = bytes.slice();
  const region = extractSceneRegion(
    openWorld(bytes),
    { x: 1, y: 1, width: 3, height: 3 },
    1,
  );
  const before = saveFragment(region);
  const beforeCells = structuredClone(region.cells);
  const beforeHalo = structuredClone(region.context.cells);
  const neighbors = offsets.map(
    ([dx, dy]) => region.cells[(1 + dx) * 3 + 1 + dy],
  );
  neighbors.forEach(Object.freeze);
  assert.equal(
    frameFromConnections(neighbors, { revealInvisible: true }).supported,
    true,
  );
  assert.deepEqual(bytes, beforeBytes);
  assert.deepEqual(region.cells, beforeCells);
  assert.deepEqual(region.context.cells, beforeHalo);
  assert.equal(saveFragment(region), before);
  assert.deepEqual(loadFragment(before).raw, region.raw);
});

const worldPath = new URL("../fixtures/example-world.wld", import.meta.url);
const texturePath = new URL(
  "../fixtures/private/Tiles_51.png",
  import.meta.url,
);
test(
  "private real-map scan verifies exact recovery and real texture crops",
  {
    skip:
      process.env.EXPLORETV_COBWEB_REAL_WORLD !== "1" ||
      !existsSync(worldPath) ||
      !existsSync(texturePath),
  },
  (t) => {
    const bytes = readFileSync(worldPath);
    const hash = (b) => createHash("sha256").update(b).digest("hex");
    const sourceHash = hash(bytes);
    assert.equal(
      sourceHash,
      "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab",
    );
    const textureBytes = readFileSync(texturePath);
    const atlas = decodePngRgba(textureBytes);
    const world = openWorld(bytes),
      getTile = getWorldTileAccessor(world);
    const crops = new Set();
    const result = {
      total: 0,
      previouslySupported: 0,
      recovered: 0,
      changedVersusIgnoringShapes: 0,
      examples: [],
    };
    for (let x = 0; x < world.width; x++) {
      const r = new Reader(world.bytes, world.sections[2]);
      r.pos = world.columns[x];
      for (let y = 0; y < world.height; ) {
        const { tile: center, repeats } = decodeRecord(r, world.important);
        const end = y + repeats + 1;
        if (center.active && center.type === 51) {
          for (; y < end; y++) {
            result.total++;
            const neighbors = offsets.map(([dx, dy]) =>
              getTile(x + dx, y + dy),
            );
            const before = plan(scene(neighbors, center, x - 1, y - 1));
            const after = frameFromConnections(neighbors, undefined, center);
            assert.equal(after.supported, true, `unsupported at ${x},${y}`);
            // Preserve the historical baseline even after the parent integrates
            // this helper into planStaticNature. Both states are tested here.
            const oldShapeRejection = neighbors.some(
              (n) => n.active && n.shape,
            );
            if (!oldShapeRejection) {
              result.previouslySupported++;
              assert.deepEqual(after, before);
            } else {
              if (before.supported) assert.deepEqual(after, before);
              else assert.equal(before.reason, "shaped-neighbor");
              result.recovered++;
              const naive = plan(
                scene(
                  neighbors.map((n) => ({ ...n, shape: 0 })),
                  center,
                ),
              );
              if (after.sx !== naive.sx || after.sy !== naive.sy) {
                result.changedVersusIgnoringShapes++;
                if (result.examples.length < 5)
                  result.examples.push({
                    x,
                    y,
                    crop: crop(after),
                    naiveCrop: crop(naive),
                  });
              }
            }
            assert.ok(after.sx >= 0 && after.sy >= 0);
            assert.ok(after.sx + after.sw <= atlas.width);
            assert.ok(after.sy + after.sh <= atlas.height);
            crops.add(`${after.sx},${after.sy}`);
          }
        } else y = end;
      }
    }
    for (const c of crops) {
      const [sx, sy] = c.split(",").map(Number);
      let nonzeroAlpha = 0;
      for (let x = sx; x < sx + 16; x++)
        for (let y = sy; y < sy + 16; y++)
          if (atlas.data[(y * atlas.width + x) * 4 + 3]) nonzeroAlpha++;
      assert.ok(nonzeroAlpha > 0, `empty real texture crop ${c}`);
    }
    assert.equal(result.total, 151702);
    assert.equal(result.previouslySupported, 138564);
    assert.equal(result.recovered, 13138);
    assert.equal(result.changedVersusIgnoringShapes, 6654);
    assert.equal(hash(bytes), sourceHash);
    t.diagnostic(
      JSON.stringify({
        ...result,
        uniqueCrops: crops.size,
        textureSha256: hash(textureBytes),
        textureWidth: atlas.width,
        textureHeight: atlas.height,
      }),
    );
  },
);
