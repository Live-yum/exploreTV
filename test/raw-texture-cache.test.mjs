import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { PNG } from "pngjs";
import { registerTextureSource, textureSource } from "../core/assets.mjs";
import { decodePngRgba } from "../core/png-rgba.mjs";
import {
  createSceneFrameCache,
  prepareSceneFrames,
} from "../core/scene-frames.mjs";
import {
  createRawTextureCache,
  RAW_TEXTURE_CACHE_LIMITS,
} from "../scripts/raw-texture-cache.mjs";

function fixture(t, { width = 16, height = 16 } = {}) {
  const assetDir = mkdtempSync(join(tmpdir(), "exploretv-raw-textures-"));
  t.after(() => rmSync(assetDir, { recursive: true, force: true }));
  const pngs = new Map(),
    raws = new Map();
  for (let seed = 0; seed < 3; seed++) {
    const data = Buffer.alloc(width * height * 4),
      name = `${seed}.png`;
    for (let i = 0; i < width * height; i++)
      data.set(
        [
          (i * 17 + seed + 255) & 255,
          (i * 31 + seed * 3 + 203) & 255,
          (i * 71 + seed * 7 + 117) & 255,
          [0, 1, 2, 17, 63, 127, 254, 255][i % 8],
        ],
        i * 4,
      );
    const png = PNG.sync.write(
      { width, height, data },
      { colorType: 6, inputColorType: 6, bitDepth: 8, filterType: seed },
    );
    writeFileSync(join(assetDir, name), png);
    pngs.set(name, png);
    raws.set(name, { width, height, data: new Uint8ClampedArray(data) });
  }
  return { assetDir, pngs, raws };
}

const command = (asset = "0.png", extra = {}) => ({
  kind: "tile",
  asset,
  type: 1,
  sx: 0,
  sy: 0,
  sw: 16,
  sh: 16,
  dx: 0,
  dy: 0,
  dw: 16,
  dh: 16,
  ...extra,
});
const prepare = (assets, commands, extra = {}) =>
  prepareSceneFrames({ commands }, assets, createCanvas, {
    inputEncoding: "tconvert-game-raw",
    opaqueScene: true,
    ...extra,
  });
const pixels = (canvas) =>
  canvas
    ? canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height)
        .data
    : null;

test("raw LRU eviction preserves descriptor and prepared-frame identities without redecoding hits", (t) => {
  const { assetDir } = fixture(t),
    cache = createRawTextureCache({ assetDir, maxRawBytes: 1041 }),
    frameCache = createSceneFrameCache(),
    first = cache.assetsFor(["0.png", "1.png"]),
    source = first.assets.get("0.png"),
    registration = textureSource(source),
    c = command();
  assert.ok(Object.isFrozen(source));
  assert.ok(Object.isFrozen(registration));
  const frames = prepare(first.assets, [c], { frameCache }),
    frame = frames.resolve(c);
  assert.ok(frame.base);
  frames.dispose();
  textureSource(first.assets.get("1.png")).rawRgba;
  const decodes = cache.stats.rawDecodes;
  first.dispose();
  const next = cache.assetsFor(["0.png"]);
  assert.equal(next.assets.get("0.png"), source);
  assert.equal(textureSource(next.assets.get("0.png")), registration);
  const warm = prepare(next.assets, [c], { frameCache });
  assert.equal(warm.resolve(c), frame);
  assert.equal(cache.stats.rawDecodes, decodes);
  assert.equal(frameCache.stats.hits, 1);
  assert.ok(cache.stats.rawEvictions >= 2);
  assert.equal(cache.stats.peakRawBytes, 1040);
  warm.dispose();
  next.dispose();
  frameCache.dispose();
  cache.dispose();
});

test("lazy channels match eager preparation for every paint, hidden RGB, low alpha and corners", (t) => {
  const { assetDir, pngs, raws } = fixture(t),
    cache = createRawTextureCache({ assetDir, maxRawBytes: 0 }),
    view = cache.assetsFor(["0.png"]),
    eager = new Map([
      [
        "0.png",
        registerTextureSource(
          { width: 16, height: 16 },
          {
            pngBytes: pngs.get("0.png"),
            rawRgba: raws.get("0.png"),
          },
        ),
      ],
    ]);
  for (let paintId = 0; paintId <= 31; paintId++) {
    const commands = [
      command("0.png", { paintId }),
      command("0.png", {
        paintId,
        kind: "wall",
        vertexColor: [231, 71, 191, 107],
      }),
      command("0.png", {
        paintId,
        kind: "liquid",
        dw: 12,
        dh: 8,
        flipX: true,
        flipY: true,
        vertexColors: {
          topLeft: [255, 0, 111, 0],
          topRight: [7, 221, 131, 63],
          bottomRight: [255, 251, 9, 255],
          bottomLeft: [173, 67, 53, 127],
        },
      }),
    ];
    const expected = prepare(eager, commands),
      actual = prepare(view.assets, commands);
    assert.deepEqual(actual.support, expected.support);
    for (const c of commands) {
      assert.deepEqual(
        pixels(actual.resolve(c).base),
        pixels(expected.resolve(c).base),
      );
      assert.deepEqual(
        pixels(actual.resolve(c).additive),
        pixels(expected.resolve(c).additive),
      );
    }
    actual.dispose();
    expected.dispose();
  }
  assert.equal(cache.stats.rawBytes, 0);
  assert.equal(cache.stats.peakRawBytes, 0);
  assert.ok(cache.stats.pngDecodeCache.nativeInflations > 0);
  view.dispose();
  cache.dispose();
});

test("both retained LRUs are bounded and active compressed overshoot is reported exactly", (t) => {
  const { assetDir, pngs } = fixture(t),
    maxEncodedBytes = Math.max(...[...pngs.values()].map((p) => p.length)),
    cache = createRawTextureCache({
      assetDir,
      maxEncodedBytes,
      maxRawBytes: 1041,
    }),
    view = cache.assetsFor([...pngs.keys()]),
    total = [...pngs.values()].reduce((n, p) => n + p.length, 0);
  assert.equal(view.assets.size, 3);
  assert.ok(cache.stats.encodedEntries >= 1 && cache.stats.encodedEntries < 3);
  assert.ok(cache.stats.encodedEvictions >= 1);
  assert.equal(cache.stats.activeEncodedBytes, total);
  assert.equal(cache.stats.liveEncodedBytes, total);
  assert.equal(cache.stats.peakLiveEncodedBytes, total);
  assert.equal(cache.stats.peakActiveEncodedBytes, total);
  assert.ok(cache.stats.retainedEncodedBytes <= maxEncodedBytes);
  assert.ok(cache.stats.peakRetainedEncodedBytes <= maxEncodedBytes);
  assert.equal(cache.stats.rawBytes, 1040);
  assert.equal(cache.stats.peakRawBytes, 1040);
  for (const name of pngs.keys()) {
    assert.deepEqual(
      textureSource(view.assets.get(name)).rawRgba,
      decodePngRgba(pngs.get(name)),
    );
    assert.ok(cache.stats.rawBytes <= 1041);
  }
  view.dispose();
  view.dispose();
  assert.equal(view.assets.size, 0);
  assert.equal(cache.stats.activeEncodedBytes, 0);
  assert.equal(cache.stats.activeSnapshots, 0);
  assert.equal(cache.stats.liveEncodedBytes, cache.stats.retainedEncodedBytes);
  cache.dispose();
  assert.equal(cache.stats.liveBytes, 0);
  assert.equal(cache.stats.pngDecodeCache.cachedStreams, 0);
});

test("immutable compressed snapshots survive file replacement and inspection without stale frame reuse", (t) => {
  const { assetDir, pngs, raws } = fixture(t),
    cache = createRawTextureCache({ assetDir, maxEntries: 1, maxRawBytes: 0 }),
    old = cache.assetsFor(["0.png"]),
    source = old.assets.get("0.png"),
    registration = textureSource(source),
    originalHash = cache.assetHashes["0.png"];
  registration.pngBytes.fill(0);
  writeFileSync(join(assetDir, "0.png"), pngs.get("1.png"));
  const stillRetained = cache.assetsFor(["0.png"]);
  assert.equal(stillRetained.assets.get("0.png"), source);
  assert.equal(cache.assetHashes["0.png"], originalHash);
  assert.deepEqual(registration.rawRgba, raws.get("0.png"));
  const other = cache.assetsFor(["2.png"]),
    replacement = cache.assetsFor(["0.png"]);
  assert.notEqual(replacement.assets.get("0.png"), source);
  assert.deepEqual(
    textureSource(replacement.assets.get("0.png")).rawRgba,
    raws.get("1.png"),
  );
  assert.deepEqual(registration.rawRgba, raws.get("0.png"));
  assert.equal(
    cache.assetHashes["0.png"],
    createHash("sha256").update(pngs.get("1.png")).digest("hex"),
  );
  assert.equal(cache.stats.activeSnapshots, 3);
  for (const view of [old, stillRetained, other, replacement]) view.dispose();
  cache.dispose();
});

test("oversized raw atlases bypass retention and are requested exactly once per frame", (t) => {
  const { assetDir } = fixture(t),
    cache = createRawTextureCache({
      assetDir,
      maxRawBytes: 1,
      maxEncodedBytes: 0,
    }),
    view = cache.assetsFor(["0.png"]);
  assert.equal(cache.stats.rawDecodes, 1);
  assert.equal(cache.stats.rawBytes, 0);
  assert.equal(cache.stats.retainedEncodedBytes, 0);
  assert.equal(cache.stats.encodedBypasses, 1);
  const frames = prepare(view.assets, [command()]);
  assert.ok(frames.resolve(command()).base);
  assert.equal(cache.stats.rawDecodes, 2);
  assert.equal(cache.stats.rawBypasses, 2);
  assert.equal(cache.stats.peakRawBytes, 0);
  frames.dispose();
  view.dispose();
  assert.equal(cache.stats.liveBytes, 0);
  cache.dispose();
});

test("missing files remain absent, invalid PNGs report exact failures, and fixed files can load", (t) => {
  const { assetDir, pngs } = fixture(t),
    bad = Buffer.from(pngs.get("0.png")),
    hashes = {},
    failures = {};
  bad[bad.length - 1] ^= 1;
  writeFileSync(join(assetDir, "bad.png"), bad);
  const cache = createRawTextureCache({
    assetDir,
    assetHashes: hashes,
    assetFailures: failures,
  });
  for (let pass = 0; pass < 2; pass++) {
    const view = cache.assetsFor(["missing.png", "bad.png", "0.png"]);
    assert.deepEqual([...view.assets.keys()], ["0.png"]);
    assert.match(failures["bad.png"], /IEND CRC mismatch/);
    assert.equal(failures["missing.png"], undefined);
    assert.equal(hashes["bad.png"], undefined);
    assert.equal(
      hashes["0.png"],
      createHash("sha256").update(pngs.get("0.png")).digest("hex"),
    );
    view.dispose();
  }
  writeFileSync(join(assetDir, "bad.png"), pngs.get("0.png"));
  const repaired = cache.assetsFor(["bad.png"]);
  assert.equal(repaired.assets.size, 1);
  assert.equal(failures["bad.png"], undefined);
  repaired.dispose();
  cache.dispose();
});

test("cache disposal releases retained memory and tracks still-live views until their release", (t) => {
  const { assetDir, pngs } = fixture(t),
    cache = createRawTextureCache({ assetDir }),
    first = cache.assetsFor(["0.png"]),
    second = cache.assetsFor(["0.png"]),
    source = first.assets.get("0.png");
  assert.equal(cache.stats.activeSnapshots, 1);
  assert.equal(cache.stats.activeEncodedBytes, pngs.get("0.png").length);
  cache.dispose();
  cache.dispose();
  assert.equal(cache.stats.retainedBytes, 0);
  assert.equal(cache.stats.liveEncodedBytes, pngs.get("0.png").length);
  assert.throws(() => textureSource(source).rawRgba, /disposed/);
  assert.throws(() => cache.assetsFor(["0.png"]), /disposed/);
  first.dispose();
  assert.equal(cache.stats.activeSnapshots, 1);
  second.dispose();
  assert.equal(cache.stats.liveBytes, 0);
});

test("provider registration validates outputs, never calls eagerly, and preserves eager behavior", () => {
  const image = { width: 1, height: 1 };
  let calls = 0;
  registerTextureSource(image, {
    pngBytes: Uint8Array.of(1, 2, 3),
    rawRgbaProvider: () => {
      calls++;
      return { width: 2, height: 1, data: new Uint8ClampedArray(8) };
    },
  });
  assert.equal(calls, 0);
  assert.throws(() => textureSource(image).rawRgba, /dimensions differ/);
  assert.equal(calls, 1);
  for (const rawRgbaProvider of [false, 1, {}])
    assert.throws(
      () =>
        registerTextureSource(image, {
          pngBytes: new Uint8Array(),
          rawRgbaProvider,
        }),
      /provider/,
    );
  assert.throws(
    () =>
      registerTextureSource(image, {
        pngBytes: new Uint8Array(),
        rawRgba: { width: 1, height: 1, data: new Uint8ClampedArray(4) },
        rawRgbaProvider: () => null,
      }),
    /provider/,
  );
});

test("cache bounds reject unsafe limits", () => {
  for (const options of [
    { maxEncodedBytes: -1 },
    { maxEncodedBytes: 8 * 1024 * 1024 + 1 },
    { maxRawBytes: NaN },
    { maxRawBytes: 1.5 },
    { maxRawBytes: 16 * 1024 * 1024 + 1 },
    { maxEntries: 0 },
    { maxEntries: 513 },
    { maxActiveEncodedBytes: -1 },
    { maxActiveEncodedBytes: 32 * 1024 * 1024 + 1 },
    { maxActiveSnapshots: 0 },
    { maxActiveSnapshots: 513 },
  ])
    assert.throws(
      () => createRawTextureCache({ assetDir: ".", ...options }),
      /budget/,
    );
});

test("active PNG byte limit aborts the whole view before opening an over-budget file", (t) => {
  const { assetDir, pngs } = fixture(t),
    maxActiveEncodedBytes =
      pngs.get("0.png").length + pngs.get("1.png").length - 1,
    cache = createRawTextureCache({ assetDir, maxActiveEncodedBytes }),
    originalOpen = fs.openSync,
    opened = [];
  try {
    fs.openSync = (...args) => {
      opened.push(args[0]);
      return originalOpen(...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => cache.assetsFor(["0.png", "1.png"]), {
      code: "ERR_RAW_TEXTURE_BUDGET",
      message: /snapshot bytes exceed budget/,
    });
    assert.deepEqual(opened, [join(assetDir, "0.png")]);
  } finally {
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(cache.stats.activeSnapshots, 0);
  assert.equal(cache.stats.activeEncodedBytes, 0);
  assert.ok(cache.stats.peakActiveEncodedBytes <= maxActiveEncodedBytes);
  assert.deepEqual(cache.assetFailures, {});
  const valid = cache.assetsFor(["1.png"]);
  assert.equal(valid.assets.size, 1);
  valid.dispose();
  cache.dispose();
});

test("overlapping views count shared snapshots once and failed views release only their own borrows", (t) => {
  const { assetDir, pngs } = fixture(t),
    total = pngs.get("0.png").length + pngs.get("1.png").length;
  for (const options of [
    { maxActiveEncodedBytes: total },
    { maxActiveSnapshots: 2 },
  ]) {
    const cache = createRawTextureCache({ assetDir, ...options }),
      first = cache.assetsFor(["0.png"]),
      overlapping = cache.assetsFor(["0.png", "1.png"]);
    assert.equal(cache.stats.activeEncodedBytes, total);
    assert.equal(cache.stats.activeSnapshots, 2);
    assert.throws(() => cache.assetsFor(["0.png", "2.png"]), {
      code: "ERR_RAW_TEXTURE_BUDGET",
    });
    assert.equal(cache.stats.activeSnapshots, 2);
    assert.equal(cache.stats.activeEncodedBytes, total);
    assert.ok(first.assets.get("0.png"));
    first.dispose();
    assert.equal(cache.stats.activeSnapshots, 2);
    overlapping.dispose();
    assert.equal(cache.stats.activeSnapshots, 0);
    const afterRelease = cache.assetsFor(["2.png"]);
    assert.equal(afterRelease.assets.size, 1);
    afterRelease.dispose();
    cache.dispose();
  }
});

test("distinct active snapshots of one filename count separately after encoded eviction", (t) => {
  const { assetDir } = fixture(t),
    cache = createRawTextureCache({
      assetDir,
      maxEntries: 1,
      maxActiveSnapshots: 2,
    }),
    first = cache.assetsFor(["0.png"]),
    original = first.assets.get("0.png"),
    other = cache.assetsFor(["1.png"]);
  assert.equal(cache.stats.activeSnapshots, 2);
  assert.throws(() => cache.assetsFor(["0.png"]), {
    code: "ERR_RAW_TEXTURE_BUDGET",
  });
  first.dispose();
  const replaced = cache.assetsFor(["0.png"]);
  assert.notEqual(replaced.assets.get("0.png"), original);
  assert.equal(cache.stats.activeSnapshots, 2);
  other.dispose();
  replaced.dispose();
  assert.equal(cache.stats.activeSnapshots, 0);
  cache.dispose();
});

test("retained but inactive snapshots must pass the aggregate pinning preflight", (t) => {
  const { assetDir } = fixture(t),
    cache = createRawTextureCache({ assetDir, maxActiveSnapshots: 1 }),
    retained = cache.assetsFor(["0.png"]);
  retained.dispose();
  const active = cache.assetsFor(["1.png"]),
    decodes = cache.stats.rawDecodes;
  assert.throws(() => cache.assetsFor(["0.png"]), {
    code: "ERR_RAW_TEXTURE_BUDGET",
  });
  assert.equal(cache.stats.rawDecodes, decodes);
  assert.equal(cache.stats.activeSnapshots, 1);
  active.dispose();
  cache.dispose();
});

test("bounded PNG reads reject overstated, growing and shrinking preflight sizes", (t) => {
  for (const change of ["overstated", "growing", "shrinking"]) {
    const { assetDir } = fixture(t),
      path = join(assetDir, "0.png"),
      cache = createRawTextureCache({ assetDir }),
      originalFstat = fs.fstatSync;
    try {
      fs.fstatSync = (...args) => {
        const result = originalFstat(...args);
        if (change === "overstated")
          return { ...result, size: result.size + 1 };
        if (change === "growing") fs.appendFileSync(path, Buffer.from([0]));
        if (change === "shrinking") fs.truncateSync(path, result.size - 1);
        return result;
      };
      syncBuiltinESMExports();
      assert.throws(() => cache.assetsFor(["0.png"]), {
        code: "ERR_RAW_TEXTURE_BUDGET",
      });
    } finally {
      fs.fstatSync = originalFstat;
      syncBuiltinESMExports();
    }
    assert.equal(cache.stats.activeSnapshots, 0);
    assert.equal(cache.stats.liveEncodedBytes, 0);
    assert.equal(cache.stats.rawDecodes, 0);
    cache.dispose();
  }
});

test("per-file PNG limit is checked before opening or reading", (t) => {
  const { assetDir } = fixture(t),
    cache = createRawTextureCache({ assetDir }),
    originalStat = fs.statSync,
    originalOpen = fs.openSync;
  let opens = 0;
  try {
    fs.statSync = () => ({ size: 8 * 1024 * 1024 + 1 });
    fs.openSync = (...args) => {
      opens++;
      return originalOpen(...args);
    };
    syncBuiltinESMExports();
    const view = cache.assetsFor(["0.png"]);
    assert.equal(view.assets.size, 0);
    assert.match(cache.assetFailures["0.png"], /encoded size outside budget/);
    assert.equal(opens, 0);
    view.dispose();
  } finally {
    fs.statSync = originalStat;
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
    cache.dispose();
  }
});

test("default aggregate limits admit the complete bundled texture corpus", (t) => {
  assert.equal(RAW_TEXTURE_CACHE_LIMITS.activeEncodedBytes, 32 * 1024 * 1024);
  assert.equal(RAW_TEXTURE_CACHE_LIMITS.activeSnapshots, 512);
  const assetDir = fileURLToPath(
    new URL("../example/assets/", import.meta.url),
  );
  // The corpus is optional in source-only checkouts; synthetic limit tests above
  // remain unconditional and exercise the same admission path.
  if (!fs.existsSync(assetDir)) {
    t.skip("Bundled texture corpus is not present in this checkout");
    return;
  }
  const names = fs
      .readdirSync(assetDir)
      .filter((name) => name.endsWith(".png")),
    bytes = names.reduce(
      (total, name) => total + fs.statSync(join(assetDir, name)).size,
      0,
    ),
    cache = createRawTextureCache({ assetDir }),
    view = cache.assetsFor(names);
  assert.equal(view.assets.size, names.length);
  assert.equal(cache.stats.activeSnapshots, names.length);
  assert.equal(cache.stats.peakActiveSnapshots, names.length);
  assert.equal(cache.stats.activeEncodedBytes, bytes);
  assert.ok(bytes < RAW_TEXTURE_CACHE_LIMITS.activeEncodedBytes);
  assert.deepEqual(cache.assetFailures, {});
  view.dispose();
  cache.dispose();
});

test("raw retention counts scanline padding and bypasses buffers larger than its byte limit", (t) => {
  const { assetDir } = fixture(t);
  for (const maxRawBytes of [1024, 1039, 1040, 1041]) {
    const cache = createRawTextureCache({ assetDir, maxRawBytes });
    const first = cache.assetsFor(["0.png"]);
    assert.equal(cache.stats.rawBytes, maxRawBytes < 1040 ? 0 : 1040);
    const raw = textureSource(first.assets.get("0.png")).rawRgba;
    assert.equal(raw.data.byteLength, 1024);
    assert.equal(raw.data.buffer.byteLength, maxRawBytes < 1040 ? 1024 : 1040);
    assert.ok(cache.stats.rawBytes <= maxRawBytes);
    assert.ok(cache.stats.peakRawBytes <= maxRawBytes);
    first.dispose();
    cache.dispose();
    assert.equal(cache.stats.rawBytes, 0);
  }
});
