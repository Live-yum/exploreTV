import test from "node:test";
import assert from "node:assert/strict";
import { planOverviewBand, planScene } from "../core/renderer.mjs";
import {
  getOverviewCommandTemplate,
  materializeOverviewCommand,
  OVERVIEW_COMMAND_STRIDE,
} from "../core/overview-command-buffer.mjs";

const tile = (extra = {}) => ({
  active: true,
  type: 1,
  frameX: null,
  frameY: null,
  shape: 0,
  wall: 2,
  paint: 0,
  wallPaint: 0,
  liquid: 0,
  liquidKind: 0,
  ...extra,
});
function region(width = 22, height = 18, extra = {}) {
  return {
    rect: { x: 100, y: 200, width, height },
    source: { width: 8400, height: 2400, worldSurface: 649 },
    cells: Array.from({ length: width * height }, () => tile(extra)),
  };
}
function referenceView(plan) {
  const { compactTerrain, planningMilliseconds, ...result } = plan;
  result.commands = plan.commands.map((c) =>
    materializeOverviewCommand(plan, c),
  );
  return result;
}
function equivalent(r, options = {}) {
  const expected = planScene(r, options),
    actual = planOverviewBand(r, options);
  assert.deepEqual(referenceView(actual), expected);
  assert.equal(actual.compactTerrain.stride, OVERVIEW_COMMAND_STRIDE);
  assert.equal(
    actual.compactTerrain.records.length,
    actual.commands.filter((c) => typeof c === "number").length *
      OVERVIEW_COMMAND_STRIDE,
  );
  return actual;
}

test("ordinary overview owners go directly into bounded records and unique immutable frames", () => {
  const r = region(148, 68),
    before = structuredClone(r),
    plan = equivalent(r),
    { records, frames } = plan.compactTerrain;
  assert.ok(plan.commands.every((c) => Number.isInteger(c) && c < 0));
  assert.equal(records.byteLength, r.cells.length * 2 * 5 * 4);
  assert.ok(frames.length < 32);
  assert.ok(Object.isFrozen(frames));
  for (const frame of frames) {
    assert.ok(Object.isFrozen(frame));
    for (const name of ["x", "y", "dx", "dy"])
      assert.equal(Object.hasOwn(frame, name), false);
  }
  for (const field of ["walls", "liquids", "tiles", "layers", "total"])
    assert.ok(Number.isFinite(plan.planningMilliseconds[field]));
  const measured = ["walls", "liquids", "tiles", "layers"].reduce(
    (sum, field) => sum + plan.planningMilliseconds[field],
    0,
  );
  assert.ok(plan.planningMilliseconds.total >= measured);
  assert.equal(
    Object.hasOwn(planScene(region(1, 1)), "planningMilliseconds"),
    false,
  );
  assert.deepEqual(r, before);
});

test("compact planning preserves crop guards, emission owners, full dependencies and diagnostics", () => {
  const r = region();
  for (let i = 0; i < r.cells.length; i++)
    Object.assign(r.cells[i], {
      type: [0, 1, 2, 404][i % 4],
      shape: i % 6,
      paint: i % 32,
      wallPaint: (i * 3) % 32,
      invisibleBlock: i % 17 === 0,
      invisibleWall: i % 19 === 0,
      inactive: i % 7 === 0,
      fullbrightBlock: i % 5 === 0,
      wireRed: i % 23 === 0,
    });
  Object.assign(r.cells[0], {
    type: 999,
    wall: 65535,
    invisibleBlock: false,
    invisibleWall: false,
  });
  Object.assign(r.cells[1], { type: 373, shape: 0 });
  Object.assign(r.cells[2], { active: false, liquid: 128, liquidKind: 99 });
  for (const revealInvisible of [false, true])
    for (const paintEnabled of [false, true])
      for (const crop of [
        {},
        { emissionCore: { x: 107, y: 206, width: 6, height: 5 } },
        { outputBounds: { x: 83, y: 67, width: 99, height: 79 } },
        {
          emissionCore: { x: 100, y: 200, width: 1, height: 1 },
          outputBounds: { x: 83, y: 67, width: 99, height: 79 },
        },
      ]) {
        const p = equivalent(r, {
          revealInvisible,
          paintEnabled,
          liquids: { enabled: true },
          ...crop,
        });
        assert.ok(p.requiredAssets.includes("Wall_65535.png"));
        assert.ok(p.support.unsupportedTiles > 0);
        assert.ok(p.support.sourceHiddenTiles > 0);
      }
});

test("every tile family, saved frame and canonical shape retains its full reference plan", () => {
  for (const saved of [false, true])
    for (const shape of [-1, 0, 1, 2, 3, 4, 5, 6]) {
      const r = region(29, 26);
      r.cells = r.cells.map((_, i) =>
        tile({
          type: (i * 97) % 754,
          wall: i % 5,
          shape,
          paint: i % 32,
          wallPaint: i % 32,
          ...(saved ? { frameX: 0, frameY: 0 } : {}),
        }),
      );
      equivalent(r, { paintEnabled: true });
    }
});

test("noncanonical identifiers, paint and shapes retain the object fallback contract", () => {
  for (const shape of ["1", "2", 2.5, null, undefined, NaN])
    for (const paint of [-1, 256, 0.5, "3", {}, NaN]) {
      const r = region(4, 1);
      r.cells = [1, 65535, 65536, "length"].map((wall) =>
        tile({ wall, shape, paint, wallPaint: paint }),
      );
      equivalent(r, { paintEnabled: true });
    }
});

test("shared slope frames materialize private mutable polygons only on fallback", () => {
  const r = region(5, 5, { shape: 2 }),
    p = equivalent(r),
    slopeTokens = p.commands.filter(
      (c) => getOverviewCommandTemplate(p, c).kind === "tile",
    ),
    template = getOverviewCommandTemplate(p, slopeTokens[0]),
    first = materializeOverviewCommand(p, slopeTokens[0]),
    second = materializeOverviewCommand(p, slopeTokens[1]);
  assert.ok(Object.isFrozen(template.clip));
  assert.ok(template.clip.every(Object.isFrozen));
  assert.notEqual(first.clip, second.clip);
  assert.notEqual(first.clip, template.clip);
  first.clip[0][0] = 7;
  assert.equal(second.clip[0][0], 0);
  assert.equal(template.clip[0][0], 0);
  assert.equal(materializeOverviewCommand(p, slopeTokens[0]).clip[0][0], 0);
});

function mixedScene() {
  const r = region(24, 24),
    put = (x, y, value) => Object.assign(r.cells[x * 24 + y], value);
  r.treeContext = {
    hallowBG: 3,
    treeX: [1923, 3451, 6191],
    treeTopVariations: [3, 0, 5, 4, 0, 2, 32, 3, 0, 0, 0, 0, 0],
  };
  for (const [type, ox, oy, height] of [
    [237, 1, 1, 2],
    [617, 7, 4, 4],
  ])
    for (let x = 0; x < 3; x++)
      for (let y = 0; y < height; y++)
        put(ox + x, oy + y, { type, frameX: x * 18, frameY: y * 18 });
  put(2, 4, { type: 33, frameX: 0, frameY: 0 });
  put(3, 4, { type: 21, frameX: 36, frameY: 18, shape: 2 });
  put(4, 4, { type: 4, frameX: 0, frameY: 0 });
  put(5, 4, { type: 51 });
  put(6, 4, { type: 373 });
  put(18, 15, { type: 5, frameX: 22, frameY: 220 });
  for (let y = 16; y < 21; y++) put(18, y, { type: 5, frameX: 0, frameY: 0 });
  put(18, 21, { type: 109 });
  put(10, 9, { active: false, liquid: 255, liquidKind: 1 });
  return r;
}
function waterfallOptions(layer) {
  return {
    paintEnabled: true,
    liquids: {
      enabled: true,
      layer,
      worldSurface: 649,
      waterfallRegistry: {
        hasOrigin: () => false,
        commandsFor: () => [
          {
            kind: "waterfall",
            asset: "Waterfall_0.png",
            sx: 0,
            sy: 0,
            sw: 16,
            sh: 16,
            dx: 160,
            dy: 144,
            dw: 16,
            dh: 16,
            x: 10,
            y: 9,
          },
        ],
        model: "test-registry",
        scanComplete: true,
        stats: {},
      },
    },
  };
}

test("special overhangs, tree layers, liquids and waterfalls stay interleaved in reference order", () => {
  const r = mixedScene();
  for (const layer of ["foreground", "background"])
    for (const outputBounds of [
      undefined,
      { x: 80, y: 48, width: 192, height: 192 },
    ]) {
      const p = equivalent(r, { ...waterfallOptions(layer), outputBounds }),
        commands = referenceView(p).commands;
      assert.ok(p.commands.some((c) => typeof c === "number"));
      assert.ok(p.commands.some((c) => typeof c === "object"));
      assert.ok(p.support.staticSpecialObjects > 0);
      assert.ok(p.support.staticFlames > 0);
      assert.ok(p.support.staticTrees > 0);
      assert.ok(commands.some((c) => c.kind === "liquid"));
      assert.ok(commands.some((c) => c.kind === "waterfall"));
      assert.ok(commands.some((c) => c.specialLayer === "over-tiles"));
    }
});

test("context owners sort with compact ordinary owners without losing overhang diagnostics", () => {
  const full = region(24, 24);
  full.rect.x = 96;
  full.rect.y = 196;
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 2; y++)
      Object.assign(full.cells[(8 + x) * 24 + 20 + y], {
        type: 237,
        frameX: x * 18,
        frameY: y * 18,
      });
  Object.assign(full.cells[2 * 24 + 6], { type: 597, frameX: 0, frameY: 0 });
  const r = {
    ...full,
    rect: { x: 100, y: 200, width: 16, height: 16 },
    context: full,
    cells: [],
  };
  for (let x = 4; x < 20; x++)
    for (let y = 4; y < 20; y++)
      r.cells.push(full.cells[x * full.rect.height + y]);
  for (const options of [{}, waterfallOptions("foreground")]) {
    const p = equivalent(r, options);
    assert.ok(p.support.contextCommands > 0);
    assert.ok(p.contextOmissions.length > 0);
    assert.ok(p.commands.some((c) => typeof c === "number"));
  }
});

test("precomputed terrain masks retain signed center variation and region-edge behavior", () => {
  const r = region(3, 3);
  r.rect.x = r.rect.y = -1;
  const mask = [12, 13, 5, 14, 15, 7, 10, 11, 3],
    frames = new Uint8Array(18);
  for (let i = 0; i < mask.length; i++) {
    frames[i * 2] = i === 4 ? 17 : mask[i];
    frames[i * 2 + 1] = mask[i];
  }
  equivalent(r, { overviewTerrainFrames: frames });
  for (const value of [null, [], new Uint8Array(17), new Uint16Array(18)]) {
    assert.throws(
      () => planOverviewBand(r, { overviewTerrainFrames: value }),
      /terrain frame table/,
    );
    assert.deepEqual(
      planScene(r, { overviewTerrainFrames: value }),
      planScene(r),
    );
  }
});

test("compact records preserve logical budgets for culled and multi-draw owners", () => {
  const r = mixedScene(),
    options = waterfallOptions("foreground"),
    count = planScene(r, options).commands.length,
    cropped = {
      ...options,
      outputBounds: { x: 144, y: 128, width: 64, height: 64 },
    };
  for (const maxCommands of [0, -1, 1.5, 131073, Infinity, count - 1])
    for (const crop of [options, cropped]) {
      assert.throws(
        () => planScene(r, { ...crop, maxCommands }),
        /command budget/,
      );
      assert.throws(
        () => planOverviewBand(r, { ...crop, maxCommands }),
        /command budget/,
      );
    }
  equivalent(r, { ...cropped, maxCommands: count });
  const p = equivalent(region(2, 2));
  for (const token of [0, 1, -0.5, NaN, Infinity, -100]) {
    assert.throws(() => materializeOverviewCommand(p, token), /command token/);
    assert.throws(() => getOverviewCommandTemplate(p, token), /command token/);
  }
  const object = { kind: "special" };
  assert.equal(materializeOverviewCommand(p, object), object);
  assert.equal(getOverviewCommandTemplate(p, object), object);
});
