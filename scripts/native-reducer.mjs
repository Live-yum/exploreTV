import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { boxDownsampleRgba } from "./downsample-rgba.mjs";

const require = createRequire(import.meta.url);
const sourcePath = fileURLToPath(
  new URL("./native-reducer.c", import.meta.url),
);
const addonPath = fileURLToPath(
  new URL(
    `../artifacts/native/native-reducer-${process.platform}-${process.arch}.node`,
    import.meta.url,
  ),
);
let addon = null;
let reason = null;
let sourceSha256 = null;
let binarySha256 = null;
let build = null;
try {
  if (process.env.EXPLORETV_DISABLE_NATIVE_REDUCER === "1")
    throw new Error("disabled by EXPLORETV_DISABLE_NATIVE_REDUCER");
  const receipt = JSON.parse(readFileSync(addonPath + ".json", "utf8"));
  sourceSha256 = createHash("sha256")
    .update(readFileSync(sourcePath))
    .digest("hex");
  if (
    receipt.version !== 2 ||
    receipt.sourceSha256 !== sourceSha256 ||
    receipt.platform !== process.platform ||
    receipt.arch !== process.arch
  )
    throw new Error(
      "native reducer build is stale; run native-reducer-build.mjs",
    );
  binarySha256 = createHash("sha256")
    .update(readFileSync(addonPath))
    .digest("hex");
  if (receipt.binarySha256 !== binarySha256)
    throw new Error(
      "native reducer binary hash differs from its build receipt",
    );
  addon = require(addonPath);
  if (
    typeof addon?.downsampleRgba !== "function" ||
    typeof addon?.trimNativeMemory !== "function" ||
    typeof addon?.nativeMemoryTrimAvailable !== "boolean"
  )
    throw new Error("native reducer export is missing");
  build = Object.freeze({
    napiVersion: receipt.napiVersion,
    compiler: receipt.compiler,
    flags: Object.freeze([...receipt.flags]),
  });
} catch (error) {
  addon = null;
  reason =
    error.code === "ENOENT" ? "native reducer is not prepared" : error.message;
}

const trimDisabled = process.env.EXPLORETV_DISABLE_NATIVE_TRIM === "1";
const trimAvailable =
  !trimDisabled && addon !== null && addon.nativeMemoryTrimAvailable;
const trimStatus = Object.freeze({
  available: trimAvailable,
  backend: trimAvailable ? "glibc-malloc-trim" : "none",
  reason: trimDisabled
    ? "disabled by EXPLORETV_DISABLE_NATIVE_TRIM"
    : !addon
      ? reason
      : !addon.nativeMemoryTrimAvailable
        ? "malloc_trim is unavailable on this platform or allocator"
        : null,
});

export const nativeReducerStatus = Object.freeze({
  available: addon !== null,
  backend: addon ? "node-api" : "javascript",
  sourceSha256: addon ? sourceSha256 : null,
  binarySha256: addon ? binarySha256 : null,
  build: addon ? build : null,
  nativeMemoryTrim: trimStatus,
  reason,
});

const trimUnavailable = Object.freeze({ available: false, released: false });
const trimNoRelease = Object.freeze({ available: true, released: false });
const trimReleased = Object.freeze({ available: true, released: true });

/**
 * Ask glibc to return already-free allocator pages to the OS. This synchronous
 * process-wide operation does not collect JS objects or free live buffers.
 * The caller chooses when to invoke it, preferably after GC and a macrotask
 * that lets native finalizers run. Repeated calls can trade memory for time.
 *
 * `released` reports malloc_trim's result, not a byte count or an RSS guarantee.
 * A missing addon, unsupported platform/allocator, or import-time environment
 * setting EXPLORETV_DISABLE_NATIVE_TRIM=1 makes this a safe no-op. Disabling trim
 * leaves the numerical native reducer available.
 */
export function trimNativeMemory() {
  if (!trimAvailable) return trimUnavailable;
  return addon.trimNativeMemory() === 1 ? trimReleased : trimNoRelease;
}

function validateMask(mask, width, height, factor) {
  const { safe, rgba, widthTiles, offsetX = 0, offsetY = 0 } = mask;
  if (
    factor !== 16 ||
    !(safe instanceof Uint8Array || safe instanceof Uint8ClampedArray) ||
    !(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) ||
    !Number.isSafeInteger(widthTiles) ||
    widthTiles < 1 ||
    widthTiles > 0xffffffff ||
    safe.length < 1 ||
    safe.length % widthTiles ||
    rgba.length !== safe.length * 4 ||
    ![offsetX, offsetY].every(Number.isSafeInteger) ||
    offsetX < 0 ||
    offsetY < 0 ||
    offsetX + width / factor > widthTiles ||
    offsetY + height / factor > safe.length / widthTiles
  )
    throw new Error("Invalid native opaque overview mask");
  return { safe, rgba, widthTiles, offsetX, offsetY };
}

/**
 * Optional Node-API implementation of boxDownsampleRgba, with exact JS fallback.
 * An optional factor-16 mask supplies already-proven final opaque tile means.
 * Its coordinates refer to the full halo plan; offsets locate this source core.
 * The caller is responsible for proving these pixels are the final composition,
 * as prepareOpaqueOverview does. Both backends return identical bytes.
 *
 * Loading never compiles code or downloads dependencies. Prepare the addon once
 * with native-reducer-build.mjs; a missing/stale build uses the JS implementation.
 */
export function boxDownsampleRgbaNative(
  data,
  width,
  height,
  factor,
  mask = null,
) {
  if (
    !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > 0xffffffff ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    height > 0xffffffff ||
    !Number.isSafeInteger(factor) ||
    factor < 1 ||
    factor > 16 ||
    width % factor ||
    height % factor ||
    data.length !== width * height * 4
  )
    throw new Error("Invalid RGBA area-reduction dimensions or byte array");
  const validated = mask ? validateMask(mask, width, height, factor) : null;
  if (addon)
    return validated
      ? addon.downsampleRgba(
          data,
          width,
          height,
          factor,
          validated.safe,
          validated.rgba,
          validated.widthTiles,
          validated.offsetX,
          validated.offsetY,
        )
      : addon.downsampleRgba(data, width, height, factor);
  const result = boxDownsampleRgba(data, width, height, factor);
  if (validated) {
    const { safe, rgba, widthTiles, offsetX, offsetY } = validated;
    const outWidth = width / factor;
    for (let y = 0; y < height / factor; y++)
      for (let x = 0; x < outWidth; x++) {
        const tile = (y + offsetY) * widthTiles + x + offsetX;
        if (safe[tile])
          result.set(
            rgba.subarray(tile * 4, tile * 4 + 4),
            (y * outWidth + x) * 4,
          );
      }
  }
  return result;
}
