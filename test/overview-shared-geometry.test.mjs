import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { registerTextureSource } from "../core/assets.mjs";
import { prepareSceneFrames, sceneFrameKey } from "../core/scene-frames.mjs";
import { renderScene } from "../core/renderer.mjs";
import { boxDownsampleRgba } from "../scripts/downsample-rgba.mjs";
import { createOverviewGeometryAnalysis } from "../scripts/overview-geometry.mjs";
import {
  prepareOpaqueOverview,
  applyOpaqueOverview,
} from "../scripts/overview-fast-path.mjs";
import {
  partitionSoftwareOverview,
  createSoftwareOverview,
} from "../scripts/software-overview.mjs";
import { nativeBlitterStatus } from "../scripts/native-blitter.mjs";

const command = (extra = {}) => ({
  kind: "tile",
  asset: "opaque",
  type: 1,
  paintId: 0,
  sx: 0,
  sy: 0,
  sw: 16,
  sh: 16,
  dx: 16,
  dy: 16,
  dw: 16,
  dh: 16,
  ...extra,
});
const region = { rect: { x: 9, y: 17, width: 8, height: 6 } },
  core = { x: 10, y: 18, width: 5, height: 3 };
const planFor = (commands) => ({
  width: 128,
  height: 96,
  commands,
  warnings: [],
});

function comparePartition(
  plan,
  target = core,
  source = region,
  provider = null,
) {
  const analysis = createOverviewGeometryAnalysis(
      plan,
      target,
      source,
      provider,
    ),
    ordinary = partitionSoftwareOverview(plan, target, source),
    shared = partitionSoftwareOverview(plan, target, source, analysis);
  assert.equal(shared.unsafe, analysis.unsafe);
  assert.equal(shared.unsafeCells, ordinary.unsafeCells);
  assert.deepEqual(shared.unsafe, ordinary.unsafe);
  for (let i = 0; i < plan.commands.length; i++) {
    const c = plan.commands[i],
      expected = ordinary.classify(c);
    assert.equal(shared.classifyAt(i), expected, `index ${i}`);
    assert.equal(shared.classify(c), expected, `object ${i}`);
    assert.equal(shared.classifyAt(i), expected, `cached ${i}`);
    assert.equal(shared.touchesUnsafe(c), ordinary.touchesUnsafe(c));
    assert.equal(shared.shouldDrawNative(c), ordinary.shouldDrawNative(c));
  }
  // These are absent from the plan; they must neither alias an indexed command
  // nor inherit its classification even after the indexed cache has filled.
  for (const c of [
    command(),
    command({ dx: -1e100 }),
    command({ dx: NaN }),
    command({ dx: 34, sw: 8 }),
  ])
    assert.equal(shared.classify(c), ordinary.classify(c));
  assert.throws(() => shared.classifyAt(-1), RangeError);
  assert.throws(() => shared.classifyAt(plan.commands.length), RangeError);
  return analysis;
}

test("shared indexed coverage equals the ordinary classifier across mixed shifted cores", () => {
  let seed = 0x947893;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  for (let scene = 0; scene < 100; scene++) {
    const commands = [];
    for (let i = 0; i < 80; i++) {
      const dw = 1 + random(64),
        dh = 1 + random(64),
        c = command({
          dx: random(220) - 40,
          dy: random(160) - 40,
          dw,
          dh,
          sw: dw,
          sh: dh,
          opacity: random(256) / 255,
        });
      switch (random(8)) {
        case 0:
          c.dx += 0.25;
          break;
        case 1:
          c.dh += 0.75;
          break;
        case 2:
          c.clip = [
            [0, 0],
            [16, 16],
            [0, 16],
          ];
          break;
        case 3:
          c.dw++;
          break;
        case 4:
          c.opacity = -1;
          break;
      }
      commands.push(c);
    }
    const x = random(4),
      y = random(3),
      target = {
        x: region.rect.x + x,
        y: region.rect.y + y,
        width: 1 + random(8 - x),
        height: 1 + random(6 - y),
      };
    comparePartition(planFor(commands), target);
  }
});

test("invalid, extreme, empty, and fractional-rounding geometry preserves conservative coverage", () => {
  for (const extra of [
    { dx: NaN },
    { dy: Infinity },
    { dw: -1 },
    { dh: 0 },
    { dh: -Infinity },
  ]) {
    const plan = planFor([command(extra), command()]),
      analysis = comparePartition(plan);
    assert.equal(analysis.validGeometry, false);
    assert.equal(analysis.unsafeCells, core.width * core.height);
    const opaque = prepareOpaqueOverview(plan, new Map(), createCanvas, {
      analysis,
    });
    assert.equal(opaque.eligibleTiles, 0);
    assert.equal(opaque.skip.size, 0);
  }
  const extreme = planFor(
    [1e100, -1e100, Number.MAX_VALUE, -Number.MAX_VALUE].flatMap((value) => [
      command({ dx: value }),
      command({ dy: value, clip: [] }),
    ]),
  );
  const analysis = comparePartition(extreme);
  assert.equal(analysis.unsafeCells, 0);
  assert.ok(analysis.last.every((value) => value === -1));
  const opaque = prepareOpaqueOverview(extreme, new Map(), createCanvas, {
    analysis,
  });
  assert.equal(
    opaque.skip.size,
    extreme.commands.length,
    "off-scene rectangles stay empty before Int32 conversion",
  );
  const nearBoundary = planFor([command({ dx: 15, dw: 16.000000000000004 })]);
  const fractional = comparePartition(nearBoundary);
  assert.equal(fractional.bounds[2], 2);
  const rectangle = new Int32Array(4);
  fractional.coreBoundsAt(0, rectangle);
  assert.equal(
    rectangle[2],
    2,
    "core subtraction occurs before the padding addition",
  );
});

test("index providers handle duplicate/frozen commands, foreign objects and mismatched views", () => {
  const first = Object.freeze(command()),
    second = Object.freeze(command({ dx: 32, sw: 8 })),
    plan = planFor([first, second, first]),
    indices = new Map(plan.commands.map((c, i) => [c, i]));
  let lookups = 0;
  const provider = {
      indexOf(c) {
        lookups++;
        return indices.get(c);
      },
    },
    analysis = comparePartition(plan, core, region, provider);
  assert.ok(lookups > 0);
  assert.equal(analysis.indexOf(first), 2);
  assert.equal(analysis.indexOf({ ...first }), -1);
  const other = planFor([command({ dx: Infinity })]);
  assert.deepEqual(
    partitionSoftwareOverview(other, core, region, analysis).unsafe,
    partitionSoftwareOverview(other, core, region).unsafe,
  );
  const shifted = { ...core, x: core.x + 1 };
  assert.deepEqual(
    partitionSoftwareOverview(plan, shifted, region, analysis).unsafe,
    partitionSoftwareOverview(plan, shifted, region).unsafe,
  );
  assert.deepEqual(
    prepareOpaqueOverview(other, new Map(), createCanvas, { analysis }).safe,
    prepareOpaqueOverview(other, new Map(), createCanvas).safe,
  );
});

function makeAssets() {
  const assets = new Map();
  for (const [name, alpha, excess] of [
    ["opaque", 255, false],
    ["alpha", 127, false],
    ["excess", 80, true],
  ]) {
    const canvas = createCanvas(32, 32),
      context = canvas.getContext("2d"),
      pixels = context.createImageData(32, 32);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const rgb = [
          (x * 13 + y * 7) % 256,
          (y * 17 + 39) % 256,
          (x * 5 + 88) % 256,
        ];
        pixels.data.set(
          [...rgb.map((v) => (excess ? v : Math.min(v, alpha))), alpha],
          (y * 32 + x) * 4,
        );
      }
    context.putImageData(pixels, 0, 0);
    assets.set(
      name,
      registerTextureSource(canvas, {
        pngBytes: new Uint8Array(),
        rawRgba: { width: 32, height: 32, data: pixels.data },
      }),
    );
  }
  return assets;
}

test("shared opaque means preserve exact full composition with alpha, additive, flips, slopes and halo", () => {
  const assets = makeAssets(),
    commands = [];
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 8; x++)
      commands.push(command({ dx: x * 16, dy: y * 16 }));
  commands.push(
    command({ asset: "alpha", dx: 12, dy: 19, dw: 32, sw: 32 }),
    command({ asset: "excess", dx: 32, dy: 16, flipX: true, opacity: 0.3 }),
    command({
      dx: 48,
      dy: 32,
      clip: [
        [0, 0],
        [16, 16],
        [0, 16],
      ],
    }),
    command({ dx: 80.25, dy: 32.5, opacity: 0.5 }),
    command({ dx: 48, dy: 16, flipY: true }),
    command({ dx: 80, dy: 16 }),
  );
  const plan = planFor(commands),
    analysis = createOverviewGeometryAnalysis(plan, core, region),
    ordinary = prepareOpaqueOverview(plan, assets, createCanvas),
    shared = prepareOpaqueOverview(plan, assets, createCanvas, { analysis });
  for (const key of [
    "safe",
    "rgba",
    "eligibleTiles",
    "candidateTiles",
    "uniqueCandidateFrames",
    "skippedCommands",
  ])
    assert.deepEqual(shared[key], ordinary[key], key);
  assert.deepEqual(shared.skip, ordinary.skip);
  const frames = prepareSceneFrames(plan, assets, createCanvas, {
    inputEncoding: "tconvert-game-raw",
    opaqueScene: true,
  });
  const draw = (list) => {
    const canvas = createCanvas(plan.width, plan.height),
      ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    renderScene(ctx, { ...plan, commands: list }, assets, {
      strict: true,
      sceneFrames: frames,
    });
    const data = ctx.getImageData(
      16,
      16,
      core.width * 16,
      core.height * 16,
    ).data;
    const reduced = boxDownsampleRgba(
      data,
      core.width * 16,
      core.height * 16,
      16,
    );
    canvas.width = canvas.height = 1;
    return reduced;
  };
  try {
    const expected = draw(commands),
      actual = draw(commands.filter((c) => !shared.skip.has(c)));
    applyOpaqueOverview(actual, core, region, shared);
    assert.deepEqual(actual, expected);
  } finally {
    frames.dispose();
  }
});

test(
  "shared native view keeps lifecycle, reordered batches and cached raw frames intact",
  {
    skip: nativeBlitterStatus.available ? false : nativeBlitterStatus.reason,
  },
  () => {
    const assets = makeAssets(),
      commands = [command(), command({ dx: 32, asset: "alpha", opacity: 0.3 })],
      plan = planFor(commands),
      keys = new Map(commands.map((c) => [c, sceneFrameKey(c)])),
      analysis = createOverviewGeometryAnalysis(plan, core, region),
      renderer = createSoftwareOverview();
    try {
      const baseline = renderer.begin(plan, core, region, assets, keys);
      baseline.preparationCommands(commands);
      baseline.drawBatch(commands, {
        resolve() {
          throw new Error("raw frame must already be cached");
        },
      });
      const expected = Buffer.from(baseline.pixels);
      baseline.finish();
      const view = renderer.begin(plan, core, region, assets, keys, analysis);
      assert.deepEqual(view.preparationCommands([...commands].reverse()), []);
      assert.ok(view.resolveCached(commands[0]));
      view.drawBatch(commands, {
        resolve() {
          throw new Error("cached frame must resolve");
        },
      });
      assert.deepEqual(view.pixels, expected);
      view.finish();
      assert.throws(() => view.resolveCached(commands[0]), /finished/);
      assert.equal(renderer.stats.activeFrameBytes, 0);
      const next = renderer.begin(plan, core, region, assets, keys, analysis);
      next.preparationCommands(commands);
      view.finish();
      assert.ok(next.resolveCached(commands[0]));
      renderer.dispose();
      assert.throws(() => next.drawBatch([], {}), /finished/);
      assert.equal(renderer.stats.liveFrameBytes, 0);
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "finishing a shared native view releases its indexed geometry and command owners",
  {
    skip: nativeBlitterStatus.available ? false : nativeBlitterStatus.reason,
  },
  () => {
    const geometryUrl = new URL(
        "../scripts/overview-geometry.mjs",
        import.meta.url,
      ).href,
      softwareUrl = new URL("../scripts/software-overview.mjs", import.meta.url)
        .href;
    const child = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--input-type=module",
        "-e",
        `
    import assert from "node:assert/strict";
    import { createOverviewGeometryAnalysis } from ${JSON.stringify(geometryUrl)};
    import { createSoftwareOverview } from ${JSON.stringify(softwareUrl)};
    const closed = createSoftwareOverview(), open = createSoftwareOverview();
    const core = { x: 0, y: 0, width: 1, height: 1 }, region = { rect: core };
    function track(renderer, finish) {
      const assets = new Map(), keys = new Map(),
        plan = { width: 16, height: 16, commands: [] },
        analysis = createOverviewGeometryAnalysis(plan, core, region);
      const view = renderer.begin(plan, core, region, assets, keys, analysis);
      if (finish) view.finish();
      return [assets, keys, analysis, plan.commands].map((value) => new WeakRef(value));
    }
    const released = track(closed, true), retained = track(open, false);
    for (let i = 0; i < 4; i++) { await new Promise(setImmediate); global.gc(); }
    assert.ok(released.every((ref) => ref.deref() === undefined), "finished shared view is collectible");
    assert.ok(retained.every((ref) => ref.deref() !== undefined), "unfinished control stays alive");
    open.dispose(); closed.dispose();
  `,
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
  },
);
