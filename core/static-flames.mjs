import { cellAt } from "./world.mjs";

/** Frozen sprite overlays, not lighting. See docs/static-flames.md. */
export const STATIC_FLAME_TILES = Object.freeze([33, 34, 42, 49, 93, 100]);
export const STATIC_FLAME_STATE = Object.freeze({
  tileFrameSeedLow: 0,
  tileFrameSeedHigh: 0,
  globalTimeWrappedHourly: 0,
  wind: 0,
});
export const STATIC_FLAME_ASSETS = Object.freeze({
  33: Object.freeze({ asset: "Flame_1.png", width: 36, height: 1412 }),
  34: Object.freeze({ asset: "Flame_3.png", width: 214, height: 2000 }),
  42: Object.freeze({ asset: "Flame_13.png", width: 70, height: 2014 }),
  49: Object.freeze({ asset: "Flame_5.png", width: 18, height: 22 }),
  93: Object.freeze({ asset: "Flame_4.png", width: 70, height: 2048 }),
  100: Object.freeze({ asset: "Flame_2.png", width: 142, height: 2016 }),
});
const types = new Set(STATIC_FLAME_TILES);
const platforms = new Set([19, 427, 435, 436, 437, 438, 439]);
const f32 = Math.fround;
const fail = (unsupported) => ({ unsupported });
const color = (value, alpha = 0) => [value, value, value, alpha];
const u32 = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

// Multiply in base 2^16. Every intermediate is an exact JS integer. The source
// consumes only 48 state bits, so the initial upper 16 bits may be discarded.
function next31(seed) {
  const a = seed.low & 0xffff,
    b = seed.low >>> 16,
    c = seed.high & 0xffff;
  const p0 = a * 0xe66d + 11;
  const p1 = b * 0xe66d + a * 0xdeec + Math.floor(p0 / 65536);
  const p2 = c * 0xe66d + b * 0xdeec + a * 5 + Math.floor(p1 / 65536);
  seed.low = ((p0 & 0xffff) | ((p1 & 0xffff) << 16)) >>> 0;
  seed.high = p2 & 0xffff;
  return seed.high * 32768 + (seed.low >>> 17);
}

/** Mutates an unsigned {low,high} seed. max is exclusive; equal ends still
 * advance the generator, matching the source's zero-width power-of-two case. */
export function nextStaticFlameInt(seed, min, max) {
  if (
    !seed ||
    !u32(seed.low) ||
    !u32(seed.high) ||
    !Number.isInteger(min) ||
    !Number.isInteger(max) ||
    min < -0x80000000 ||
    max > 0x7fffffff ||
    max < min ||
    max - min > 0x7fffffff
  )
    throw new RangeError("Invalid static flame random range or seed");
  const bound = max - min;
  if ((bound & -bound) === bound)
    return Math.floor((bound * next31(seed)) / 0x80000000) + min;
  let bits, value;
  do {
    bits = next31(seed);
    value = bits % bound;
  } while (((bits - value + bound - 1) | 0) < 0);
  return value + min;
}

function seedAt(x, y, state) {
  return {
    low: (state.tileFrameSeedLow ^ y) >>> 0,
    high: (state.tileFrameSeedHigh ^ x) >>> 0,
  };
}

function at(region, worldX, worldY) {
  const own = cellAt(region, worldX - region.rect.x, worldY - region.rect.y);
  if (own) return own;
  if (region.context) {
    const tile = cellAt(
      region.context,
      worldX - region.context.rect.x,
      worldY - region.context.rect.y,
    );
    if (tile) return tile;
  }
  return typeof region.getWorldTile === "function"
    ? region.getWorldTile(worldX, worldY)
    : null;
}

function recipe(count = 7, shade = 100, mx = 0.15, my = 0.35, yMax = 1) {
  return {
    count,
    vertexColor: color(shade),
    xMin: -10,
    xMax: 11,
    yMin: -10,
    yMax,
    mx,
    my,
  };
}
function fixed(vertexColor) {
  return { ...recipe(1, 0, 0, 0, 0), xMin: 0, xMax: 0, yMin: 0, vertexColor };
}

function pulse(min, time) {
  let amount = f32(f32(f32(time) % 2) / 2);
  amount = f32(amount * 2);
  if (amount > 1) amount = f32(2 - amount);
  return f32(min + f32(f32(1 - min) * amount));
}

function modernRecipe(relativeStyle, time) {
  if ([4, 5, 6, 8, 9, 11].includes(relativeStyle)) return recipe(0);
  if (relativeStyle === 0) {
    const g = Math.trunc(f32(150 * pulse(0.5, time)));
    return fixed([150, g, g, 50]);
  }
  if (relativeStyle === 1)
    return { ...recipe(3), vertexColor: color(200, 150) };
  if (relativeStyle === 2) {
    const g = Math.trunc(f32(170 * pulse(0.5, time)));
    return fixed([170, g, g, 75]);
  }
  if (relativeStyle === 13)
    return fixed(color(Math.trunc(f32(255 * pulse(0.75, time)))));
  if ([14, 17].includes(relativeStyle)) return fixed(color(200, 150));
  if ([15, 18, 20].includes(relativeStyle))
    return fixed(color(Math.trunc(f32(255 * pulse(0.25, time)))));
  return null;
}

// These recipes follow the call site actually used by normal tile drawing:
// 34/42 use GetTileFlameData in the multi-tile path; the others use the single
// tile path. In particular, chandelier 9 and lamp 12/13 are not interchangeable.
function flameRecipe(type, style, time) {
  const modernStart = type === 33 ? 43 : [34, 42].includes(type) ? 50 : 44;
  if (type !== 49 && style >= modernStart) {
    const modern = modernRecipe(style - modernStart, time);
    if (modern) return modern;
  }
  if (type === 33) {
    if ([5, 6, 7, 10].includes(style)) return recipe(7, 50, 0.075, 0.075, 11);
    if (style === 8) return recipe(7, 50, 0.3, 0.3, 11);
    if (style === 12) return recipe(7, 50, 0.1, 0.15);
    if (style === 14) return recipe(8, 75, 0.1, 0.1, 11);
    if (style === 16) return recipe(4, 75, 0.15, 0.15, 11);
    if ([27, 28].includes(style)) return fixed(color(75));
  } else if (type === 34) {
    if ([8, 17, 20].includes(style)) return recipe(7, 50, 0.075, 0.075, 11);
    if (style === 9)
      return { ...recipe(3, 50, 2, 2, 1), xMin: -1, xMax: 1, yMin: -1 };
    if (style === 11) return recipe(7, 50, 0.3, 0.3, 11);
    if (style === 15) return recipe(7, 50, 0.1, 0.15);
    if (style === 18) return recipe(8, 75, 0.1, 0.1, 11);
    if ([34, 35].includes(style)) return fixed(color(75));
  } else if (type === 42) {
    if (
      [
        1, 3, 6, 8, 19, 27, 29, 30, 31, 32, 36, 39, 44, 53, 57, 60, 62, 66, 69,
      ].includes(style)
    )
      return recipe();
    if ([2, 16, 25].includes(style)) return recipe(7, 50, 0.15, 0.1);
    if (style === 11) return recipe(7, 50, 0.075, 0.075, 11);
    if ([34, 35].includes(style)) return fixed(color(75));
    return recipe(0);
  } else if (type === 93) {
    if (style === 1) return recipe(3, 50, 0.15, 0.15, 11);
    if ([2, 4].includes(style)) return recipe(7, 50, 0.075, 0.075, 11);
    if (style === 3) return { ...recipe(7, 100, 0.2, 0.35), yMin: -20 };
    if (style === 5) return recipe(7, 50, 0.3, 0.3, 11);
    if (style === 9) return recipe(7, 50, 0.1, 0.15);
    if (style === 12)
      return { ...recipe(1, 100, 0.01, 0.01, 11), randomColor: true };
    if (style === 13) return recipe(8, 75, 0.1, 0.1, 11);
    if ([28, 29].includes(style)) return fixed(color(75));
  } else if (type === 100) {
    if (style === 3) return recipe(3, 50, 0.05, 0.15, 11);
    if (style === 6) return recipe(5, 75, 0.15, 0.15, 11);
    if (style === 9) return recipe(7, 100, 0.3, 0.3, 11);
    if (style === 11) return recipe(7, 50, 0.1, 0.15);
    if (style === 13) return recipe(8, 75, 0.1, 0.1, 11);
    if ([28, 29].includes(style)) return fixed(color(75));
  }
  return recipe();
}

function hangingSeed(region, wx, wy, tile, state, revealInvisible) {
  const sizeX = tile.type === 34 ? 3 : 1,
    sizeY = tile.type === 34 ? 3 : 2;
  const rootX = wx - (tile.frameX % (sizeX * 18)) / 18;
  const rootY = wy - (tile.frameY % (sizeY * 18)) / 18;
  const anchor = at(region, rootX, rootY);
  if (!anchor) return fail("Hanging flame requires its object anchor halo");
  if (
    !anchor.active ||
    anchor.type !== tile.type ||
    anchor.frameX !== tile.frameX - (wx - rootX) * 18 ||
    anchor.frameY !== tile.frameY - (wy - rootY) * 18
  )
    return fail("Hanging flame has no matching stored-frame object anchor");
  let seed = { low: 0, high: 0 };
  // DrawMultiTileVinesInWind retains the first nonzero seed, but restarts its
  // random sequence for every cell. The root (0,0), seed zero case is deliberate.
  for (let ax = rootX; ax <= wx; ax++) {
    for (let ay = rootY; ay < rootY + sizeY; ay++) {
      const part = at(region, ax, ay);
      if (!part) return fail("Hanging flame requires its seed-selection halo");
      if (
        part.type === tile.type &&
        (!part.invisibleBlock || revealInvisible)
      ) {
        if (seed.low === 0 && seed.high === 0) seed = seedAt(ax, ay, state);
        if (ax === wx && ay === wy) return { seed, rootX, rootY };
      }
    }
  }
  return fail("Hanging flame cell is not visible in its source draw path");
}

/** Return overlay commands only; append after the furniture body. A result with
 * commands: [] is explicit hidden/no-flame-style completion, never a base sprite.
 * Missing halo or invalid inputs produce {unsupported}, not a guessed seed. */
export function planStaticFlames(region, x, y, tile, options = {}) {
  if (!tile || !types.has(tile.type)) return null;
  if (
    !region?.rect ||
    !region.cells ||
    !Number.isInteger(region.rect.x) ||
    !Number.isInteger(region.rect.y) ||
    !Number.isInteger(region.rect.width) ||
    !Number.isInteger(region.rect.height) ||
    region.rect.width <= 0 ||
    region.rect.height <= 0 ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= region.rect.width ||
    y >= region.rect.height
  )
    return fail("Static flames require world coordinates");
  const wx = region.rect.x + x,
    wy = region.rect.y + y;
  if (wx < 0 || wy < 0 || wx > 0x7fffffff || wy > 0x7fffffff)
    return fail("Static flame coordinates exceed the source integer range");
  const state = options.state ?? STATIC_FLAME_STATE;
  if (
    !state ||
    !u32(state.tileFrameSeedLow) ||
    !u32(state.tileFrameSeedHigh) ||
    !Number.isFinite(state.globalTimeWrappedHourly) ||
    state.globalTimeWrappedHourly < 0 ||
    state.globalTimeWrappedHourly >= 3600 ||
    state.wind !== 0
  )
    return fail(
      "Static flames require an explicit frozen seed, hourly time and zero wind",
    );
  if (!tile.active || (tile.invisibleBlock && !options.revealInvisible))
    return { commands: [], sourceDrawCount: 0, hidden: true };
  if (tile.shape)
    return fail("Static flames do not define slopes or half-blocks");
  const fx = tile.frameX,
    fy = tile.frameY,
    type = tile.type;
  if (
    !Number.isInteger(fx) ||
    !Number.isInteger(fy) ||
    fx < 0 ||
    fy < 0 ||
    fx > 32767 ||
    fy > 32767 ||
    fx % 18 ||
    fy % ([33, 49].includes(type) ? 22 : 18)
  )
    return fail(
      "Static flames require aligned nonnegative saved frame coordinates",
    );
  const stride = { 33: 22, 34: 54, 42: 36, 49: 22, 93: 54, 100: 36 }[type];
  const style =
    Math.floor(fy / stride) + (type === 34 ? 37 * Math.floor(fx / 108) : 0);
  if (
    style > { 33: 63, 34: 70, 42: 70, 49: 0, 93: 64, 100: 64 }[type] ||
    fx >= { 33: 36, 34: 216, 42: 36, 49: 36, 93: 36, 100: 72 }[type] ||
    (type === 34 && fy >= 1998)
  )
    return fail(
      "Static flame style or state lies outside the verified source atlas",
    );
  let seed = seedAt(wx, wy, state),
    offsetY = [33, 49].includes(type) ? -4 : 2;
  if (type === 34 || type === 42) {
    const hanging = hangingSeed(
      region,
      wx,
      wy,
      tile,
      state,
      options.revealInvisible,
    );
    if (hanging.unsupported) return hanging;
    seed = hanging.seed;
    offsetY = -2;
    if (type === 42 && hanging.rootY > 0) {
      const above = at(region, hanging.rootX, hanging.rootY - 1);
      if (!above) return fail("Hanging flame requires its ceiling anchor halo");
      if (above.active && platforms.has(above.type) && !above.shape)
        offsetY -= 8;
    }
  }
  const r = flameRecipe(type, style, state.globalTimeWrappedHourly);
  const offState =
    type === 34 ? fx % 108 >= 54 : type === 100 ? fx >= 36 : fx >= 18;
  // Off state retains the source draws: imported packs may contain nonzero
  // off-column pixels. Only an actual zero-count recipe omits its commands.
  if (r.count === 0)
    return {
      commands: [],
      sourceDrawCount: r.count,
      style,
      offState,
      noFlameStyle: r.count === 0,
    };
  const asset = STATIC_FLAME_ASSETS[type];
  const wrap = type === 42 || type === 100 ? 2016 : type === 93 ? 1998 : 0;
  const sx = fx + (wrap ? Math.floor(fy / wrap) * (type === 100 ? 72 : 36) : 0);
  const sy = wrap ? fy % wrap : fy;
  const sh = [33, 49].includes(type) ? 20 : 16;
  if (sx + 16 > asset.width || sy + sh > asset.height)
    return fail("Static flame source crop exceeds the verified texture bounds");
  const commands = [];
  for (let index = 0; index < r.count; index++) {
    const jitterX = f32(nextStaticFlameInt(seed, r.xMin, r.xMax) * f32(r.mx));
    const jitterY = f32(nextStaticFlameInt(seed, r.yMin, r.yMax) * f32(r.my));
    const vertexColor = r.randomColor
      ? [
          nextStaticFlameInt(seed, 90, 111),
          nextStaticFlameInt(seed, 90, 111),
          nextStaticFlameInt(seed, 90, 111),
          0,
        ]
      : r.vertexColor.slice();
    commands.push({
      asset: asset.asset,
      type,
      sx,
      sy,
      sw: 16,
      sh,
      offsetX: jitterX,
      offsetY: offsetY + jitterY,
      flipX: false,
      opacity: 1,
      paintId: 0,
      staticOverlay: true,
      vertexColor,
      fidelity: "static-frozen-seed-flame",
    });
  }
  return { commands, sourceDrawCount: r.count, style, offState };
}
