import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { fixtureWorld, record } from "./fixture.mjs";
import { parseExportCli, exportWorld } from "../scripts/export-world.mjs";
import {
  parseOverviewCli,
  exportOverview,
} from "../scripts/export-overview.mjs";
import { nativeBlitterStatus } from "../scripts/native-blitter.mjs";
import { nativeReducerStatus } from "../scripts/native-reducer.mjs";

const require = createRequire(import.meta.url);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "exploretv-direct-reduction-")),
    assetDir = join(directory, "assets"),
    worldPath = join(directory, "source.wld");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(assetDir);
  const width = 24,
    height = 12,
    columns = Array.from({ length: width }, (_, x) =>
      Array.from({ length: height }, (_, y) => {
        // A source PointClamp continuation stretches one source row to four
        // destination rows, retaining a genuine Canvas-dependent output cell.
        if (x === 8 && y === 6)
          return record({ type: 1, shape: 1, liquid: 127 });
        if (x === 8 && y === 5) return record({ type: null, liquid: 200 });
        if (x === 7 && y === 6) return record({ type: null, liquid: 120 });
        // An opaque painted frame remains generic but supplies a final mean.
        if (x === 16 && y === 7) return record({ type: 0, paint: 2, wall: 1 });
        return record({ type: 1, wall: 1 });
      }),
    ),
    world = fixtureWorld({ width, height, columns });
  // Populate the optional v269 surface field in the synthetic zeroed header.
  // Keeping this halfbrick above ground selects the non-gradient PointClamp.
  const sceneMetadataSkip = 4 + 8 + 8 + 1 + 68 + 8;
  new DataView(world.bytes.buffer).setFloat64(
    world.widthOffset + 4 + sceneMetadataSkip,
    height,
    true,
  );
  writeFileSync(worldPath, world.bytes);
  for (const [name, w, h, opaque] of [
    ["Tiles_1.png", 288, 270, false],
    ["Tiles_0.png", 288, 270, true],
    ["Wall_1.png", 468, 180, false],
    ["water_0.png", 48, 1360, false],
    ["Liquid_0.png", 16, 16, false],
  ]) {
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        png.data.set(
          [
            (x * 13 + 91) & 255,
            (y * 7 + 53) & 255,
            (x + y + 37) & 255,
            opaque ? 255 : 128,
          ],
          (y * w + x) * 4,
        );
    writeFileSync(join(assetDir, name), PNG.sync.write(png));
  }
  return { directory, assetDir, worldPath };
}

function independentReduction(full, rect) {
  const output = Buffer.alloc(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++)
    for (let x = 0; x < rect.width; x++) {
      const sums = [0, 0, 0, 0];
      for (let sy = 0; sy < 16; sy++)
        for (let sx = 0; sx < 16; sx++) {
          const i =
              (((rect.y + y) * 16 + sy) * full.width + (rect.x + x) * 16 + sx) *
              4,
            alpha = full.data[i + 3];
          for (let c = 0; c < 3; c++) sums[c] += full.data[i + c] * alpha;
          sums[3] += alpha;
        }
      const at = (y * rect.width + x) * 4;
      for (let c = 0; c < 3; c++)
        output[at + c] = sums[3] ? Math.round(sums[c] / sums[3]) : 0;
      output[at + 3] = Math.round(sums[3] / 256);
    }
  return output;
}

test(
  "export reuses direct means before detailed reduction and preserves mixed Canvas and opaque output",
  { skip: !nativeBlitterStatus.available || !nativeReducerStatus.available },
  async (t) => {
    const { directory, assetDir, worldPath } = fixture(t),
      fullPath = join(directory, "full.png"),
      outputPath = join(directory, "overview.png"),
      core = { x: 2, y: 2, width: 20, height: 8 };
    await exportWorld(parseExportCli([worldPath, assetDir, fullPath]));
    const expected = independentReduction(
        PNG.sync.read(readFileSync(fullPath)),
        core,
      ),
      addon = require(
        fileURLToPath(
          new URL(
            `../artifacts/native/native-reducer-${process.platform}-${process.arch}.node`,
            import.meta.url,
          ),
        ),
      ),
      downsample = addon.downsampleRgba,
      priorResults = new WeakSet();
    let reusedDirectCalls = 0,
      protectedCells = 0;
    t.mock.method(addon, "downsampleRgba", (...args) => {
      const [
        source,
        width,
        height,
        factor,
        safe,
        rgba,
        stride,
        offsetX,
        offsetY,
      ] = args;
      // A complete earlier core reduction is the direct result. Row-sized
      // Canvas merges have height 16 and cannot satisfy this identity check.
      const reuse =
        width === core.width * 16 &&
        height === core.height * 16 &&
        rgba &&
        priorResults.has(rgba);
      if (reuse) {
        reusedDirectCalls++;
        assert.equal(factor, 16);
        assert.equal(stride, core.width);
        assert.equal(offsetX, 0);
        assert.equal(offsetY, 0);
        assert.ok(
          safe.includes(0),
          "Complex draws remain outside the direct mask",
        );
        for (let cell = 0; cell < safe.length; cell++) {
          if (!safe[cell]) continue;
          protectedCells++;
          const x = cell % core.width,
            y = Math.floor(cell / core.width);
          // A safe block is deliberately invalidated before native access.
          // The intermediate reducer output must come from the supplied mean,
          // before the exporter's later direct overlay can conceal a mistake.
          for (let row = 0; row < 16; row++) {
            const start = ((y * 16 + row) * width + x * 16) * 4;
            source.fill(0, start, start + 64);
          }
        }
      }
      const result = downsample(...args);
      if (reuse)
        for (let cell = 0; cell < safe.length; cell++)
          if (safe[cell])
            assert.deepEqual(
              result.subarray(cell * 4, cell * 4 + 4),
              rgba.subarray(cell * 4, cell * 4 + 4),
              `direct cell ${cell} must already be correct before overlays`,
            );
      priorResults.add(result);
      return result;
    });
    const report = await exportOverview(
      parseOverviewCli([
        worldPath,
        assetDir,
        outputPath,
        "--region",
        `${core.x},${core.y},${core.width},${core.height}`,
      ]),
    );
    assert.equal(
      reusedDirectCalls,
      1,
      "The generic reducer must receive direct.safe/pixels",
    );
    assert.ok(protectedCells > (core.width * core.height) / 2);
    assert.ok(
      report.nativeOverview.canvasCommands > 0,
      "The fixture must exercise a real Canvas fallback",
    );
    assert.ok(
      report.opaqueOverview.eligibleTiles > 0,
      "Generic opaque means must still be merged afterward",
    );
    assert.deepEqual(report.missingCommands, {});
    assert.deepEqual(report.invalidCommands, {});
    assert.deepEqual(report.effectFailures, {});
    assert.deepEqual(PNG.sync.read(readFileSync(outputPath)).data, expected);
  },
);
