import { textureSource } from "../core/assets.mjs";
import { FRAME_LIMITS } from "../core/scene-frames.mjs";
import { resolvePaintSettings } from "../core/paint.mjs";
import { nativeFrameWithOpacity } from "./native-blitter.mjs";

/**
 * Exact prepared pixels for the raw identity shader, without a Canvas surface.
 *
 * `source` is the same immutable registered texture used by prepareSceneFrames.
 * Unsupported encodings/effects return null for that original preparer; an
 * established validation failure returns { unsupported: originalReason }.
 * Unknown encoding names throw, matching the original preparation entry point.
 *
 * Successful base/additive arrays contain premultiplied bytes with `opacity`
 * baked in, ready for the integer compositor. `mean` is deliberately PRE-opacity
 * and exists only for an opaque 16x16 source frame. This is the same frame-level
 * metadata as sceneFrameKey (which excludes opacity), never a proof that an
 * arbitrary destination command may be skipped. The caller must still prove
 * final coverage, draw geometry, clip and opacity before using the mean.
 *
 * For integer P <= A, round(round(P * 255 / A) * A / 255) = P. Therefore the
 * original splitPremultipliedRGBA -> Canvas -> premultiplied readback produces
 * exactly min(rawRGB, A) in the base and max(rawRGB - A, 0) in the additive plane.
 * RGB above alpha, including alpha-zero emission, is preserved independently.
 */
export function prepareRawOverviewFrame(
  command,
  source,
  {
    inputEncoding = "tconvert-game-raw",
    opaqueScene = true,
    opacity = command.opacity === undefined ? 1 : command.opacity,
  } = {},
) {
  if (inputEncoding === "standard-straight") return null;
  if (inputEncoding !== "tconvert-game-raw")
    throw new Error("Unknown asset channel encoding");
  if (!source) return { unsupported: "missing-source-texture" };
  const { sx, sy, sw: width, sh: height } = command;
  if (
    !Number.isSafeInteger(sx) ||
    !Number.isSafeInteger(sy) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    sx < 0 ||
    sy < 0 ||
    width < 1 ||
    height < 1 ||
    width > FRAME_LIMITS.maxSide ||
    height > FRAME_LIMITS.maxSide
  )
    return { unsupported: "invalid-frame-bounds" };
  const sourceWidth = source.naturalWidth ?? source.width,
    sourceHeight = source.naturalHeight ?? source.height;
  if (sx + width > sourceWidth || sy + height > sourceHeight)
    return { unsupported: "source-crop-outside-texture" };

  // The original corner path has additional geometry/domain validations before
  // resolving paint. Delegate the entire effect so its failure ordering stays
  // unchanged, rather than partially reimplementing that contract here.
  if (command.vertexColor || command.vertexColors) return null;
  const paintId = command.paintId || 0,
    settings = resolvePaintSettings(command.type ?? 0, {
      paintId,
      wall: command.kind === "wall",
    });
  if (!settings.supported) return { unsupported: settings.reason };
  if (paintId !== 0 && paintId !== 31) return null;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) return null;

  try {
    const imported = textureSource(source),
      raw = imported?.rawRgba;
    if (!raw)
      return { unsupported: imported?.rawError || "raw-png-bytes-required" };
    // The PNG decoder supplies exact byte arrays. Unusual hand-registered
    // sources keep the original preparer's conversion/validation behavior.
    if (
      !(
        raw.data instanceof Uint8Array || raw.data instanceof Uint8ClampedArray
      ) ||
      !Number.isSafeInteger(raw.width) ||
      !Number.isSafeInteger(raw.height) ||
      raw.width !== sourceWidth ||
      raw.height !== sourceHeight ||
      raw.data.length !== raw.width * raw.height * 4
    )
      return null;
    const size = width * height * 4,
      base = new Uint8Array(size),
      pixels = raw.data;
    let additive = null,
      opaqueMean = width === 16 && height === 16,
      sumRed = 0,
      sumGreen = 0,
      sumBlue = 0;
    for (let y = 0; y < height; y++) {
      let input = ((sy + y) * raw.width + sx) * 4,
        output = y * width * 4;
      const end = output + width * 4;
      for (; output < end; input += 4, output += 4) {
        const red = pixels[input],
          green = pixels[input + 1],
          blue = pixels[input + 2],
          alpha = pixels[input + 3],
          extraRed = red > alpha ? red - alpha : 0,
          extraGreen = green > alpha ? green - alpha : 0,
          extraBlue = blue > alpha ? blue - alpha : 0,
          extraAlpha = Math.max(extraRed, extraGreen, extraBlue);
        base[output] = red - extraRed;
        base[output + 1] = green - extraGreen;
        base[output + 2] = blue - extraBlue;
        base[output + 3] = alpha;
        if (extraAlpha) {
          if (!opaqueScene)
            return { unsupported: "premultiplied-excess-needs-opaque-scene" };
          additive ??= new Uint8Array(size);
          additive[output] = extraRed;
          additive[output + 1] = extraGreen;
          additive[output + 2] = extraBlue;
          additive[output + 3] = extraAlpha;
        }
        if (opaqueMean) {
          if (alpha !== 255) opaqueMean = false;
          else {
            sumRed += red;
            sumGreen += green;
            sumBlue += blue;
          }
        }
      }
    }
    const mean = opaqueMean
      ? Uint8Array.of(
          Math.round(sumRed / 256),
          Math.round(sumGreen / 256),
          Math.round(sumBlue / 256),
          255,
        )
      : null;
    if (opacity !== 1) {
      nativeFrameWithOpacity(base, opacity, base);
      if (additive) nativeFrameWithOpacity(additive, opacity, additive);
    }
    return {
      base,
      additive,
      width,
      height,
      uvFlipApplied: false,
      bytes: base.byteLength + (additive?.byteLength ?? 0),
      mean,
    };
  } catch (error) {
    return { unsupported: error.reason || "paint-frame-preparation-failed" };
  }
}
