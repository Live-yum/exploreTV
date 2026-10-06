import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { createRequire } from "node:module";

export const OVERVIEW_FRAME_PACK_SCHEMA = "exploretv-overview-frame-pack-v1";
export const OVERVIEW_FRAME_PACK_BAKE_VERSION = 1;
export const OVERVIEW_FRAME_PACK_RECORD_BYTES = 32;
export const OVERVIEW_FRAME_PACK_LIMITS = Object.freeze({
  manifestBytes: 2 * 1024 * 1024,
  frames: 131072,
  sources: 512,
  pageBytes: 256 * 1024,
  pages: 4096,
  pixelBytes: 256 * 1024 * 1024,
});
export const OVERVIEW_FRAME_PACK_RULE_PATHS = Object.freeze([
  "core/overview-frame-recipes.mjs",
  "core/assets.mjs",
  "core/png-rgba.mjs",
  "core/paint.mjs",
  "core/scene-frames.mjs",
  "core/static-blocks.mjs",
  "core/liquid-shimmer.mjs",
  "scripts/raw-overview-frame.mjs",
  "scripts/direct-slope-overview-frame.mjs",
  "scripts/slope-overview-frame.mjs",
  "scripts/native-blitter.mjs",
  "scripts/native-blitter.c",
  "scripts/png-rgba-node.mjs",
  "scripts/overview-frame-pack-format.mjs",
  "scripts/build-overview-frame-pack.mjs",
  "package-lock.json",
]);
export const overviewFramePackSha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function overviewFramePackRuleHashes() {
  return Object.fromEntries(
    OVERVIEW_FRAME_PACK_RULE_PATHS.map((path) => [
      path,
      overviewFramePackSha256(
        readFileSync(new URL(`../${path}`, import.meta.url)),
      ),
    ]),
  );
}
export function overviewFramePackBaker() {
  const require = createRequire(import.meta.url);
  return {
    canvasVersion: require("@napi-rs/canvas/package.json").version,
    platform: process.platform,
    arch: process.arch,
  };
}

/** Exact, unpooled backing. A changed file cannot escape the checked byte cap. */
export function readOverviewFramePackFile(path, limit, expectedBytes = null) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > limit ||
      (expectedBytes !== null && size !== expectedBytes)
    )
      throw new Error("Overview frame pack file size outside contract");
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, null);
      if (!count) throw new Error("Overview frame pack file is truncated");
      offset += count;
    }
    if (readSync(fd, new Uint8Array(1), 0, 1, null))
      throw new Error("Overview frame pack file changed while reading");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
