import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { createHalfbrickLiquidSampler } from "../core/liquid-halfbrick.mjs";
import { renderScene } from "../core/renderer.mjs";
import { registerTextureSource } from "../core/assets.mjs";
import { prepareSceneFrames, sceneFrameKey } from "../core/scene-frames.mjs";

const empty = () => ({ active: false, shape: 0, liquid: 0 });
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
const half = (liquid = 127, liquidKind = 1, extra = {}) =>
  wet(liquid, liquidKind, { ...block(1), liquid, ...extra });
function make(own = half(), overrides = {}, options = {}, fill = block()) {
  const cells = { "100,200": own, ...overrides };
  const get = (x, y) => cells[`${x},${y}`] ?? fill;
  const region = {
    rect: { x: 100, y: 200, width: 1, height: 1 },
    cells: [own],
    getWorldTile: get,
  };
  return {
    region,
    cells,
    sample: createHalfbrickLiquidSampler(region, {
      worldSurface: 100,
      ...options,
    }),
  };
}
function plan(own, overrides, options, fill) {
  return make(own, overrides, options, fill).sample(100, 200);
}
const back = (result) => result.commands.filter((c) => c.drawBeforeTiles);

test("unwalled partial halfbrick below liquid uses a twelve-row original-texture gradient", () => {
  const p = plan(half(), { "100,199": wet(200) });
  assert.equal(p.supported, true);
  assert.equal(p.gradientRows, 12);
  assert.equal(p.normalDrawn, false);
  assert.deepEqual(p.requiredAssets, ["Liquid_0.png"]);
  assert.equal(p.commands.length, 12);
  for (const [row, c] of p.commands.entries()) {
    assert.deepEqual(
      [c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh],
      [0, row + 4, 16, 1, 0, row, 16, 1],
    );
    assert.equal(c.opacity, (127 / 255) * ((row + 0.5) / 12));
    assert.deepEqual(c.vertexAlphaEndpoints, [0, 127]);
    assert.equal(c.layer, "behind-tile");
    assert.equal(c.liquidLevel, 127);
  }
});

test("north plus a wet side extends the quad to sixteen rows with explicit PointClamp samples", () => {
  const p = plan(half(), { "100,199": wet(200), "99,200": wet(120) });
  assert.equal(p.gradientRows, 16);
  assert.equal(p.clampedRows, 4);
  assert.equal(p.commands.length, 16);
  for (let row = 0; row < 16; row++) {
    const c = p.commands[row];
    assert.equal(c.sy, Math.min(row + 4, 15));
    assert.equal(c.opacity, (127 / 255) * ((row + 0.5) / 16));
    assert.equal(
      c.sourceSampling,
      row >= 12 ? "point-clamp-bottom" : undefined,
    );
  }
});

test("surface halfbricks use uniform source alpha, while lava and honey retain their own texture", () => {
  for (const [kind, asset, endpoint] of [
    [1, "Liquid_0.png", 127],
    [2, "Liquid_1.png", 102],
    [3, "Liquid_11.png", 255],
  ]) {
    const p = plan(
      half(127, kind),
      { "100,199": wet(200, kind) },
      { lavaOpacity: 0.4 },
    );
    assert.equal(p.commands[0].asset, asset);
    assert.deepEqual(p.commands[0].vertexAlphaEndpoints, [0, endpoint]);
  }
  const surface = plan(half(), { "100,199": wet() }, { worldSurface: 200 });
  assert.equal(surface.gradientRows, 0);
  assert.deepEqual(
    back(surface).map((c) => [c.sy, c.sh, c.opacity]),
    [[4, 12, 1]],
  );
});

test("dry and fully wet halfbricks include the independent normal top pass", () => {
  for (const amount of [0, 255]) {
    const p = plan(
      half(amount),
      { "100,199": wet() },
      { layer: "foreground", waterfallFrame: 3 },
    );
    assert.equal(p.commands.length, 13);
    assert.equal(back(p).length, 12);
    assert.equal(p.normalDrawn, true);
    const normal = p.commands.at(-1);
    assert.equal(normal.asset, "water_0.png");
    assert.deepEqual(
      [normal.sx, normal.sy, normal.sh, normal.dy],
      [16, 296, 8, 0],
    );
    assert.equal(normal.opacity, 0.6);
    assert.equal(normal.liquidLevel, amount);
    assert.equal(normal.drawBeforeTiles, undefined);
  }
});

test("walls suppress the separate behind pass even if a waterfall could be registered", () => {
  const p = plan(half(127, 1, { wall: 1 }), {
    "100,199": wet(15),
    "99,200": wet(240),
    "101,200": empty(),
  });
  assert.equal(p.supported, true);
  assert.equal(back(p).length, 0);
  assert.equal(p.normalDrawn, true);
  assert.equal(p.waterfallDecision, "not-needed");
  const blocked = plan(half(127, 1, { type: 54 }), { "100,199": wet() });
  assert.equal(blocked.occluded, true);
  assert.deepEqual(blocked.commands, []);
});

test("raw side/self thresholds and bottom-only source geometry remain quantized", () => {
  assert.equal(plan(half(160)).occluded, true);
  assert.deepEqual(
    back(plan(half(161))).map((c) => [c.sy, c.sh, c.dy]),
    [[0, 12, 4]],
  );
  assert.deepEqual(
    back(plan(half(0), { "99,200": wet(128) })).map((c) => [c.sy, c.sh, c.dy]),
    [[0, 8, 8]],
  );
  assert.deepEqual(
    back(plan(half(0), { "100,201": wet(241) })).map((c) => [c.sy, c.sh, c.dy]),
    [[4, 4, 12]],
  );
  assert.equal(plan(half(0), { "100,201": wet(240) }).occluded, true);
});

test("a high wet side is safe when the opposite side cannot originate a waterfall", () => {
  for (const shape of [0, 2, 3, 4, 5]) {
    const p = plan(half(0), { "99,200": wet(240), "101,200": block(shape) });
    assert.equal(p.supported, true);
    assert.equal(p.waterfallDecision, "fresh-scan-ineligible");
    assert.deepEqual(
      back(p).map((c) => [c.sy, c.sh, c.dy]),
      [[0, 16, 0]],
    );
  }
});

test("open dry sides and upper raw levels reproduce the waterfall eligibility boundaries", () => {
  for (const east of [empty(), block(1), { ...block(), inactive: true }]) {
    const p = plan(half(), {
      "100,199": wet(15),
      "99,200": wet(161),
      "101,200": east,
    });
    assert.equal(p.reason, "halfbrick-waterfall-state-required");
    assert.equal(p.commands, undefined);
  }
  const deep = plan(half(), {
    "100,199": wet(16),
    "99,200": wet(161),
    "101,200": empty(),
  });
  assert.equal(deep.supported, true);
  const solidAbove = plan(half(), {
    "100,199": wet(16, 1, { ...block(), liquid: 16 }),
    "99,200": wet(161),
    "101,200": empty(),
  });
  assert.equal(solidAbove.reason, "halfbrick-waterfall-state-required");
  const slopeAbove = plan(half(), {
    "100,199": wet(16, 1, { ...block(2), liquid: 16 }),
    "99,200": wet(161),
    "101,200": empty(),
  });
  assert.equal(slopeAbove.supported, true);
});

test("rain/lava-rain/snow cloud origins require cache state even with closed horizontal sides", () => {
  for (const type of [196, 460, 717]) {
    const p = plan(half(0), { "100,199": block(0, type), "99,200": wet(240) });
    assert.equal(p.reason, "halfbrick-waterfall-state-required");
    const wetSelf = plan(half(), {
      "100,199": block(0, type),
      "99,200": wet(240),
    });
    assert.equal(wetSelf.supported, true);
  }
});

test("unsupported source contexts never yield partial output", () => {
  for (const [overrides, reason] of [
    [{ "100,199": wet(255, 4) }, "halfbrick-shimmer"],
    [{ "100,199": wet(255, 2) }, "halfbrick-mixed-liquid-neighborhood"],
    [{ "100,199": wet(256) }, "halfbrick-invalid-liquid-level"],
    [
      { "100,199": { ...block(), type: 999 } },
      "halfbrick-unknown-solid-neighborhood",
    ],
    [{ "100,199": { ...block(), shape: 6 } }, "halfbrick-invalid-shape"],
    [
      { "100,199": wet(255, 1, { type: 379 }) },
      "halfbrick-special-tile-neighborhood",
    ],
  ])
    assert.deepEqual(plan(half(), overrides), { supported: false, reason });
  assert.equal(
    plan(half(), {}, { worldSurface: undefined }).reason,
    "halfbrick-world-surface-unknown",
  );
  assert.equal(plan(half(), {}, {}, null).reason, "halfbrick-missing-context");
  assert.equal(plan(half(127, 1, { type: 51 })).reason, "halfbrick-non-solid");
  const fixture = make(half(0), { "100,199": wet(200) });
  fixture.region.context = {
    rect: { x: 99, y: 199, width: 3, height: 3 },
    cells: Array.from({ length: 9 }, () => block()),
  };
  fixture.region.context.cells[3] = wet(200);
  delete fixture.region.getWorldTile;
  const p = createHalfbrickLiquidSampler(fixture.region, { worldSurface: 100 })(
    100,
    200,
  );
  assert.equal(p.supported, false);
  assert.equal(p.reason, "visible-missing-context");
  assert.equal(p.commands, undefined);
});

test("native-pixel gradient keeps asymmetric source pixels and clamps only out-of-texture rows", () => {
  const p = plan(half(), { "100,199": wet(), "99,200": wet(120) });
  const texture = createCanvas(16, 16),
    source = texture.getContext("2d");
  for (let row = 0; row < 16; row++) {
    source.fillStyle = `rgb(${40 + row * 8},80,20)`;
    source.fillRect(4, row, 2, 1);
  }
  const canvas = createCanvas(16, 16),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, 16, 16);
  const rendered = renderScene(
    ctx,
    { width: 16, height: 16, commands: p.commands, warnings: [] },
    new Map([["Liquid_0.png", texture]]),
    { strict: true },
  );
  assert.equal(rendered.drawn, 16);
  for (let row = 0; row < 16; row++) {
    const pixel = [...ctx.getImageData(4, row, 1, 1).data];
    const expected =
      (40 + Math.min(row + 4, 15) * 8) * (127 / 255) * ((row + 0.5) / 16);
    assert.ok(
      Math.abs(pixel[0] - expected) <= 1.1,
      `row ${row}: ${pixel[0]} vs ${expected}`,
    );
    assert.deepEqual([...ctx.getImageData(3, row, 1, 1).data], [0, 0, 0, 255]);
  }
});

test("raw premultiplied and super-alpha source channels receive the vertex ramp exactly once", () => {
  const p = plan(half(), { "100,199": wet(), "99,200": wet(120) });
  const texture = (rgba) => {
    const canvas = createCanvas(16, 16),
      ctx = canvas.getContext("2d"),
      pixels = ctx.createImageData(16, 16);
    for (let i = 0; i < pixels.data.length; i += 4) pixels.data.set(rgba, i);
    ctx.putImageData(pixels, 0, 0);
    registerTextureSource(canvas, {
      pngBytes: new Uint8Array(),
      rawRgba: { width: 16, height: 16, data: pixels.data },
    });
    return canvas;
  };
  const background = [10, 30, 70, 255];
  const backgroundCommand = {
    kind: "wall",
    asset: "background",
    type: 1,
    sx: 0,
    sy: 0,
    sw: 16,
    sh: 16,
    dx: 0,
    dy: 0,
    dw: 16,
    dh: 16,
  };
  // Same clamped source row, different interpolation weights: frame caching
  // must cache only the source sample and not bake a second copy of the ramp.
  assert.equal(sceneFrameKey(p.commands[12]), sceneFrameKey(p.commands[15]));
  assert.notEqual(p.commands[12].opacity, p.commands[15].opacity);
  assert.ok(p.commands.every((c) => c.vertexColor === undefined));
  for (const rgba of [
    [80, 40, 20, 128],
    [120, 60, 30, 40],
    [120, 20, 10, 0],
  ]) {
    const assets = new Map([
      ["background", texture(background)],
      ["Liquid_0.png", texture(rgba)],
    ]);
    const renderPlan = {
      width: 16,
      height: 16,
      commands: [backgroundCommand, ...p.commands],
      warnings: [],
    };
    const frames = prepareSceneFrames(renderPlan, assets, createCanvas, {
      inputEncoding: "tconvert-game-raw",
      opaqueScene: true,
    });
    const canvas = createCanvas(16, 16),
      ctx = canvas.getContext("2d");
    const result = renderScene(ctx, renderPlan, assets, {
      strict: true,
      sceneFrames: frames,
    });
    assert.equal(result.skippedEffects, 0);
    assert.equal(frames.support.additiveFrames > 0, rgba[0] > rgba[3]);
    for (let row = 0; row < 16; row++) {
      const t = (127 / 255) * ((row + 0.5) / 16);
      const pixel = [...ctx.getImageData(8, row, 1, 1).data];
      for (let channel = 0; channel < 3; channel++) {
        // Quantize the analytic premultiplied result to the same byte domain;
        // the existing Canvas source-over/additive adapter permits ±2 bytes.
        const expected = Math.round(
          rgba[channel] * t + background[channel] * (1 - (rgba[3] / 255) * t),
        );
        assert.ok(
          Math.abs(pixel[channel] - expected) <= 2,
          `${rgba}, row ${row}, channel ${channel}: ${pixel[channel]} vs ${expected}`,
        );
      }
      assert.equal(pixel[3], 255);
    }
    frames.dispose();
  }
});

test("sampling preserves input records and selection-local placement", () => {
  const fixture = make(half(), { "100,199": wet() });
  const before = JSON.stringify(fixture.cells);
  const first = fixture.sample(100, 200),
    second = fixture.sample(100, 200);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(fixture.cells), before);
  fixture.region.rect.x = 98;
  fixture.region.cells[0] = block();
  const moved = createHalfbrickLiquidSampler(fixture.region, {
    worldSurface: 100,
  })(100, 200);
  assert.equal(moved.commands[0].dx, 32);
  assert.equal(moved.commands[0].worldX, 100);
});
