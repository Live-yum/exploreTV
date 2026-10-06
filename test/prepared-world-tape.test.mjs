import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";
import {
  clearOpaque,
  composeInto,
  nativeBlitterStatus,
} from "../scripts/native-blitter.mjs";
import {
  boxDownsampleRgbaNative,
  nativeReducerStatus,
} from "../scripts/native-reducer.mjs";
import {
  createWorldTapeRecorder,
  readWorldTapeManifest,
  replayWorldTapeChunks,
  WORLD_TAPE_LIMITS,
} from "../scripts/prepared-world-tape.mjs";
import { createSoftwareOverview } from "../scripts/software-overview.mjs";
import {
  createSceneFrameCache,
  prepareSceneFrames,
  sceneFrameKey,
} from "../core/scene-frames.mjs";
import { registerTextureSource } from "../core/assets.mjs";

const hash = (data) => createHash("sha256").update(data).digest("hex");
const native = nativeBlitterStatus.available && nativeReducerStatus.available;
const options = { requireNative: false };
const report = {
  world: { sha256: "1".repeat(64), width: 4, height: 2, version: 326 },
  worldRect: { x: 0, y: 0, width: 4, height: 2 },
  bandTiles: 1,
  assets: { sample: "2".repeat(64) },
  sources: { renderer: "3".repeat(64) },
};
function pixelFrame(rgba, side = 16) {
  const frame = new Uint8Array(side * side * 4);
  for (let i = 0; i < frame.length; i += 4) frame.set(rgba, i);
  return frame;
}
function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), "exploretv-world-tape-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function rendered(descriptors, sources, width = 32, height = 16) {
  const pixels = new Uint8Array(width * height * 4);
  clearOpaque(pixels);
  composeInto(pixels, width, height, descriptors, sources);
  return { pixels, data: boxDownsampleRgbaNative(pixels, width, height, 16) };
}
async function replay(directory, opts = {}) {
  const result = [];
  for await (const chunk of replayWorldTapeChunks(directory, {
    ...options,
    ...opts,
  }))
    result.push(chunk);
  return result;
}
function smallTape(directory, extra = {}) {
  const recorder = createWorldTapeRecorder(directory, { ...options, ...extra }),
    sources = [pixelFrame([60, 20, 10, 128]), pixelFrame([0, 30, 0, 0])],
    descriptors = Int32Array.from([
      0, 16, 16, 0, 0, 0, 0, 0, 1, 16, 16, 8, 0, 1, 0, 1,
    ]),
    { pixels, data } = rendered(descriptors, sources);
  recorder.beginChunk({ x: 0, y: 0, width: 2, height: 1 });
  recorder.recordBatch({ descriptors, sources, width: 32, height: 16 });
  recorder.endChunk(data, pixels);
  const manifest = recorder.finalize(report);
  return { recorder, manifest, data };
}
function rewriteManifest(directory, manifest) {
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
}
function rewriteCommands(directory, transform) {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"))),
    file = readFileSync(join(directory, "commands.bin")),
    changed = transform(file, manifest);
  manifest.chunks[0].length = changed.length;
  manifest.chunks[0].sha256 = hash(changed);
  manifest.files.commands.bytes = changed.length;
  manifest.files.commands.sha256 = hash(changed);
  writeFileSync(join(directory, "commands.bin"), changed);
  rewriteManifest(directory, manifest);
}
function mutateFirstCommand(directory, change) {
  rewriteCommands(directory, (encoded) => {
    const compressedLength = encoded.readUInt32LE(8),
      raw = inflateRawSync(encoded.subarray(48, 48 + compressedLength));
    change(raw);
    const compressed = deflateRawSync(raw),
      header = Buffer.from(encoded.subarray(0, 48));
    header.writeUInt32LE(compressed.length, 8);
    Buffer.from(hash(raw), "hex").copy(header, 16);
    return Buffer.concat([
      header,
      compressed,
      encoded.subarray(48 + compressedLength),
    ]);
  });
}

test("prepared tape replays native layers plus exact sparse overrides and empty native cores", async (t) => {
  const directory = workspace(t),
    recorder = createWorldTapeRecorder(directory, options),
    first = pixelFrame([70, 20, 5, 128]),
    sources = [first, pixelFrame([0, 40, 0, 0]), Uint8Array.from(first)],
    descriptors = Int32Array.from([
      0, 16, 16, 0, 0, 0, 0, 0, 1, 16, 16, 8, 0, 1, 0, 1, 2, 16, 16, 16, 0, 0,
      1, 0,
    ]),
    { pixels, data } = rendered(descriptors, sources);
  data.set([230, 40, 20, 255], 4);
  recorder.beginChunk({ x: 0, y: 0, width: 2, height: 1 });
  recorder.recordBatch({ descriptors, sources, width: 32, height: 16 });
  recorder.endChunk(data, pixels);
  const second = Uint8Array.of(0, 0, 0, 255, 4, 5, 6, 255);
  recorder.beginChunk({ x: 0, y: 1, width: 2, height: 1 });
  recorder.endChunk(second, null);
  assert.equal(existsSync(join(directory, "manifest.json")), false);
  const manifest = recorder.finalize(report);
  assert.equal(manifest.frames.length, 2);
  assert.equal(manifest.chunks.length, 2);
  assert.equal(recorder.stats.deduplicatedFrames, 1);
  assert.equal(recorder.stats.overrides, 2);
  assert.deepEqual(readWorldTapeManifest(directory).report, report);
  const output = await replay(directory);
  assert.deepEqual(output[0].data, data);
  assert.deepEqual([...output[1].data], [...second]);
  assert.equal(output[0].stats.commands, 3);
  assert.equal(output[0].stats.chunks, 2);
  recorder.abort();
  assert.ok(existsSync(join(directory, "manifest.json")));
});

test("native record sources and descriptors are copied before the recording callback returns", async (t) => {
  const directory = workspace(t),
    recorder = createWorldTapeRecorder(directory, options),
    sources = [pixelFrame([10, 20, 30, 255])],
    descriptors = Int32Array.from([0, 16, 16, 0, 0, 0, 0, 0]),
    { pixels, data } = rendered(descriptors, sources, 16, 16);
  recorder.beginChunk({ x: 0, y: 0, width: 1, height: 1 });
  recorder.recordBatch({ descriptors, sources, width: 16, height: 16 });
  descriptors.fill(0);
  sources[0].fill(0);
  recorder.endChunk(data, pixels);
  recorder.finalize(report);
  assert.deepEqual((await replay(directory))[0].data, data);
});

test("frame LRU includes pinned batch sources and flushes before its byte cap", async (t) => {
  const directory = workspace(t),
    recorder = createWorldTapeRecorder(directory, options),
    sources = [
      pixelFrame([50, 0, 0, 128]),
      pixelFrame([0, 80, 0, 128]),
      pixelFrame([0, 0, 90, 128]),
    ],
    descriptors = Int32Array.from([
      0, 16, 16, 0, 0, 0, 0, 0, 1, 16, 16, 0, 0, 1, 0, 0, 2, 16, 16, 0, 0, 0, 1,
      0, 0, 16, 16, 0, 0, 0, 0, 0,
    ]),
    { pixels, data } = rendered(descriptors, sources, 16, 16);
  recorder.beginChunk({ x: 0, y: 0, width: 1, height: 1 });
  recorder.recordBatch({ descriptors, sources, width: 16, height: 16 });
  recorder.endChunk(data, pixels);
  recorder.finalize(report);
  const [chunk] = await replay(directory, { maxFrameBytes: 1024 });
  assert.deepEqual(chunk.data, data);
  assert.equal(chunk.stats.nativeBatches, 4);
  assert.ok(chunk.stats.peakFrameBytes <= 1024);
  assert.ok(chunk.stats.peakActiveFrameBytes <= 1024);
});

test("recording enforces byte, frame-index, chunk and lifecycle budgets without deleting unrelated output", (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, "preview.png"), "unrelated preview");
  const recorder = createWorldTapeRecorder(directory, {
    ...options,
    maxFrames: 1,
  });
  recorder.beginChunk({ x: 0, y: 0, width: 1, height: 1 });
  assert.throws(
    () =>
      recorder.recordBatch({
        descriptors: Int32Array.from([
          0, 16, 16, 0, 0, 0, 0, 0, 1, 16, 16, 0, 0, 0, 0, 0,
        ]),
        sources: [pixelFrame([10, 0, 0, 255]), pixelFrame([20, 0, 0, 255])],
        width: 16,
        height: 16,
      }),
    /frame index/,
  );
  assert.equal(
    readFileSync(join(directory, "preview.png"), "utf8"),
    "unrelated preview",
  );
  assert.equal(existsSync(join(directory, "frames.bin")), false);
  assert.throws(() => recorder.finalize(report), /closed/);
  const unfinished = createWorldTapeRecorder(directory, options);
  unfinished.beginChunk({ x: 0, y: 0, width: 1, height: 1 });
  assert.throws(() => unfinished.finalize(report), /unfinished/);
  assert.equal(existsSync(join(directory, "manifest.json")), false);
  const tiny = createWorldTapeRecorder(directory, {
    ...options,
    maxTotalBytes: 1,
  });
  tiny.beginChunk({ x: 0, y: 0, width: 1, height: 1 });
  assert.throws(() => tiny.endChunk(Uint8Array.of(1, 2, 3, 255)), /total byte/);
});

test("manifest bounds and full payload hashes reject stale offsets, truncation and corrupt bytes", async (t) => {
  const directory = workspace(t),
    { manifest } = smallTape(directory),
    framesPath = join(directory, "frames.bin"),
    original = readFileSync(framesPath);
  const corrupted = Buffer.from(original);
  corrupted[0] ^= 32;
  writeFileSync(framesPath, corrupted);
  assert.throws(() => readWorldTapeManifest(directory), /hash mismatch/);
  writeFileSync(framesPath, original.subarray(1));
  assert.throws(() => readWorldTapeManifest(directory), /size/);
  writeFileSync(framesPath, original);
  manifest.frames[0].offset = 1;
  rewriteManifest(directory, manifest);
  assert.throws(() => readWorldTapeManifest(directory), /offset/);
  manifest.frames[0].offset = 0;
  manifest.chunks[0].core.width = 512;
  manifest.chunks[0].core.height = 512;
  rewriteManifest(directory, manifest);
  await assert.rejects(() => replay(directory), /chunk byte budget/);
});

test("record-level hashes, decompression limits and exact deflate boundaries are independently checked", async (t) => {
  const directory = workspace(t);
  smallTape(directory);
  rewriteCommands(directory, (encoded) => {
    const changed = Buffer.from(encoded);
    changed[16] ^= 1;
    return changed;
  });
  await assert.rejects(() => replay(directory), /record hash/);
  const second = workspace(t);
  smallTape(second);
  rewriteCommands(second, (encoded) => {
    const changed = Buffer.from(encoded);
    changed.writeUInt32LE(WORLD_TAPE_LIMITS.maxChunkBytes + 1, 4);
    return changed;
  });
  await assert.rejects(() => replay(second), /record header/);
  const third = workspace(t);
  smallTape(third);
  rewriteCommands(third, (encoded) => {
    const n = encoded.readUInt32LE(8),
      header = Buffer.from(encoded.subarray(0, 48));
    header.writeUInt32LE(n + 1, 8);
    return Buffer.concat([
      header,
      encoded.subarray(48, 48 + n),
      Buffer.of(0),
      encoded.subarray(48 + n),
    ]);
  });
  await assert.rejects(() => replay(third), /deflate boundary/);
});

test("well-hashed malformed descriptors and altered pixels still fail replay", async (t) => {
  const directory = workspace(t);
  smallTape(directory);
  mutateFirstCommand(directory, (raw) => raw.writeInt32LE(32767, 0));
  await assert.rejects(() => replay(directory), /command frame/);
  const second = workspace(t);
  smallTape(second);
  mutateFirstCommand(second, (raw) => raw.writeInt32LE(16, 12));
  await assert.rejects(() => replay(second), /prepared reference/);
});

test("well-hashed override tampering is rejected by the prepared RGBA identity", async (t) => {
  const directory = workspace(t),
    recorder = createWorldTapeRecorder(directory, options);
  recorder.beginChunk({ x: 0, y: 0, width: 1, height: 1 });
  recorder.endChunk(Uint8Array.of(30, 40, 50, 255));
  recorder.finalize(report);
  rewriteCommands(directory, (encoded) => {
    const raw = inflateRawSync(encoded.subarray(48));
    raw[4] ^= 32;
    const compressed = deflateRawSync(raw),
      header = Buffer.from(encoded.subarray(0, 48));
    header.writeUInt32LE(compressed.length, 8);
    Buffer.from(hash(raw), "hex").copy(header, 16);
    return Buffer.concat([header, compressed]);
  });
  await assert.rejects(() => replay(directory), /prepared reference/);
});

test("seeded clipped destinations, pattern flips and additive batches retain command order", async (t) => {
  const directory = workspace(t),
    recorder = createWorldTapeRecorder(directory, options);
  let seed = 0x19be1;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const sources = Array.from({ length: 5 }, () => {
    const frame = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < frame.length; i += 4) {
      const alpha = 1 + random(255);
      frame.set(
        [random(alpha + 1), random(alpha + 1), random(alpha + 1), alpha],
        i,
      );
    }
    return frame;
  });
  for (let chunk = 0; chunk < 3; chunk++) {
    const descriptors = new Int32Array(120 * 8);
    for (let i = 0; i < descriptors.length; i += 8)
      descriptors.set(
        [
          random(sources.length),
          16,
          16,
          random(56) - 16,
          random(40) - 16,
          random(2),
          random(2),
          random(2),
        ],
        i,
      );
    const { pixels, data } = rendered(descriptors, sources, 32, 16);
    recorder.beginChunk({ x: chunk * 2, y: 0, width: 2, height: 1 });
    recorder.recordBatch({
      descriptors: descriptors.subarray(0, 60 * 8),
      sources,
      width: 32,
      height: 16,
    });
    recorder.recordBatch({
      descriptors: descriptors.subarray(60 * 8),
      sources,
      width: 32,
      height: 16,
    });
    recorder.endChunk(data, pixels);
  }
  recorder.finalize(report);
  const chunks = await replay(directory, { maxFrameBytes: 2048 });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].stats.commands, 360);
  assert.ok(chunks[0].stats.nativeBatches > 6);
  assert.ok(chunks[0].stats.peakFrameBytes <= 2048);
});

test(
  "software overview records only opt-in completed native batches",
  { skip: !native },
  async (t) => {
    const directory = workspace(t),
      recorder = createWorldTapeRecorder(directory),
      source = createCanvas(16, 16),
      image = source.getContext("2d").createImageData(16, 16);
    image.data.set(pixelFrame([40, 70, 20, 128]));
    source.getContext("2d").putImageData(image, 0, 0);
    registerTextureSource(source, {
      pngBytes: new Uint8Array(),
      rawRgba: { width: 16, height: 16, data: image.data },
    });
    const c = {
        asset: "sample",
        kind: "tile",
        type: 1,
        sx: 0,
        sy: 0,
        sw: 16,
        sh: 16,
        dx: 0,
        dy: 0,
        dw: 16,
        dh: 16,
        paintId: 0,
      },
      plan = { width: 16, height: 16, commands: [c], warnings: [] },
      core = { x: 0, y: 0, width: 1, height: 1 },
      assets = new Map([["sample", source]]),
      keyCache = new Map([[c, sceneFrameKey(c)]]),
      overview = createSoftwareOverview({
        onNativeBatch: recorder.recordBatch,
      }),
      frameCache = createSceneFrameCache();
    recorder.beginChunk(core);
    const view = overview.begin(plan, core, { rect: core }, assets, keyCache),
      commands = view.preparationCommands(plan.commands),
      prepared = prepareSceneFrames(
        { ...plan, commands },
        assets,
        createCanvas,
        {
          inputEncoding: "tconvert-game-raw",
          opaqueScene: true,
          frameCache,
          keyCache,
        },
      );
    assert.deepEqual(view.drawBatch(plan.commands, prepared), []);
    const data = boxDownsampleRgbaNative(view.pixels, 16, 16, 16);
    recorder.endChunk(data, view.pixels);
    view.finish();
    prepared.dispose();
    frameCache.dispose();
    overview.dispose();
    recorder.finalize(report);
    assert.deepEqual(
      (await replay(directory, { requireNative: true }))[0].data,
      data,
    );
    assert.equal(recorder.stats.commands, 1);
  },
);
