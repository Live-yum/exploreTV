/** Original paint formulas. See docs/paint-scope.md for provenance and alpha limits. */
export class UnsupportedPaintError extends Error {
  constructor(reason) {
    super(`Unsupported paint operation: ${reason}`);
    this.name = "UnsupportedPaintError";
    this.reason = reason;
  }
}

const DIRTY = new Set([0, 2, 23, 109, 199, 477, 492, 633]);
const MUDDY = new Set([59, 60, 70]);
const TREE_MASKS = new Set([
  5, 323, 583, 584, 585, 586, 587, 588, 589, 595, 596, 615, 616, 634,
]);
const f = Math.fround;
const byte = (value) => Math.round(Math.max(0, Math.min(1, value)) * 255);

export function supportsPaint(paintId) {
  return Number.isInteger(paintId) && paintId >= 0 && paintId <= 31;
}

/** Resolve only the mask, not a tile atlas or runtime tree biome. */
export function resolvePaintStyle(
  tileType,
  { paintId = 1, wall = false } = {},
) {
  if (!supportsPaint(paintId))
    return { supported: false, reason: "unknown-paint-id" };
  if (wall || paintId < 1 || paintId > 12)
    return { supported: true, specialSettings: null };
  if (!Number.isInteger(tileType) || tileType < 0)
    return { supported: false, reason: "unknown-tile-type" };
  if (TREE_MASKS.has(tileType))
    return { supported: false, reason: "tree-paint-style" };
  if (DIRTY.has(tileType))
    return {
      supported: true,
      specialSettings: {
        minHue: f(0.03),
        maxHue: f(0.08),
        minSat: f(0.38),
        maxSat: f(0.53),
        hueOffset: 0,
        invert: true,
      },
    };
  if (MUDDY.has(tileType))
    return {
      supported: true,
      specialSettings: {
        minHue: f(0.42),
        maxHue: f(0.55),
        minSat: f(0.2),
        maxSat: f(0.27),
        hueOffset: 0.5,
        invert: true,
      },
    };
  return { supported: true, specialSettings: null };
}

function validateMask(settings) {
  if (!settings) return;
  for (const key of ["minHue", "maxHue", "minSat", "maxSat", "hueOffset"]) {
    if (!Number.isFinite(settings[key]))
      throw new UnsupportedPaintError("invalid-special-settings");
  }
  if (
    settings.minHue > settings.maxHue ||
    settings.minSat > settings.maxSat ||
    typeof settings.invert !== "boolean"
  ) {
    throw new UnsupportedPaintError("invalid-special-settings");
  }
}

function maskIncludes(rgb, settings) {
  const [r, g, b] = rgb;
  const high = Math.max(...rgb),
    low = Math.min(...rgb),
    delta = high - low;
  let hue = 0,
    saturation = 0;
  if (delta > 0) {
    saturation = delta / high;
    const sector =
      high === r
        ? (g - b) / delta
        : high === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4;
    hue = sector / 6 - Math.floor(sector / 6);
  }
  // JS remainder, like the effect's fmod, preserves the sign of a negative offset.
  hue = (hue + settings.hueOffset) % 1;
  const included =
    hue >= settings.minHue &&
    hue <= settings.maxHue &&
    saturation >= settings.minSat &&
    saturation <= settings.maxSat;
  return settings.invert ? !included : included;
}

function paintSample(rgb, paintId, wall, settings) {
  if (paintId === 0 || paintId === 31) return rgb;
  if (paintId <= 12 && settings && !maskIncludes(rgb, settings)) return rgb;
  const high = Math.max(...rgb),
    low = Math.min(...rgb);
  if (paintId <= 24) {
    const b = paintId <= 12 ? low : f(0.4) * low;
    const a = high,
      c = (a + b) * 0.5;
    return [
      [a, b, b],
      [a, c, b],
      [a, a, b],
      [c, a, b],
      [b, a, b],
      [b, a, c],
      [b, a, a],
      [b, c, a],
      [b, b, a],
      [c, b, a],
      [a, b, a],
      [a, b, c],
    ][(paintId - 1) % 12];
  }
  let gray;
  switch (paintId) {
    case 25:
      gray = f(0.15) * (high + low);
      break;
    case 26:
      gray = (7 * high + 3 * low) * f(0.1) * (2 - (high + low) * 0.5);
      break;
    case 27:
      gray = (high + low) * 0.5;
      break;
    case 28:
      return [high, f(0.7) * high, f(0.49) * high];
    case 29:
      gray = f(0.025) * (high + low);
      break;
    case 30:
      return high === 0
        ? rgb
        : rgb.map((x) => (wall ? Math.max(0, 0.75 - 2 * x) : 1 - x));
  }
  return [gray, gray, gray];
}

/**
 * bytes4 -> new Uint8ClampedArray. Never changes the input.
 * alphaMode:
 * - opaque-only (default): A=255 or transparent; rejects nontrivial semitransparent paint.
 * - straight: explicitly interpret input as unassociated RGBA; premultiply, paint, and
 *   unpremultiply. Reject colors that cannot be represented by straight RGBA.
 * - premultiplied: raw shader-domain input/output, NOT Canvas ImageData.
 * - scene-premultiplied: interpret inputEncoding and return shader-domain RGBA,
 *   including RGB > alpha. Requires a premultiplied scene compositor.
 * inputEncoding: standard-straight (default), or tconvert-game-raw for PNGs that
 * preserve XNB sampled channels. With straight output, raw input skips premultiplication.
 * Options: wall, specialSettings, alphaMode, inputEncoding. Coatings are separate.
 */
export function paintPixelRGBA(
  bytes4,
  paintId,
  {
    wall = false,
    specialSettings = null,
    alphaMode = "opaque-only",
    inputEncoding = "standard-straight",
  } = {},
) {
  if (!supportsPaint(paintId))
    throw new UnsupportedPaintError("unknown-paint-id");
  if (
    !bytes4 ||
    bytes4.length !== 4 ||
    !Array.from(bytes4).every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    throw new TypeError("Expected exactly four RGBA bytes");
  }
  if (
    ![
      "opaque-only",
      "straight",
      "premultiplied",
      "scene-premultiplied",
    ].includes(alphaMode)
  )
    throw new UnsupportedPaintError("unknown-alpha-mode");
  if (!["standard-straight", "tconvert-game-raw"].includes(inputEncoding))
    throw new UnsupportedPaintError("unknown-input-encoding");
  validateMask(specialSettings);
  const rawToStraight =
    alphaMode === "straight" && inputEncoding === "tconvert-game-raw";
  const sceneMode = alphaMode === "scene-premultiplied";
  const sceneRaw = sceneMode && inputEncoding === "tconvert-game-raw";
  if ((paintId === 0 || paintId === 31) && !rawToStraight && !sceneMode)
    return Uint8ClampedArray.from(bytes4);
  const alpha = bytes4[3] / 255;
  if (alpha === 0 && !sceneRaw) return Uint8ClampedArray.of(0, 0, 0, 0);
  if (alphaMode === "opaque-only" && alpha !== 1)
    throw new UnsupportedPaintError("semitransparent-alpha-provenance");
  let rgb = Array.from(bytes4)
    .slice(0, 3)
    .map((n) => n / 255);
  if (
    (alphaMode === "premultiplied" || rawToStraight) &&
    rgb.some((v) => v > alpha)
  )
    throw new UnsupportedPaintError("invalid-premultiplied-input");
  if ((alphaMode === "straight" && !rawToStraight) || (sceneMode && !sceneRaw))
    rgb = rgb.map((v) => v * alpha);
  rgb = paintSample(rgb, paintId, wall, specialSettings).map((v) =>
    Math.max(0, Math.min(1, v)),
  );
  if (alphaMode === "straight") {
    if (rgb.some((v) => v > alpha + 1e-7))
      throw new UnsupportedPaintError("paint-exceeds-alpha");
    rgb = rgb.map((v) => v / alpha);
  }
  return Uint8ClampedArray.of(...rgb.map(byte), bytes4[3]);
}

export const resolvePaintSettings = resolvePaintStyle;
