import test from "node:test";
import assert from "node:assert/strict";
import { planLiquids } from "../core/liquid.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { renderScene } from "../core/renderer.mjs";
const empty = () => ({ active: false, liquid: 0, shape: 0 });
const wet = (liquid = 255, liquidKind = 1, extra = {}) => ({
  ...empty(),
  liquid,
  liquidKind,
  ...extra,
});
const region = (cells, width = 1, height = cells.length, x = 0, y = 0) => ({
  rect: { x, y, width, height },
  cells,
});
const opts = { enabled: true, worldSurface: 100, isSolid: (t) => t.type === 1 };
test("disabled by default and inputs remain untouched", () => {
  const r = region([Object.freeze(wet())]);
  Object.freeze(r.cells);
  assert.deepEqual(planLiquids(r).commands, []);
  const before = JSON.stringify(r);
  planLiquids(r, opts);
  assert.equal(JSON.stringify(r), before);
});
test("storage kinds map to modern texture assets and shimmer is explicitly skipped", () => {
  for (const [kind, asset] of [
    [1, "water_0.png"],
    [2, "water_1.png"],
    [3, "water_11.png"],
  ]) {
    const p = planLiquids(region([wet(255, kind)]), opts);
    assert.equal(p.commands[0].asset, asset);
    assert.deepEqual(p.requiredAssets, [asset]);
  }
  const p = planLiquids(region([wet(255, 4)], 1, 1, 30, 40), opts);
  assert.deepEqual(p.commands, []);
  assert.deepEqual(p.support.unsupportedCoordinates, [
    { x: 30, y: 40, reason: "shimmer" },
  ]);
});
test("flat byte fill is deterministic and explicitly approximate", () => {
  for (const [level, h] of [
    [1, 1],
    [127, 8],
    [128, 9],
    [255, 16],
  ]) {
    const c = planLiquids(region([wet(level)]), opts).commands[0];
    assert.deepEqual([c.sh, c.dh, c.dy], [h, h, 16 - h]);
    assert.equal(c.fidelity, "flat-fill-approximation");
  }
});
test("column-major cells use selected-local coordinates", () => {
  const p = planLiquids(
    region([empty(), wet(), wet(), empty()], 2, 2, 99, 101),
    opts,
  );
  assert.deepEqual(
    p.commands.map((c) => [c.dx, c.dy, c.worldX, c.worldY]),
    [
      [0, 16, 99, 102],
      [16, 0, 100, 101],
    ],
  );
});
test("context determines topology without emitting outside selection", () => {
  const r = region([wet()], 1, 1, 1, 1);
  r.context = region(
    Array.from({ length: 9 }, () => wet()),
    3,
    3,
  );
  const p = planLiquids(r, { ...opts, waterfallFrame: 3 });
  assert.equal(p.commands.length, 1);
  assert.equal(p.commands[0].sy, 48 + 240);
  assert.equal(p.support.missingContextCells, 0);
});
test("side atlas uses normal animation and central atlas uses waterfall clock", () => {
  const r = region([wet(), wet()], 2, 1);
  const p = planLiquids(r, { ...opts, frame: 2, waterfallFrame: 7 });
  assert.deepEqual(
    p.commands.map((c) => [c.sx, c.sy]),
    [
      [0, 160],
      [32, 160],
    ],
  );
  assert.equal(
    planLiquids(region([wet()]), { ...opts, frame: 2, waterfallFrame: 7 })
      .commands[0].sy,
    16 + 560,
  );
});
test("surface row uses fixed atlas Y and source metadata fallback", () => {
  const r = region([wet()], 1, 1, 1, 100);
  r.context = region(
    [empty(), wet(), empty(), wet(), empty(), wet()],
    3,
    2,
    0,
    99,
  );
  r.source = { worldSurface: 100 };
  const p = planLiquids(r, { enabled: true, waterfallFrame: 3 });
  assert.equal(p.commands[0].sy, 1280);
  assert.equal(p.support.worldSurfaceKnown, true);
  assert.ok(
    planLiquids(region([wet()]), { enabled: true }).warnings.some((w) =>
      w.includes("worldSurface"),
    ),
  );
});
test("front/background opacity is explicit; style and alpha validated", () => {
  const r = region([wet(255, 2)]);
  assert.equal(
    planLiquids(r, { ...opts, lavaOpacity: 0.5 }).commands[0].opacity,
    0.5,
  );
  assert.equal(
    planLiquids(r, { ...opts, lavaOpacity: 0.5, layer: "foreground" })
      .commands[0].opacity,
    0.475,
  );
  assert.equal(
    planLiquids(region([wet()]), { ...opts, waterStyle: 13 }).commands[0].asset,
    "water_13.png",
  );
  assert.throws(() => planLiquids(r, { ...opts, waterStyle: 11 }), RangeError);
});
test("unverified shapes, special neighbors, unknown solids, and mixed liquids are counted", () => {
  for (const [extra, reason] of [
    [{ active: true, shape: 1 }, "shape-non-solid"],
    [{ active: true, shape: 2 }, "shape-non-solid"],
    [{ active: true, type: 518 }, "special-tile-neighborhood"],
  ]) {
    assert.equal(
      planLiquids(region([wet(255, 1, extra)]), opts).support
        .unsupportedByReason[reason],
      1,
    );
  }
  assert.equal(
    planLiquids(region([wet(255, 1, { active: true, type: 777 })]), {
      enabled: true,
    }).support.unsupported,
    1,
  );
  assert.equal(
    planLiquids(region([wet(), wet(255, 2)]), opts).support.unsupportedByReason[
      "mixed-liquid-neighborhood"
    ],
    2,
  );
  assert.equal(
    planLiquids(region([wet(255, 1, { active: true, type: 1 })]), opts).support
      .skippedSolid,
    1,
  );
});

function shapeScene(shape = 2, level = 255, extra = {}) {
  const own = wet(level, 1, { active: true, type: 1, shape, ...extra });
  const r = region([own], 1, 1, 20, 200);
  r.context = region(Array.from({ length: 9 }, empty), 3, 3, 19, 199);
  r.context.cells[4] = own;
  return r;
}
const north = 3,
  west = 1,
  east = 7,
  south = 5;
const block = (shape = 0) => ({ ...empty(), active: true, type: 1, shape });

test("source-backed slope crops use LiquidSlope atlas columns and two-pixel fill quantization", () => {
  for (const [shape, sx] of [
    [2, 0],
    [3, 18],
    [4, 36],
    [5, 54],
  ]) {
    const r = shapeScene(shape, 127);
    r.context.cells[west] = block();
    r.context.cells[east] = block();
    const p = planLiquids(r, opts),
      c = p.commands[0];
    assert.equal(p.support.unsupported, 0);
    assert.equal(c.asset, "LiquidSlope_0.png");
    assert.deepEqual([c.sx, c.sy, c.sw, c.sh, c.dy], [sx, 8, 16, 8, 8]);
    assert.equal(c.opacity, 0.5);
    assert.equal(c.drawBeforeTiles, true);
    assert.equal(c.layer, "behind-tile");
    assert.equal(c.fidelity, "static-slope-liquid-atlas");
  }
});

test("shape atlas mapping retains lava/honey identity and source depth/wall opacity", () => {
  for (const [liquidKind, asset, expected] of [
    [1, "LiquidSlope_0.png", 0.5],
    [2, "LiquidSlope_1.png", 1],
    [3, "LiquidSlope_11.png", 1],
  ]) {
    const r = shapeScene(2, 255, { liquidKind });
    const c = planLiquids(r, opts).commands[0];
    assert.equal(c.asset, asset);
    assert.equal(c.opacity, expected);
  }
  const r = shapeScene(2, 255, { wall: 21 });
  assert.equal(
    planLiquids(r, { ...opts, worldSurface: 250 }).commands[0].opacity,
    0.9,
  );
  r.cells[0].wall = 1;
  assert.equal(
    planLiquids(r, { ...opts, worldSurface: 250 }).commands[0].opacity,
    0.6,
  );
  r.cells[0].liquidKind = 2;
  assert.equal(
    planLiquids(r, { ...opts, worldSurface: 250, lavaOpacity: 0.4 }).commands[0]
      .opacity,
    0.4,
  );
});

test("top-only and bottom-only slope inflows preserve their source strips", () => {
  const upper = shapeScene(2);
  upper.context.cells[north] = wet();
  let c = planLiquids(upper, opts).commands[0];
  assert.deepEqual([c.sx, c.sy, c.sh, c.dy], [0, 4, 12, 0]);
  const lower = shapeScene(4);
  lower.context.cells[south] = wet();
  lower.context.cells[east] = block();
  c = planLiquids(lower, opts).commands[0];
  assert.deepEqual([c.sx, c.sy, c.sh, c.dy], [36, 4, 4, 12]);
});

test("source PointClamp becomes bounded body/last-row crops while open-side occlusion stays explicit", () => {
  const r = shapeScene(2);
  r.context.cells[north] = wet();
  r.context.cells[east] = wet();
  const p = planLiquids(r, opts);
  assert.equal(p.support.unsupported, 0);
  assert.equal(p.support.drawn, 1);
  assert.equal(p.support.commandCount, 2);
  assert.equal(p.support.clampedShapeCells, 1);
  assert.deepEqual(
    p.commands.map((c) => [c.sy, c.sh, c.dy, c.dh]),
    [
      [4, 12, 0, 12],
      [15, 1, 12, 4],
    ],
  );
  const occluded = planLiquids(shapeScene(4), opts);
  assert.equal(occluded.commands.length, 0);
  assert.equal(occluded.support.skippedOccluded, 1);
});

test("PointClamp overflow repeats actual edge pixels at native scale", () => {
  const r = shapeScene(2);
  r.context.cells[north] = wet();
  r.context.cells[east] = wet();
  const p = planLiquids(r, opts);
  const atlas = createCanvas(72, 16),
    ctx = atlas.getContext("2d");
  for (let y = 0; y < 16; y++) {
    ctx.fillStyle = `rgb(${y * 16},80,30)`;
    ctx.fillRect(0, y, 16, 1);
  }
  const output = createCanvas(16, 16),
    out = output.getContext("2d");
  renderScene(
    out,
    { width: 16, height: 16, commands: p.commands, warnings: [] },
    new Map([["LiquidSlope_0.png", atlas]]),
    { strict: true },
  );
  const pixel = (y) => [...out.getImageData(2, y, 1, 1).data];
  assert.ok(Math.abs(pixel(0)[0] - 64) <= 1);
  assert.ok(Math.abs(pixel(11)[0] - 240) <= 1);
  for (let y = 12; y < 16; y++) assert.deepEqual(pixel(y), pixel(11));
});

test("known slope neighbors allow a provably full visible-level cell without treating unknowns as air", () => {
  const r = region([wet()], 1, 1, 20, 200);
  r.context = region(
    Array.from({ length: 9 }, () => wet()),
    3,
    3,
    19,
    199,
  );
  r.context.cells[west] = block(2);
  r.context.cells[north] = block(1);
  const p = planLiquids(r, { ...opts, waterfallFrame: 3 });
  assert.equal(p.support.unsupported, 0);
  assert.equal(p.support.sourceGeometryDrawn, 1);
  assert.deepEqual(
    [p.commands[0].sx, p.commands[0].sy, p.commands[0].sw, p.commands[0].sh],
    [16, 288, 16, 16],
  );
  assert.equal(p.commands[0].fidelity, "static-full-liquid-near-shape");
  r.context.cells[east] = empty();
  assert.equal(
    planLiquids(r, opts).support.unsupportedByReason["visible-missing-context"],
    1,
  );
  r.context.cells[east] = { active: true, type: 999, shape: 0 };
  assert.equal(
    planLiquids(r, {
      ...opts,
      isSolid: (t) => (t.type === 1 ? true : undefined),
    }).support.unsupportedByReason["unknown-solid-neighborhood"],
    1,
  );
});

test("a walled halfbrick under full same-kind liquid uses only the normal top eight pixels", () => {
  const r = shapeScene(1, 255, { wall: 1 });
  r.context.cells = Array.from({ length: 9 }, () => wet());
  r.context.cells[4] = r.cells[0];
  const p = planLiquids(r, { ...opts, waterfallFrame: 2, layer: "foreground" });
  assert.equal(p.commands.length, 1);
  const c = p.commands[0];
  assert.equal(c.asset, "water_0.png");
  assert.deepEqual(
    [c.sx, c.sy, c.sw, c.sh, c.dx, c.dy],
    [16, 216, 16, 8, 0, 0],
  );
  assert.equal(c.opacity, 0.6);
  assert.equal(c.drawBeforeTiles, undefined);
  assert.equal(c.fidelity, "static-wet-halfbrick-top");
});

test("safe halfbrick self-liquid uses real Liquid PNG while unresolved overlap/waterfalls are rejected", () => {
  const r = shapeScene(1, 200);
  const c = planLiquids(r, opts).commands[0];
  assert.equal(c.asset, "Liquid_0.png");
  assert.deepEqual([c.sx, c.sy, c.sw, c.sh, c.dy], [0, 0, 16, 14, 2]);
  assert.equal(c.drawBeforeTiles, true);
  r.context.cells[west] = wet(200);
  assert.equal(
    planLiquids(r, opts).support.unsupportedByReason[
      "halfbrick-waterfall-neighborhood"
    ],
    1,
  );
  r.context.cells[west] = empty();
  r.context.cells[north] = wet(200);
  assert.equal(
    planLiquids(r, opts).support.unsupportedByReason[
      "halfbrick-overlap-neighborhood"
    ],
    1,
  );
});

test("shape subsets still reject mixed liquid, shimmer, missing context, malformed shapes and unknown depth", () => {
  const r = shapeScene();
  r.context.cells[west] = wet(255, 2);
  assert.equal(
    planLiquids(r, opts).support.unsupportedByReason[
      "mixed-liquid-neighborhood"
    ],
    1,
  );
  r.context.cells[west] = empty();
  assert.equal(
    planLiquids(r, { enabled: true, isSolid: opts.isSolid }).support
      .unsupportedByReason["shape-world-surface-unknown"],
    1,
  );
  r.cells[0].liquidKind = 4;
  assert.equal(planLiquids(r, opts).support.unsupportedByReason.shimmer, 1);
  r.cells[0].liquidKind = 1;
  r.cells[0].shape = 6;
  assert.equal(
    planLiquids(r, opts).support.unsupportedByReason[
      "invalid-shape-neighborhood"
    ],
    1,
  );
  r.cells[0].shape = 2;
  delete r.context;
  assert.equal(
    planLiquids(r, opts).support.unsupportedByReason["shape-missing-context"],
    1,
  );
});

test("slope source pixels are copied with their own alpha mask, never replaced by a generic triangle", () => {
  const r = shapeScene(3, 127);
  const p = planLiquids(r, opts),
    c = p.commands[0];
  const atlas = createCanvas(72, 16),
    ctx = atlas.getContext("2d");
  // An intentionally non-triangular original fixture: only one asymmetric bar.
  ctx.fillStyle = "rgb(240,80,20)";
  ctx.fillRect(18 + 3, 8 + 2, 2, 3);
  const output = createCanvas(16, 16),
    outputContext = output.getContext("2d");
  const report = renderScene(
    outputContext,
    { width: 16, height: 16, commands: [c], warnings: [] },
    new Map([["LiquidSlope_0.png", atlas]]),
    { strict: true },
  );
  assert.equal(report.drawn, 1);
  const pixel = (x, y) => [...outputContext.getImageData(x, y, 1, 1).data];
  assert.ok(Math.abs(pixel(3, 10)[3] - 128) <= 1);
  assert.deepEqual(pixel(2, 10), [0, 0, 0, 0]);
  assert.deepEqual(pixel(15, 15), [0, 0, 0, 0]);
});

test("shape world offsets are selection-local and planner never mutates cells", () => {
  const r = shapeScene(2, 127);
  const before = structuredClone(r);
  const c = planLiquids(r, opts).commands[0];
  assert.deepEqual([c.dx, c.dy, c.worldX, c.worldY], [0, 8, 20, 200]);
  assert.deepEqual(r, before);
});

test("dry solid slopes use source-backed neighboring liquid without fabricating a stored liquid byte", () => {
  const r = shapeScene(2, 0);
  r.context.cells[east] = wet(127, 2);
  const before = structuredClone(r);
  const p = planLiquids(r, opts),
    c = p.commands[0];
  assert.equal(p.support.liquidCells, 0);
  assert.equal(p.support.shapeCandidateCells, 1);
  assert.equal(p.support.evaluatedCells, 1);
  assert.equal(p.support.shapeDrawn, 1);
  assert.equal(c.asset, "LiquidSlope_1.png");
  assert.deepEqual([c.sx, c.sy, c.sh, c.dy], [0, 8, 8, 8]);
  assert.equal(c.liquidLevel, 0);
  assert.deepEqual(r, before);
  r.context.cells[east] = empty();
  assert.equal(planLiquids(r, opts).commands.length, 0);
});

test("dry halfbrick with a wall inherits full liquid above only for the proven eight-pixel subset", () => {
  const r = shapeScene(1, 0, { wall: 1 });
  r.context.cells = Array.from({ length: 9 }, () => wet(255, 3));
  r.context.cells[4] = r.cells[0];
  const p = planLiquids(r, opts);
  assert.equal(p.support.liquidCells, 0);
  assert.equal(p.support.shapeCandidateCells, 1);
  assert.equal(p.commands[0].asset, "water_11.png");
  assert.equal(p.commands[0].sh, 8);
  assert.equal(p.commands[0].liquidLevel, 0);
});
test("actuated solids do not occlude and platform is not assumed solid", () => {
  assert.equal(
    planLiquids(
      region([wet(255, 1, { active: true, type: 1, inactive: true })]),
      opts,
    ).support.drawn,
    1,
  );
  assert.equal(
    planLiquids(region([wet(255, 1, { active: true, type: 19 })]), {
      enabled: true,
    }).support.drawn,
    1,
  );
});

test("partial liquid near a slope uses source visible geometry with one counted command", () => {
  const r = region([wet(1)], 1, 1, 20, 200);
  r.context = region(
    Array.from({ length: 9 }, () => block()),
    3,
    3,
    19,
    199,
  );
  r.context.cells[4] = r.cells[0];
  r.context.cells[west] = block(2);
  r.getWorldTile = () => block();
  const p = planLiquids(r, opts),
    c = p.commands[0];
  assert.equal(c.fidelity, "static-source-visible-level");
  assert.deepEqual([c.sx, c.sy, c.sh, c.dy], [16, 1280, 4, 12]);
  assert.equal(p.support.evaluatedCells, 1);
  assert.equal(p.support.drawn, 1);
  assert.equal(p.support.sourceGeometryDrawn, 1);
  assert.equal(p.support.visibleLevelDrawn, 1);
  assert.equal(p.support.shapeDrawn, 0);
  assert.equal(p.support.commandCount, 1);
  assert.equal(p.support.unsupported, 0);
  assert.deepEqual(p.requiredAssets, ["water_0.png"]);
});

test("dry walled halfbricks below partial liquid use one normal pass and retain raw accounting", () => {
  const r = shapeScene(1, 0, { wall: 1 });
  r.context.cells = Array.from({ length: 9 }, () => block());
  r.context.cells[4] = r.cells[0];
  r.context.cells[north] = wet(1, 3);
  r.getWorldTile = () => block();
  const p = planLiquids(r, { ...opts, layer: "foreground" });
  assert.equal(p.commands.length, 1);
  assert.equal(p.commands[0].asset, "water_11.png");
  assert.equal(p.commands[0].layer, "foreground");
  assert.equal(p.commands[0].drawBeforeTiles, undefined);
  assert.equal(p.commands[0].liquidLevel, 0);
  assert.equal(p.commands[0].sh, 8);
  assert.equal(p.support.liquidCells, 0);
  assert.equal(p.support.shapeCandidateCells, 1);
  assert.equal(p.support.evaluatedCells, 1);
  assert.equal(p.support.shapeDrawn, 1);
  assert.equal(p.support.visibleLevelDrawn, 1);
  assert.equal(p.support.unsupported, 0);
  assert.equal(r.cells[0].liquid, 0);
  r.cells[0].wall = 0;
  const unwalled = planLiquids(r, opts);
  assert.equal(unwalled.commands.length, 0);
  assert.equal(
    unwalled.support.unsupportedByReason["halfbrick-overlap-neighborhood"],
    1,
  );
});

test("visible-level integration rejects unknown or missing dependencies beyond the local preflight", () => {
  const r = region([wet(127)], 1, 1, 20, 200);
  r.context = region(
    Array.from({ length: 9 }, () => wet()),
    3,
    3,
    19,
    199,
  );
  r.context.cells[4] = r.cells[0];
  r.context.cells[west] = block(2);
  let p = planLiquids(r, opts);
  assert.equal(p.commands.length, 0);
  assert.equal(p.support.unsupportedByReason["visible-missing-context"], 1);
  r.getWorldTile = () => ({ ...block(), type: 999 });
  p = planLiquids(r, {
    ...opts,
    isSolid: (t) => (t.type === 1 ? true : undefined),
  });
  assert.equal(p.commands.length, 0);
  assert.equal(p.support.visibleLevelDrawn, 0);
  assert.equal(
    p.support.unsupportedByReason["visible-unknown-solid-neighborhood"],
    1,
  );
  assert.equal(
    p.support.evaluatedCells,
    p.support.drawn +
      p.support.skippedSolid +
      p.support.skippedOccluded +
      p.support.unsupported,
  );
});
