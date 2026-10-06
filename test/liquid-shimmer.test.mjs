import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  openWorld,
  Reader,
  decodeRecord,
  extractSceneRegion,
} from "../core/world.mjs";
import { planScene, renderScene } from "../core/renderer.mjs";
import { registerTextureSource } from "../core/assets.mjs";
import { prepareSceneFrames } from "../core/scene-frames.mjs";
import { decodePngRgba } from "../core/png-rgba.mjs";
import { isSolidOrSlopedTile } from "../core/tile-solidity.mjs";
import {
  SHIMMER_ASSETS,
  SHIMMER_STATIC_STATE,
  shimmerBaseColor,
  shimmerBaseVertexColors,
  shimmerGlitterColor,
  shimmerGlitterOpacity,
  shimmerGlitterVertexColors,
  shimmerFrame,
  shimmerNoise,
  createShimmerLiquidSampler,
  planShimmerLiquids,
  interpolateShimmerVertexColors,
  rasterizeShimmerCommand,
} from "../core/liquid-shimmer.mjs";

const air = Object.freeze({
  active: false,
  type: 0,
  shape: 0,
  liquid: 0,
  liquidKind: 0,
  wall: 0,
});
const stone = Object.freeze({ ...air, active: true, type: 1 });
const wet = (amount = 255, extra = {}) =>
  Object.freeze({ ...air, liquid: amount, liquidKind: 4, ...extra });
function setup(
  cells = {},
  fill = stone,
  options = {},
  origin = { x: 100, y: 100 },
) {
  const get = (x, y) =>
    cells[`${x},${y}`] ?? (typeof fill === "function" ? fill(x, y) : fill);
  const region = {
    rect: { ...origin, width: 1, height: 1 },
    cells: [get(origin.x, origin.y)],
    getWorldTile: get,
    source: { worldSurface: 300 },
  };
  return { region, sample: createShimmerLiquidSampler(region, options) };
}
const one = (cells, fill, options, xy = { x: 100, y: 100 }) =>
  setup(cells, fill, options, xy).sample(xy.x, xy.y);
const base = (p) => p.commands.find((c) => c.shimmerPart === "base");
const glitter = (p) => p.commands.find((c) => c.shimmerPart === "glitter");
const shape = (p) => p.commands.filter((c) => c.shimmerPart === "behind-tile");
const crop = (c) => [c.sx, c.sy, c.sw, c.sh, c.dx, c.dy];
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("explicit frozen defaults and source base-color CPU quantization", () => {
  assert.deepEqual(SHIMMER_STATIC_STATE, {
    frame: 0,
    timeForVisualEffects: 0,
    colorProfile: "xna",
  });
  assert.deepEqual(shimmerBaseVertexColors(0, 0), {
    topLeft: [169, 138, 240, 255],
    topRight: [178, 155, 244, 255],
    bottomLeft: [171, 141, 240, 255],
    bottomRight: [180, 158, 244, 255],
  });
  assert.deepEqual(
    shimmerBaseVertexColors(0, 0, 0.5).topLeft,
    [84, 68, 119, 127],
  );
  assert.deepEqual(
    shimmerBaseVertexColors(0, 0, 1, 0, { colorProfile: "fna" }).topLeft,
    [169, 137, 239, 255],
  );
  // Source Lerp weight reaches below zero. Clamping that weight would make R>=165.
  assert.ok(shimmerBaseColor(100, 100)[0] < 165 / 255);
  // XNA constructor half-red rounds 127.5 to even 128; FNA truncates to 127.
  assert.deepEqual(shimmerGlitterColor(true, 0, 0), [128, 0, 0, 0]);
  assert.deepEqual(shimmerGlitterColor(true, 0, 0, 0, "fna"), [127, 0, 0, 0]);
  assert.equal(shimmerGlitterVertexColors(0, 0, 0.5).topLeft[0], 64);
  assert.ok(
    Object.values(shimmerGlitterVertexColors(100, 100)).every(
      (v) => v[3] === 0,
    ),
  );
});

test("wrapping uint noise matches independent arbitrary-precision arithmetic", () => {
  const reference = (a, b) => {
    const x = BigInt(a),
      y = BigInt(b),
      mask = (1n << 32n) - 1n;
    const xx = (36469n * (x & 65535n) + (x >> 16n)) & mask,
      yy = (18012n * (y & 65535n) + (y >> 16n)) & mask;
    return Number(((xx << 16n) + yy) & mask);
  };
  for (const [x, y] of [
    [0, 0],
    [100, 100],
    [65535, 65535],
    [0xffffffff, 0xffffffff],
    [801, 852],
  ])
    assert.equal(shimmerNoise(x, y), reference(x, y));
  assert.equal(shimmerGlitterOpacity(true, 801, 852), 0.5);
  assert.equal(shimmerGlitterOpacity(false, 0, 0), 0);
});

test("Shimmer clocks use truncation, coordinate phase and modern animation only", () => {
  assert.equal(shimmerFrame(true, 100, 100), 11);
  assert.equal(shimmerFrame(false, 100, 100), 4);
  assert.equal(shimmerFrame(true, 0, 0, 360), 0); // -0.94 truncates toward zero, not floor.
  assert.equal(shimmerFrame(true, 0, 0, 720), 15);
  const p = one({ "100,100": wet() }, stone, { frame: 2, waterfallFrame: 7 });
  assert.deepEqual(crop(base(p)), [16, 208, 16, 16, 0, 0]);
  assert.deepEqual(crop(glitter(p)), [64, 368, 16, 16, 0, 0]);
  assert.equal(
    glitter(one({ "101,100": wet() }, stone, {}, { x: 101, y: 100 })),
    undefined,
  );
  assert.equal(base(one({ "100,100": wet() }, stone, { frame: 18 })).sy, 208);
});

test("surface base and sparkle use separate atlas rows and opacity rules", () => {
  const bg = one({ "100,100": wet(127) }, stone, { worldSurface: 120 });
  assert.deepEqual(crop(base(bg)), [16, 1280, 16, 8, 0, 8]);
  assert.equal(glitter(bg).sy, 880);
  const fg = one({ "100,100": wet(127) }, stone, {
    worldSurface: 120,
    layer: "foreground",
  });
  assert.equal(base(fg).baseOpacity, 0.75);
  assert.equal(base(fg).opacity, 1); // Alpha has already entered all corner channels.
  assert.equal(base(fg).vertexColors.topLeft[3], 191);
  assert.deepEqual(glitter(fg).vertexColors, glitter(bg).vertexColors);
  assert.equal(base(fg).asset, "water_14.png");
  assert.equal(base(fg).sourceAsset, "Images/Misc/water_14.png");
});

test("quarter-cell, smoothed levels, bridge and finite Shimmer trail geometry", () => {
  assert.deepEqual(
    crop(base(one({ "100,100": wet(1) }))),
    [16, 0, 16, 4, 0, 12],
  );
  assert.deepEqual(
    crop(
      base(
        one(
          { "99,100": wet(), "100,100": wet(127), "101,100": wet() },
          (x, y) => (y > 100 ? stone : air),
        ),
      ),
    ),
    [16, 0, 16, 12, 0, 4],
  );
  const bridged = one({ "99,100": wet(), "100,100": air, "101,100": wet(1) });
  assert.equal(base(bridged).liquidLevel, 0);
  assert.deepEqual(crop(base(bridged)), [16, 0, 16, 9, 0, 7]);
  const { sample } = setup({ "100,99": wet() }, air);
  assert.ok(base(sample(100, 109)));
  assert.equal(base(sample(100, 110)), undefined);
  assert.equal(
    base(sample(100, 100)).cacheOpacity,
    Math.fround(1 - Math.fround(1 / 11)),
  );
});

test("dry halfbrick preserves normal upper half plus the Shimmer-specific behind pass", () => {
  for (const wall of [0, 1]) {
    const tile = Object.freeze({ ...stone, shape: 1, wall });
    const p = one({
      "100,100": tile,
      "100,99": wet(),
      "99,100": wet(),
      "101,100": wet(),
    });
    assert.equal(p.supported, true);
    assert.deepEqual(crop(base(p)), [16, 56, 16, 8, 0, 0]);
    assert.deepEqual(crop(shape(p)[0]), [0, 4, 16, 16, 0, 0]);
    assert.equal(shape(p)[0].vertexColors.topLeft[3], 255);
    assert.equal(shape(p)[0].vertexColors.bottomLeft[3], 255);
    assert.equal(shape(p)[0].asset, "Liquid_14.png");
    // Source SetShimmerVertexColors overwrites water wall-alpha/upper gradient.
    assert.equal(tile.liquid, 0);
    assert.equal(tile.liquidKind, 0);
  }
});

test("slope source atlas follows draw pass, retaining PointClamp vertex domain", () => {
  const cells = {
    "100,100": Object.freeze({ ...stone, shape: 2 }),
    "100,99": wet(),
    "101,100": wet(),
  };
  const bg = one(cells),
    fg = one(cells, stone, { layer: "foreground" });
  assert.equal(base(bg), undefined);
  assert.equal(shape(bg)[0].asset, "Liquid_14.png");
  assert.equal(shape(bg).length, 1);
  assert.equal(shape(fg)[0].asset, "LiquidSlope_14.png");
  assert.equal(shape(fg).length, 2);
  assert.deepEqual(crop(shape(fg)[0]), [0, 4, 16, 12, 0, 0]);
  assert.deepEqual(crop(shape(fg)[1]), [0, 15, 16, 1, 0, 12]);
  assert.equal(shape(fg)[1].dh, 4);
  assert.deepEqual(shape(fg)[1].vertexDomain, {
    x: 0,
    y: 0,
    width: 16,
    height: 16,
  });
  assert.equal(shape(fg)[0].vertexColors.topLeft[3], 191);
});

test("ambiguous runtime, malformed data and missing context are explicit", () => {
  const p = createShimmerLiquidSampler(
    { rect: { x: 1, y: 1, width: 1, height: 1 }, cells: [wet()] },
    { worldSurface: 300 },
  )(1, 1);
  assert.equal(p.reason, "shimmer-missing-context");
  assert.equal(
    one({ "100,100": wet(256) }).reason,
    "shimmer-invalid-liquid-level",
  );
  assert.equal(
    one({ "100,100": wet(255, { shape: 6 }) }).reason,
    "shimmer-invalid-shape",
  );
  assert.equal(
    one({ "100,100": wet(), "101,100": { ...stone, type: 999 } }).reason,
    "shimmer-unknown-solid-neighborhood",
  );
  assert.equal(
    one({ "100,100": wet(), "101,100": { ...stone, type: 518 } }).reason,
    "shimmer-special-tile-neighborhood",
  );
  assert.equal(
    one({ "100,100": wet() }, stone, { worldSurface: NaN }).reason,
    "shimmer-world-surface-unknown",
  );
  assert.equal(
    one({ "100,100": wet() }, stone, { renderMode: "retro" }).reason,
    "shimmer-legacy-renderer-unsupported",
  );
  const half = {
    "100,100": { ...stone, shape: 1 },
    "100,99": air,
    "99,100": wet(),
    "101,100": air,
  };
  assert.equal(one(half).reason, "shimmer-waterfall-state-required");
  assert.equal(one(half, stone, { hasWaterfall: () => true }).supported, true);
  assert.equal(shape(one(half, stone, { hasWaterfall: () => true })).length, 0);
  assert.ok(shape(one(half, stone, { hasWaterfall: () => false })).length);
  const registry={registered:true,hasOrigin(x,y){assert.equal(x,100);assert.equal(y,100);return this.registered;}};
  assert.equal(shape(one(half,stone,{waterfallRegistry:registry,hasWaterfall:()=>false})).length,0);
  registry.registered=false;
  assert.ok(shape(one(half,stone,{waterfallRegistry:registry})).length);
  registry.registered=undefined;
  assert.equal(one(half,stone,{waterfallRegistry:registry,hasWaterfall:()=>false}).reason,"shimmer-waterfall-state-required");
  assert.throws(() => one({}, stone, { frame: NaN }), /frame/);
  assert.throws(
    () => one({}, stone, { timeForVisualEffects: Infinity }),
    /bounded/,
  );
  assert.throws(() => one({}, stone, { colorProfile: "guess" }), /profile/);
  assert.throws(
    () =>
      createShimmerLiquidSampler({
        rect: { x: 0, y: 0, width: 513, height: 1 },
        cells: Array(513).fill(air),
      }),
    /region/,
  );
});

test("TileBatch triangles differ from bilinear and retain alpha-zero additive RGB", () => {
  const black = [0, 0, 0, 0],
    white = [255, 255, 255, 0],
    vertices = {
      topLeft: black,
      topRight: black,
      bottomLeft: black,
      bottomRight: white,
    };
  assert.deepEqual(
    interpolateShimmerVertexColors(vertices, 0.75, 0.25),
    [63.75, 63.75, 63.75, 0],
  );
  assert.deepEqual(
    interpolateShimmerVertexColors(vertices, 0.25, 0.75),
    [63.75, 63.75, 63.75, 0],
  );
  const raw = {
    width: 2,
    height: 2,
    data: Uint8ClampedArray.from([
      200, 100, 50, 0, 200, 100, 50, 0, 200, 100, 50, 0, 200, 100, 50, 0,
    ]),
  };
  const cmd = {
    sx: 0,
    sy: 0,
    sw: 2,
    sh: 2,
    dx: 0,
    dy: 0,
    dw: 2,
    dh: 2,
    vertexColors: vertices,
  };
  const result = rasterizeShimmerCommand(cmd, raw);
  assert.deepEqual(
    [...result.data],
    [50, 25, 13, 0, 50, 25, 13, 0, 50, 25, 13, 0, 150, 75, 38, 0],
  );
  assert.deepEqual([...raw.data.slice(0, 4)], [200, 100, 50, 0]);
  assert.throws(
    () =>
      rasterizeShimmerCommand(cmd, raw, { inputEncoding: "standard-straight" }),
    /raw/,
  );
  assert.throws(() => rasterizeShimmerCommand({ ...cmd, sx: 1 }, raw), /crop/);
  assert.throws(
    () => interpolateShimmerVertexColors(vertices, -0.1, 0),
    /sample/,
  );
});

const fixture = new URL("../fixtures/example-world.wld", import.meta.url);
const assetFolder = new URL("../example/assets/", import.meta.url);

test(
  "pinned full-world census, all saved cells and all 24 dry shape events have bounded original texture commands",
  async () => {
    const bytes = readFileSync(fixture),
      world = openWorld(bytes),
      before = sha(bytes);
    assert.equal(
      before,
      "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab",
    );
    assert.deepEqual(
      [world.width, world.height, world.version],
      [8400, 2400, 315],
    );
    const reader = new Reader(world.bytes),
      points = [],
      levels = {};
    for (let x = 0; x < world.width; x++) {
      reader.pos = world.columns[x];
      let y = 0;
      while (y < world.height) {
        const rec = decodeRecord(reader, world.important);
        if (rec.tile.liquidKind === 4 && rec.tile.liquid) {
          levels[rec.tile.liquid] =
            (levels[rec.tile.liquid] ?? 0) + rec.repeats + 1;
          for (let yy = y; yy <= y + rec.repeats; yy++)
            points.push({ x, y: yy });
        }
        y += rec.repeats + 1;
      }
    }
    assert.equal(points.length, 739);
    assert.deepEqual(levels, { 127: 61, 255: 678 });
    const rect = { x: 789, y: 840, width: 85, height: 40 },
      region = extractSceneRegion(world, rect);
    const snapshot = JSON.stringify({
      cells: region.cells,
      raw: region.raw,
      context: region.context,
    });
    for (const t of region.cells) Object.freeze(t);
    const bg = planShimmerLiquids(region),
      fg = planShimmerLiquids(region, { layer: "foreground" });
    for (const p of [bg, fg]) {
      assert.equal(p.support.savedShimmerCells, 739);
      assert.equal(p.support.savedShimmerDrawn, 739);
      assert.equal(p.support.dryShapeCandidates, 24);
      assert.equal(p.support.dryShapeDrawn, 24);
      assert.equal(p.support.unsupported, 0);
      assert.ok(p.commands.length < 1300);
      assert.deepEqual(
        new Set(
          p.commands
            .filter((c) => c.shimmerPart === "base" && c.liquidLevel)
            .map((c) => `${c.worldX},${c.worldY}`),
        ),
        new Set(points.map((p) => `${p.x},${p.y}`)),
      );
    }
    assert.equal(
      JSON.stringify({
        cells: region.cells,
        raw: region.raw,
        context: region.context,
      }),
      snapshot,
    );
    assert.equal(sha(bytes), before);
    const source = {};
    for (const [name, meta] of Object.entries(SHIMMER_ASSETS)) {
      const png = readFileSync(new URL(name, assetFolder));
      assert.equal(sha(png), meta.sha256);
      source[name] = decodePngRgba(png);
      assert.deepEqual(
        [source[name].width, source[name].height],
        [meta.width, meta.height],
      );
    }
    const partCounts = (p) =>
      p.commands.reduce(
        (o, c) => ((o[c.shimmerPart] = (o[c.shimmerPart] ?? 0) + 1), o),
        {},
      );
    const rasterStats = { commands: 0, pixels: 0, alphaZeroRgbPixels: 0 };
    for (const c of [...bg.commands, ...fg.commands]) {
      const p = rasterizeShimmerCommand(c, source[c.asset]);
      rasterStats.commands++;
      rasterStats.pixels += p.width * p.height;
      assert.ok(
        c.sx + c.sw <= source[c.asset].width &&
          c.sy + c.sh <= source[c.asset].height,
      );
      for (let i = 0; i < p.data.length; i += 4)
        if (!p.data[i + 3] && (p.data[i] || p.data[i + 1] || p.data[i + 2]))
          rasterStats.alphaZeroRgbPixels++;
    }
    assert.ok(rasterStats.alphaZeroRgbPixels > 0);
    // The same source cell has identical world-phase vertices and crops in a small ROI.
    const little = extractSceneRegion(world, {
        x: 824,
        y: 850,
        width: 16,
        height: 20,
      }),
      small = planShimmerLiquids(little);
    for (const c of small.commands) {
      const same = bg.commands.find(
        (b) =>
          b.worldX === c.worldX &&
          b.worldY === c.worldY &&
          b.shimmerPart === c.shimmerPart &&
          b.asset === c.asset,
      );
      assert.ok(same);
      assert.deepEqual(c.vertexColors, same.vertexColors);
      assert.deepEqual(
        [c.sx, c.sy, c.sw, c.sh],
        [same.sx, same.sy, same.sw, same.sh],
      );
    }
    const width = rect.width * 16,
      height = rect.height * 16;
    function composite(scene, commands) {
      for (const c of commands) {
        const sprite = rasterizeShimmerCommand(c, source[c.asset]);
        for (let y = 0; y < sprite.height; y++)
          for (let x = 0; x < sprite.width; x++) {
            const dx = c.dx + x,
              dy = c.dy + y;
            if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
            const src = (y * sprite.width + x) * 4,
              dst = (dy * width + dx) * 4,
              a = sprite.data[src + 3] / 255;
            for (let n = 0; n < 4; n++)
              scene[dst + n] = Math.min(
                255,
                Math.round(sprite.data[src + n] + scene[dst + n] * (1 - a)),
              );
          }
      }
      return scene;
    }
    const opaque = () => {
      const b = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < b.length; i += 4) {
        b[i] = 17;
        b[i + 1] = 23;
        b[i + 2] = 31;
        b[i + 3] = 255;
      }
      return b;
    };
    const component = composite(opaque(), bg.commands),
      baseOnly = composite(
        opaque(),
        bg.commands.filter((c) => c.shimmerPart !== "glitter"),
      );
    let different = 0;
    for (let i = 0; i < component.length; i += 4)
      if (
        component[i] !== baseOnly[i] ||
        component[i + 1] !== baseOnly[i + 1] ||
        component[i + 2] !== baseOnly[i + 2]
      )
        different++;
    assert.ok(different > 1000);
    assert.ok(component.every((v, i) => i % 4 !== 3 || v === 255));
    const artifacts = new URL("../artifacts/shimmer/", import.meta.url);
    mkdirSync(artifacts, { recursive: true });
    const pngFile = (name, data) => {
      const out = PNG.sync.write({ width, height, data: Buffer.from(data) });
      writeFileSync(new URL(name, artifacts), out);
      return sha(out);
    };
    const componentHash = pngFile("actual-pond-component.png", component);
    const noGlitterHash = pngFile("actual-pond-base-only.png", baseOnly);
    const terrain = planScene(region, {
        paint: { enabled: true },
        liquids: { enabled: false },
      }),
      assets = new Map();
    for (const name of terrain.requiredAssets) {
      const png = readFileSync(
          new URL(`../example/assets/${name}`, import.meta.url),
        ),
        image = await loadImage(png);
      registerTextureSource(image, {
        pngBytes: png,
        rawRgba: decodePngRgba(png),
      });
      assets.set(name, image);
    }
    const sceneFrames = prepareSceneFrames(terrain, assets, createCanvas, {
      inputEncoding: "tconvert-game-raw",
      opaqueScene: true,
    });
    assert.equal(sceneFrames.support.unsupportedCommands, 0);
    const canvas = createCanvas(width, height),
      ctx = canvas.getContext("2d"),
      walls = {
        ...terrain,
        commands: terrain.commands.filter((c) => c.kind === "wall"),
      };
    renderScene(ctx, walls, assets, { strict: true, sceneFrames });
    const target = ctx.getImageData(0, 0, width, height);
    composite(target.data, bg.commands);
    ctx.putImageData(target, 0, 0);
    renderScene(
      ctx,
      {
        ...terrain,
        commands: terrain.commands.filter((c) => c.kind !== "wall"),
      },
      assets,
      { strict: true, sceneFrames: { ...sceneFrames, opaqueScene: false } },
    );
    const sceneHash = pngFile(
      "actual-pond-scene.png",
      ctx.getImageData(0, 0, width, height).data,
    );
    sceneFrames.dispose();
    const report = {
      sourceCommit: "8255d34616c780af12079425ac92a0a7aed87d71",
      world: {
        sha256: before,
        width: world.width,
        height: world.height,
        version: world.version,
        worldSurface: world.worldSurface,
      },
      census: { savedWet: 739, levels, dryShapeEvents: 24 },
      rect,
      background: bg.support,
      foreground: fg.support,
      parts: { background: partCounts(bg), foreground: partCounts(fg) },
      assets: SHIMMER_ASSETS,
      state: bg.assumptions,
      rasterStats,
      sparkleChangedPixels: different,
      images: {
        "actual-pond-component.png": componentHash,
        "actual-pond-base-only.png": noGlitterHash,
        "actual-pond-scene.png": sceneHash,
      },
      limitations: [
        "Source-derived frozen CPU snapshot, no live game/GPU screenshot oracle.",
        "Existing terrain planner remains approximate; full scene image is integration evidence only.",
        "Recorded XNA/FNA Color behavior is an explicit selectable profile, not platform detection.",
        "Background snapshot is rendered here; source foreground commands are verified separately.",
      ],
    };
    writeFileSync(
      new URL("coverage.json", artifacts),
      JSON.stringify(report, null, 2),
    );
  },
);
