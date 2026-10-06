import {
  prepareFramePixels,
  quantizeCanvasOpacity,
} from "./native-blitter.mjs";

const slopePoints = {
  2: [
    [0, 0],
    [16, 16],
    [0, 16],
  ],
  3: [
    [0, 16],
    [16, 0],
    [16, 16],
  ],
  4: [
    [0, 0],
    [16, 0],
    [0, 16],
  ],
  5: [
    [0, 0],
    [16, 0],
    [16, 16],
  ],
};

/** Return a canonical 16-pixel slope shape, or null for the Canvas fallback. */
export function canonicalSlopeClip(c) {
  if (
    !c ||
    c.vertexColors ||
    c.sw !== 16 ||
    c.sh !== 16 ||
    c.dw !== 16 ||
    c.dh !== 16 ||
    !Number.isSafeInteger(c.dx) ||
    !Number.isSafeInteger(c.dy) ||
    Math.abs(c.dx) > 0x3fffffff ||
    Math.abs(c.dy) > 0x3fffffff ||
    (c.opacity !== undefined &&
      (!Number.isFinite(c.opacity) || c.opacity < 0 || c.opacity > 1)) ||
    (c.flipX !== undefined && typeof c.flipX !== "boolean") ||
    (c.flipY !== undefined && typeof c.flipY !== "boolean") ||
    !Array.isArray(c.clip) ||
    c.clip.length !== 3 ||
    !c.clip.every((point) => Array.isArray(point) && point.length === 2)
  )
    return null;
  for (let shape = 2; shape <= 5; shape++) {
    const points = slopePoints[shape];
    if (
      c.clip[0][0] === points[0][0] &&
      c.clip[0][1] === points[0][1] &&
      c.clip[1][0] === points[1][0] &&
      c.clip[1][1] === points[1][1] &&
      c.clip[2][0] === points[2][0] &&
      c.clip[2][1] === points[2][1]
    )
      return shape;
  }
  return null;
}

/**
 * Bake a canonical slope into independently composable premultiplied planes.
 * Integer placement makes the four clip coverages translation-independent.
 * Opacity and UV flips MUST happen inside the clipped draw: clipping first and
 * multiplying opacity later changes byte rounding at the diagonal edge.
 *
 * The caller's pixel-cache key must include the ordinary source/frame identity,
 * shape, both command flip flags and quantizeCanvasOpacity(opacity ?? 1).
 * Returned planes already contain opacity and flips; native draws use alpha 1
 * and no further UV transform. Unsupported commands return null. A supported
 * command requires an already validated 16x16 prepared Canvas frame.
 */
export function prepareClippedOverviewFrame(frame, c, createCanvas) {
  const shape = canonicalSlopeClip(c);
  if (shape === null) return null;
  if (
    !frame?.base ||
    frame.unsupported ||
    frame.width !== 16 ||
    frame.height !== 16 ||
    frame.base.width !== 16 ||
    frame.base.height !== 16 ||
    (frame.additive &&
      (frame.additive.width !== 16 || frame.additive.height !== 16)) ||
    typeof createCanvas !== "function"
  )
    throw new TypeError(
      "Canonical slope requires a validated 16x16 Canvas frame",
    );
  const opacity = c.opacity === undefined ? 1 : c.opacity,
    opacityByte = quantizeCanvasOpacity(opacity),
    flipX = !!c.flipX && !frame.uvFlipApplied,
    flipY = !!c.flipY && !frame.uvFlipApplied,
    points = slopePoints[shape],
    canvas = createCanvas(16, 16),
    context = canvas.getContext("2d");
  const materialize = (source) => {
    // Reset outside the clip: an antialiased clear inside the clip would leave
    // some of the preceding plane's diagonal pixels behind.
    context.clearRect(0, 0, 16, 16);
    context.save();
    try {
      context.imageSmoothingEnabled = false;
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = opacity;
      context.beginPath();
      context.moveTo(points[0][0], points[0][1]);
      context.lineTo(points[1][0], points[1][1]);
      context.lineTo(points[2][0], points[2][1]);
      context.closePath();
      context.clip();
      if (flipX || flipY) {
        context.translate(flipX ? 16 : 0, flipY ? 16 : 0);
        context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
      }
      context.drawImage(source, 0, 0, 16, 16);
    } finally {
      context.restore();
    }
    return prepareFramePixels(canvas);
  };
  try {
    const base = materialize(frame.base),
      additive = frame.additive ? materialize(frame.additive) : null;
    return {
      base,
      additive,
      width: 16,
      height: 16,
      uvFlipApplied: true,
      bytes: base.byteLength + (additive?.byteLength ?? 0),
      clipShape: shape,
      opacityByte,
    };
  } finally {
    canvas.width = canvas.height = 1;
  }
}
