import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { fixtureWorld, record } from "./fixture.mjs";
import { nativeBlitterStatus } from "../scripts/native-blitter.mjs";
import { nativeReducerStatus } from "../scripts/native-reducer.mjs";
import {
  exportPreparedWorld,
  hashBoundedFile,
  prepareWorld,
  verifyPreparedWorldBindings,
} from "../scripts/prepared-world.mjs";
import { verifyExport } from "../scripts/verify-export.mjs";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "prepared-world-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worldPath = join(root, "source.wld"),
    assetDir = join(root, "assets"),
    directory = join(root, "compiled"),
    width = 37,
    height = 23;
  mkdirSync(assetDir);
  const columns = Array.from({ length: width }, (_, x) =>
    Array.from({ length: height }, (_, y) =>
      record({
        type: (x + y) % 5 === 0 ? null : (x + y) % 2,
        wall: 1,
        shape: (x + y) % 7 === 0 ? 2 : 0,
        paint: x % 13 === 0 ? 2 : 0,
        wallPaint: x % 17 === 0 ? 3 : 0,
      }),
    ),
  );
  writeFileSync(worldPath, fixtureWorld({ width, height, columns }).bytes);
  for (const [name, w, h, seed] of [
    ["Tiles_0.png", 288, 270, 17],
    ["Tiles_1.png", 288, 270, 1],
    ["Wall_1.png", 468, 180, 31],
  ]) {
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4,
          alpha = (x + y) % 11 === 0 ? 0 : 128 + (x % 128);
        png.data.set(
          [
            Math.min(alpha, (x * 7 + seed) % 256),
            Math.min(alpha, (y * 5 + seed) % 256),
            Math.min(alpha, (x + y + seed) % 256),
            alpha,
          ],
          i,
        );
      }
    writeFileSync(join(assetDir, name), PNG.sync.write(png));
  }
  return { root, worldPath, assetDir, directory };
}

test("bounded input hashes reject oversized files without retaining them", (t) => {
  const { worldPath } = setup(t),
    bytes = readFileSync(worldPath);
  assert.equal(
    hashBoundedFile(worldPath, bytes.length),
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.throws(() => hashBoundedFile(worldPath, bytes.length - 1), /budget/);
});

test(
  "prepared world replays exact pixels, validates its snapshot and never needs the first PNG",
  {
    skip: !nativeBlitterStatus.available || !nativeReducerStatus.available,
  },
  async (t) => {
    const args = setup(t);
    const preparation = await prepareWorld({
      ...args,
      flags: [
        "--region",
        "1,2,35,20",
        "--chunk-tiles",
        "16",
        "--band-tiles",
        "7",
      ],
    });
    assert.equal(preparation.schema, "exploretv-world-preparation-v1");
    assert.equal(preparation.manifest.chunks.length, 9);
    assert.ok(preparation.tape.commands > 0, "A real command tape is recorded");
    assert.ok(preparation.tape.frames > 0);
    const expected = PNG.sync.read(readFileSync(preparation.preview));
    for (const suffix of ["", ".json", ".progress.json"])
      rmSync(preparation.preview + suffix, { force: true });
    const outputPath = join(args.root, "replayed.png");
    const replay = await exportPreparedWorld({ ...args, outputPath });
    assert.equal(replay.executionMode, "prepared-command-replay");
    assert.equal(replay.fullWorld, false);
    assert.equal(replay.processedCells, 35 * 20);
    assert.deepEqual(replay.worldRect, { x: 1, y: 2, width: 35, height: 20 });
    assert.deepEqual(
      PNG.sync.read(readFileSync(outputPath)).data,
      expected.data,
    );
    assert.equal(replay.preparedWorld.rgbaSha256, preparation.rgbaSha256);
    assert.ok(replay.replay.peakFrameBytes <= 8 * 1024 ** 2);
    assert.equal((await verifyExport(outputPath)).status, "passed");
    await assert.rejects(
      exportPreparedWorld({ ...args, outputPath }),
      /already exists/,
    );
    await assert.rejects(prepareWorld(args), /already exists/);
    assert.ok(existsSync(outputPath));

    const manifestPath = join(args.directory, "manifest.json"),
      original = readFileSync(manifestPath);
    const mutate = async (callback, pattern, name) => {
      const manifest = JSON.parse(original);
      callback(manifest);
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const path = join(args.root, name + ".png");
      try {
        await assert.rejects(
          exportPreparedWorld({ ...args, outputPath: path }),
          pattern,
        );
        assert.equal(
          existsSync(path),
          false,
          "Invalid replay never publishes a PNG",
        );
        assert.equal(existsSync(path + ".partial"), false);
      } finally {
        writeFileSync(manifestPath, original);
      }
    };

    await t.test(
      "renderer and dependency fingerprints reject stale tapes",
      async () => {
        await mutate(
          (m) => {
            m.report.sourceHashes["core/renderer.mjs"] = "0".repeat(64);
          },
          /renderer source changed/,
          "stale-source",
        );
        for (const source of [
          "scripts/scene-command-index.mjs",
          "scripts/overview-geometry.mjs",
        ]) {
          await mutate(
            (m) => {
              delete m.report.sourceHashes[source];
            },
            /missing required source provenance/,
            "missing-" + source.split("/").at(-1),
          );
          await mutate(
            (m) => {
              m.report.sourceHashes[source] = "0".repeat(64);
            },
            /renderer source changed/,
            "stale-" + source.split("/").at(-1),
          );
        }
        await mutate(
          (m) => {
            m.report.preparedWorld.dependencyLockSha256 = "0".repeat(64);
          },
          /dependency lock changed/,
          "stale-lock",
        );
      },
    );
    await t.test(
      "reordered or omitted cores cannot turn correct local pixels into a wrong panorama",
      async () => {
        await mutate(
          (m) => {
            m.chunks[0].core.x++;
          },
          /exact scope/,
          "wrong-origin",
        );
        await mutate(
          (m) => {
            m.report.worldRect.x = 3;
          },
          /layout|exact scope/,
          "outside-world",
        );
        await mutate(
          (m) => {
            m.report.preparedWorld.rgbaSha256 = "0".repeat(64);
          },
          /pixel hash differs/,
          "wrong-pixels",
        );
      },
    );
    await t.test(
      "world and texture bytes are verified before output publication",
      async () => {
        const source = readFileSync(args.worldPath);
        try {
          writeFileSync(
            args.worldPath,
            Buffer.concat([source, Buffer.from([0])]),
          );
          await assert.rejects(
            exportPreparedWorld({
              ...args,
              outputPath: join(args.root, "stale-world.png"),
            }),
            /world SHA-256 differs/,
          );
        } finally {
          writeFileSync(args.worldPath, source);
        }
        const texturePath = join(args.assetDir, "Tiles_0.png"),
          texture = readFileSync(texturePath);
        try {
          writeFileSync(
            texturePath,
            Buffer.concat([texture, Buffer.from([0])]),
          );
          await assert.rejects(
            exportPreparedWorld({
              ...args,
              outputPath: join(args.root, "stale-texture.png"),
            }),
            /texture changed/,
          );
        } finally {
          writeFileSync(texturePath, texture);
        }
      },
    );
    await t.test(
      "a newly available formerly missing texture invalidates the snapshot",
      () => {
        const report = structuredClone(preparation.manifest.report);
        report.missingCommands["Tiles_650.png"] = 1;
        report.preparedWorld.inputAssetStates["Tiles_650.png"] = null;
        verifyPreparedWorldBindings(report, args);
        writeFileSync(
          join(args.assetDir, "Tiles_650.png"),
          readFileSync(join(args.assetDir, "Tiles_0.png")),
        );
        assert.throws(
          () => verifyPreparedWorldBindings(report, args),
          /texture state changed/,
        );
      },
    );
    await t.test(
      "cancellation during a completed band removes the partial PNG",
      async () => {
        const controller = new AbortController(),
          path = join(args.root, "cancelled.png");
        await assert.rejects(
          exportPreparedWorld(
            { ...args, outputPath: path },
            {
              signal: controller.signal,
              onProgress: () =>
                controller.abort(new Error("test cancellation")),
            },
          ),
          /test cancellation/,
        );
        assert.equal(existsSync(path), false);
        assert.equal(existsSync(path + ".partial"), false);
      },
    );
  },
);

test(
  "failed preparation releases only its own files",
  {
    skip: !nativeBlitterStatus.available || !nativeReducerStatus.available,
  },
  async (t) => {
    const args = setup(t),
      controller = new AbortController();
    await assert.rejects(
      prepareWorld(
        { ...args, flags: ["--band-tiles", "7"] },
        {
          signal: controller.signal,
          onProgress: () => controller.abort(new Error("stop preparation")),
        },
      ),
      /stop preparation/,
    );
    assert.equal(existsSync(join(args.directory, "manifest.json")), false);
    assert.equal(existsSync(args.directory), false);
    assert.ok(existsSync(args.worldPath));
  },
);
