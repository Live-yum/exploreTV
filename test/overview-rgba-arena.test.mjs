import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { registerTextureSource, textureSource } from "../core/assets.mjs";
import { sceneFrameKey } from "../core/scene-frames.mjs";
import { createOverviewRgbaArena } from "../scripts/overview-rgba-arena.mjs";
import { createDirectTerrainOverview } from "../scripts/direct-terrain-overview.mjs";
import { createSoftwareOverview } from "../scripts/software-overview.mjs";
import { nativeBlitterStatus } from "../scripts/native-blitter.mjs";
import { boxDownsampleRgba } from "../scripts/downsample-rgba.mjs";

const nativeTest = {
  skip: nativeBlitterStatus.available ? false : nativeBlitterStatus.reason,
};

function fixture(width = 2, height = 2, alpha = 128) {
  const data = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([173, 64, 211, alpha], i);
  const source = registerTextureSource(
      { width: 16, height: 16 },
      {
        pngBytes: new Uint8Array(),
        rawRgba: { width: 16, height: 16, data },
      },
    ),
    core = { x: 0, y: 0, width, height },
    commands = [0, 1].map((i) => ({
      kind: "tile",
      type: 1,
      asset: `frame${i}`,
      paintId: 0,
      sx: 0,
      sy: 0,
      sw: 16,
      sh: 16,
      dx: i * 8,
      dy: i * 4,
      dw: 16,
      dh: 16,
    }));
  return {
    core,
    region: { rect: core },
    plan: { width: width * 16, height: height * 16, commands },
    assets: new Map(commands.map((c) => [c.asset, source])),
    keys: new Map(commands.map((c) => [c, sceneFrameKey(c)])),
  };
}
const begin = (renderer, f) =>
  renderer.begin(f.plan, f.core, f.region, f.assets, f.keys);
const draw = (view, commands) => {
  assert.deepEqual(view.preparationCommands(commands), []);
  view.drawBatch(commands, {
    resolve() {
      throw new Error("Unexpected prepared frame fallback");
    },
  });
};

test("RGBA arena has one lazy fixed allocation and exclusive, idempotent leases", () => {
  for (const maxBytes of [0, 3, 1025, Infinity, 6 * 1024 * 1024 + 4])
    assert.throws(() => createOverviewRgbaArena({ maxBytes }), /capacity/);
  const arena = createOverviewRgbaArena({ maxBytes: 4096 });
  assert.equal(arena.stats.bufferBytes, 0);
  assert.equal(arena.stats.allocations, 0);
  for (const bytes of [0, 3, 4097, Infinity])
    assert.throws(() => arena.acquire(bytes), /capacity/);
  const first = arena.acquire(4),
    backing = first.pixels.buffer;
  assert.equal(backing.byteLength, 4096, "small arenas bypass the Buffer pool");
  assert.equal(first.pixels.length, 4);
  first.pixels.fill(19);
  assert.throws(() => arena.acquire(4096), /active lease/);
  assert.throws(() => arena.dispose(), /active lease/);
  first.release();
  first.release();
  const second = arena.acquire(4096);
  assert.equal(second.pixels.buffer, backing);
  assert.deepEqual([...second.pixels.subarray(0, 4)], [19, 19, 19, 19]);
  first.release();
  assert.equal(
    arena.stats.activeBytes,
    4096,
    "stale release preserves new lease",
  );
  assert.throws(() => arena.acquire(4), /active lease/);
  assert.equal(arena.stats.allocations, 1);
  assert.equal(arena.stats.peakBufferBytes, 4096);
  assert.equal(arena.stats.peakActiveBytes, 4096);
  assert.equal(arena.stats.releases, 1);
  second.release();
  arena.dispose();
  arena.dispose();
  first.release();
  second.release();
  assert.equal(arena.stats.bufferBytes, 0);
  assert.equal(arena.stats.releases, 2);
  assert.throws(() => arena.acquire(4), /disposed/);
});

test(
  "direct and generic stages reuse one backing without changing their exact output lifetimes",
  nativeTest,
  () => {
    const arena = createOverviewRgbaArena({ maxBytes: 4096 }),
      direct = createDirectTerrainOverview({ detailedRgbaArena: arena }),
      software = createSoftwareOverview({ detailedRgbaArena: arena }),
      reference = createSoftwareOverview(),
      f = fixture();
    try {
      const expected = begin(reference, f);
      draw(expected, f.plan.commands);
      const expectedPixels = Buffer.from(expected.pixels);
      expected.finish();
      const result = direct.render(f.plan, f.core, f.region, f.assets);
      assert.deepEqual(
        result.pixels,
        boxDownsampleRgba(expectedPixels, 32, 32, 16),
      );
      assert.equal(
        arena.stats.activeBytes,
        0,
        "direct completes reduction before release",
      );
      assert.ok(direct.stats.nativeBlits > 0);
      const probe = arena.acquire(4096),
        backing = probe.pixels.buffer,
        retainedDirect = result.pixels.slice();
      assert.notEqual(result.pixels.buffer, backing);
      probe.release();
      const view = begin(software, f);
      assert.equal(view.pixels.buffer, backing);
      draw(view, f.plan.commands);
      view.finish();
      assert.deepEqual(view.pixels, expectedPixels);
      assert.equal(
        arena.stats.activeBytes,
        4096,
        "finish preserves output until caller reduces it",
      );
      assert.throws(
        () => direct.render(f.plan, f.core, f.region, f.assets),
        /active lease/,
      );
      assert.deepEqual(view.pixels, expectedPixels);
      view.releasePixels();
      software.releasePixels();
      const secondDirect = direct.render(f.plan, f.core, f.region, f.assets);
      assert.deepEqual(secondDirect.pixels, retainedDirect);
      const smaller = fixture(1, 1),
        smallView = begin(software, smaller);
      assert.equal(smallView.pixels.length, 1024);
      assert.equal(smallView.pixels.buffer, backing);
      view.finish();
      view.releasePixels();
      assert.equal(
        arena.stats.activeBytes,
        1024,
        "stale finish cannot return the new output",
      );
      draw(smallView, smaller.plan.commands);
      smallView.finish();
      const largeView = begin(software, f);
      assert.equal(
        largeView.pixels.buffer,
        backing,
        "growing the used prefix never allocates",
      );
      assert.deepEqual(
        result.pixels,
        retainedDirect,
        "direct 1px result survives later detailed draws",
      );
      assert.equal(arena.stats.allocations, 1);
      assert.equal(software.stats.bufferBytes, 0);
      assert.equal(direct.stats.bufferBytes, 0);
      assert.equal(software.stats.peakSharedBufferBytes, 4096);
      assert.equal(direct.stats.peakSharedBufferBytes, 4096);
      largeView.releasePixels();
      assert.equal(
        arena.stats.activeBytes,
        0,
        "enclosing engine failure can release an unfinished view",
      );
      assert.throws(() => largeView.preparationCommands([]), /finished/);
    } finally {
      software.dispose();
      direct.dispose();
      reference.dispose();
      arena.dispose();
    }
  },
);

test(
  "empty, opaque, unsafe and oversized cores do not strand or duplicate shared backing",
  nativeTest,
  () => {
    const arena = createOverviewRgbaArena({ maxBytes: 1024 }),
      direct = createDirectTerrainOverview({ detailedRgbaArena: arena }),
      software = createSoftwareOverview({ detailedRgbaArena: arena }),
      f = fixture(1, 1, 255);
    try {
      const opaque = { ...f.plan, commands: [f.plan.commands[0]] };
      assert.ok(direct.render(opaque, f.core, f.region, f.assets));
      assert.equal(
        arena.stats.allocations,
        0,
        "opaque mean requires no detailed allocation",
      );
      assert.ok(
        direct.render({ ...f.plan, commands: [] }, f.core, f.region, f.assets),
      );
      assert.equal(arena.stats.allocations, 0);
      const first = begin(software, f);
      first.finish();
      const unsafe = {
        ...f,
        plan: { ...f.plan, commands: [{ ...f.plan.commands[0], dw: 16.5 }] },
      };
      assert.equal(begin(software, unsafe), null);
      assert.equal(
        arena.stats.activeBytes,
        0,
        "all-unsafe next view returns previous lease",
      );
      const large = fixture();
      assert.equal(
        direct.render(large.plan, large.core, large.region, large.assets),
        null,
      );
      assert.equal(begin(software, large), null);
      assert.equal(arena.stats.allocations, 1);
      assert.equal(arena.stats.peakBufferBytes, 1024);
      assert.equal(direct.stats.bufferBytes, 0);
      assert.equal(software.stats.bufferBytes, 0);
    } finally {
      software.dispose();
      direct.dispose();
      arena.dispose();
    }
  },
);

test(
  "failed and reentrant generic views return only their own shared lease",
  nativeTest,
  () => {
    for (const phase of [
      "prepare",
      "draw",
      "descriptor",
      "record",
      "dispose",
      "supersede",
    ]) {
      const arena = createOverviewRgbaArena({ maxBytes: 4096 }),
        software = createSoftwareOverview({
          detailedRgbaArena: arena,
          onNativeBatch:
            phase === "record"
              ? () => {
                  throw new Error("record failure");
                }
              : null,
        }),
        f = fixture(),
        view = begin(software, f);
      let next = null;
      try {
        if (phase === "prepare") {
          f.assets.delete("frame1");
          assert.throws(
            () => view.preparationCommands(f.plan.commands),
            /width|naturalWidth/,
          );
        } else {
          view.preparationCommands([f.plan.commands[0]]);
          const commands =
            phase === "descriptor"
              ? {
                  get length() {
                    throw new Error("descriptor failure");
                  },
                }
              : f.plan.commands;
          if (phase === "record") view.preparationCommands(commands);
          assert.throws(
            () =>
              view.drawBatch(commands, {
                resolve() {
                  if (phase === "dispose") software.dispose();
                  else if (phase === "supersede") next = begin(software, f);
                  else throw new Error("frame failure");
                  return null;
                },
              }),
            /failure|finished/,
          );
        }
        assert.equal(arena.stats.activeBytes, next ? 4096 : 0, phase);
        view.finish();
        if (next) {
          assert.equal(arena.stats.activeBytes, 4096);
          next.preparationCommands([]);
        }
        software.releasePixels();
        assert.equal(arena.stats.activeBytes, 0);
        const independent = arena.acquire(4096);
        independent.release();
      } finally {
        software.dispose();
        arena.dispose();
      }
    }
  },
);

test(
  "a direct second-pass failure returns the borrowed core before generic fallback",
  nativeTest,
  () => {
    const arena = createOverviewRgbaArena({ maxBytes: 4096 }),
      direct = createDirectTerrainOverview({
        detailedRgbaArena: arena,
        maxFrames: 1,
        maxFrameBytes: 8192,
      }),
      software = createSoftwareOverview({ detailedRgbaArena: arena }),
      f = fixture(),
      raw = textureSource(f.assets.get("frame0")).rawRgba;
    let reads = 0;
    const unstable = registerTextureSource(
      { width: 16, height: 16 },
      {
        pngBytes: new Uint8Array(),
        rawRgbaProvider: () => (++reads === 1 ? raw : null),
      },
    );
    f.assets.set("frame1", unstable);
    try {
      assert.equal(direct.render(f.plan, f.core, f.region, f.assets), null);
      assert.equal(direct.stats.secondPassFailures, 1);
      assert.equal(
        arena.stats.acquisitions,
        1,
        "failure occurs after the detailed core was acquired",
      );
      assert.equal(arena.stats.releases, 1);
      assert.equal(arena.stats.activeBytes, 0);
      registerTextureSource(unstable, {
        pngBytes: new Uint8Array(),
        rawRgba: raw,
      });
      const fallback = begin(software, f);
      draw(fallback, f.plan.commands);
      fallback.finish();
      assert.equal(arena.stats.allocations, 1);
      software.releasePixels();
      assert.ok(direct.render(f.plan, f.core, f.region, f.assets));
      assert.equal(arena.stats.activeBytes, 0);
    } finally {
      software.dispose();
      direct.dispose();
      arena.dispose();
    }
  },
);

test(
  "shared finished output does not retain completed assets or command maps",
  nativeTest,
  () => {
    const rendererUrl = new URL(
        "../scripts/software-overview.mjs",
        import.meta.url,
      ).href,
      arenaUrl = new URL("../scripts/overview-rgba-arena.mjs", import.meta.url)
        .href,
      source = `
      import assert from 'node:assert/strict';
      import { createSoftwareOverview } from ${JSON.stringify(rendererUrl)};
      import { createOverviewRgbaArena } from ${JSON.stringify(arenaUrl)};
      const arena = createOverviewRgbaArena({maxBytes: 1024});
      const closed = createSoftwareOverview({detailedRgbaArena: arena}), open = createSoftwareOverview();
      const core = {x:0,y:0,width:1,height:1}, region = {rect:core};
      function track(renderer, finish) {
        const assets = new Map(), keys = new Map();
        const view = renderer.begin({width:16,height:16,commands:[]}, core, region, assets, keys);
        if(finish) view.finish();
        return [new WeakRef(assets), new WeakRef(keys)];
      }
      const released = track(closed,true), retained = track(open,false);
      for(let i=0;i<4;i++) { await new Promise(setImmediate); global.gc(); }
      assert.ok(retained.every(r=>r.deref()!==undefined));
      assert.ok(released.every(r=>r.deref()===undefined),'arena lease must not retain a begin closure');
      assert.equal(arena.stats.activeBytes,1024,'finished output remains borrowed');
      closed.dispose(); open.dispose(); arena.dispose();
    `,
      run = spawnSync(
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
