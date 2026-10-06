import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { registerTextureSource } from "../core/assets.mjs";
import {
  prepareSceneFrames,
  createSceneFrameCache,
  sceneFrameKey,
} from "../core/scene-frames.mjs";
import { renderScene } from "../core/renderer.mjs";
import { createSoftwareOverview } from "../scripts/software-overview.mjs";
import { nativeBlitterStatus } from "../scripts/native-blitter.mjs";

const nativeTest = {
  skip: nativeBlitterStatus.available ? false : nativeBlitterStatus.reason,
};
const region = { rect: { x: 3, y: 6, width: 12, height: 8 } },
  core = { x: 5, y: 7, width: 8, height: 4 },
  left = (core.x - region.rect.x) * 16,
  top = (core.y - region.rect.y) * 16;

function registerPixels(canvas, seed, mode) {
  const width = canvas.width,
    height = canvas.height,
    context = canvas.getContext("2d"),
    image = context.createImageData(width, height),
    alphas = [0, 1, 17, 63, 128, 200, 254, 255];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const alpha =
          mode === "opaque" ? 255 : alphas[(x + y + seed) % alphas.length],
        values = [
          (x * 13 + seed) % 256,
          (y * 17 + seed * 3) % 256,
          (x * 7 + y * 19 + seed) % 256,
        ];
      image.data.set(
        [
          ...values.map((value) =>
            mode === "excess" ? value : Math.min(value, alpha),
          ),
          alpha,
        ],
        (y * width + x) * 4,
      );
    }
  context.putImageData(image, 0, 0);
  registerTextureSource(canvas, {
    pngBytes: new Uint8Array(),
    rawRgba: { width, height, data: image.data },
  });
}

function makeAssets() {
  const assets = new Map();
  for (const [name, seed, mode] of [
    ["plain", 31, "plain"],
    ["excess", 73, "excess"],
    ["opaque", 17, "opaque"],
  ]) {
    const canvas = createCanvas(64, 64);
    registerPixels(canvas, seed, mode);
    assets.set(name, canvas);
  }
  return assets;
}

const command = (extra = {}) => ({
  kind: "tile",
  asset: "plain",
  type: 1,
  sx: 0,
  sy: 0,
  sw: 16,
  sh: 16,
  dx: left,
  dy: top,
  dw: 16,
  dh: 16,
  paintId: 0,
  ...extra,
});

function background() {
  const result = [];
  for (let y = 0; y < core.height; y++)
    for (let x = 0; x < core.width; x++)
      result.push(
        command({ asset: "opaque", dx: left + x * 16, dy: top + y * 16 }),
      );
  return result;
}

function plan(commands) {
  return {
    width: region.rect.width * 16,
    height: region.rect.height * 16,
    commands,
    warnings: [],
  };
}

function equalPixels(actual, expected, unsafe = null) {
  assert.equal(actual.length, expected.length);
  const examples = [];
  let differences = 0;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] === expected[i]) continue;
    differences++;
    if (examples.length < 12) {
      const pixel = Math.floor(i / 4),
        x = pixel % (core.width * 16),
        y = Math.floor(pixel / (core.width * 16));
      examples.push({
        x,
        y,
        channel: i % 4,
        actual: actual[i],
        expected: expected[i],
        unsafe: unsafe?.[Math.floor(y / 16) * core.width + Math.floor(x / 16)],
      });
    }
  }
  assert.equal(differences, 0, JSON.stringify(examples));
}

function reference(p, assets, coreSurface = false) {
  const canvas = createCanvas(
      coreSurface ? core.width * 16 : p.width,
      coreSurface ? core.height * 16 : p.height,
    ),
    frames = prepareSceneFrames(p, assets, createCanvas, {
      inputEncoding: "tconvert-game-raw",
      opaqueScene: true,
    });
  try {
    assert.equal(frames.support.unsupportedCommands, 0);
    if (coreSurface) canvas.getContext("2d").translate(-left, -top);
    renderScene(canvas.getContext("2d"), p, assets, {
      strict: true,
      sceneFrames: frames,
    });
    return Buffer.from(
      canvas
        .getContext("2d")
        .getImageData(
          coreSurface ? 0 : left,
          coreSurface ? 0 : top,
          core.width * 16,
          core.height * 16,
        ).data,
    );
  } finally {
    frames.dispose();
    canvas.width = canvas.height = 1;
  }
}

function optimized(renderer, p, assets, frameCache, batchSize = 9) {
  const keyCache = new Map(p.commands.map((c) => [c, sceneFrameKey(c)])),
    result = renderer.begin(p, core, region, assets, keyCache);
  assert.ok(
    result,
    "The native backend must run on at least one safe output cell",
  );
  const canvas = createCanvas(core.width * 16, core.height * 16),
    context = canvas.getContext("2d");
  let preparedCommands = 0,
    cachedCommands = 0,
    unresolvedLookups = 0;
  context.fillStyle = "#000000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.translate(-left, -top);
  try {
    for (let offset = 0; offset < p.commands.length; offset += batchSize) {
      const commands = p.commands.slice(offset, offset + batchSize),
        toPrepare = result.preparationCommands(commands),
        preparedKeys = new Set(toPrepare.map((c) => keyCache.get(c))),
        frames = prepareSceneFrames(
          { ...p, commands: toPrepare },
          assets,
          createCanvas,
          {
            inputEncoding: "tconvert-game-raw",
            opaqueScene: true,
            frameCache,
            keyCache,
          },
        ),
        trackedFrames = {
          ...frames,
          resolve(c) {
            if (!preparedKeys.has(keyCache.get(c))) unresolvedLookups++;
            return frames.resolve(c);
          },
        };
      preparedCommands += toPrepare.length;
      try {
        for (const c of commands) {
          const cached = result.resolveCached(c);
          if (cached) cachedCommands++;
          const resolved = cached ?? trackedFrames.resolve(c);
          assert.equal(resolved?.unsupported, undefined);
        }
        const fallback = result.drawBatch(commands, trackedFrames);
        if (fallback.length)
          renderScene(context, { ...p, commands: fallback }, assets, {
            strict: true,
            sceneFrames: { ...trackedFrames, opaqueScene: false },
          });
      } finally {
        frames.dispose();
      }
    }
    // Compare every detailed source pixel, before area reduction. This detects
    // compositing errors which could otherwise disappear in a tile's mean.
    const pixels = Buffer.from(result.pixels),
      fallback = context.getImageData(0, 0, canvas.width, canvas.height).data,
      pixelWidth = core.width * 16;
    for (let y = 0; y < core.height; y++)
      for (let x = 0; x < core.width; x++) {
        if (!result.unsafe[y * core.width + x]) continue;
        for (let row = 0; row < 16; row++) {
          const start = ((y * 16 + row) * pixelWidth + x * 16) * 4;
          pixels.set(fallback.subarray(start, start + 16 * 4), start);
        }
      }
    return {
      pixels,
      preparedCommands,
      cachedCommands,
      unresolvedLookups,
      nativeCommands: result.nativeCommands,
      canvasCommands: result.canvasCommands,
      unsafe: new Uint8Array(result.unsafe),
      unsafeCells: result.unsafe.reduce((sum, value) => sum + value, 0),
    };
  } finally {
    result.finish();
    canvas.width = canvas.height = 1;
  }
}

function opacityPlan() {
  const commands = background();
  for (const [i, opacity] of [
    0,
    0.3,
    0.499,
    0.5,
    0.8,
    1,
    0.99999,
    1 / 255,
  ].entries()) {
    // Same sceneFrameKey at several opacity values and destinations, including
    // overlaps within one batch. Cache keys must qualify every opacity level.
    commands.push(command({ opacity, dx: left + i * 5, dy: top + (i % 3) }));
    commands.push(
      command({
        asset: "excess",
        opacity,
        dx: left + i * 4,
        dy: top + 12,
        flipX: !!(i % 2),
      }),
    );
  }
  commands.push(
    command({
      asset: "excess",
      opacity: 0.5,
      dx: left - 8,
      dy: top + 31,
      flipX: true,
      flipY: true,
    }),
  );
  commands.push(
    command({
      asset: "plain",
      opacity: 0.7,
      paintId: 26,
      dx: left + 60,
      dy: top + 20,
    }),
  );
  commands.push(
    command({
      asset: "excess",
      opacity: 0.35,
      paintId: 1,
      dx: left + 68,
      dy: top + 24,
    }),
  );
  commands.push(
    command({
      asset: "plain",
      kind: "wall",
      opacity: 0.6,
      paintId: 3,
      sw: 32,
      sh: 32,
      dw: 32,
      dh: 32,
      dx: left + 105,
      dy: top + 40,
      flipY: true,
    }),
  );
  return plan(commands);
}

test(
  "software composition preserves raw/additive opacity, paint, cropped cores and warm frame bypass",
  nativeTest,
  () => {
    const assets = makeAssets(),
      p = opacityPlan(),
      renderer = createSoftwareOverview(),
      frameCache = createSceneFrameCache();
    try {
      const expected = reference(p, assets),
        cold = optimized(renderer, p, assets, frameCache),
        warm = optimized(renderer, p, assets, frameCache, 7);
      equalPixels(cold.pixels, expected);
      equalPixels(warm.pixels, expected);
      assert.equal(cold.unsafeCells, 0);
      assert.equal(cold.canvasCommands, 0);
      assert.ok(
        cold.nativeCommands > p.commands.length,
        "raw excess draws retain their additive term",
      );
      assert.ok(cold.preparedCommands > 0);
      assert.equal(warm.preparedCommands, 0);
      assert.equal(warm.cachedCommands, p.commands.length);
      assert.equal(
        warm.unresolvedLookups,
        0,
        "cache bypass must not eagerly resolve unprepared Canvas frames",
      );
    } finally {
      frameCache.dispose();
      renderer.dispose();
    }
  },
);

test(
  "mixed native/Canvas batches preserve full pixels through clipping, scaling and bounded eviction",
  nativeTest,
  () => {
    const assets = makeAssets(),
      commands = background();
    commands.push(
      command({
        asset: "excess",
        opacity: 0.4,
        sw: 32,
        sh: 32,
        dw: 32,
        dh: 32,
        dx: left + 24,
        dy: top + 4,
      }),
      command({
        asset: "plain",
        opacity: 0.3,
        dx: left + 48,
        dy: top + 16,
        clip: [
          [0, 0],
          [16, 16],
          [0, 16],
        ],
      }),
      command({
        asset: "excess",
        opacity: 0.75,
        dx: left + 56,
        dy: top + 16,
        dw: 32,
      }),
      command({
        asset: "plain",
        opacity: 0.6,
        dx: left + 80.25,
        dy: top + 16.5,
      }),
      command({ asset: "opaque", opacity: 0.8, dx: left + 48, dy: top + 16 }),
      command({
        asset: "excess",
        opacity: 0.35,
        paintId: 26,
        dx: left + 64,
        dy: top + 16,
        sw: 32,
        sh: 32,
        dw: 32,
        dh: 32,
        flipX: true,
      }),
      command({
        asset: "plain",
        opacity: 0.5,
        dx: left + 4,
        dy: top + 48,
        sh: 8,
        dh: 8,
        flipY: true,
      }),
      command({
        asset: "plain",
        opacity: 0.45,
        dx: left + 104,
        dy: top + 48,
        flipX: true,
        vertexColors: {
          topLeft: [255, 71, 93, 255],
          topRight: [41, 255, 82, 255],
          bottomRight: [71, 93, 255, 255],
          bottomLeft: [255, 255, 127, 255],
        },
      }),
    );
    const p = plan(commands),
      renderer = createSoftwareOverview({ maxFrames: 2, maxFrameBytes: 8192 }),
      frameCache = createSceneFrameCache({ maxFrames: 2, maxBytes: 8192 });
    try {
      const expected = reference(p, assets);
      for (const batchSize of [7, 3]) {
        const actual = optimized(renderer, p, assets, frameCache, batchSize);
        equalPixels(actual.pixels, expected, actual.unsafe);
        assert.ok(
          actual.unsafeCells > 0 &&
            actual.unsafeCells < core.width * core.height,
        );
        assert.ok(actual.nativeCommands > 0);
        assert.ok(actual.canvasCommands > 0);
        assert.equal(actual.unresolvedLookups, 0);
      }
      assert.ok(renderer.stats.evictions > 0);
      assert.ok(renderer.stats.peakFrameBytes <= 8192);
      assert.ok(renderer.stats.frameEntries <= 2);
    } finally {
      frameCache.dispose();
      renderer.dispose();
    }
  },
);

test(
  "nonbinary scaling retains the existing translated-core Canvas fallback semantics",
  nativeTest,
  () => {
    const assets = makeAssets(),
      p = plan([
        ...background(),
        command({
          asset: "excess",
          opacity: 0.75,
          dx: left + 56,
          dy: top + 16,
          dw: 24,
        }),
        command({
          asset: "plain",
          opacity: 0.35,
          paintId: 26,
          dx: left + 64,
          dy: top + 16,
        }),
      ]),
      renderer = createSoftwareOverview(),
      frameCache = createSceneFrameCache();
    try {
      // The existing exporter uses a translated core-sized Canvas. At a 1.5x
      // nearest-neighbor sampling tie, Skia can round differently on a larger
      // untranslated canvas. Compare against ALL original commands on exactly
      // the exporter's established surface/transform, with no native draws.
      const expected = reference(p, assets, true),
        actual = optimized(renderer, p, assets, frameCache, 5);
      equalPixels(actual.pixels, expected, actual.unsafe);
      assert.ok(actual.nativeCommands > 0);
      assert.ok(actual.canvasCommands > 0);
      assert.equal(actual.unresolvedLookups, 0);
    } finally {
      frameCache.dispose();
      renderer.dispose();
    }
  },
);

test(
  "re-registering a source invalidates both native pixel variants and prepared-frame caches",
  nativeTest,
  () => {
    const assets = makeAssets(),
      p = opacityPlan(),
      renderer = createSoftwareOverview(),
      frameCache = createSceneFrameCache();
    try {
      const first = optimized(renderer, p, assets, frameCache),
        misses = renderer.stats.misses;
      registerPixels(assets.get("plain"), 191, "plain");
      registerPixels(assets.get("excess"), 101, "excess");
      const expected = reference(p, assets),
        changed = optimized(renderer, p, assets, frameCache);
      equalPixels(changed.pixels, expected);
      assert.notDeepEqual(changed.pixels, first.pixels);
      assert.ok(renderer.stats.misses > misses);
      assert.ok(changed.preparedCommands > 0);
      assert.equal(changed.unresolvedLookups, 0);
    } finally {
      frameCache.dispose();
      renderer.dispose();
    }
  },
);

test(
  "more than 8192 opacity variants flush in order with bounded active pixels",
  nativeTest,
  () => {
    const assets = makeAssets(),
      commands = background();
    // Only 33 ordinary sceneFrameKeys, but 8448 distinct native pixel variants.
    // The former Canvas-frame batch limit alone cannot bound the native sources.
    for (let frame = 0; frame < 33; frame++)
      for (let variant = 0; variant < 256; variant++) {
        const alpha = (variant * 73) % 256;
        commands.push(
          command({
            sx: frame,
            sy: 0,
            sw: 1,
            sh: 1,
            dw: 1,
            dh: 1,
            opacity: alpha / 255,
            dx: left + (variant % 16),
            dy: top + Math.floor(variant / 16),
          }),
        );
      }
    const p = plan(commands),
      renderer = createSoftwareOverview({
        maxFrames: 2,
        maxFrameBytes: 64,
        maxLiveFrameBytes: 32768,
      }),
      frameCache = createSceneFrameCache();
    try {
      const expected = reference(p, assets);
      for (let repeat = 0; repeat < 2; repeat++) {
        const actual = optimized(
          renderer,
          p,
          assets,
          frameCache,
          commands.length,
        );
        equalPixels(actual.pixels, expected);
        assert.equal(actual.canvasCommands, 0);
        assert.equal(actual.unresolvedLookups, 0);
        assert.ok(actual.nativeCommands >= 8448);
        assert.equal(renderer.stats.activeFrameBytes, 0);
        assert.equal(renderer.stats.liveFrameBytes, renderer.stats.frameBytes);
      }
      assert.ok(renderer.stats.nativeBatches > 2);
      assert.ok(renderer.stats.maxBatchSources <= 8192);
      assert.ok(renderer.stats.maxBatchBlits <= 8192);
      assert.ok(renderer.stats.evictions > 0);
      assert.ok(
        renderer.stats.peakActiveFrameBytes > 64,
        "live batch pixels are measured outside the tiny retained LRU",
      );
      assert.ok(renderer.stats.peakLiveFrameBytes <= 32768);
      assert.ok(renderer.stats.peakFrameBytes <= 64);
    } finally {
      frameCache.dispose();
      renderer.dispose();
    }
    assert.equal(renderer.stats.activeFrameBytes, 0);
    assert.equal(renderer.stats.liveFrameBytes, 0);
  },
);

test(
  "cached future draws survive eviction and pixel-budget flushes without Canvas preparation",
  nativeTest,
  () => {
    const assets = makeAssets(),
      renderer = createSoftwareOverview({
        maxFrames: 4,
        maxFrameBytes: 4096,
        maxLiveFrameBytes: 65536,
      }),
      frameCache = createSceneFrameCache();
    const cached = command({ asset: "opaque", opacity: 0.2 });
    try {
      // Warm exactly the pixel variant used on both sides of the long new batch.
      optimized(renderer, plan([cached]), assets, frameCache, 1);
      const commands = [cached];
      for (let variant = 0; variant < 192; variant++)
        commands.push(
          command({
            asset: "opaque",
            sx: 18,
            opacity: ((variant * 73) % 256) / 255,
            dx: left + (variant % 3) * 8,
            dy: top + (variant % 2) * 8,
          }),
        );
      commands.push({ ...cached, dx: left + 12, dy: top + 4 });
      const p = plan(commands),
        expected = reference(p, assets),
        beforeBatches = renderer.stats.nativeBatches,
        actual = optimized(renderer, p, assets, frameCache, commands.length);
      equalPixels(actual.pixels, expected);
      assert.ok(actual.cachedCommands >= 2);
      assert.ok(
        actual.preparedCommands > 0,
        "variants exceeding the borrow budget retain original frame preparation",
      );
      assert.equal(
        actual.unresolvedLookups,
        0,
        "flushing must keep skipped future frames pinned",
      );
      assert.ok(renderer.stats.rawPreparedFrames > 0);
      assert.ok(renderer.stats.nativeBatches - beforeBatches > 1);
      assert.ok(renderer.stats.peakLiveFrameBytes <= 65536);
      assert.ok(renderer.stats.peakFrameBytes <= 4096);
      assert.equal(renderer.stats.activeFrameBytes, 0);
      assert.equal(renderer.stats.liveFrameBytes, renderer.stats.frameBytes);
    } finally {
      frameCache.dispose();
      renderer.dispose();
    }
  },
);

const slopeClips = [
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
];

function slopeVariants() {
  const opacities = [
    0,
    1 / 255,
    0.5,
    0.6,
    0.95,
    1,
    127.5 / 255 - 1e-7,
    127.5 / 255 + 1e-7,
  ];
  const variants = [];
  for (let i = 0; i < 4 * 4 * opacities.length; i++) {
    variants.push(
      command({
        asset: "excess",
        clip: slopeClips[i % 4],
        flipX: !!(i & 4),
        flipY: !!(i & 8),
        opacity: opacities[Math.floor(i / 16)],
        dx: left - 8 + ((i * 17) % (core.width * 16)),
        dy: top - 7 + ((i * 11) % (core.height * 16)),
      }),
    );
  }
  // The ordinary rectangular draw must also remain separate from every clip,
  // although all these commands intentionally share one sceneFrameKey.
  variants.push(
    command({
      asset: "excess",
      opacity: 0.6,
      flipX: true,
      dx: left + 41,
      dy: top + 19,
    }),
  );
  assert.equal(new Set(variants.map(sceneFrameKey)).size, 1);
  return variants;
}

test(
  "software slope cache isolates shape, flips and opacity with exact cold and warm native pixels",
  nativeTest,
  () => {
    const assets = makeAssets(),
      variants = slopeVariants(),
      p = plan([
        ...background(),
        ...variants,
        ...variants.toReversed().map((c) => ({
          ...c,
          dx: c.dx + 3,
          dy: c.dy - 2,
        })),
      ]),
      renderer = createSoftwareOverview(),
      frameCache = createSceneFrameCache();
    try {
      const expected = reference(p, assets),
        cold = optimized(renderer, p, assets, frameCache, 13),
        misses = renderer.stats.misses,
        warm = optimized(renderer, p, assets, frameCache, 5);
      equalPixels(cold.pixels, expected);
      equalPixels(warm.pixels, expected);
      for (const actual of [cold, warm]) {
        assert.equal(actual.unsafeCells, 0);
        assert.equal(actual.canvasCommands, 0);
        assert.equal(
          actual.nativeCommands,
          core.width * core.height + 4 * variants.length,
          "every slope must use native base and additive blits",
        );
        assert.equal(actual.unresolvedLookups, 0);
      }
      assert.ok(
        cold.preparedCommands > 0,
        "cold slopes prepare their clipped Canvas planes",
      );
      assert.equal(warm.preparedCommands, 0);
      assert.equal(warm.cachedCommands, p.commands.length);
      assert.equal(
        renderer.stats.misses,
        misses,
        "a warm pass must reuse every qualified clip variant",
      );
    } finally {
      frameCache.dispose();
      renderer.dispose();
    }
  },
);

test(
  "software slope variants survive bounded eviction and reuse across small preparation batches",
  nativeTest,
  () => {
    const assets = makeAssets(),
      variants = slopeVariants(),
      commands = [...background(), command({ asset: "opaque" })];
    // Repeat groups of three variants at new destinations. A three-frame cache
    // repeatedly serves warm clips and then evicts them for the following group.
    for (let i = 0; i < variants.length; i += 3) {
      const group = variants.slice(i, i + 3);
      commands.push(
        ...group,
        ...group.map((c) => ({
          ...c,
          dx: c.dx + 5,
          dy: c.dy + 1,
        })),
      );
    }
    const p = plan(commands),
      renderer = createSoftwareOverview({
        maxFrames: 3,
        maxFrameBytes: 6144,
        maxLiveFrameBytes: 65536,
      }),
      frameCache = createSceneFrameCache({ maxFrames: 2, maxBytes: 8192 });
    try {
      const expected = reference(p, assets);
      for (const batchSize of [1, 3, 7, 41]) {
        const actual = optimized(renderer, p, assets, frameCache, batchSize);
        equalPixels(actual.pixels, expected);
        assert.equal(actual.unsafeCells, 0);
        assert.equal(actual.canvasCommands, 0);
        assert.equal(
          actual.nativeCommands,
          core.width * core.height + 1 + 4 * variants.length,
        );
        assert.equal(actual.unresolvedLookups, 0);
        assert.ok(actual.preparedCommands > 0);
        if (batchSize <= 3)
          assert.ok(
            actual.cachedCommands > core.width * core.height,
            "small batches must exercise warm slope hits as well as eviction",
          );
        assert.equal(renderer.stats.activeFrameBytes, 0);
        assert.equal(renderer.stats.liveFrameBytes, renderer.stats.frameBytes);
      }
      assert.ok(renderer.stats.evictions > variants.length);
      assert.ok(renderer.stats.frameEntries <= 3);
      assert.ok(renderer.stats.peakFrameBytes <= 6144);
      assert.ok(renderer.stats.peakLiveFrameBytes <= 65536);
    } finally {
      frameCache.dispose();
      renderer.dispose();
    }
  },
);
