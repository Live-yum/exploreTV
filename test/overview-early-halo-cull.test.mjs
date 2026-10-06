import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { createCanvas } from "@napi-rs/canvas";
import { createWorldRenderer } from "../scripts/world-render-engine.mjs";
import { nativeBlitterStatus } from "../scripts/native-blitter.mjs";

const logicalCounters = [
  "plannedCommands",
  "renderedCommands",
  "commandCounts",
  "missingCommands",
  "invalidCommands",
  "effectFailures",
  "unsupportedTiles",
  "liquidUnsupported",
  "sourceHiddenTiles",
  "assetFailures",
  "assetHashes",
];

function assetsFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "exploretv-early-halo-")),
    assetDir = join(dir, "assets");
  mkdirSync(assetDir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, width, height, seed, excess] of [
    ["Tiles_1.png", 288, 270, 17, true],
    ["Wall_1.png", 468, 180, 31, false],
    ["Tiles_5.png", 726, 264, 47, false],
    ["Tiles_109.png", 288, 270, 61, false],
    ["Tree_Tops_20.png", 1476, 140, 79, false],
    ["Tiles_4.png", 88, 100, 97, false],
  ]) {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const alpha = [31, 63, 127, 191][(x + y + seed) % 4],
          rgb = [
            (x * 3 + seed) & 255,
            (y * 5 + seed) & 255,
            (x + y * 7 + seed * 3) & 255,
          ];
        png.data.set(
          [
            ...rgb.map((value) => (excess ? value : Math.min(value, alpha))),
            alpha,
          ],
          (y * width + x) * 4,
        );
      }
    writeFileSync(join(assetDir, name), PNG.sync.write(png));
  }
  return assetDir;
}

function makeRegion() {
  const width = 30,
    height = 28;
  return {
    rect: { x: 100, y: 200, width, height },
    version: 315,
    source: { width: 8400, height: 2400, worldSurface: 649 },
    treeContext: {
      hallowBG: 3,
      treeX: [1923, 3451, 6191],
      treeTopVariations: [3, 0, 5, 4, 0, 2, 32, 3, 0, 0, 0, 0, 0],
    },
    cells: Array.from({ length: width * height }, () => ({
      active: false,
      wall: 1,
      liquid: 0,
    })),
  };
}

function put(region, x, y, extra) {
  const i = x * region.rect.height + y;
  region.cells[i] = { ...region.cells[i], ...extra };
}

function addTallTree(region, { paint = 0 } = {}) {
  put(region, 14, 17, {
    active: true,
    type: 5,
    frameX: 22,
    frameY: 220,
    shape: 0,
    paint,
  });
  for (let y = 18; y < 23; y++)
    put(region, 14, y, {
      active: true,
      type: 5,
      frameX: 0,
      frameY: 0,
      shape: 0,
    });
  put(region, 14, 23, { active: true, type: 109, shape: 0 });
}

async function draw(
  assetDir,
  region,
  core,
  { lowMemory = false, native = false } = {},
) {
  const omissions = [],
    renderer = createWorldRenderer({
      assetDir,
      lowMemory,
      nativeOverview: native,
      onOmission: (...entry) => omissions.push(entry),
    }),
    canvas = createCanvas(1, 1);
  try {
    const drawn = await renderer.drawRegion(region, canvas, {
        core,
        count: true,
        overview: lowMemory,
        coreSurface: lowMemory,
      }),
      width = core.width * 16,
      height = core.height * 16;
    // All fixture textures are translucent. No mean replacement can conceal a
    // detailed-pixel mismatch; compare the complete source-resolution core.
    assert.equal(drawn.opaqueOverview?.eligibleTiles ?? 0, 0);
    let pixels;
    if (drawn.softwareOverview) {
      const software = drawn.softwareOverview;
      pixels = Buffer.from(software.pixels);
      if (software.canvasCommands) {
        const fallback = canvas
          .getContext("2d")
          .getImageData(drawn.readbackX, drawn.readbackY, width, height).data;
        for (let y = 0; y < core.height; y++)
          for (let x = 0; x < core.width; x++) {
            if (!software.unsafe[y * core.width + x]) continue;
            for (let row = 0; row < 16; row++) {
              const start = ((y * 16 + row) * width + x * 16) * 4;
              pixels.set(fallback.subarray(start, start + 64), start);
            }
          }
      }
    } else
      pixels = Buffer.from(
        canvas
          .getContext("2d")
          .getImageData(drawn.readbackX, drawn.readbackY, width, height).data,
      );
    return {
      pixels,
      plan: drawn.plan,
      coreCommands: drawn.coreCommands,
      stats: structuredClone(renderer.stats),
      omissions: omissions.sort(
        (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2],
      ),
    };
  } finally {
    renderer.dispose();
    canvas.width = canvas.height = 1;
  }
}

function assertEquivalent(actual, baseline, region, core) {
  assert.deepEqual(actual.pixels, baseline.pixels);
  const { commands: referenceCommands, ...referenceDiagnostics } =
      baseline.plan,
    { commands, generationCulling, ...diagnostics } = actual.plan;
  assert.deepEqual(
    diagnostics,
    referenceDiagnostics,
    "full read-region assets, support and diagnostics remain unchanged",
  );
  const left = (core.x - region.rect.x) * 16,
    top = (core.y - region.rect.y) * 16;
  // Independent pixel envelope for this fixture's ordinary tile and wall
  // owners. All special sprites keep their exact previous planning path.
  const expectedCommands = referenceCommands.filter((c) => {
    if (
      c.kind !== "wall" &&
      !(c.kind === "tile" && c.fidelity === "approximate")
    )
      return true;
    const wall = c.kind === "wall",
      size = wall ? 32 : 16,
      dx = c.x * 16 - (wall ? 8 : 0),
      dy = c.y * 16 - (wall ? 8 : 0);
    return !(
      dx + size + 1 <= left ||
      dy + size + 1 <= top ||
      dx - 1 >= left + core.width * 16 ||
      dy - 1 >= top + core.height * 16
    );
  });
  assert.deepEqual(
    commands,
    expectedCommands,
    "only proven ordinary halo commands are absent; retained ordering is exact",
  );
  assert.deepEqual(generationCulling, {
    culledCommands: referenceCommands.length - expectedCommands.length,
    logicalCommands: referenceCommands.length,
  });
  assert.ok(generationCulling.culledCommands > 0);
  assert.equal(
    actual.stats.generationCulledHaloCommands,
    generationCulling.culledCommands,
  );
  assert.ok(
    actual.stats.earlyCulledHaloCommands >= generationCulling.culledCommands,
  );
  assert.equal(actual.coreCommands, baseline.coreCommands);
  assert.deepEqual(actual.omissions, baseline.omissions);
  for (const counter of logicalCounters)
    assert.deepEqual(actual.stats[counter], baseline.stats[counter], counter);
  assert.ok(actual.stats.earlyCulledHaloCommands > 0);
  assert.equal(actual.stats.maxPlanCommands, baseline.plan.commands.length);
  assert.equal(
    actual.stats.frameKeyInterner.calls,
    baseline.plan.commands.length - actual.stats.earlyCulledHaloCommands,
    "culled halo commands never reach frame-key generation",
  );
  assert.equal(
    actual.stats.opaqueOverview.totalCommands,
    actual.stats.frameKeyInterner.calls,
    "opaque analysis uses the selected working commands",
  );
}

test("early halo culling retains exterior 8-pixel wall spans, tall crowns and exact translucent core pixels", async (t) => {
  const assetDir = assetsFixture(t),
    region = makeRegion(),
    core = { x: 112, y: 209, width: 6, height: 5 };
  addTallTree(region);
  for (let x = 12; x < 18; x++)
    for (let y = 9; y < 14; y++)
      if ((x + y) % 3 === 0)
        put(region, x, y, {
          active: true,
          type: 1,
          shape: (x + y) % 6,
          paint: x === 15 ? 26 : 0,
        });
  const before = structuredClone(region),
    baseline = await draw(assetDir, region, core);
  assert.equal(baseline.stats.earlyCulledHaloCommands, 0);
  assert.equal(baseline.stats.plannedCommands, baseline.stats.renderedCommands);
  const wall = baseline.plan.commands.find(
      (c) => c.kind === "wall" && c.x === 11 && c.y === 10,
    ),
    left = (core.x - region.rect.x) * 16,
    top = (core.y - region.rect.y) * 16,
    crowns = baseline.plan.commands.filter((c) => c.treePart === "crown");
  assert.equal(wall.dx + wall.dw - left, 8);
  assert.equal(
    crowns.length,
    6,
    "140px crown remains split into its original bounded sprites",
  );
  assert.ok(crowns.every((c) => c.y === 17));
  assert.ok(
    crowns.some((c) => c.dy < top + core.height * 16 && c.dy + c.dh > top),
  );
  for (const native of nativeBlitterStatus.available
    ? [false, true]
    : [false]) {
    const actual = await draw(assetDir, region, core, {
      lowMemory: true,
      native,
    });
    assertEquivalent(actual, baseline, region, core);
    if (native) {
      assert.ok(actual.stats.nativeOverview.nativeCommands > 0);
      assert.ok(actual.stats.nativeOverview.rawPreparedFrames > 0);
      assert.equal(actual.stats.nativeOverview.canvasCommands, 0);
    }
  }
  // These exterior owners contribute visible pixels, so an owner-only filter
  // would fail the equality above even though all core owner counts survived.
  const noOverhang = structuredClone(region);
  put(noOverhang, 11, 10, { wall: 0 });
  put(noOverhang, 14, 17, { frameX: 0, frameY: 0 });
  const absent = await draw(assetDir, noOverhang, core);
  assert.notDeepEqual(absent.pixels, baseline.pixels);
  assert.deepEqual(region, before);
});

test("early halo culling preserves owner omissions and still validates halo-only corrupt assets", async (t) => {
  const assetDir = assetsFixture(t),
    region = makeRegion(),
    core = { x: 112, y: 209, width: 6, height: 5 };
  put(region, 0, 0, { active: true, type: 1, paint: 33 });
  put(region, 1, 0, { active: true, type: 0 });
  put(region, 12, 9, { active: true, type: 2 });
  put(region, 13, 9, { active: true, type: 1, paint: 33 });
  put(region, 14, 9, { active: true, type: 4, frameX: 0, frameY: 999 });
  const corrupt = PNG.sync.write(new PNG({ width: 16, height: 16 }));
  const idat = corrupt.indexOf(Buffer.from("IDAT"));
  assert.ok(idat > 0);
  corrupt[idat + 4] ^= 1;
  writeFileSync(join(assetDir, "Tiles_0.png"), corrupt);
  const baseline = await draw(assetDir, region, core);
  assert.ok(baseline.stats.assetFailures["Tiles_0.png"]);
  assert.equal(baseline.stats.missingCommands["Tiles_2.png"], 1);
  assert.equal(baseline.stats.invalidCommands["Tiles_4.png"], 1);
  assert.equal(baseline.stats.effectFailures["unknown-paint-id"], 1);
  assert.equal(baseline.stats.missingCommands["Tiles_0.png"], undefined);
  for (const native of nativeBlitterStatus.available
    ? [false, true]
    : [false]) {
    const actual = await draw(assetDir, region, core, {
      lowMemory: true,
      native,
    });
    assertEquivalent(actual, baseline, region, core);
  }
});

test("all core-owner effects remain validated even when individual crown pieces lie outside the core", async (t) => {
  const assetDir = assetsFixture(t),
    region = makeRegion(),
    core = { x: 114, y: 217, width: 1, height: 1 };
  addTallTree(region, { paint: 33 });
  const baseline = await draw(assetDir, region, core),
    owned = baseline.plan.commands.filter(
      (c) => c.x === 14 && c.y === 17 && c.kind === "tile",
    );
  assert.equal(owned.length, 7);
  assert.equal(
    baseline.stats.effectFailures["unknown-paint-id"],
    7,
    "all six canopy fragments and the trunk retain their owner's failure",
  );
  assert.ok(owned.some((c) => c.dy + c.dh + 1 <= 17 * 16));
  const actual = await draw(assetDir, region, core, {
    lowMemory: true,
    native: nativeBlitterStatus.available,
  });
  assertEquivalent(actual, baseline, region, core);
});
