import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import { prepareExample, readManifest } from "../scripts/prepare-example.mjs";

const CLI = fileURLToPath(
  new URL("../scripts/prepare-example.mjs", import.meta.url),
);
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "exploretv-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  const pixels = Buffer.from([
    255, 7, 63, 0, 37, 90, 12, 1, 77, 32, 250, 127, 9, 150, 240, 255,
  ]);
  const bytes = PNG.sync.write(
    { width: 2, height: 2, data: pixels },
    { colorType: 6, inputColorType: 6, bitDepth: 8 },
  );
  const entries = ["Tiles_0.png", "water_0.png"].map((file) => ({
    file,
    bytes: bytes.length,
    sha256: checksum(bytes),
    width: 2,
    height: 2,
  }));
  const manifest = join(root, "manifest.json");
  const data = {
    schemaVersion: 1,
    inputEncoding: "tconvert-game-raw",
    textures: entries,
  };
  const save = () => writeFileSync(manifest, JSON.stringify(data));
  save();
  return {
    root,
    source,
    output: join(root, "output"),
    manifest,
    data,
    save,
    bytes,
  };
}

function writeFlat(f) {
  for (const entry of f.data.textures)
    writeFileSync(join(f.source, entry.file), f.bytes);
}

function run(f, ...options) {
  return spawnSync(
    process.execPath,
    [CLI, f.source, "--manifest", f.manifest, "--output", f.output, ...options],
    { encoding: "utf8", timeout: 20000 },
  );
}

test("CLI selects only pinned PNGs from Images/Misc and is repeatable without overwrites", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.source, "Images", "Misc"), { recursive: true });
  writeFileSync(join(f.source, "Images", "Tiles_0.png"), f.bytes);
  writeFileSync(join(f.source, "Images", "Misc", "water_0.png"), f.bytes);
  writeFileSync(
    join(f.source, "Images", "Tiles_999.png"),
    "not a PNG, never selected",
  );
  writeFileSync(join(f.source, "unrelated.txt"), "do not copy");
  mkdirSync(f.output);
  writeFileSync(join(f.output, "keep.txt"), "unrelated output");
  const first = run(f);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).copied, 2);
  assert.deepEqual(readdirSync(f.output).sort(), [
    "Tiles_0.png",
    "keep.txt",
    "water_0.png",
  ]);
  assert.deepEqual(readFileSync(join(f.output, "water_0.png")), f.bytes);
  const second = run(f);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).copied, 0);
  assert.equal(JSON.parse(second.stdout).kept, 2);
  assert.equal(
    readFileSync(join(f.output, "keep.txt"), "utf8"),
    "unrelated output",
  );
  assert.deepEqual(
    readFileSync(join(f.source, "Images", "Tiles_0.png")),
    f.bytes,
  );
});

test("--check validates a flat directory without creating output", (t) => {
  const f = fixture(t);
  writeFlat(f);
  const result = run(f, "--check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "verified");
  assert.equal(existsSync(f.output), false);
});

test("missing required input fails before copying earlier valid inputs", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, "Tiles_0.png"), f.bytes);
  assert.throws(
    () => prepareExample(f),
    /Missing required texture: water_0\.png/,
  );
  assert.equal(existsSync(f.output), false);
});

test("hash, byte size, and manifest dimensions must all match", (t) => {
  const f = fixture(t);
  writeFlat(f);
  f.data.textures[1].sha256 = "0".repeat(64);
  f.save();
  assert.throws(() => prepareExample(f), /SHA-256 mismatch: water_0/);
  f.data.textures[1].sha256 = checksum(f.bytes);
  f.data.textures[1].bytes++;
  f.save();
  assert.throws(() => prepareExample(f), /File size is outside/);
  f.data.textures[1].bytes--;
  f.data.textures[1].width = 3;
  f.save();
  assert.throws(() => prepareExample(f), /PNG dimensions differ/);
  assert.equal(existsSync(f.output), false);
});

test("a checksum-pinned malformed PNG still fails the bounded decoder", (t) => {
  const f = fixture(t);
  writeFlat(f);
  const corrupt = Buffer.from(f.bytes);
  corrupt[corrupt.length - 1] ^= 1; // Invalid IEND CRC, with a matching manifest hash.
  writeFileSync(join(f.source, "water_0.png"), corrupt);
  f.data.textures[1].sha256 = checksum(corrupt);
  f.save();
  assert.throws(() => prepareExample(f), /PNG:/);
  assert.equal(existsSync(f.output), false);
});

test("conflicting output blocks the entire import and preserves unrelated data", (t) => {
  const f = fixture(t);
  writeFlat(f);
  mkdirSync(f.output);
  const conflict = Buffer.from(f.bytes);
  conflict[40] ^= 1;
  writeFileSync(join(f.output, "water_0.png"), conflict);
  writeFileSync(join(f.output, "keep.txt"), "keep me");
  assert.throws(() => prepareExample(f), /Existing output differs/);
  assert.equal(existsSync(join(f.output, "Tiles_0.png")), false);
  assert.deepEqual(readFileSync(join(f.output, "water_0.png")), conflict);
  assert.equal(readFileSync(join(f.output, "keep.txt"), "utf8"), "keep me");
});

test("manifest names cannot traverse paths and entries, counts, and bytes are bounded", (t) => {
  const f = fixture(t);
  const base = { ...f.data.textures[0] };
  const invalidLists = [
    [{ ...base, file: "../Tiles_0.png" }],
    [{ ...base, file: "Images/Tiles_0.png" }],
    [base, base],
    [{ ...base, sha256: "invalid" }],
    [{ ...base, bytes: 8 * 1024 * 1024 + 1 }],
    [{ ...base, width: 4097 }],
    [{ ...base, width: 4096, height: 4096 }],
    Array.from({ length: 513 }, (_, i) => ({
      ...base,
      file: `Tiles_${i}.png`,
    })),
    Array.from({ length: 9 }, (_, i) => ({
      ...base,
      file: `Tiles_${i}.png`,
      bytes: 8 * 1024 * 1024,
    })),
  ];
  for (const textures of invalidLists) {
    f.data.textures = textures;
    f.save();
    assert.throws(() => readManifest(f.manifest), /manifest|Manifest/);
  }
  writeFileSync(f.manifest, " ".repeat(256 * 1024 + 1));
  assert.throws(() => readManifest(f.manifest), /File size is outside/);
  assert.equal(existsSync(f.output), false);
});

test("source and output cannot overlap, including nonexistent descendants", (t) => {
  const f = fixture(t);
  writeFlat(f);
  for (const output of [f.source, join(f.source, "new", "output"), f.root])
    assert.throws(() => prepareExample({ ...f, output }), /non-overlapping/);
  assert.equal(existsSync(join(f.source, "new")), false);
});

test("symlinks inside source or destination are not followed", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, "Tiles_0.png"), f.bytes);
  const elsewhere = join(f.root, "elsewhere.png");
  writeFileSync(elsewhere, f.bytes);
  symlinkSync(elsewhere, join(f.source, "water_0.png"));
  assert.throws(() => prepareExample(f), /Symlink/);
  rmSync(join(f.source, "water_0.png"));
  writeFileSync(join(f.source, "water_0.png"), f.bytes);
  mkdirSync(f.output);
  symlinkSync(elsewhere, join(f.output, "water_0.png"));
  assert.throws(() => prepareExample(f), /symlink/);
  assert.equal(existsSync(join(f.output, "Tiles_0.png")), false);
  const linked = join(f.root, "linked-output");
  symlinkSync(f.output, linked, "dir");
  assert.throws(
    () => prepareExample({ ...f, output: join(linked, "nested") }),
    /symlinks/,
  );
  assert.deepEqual(readFileSync(elsewhere), f.bytes);
});

test("ambiguous layouts fail instead of silently choosing a different texture", (t) => {
  const f = fixture(t);
  writeFlat(f);
  mkdirSync(join(f.source, "Images"));
  writeFileSync(join(f.source, "Images", "Tiles_0.png"), f.bytes);
  assert.throws(() => prepareExample(f), /Ambiguous source locations/);
  assert.equal(existsSync(f.output), false);
});

test("CLI help needs no input and malformed options fail", () => {
  const help = spawnSync(process.execPath, [CLI, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /never downloads or uploads/);
  for (const args of [
    [],
    ["--download"],
    ["--output"],
    ["x", "--check", "--check"],
  ]) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /prepare-example:/);
  }
});

test("the checked-in example manifest pins all 342 selected resources without requiring private inputs", () => {
  const { manifest, totalBytes } = readManifest(
    fileURLToPath(new URL("../example/asset-manifest.json", import.meta.url)),
  );
  assert.equal(manifest.textures.length, 342);
  assert.equal(totalBytes, 3857015);
  assert.equal(manifest.sourceProvenance.exporter, "TConvert");
  assert.equal(manifest.sourceProvenance.gameVersion, "1.4.5.8");
  assert.deepEqual(
    manifest.textures
      .filter((e) => e.file.startsWith("water_"))
      .map((e) => e.file),
    ["water_0.png", "water_1.png", "water_11.png"],
  );
});
