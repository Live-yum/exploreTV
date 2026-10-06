import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { registerTextureSource, textureSource } from "../core/assets.mjs";
import { renderSceneBatched } from "../core/scene-batches.mjs";
import { materializeOverviewCommand } from "../core/overview-command-buffer.mjs";
import { createDirectTerrainOverview } from "../scripts/direct-terrain-overview.mjs";
import { nativeBlitterStatus } from "../scripts/native-blitter.mjs";
import { boxDownsampleRgba } from "../scripts/downsample-rgba.mjs";

const nativeTest = {
  skip: nativeBlitterStatus.available ? false : nativeBlitterStatus.reason,
};

function registerPixels(source, seed = 1, mode = "excess") {
  const width = source.width,
    height = source.height,
    context = source.getContext("2d"),
    image = context.createImageData(width, height),
    alphas = [0, 1, 17, 63, 128, 200, 254, 255];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const alpha = mode === "opaque" ? 255 : alphas[(x + y * 3 + seed) % 8],
        at = (y * width + x) * 4,
        red = (x * 13 + y * 3 + seed * 11) % 256,
        green = (x * 7 + y * 17 + seed * 3) % 256,
        blue = (x * 19 + y * 11 + seed) % 256;
      image.data[at] = mode === "plain" ? Math.min(red, alpha) : red;
      image.data[at + 1] = mode === "plain" ? Math.min(green, alpha) : green;
      image.data[at + 2] = mode === "plain" ? Math.min(blue, alpha) : blue;
      image.data[at + 3] = alpha;
    }
  context.putImageData(image, 0, 0);
  registerTextureSource(source, {
    pngBytes: new Uint8Array(),
    rawRgba: { width, height, data: image.data },
  });
  return source;
}

function assets() {
  return new Map([
    ["opaque", registerPixels(createCanvas(64, 64), 11, "opaque")],
    ["plain", registerPixels(createCanvas(64, 64), 37, "plain")],
    ["excess", registerPixels(createCanvas(64, 64), 73, "excess")],
  ]);
}

function scene(width = 8, height = 4) {
  const region = {
      rect: { x: 13, y: 17, width: width + 4, height: height + 4 },
    },
    core = { x: 15, y: 19, width, height };
  const make = (extra = {}) => ({
    kind: "tile",
    type: 1,
    asset: "plain",
    paintId: 0,
    sx: 0,
    sy: 0,
    sw: 16,
    sh: 16,
    dx: 32,
    dy: 32,
    dw: 16,
    dh: 16,
    ...extra,
  });
  const plan = (commands) => ({
    width: region.rect.width * 16,
    height: region.rect.height * 16,
    commands,
    warnings: [],
    requiredAssets: [...new Set(commands.map((c) => c.asset))].sort(),
  });
  return { core, region, make, plan };
}

function reference(plan, imageAssets, core, region) {
  const canvas = createCanvas(core.width * 16, core.height * 16),
    context = canvas.getContext("2d");
  context.translate(
    -(core.x - region.rect.x) * 16,
    -(core.y - region.rect.y) * 16,
  );
  try {
    const report = renderSceneBatched(
      context,
      plan.compactTerrain
        ? {
            ...plan,
            commands: plan.commands.map((command) =>
              materializeOverviewCommand(plan, command),
            ),
          }
        : plan,
      imageAssets,
      createCanvas,
      {
        inputEncoding: "tconvert-game-raw",
        opaqueScene: true,
        strict: true,
      },
    );
    assert.equal(report.skippedEffects, 0);
    const detailed = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    ).data;
    return boxDownsampleRgba(detailed, canvas.width, canvas.height, 16);
  } finally {
    canvas.width = canvas.height = 1;
  }
}

function composePartition(renderer, plan, imageAssets, core, region) {
  const direct = renderer.render(plan, core, region, imageAssets);
  assert.ok(direct, "Scene must exercise a nonempty direct partition");
  assert.equal(direct.handled.length, plan.commands.length);
  const remaining = plan.commands.filter((_, i) => !direct.handled[i]),
    result = reference(
      { ...plan, commands: remaining },
      imageAssets,
      core,
      region,
    );
  for (let i = 0; i < direct.safe.length; i++)
    if (direct.safe[i])
      result.set(direct.pixels.subarray(i * 4, i * 4 + 4), i * 4);
  return { direct, result };
}

function equalPixels(actual, expected) {
  let count = 0;
  const examples = [];
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++)
    if (actual[i] !== expected[i]) {
      count++;
      if (examples.length < 12)
        examples.push({
          pixel: i >> 2,
          channel: i % 4,
          actual: actual[i],
          expected: expected[i],
        });
    }
  assert.equal(count, 0, JSON.stringify(examples));
}

test(
  "ordinary walls, alpha/excess tiles, flips and identity paint compose exactly",
  nativeTest,
  () => {
    const s = scene(),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview();
    const commands = [];
    for (let y = -1; y < s.core.height + 1; y++)
      for (let x = -1; x < s.core.width + 1; x++) {
        commands.push(
          s.make({
            kind: "wall",
            type: 1,
            asset: x % 2 ? "plain" : "excess",
            sw: 32,
            sh: 32,
            dw: 32,
            dh: 32,
            dx: 32 + x * 16 - 8,
            dy: 32 + y * 16 - 8,
            sx: (x & 1) * 16,
            sy: (y & 1) * 16,
            flipX: !!(x & 1),
            flipY: !!(y & 1),
          }),
        );
      }
    for (let y = 0; y < s.core.height; y++)
      for (let x = 0; x < s.core.width; x++)
        commands.push(
          s.make({
            dx: 32 + x * 16,
            dy: 32 + y * 16,
            asset: ["opaque", "plain", "excess"][(x + y) % 3],
            sx: (x % 4) * 16,
            sy: (y % 4) * 16,
            paintId: x % 2 ? 31 : 0,
            flipX: !!(x & 1),
            flipY: !!(y & 1),
          }),
        );
    try {
      const p = s.plan(commands),
        expected = reference(p, imageAssets, s.core, s.region),
        first = composePartition(renderer, p, imageAssets, s.core, s.region);
      equalPixels(first.result, expected);
      assert.equal(first.direct.handledCount, commands.length);
      assert.equal(first.direct.safeCells, s.core.width * s.core.height);
      const prepared = renderer.stats.rawPreparedFrames,
        second = composePartition(renderer, p, imageAssets, s.core, s.region);
      equalPixels(second.result, expected);
      assert.equal(renderer.stats.rawPreparedFrames, prepared);
      assert.ok(renderer.stats.hits > commands.length);
      assert.equal(renderer.stats.activeFrameBytes, 0);
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "3000 ordered mixed commands match the full Canvas renderer at every output pixel",
  nativeTest,
  () => {
    const s = scene(48, 24),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview(),
      commands = [];
    let seed = 0x46ab91f3;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let i = 0; i < 3000; i++) {
      const mode = random() % 20,
        complex = mode >= 14,
        x = complex ? 32 + (random() % 17) : (random() % 52) - 2,
        y = (random() % 28) - 2,
        c = s.make({
          asset: ["plain", "excess", "opaque"][random() % 3],
          sx: (random() % 4) * 16,
          sy: (random() % 4) * 16,
          dx: 32 + x * 16,
          dy: 32 + y * 16,
          paintId: random() % 4 === 0 ? 31 : 0,
          flipX: !!(random() & 1),
          flipY: !!(random() & 1),
        });
      if (mode < 6)
        Object.assign(c, {
          kind: "wall",
          type: 2,
          sw: 32,
          sh: 32,
          dw: 32,
          dh: 32,
          sx: (random() % 3) * 16,
          sy: (random() % 3) * 16,
          dx: c.dx - 8,
          dy: c.dy - 8,
        });
      else if (mode === 14) c.opacity = [0, 0.3, 0.5, 0.999][random() % 4];
      else if (mode === 15)
        c.clip = [
          [0, 0],
          [16, 16],
          [0, 16],
        ];
      else if (mode === 16)
        Object.assign(c, {
          kind: "object",
          type: 4,
          dw: 29,
          dh: 23,
          dx: c.dx - 9,
        });
      else if (mode === 17)
        Object.assign(c, { dx: c.dx - 0.25, dy: c.dy + 0.5 });
      else if (mode === 18) c.vertexColor = [90, 213, 177, 201];
      else if (mode === 19) c.paintId = 7;
      commands.push(c);
    }
    try {
      const p = s.plan(commands),
        expected = reference(p, imageAssets, s.core, s.region),
        { direct, result } = composePartition(
          renderer,
          p,
          imageAssets,
          s.core,
          s.region,
        );
      equalPixels(result, expected);
      assert.equal(commands.length, 3000);
      assert.ok(direct.handledCount > 1000);
      assert.ok(direct.handledCount < 3000);
      assert.ok(
        direct.safeCells > 600 && direct.safeCells < direct.safe.length,
      );
      assert.equal(
        direct.handledCount,
        direct.handled.reduce((sum, value) => sum + value, 0),
      );
      assert.ok(renderer.stats.nativeCommands > direct.handledCount - 500);
      assert.ok(renderer.stats.peakLiveFrameBytes <= 4 * 1024 * 1024);
      assert.ok(renderer.stats.peakBufferBytes <= 6 * 1024 * 1024);
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "a wall crossing unsafe cells remains generic and also contributes to direct safe pixels",
  nativeTest,
  () => {
    const s = scene(5, 3),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview();
    const p = s.plan([
      s.make({
        kind: "wall",
        sw: 32,
        sh: 32,
        dw: 32,
        dh: 32,
        dx: 40,
        dy: 32,
        asset: "excess",
      }),
      s.make({
        kind: "object",
        type: 4,
        dx: 64,
        dy: 32,
        dw: 18,
        asset: "opaque",
      }),
      s.make({ dx: 32, dy: 64, asset: "plain" }),
    ]);
    try {
      const { direct, result } = composePartition(
        renderer,
        p,
        imageAssets,
        s.core,
        s.region,
      );
      assert.equal(direct.handled[0], 0);
      assert.equal(direct.handled[1], 0);
      assert.equal(direct.handled[2], 1);
      assert.equal(direct.safe[0], 1);
      assert.equal(direct.safe[1], 1);
      assert.equal(direct.safe[2], 0);
      equalPixels(result, reference(p, imageAssets, s.core, s.region));
      assert.ok(direct.pixels[0] + direct.pixels[1] + direct.pixels[2] > 0);
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "unsupported, missing, invalid-crop and tinted commands keep their generic diagnostic path",
  nativeTest,
  () => {
    const s = scene(8, 2),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview();
    const p = s.plan([
      s.make({ dx: 32, asset: "opaque" }),
      s.make({ dx: 48, asset: "missing" }),
      s.make({ dx: 64, sx: 64 }),
      s.make({ dx: 80, paintId: 32 }),
      s.make({ dx: 96, type: 5, paintId: 1 }),
      s.make({ dx: 112, vertexColor: [255, 255, 255, 255] }),
      s.make({ dx: 128, opacity: NaN }),
      s.make({ dx: 144, asset: "opaque" }),
    ]);
    try {
      const result = renderer.render(p, s.core, s.region, imageAssets);
      assert.ok(result);
      assert.deepEqual([...result.handled], [1, 0, 0, 0, 0, 0, 0, 1]);
      assert.deepEqual(
        [...result.safe.subarray(0, 8)],
        [1, 0, 0, 0, 0, 0, 0, 1],
      );
      assert.equal(result.handledCount, 2);
      assert.equal(renderer.stats.preparationFailures, 2);
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "fractional and clipped destinations get one-pixel protection; unknown geometry declines the view",
  nativeTest,
  () => {
    const s = scene(8, 4),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview();
    try {
      const clipped = renderer.render(
        s.plan([s.make(), s.make({ dx: 80, dy: 48, clip: [] })]),
        s.core,
        s.region,
        imageAssets,
      );
      assert.ok(clipped);
      assert.equal(clipped.safeCells, 32 - 9);
      const fractional = renderer.render(
        s.plan([s.make(), s.make({ dx: 80.5, dy: 48.5 })]),
        s.core,
        s.region,
        imageAssets,
      );
      assert.ok(fractional);
      assert.equal(fractional.safeCells, 32 - 9);
      for (const geometry of [
        { dx: NaN },
        { dh: 0 },
        { dw: -16 },
        { dy: Infinity },
      ]) {
        assert.equal(
          renderer.render(
            s.plan([s.make(), s.make(geometry)]),
            s.core,
            s.region,
            imageAssets,
          ),
          null,
        );
        assert.equal(renderer.stats.activeFrameBytes, 0);
      }
      const p = s.plan([s.make()]);
      equalPixels(
        composePartition(renderer, p, imageAssets, s.core, s.region).result,
        reference(p, imageAssets, s.core, s.region),
      );
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "source replacement and re-registration invalidate numeric frame identities",
  nativeTest,
  () => {
    const s = scene(2, 1),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview(),
      p = s.plan([s.make({ asset: "opaque" })]);
    try {
      const first = renderer.render(p, s.core, s.region, imageAssets);
      registerPixels(imageAssets.get("opaque"), 101, "opaque");
      const second = renderer.render(p, s.core, s.region, imageAssets);
      assert.notDeepEqual(second.pixels, first.pixels);
      equalPixels(second.pixels, reference(p, imageAssets, s.core, s.region));
      assert.equal(renderer.stats.sourceInvalidations, 1);
      imageAssets.set(
        "opaque",
        registerPixels(createCanvas(64, 64), 153, "opaque"),
      );
      const third = renderer.render(p, s.core, s.region, imageAssets);
      equalPixels(third.pixels, reference(p, imageAssets, s.core, s.region));
      assert.equal(renderer.stats.rawPreparedFrames, 3);
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "final opaque tiles eliminate covered walls and the entire detailed raster",
  nativeTest,
  () => {
    const s = scene(4, 2),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview(),
      commands = [];
    for (let y = 0; y < s.core.height; y++)
      for (let x = 0; x < s.core.width; x++)
        commands.push(
          s.make({
            kind: "wall",
            asset: "excess",
            sw: 32,
            sh: 32,
            dw: 32,
            dh: 32,
            dx: 24 + x * 16,
            dy: 24 + y * 16,
          }),
        );
    for (let y = 0; y < s.core.height; y++)
      for (let x = 0; x < s.core.width; x++)
        commands.push(
          s.make({
            asset: "opaque",
            dx: 32 + x * 16,
            dy: 32 + y * 16,
            sx: x * 16,
            sy: y * 16,
            flipX: !!(x & 1),
            flipY: !!(y & 1),
            paintId: 31,
          }),
        );
    try {
      const p = s.plan(commands),
        { direct, result } = composePartition(
          renderer,
          p,
          imageAssets,
          s.core,
          s.region,
        );
      equalPixels(result, reference(p, imageAssets, s.core, s.region));
      assert.equal(direct.handledCount, 16);
      assert.equal(direct.opaqueCells, 8);
      assert.equal(direct.nativeRequiredCells, 0);
      assert.equal(renderer.stats.nativeCommands, 0);
      assert.equal(renderer.stats.nativeBatches, 0);
      assert.equal(renderer.stats.bufferBytes, 0);
      assert.equal(renderer.stats.allNativeSkippedRenders, 1);
      assert.equal(renderer.stats.skippedWallCommands, 8);
      assert.equal(renderer.stats.skippedTileCommands, 8);
      assert.equal(
        renderer.stats.candidateBlitPixels,
        renderer.stats.skippedBlitPixels,
      );
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "later walls and partial tiles invalidate means; later opaque tiles restore exact final means",
  nativeTest,
  () => {
    const s = scene(5, 3),
      imageAssets = assets(),
      background = [];
    for (let y = 0; y < s.core.height; y++)
      for (let x = 0; x < s.core.width; x++)
        background.push(
          s.make({ asset: "opaque", dx: 32 + x * 16, dy: 32 + y * 16 }),
        );
    const wall = s.make({
        kind: "wall",
        asset: "plain",
        sw: 32,
        sh: 32,
        dw: 32,
        dh: 32,
        dx: 48,
        dy: 32,
      }),
      finalTile = s.make({
        asset: "opaque",
        sx: 16,
        dx: 48,
        dy: 32,
        flipX: true,
      }),
      partialTile = s.make({ asset: "opaque", dx: 40, dy: 40, flipY: true });
    for (const tail of [
      [wall],
      [wall, finalTile],
      [wall, finalTile, partialTile],
    ]) {
      const renderer = createDirectTerrainOverview(),
        p = s.plan([...background, ...tail]);
      try {
        const { direct, result } = composePartition(
          renderer,
          p,
          imageAssets,
          s.core,
          s.region,
        );
        equalPixels(result, reference(p, imageAssets, s.core, s.region));
        assert.ok(direct.opaqueCells > 0 && direct.opaqueCells < 15);
        assert.ok(renderer.stats.nativeCommands > 0);
        if (tail.length === 1) assert.equal(direct.opaqueCells, 11);
        if (tail.length === 2) {
          assert.equal(direct.opaqueCells, 12);
          assert.equal(direct.nativeRequiredCells, 3);
          assert.equal(renderer.stats.keptCrossOpaqueWallCommands, 1);
          assert.equal(renderer.stats.nativeCommands, 4);
        }
      } finally {
        renderer.dispose();
      }
    }
    // A complex layer cancels direct ownership only for its affected cell. All
    // other final opaque means remain usable without allocating a native core.
    const renderer = createDirectTerrainOverview(),
      p = s.plan([
        ...background,
        s.make({
          kind: "object",
          type: 4,
          asset: "excess",
          vertexColor: [255, 255, 255, 255],
        }),
      ]);
    try {
      const { direct, result } = composePartition(
        renderer,
        p,
        imageAssets,
        s.core,
        s.region,
      );
      equalPixels(result, reference(p, imageAssets, s.core, s.region));
      assert.equal(direct.opaqueCells, 14);
      assert.equal(direct.safeCells, 14);
      assert.equal(direct.nativeRequiredCells, 0);
      assert.equal(direct.handled[0], 0);
      assert.equal(renderer.stats.allNativeSkippedRenders, 1);
      assert.equal(renderer.stats.bufferBytes, 0);
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "a second-pass source failure discards the whole direct view after bounded eviction",
  nativeTest,
  () => {
    const s = scene(4, 1),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview({
        maxFrameBytes: 8192,
        maxFrames: 1,
      }),
      source = imageAssets.get("plain"),
      raw = textureSource(source).rawRgba;
    let reads = 0;
    registerTextureSource(source, {
      pngBytes: new Uint8Array(),
      rawRgbaProvider: () => (++reads === 1 ? raw : null),
    });
    const p = s.plan([s.make(), s.make({ asset: "excess", dx: 48 })]);
    try {
      assert.equal(renderer.render(p, s.core, s.region, imageAssets), null);
      assert.equal(renderer.stats.secondPassMisses, 1);
      assert.equal(renderer.stats.secondPassFailures, 1);
      assert.equal(renderer.stats.activeFrameBytes, 0);
      assert.ok(renderer.stats.peakLiveFrameBytes <= 8192);
      registerTextureSource(source, {
        pngBytes: new Uint8Array(),
        rawRgba: raw,
      });
      const { result } = composePartition(
        renderer,
        p,
        imageAssets,
        s.core,
        s.region,
      );
      equalPixels(result, reference(p, imageAssets, s.core, s.region));
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "cache and active batch share the byte/count limits across many evictions and ordered flushes",
  nativeTest,
  () => {
    const s = scene(12, 4),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview({
        maxFrameBytes: 8192,
        maxFrames: 2,
      }),
      commands = [];
    for (let i = 0; i < 400; i++) {
      const wall = i % 3 === 0;
      commands.push(
        s.make({
          kind: wall ? "wall" : "tile",
          asset: "excess",
          sw: wall ? 32 : 16,
          sh: wall ? 32 : 16,
          dw: wall ? 32 : 16,
          dh: wall ? 32 : 16,
          sx: (i % 3) * 16,
          sy: (Math.floor(i / 3) % 3) * 16,
          dx: 32 + (i % 12) * 16 - (wall ? 8 : 0),
          dy: 32 + (Math.floor(i / 12) % 4) * 16 - (wall ? 8 : 0),
          flipX: !!(i & 1),
          flipY: !!(i & 2),
        }),
      );
    }
    try {
      const p = s.plan(commands),
        { result } = composePartition(
          renderer,
          p,
          imageAssets,
          s.core,
          s.region,
        );
      equalPixels(result, reference(p, imageAssets, s.core, s.region));
      assert.ok(renderer.stats.evictions > 100);
      assert.ok(renderer.stats.nativeBatches > 100);
      assert.ok(renderer.stats.secondPassMisses > 100);
      assert.ok(renderer.stats.peakLiveFrameBytes <= 8192);
      assert.ok(renderer.stats.peakActiveFrameBytes <= 8192);
      assert.ok(renderer.stats.peakFrameEntries <= 2);
      assert.equal(renderer.stats.activeFrameBytes, 0);
    } finally {
      renderer.dispose();
    }
    assert.equal(renderer.stats.liveFrameBytes, 0);
    assert.equal(renderer.stats.bufferBytes, 0);
  },
);

test(
  "raw rectangles from 1 to 64 pixels preserve half bricks, liquid opacity and ordered sprite layers",
  nativeTest,
  () => {
    const s = scene(16, 8),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview(),
      commands = [],
      sizes = [
        [1, 1],
        [16, 8],
        [16, 14],
        [16, 16],
        [16, 32],
        [32, 16],
        [32, 32],
        [64, 1],
        [1, 64],
        [48, 23],
        [64, 64],
      ],
      opacities = [0, 0.01, 0.3, 0.499, 0.5, 0.6, 0.95, 0.999, 1];
    for (let y = 0; y < s.core.height; y++)
      for (let x = 0; x < s.core.width; x++)
        commands.push(
          s.make({ asset: "opaque", dx: 32 + x * 16, dy: 32 + y * 16 }),
        );
    for (let i = 0; i < 400; i++) {
      const [sw, sh] = sizes[i % sizes.length];
      commands.push(
        s.make({
          kind: ["liquid", "waterfall", "object"][i % 3],
          type: 42,
          sw,
          sh,
          dw: sw,
          dh: sh,
          sx: i % (65 - sw),
          sy: (i * 7) % (65 - sh),
          dx: 25 + ((i * 37) % 263),
          dy: 21 + ((i * 19) % 145),
          asset: ["plain", "excess", "opaque"][i % 3],
          opacity: opacities[i % opacities.length],
          paintId: i % 2 ? 31 : 0,
          flipX: !!(i & 1),
          flipY: !!(i & 2),
        }),
      );
    }
    try {
      const p = s.plan(commands),
        { direct, result } = composePartition(
          renderer,
          p,
          imageAssets,
          s.core,
          s.region,
        );
      equalPixels(result, reference(p, imageAssets, s.core, s.region));
      assert.equal(direct.handledCount, commands.length);
      assert.equal(direct.safeCells, 128);
      assert.equal(renderer.stats.extendedCandidates, 400);
      assert.ok(renderer.stats.peakLiveFrameBytes <= 4 * 1024 * 1024);
      assert.equal(renderer.stats.activeFrameBytes, 0);
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "extended crop keys do not alias 12-bit terrain crops and small budgets reject larger raw frames",
  nativeTest,
  () => {
    const s = scene(2, 1),
      wide = createCanvas(4160, 16),
      context = wide.getContext("2d"),
      image = context.createImageData(wide.width, wide.height);
    for (let y = 0; y < wide.height; y++)
      for (let x = 0; x < wide.width; x++)
        image.data.set(
          [x < 4096 ? 20 : 220, 31, 53, 255],
          (y * wide.width + x) * 4,
        );
    context.putImageData(image, 0, 0);
    registerTextureSource(wide, {
      pngBytes: new Uint8Array(),
      rawRgba: { width: wide.width, height: wide.height, data: image.data },
    });
    const imageAssets = new Map([["wide", wide]]),
      renderer = createDirectTerrainOverview(),
      p = s.plan([
        s.make({ asset: "wide" }),
        s.make({ asset: "wide", sx: 4096, dx: 48 }),
      ]);
    try {
      const { direct, result } = composePartition(
        renderer,
        p,
        imageAssets,
        s.core,
        s.region,
      );
      equalPixels(result, reference(p, imageAssets, s.core, s.region));
      assert.equal(direct.pixels[0], 20);
      assert.equal(direct.pixels[4], 220);
      assert.equal(renderer.stats.rawPreparedFrames, 2);
    } finally {
      renderer.dispose();
      wide.width = wide.height = 1;
    }
    const t = scene(5, 4),
      small = createDirectTerrainOverview({ maxFrameBytes: 8192 }),
      smallAssets = assets(),
      q = t.plan([
        t.make({
          kind: "object",
          asset: "excess",
          sw: 64,
          sh: 64,
          dw: 64,
          dh: 64,
        }),
        t.make({ asset: "opaque", dx: 96 }),
      ]);
    try {
      const { direct, result } = composePartition(
        small,
        q,
        smallAssets,
        t.core,
        t.region,
      );
      equalPixels(result, reference(q, smallAssets, t.core, t.region));
      assert.deepEqual([...direct.handled], [0, 1]);
      assert.equal(small.stats.budgetFallbacks, 1);
      assert.ok(small.stats.peakLiveFrameBytes <= 8192);
    } finally {
      small.dispose();
    }
  },
);

test(
  "canonical slope cache qualifies shape, flips, opacity, paint and vertex tint while retaining native order",
  nativeTest,
  () => {
    const s = scene(8, 8),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview(),
      commands = [],
      shapes = [
        [
          [0, 0],
          [16, 16],
          [0, 16],
        ],
        [
          [0, 16],
          [16, 0],
          [16, 16],
        ],
        [
          [0, 0],
          [16, 0],
          [0, 16],
        ],
        [
          [0, 0],
          [16, 0],
          [16, 16],
        ],
      ],
      opacities = [0, 0.3, 0.5, 0.95, 1],
      paints = [0, 1, 7, 12, 13, 29, 30, 31];
    for (let y = 0; y < s.core.height; y++)
      for (let x = 0; x < s.core.width; x++)
        commands.push(
          s.make({ asset: "opaque", dx: 32 + x * 16, dy: 32 + y * 16 }),
        );
    for (let shape = 0; shape < 4; shape++)
      for (let flip = 0; flip < 4; flip++)
        for (let alpha = 0; alpha < opacities.length; alpha++) {
          const i = (shape * 4 + flip) * opacities.length + alpha;
          commands.push(
            s.make({
              kind: i % 3 ? "tile" : "wall",
              type: i % 2,
              asset: i % 2 ? "plain" : "excess",
              clip: shapes[shape],
              flipX: !!(flip & 1),
              flipY: !!(flip & 2),
              opacity: opacities[alpha],
              paintId: paints[i % paints.length],
              vertexColor:
                i % 3 === 0
                  ? [101, 220, 73, 191]
                  : i % 3 === 1
                    ? [255, 64, 0, 0]
                    : undefined,
              dx: 32 + (i % 8) * 16,
              dy: 32 + (Math.floor(i / 8) % 8) * 16,
            }),
          );
        }
    try {
      const p = s.plan(commands),
        expected = reference(p, imageAssets, s.core, s.region),
        { direct, result } = composePartition(
          renderer,
          p,
          imageAssets,
          s.core,
          s.region,
        );
      equalPixels(result, expected);
      assert.equal(direct.handledCount, commands.length);
      assert.equal(direct.safeCells, 64);
      assert.equal(renderer.stats.slopeCandidates, 80);
      assert.ok(renderer.stats.slopePreparedFrames > 20);
      assert.ok(renderer.stats.peakLiveFrameBytes <= 4 * 1024 * 1024);
      const prepared = renderer.stats.slopePreparedFrames;
      equalPixels(
        composePartition(renderer, p, imageAssets, s.core, s.region).result,
        expected,
      );
      assert.equal(renderer.stats.slopePreparedFrames, prepared);
      assert.equal(renderer.stats.activeFrameBytes, 0);
      assert.equal(renderer.stats.secondPassFailures, 0);
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "empty core output is opaque black and unsupported modes or budgets decline safely",
  nativeTest,
  () => {
    const s = scene(2, 2),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview();
    try {
      const result = renderer.render(s.plan([]), s.core, s.region, imageAssets);
      assert.ok(result);
      assert.deepEqual(
        [...result.pixels],
        [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255],
      );
      assert.equal(result.handledCount, 0);
      assert.equal(result.safeCells, 4);
    } finally {
      renderer.dispose();
    }
    assert.throws(
      () => renderer.render(s.plan([]), s.core, s.region, imageAssets),
      /disposed/,
    );
    const straight = createDirectTerrainOverview({
        inputEncoding: "standard-straight",
      }),
      tooSmall = createDirectTerrainOverview({ maxDetailedBytes: 1024 });
    try {
      assert.equal(
        straight.render(s.plan([]), s.core, s.region, imageAssets),
        null,
      );
      assert.equal(
        tooSmall.render(s.plan([]), s.core, s.region, imageAssets),
        null,
      );
    } finally {
      straight.dispose();
      tooSmall.dispose();
    }
    assert.throws(
      () => createDirectTerrainOverview({ maxFrames: 8193 }),
      /budget/,
    );
    assert.throws(
      () => createDirectTerrainOverview({ maxFrameBytes: 8191 }),
      /budget/,
    );
  },
);

test(
  "failed extended keys are not retained in the uncharged numeric negative cache",
  nativeTest,
  () => {
    for (const width of [8, 16]) {
      const s = scene(4, 2),
        imageAssets = assets(),
        renderer = createDirectTerrainOverview(),
        source = createCanvas(64, 64);
      let reads = 0;
      registerTextureSource(source, {
        pngBytes: new Uint8Array(),
        rawRgbaProvider() {
          reads++;
          return null;
        },
      });
      imageAssets.set("failed", source);
      const commands = [s.make({ asset: "opaque" })];
      for (let i = 0; i < 80; i++)
        commands.push(
          s.make({ asset: "failed", dx: 48, sw: width, dw: width }),
        );
      try {
        const direct = renderer.render(
          s.plan(commands),
          s.core,
          s.region,
          imageAssets,
        );
        assert.ok(direct);
        assert.equal(direct.handledCount, 1);
        assert.equal(direct.safe[1], 0);
        // The extended width-8 key is deliberately not remembered after failure;
        // the ordinary numeric width-16 key remains safely deduplicated.
        assert.equal(reads, width === 8 ? 80 : 1);
        assert.equal(renderer.stats.activeFrameBytes, 0);
      } finally {
        renderer.dispose();
        source.width = source.height = 1;
      }
    }
  },
);

test(
  "CLOCK retains a repeatedly used hot frame amid a stream of cold frame crops",
  nativeTest,
  () => {
    const s = scene(4, 1),
      hot = registerPixels(createCanvas(64, 64), 101, "opaque"),
      cold = registerPixels(createCanvas(64, 64), 153, "opaque"),
      imageAssets = new Map([
        ["hot", hot],
        ["cold", cold],
      ]),
      plans = [],
      expected = [];
    for (let i = 0; i < 48; i++) {
      const p = s.plan([
        s.make({ asset: "hot" }),
        s.make({
          asset: "cold",
          dx: 48,
          sx: (i % 4) * 16,
          sy: (Math.floor(i / 4) % 4) * 16,
        }),
      ]);
      plans.push(p);
      expected.push(reference(p, imageAssets, s.core, s.region));
    }
    const hotRaw = textureSource(hot).rawRgba,
      coldRaw = textureSource(cold).rawRgba;
    let hotReads = 0,
      coldReads = 0;
    registerTextureSource(hot, {
      pngBytes: new Uint8Array(),
      rawRgbaProvider() {
        hotReads++;
        return hotRaw;
      },
    });
    registerTextureSource(cold, {
      pngBytes: new Uint8Array(),
      rawRgbaProvider() {
        coldReads++;
        return coldRaw;
      },
    });
    const renderer = createDirectTerrainOverview({
      maxFrameBytes: 8192,
      maxFrames: 3,
    });
    try {
      for (let i = 0; i < plans.length; i++) {
        const direct = renderer.render(plans[i], s.core, s.region, imageAssets);
        assert.ok(direct);
        assert.equal(direct.handledCount, 2);
        equalPixels(direct.pixels, expected[i]);
      }
      // This checks actual preparation/provider work, not a simulated cache.
      // The first full second-chance sweep may evict the initial hot entry once;
      // subsequent cold arrivals must leave the repeatedly referenced frame live.
      assert.ok(
        hotReads <= 2,
        `Hot frame unexpectedly prepared ${hotReads} times`,
      );
      assert.equal(coldReads, 48);
      assert.ok(renderer.stats.clockPromotions > 0);
      assert.ok(renderer.stats.evictions > 40);
      assert.ok(renderer.stats.clockScans <= 2 * 3 * renderer.stats.misses);
      assert.ok(renderer.stats.peakLiveFrameBytes <= 8192);
      assert.ok(renderer.stats.peakFrameEntries <= 3);
      assert.equal(renderer.stats.activeFrameBytes, 0);
    } finally {
      renderer.dispose();
      hot.width = hot.height = cold.width = cold.height = 1;
    }
  },
);

// Test-only conversion lets the unchanged Canvas path remain the independent
// pixel reference. Production planning constructs these records directly.
function compactPlan(
  plan,
  select = (c) => c.kind === "tile" || c.kind === "wall",
) {
  const frames = [],
    frameSlots = new Map(),
    records = [],
    commands = plan.commands.map((c) => {
      if (!select(c)) return c;
      const { dx, dy, x = 0, y = 0, ...template } = c,
        key = JSON.stringify(template);
      let slot = frameSlots.get(key);
      if (slot === undefined) {
        slot = frames.length;
        frames.push(Object.freeze(template));
        frameSlots.set(key, slot);
      }
      records.push(slot, dx, dy, x, y);
      return -(records.length / 5);
    });
  return {
    ...plan,
    commands,
    compactTerrain: {
      stride: 5,
      records: Int32Array.from(records),
      frames: Object.freeze(frames),
    },
  };
}

test(
  "compact terrain validates unique frames once and uses generation slots in the second pass",
  nativeTest,
  () => {
    const s = scene(16, 8),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview(),
      commands = [];
    for (let i = 0; i < 2048; i++)
      commands.push(
        s.make({
          asset: "excess",
          sx: (i % 4) * 16,
          dx: 32 + (i % 16) * 16,
          dy: 32 + (Math.floor(i / 16) % 8) * 16,
          flipX: !!(i & 1),
          flipY: !!(i & 2),
        }),
      );
    const full = s.plan(commands),
      compact = compactPlan(full),
      frameCount = compact.compactTerrain.frames.length;
    try {
      const { direct, result } = composePartition(
        renderer,
        compact,
        imageAssets,
        s.core,
        s.region,
      );
      equalPixels(result, reference(full, imageAssets, s.core, s.region));
      assert.equal(direct.handledCount, commands.length);
      assert.equal(renderer.stats.compactCommands, commands.length);
      assert.equal(renderer.stats.compactFramesValidated, frameCount);
      assert.equal(
        renderer.stats.compactValidationReuses,
        commands.length - frameCount,
      );
      assert.equal(renderer.stats.frameKeyLookups, frameCount);
      assert.equal(renderer.stats.compactSecondPassSlotHits, commands.length);
      assert.equal(renderer.stats.compactSecondPassReloads, 0);
      assert.equal(renderer.stats.peakCompactSlotBytes, frameCount * 13);
      assert.equal(renderer.stats.compactSlotBytes, 0);
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "compact slot generations survive repeated byte-budget eviction without retaining old frames",
  nativeTest,
  () => {
    const s = scene(12, 4),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview({
        maxFrameBytes: 8192,
        maxFrames: 1,
      }),
      commands = [];
    for (let i = 0; i < 300; i++)
      commands.push(
        s.make({
          asset: i & 1 ? "plain" : "excess",
          sx: (i % 3) * 16,
          dx: 32 + (i % 12) * 16,
          dy: 32 + (Math.floor(i / 12) % 4) * 16,
          flipX: !!(i & 1),
          flipY: !!(i & 2),
        }),
      );
    const full = s.plan(commands),
      compact = compactPlan(full);
    try {
      const { result } = composePartition(
        renderer,
        compact,
        imageAssets,
        s.core,
        s.region,
      );
      equalPixels(result, reference(full, imageAssets, s.core, s.region));
      assert.equal(
        renderer.stats.compactFramesValidated,
        compact.compactTerrain.frames.length,
      );
      assert.ok(renderer.stats.compactSecondPassReloads > 200);
      assert.ok(renderer.stats.evictions > 200);
      assert.ok(renderer.stats.nativeBatches > 200);
      assert.ok(renderer.stats.peakLiveFrameBytes <= 8192);
      assert.ok(renderer.stats.peakActiveFrameBytes <= 8192);
      assert.equal(renderer.stats.peakFrameEntries, 1);
      assert.equal(renderer.stats.activeFrameBytes, 0);
    } finally {
      renderer.dispose();
    }
    assert.equal(renderer.stats.liveFrameBytes, 0);
  },
);

test(
  "compact templates preserve mixed wall, sprite, slope, half-brick and liquid order",
  nativeTest,
  () => {
    const s = scene(8, 4),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview(),
      commands = [];
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 8; x++) {
        const dx = 32 + x * 16,
          dy = 32 + y * 16;
        commands.push(
          s.make({
            kind: "wall",
            asset: "excess",
            sw: 32,
            sh: 32,
            dw: 32,
            dh: 32,
            dx: dx - 8,
            dy: dy - 8,
          }),
        );
        commands.push(
          s.make({ kind: "object", asset: "plain", dx, dy, opacity: 0.3 }),
        );
        commands.push(
          s.make({
            asset: "opaque",
            dx,
            dy,
            clip: [
              [0, 0],
              [16, 16],
              [0, 16],
            ],
            flipX: !!(x & 1),
          }),
        );
        commands.push(s.make({ asset: "plain", dx, dy: dy + 8, sh: 8, dh: 8 }));
        commands.push(
          s.make({ kind: "liquid", asset: "excess", dx, dy, opacity: 0.4 }),
        );
      }
    const full = s.plan(commands),
      compact = compactPlan(full);
    try {
      const { result } = composePartition(
        renderer,
        compact,
        imageAssets,
        s.core,
        s.region,
      );
      equalPixels(result, reference(full, imageAssets, s.core, s.region));
      assert.ok(renderer.stats.slopeCandidates > 0);
      assert.ok(renderer.stats.compactValidationReuses > 0);
      assert.ok(renderer.stats.compactSecondPassSlotHits > 0);
      assert.equal(renderer.stats.secondPassFailures, 0);
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "compact invalid crops and missing sources retain bounded validation and generic diagnostics",
  nativeTest,
  () => {
    const s = scene(8, 2),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview(),
      control = createDirectTerrainOverview(),
      commands = [];
    for (let i = 0; i < 20; i++)
      commands.push(
        s.make({ asset: "missing", dx: 48 }),
        s.make({ sx: 64, dx: 64 }),
        s.make({ asset: "opaque", dx: 32 }),
      );
    const full = s.plan(commands),
      compact = compactPlan(full);
    try {
      const actual = renderer.render(compact, s.core, s.region, imageAssets),
        expected = control.render(full, s.core, s.region, imageAssets);
      assert.ok(actual);
      assert.deepEqual(actual.handled, expected.handled);
      assert.deepEqual(actual.safe, expected.safe);
      equalPixels(actual.pixels, expected.pixels);
      assert.equal(renderer.stats.compactFramesValidated, 3);
      assert.equal(renderer.stats.preparationFailures, 2);
      assert.equal(renderer.stats.compactValidationReuses, 57);
    } finally {
      renderer.dispose();
      control.dispose();
    }
  },
);

test(
  "a compact slot re-preparation failure declines the complete view after generation invalidation",
  nativeTest,
  () => {
    const s = scene(4, 1),
      imageAssets = assets(),
      source = imageAssets.get("plain"),
      raw = textureSource(source).rawRgba,
      renderer = createDirectTerrainOverview({
        maxFrameBytes: 8192,
        maxFrames: 1,
      });
    let reads = 0;
    registerTextureSource(source, {
      pngBytes: new Uint8Array(),
      rawRgbaProvider: () => (++reads === 1 ? raw : null),
    });
    const compact = compactPlan(
      s.plan([s.make(), s.make({ asset: "excess", dx: 48 })]),
    );
    try {
      assert.equal(
        renderer.render(compact, s.core, s.region, imageAssets),
        null,
      );
      assert.equal(renderer.stats.compactSecondPassReloads, 1);
      assert.equal(renderer.stats.secondPassFailures, 1);
      assert.equal(renderer.stats.activeFrameBytes, 0);
      assert.ok(renderer.stats.peakLiveFrameBytes <= 8192);
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "native resolved-cell clipping removes exact 3x3 wall fragments with unchanged output",
  nativeTest,
  () => {
    const s = scene(3, 3),
      imageAssets = assets(),
      masked = createDirectTerrainOverview({ resolvedCellMask: true }),
      unmasked = createDirectTerrainOverview({ resolvedCellMask: false }),
      full = s.plan([
        s.make({
          kind: "wall",
          asset: "plain",
          sw: 32,
          sh: 32,
          dw: 32,
          dh: 32,
          dx: 40,
          dy: 40,
        }),
        s.make({ asset: "opaque", dx: 32, dy: 32 }),
        s.make({ asset: "opaque", dx: 48, dy: 48 }),
        s.make({ asset: "opaque", dx: 64, dy: 64 }),
      ]),
      compact = compactPlan(full);
    try {
      const actual = composePartition(
          masked,
          compact,
          imageAssets,
          s.core,
          s.region,
        ),
        control = composePartition(
          unmasked,
          compact,
          imageAssets,
          s.core,
          s.region,
        );
      equalPixels(
        actual.result,
        reference(full, imageAssets, s.core, s.region),
      );
      equalPixels(actual.result, control.result);
      assert.equal(masked.stats.keptCrossOpaqueWallCommands, 1);
      // The -8px wall touches three cells on each axis: corner 8x8, center
      // 16x16, opposite corner 8x8, counted over its one nonadditive plane.
      assert.equal(masked.stats.blitPixelsToResolvedCells, 64 + 256 + 64);
      assert.equal(masked.stats.maskedBlitPixelsSkipped, 384);
      assert.equal(masked.stats.maskedUnsafeBlitPixelsSkipped, 0);
      assert.equal(
        unmasked.stats.nativeBlitPixels - masked.stats.nativeBlitPixels,
        384,
      );
      assert.equal(
        masked.stats.candidateBlitPixels,
        masked.stats.nativeBlitPixels + masked.stats.skippedBlitPixels,
      );
    } finally {
      masked.dispose();
      unmasked.dispose();
    }
  },
);

test(
  "malformed compact records decline safely before interpreting numeric commands",
  nativeTest,
  () => {
    const s = scene(),
      imageAssets = assets(),
      renderer = createDirectTerrainOverview(),
      original = compactPlan(s.plan([s.make()]));
    try {
      for (const p of [
        { ...original, commands: [-2] },
        { ...original, commands: [0] },
        {
          ...original,
          compactTerrain: { ...original.compactTerrain, stride: 4 },
        },
        {
          ...original,
          compactTerrain: {
            ...original.compactTerrain,
            records: Int32Array.of(3, 32, 32, 0, 0),
          },
        },
        {
          ...original,
          compactTerrain: {
            ...original.compactTerrain,
            records: new Int32Array(new SharedArrayBuffer(20)),
          },
        },
      ])
        assert.equal(renderer.render(p, s.core, s.region, imageAssets), null);
      assert.equal(renderer.stats.activeFrameBytes, 0);
    } finally {
      renderer.dispose();
    }
  },
);
