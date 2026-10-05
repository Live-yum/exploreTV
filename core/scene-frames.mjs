import { multiplyStaticVertexColor } from "./static-blocks.mjs";
import { textureSource } from "./assets.mjs";
import { interpolateShimmerVertexColors } from "./liquid-shimmer.mjs";
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
function cornerDomain(c) {
  const domain = c.vertexDomain ?? {
    x: c.dx,
    y: c.dy,
    width: c.dw,
    height: c.dh,
  };
  return {
    offsetX: c.dx - domain.x,
    offsetY: c.dy - domain.y,
    width: domain.width,
    height: domain.height,
  };
}
export function sceneFrameKey(c) {
  const ordinary = [
    c.asset,
    c.kind,
    c.type ?? "",
    c.sx,
    c.sy,
    c.sw,
    c.sh,
    c.paintId || 0,
    c.vertexColor ? c.vertexColor.join(",") : "",
  ].join(":");
  if (!c.vertexColors) return ordinary;
  // Corner ramps stay attached to destination vertices; flips change only UVs.
  // Normalize position against the original quad so translated ROI instances
  // share a frame, while split PointClamp rows keep their own ramp interval.
  const d = cornerDomain(c);
  return (
    ordinary +
    ":corners:" +
    JSON.stringify([
      ["topLeft", "topRight", "bottomRight", "bottomLeft"].map(
        (k) => c.vertexColors[k],
      ),
      c.dw,
      c.dh,
      d.offsetX,
      d.offsetY,
      d.width,
      d.height,
      !!c.flipX,
      !!c.flipY,
      c.interpolation ?? "triangles-tl-br",
      Number.isSafeInteger(c.dx),
      Number.isSafeInteger(c.dy),
      c.inputEncoding ?? "",
    ])
  );
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
    inputEncoding === "tconvert-game-raw" ||
    (c.paintId || 0) !== 0 ||
    !!c.vertexColor ||
    !!c.vertexColors;
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
    const corner = !!c.vertexColors;
    const width = corner ? c.dw : c.sw,
      height = corner ? c.dh : c.sh;
    let domain;
    if (corner) {
      if (c.inputEncoding !== undefined && c.inputEncoding !== inputEncoding) {
        fail("corner-input-encoding-mismatch");
        continue;
      }
      if (
        ![c.dx, c.dy, width, height].every(Number.isSafeInteger) ||
        width < 1 ||
        height < 1 ||
        width > FRAME_LIMITS.maxSide ||
        height > FRAME_LIMITS.maxSide
      ) {
        fail("invalid-corner-frame-bounds");
        continue;
      }
      if (
        c.interpolation !== undefined &&
        c.interpolation !== "triangles-tl-br"
      ) {
        fail("unsupported-corner-interpolation");
        continue;
      }
      domain = cornerDomain(c);
      if (
        !Object.values(domain).every(Number.isFinite) ||
        domain.width < 1 ||
        domain.height < 1 ||
        domain.offsetX < 0 ||
        domain.offsetY < 0 ||
        domain.offsetX + width > domain.width ||
        domain.offsetY + height > domain.height
      ) {
        fail("invalid-corner-vertex-domain");
        continue;
      }
      try {
        interpolateShimmerVertexColors(c.vertexColors, 0, 0);
      } catch {
        fail("invalid-corner-vertex-colors");
        continue;
      }
    }
    const settings = resolvePaintSettings(c.type ?? 0, {
      paintId: c.paintId || 0,
      wall: c.kind === "wall",
    });
    if (!settings.supported) {
      fail(settings.reason);
      continue;
    }
    const reserved = width * height * 8;
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
      let pixels;
      if (inputEncoding === "tconvert-game-raw") {
        const imported = textureSource(source);
        if (!imported?.rawRgba)
          throw new UnsupportedPaintError(
            imported?.rawError || "raw-png-bytes-required",
          );
        const raw = imported.rawRgba;
        pixels = { data: new Uint8ClampedArray(c.sw * c.sh * 4) };
        for (let y = 0; y < c.sh; y++) {
          const start = ((c.sy + y) * raw.width + c.sx) * 4;
          pixels.data.set(
            raw.data.subarray(start, start + c.sw * 4),
            y * c.sw * 4,
          );
        }
      } else {
        ctx.drawImage(source, c.sx, c.sy, c.sw, c.sh, 0, 0, c.sw, c.sh);
        pixels = ctx.getImageData(0, 0, c.sw, c.sh);
      }
      const base = new Uint8ClampedArray(width * height * 4),
        additive = new Uint8ClampedArray(width * height * 4);
      let hasAdditive = false;
      for (let i = 0; i < base.length; i += 4) {
        const x = (i / 4) % width,
          y = Math.floor(i / 4 / width);
        let sourceOffset = i;
        if (corner) {
          let sx = Math.floor(((x + 0.5) * c.sw) / width),
            sy = Math.floor(((y + 0.5) * c.sh) / height);
          if (c.flipX) sx = c.sw - 1 - sx;
          if (c.flipY) sy = c.sh - 1 - sy;
          sourceOffset = (sy * c.sw + sx) * 4;
        }
        const painted = paintPixelRGBA(
          pixels.data.subarray(sourceOffset, sourceOffset + 4),
          c.paintId || 0,
          {
            wall: c.kind === "wall",
            specialSettings: settings.specialSettings,
            inputEncoding,
            alphaMode: "scene-premultiplied",
          },
        );
        let tinted = c.vertexColor
          ? multiplyStaticVertexColor(painted, c.vertexColor)
          : painted;
        if (corner) {
          const vertex = interpolateShimmerVertexColors(
            c.vertexColors,
            (domain.offsetX + x + 0.5) / domain.width,
            (domain.offsetY + y + 0.5) / domain.height,
          );
          tinted = multiplyStaticVertexColor(tinted, vertex);
        }
        const split = splitPremultipliedRGBA(tinted, { opaqueScene });
        base.set(split.base, i);
        if (split.additive) {
          additive.set(split.additive, i);
          hasAdditive = true;
        }
      }
      const materialize = (data) => {
        const canvas = createCanvas(width, height),
          target = canvas.getContext("2d"),
          image = target.createImageData(width, height);
        image.data.set(data);
        target.putImageData(image, 0, 0);
        return canvas;
      };
      frames.set(key, {
        base: materialize(base),
        additive: hasAdditive ? materialize(additive) : null,
        width,
        height,
        uvFlipApplied: corner,
      });
      support.preparedFrames++;
      if (hasAdditive) support.additiveFrames++;
      support.bytes += width * height * 4 * (hasAdditive ? 2 : 1);
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
      "Asset encoding: raw RGBA8 PNG bytes preserved before shader math. Canvas output blending still has 8-bit rounding; not a GPU bit-identical oracle.",
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
