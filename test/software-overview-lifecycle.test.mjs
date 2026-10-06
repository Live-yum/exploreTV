import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { registerTextureSource } from "../core/assets.mjs";
import { sceneFrameKey } from "../core/scene-frames.mjs";
import { createSoftwareOverview } from "../scripts/software-overview.mjs";
import { nativeBlitterStatus } from "../scripts/native-blitter.mjs";

const nativeTest = {
  skip: nativeBlitterStatus.available ? false : nativeBlitterStatus.reason,
};
const core = { x: 0, y: 0, width: 2, height: 2 },
  region = { rect: core };
function fixture() {
  const data = new Uint8Array(16 * 16 * 4).fill(201);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const source = registerTextureSource(
    { width: 16, height: 16 },
    {
      pngBytes: new Uint8Array(),
      rawRgba: { width: 16, height: 16, data },
    },
  );
  const commands = ["first", "second"].map((asset, i) => ({
    kind: "tile",
    type: 1,
    asset,
    paintId: 0,
    sx: 0,
    sy: 0,
    sw: 16,
    sh: 16,
    dx: i * 16,
    dy: 0,
    dw: 16,
    dh: 16,
  }));
  return {
    commands,
    assets: new Map(commands.map((c) => [c.asset, source])),
    plan: { width: 32, height: 32, commands },
    keys: new Map(commands.map((c) => [c, sceneFrameKey(c)])),
  };
}
const begin = (renderer, f) =>
  renderer.begin(f.plan, core, region, f.assets, f.keys);
function assertFinished(view, command) {
  assert.throws(() => view.preparationCommands([]), /finished/);
  assert.throws(() => view.resolveCached(command), /finished/);
  assert.throws(() => view.drawBatch([], {}), /finished/);
}

test(
  "finished native views retain output and caches while stale callbacks cannot release a new view",
  nativeTest,
  () => {
    const f = fixture(),
      renderer = createSoftwareOverview(),
      first = f.commands[0];
    try {
      const a = begin(renderer, f);
      assert.deepEqual(a.preparationCommands([first]), []);
      a.drawBatch([first], {
        resolve() {
          throw new Error("unexpected preparation");
        },
      });
      const output = Buffer.from(a.pixels),
        unsafe = new Uint8Array(a.unsafe);
      assert.deepEqual([...output.subarray(0, 4)], [201, 201, 201, 255]);
      a.finish();
      a.finish();
      assertFinished(a, first);
      assert.deepEqual(a.pixels, output);
      assert.deepEqual(a.unsafe, unsafe);
      assert.equal(renderer.stats.activeFrameBytes, 0);
      assert.ok(renderer.stats.frameBytes > 0);
      const b = begin(renderer, f);
      assert.deepEqual(b.preparationCommands([first]), []);
      assert.ok(renderer.stats.activeFrameBytes > 0);
      a.finish();
      assert.ok(b.resolveCached(first));
      assert.ok(renderer.stats.activeFrameBytes > 0);
      const c = begin(renderer, f);
      assertFinished(b, first);
      assert.equal(renderer.stats.activeFrameBytes, 0);
      c.preparationCommands([first]);
      b.finish();
      assert.ok(c.resolveCached(first));
      renderer.dispose();
      assertFinished(c, first);
      assert.equal(renderer.stats.activeFrameBytes, 0);
      assert.equal(renderer.stats.liveFrameBytes, 0);
      a.finish();
      b.finish();
      c.finish();
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "preparation and draw failures close the view and release already borrowed pixels",
  nativeTest,
  () => {
    for (const phase of ["prepare", "draw", "descriptor"]) {
      const f = fixture(),
        renderer = createSoftwareOverview(),
        view = begin(renderer, f);
      try {
        if (phase === "prepare") {
          f.assets.delete("second");
          assert.throws(
            () => view.preparationCommands(f.commands),
            /width|naturalWidth/,
          );
        } else {
          view.preparationCommands([f.commands[0]]);
          assert.ok(renderer.stats.activeFrameBytes > 0);
          const commands =
            phase === "descriptor"
              ? {
                  get length() {
                    throw new Error("descriptor failure");
                  },
                }
              : f.commands;
          assert.throws(
            () =>
              view.drawBatch(commands, {
                resolve() {
                  throw new Error("frame failure");
                },
              }),
            /failure/,
          );
        }
        assertFinished(view, f.commands[0]);
        assert.equal(renderer.stats.activeFrameBytes, 0);
        assert.equal(renderer.stats.liveFrameBytes, renderer.stats.frameBytes);
        const next = begin(renderer, f);
        next.finish();
      } finally {
        renderer.dispose();
      }
    }
  },
);

test(
  "reentrant disposal inside a frame resolver cannot allocate or draw into a closed view",
  nativeTest,
  () => {
    const f = fixture(),
      renderer = createSoftwareOverview(),
      view = begin(renderer, f);
    view.preparationCommands([f.commands[0]]);
    const output = Buffer.from(view.pixels);
    assert.throws(
      () =>
        view.drawBatch(f.commands, {
          resolve() {
            renderer.dispose();
            return {
              get base() {
                throw new Error(
                  "closed view must not inspect the returned frame",
                );
              },
            };
          },
        }),
      /finished/,
    );
    assert.deepEqual(view.pixels, output);
    assert.equal(renderer.stats.activeFrameBytes, 0);
    assert.equal(renderer.stats.liveFrameBytes, 0);
    assert.equal(renderer.stats.frameBytes, 0);
    assert.equal(renderer.stats.nativeCommands, 0);
    view.finish();
  },
);

test(
  "finish makes prior assets and command maps collectible before the next begin",
  nativeTest,
  () => {
    // A tiny isolated process supplies real major GC. The unfinished control
    // proves that the weak targets were actually held by the current callback.
    const moduleUrl = new URL(
      "../scripts/software-overview.mjs",
      import.meta.url,
    ).href;
    const source = `
    import assert from 'node:assert/strict';
    import { createSoftwareOverview } from ${JSON.stringify(moduleUrl)};
    const closed = createSoftwareOverview(), open = createSoftwareOverview();
    const core = { x: 0, y: 0, width: 1, height: 1 }, region = { rect: core };
    function track(renderer, finish) {
      const assets = new Map(), keys = new Map();
      const view = renderer.begin({ width: 16, height: 16, commands: [] }, core, region, assets, keys);
      if (finish) view.finish();
      return [new WeakRef(assets), new WeakRef(keys)];
    }
    const released = track(closed, true), retained = track(open, false);
    for (let i = 0; i < 4; i++) {
      await new Promise(setImmediate);
      global.gc();
    }
    assert.ok(retained.every(ref => ref.deref() !== undefined), 'unfinished control retains its context');
    assert.ok(released.every(ref => ref.deref() === undefined), 'finished view releases assets and command maps');
    closed.dispose(); open.dispose();
  `;
    const run = spawnSync(
      process.execPath,
      ["--expose-gc", "--input-type=module", "--eval", source],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 65536,
      },
    );
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
  },
);
