/** Frozen modern Shimmer sprites and color kernel. See docs/liquid-shimmer.md. */
import { isSolidOrSlopedTile } from "./tile-solidity.mjs";
export const SHIMMER_SOURCE = "8255d34616c780af12079425ac92a0a7aed87d71";
export const SHIMMER_STATIC_STATE = Object.freeze({
  frame: 0,
  timeForVisualEffects: 0,
  colorProfile: "xna",
});
export const SHIMMER_ASSETS = Object.freeze({
  "water_14.png": Object.freeze({
    width: 144,
    height: 1360,
    source: "Images/Misc/water_14.png",
    sha256: "7b48569dce7f0d3216ef74ca641112a47f582b4852a97226a61c2d8ce66dcb3f",
  }),
  "Liquid_14.png": Object.freeze({
    width: 306,
    height: 72,
    source: "Images/Liquid_14.png",
    sha256: "45261d749203308678cf0fe57928da64b2db6629e2e90546a1b655d036a4caa5",
  }),
  "LiquidSlope_14.png": Object.freeze({
    width: 72,
    height: 16,
    source: "Images/LiquidSlope_14.png",
    sha256: "ec12687d55d0d1b10efe190eeaefd95964129718080de0b22dded95407405d5d",
  }),
});
const PLATFORMS = new Set([19, 427, 435, 436, 437, 438, 439]);
const SPECIAL = new Set([379, 518, 546]);
const BLOCKS_BACK = new Set([54, 541, 328, 459, 470]);
const CLOUD_ORIGINS = new Set([196, 460, 717]);
const LENGTH = [10, 3, 2, 10];
const f = Math.fround,
  add = (a, b) => f(a + b),
  sub = (a, b) => f(a - b),
  mul = (a, b) => f(a * b);
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const attenuation = LENGTH.map((length) => {
  const out = [1],
    step = f(1 / (length + 1));
  for (let i = 1; i <= length; i++) out.push(sub(out[i - 1], step));
  return out;
});
const roundEven = (value) => {
  const n = Math.floor(value),
    r = value - n;
  return r === 0.5 ? n + (n % 2) : Math.round(value);
};
function validateColorInputs(x, y, time, profile) {
  if (
    ![x, y, time].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    x > 1000000 ||
    y > 1000000 ||
    Math.abs(time) > 1e9
  )
    throw new RangeError(
      "Shimmer color coordinates/time outside bounded domain",
    );
  if (!["xna", "fna"].includes(profile))
    throw new RangeError("Unknown Shimmer color profile");
}
function colorFromVector(vector, profile) {
  return vector.map((v) => {
    const n = mul(clamp(v), 255);
    return profile === "xna" ? roundEven(n) : Math.trunc(n);
  });
}
const scaleColor = (color, opacity) =>
  color.map((v) => Math.trunc(clamp(mul(v, opacity), 0, 255)));
const toVector = (color) => color.map((v) => f(v / 255));
const spatial = (x, y) => add(f(x), f(f(y) / 6));
export function shimmerWave(x, y, timeForVisualEffects = 0) {
  validateColorInputs(x, y, timeForVisualEffects, "xna");
  return f(
    Math.sin(
      (f(spatial(x, y) / 10) - timeForVisualEffects / 360) * 6.2831854820251465,
    ),
  );
}
/** Source Vector4, before Color byte quantization; interpolation is unclamped. */
export function shimmerBaseColor(x, y, timeForVisualEffects = 0) {
  const wave = shimmerWave(x, y, timeForVisualEffects),
    weight = add(f(0.1), mul(wave, f(0.4)));
  const lo = [f(0.64705884), f(26 / 51), f(14 / 15), 1],
    hi = [f(41 / 51), f(41 / 51), 1, 1];
  return lo.map((a, i) => add(a, mul(sub(hi[i], a), weight)));
}
function remap(v, min, max, toMax) {
  return mul(f(toMax), clamp(f(sub(v, f(min)) / sub(f(max), f(min)))));
}
export function shimmerNoise(x, y) {
  x = x >>> 0;
  y = y >>> 0;
  x = (Math.imul(36469, x & 65535) + (x >>> 16)) >>> 0;
  y = (Math.imul(18012, y & 65535) + (y >>> 16)) >>> 0;
  return ((x << 16) + y) >>> 0;
}
export function shimmerGlitterOpacity(top, x, y, timeForVisualEffects = 0) {
  validateColorInputs(x, y, timeForVisualEffects, "xna");
  if (top) return 0.5;
  const envelope = remap(
    shimmerWave(x, y, timeForVisualEffects),
    -0.5,
    1,
    0.35,
  );
  const noise = f(
    Math.sin(
      f(f(shimmerNoise(Math.trunc(x), Math.trunc(y))) / 10) +
        timeForVisualEffects / 180,
    ),
  );
  return remap(mul(envelope, noise), 0, 0.5, 1);
}
function hueChannel(c) {
  if (c < 0) c++;
  if (c > 1) c--;
  return 6 * c < 1 ? 6 * c : 2 * c < 1 ? 1 : 3 * c < 2 ? (2 / 3 - c) * 6 : 0;
}
export function shimmerGlitterColor(
  top,
  x,
  y,
  timeForVisualEffects = 0,
  profile = "xna",
) {
  validateColorInputs(x, y, timeForVisualEffects, profile);
  const hue = f((spatial(x, y) + timeForVisualEffects / 30) / 6) % 1;
  const hsl = [
    roundEven(hueChannel(hue + 1 / 3) * 255),
    roundEven(hueChannel(hue) * 255),
    roundEven(hueChannel(hue - 1 / 3) * 255),
    0,
  ];
  const opacity = shimmerGlitterOpacity(top, x, y, timeForVisualEffects);
  return colorFromVector(
    toVector(hsl).map((v) => mul(v, opacity)),
    profile,
  );
}
export function shimmerFrame(top, x, y, timeForVisualEffects = 0) {
  validateColorInputs(x, y, timeForVisualEffects, "xna");
  x = add(f(x), 0.5);
  y = add(f(y), 0.5);
  let phase = f(spatial(x, y) / 10) - timeForVisualEffects / 360;
  if (!top) phase += add(x, y);
  return ((Math.trunc(phase) % 16) + 16) % 16;
}
function cornersFor(x, y, fn) {
  return {
    topLeft: fn(x, y),
    topRight: fn(x + 1, y),
    bottomLeft: fn(x, y + 1),
    bottomRight: fn(x + 1, y + 1),
  };
}
function opacityValue(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new RangeError("Invalid Shimmer opacity");
  return f(value);
}
export function shimmerBaseVertexColors(
  x,
  y,
  opacity = 1,
  timeForVisualEffects = 0,
  { colorProfile = "xna" } = {},
) {
  validateColorInputs(x, y, timeForVisualEffects, colorProfile);
  opacity = opacityValue(opacity);
  const white = toVector(scaleColor([255, 255, 255, 255], opacity));
  return cornersFor(x, y, (a, b) =>
    colorFromVector(
      shimmerBaseColor(a, b, timeForVisualEffects).map((v, i) =>
        mul(v, white[i]),
      ),
      colorProfile,
    ),
  );
}
export function shimmerGlitterVertexColors(
  x,
  y,
  opacity = 1,
  top = true,
  timeForVisualEffects = 0,
  { colorProfile = "xna" } = {},
) {
  validateColorInputs(x, y, timeForVisualEffects, colorProfile);
  opacity = opacityValue(opacity);
  return cornersFor(x, y, (a, b) =>
    scaleColor(
      shimmerGlitterColor(top, a, b, timeForVisualEffects, colorProfile),
      opacity,
    ),
  );
}
class Unsupported extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
const reject = (reason) => {
  throw new Unsupported(reason);
};
function at(region, x, y) {
  if (!region?.rect) return null;
  const dx = x - region.rect.x,
    dy = y - region.rect.y;
  return dx >= 0 && dy >= 0 && dx < region.rect.width && dy < region.rect.height
    ? (region.cells[dx * region.rect.height + dy] ?? null)
    : null;
}

/**
 * Build one memoized sampler per region. No input mutation or asset reads.
 * isSolid returns true/false for proven material classifications, otherwise
 * undefined. getWorldTile, when supplied, must return decoded world records.
 */
function createShimmerGeometry(region, options = {}) {
  const rect = region?.rect;
  if (
    !rect ||
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    rect.width > 512 ||
    rect.height > 512 ||
    rect.width * rect.height > 65536 ||
    region.cells?.length !== rect.width * rect.height
  )
    throw new RangeError("Invalid shimmer-liquid region");
  const worldSurface = options.worldSurface ?? region.source?.worldSurface;
  const reader = options.getWorldTile ?? region.getWorldTile;
  let depth = 0;
  const memo = (compute) => {
    const cache = new Map();
    return (x, y) => {
      const key = `${x},${y}`;
      if (cache.has(key)) {
        const value = cache.get(key);
        if (value instanceof Unsupported) throw value;
        return value;
      }
      // Pathological uninterrupted partial columns/corner chains are reported,
      // never silently truncated or allowed to exhaust the JavaScript stack.
      if (++depth > 384) {
        depth--;
        reject("shimmer-dependency-depth");
      }
      try {
        const value = compute(x, y);
        cache.set(key, value);
        return value;
      } catch (error) {
        if (
          error instanceof Unsupported &&
          error.reason !== "shimmer-dependency-depth"
        )
          cache.set(key, error);
        throw error;
      } finally {
        depth--;
      }
    };
  };
  const raw = memo((x, y) => {
    const tile =
      at(region, x, y) ??
      at(region.context, x, y) ??
      (typeof reader === "function" ? reader(x, y) : null);
    if (!tile) reject("shimmer-missing-context");
    const amount = tile.liquid ?? 0,
      shape = tile.shape ?? 0;
    if (!Number.isInteger(amount) || amount < 0 || amount > 255)
      reject("shimmer-invalid-liquid-level");
    if (!Number.isInteger(shape) || shape < 0 || shape > 5)
      reject("shimmer-invalid-shape");
    const kind = amount ? tile.liquidKind - 1 : 0;
    if (amount && ![0, 1, 2, 3].includes(kind))
      reject("shimmer-unknown-liquid-kind");
    let solid = false;
    if (tile.active && !tile.inactive && !PLATFORMS.has(tile.type)) {
      if (SPECIAL.has(tile.type)) reject("shimmer-special-tile-neighborhood");
      const known = (options.isSolid ?? isSolidOrSlopedTile)(tile);
      if (typeof known !== "boolean")
        reject("shimmer-unknown-solid-neighborhood");
      solid = known;
    }
    return { tile, amount, shape, kind, solid, level: f(amount / 255) };
  });
  const seed = memo((x, y) => {
    const self = raw(x, y);
    const half =
      self.shape === 1 &&
      !PLATFORMS.has(self.tile.type) &&
      raw(x, y - 1).amount > 0;
    if (half)
      return {
        ...self,
        half,
        level: 1,
        kind: self.amount ? self.kind : raw(x, y - 1).kind,
      };
    if (self.amount || self.solid)
      return { ...self, half, level: self.amount ? self.level : 0 };
    const north = raw(x, y - 1),
      south = raw(x, y + 1);
    const west = raw(x - 1, y),
      east = raw(x + 1, y);
    let level = 0,
      kind = self.kind;
    if (
      north.amount &&
      south.amount &&
      north.kind === south.kind &&
      !north.solid &&
      !south.solid
    ) {
      level = add(north.level, south.level);
      kind = north.kind;
    }
    if (
      west.amount &&
      east.amount &&
      west.kind === east.kind &&
      !west.solid &&
      !east.solid
    ) {
      level = Math.max(level, add(west.level, east.level));
      kind = west.kind;
    }
    return { ...self, half, level: mul(level, 0.5), kind };
  });
  const visible = memo((x, y) => {
    const self = seed(x, y);
    if (self.solid && !self.half)
      return { ...self, level: 1, shown: false, alpha: 0 };
    // Own full seed dominates all incoming levels, resets opacity and type.
    if (self.level === 1) return { ...self, shown: true, alpha: 1 };
    let level = self.level,
      kind = self.kind,
      alpha = self.level ? 1 : 0;
    const sources = [];
    for (let distance = 1; distance <= 10; distance++) {
      const above = seed(x, y - distance);
      if (
        above.level &&
        (!above.solid || above.half) &&
        distance <= LENGTH[above.kind]
      )
        sources.push({ distance, above });
      if (above.solid) break;
    }
    // Earlier/high sources are written first, and nearer sources overwrite the
    // inherited opacity/type even if they do not increase the maximum level.
    for (const { distance, above } of sources.reverse()) {
      const source = visible(x, y - distance);
      const weight = attenuation[above.kind][distance];
      level = Math.max(level, mul(source.level, weight));
      if (!self.level) {
        alpha = weight;
        kind = above.kind;
      }
    }
    return { ...self, level, kind, alpha, shown: level !== 0 };
  });
  const walls = memo((x, y) => {
    const self = visible(x, y);
    if (!self.shown)
      return {
        ...self,
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        edgeLeft: false,
        edgeRight: false,
        edgeTop: false,
        edgeBottom: false,
        fx: 0,
        fy: 0,
      };
    const north = visible(x, y - 1),
      south = visible(x, y + 1);
    const west = visible(x - 1, y),
      east = visible(x + 1, y);
    const missing = sub(1, self.level);
    const top = !north.shown ? mul(south.level, missing) : 0;
    const bottom =
      !south.shown && !south.solid && !south.half
        ? sub(1, mul(north.level, missing))
        : 1;
    const left =
      !west.shown && !west.solid && !west.half ? mul(east.level, missing) : 0;
    const right =
      !east.shown && !east.solid && !east.half
        ? sub(1, mul(west.level, missing))
        : 1;
    const edgeTop = (!north.shown && !north.solid) || top !== 0;
    const edgeBottom = (!south.shown && !south.solid) || bottom !== 1;
    const edgeLeft = (!west.shown && !west.solid) || left !== 0;
    const edgeRight = (!east.shown && !east.solid) || right !== 1;
    let fx = edgeLeft ? 0 : edgeRight ? 32 : 16,
      fy = 0;
    if (edgeLeft && edgeRight) {
      fx = 16;
      fy = edgeTop ? 16 : 32;
    } else if (!edgeTop) fy = !edgeLeft && !edgeRight ? 48 : 16;
    if (fy === 16 && edgeLeft !== edgeRight && y % 2 === 0) fy = 32;
    return {
      ...self,
      left,
      right,
      top,
      bottom,
      edgeTop,
      edgeBottom,
      edgeLeft,
      edgeRight,
      fx,
      fy,
    };
  });
  const smooth = memo((x, y) => {
    const self = walls(x, y);
    if (!self.shown) return self;
    const result = { ...self };
    const north = walls(x, y - 1),
      south = walls(x, y + 1);
    const west = walls(x - 1, y),
      east = walls(x + 1, y);
    const average = (value, a, b) => mul(add(add(mul(value, 2), a), b), 0.25);
    if (north.shown && south.shown) {
      if (self.edgeLeft)
        result.left = average(self.left, north.left, south.left);
      if (self.edgeRight)
        result.right = average(self.right, north.right, south.right);
    }
    if (west.shown && east.shown) {
      if (self.edgeTop) result.top = average(self.top, west.top, east.top);
      if (self.edgeBottom)
        result.bottom = average(self.bottom, west.bottom, east.bottom);
    }
    return result;
  });
  const corrected = memo((x, y) => {
    const self = smooth(x, y);
    if (!self.amount) return self;
    const result = { ...self };
    const south = smooth(x, y + 1);
    if (self.edgeTop && !self.edgeBottom && self.edgeLeft !== self.edgeRight) {
      // Source visits columns left-to-right, then rows top-to-bottom. West has
      // already been corrected; east and south still contain smoothed walls.
      if (self.edgeRight) {
        result.right = south.right;
        result.top = corrected(x - 1, y).top;
      } else {
        result.left = south.left;
        result.top = smooth(x + 1, y).top;
      }
    } else if (south.fx === 16 && south.fy === 32) {
      if (self.left > 0.5) {
        result.left = 0;
        result.fx = 0;
        result.fy = 0;
      } else if (self.right < 0.5) {
        result.right = 1;
        result.fx = 32;
        result.fy = 0;
      }
    }
    return result;
  });
  const corners = memo((x, y) => {
    const self = corrected(x, y);
    if (
      !self.amount ||
      self.edgeTop ||
      self.edgeBottom ||
      self.edgeLeft ||
      self.edgeRight
    )
      return self;
    const west = corrected(x - 1, y),
      east = corrected(x + 1, y),
      north = corrected(x, y - 1);
    const result = { ...self };
    if (west.edgeTop && north.edgeLeft) {
      result.fx =
        Math.max(4, Math.trunc(sub(16, mul(corners(x, y - 1).left, 16)))) - 4;
      result.fy =
        48 +
        Math.max(4, Math.trunc(sub(16, mul(corners(x - 1, y).top, 16)))) -
        4;
    } else if (east.edgeTop && north.edgeRight) {
      result.fx =
        32 - Math.min(16, Math.trunc(mul(corners(x, y - 1).right, 16)) - 4);
      result.fy = 48 + Math.max(4, Math.trunc(sub(16, mul(east.top, 16)))) - 4;
    } else return self;
    result.left = result.top = 0;
    result.right = result.bottom = 1;
    return result;
  });
  return (worldX, worldY) => {
    const state = corners(worldX, worldY);
    if (
      !state.shown ||
      (state.half && state.amount && !state.tile.wall && state.amount < 255)
    )
      return { occluded: true, state };
    if (state.kind !== 3) return { notShimmer: true, state };
    if (!Number.isFinite(worldSurface)) reject("shimmer-world-surface-unknown");
    const left = Math.min(0.75, state.left),
      right = Math.max(0.25, state.right),
      top = Math.min(0.75, state.top);
    const bottom =
      state.half && state.solid
        ? Math.min(0.5, Math.max(0.25, state.bottom))
        : Math.max(0.25, state.bottom);
    const sx = Math.trunc(sub(16, mul(right, 16))) + state.fx,
      sy = Math.trunc(sub(16, mul(bottom, 16))) + state.fy;
    const sw = Math.ceil(mul(sub(right, left), 16)),
      sh = Math.ceil(mul(sub(bottom, top), 16));
    if (sx < 0 || sy < 0 || sw < 1 || sh < 1 || sx + sw > 48 || sy + sh > 80)
      reject("shimmer-invalid-source-crop");
    return {
      state,
      sx,
      sy,
      sw,
      sh,
      offsetX: Math.floor(mul(left, 16)),
      offsetY: Math.floor(mul(top, 16)),
      surface: state.fx === 16 && state.fy === 0 && worldY > worldSurface - 40,
    };
  };
}

function configuration(options) {
  const frame = options.frame ?? 0,
    time = options.timeForVisualEffects ?? 0,
    profile = options.colorProfile ?? "xna";
  if (!Number.isSafeInteger(frame) || Math.abs(frame) > 0x7fffffff)
    throw new RangeError("Invalid Shimmer animation frame");
  validateColorInputs(0, 0, time, profile);
  if (
    options.layer !== undefined &&
    !["background", "foreground"].includes(options.layer)
  )
    throw new RangeError("Invalid Shimmer layer");
  return {
    frame: ((frame % 16) + 16) % 16,
    time,
    profile,
    layer: options.layer ?? "background",
  };
}
function sourceReader(region, options) {
  const reader = options.getWorldTile ?? region.getWorldTile;
  return (x, y) =>
    at(region, x, y) ??
    at(region.context, x, y) ??
    (typeof reader === "function" ? reader(x, y) : null);
}
function baseCommand(region, wx, wy, asset, vertices, extra = {}) {
  return {
    kind: "liquid",
    asset,
    sourceAsset: SHIMMER_ASSETS[asset].source,
    x: wx - region.rect.x,
    y: wy - region.rect.y,
    worldX: wx,
    worldY: wy,
    liquidType: 3,
    opacity: 1,
    vertexColors: vertices,
    vertexColorEncoding: "rgba8-premultiplied",
    interpolation: "triangles-tl-br",
    blend: "premultiplied-source-over",
    sourceSampling: "point-clamp",
    inputEncoding: "tconvert-game-raw",
    fidelity: "static-source-shimmer",
    ...extra,
  };
}
function addShapeCommands(region, wx, wy, tile, get, options, cfg) {
  const solid = options.isSolid ?? isSolidOrSlopedTile;
  if (!tile.active || tile.inactive) return [];
  const isSolid = solid(tile);
  if (typeof isSolid !== "boolean")
    reject("shimmer-unknown-solid-neighborhood");
  if (!isSolid || PLATFORMS.has(tile.type)) return [];
  if (SPECIAL.has(tile.type)) reject("shimmer-special-tile-neighborhood");
  const north = get(wx, wy - 1),
    west = get(wx - 1, wy),
    east = get(wx + 1, wy),
    south = get(wx, wy + 1);
  const all = [tile, north, west, east, south];
  for (const n of all) {
    if (!n) reject("shimmer-missing-context");
    if (
      !Number.isInteger(n.liquid ?? 0) ||
      (n.liquid ?? 0) < 0 ||
      (n.liquid ?? 0) > 255
    )
      reject("shimmer-invalid-liquid-level");
    if (
      !Number.isInteger(n.shape ?? 0) ||
      (n.shape ?? 0) < 0 ||
      (n.shape ?? 0) > 5
    )
      reject("shimmer-invalid-shape");
    if (n.active && !n.inactive && typeof solid(n) !== "boolean")
      reject("shimmer-unknown-solid-neighborhood");
    if (n.type === 379 && n.liquid) reject("shimmer-special-tile-neighborhood");
  }
  if (!all.some((n) => n.liquid && n.liquidKind === 4)) return [];
  if (all.some((n) => n.liquid && n.liquidKind !== 4))
    reject("shimmer-mixed-behind-tile-liquids");
  const half = tile.shape === 1,
    slope = half ? 0 : Math.max(0, (tile.shape ?? 0) - 1);
  if (BLOCKS_BACK.has(tile.type) && slope === 0) return [];
  if (half && (west.liquid > 160 || east.liquid > 160)) {
    const registry = options.waterfallRegistry;
    let registered;
    if (registry) {
      if (typeof registry.hasOrigin !== "function")
        reject("shimmer-waterfall-state-required");
      registered = registry.hasOrigin(wx, wy);
      if (typeof registered !== "boolean")
        reject("shimmer-waterfall-state-required");
    } else registered = options.hasWaterfall?.(wx, wy);
    if (registered === undefined) {
      const full = (n) => solid(n) && !(n.shape ?? 0),
        open = (n) => !n.liquid && !full(n) && (n.shape ?? 0) <= 1;
      const possible =
        (north.liquid < 16 || full(north)) && (open(west) || open(east));
      const cloud =
        north.active && CLOUD_ORIGINS.has(north.type) && !tile.liquid;
      if (possible || cloud) reject("shimmer-waterfall-state-required");
      registered = false; // A fresh static origin scan cannot register this cell.
    }
    if (typeof registered !== "boolean")
      reject("shimmer-waterfall-state-required");
    if (registered) return [];
  }
  let fromWest = west.liquid > 0 && slope !== 1 && slope !== 3;
  let fromEast = east.liquid > 0 && slope !== 2 && slope !== 4;
  const fromNorth = north.liquid > 0 && slope !== 3 && slope !== 4;
  const fromSouth = south.liquid > 240 && slope !== 1 && slope !== 2;
  const fromSelf =
    tile.liquid > 0 && tile.shape && (tile.shape !== 1 || tile.liquid > 160);
  if (!(fromWest || fromEast || fromNorth || fromSouth || fromSelf)) return [];
  const level = Math.max(
    fromSelf ? tile.liquid : 0,
    fromWest ? west.liquid : 0,
    fromEast ? east.liquid : 0,
  );
  if (fromSouth && (fromWest || fromEast)) fromWest = fromEast = true;
  let sy = 4,
    sw = 16,
    sh = 16,
    offsetX = 0,
    offsetY = 0;
  if (!(fromNorth && (fromWest || fromEast || fromSouth))) {
    if (fromNorth) sh = tile.shape ? 12 : 4;
    else if (fromSouth && !fromWest && !fromEast) {
      sh = 4;
      offsetY = 12;
    } else {
      offsetY = Math.trunc((256 - level) / 32) * 2;
      sh = 16 - offsetY;
      const northFull = solid(north) && !(north.shape ?? 0);
      sy = !north.liquid && (tile.shape || !northFull) ? 0 : 4;
      if (slope) sy = offsetY;
      else if (!(fromWest && fromEast) && !half) {
        sw = 4;
        if (!fromWest) offsetX = 12;
      }
    }
  }
  if (sh < 1 || sh > 16 || sy < 0 || sy > 16)
    reject("shimmer-invalid-shape-source-crop");
  // Background pass draws the complete liquid strip behind ordinary blocks.
  // The solid-tile prepass uses actual slope masks. Shimmer resets all prior
  // lighting/gradient suppression, so ordinary-water num15 is deliberately absent.
  const masked =
    slope && (cfg.layer === "foreground" || BLOCKS_BACK.has(tile.type));
  const asset = masked ? "LiquidSlope_14.png" : "Liquid_14.png",
    sx = masked ? 18 * (slope - 1) : 0;
  const vertices = shimmerBaseVertexColors(
    wx,
    wy,
    cfg.layer === "foreground" ? 0.75 : 1,
    cfg.time,
    { colorProfile: cfg.profile },
  );
  const dx = (wx - region.rect.x) * 16 + offsetX,
    dy = (wy - region.rect.y) * 16 + offsetY;
  const common = baseCommand(region, wx, wy, asset, vertices, {
    sx,
    sy,
    sw,
    sh,
    dx,
    dy,
    dw: sw,
    dh: sh,
    layer: "behind-tile",
    drawBeforeTiles: true,
    shimmerPart: "behind-tile",
    shimmerPass:
      cfg.layer === "foreground"
        ? "solid-tile-prepass"
        : "background-behind-tile",
    liquidLevel: tile.liquid ?? 0,
  });
  const textureHeight = SHIMMER_ASSETS[asset].height;
  if (sy + sh <= textureHeight) return [common];
  const rows = textureHeight - sy;
  if (rows < 1) reject("shimmer-invalid-shape-source-crop");
  const vertexDomain = { x: dx, y: dy, width: sw, height: sh };
  return [
    { ...common, sh: rows, dh: rows, vertexDomain },
    {
      ...common,
      sy: textureHeight - 1,
      sh: 1,
      dy: dy + rows,
      dh: sh - rows,
      vertexDomain,
      sourceSampling: "point-clamp-bottom",
    },
  ];
}

/** One memoized source-domain sampler. Never changes cells, context or raw bytes.
 * layer background includes the source behind-block pass; foreground includes
 * the solid-tile prepass. Draw marked prepass commands before foreground Tiles. */
export function createShimmerLiquidSampler(region, options = {}) {
  const cfg = configuration(options),
    geometry = createShimmerGeometry(region, options),
    get = sourceReader(region, options);
  return (worldX, worldY) => {
    if (
      !Number.isSafeInteger(worldX) ||
      !Number.isSafeInteger(worldY) ||
      worldX < 0 ||
      worldY < 0
    )
      throw new RangeError("Invalid Shimmer coordinate");
    try {
      if (options.renderMode !== undefined && options.renderMode !== "modern")
        reject("shimmer-legacy-renderer-unsupported");
      const tile = get(worldX, worldY);
      if (!tile) reject("shimmer-missing-context");
      const shape = addShapeCommands(
        region,
        worldX,
        worldY,
        tile,
        get,
        options,
        cfg,
      );
      const g = geometry(worldX, worldY),
        commands = [...shape];
      if (!g.occluded && !g.notShimmer) {
        const { state, sx, sy, sw, sh, offsetX, offsetY, surface } = g;
        const baseOpacity = Math.min(
          1,
          mul(state.alpha, cfg.layer === "foreground" ? 0.75 : 1),
        );
        const vertices = shimmerBaseVertexColors(
          worldX,
          worldY,
          baseOpacity,
          cfg.time,
          { colorProfile: cfg.profile },
        );
        const common = {
          sx,
          sy,
          sw,
          sh,
          dx: (worldX - region.rect.x) * 16 + offsetX,
          dy: (worldY - region.rect.y) * 16 + offsetY,
          dw: sw,
          dh: sh,
          layer: cfg.layer,
          liquidLevel: state.amount,
          visibleLiquidLevel: state.level,
          cacheOpacity: state.alpha,
          frame: cfg.frame,
          timeForVisualEffects: cfg.time,
          colorProfile: cfg.profile,
        };
        commands.push(
          baseCommand(region, worldX, worldY, "water_14.png", vertices, {
            ...common,
            sy: surface ? 1280 : sy + cfg.frame * 80,
            shimmerPart: "base",
            baseOpacity,
            isSurfaceLiquid: surface,
          }),
        );
        const top = sx !== 16 || sy % 80 !== 48;
        if (top || (worldX + worldY) % 2 === 0) {
          const glitterFrame = shimmerFrame(top, worldX, worldY, cfg.time);
          const glitter = shimmerGlitterVertexColors(
            worldX,
            worldY,
            state.alpha,
            top,
            cfg.time,
            { colorProfile: cfg.profile },
          );
          commands.push(
            baseCommand(region, worldX, worldY, "water_14.png", glitter, {
              ...common,
              sx: sx + 48,
              sy: sy + glitterFrame * 80,
              frame: glitterFrame,
              shimmerPart: "glitter",
              glitterTop: top,
            }),
          );
        }
      }
      return {
        supported: true,
        commands,
        occluded: commands.length === 0,
        normalDrawn: commands.some((c) => c.shimmerPart === "base"),
        shapeDrawn: shape.length > 0,
        requiredAssets: [...new Set(commands.map((c) => c.asset))].sort(),
      };
    } catch (error) {
      if (error instanceof Unsupported)
        return { supported: false, reason: error.reason };
      throw error;
    }
  };
}

/** Region planner including saved Shimmer, neighboring solid shapes and derived
 * dry trails. Candidate counts are not interchangeable with stored wet counts. */
export function planShimmerLiquids(region, options = {}) {
  const sample = createShimmerLiquidSampler(region, options),
    get = sourceReader(region, options),
    cfg = configuration(options);
  const result = {
    commands: [],
    requiredAssets: [],
    resolvedCoordinates: [],
    support: {
      mode: "static-source-shimmer",
      layer: cfg.layer,
      savedShimmerCells: 0,
      dryShapeCandidates: 0,
      dryOtherCandidates: 0,
      evaluatedCells: 0,
      drawnCells: 0,
      savedShimmerDrawn: 0,
      dryShapeDrawn: 0,
      occluded: 0,
      unsupported: 0,
      unsupportedByReason: {},
      unsupportedCoordinates: [],
      commandCount: 0,
    },
  };
  const s = result.support,
    { x: ox, y: oy, width, height } = region.rect,
    solid = options.isSolid ?? isSolidOrSlopedTile;
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++) {
      const wx = ox + x,
        wy = oy + y,
        tile = get(wx, wy),
        wet = tile?.liquid > 0 && tile.liquidKind === 4;
      const isWet = (a, b) => {
        const t = get(a, b);
        return t?.liquid > 0 && t.liquidKind === 4;
      };
      const adjacent =
        isWet(wx, wy - 1) ||
        isWet(wx - 1, wy) ||
        isWet(wx + 1, wy) ||
        isWet(wx, wy + 1);
      const dryShape = !tile?.liquid && tile?.shape && solid(tile) && adjacent;
      let candidate = wet || adjacent;
      // A dry bridge can itself feed a ten-cell trail. Search one side column
      // on either side as well as the direct source column, without inventing tiles.
      if (!candidate && !(tile?.active && !tile.inactive && solid(tile)))
        for (let d = 1; d <= 11 && !candidate; d++)
          candidate =
            isWet(wx, wy - d) || isWet(wx - 1, wy - d) || isWet(wx + 1, wy - d);
      if (!candidate) continue;
      if (wet) s.savedShimmerCells++;
      else if (dryShape) s.dryShapeCandidates++;
      else s.dryOtherCandidates++;
      s.evaluatedCells++;
      const out = sample(wx, wy);
      if (!out.supported) {
        s.unsupported++;
        s.unsupportedByReason[out.reason] =
          (s.unsupportedByReason[out.reason] ?? 0) + 1;
        s.unsupportedCoordinates.push({
          x: wx,
          y: wy,
          reason: out.reason,
          savedShimmer: wet,
          dryShape: !!dryShape,
        });
        continue;
      }
      result.resolvedCoordinates.push({
        x: wx,
        y: wy,
        drawn: out.commands.length > 0,
      });
      if (out.commands.length) {
        s.drawnCells++;
        if (wet) s.savedShimmerDrawn++;
        if (dryShape) s.dryShapeDrawn++;
        result.commands.push(...out.commands);
      } else s.occluded++;
    }
  // The background behind-block call precedes modern base/glitter; the solid
  // prepass also precedes Tile draws. Retain per-cell base-before-glitter order.
  result.commands.sort(
    (a, b) => Number(!a.drawBeforeTiles) - Number(!b.drawBeforeTiles),
  );
  result.requiredAssets = [
    ...new Set(result.commands.map((c) => c.asset)),
  ].sort();
  s.commandCount = result.commands.length;
  result.assumptions = {
    ...SHIMMER_STATIC_STATE,
    frame: cfg.frame,
    timeForVisualEffects: cfg.time,
    colorProfile: cfg.profile,
    renderer: "modern",
    lighting: "source-independent",
    waterfallRegistry: "fresh-static-or-explicit",
  };
  return result;
}

/** Native TileBatch triangle interpolation, returning unquantized byte channels.
 * u,v measure the entire destination quad, including any PointClamp split. */
export function interpolateShimmerVertexColors(vertices, u, v) {
  const keys = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
  if (
    !vertices ||
    !Number.isFinite(u) ||
    !Number.isFinite(v) ||
    u < 0 ||
    v < 0 ||
    u > 1 ||
    v > 1 ||
    keys.some(
      (k) =>
        vertices[k]?.length !== 4 ||
        !Array.from(vertices[k]).every(
          (n) => Number.isFinite(n) && n >= 0 && n <= 255,
        ),
    )
  )
    throw new RangeError("Invalid Shimmer vertices or sample position");
  const {
    topLeft: tl,
    topRight: tr,
    bottomRight: br,
    bottomLeft: bl,
  } = vertices;
  return tl.map((c, i) =>
    u >= v
      ? c * (1 - u) + tr[i] * (u - v) + br[i] * v
      : c * (1 - v) + bl[i] * (v - u) + br[i] * u,
  );
}

/** Bounded native-size PointClamp sprite raster. Input/output are raw sampled
 * channels with premultiplied excess, never Canvas straight-alpha ImageData.
 * Alpha-zero glitter RGB survives. The caller composites with P + D*(1-A).
 * This helper is also suitable for source waterfall commands with corner colors. */
export function rasterizeShimmerCommand(
  command,
  rawImage,
  { inputEncoding = "tconvert-game-raw" } = {},
) {
  if (inputEncoding !== "tconvert-game-raw")
    throw new RangeError("Shimmer requires preserved game-raw RGBA channels");
  const c = command;
  if (
    !rawImage ||
    !Number.isSafeInteger(rawImage.width) ||
    !Number.isSafeInteger(rawImage.height) ||
    rawImage.width < 1 ||
    rawImage.height < 1 ||
    rawImage.width > 4096 ||
    rawImage.height > 4096 ||
    rawImage.data?.length !== rawImage.width * rawImage.height * 4
  )
    throw new RangeError("Invalid Shimmer source image");
  if (
    ![c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh].every(
      Number.isSafeInteger,
    ) ||
    c.sx < 0 ||
    c.sy < 0 ||
    c.sw < 1 ||
    c.sh < 1 ||
    c.dw < 1 ||
    c.dh < 1 ||
    c.dw > 64 ||
    c.dh > 64 ||
    c.sw > 64 ||
    c.sh > 64 ||
    c.sx + c.sw > rawImage.width ||
    c.sy + c.sh > rawImage.height
  )
    throw new RangeError("Shimmer crop outside bounded source/destination");
  if (c.interpolation !== undefined && c.interpolation !== "triangles-tl-br")
    throw new RangeError("Unsupported Shimmer interpolation");
  const domain = c.vertexDomain ?? {
    x: c.dx,
    y: c.dy,
    width: c.dw,
    height: c.dh,
  };
  if (
    ![domain.x, domain.y, domain.width, domain.height].every(Number.isFinite) ||
    domain.width < 1 ||
    domain.height < 1
  )
    throw new RangeError("Invalid Shimmer vertex domain");
  const data = new Uint8ClampedArray(c.dw * c.dh * 4);
  for (let y = 0; y < c.dh; y++)
    for (let x = 0; x < c.dw; x++) {
      const u = (c.dx + x + 0.5 - domain.x) / domain.width,
        v = (c.dy + y + 0.5 - domain.y) / domain.height;
      const vertex = interpolateShimmerVertexColors(c.vertexColors, u, v);
      let sx = Math.floor(((x + 0.5) * c.sw) / c.dw),
        sy = Math.floor(((y + 0.5) * c.sh) / c.dh);
      if (c.flipX) sx = c.sw - 1 - sx;
      if (c.flipY) sy = c.sh - 1 - sy;
      const from = ((c.sy + sy) * rawImage.width + c.sx + sx) * 4,
        to = (y * c.dw + x) * 4;
      for (let i = 0; i < 4; i++)
        data[to + i] = Math.round((rawImage.data[from + i] * vertex[i]) / 255);
    }
  return { width: c.dw, height: c.dh, data, encoding: "premultiplied-excess" };
}
