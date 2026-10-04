import {
  paintPixelRGBA,
  resolvePaintSettings,
  UnsupportedPaintError,
} from "./paint.mjs";
export const FRAME_LIMITS = Object.freeze({
  maxFrames: 512,
  maxBytes: 8 * 1024 * 1024,
  maxSide: 64,
});
export function sceneFrameKey(c) {
  return [
    c.asset,
    c.kind,
    c.type ?? "",
    c.sx,
    c.sy,
    c.sw,
    c.sh,
    c.paintId || 0,
  ].join(":");
}
/**
 * Split premultiplied source P,A into representable source-over min(P,A),A and
 * additive max(P-A,0). The second term is valid ONLY over an opaque scene buffer.
 * No sprite is flattened onto black: foreground/background order is retained.
 */
export function splitPremultipliedRGBA(rgba, { opaqueScene = false } = {}) {
  const a = rgba[3],
    extra = [
      Math.max(0, rgba[0] - a),
      Math.max(0, rgba[1] - a),
      Math.max(0, rgba[2] - a),
    ],
    e = Math.max(...extra);
  if (e && !opaqueScene)
    throw new UnsupportedPaintError("premultiplied-excess-needs-opaque-scene");
  const base = Uint8ClampedArray.of(
    a ? Math.round((Math.min(rgba[0], a) * 255) / a) : 0,
    a ? Math.round((Math.min(rgba[1], a) * 255) / a) : 0,
    a ? Math.round((Math.min(rgba[2], a) * 255) / a) : 0,
    a,
  );
  const additive = e
    ? Uint8ClampedArray.of(...extra.map((n) => Math.round((n * 255) / e)), e)
    : null;
  return { base, additive };
}
export function prepareSceneFrames(
  plan,
  assets,
  createCanvas,
  {
    inputEncoding = "standard-straight",
    opaqueScene = false,
    maxFrames = FRAME_LIMITS.maxFrames,
    maxBytes = FRAME_LIMITS.maxBytes,
  } = {},
) {
  if (!["standard-straight", "tconvert-game-raw"].includes(inputEncoding))
    throw new Error("Unknown asset channel encoding");
  if (
    !Number.isSafeInteger(maxFrames) ||
    maxFrames < 1 ||
    maxFrames > FRAME_LIMITS.maxFrames ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > FRAME_LIMITS.maxBytes
  )
    throw new Error("Invalid painted-frame budget");
  const frames = new Map(),
    failures = new Map(),
    support = {
      paintedCommands: 0,
      preparedFrames: 0,
      additiveFrames: 0,
      bytes: 0,
      unsupportedCommands: 0,
      reasons: {},
    };
  const get = (name) =>
    assets instanceof Map ? assets.get(name) : assets?.[name];
  const required = (c) =>
    inputEncoding === "tconvert-game-raw" || (c.paintId || 0) !== 0;
  let scratch = null,
    disposed = false;
  for (const c of plan.commands) {
    if (!required(c)) continue;
    if (c.paintId) support.paintedCommands++;
    const key = sceneFrameKey(c);
    if (frames.has(key) || failures.has(key)) continue;
    if (frames.size + failures.size >= maxFrames) continue;
    const fail = (reason) => failures.set(key, reason);
    const source = get(c.asset);
    if (!source) {
      fail("missing-source-texture");
      continue;
    }
    if (
      ![c.sx, c.sy, c.sw, c.sh].every(Number.isSafeInteger) ||
      c.sx < 0 ||
      c.sy < 0 ||
      c.sw < 1 ||
      c.sh < 1 ||
      c.sw > FRAME_LIMITS.maxSide ||
      c.sh > FRAME_LIMITS.maxSide
    ) {
      fail("invalid-frame-bounds");
      continue;
    }
    if (
      c.sx + c.sw > (source.naturalWidth ?? source.width) ||
      c.sy + c.sh > (source.naturalHeight ?? source.height)
    ) {
      fail("source-crop-outside-texture");
      continue;
    }
    const settings = resolvePaintSettings(c.type ?? 0, {
      paintId: c.paintId || 0,
      wall: c.kind === "wall",
    });
    if (!settings.supported) {
      fail(settings.reason);
      continue;
    }
    const reserved = c.sw * c.sh * 8;
    if (support.bytes + reserved > maxBytes) {
      fail("painted-frame-byte-budget");
      continue;
    }
    try {
      scratch ??= createCanvas(c.sw, c.sh);
      scratch.width = c.sw;
      scratch.height = c.sh;
      const ctx = scratch.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, c.sw, c.sh);
      ctx.drawImage(source, c.sx, c.sy, c.sw, c.sh, 0, 0, c.sw, c.sh);
      const pixels = ctx.getImageData(0, 0, c.sw, c.sh),
        base = new Uint8ClampedArray(pixels.data.length),
        additive = new Uint8ClampedArray(pixels.data.length);
      let hasAdditive = false;
      for (let i = 0; i < pixels.data.length; i += 4) {
        const painted = paintPixelRGBA(
          pixels.data.subarray(i, i + 4),
          c.paintId || 0,
          {
            wall: c.kind === "wall",
            specialSettings: settings.specialSettings,
            inputEncoding,
            alphaMode: "scene-premultiplied",
          },
        );
        const split = splitPremultipliedRGBA(painted, { opaqueScene });
        base.set(split.base, i);
        if (split.additive) {
          additive.set(split.additive, i);
          hasAdditive = true;
        }
      }
      const materialize = (data) => {
        const canvas = createCanvas(c.sw, c.sh),
          target = canvas.getContext("2d"),
          image = target.createImageData(c.sw, c.sh);
        image.data.set(data);
        target.putImageData(image, 0, 0);
        return canvas;
      };
      frames.set(key, {
        base: materialize(base),
        additive: hasAdditive ? materialize(additive) : null,
      });
      support.preparedFrames++;
      if (hasAdditive) support.additiveFrames++;
      support.bytes += c.sw * c.sh * 4 * (hasAdditive ? 2 : 1);
    } catch (error) {
      fail(error.reason || "paint-frame-preparation-failed");
    }
  }
  const resolve = (c) => {
    if (disposed) return { unsupported: "prepared-frames-disposed" };
    if (!required(c)) return null;
    const key = sceneFrameKey(c);
    return (
      frames.get(key) || {
        unsupported: failures.get(key) || "painted-frame-count-budget",
      }
    );
  };
  for (const c of plan.commands) {
    const value = resolve(c);
    if (value?.unsupported) {
      support.unsupportedCommands++;
      support.reasons[value.unsupported] =
        (support.reasons[value.unsupported] || 0) + 1;
    }
  }
  const warnings = [];
  if (inputEncoding === "tconvert-game-raw")
    warnings.push(
      "Asset encoding: raw game texture channels. PNG decoding/8-bit rounding is not a GPU bit-identical oracle.",
    );
  if (support.additiveFrames)
    warnings.push(
      "Painted RGB exceeding alpha is retained by source-over + additive terms on one opaque black scene buffer; sprites are not individually flattened.",
    );
  if (support.unsupportedCommands)
    warnings.push(
      `${support.unsupportedCommands} paint/channel-conversion commands skipped: ${Object.entries(
        support.reasons,
      )
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}.`,
    );
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const frame of frames.values())
      for (const canvas of [frame.base, frame.additive])
        if (canvas) {
          canvas.width = 1;
          canvas.height = 1;
        }
    if (scratch) {
      scratch.width = 1;
      scratch.height = 1;
    }
    frames.clear();
    failures.clear();
  };
  return { resolve, dispose, support, warnings, opaqueScene, inputEncoding };
}
