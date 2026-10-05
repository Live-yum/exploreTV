#!/usr/bin/env node
// Original, local-only importer. The manifest is metadata, not an artwork license.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { decodePngRgba, PNG_RGBA_LIMITS } from "../core/png-rgba.mjs";

const PROJECT = fileURLToPath(new URL("../", import.meta.url));
export const IMPORT_LIMITS = Object.freeze({
  manifestBytes: 256 * 1024,
  files: 256,
  totalBytes: 64 * 1024 * 1024,
});
const NAME = /^(?:Tiles_|Wall_|water_)(?:0|[1-9][0-9]{0,4})\.png$/;
const SHA256 = /^[a-f0-9]{64}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const USAGE = `Usage: node scripts/prepare-example.mjs <local-png-directory> [options]

Import only the PNGs pinned by example/asset-manifest.json.
Use legally obtained Terraria PNGs that you have permission to use locally.
Re-Logic artwork rights are separate from this project's code; this command
does not authorize redistribution and never downloads or uploads resources.

Options:
  --output <directory>    Destination (default: project/example-assets)
  --manifest <file>       Alternate bounded manifest for your own assets/tests
  --check                Validate all source assets without writing anything
  --help                 Show this help

Supports flat directories and TConvert Images/ and Images/Misc/ layouts.
Every required file must match its size, SHA-256, dimensions and RGBA8 decode.
Existing identical output files are kept; conflicts and symlinks are rejected.
The input directory and output directory must not contain one another.
`;

function statIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function boundedRead(path, limit, expectedSize) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Expected a regular file, not a symlink: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = fstatSync(fd);
    if (
      !current.isFile() ||
      current.size < 1 ||
      current.size > limit ||
      (expectedSize !== undefined && current.size !== expectedSize)
    )
      throw new Error(`File size is outside the expected bound: ${path}`);
    // A capped read also rejects a file that grows after fstat, without reading
    // an unbounded stream into memory.
    const bytes = Buffer.alloc(current.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== current.size)
      throw new Error(`File changed while being read: ${path}`);
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

export function readManifest(path) {
  const manifest = JSON.parse(
    boundedRead(path, IMPORT_LIMITS.manifestBytes).toString("utf8"),
  );
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.inputEncoding !== "tconvert-game-raw" ||
    !Array.isArray(manifest.textures) ||
    !manifest.textures.length ||
    manifest.textures.length > IMPORT_LIMITS.files
  )
    throw new Error("Invalid manifest schema, encoding, or texture count");
  const names = new Set();
  let totalBytes = 0;
  for (const entry of manifest.textures) {
    if (
      !entry ||
      typeof entry.file !== "string" ||
      !NAME.test(entry.file) ||
      names.has(entry.file) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 33 ||
      entry.bytes > PNG_RGBA_LIMITS.encodedBytes ||
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256) ||
      !Number.isSafeInteger(entry.width) ||
      !Number.isSafeInteger(entry.height) ||
      entry.width < 1 ||
      entry.height < 1 ||
      entry.width > PNG_RGBA_LIMITS.dimension ||
      entry.height > PNG_RGBA_LIMITS.dimension ||
      entry.width * entry.height * 4 > PNG_RGBA_LIMITS.decodedBytes
    )
      throw new Error("Invalid or duplicate texture entry in manifest");
    names.add(entry.file);
    totalBytes += entry.bytes;
  }
  if (totalBytes > IMPORT_LIMITS.totalBytes)
    throw new Error(
      "Manifest aggregate texture size exceeds the 64 MiB budget",
    );
  return { manifest, totalBytes };
}

function sourceCandidate(root, parts) {
  let path = root;
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]);
    const stat = statIfPresent(path);
    if (!stat) return null;
    if (stat.isSymbolicLink())
      throw new Error(`Symlink is not allowed inside the source: ${path}`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
      throw new Error(`Unexpected source file type: ${path}`);
  }
  return path;
}

function locateSource(root, file) {
  const candidates = [[file], ["Images", file]];
  if (file.startsWith("water_"))
    candidates.push(["Misc", file], ["Images", "Misc", file]);
  const found = candidates
    .map((parts) => sourceCandidate(root, parts))
    .filter(Boolean);
  if (!found.length) throw new Error(`Missing required texture: ${file}`);
  if (found.length > 1)
    throw new Error(`Ambiguous source locations for ${file}; use one layout`);
  return found[0];
}

// Resolve existing ancestors before testing overlap. Reject symlink output
// components so writing cannot silently redirect to a different destination.
function canonicalOutput(path) {
  let cursor = resolve(path);
  const missing = [];
  while (!statIfPresent(cursor)) {
    missing.unshift(basename(cursor));
    cursor = dirname(cursor);
  }
  let existing = cursor;
  while (true) {
    const stat = lstatSync(existing);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(
        `Output ancestors must be directories, not symlinks: ${existing}`,
      );
    if (dirname(existing) === existing) break;
    existing = dirname(existing);
  }
  return join(realpathSync(cursor), ...missing);
}

function contains(parent, child) {
  const path = relative(parent, child);
  return (
    !path ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

export function prepareExample({
  source,
  output = join(PROJECT, "example-assets"),
  manifest: manifestPath = join(PROJECT, "example", "asset-manifest.json"),
  check = false,
}) {
  if (!source) throw new Error("A local PNG source directory is required");
  const { manifest, totalBytes } = readManifest(resolve(manifestPath));
  const root = realpathSync(resolve(source));
  if (!lstatSync(root).isDirectory())
    throw new Error("The PNG source must be a directory");
  const destination = canonicalOutput(output);
  if (contains(root, destination) || contains(destination, root))
    throw new Error(
      "Source and output must be separate, non-overlapping directories",
    );

  // Validate the entire input and all destination conflicts before creating any
  // output. Retained encoded bytes are capped at 64 MiB by the manifest.
  const selected = [];
  for (const entry of manifest.textures) {
    const input = locateSource(root, entry.file);
    const bytes = boundedRead(input, PNG_RGBA_LIMITS.encodedBytes, entry.bytes);
    if (hash(bytes) !== entry.sha256)
      throw new Error(`SHA-256 mismatch: ${entry.file}`);
    const decoded = decodePngRgba(bytes);
    if (decoded.width !== entry.width || decoded.height !== entry.height)
      throw new Error(`PNG dimensions differ from manifest: ${entry.file}`);
    const target = join(destination, entry.file);
    const existing = statIfPresent(target);
    let keep = false;
    if (existing) {
      const previous = boundedRead(
        target,
        PNG_RGBA_LIMITS.encodedBytes,
        entry.bytes,
      );
      if (hash(previous) !== entry.sha256)
        throw new Error(
          `Existing output differs; nothing will be overwritten: ${entry.file}`,
        );
      keep = true;
    }
    selected.push({ bytes, target, keep });
  }

  let copied = 0;
  if (!check) {
    mkdirSync(destination, { recursive: true });
    if (canonicalOutput(destination) !== destination)
      throw new Error("Output directory changed during validation");
    for (const item of selected) {
      if (item.keep) continue;
      // Exclusive creation never truncates an existing file, even if one was
      // added after validation. No cleanup deletes user files on failure.
      writeFileSync(item.target, item.bytes, { flag: "wx" });
      copied++;
    }
  }
  return {
    status: check ? "verified" : "prepared",
    files: selected.length,
    totalBytes,
    copied,
    kept: selected.filter((item) => item.keep).length,
    inputEncoding: manifest.inputEncoding,
    output: destination,
  };
}

function main(args) {
  if (args.includes("--help")) {
    if (args.length !== 1)
      throw new Error("--help cannot be combined with other arguments");
    console.log(USAGE);
    return;
  }
  const options = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--check") {
      if (seen.has(arg)) throw new Error(`Repeated option: ${arg}`);
      seen.add(arg);
      options.check = true;
    } else if (arg === "--output" || arg === "--manifest") {
      if (seen.has(arg)) throw new Error(`Repeated option: ${arg}`);
      seen.add(arg);
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith("-") || options.source) {
      throw new Error(`Unexpected argument: ${arg}`);
    } else options.source = arg;
  }
  if (!options.source) throw new Error(USAGE);
  console.log(JSON.stringify(prepareExample(options), null, 2));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`prepare-example: ${error.message}`);
    process.exitCode = 1;
  }
}
