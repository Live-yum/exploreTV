/** Frozen, fullbright interior liquid geometry. See docs/liquid-visible-level.md. */
const PLATFORMS = new Set([19, 427, 435, 436, 437, 438, 439]);
const SPECIAL = new Set([379, 518, 546]);
const WATER_STYLES = new Set([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13]);
const LENGTH = [10, 3, 2, 10];
const FRONT_ALPHA = [0.6, 0.95, 0.95, 0.75];
const f = Math.fround;
const add = (a, b) => f(a + b);
const sub = (a, b) => f(a - b);
const mul = (a, b) => f(a * b);
const clock = (n) =>
  Number.isFinite(n) ? ((Math.trunc(n) % 16) + 16) % 16 : 0;
const clampAlpha = (n) =>
  Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
const attenuation = LENGTH.map((length) => {
  const step = f(1 / (length + 1));
  const levels = [1];
  for (let i = 1; i <= length; i++) levels.push(sub(levels[i - 1], step));
  return levels;
});

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
export function createVisibleLiquidSampler(region, options = {}) {
  const rect = region?.rect;
  if (
    !rect ||
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    region.cells?.length !== rect.width * rect.height
  )
    throw new RangeError("Invalid visible-liquid region");
  const waterStyle = options.waterStyle ?? 0;
  if (!WATER_STYLES.has(waterStyle))
    throw new RangeError("Invalid water atlas");
  const worldSurface = options.worldSurface ?? region.source?.worldSurface;
  const frame = clock(options.frame),
    waterfallFrame = clock(options.waterfallFrame);
  const lavaOpacity = clampAlpha(options.lavaOpacity ?? 1);
  const waterOpacity = clampAlpha(options.waterOpacity ?? 1);
  const layer = options.layer === "foreground" ? "foreground" : "background";
  const reader = options.getWorldTile ?? region.getWorldTile;
  let depth = 0;
  const memo = (compute) => {
    const cache = new Map();
    return (x, y) => {
      // sample() validates integer coordinates and every dependency adds an
      // integer offset. Pack the common world range without allocating strings;
      // negative, large and boundary-crossing dependencies keep their exact
      // string identity. Number and string keys cannot collide in this Map.
      const key =
        x >= 0 && x < 32768 && y >= 0 && y < 32768
          ? x * 32768 + y
          : `${x},${y}`;
      // These seven memoized stages return state objects or cached Unsupported
      // errors, never undefined, so a hit needs only one lookup.
      const value = cache.get(key);
      if (value !== undefined) {
        if (value instanceof Unsupported) throw value;
        return value;
      }
      // Pathological uninterrupted partial columns/corner chains are reported,
      // never silently truncated or allowed to exhaust the JavaScript stack.
      if (++depth > 384) {
        depth--;
        reject("visible-dependency-depth");
      }
      try {
        const value = compute(x, y);
        cache.set(key, value);
        return value;
      } catch (error) {
        if (
          error instanceof Unsupported &&
          error.reason !== "visible-dependency-depth"
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
    if (!tile) reject("visible-missing-context");
    const amount = tile.liquid ?? 0,
      shape = tile.shape ?? 0;
    if (!Number.isInteger(amount) || amount < 0 || amount > 255)
      reject("visible-invalid-liquid-level");
    if (!Number.isInteger(shape) || shape < 0 || shape > 5)
      reject("visible-invalid-shape");
    const kind = amount ? tile.liquidKind - 1 : 0;
    if (amount && ![0, 1, 2, 3].includes(kind))
      reject("visible-unknown-liquid-kind");
    let solid = false;
    if (tile.active && !tile.inactive && !PLATFORMS.has(tile.type)) {
      if (SPECIAL.has(tile.type)) reject("visible-special-tile-neighborhood");
      const known = options.isSolid?.(tile);
      if (typeof known !== "boolean")
        reject("visible-unknown-solid-neighborhood");
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
  return function sample(worldX, worldY) {
    if (!Number.isSafeInteger(worldX) || !Number.isSafeInteger(worldY))
      throw new RangeError("Invalid visible-liquid coordinate");
    try {
      const state = corners(worldX, worldY);
      const behindTileSuppressed =
        state.half && state.solid && state.tile.wall > 0;
      if (
        !state.shown ||
        (state.half &&
          state.amount > 0 &&
          !state.tile.wall &&
          state.amount < 255)
      )
        return { supported: true, occluded: true, behindTileSuppressed };
      if (state.kind === 3) reject("visible-shimmer");
      if (!Number.isFinite(worldSurface))
        reject("visible-world-surface-unknown");
      const left = Math.min(0.75, state.left),
        right = Math.max(0.25, state.right);
      const top = Math.min(0.75, state.top);
      const bottom =
        state.half && state.solid
          ? Math.min(0.5, Math.max(0.25, state.bottom))
          : Math.max(0.25, state.bottom);
      const sx = Math.trunc(sub(16, mul(right, 16))) + state.fx;
      const surface =
        state.fx === 16 && state.fy === 0 && worldY > worldSurface - 40;
      const sy = surface
        ? 1280
        : Math.trunc(sub(16, mul(bottom, 16))) +
          state.fy +
          (sx === 16 ? waterfallFrame : frame) * 80;
      const sw = Math.ceil(mul(sub(right, left), 16)),
        sh = Math.ceil(mul(sub(bottom, top), 16));
      // Exact known water atlases are 48×1360. Invalid source reads are never
      // replaced by clipping the source rectangle and stretching the remainder.
      if (
        sx < 0 ||
        sy < 0 ||
        sw < 1 ||
        sh < 1 ||
        sx + sw > 48 ||
        sy + sh > 1360
      )
        reject("visible-invalid-source-crop");
      const texture = state.kind === 0 ? waterStyle : state.kind === 1 ? 1 : 11;
      const asset = `water_${texture}.png`;
      const typeAlpha =
        state.kind === 0 ? waterOpacity : state.kind === 1 ? lavaOpacity : 1;
      const frontOpacity = Math.min(
        1,
        state.alpha * FRONT_ALPHA[state.kind] * typeAlpha,
      );
      const alpha =
        layer === "foreground"
          ? frontOpacity
          : Math.min(1, state.alpha * typeAlpha);
      const x = worldX - rect.x,
        y = worldY - rect.y;
      const command = {
        kind: "liquid",
        asset,
        sourceAsset: `Images/Misc/${asset}`,
        sx,
        sy,
        sw,
        sh,
        dx: x * 16 + Math.floor(mul(left, 16)),
        dy: y * 16 + Math.floor(mul(top, 16)),
        dw: sw,
        dh: sh,
        opacity: alpha,
        frontOpacity,
        layer,
        liquidType: state.kind,
        liquidLevel: state.amount,
        visibleLiquidLevel: state.level,
        x,
        y,
        worldX,
        worldY,
        fidelity: "static-source-visible-level",
      };
      return { supported: true, command, behindTileSuppressed };
    } catch (error) {
      if (error instanceof Unsupported)
        return { supported: false, reason: error.reason };
      throw error;
    }
  };
}
