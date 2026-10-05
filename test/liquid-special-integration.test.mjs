import test from "node:test";
import assert from "node:assert/strict";
import { planLiquids } from "../core/liquid.mjs";
import { planScene } from "../core/renderer.mjs";
import { isSolidOrSlopedTile } from "../core/tile-solidity.mjs";

const empty = () => ({ active: false, type: 0, shape: 0, liquid: 0 });
const block = (shape = 0, type = 1) => ({
  active: true,
  type,
  shape,
  liquid: 0,
});
const wet = (liquid = 255, liquidKind = 1, extra = {}) => ({
  ...empty(),
  liquid,
  liquidKind,
  ...extra,
});
const lily = () =>
  wet(255, 1, { active: true, type: 518, frameX: 36, frameY: 18 });
const options = {
  enabled: true,
  worldSurface: 300,
  layer: "foreground",
  isSolid: isSolidOrSlopedTile,
};
function fixture(own = wet(), overrides = {}, fill = block()) {
  const records = { "100,100": own, ...overrides };
  const getWorldTile = (x, y) => records[`${x},${y}`] ?? fill;
  const context = { rect: { x: 99, y: 99, width: 3, height: 3 }, cells: [] };
  for (let x = 99; x <= 101; x++)
    for (let y = 99; y <= 101; y++) context.cells.push(getWorldTile(x, y));
  return {
    rect: { x: 100, y: 100, width: 1, height: 1 },
    cells: [own],
    context,
    getWorldTile,
  };
}
function accounted(p) {
  assert.equal(
    p.support.evaluatedCells,
    p.support.drawn +
      p.support.skippedSolid +
      p.support.skippedOccluded +
      p.support.unsupported,
  );
  assert.equal(p.support.commandCount, p.commands.length);
}

test("integrated lily liquid reuses the existing Tile exactly once before the foreground pass", () => {
  const region = fixture(lily());
  const without = planScene(region, { liquids: { enabled: false } });
  const withWater = planScene(region, { liquids: options });
  const tile = withWater.commands.filter((c) => c.kind === "tile");
  assert.deepEqual(
    tile,
    without.commands.filter((c) => c.kind === "tile"),
  );
  assert.equal(tile.length, 1);
  assert.equal(tile[0].asset, "Tiles_518.png");
  assert.equal(tile[0].dy, -8);
  const liquid = withWater.commands.find((c) => c.kind === "liquid");
  assert.ok(
    withWater.commands.indexOf(tile[0]) < withWater.commands.indexOf(liquid),
  );
  assert.equal(liquid.asset, "water_0.png");
  assert.equal(withWater.support.liquidDrawing.unsupported, 0);
  assert.equal(withWater.support.liquidDrawing.specialContextDrawn, 1);
  assert.equal(withWater.support.liquidDrawing.lilyUnderlayCells, 1);
});

test("direct lily-neighbor failure becomes one counted source-derived liquid command", () => {
  const region = fixture(wet(127), { "101,100": lily() });
  const before = JSON.stringify(region);
  const p = planLiquids(region, options);
  assert.equal(p.support.unsupported, 0);
  assert.equal(p.support.drawn, 1);
  assert.equal(p.support.specialContextDrawn, 1);
  assert.equal(p.support.visibleLevelDrawn, 1);
  assert.equal(p.support.lilyUnderlayCells, 0);
  assert.equal(p.commands[0].fidelity, "static-source-visible-level");
  assert.equal(JSON.stringify(region), before);
  accounted(p);
});

test("extended lily dependency failure is retried only after the original normal solver rejects it", () => {
  const region = fixture(
    wet(127),
    { "99,100": block(2), "102,100": lily() },
    wet(),
  );
  const p = planLiquids(region, options);
  assert.equal(p.support.unsupported, 0);
  assert.equal(p.support.specialContextDrawn, 1);
  assert.equal(p.support.visibleLevelDrawn, 1);
  assert.equal(p.commands[0].liquidLevel, 127);
  accounted(p);
});

test("sloped platforms use the normal pass without increasing solid-shape draw accounting", () => {
  for (const shape of [2, 3]) {
    const p = planLiquids(
      fixture(wet(127, 1, { active: true, type: 19, shape })),
      options,
    );
    assert.equal(p.support.unsupported, 0);
    assert.equal(p.support.specialContextDrawn, 1);
    assert.equal(p.support.shapeDrawn, 0);
    assert.equal(p.support.visibleLevelDrawn, 1);
    assert.equal(p.commands[0].asset, "water_0.png");
    assert.equal(p.commands[0].drawBeforeTiles, undefined);
    accounted(p);
  }
});

test("mixed wet seeds retain their own asset while uncertain mixed waterfalls remain unsupported", () => {
  const p = planLiquids(
    fixture(wet(86, 1), { "100,99": wet(255, 3) }),
    options,
  );
  assert.equal(p.support.unsupported, 0);
  assert.equal(p.commands[0].asset, "water_0.png");
  assert.equal(p.commands[0].liquidType, 0);
  assert.equal(p.commands[0].liquidLevel, 86);
  const unresolved = planLiquids(
    fixture(block(1), {
      "99,100": wet(255, 1),
      "101,100": empty(),
      "101,101": wet(255, 2),
    }),
    options,
  );
  assert.equal(unresolved.commands.length, 0);
  assert.equal(
    unresolved.support.unsupportedByReason[
      "mixed-halfbrick-waterfall-state-required"
    ],
    1,
  );
  assert.equal(unresolved.support.liquidCells, 0);
  assert.equal(unresolved.support.shapeCandidateCells, 1);
  accounted(p);
  accounted(unresolved);
});

test("lily-neighbor solid slopes count one dry candidate and preserve the PointClamp continuation", () => {
  const own = block(2);
  const p = planLiquids(
    fixture(own, { "100,99": wet(), "101,100": lily() }),
    options,
  );
  assert.equal(p.commands.length, 2);
  assert.equal(p.support.specialContextDrawn, 1);
  assert.equal(p.support.shapeDrawn, 1);
  assert.equal(p.support.visibleLevelDrawn, 0);
  assert.equal(p.support.clampedShapeCells, 1);
  assert.equal(p.support.shapeCandidateCells, 1);
  assert.equal(p.support.liquidCells, 0);
  assert.equal(own.liquid, 0);
  assert.ok(p.commands.every((c) => c.drawBeforeTiles));
  assert.equal(p.commands[1].sourceSampling, "point-clamp-bottom");
  accounted(p);
});

test("Bubble, Grate, Shimmer and unavailable lily background ordering are still explicit", () => {
  for (const [region, extra, reason] of [
    [
      fixture(wet(), { "101,100": block(0, 379) }),
      {},
      "special-bubble-runtime-solid",
    ],
    [fixture(wet(), { "101,100": block(0, 546) }), {}, "special-grate-context"],
    [fixture(wet(255, 4)), {}, "shimmer"],
    [fixture(lily()), { layer: "background" }, "special-lily-background-layer"],
  ]) {
    const p = planLiquids(region, { ...options, ...extra });
    assert.equal(p.commands.length, 0);
    assert.equal(p.support.unsupportedByReason[reason], 1);
    assert.equal(p.support.specialContextDrawn, 0);
    accounted(p);
  }
});

test("already supported flat fills preserve their complete command and bypass the candidate", () => {
  const p = planLiquids(fixture(wet(), {}, wet()), options);
  assert.deepEqual(p.commands, [
    {
      kind: "liquid",
      asset: "water_0.png",
      sourceAsset: "Images/Misc/water_0.png",
      sx: 16,
      sy: 48,
      sw: 16,
      sh: 16,
      dx: 0,
      dy: 0,
      dw: 16,
      dh: 16,
      opacity: 0.6,
      frontOpacity: 0.6,
      layer: "foreground",
      liquidType: 0,
      liquidLevel: 255,
      x: 0,
      y: 0,
      worldX: 100,
      worldY: 100,
      fidelity: "flat-fill-approximation",
    },
  ]);
  assert.equal(p.support.specialContextDrawn, 0);
  accounted(p);
});
