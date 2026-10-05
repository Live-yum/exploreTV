import { Reader, FormatError, cellAt } from "./world.mjs";

/** Original, bounded static geometry. See docs/static-furniture-next.md. */
export const STATIC_FURNITURE_NEXT_TILES = Object.freeze([
  12, 13, 16, 26, 29, 31, 33, 34, 42, 49, 50, 55, 77, 79, 81, 82, 83, 84, 85,
  86, 87, 88, 89, 90, 91, 93, 94, 100, 101, 104, 106, 114, 124, 125, 132, 134,
  135, 136, 137, 138, 141, 215, 219, 220, 227, 231, 240, 241, 242, 245, 246,
  305, 324, 349, 354, 355, 377, 411, 443, 467, 469, 488, 519, 529, 530, 549,
  561, 567, 571, 574, 575, 576, 577, 578, 664, 713, 714, 715, 716, 751, 752,
]);
const supported = new Set(STATIC_FURNITURE_NEXT_TILES);
export const STATIC_FURNITURE_PENDING_FLAMES = Object.freeze({
  33: "Flame_1.png",
  34: "Flame_3.png",
  42: "Flame_13.png",
  49: "Flame_5.png",
  93: "Flame_4.png",
  100: "Flame_2.png",
});
const beams = new Set([124, 561, 574, 575, 576, 577, 578]);
const platforms = new Set([19, 427, 435, 436, 437, 438, 439]);
const height18 = new Set([16, 26, 77, 137, 138, 488, 664, 713, 714, 715, 716]);
const top2 = new Set([
  85, 89, 93, 104, 134, 219, 220, 231, 305, 349, 354, 355, 377, 519, 571,
]);
const herbs = new Set([82, 83, 84]);
const corrupt = new Set([23, 661, 25, 112, 163, 398, 400, 636]);
const crimson = new Set([199, 662, 203, 234, 200, 399, 401, 205]);
const hallow = new Set([109, 492, 117, 116, 164, 402, 403, 115]);
// Initialization facts, including ranges 255–268, 435–439 and 727–732.
const solids = new Set([
  0, 1, 2, 6, 7, 8, 9, 10, 19, 22, 23, 25, 30, 37, 38, 39, 40, 41, 43, 44, 45,
  46, 47, 48, 53, 54, 56, 57, 58, 59, 60, 63, 64, 65, 66, 67, 68, 70, 75, 76,
  107, 108, 109, 111, 112, 116, 117, 118, 119, 120, 121, 122, 123, 127, 130,
  137, 138, 140, 145, 146, 147, 148, 150, 151, 152, 153, 154, 155, 156, 157,
  158, 159, 160, 161, 162, 163, 164, 166, 167, 168, 169, 170, 175, 176, 177,
  179, 180, 181, 182, 183, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197,
  198, 199, 200, 202, 203, 204, 206, 208, 211, 221, 222, 223, 224, 225, 226,
  229, 230, 232, 234, 235, 239, 248, 249, 250, 251, 252, 253, 255, 256, 257,
  258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 272, 273, 274, 284,
  311, 312, 313, 315, 321, 322, 325, 326, 327, 328, 329, 345, 346, 347, 348,
  350, 357, 367, 368, 369, 370, 371, 379, 380, 381, 383, 384, 385, 387, 388,
  396, 397, 398, 399, 400, 401, 402, 403, 404, 407, 408, 409, 415, 416, 417,
  418, 421, 422, 426, 427, 430, 431, 432, 433, 434, 435, 436, 437, 438, 439,
  446, 447, 448, 458, 459, 460, 472, 473, 474, 476, 477, 478, 479, 481, 482,
  483, 484, 492, 495, 496, 498, 500, 501, 502, 503, 507, 508, 512, 513, 514,
  515, 516, 517, 534, 535, 536, 537, 539, 540, 541, 546, 557, 562, 563, 566,
  618, 625, 626, 627, 628, 633, 635, 641, 659, 661, 662, 664, 666, 667, 668,
  669, 670, 671, 672, 673, 674, 675, 676, 677, 678, 679, 680, 681, 682, 683,
  684, 685, 686, 687, 688, 689, 690, 691, 692, 708, 711, 712, 713, 714, 715,
  716, 717, 718, 719, 722, 726, 727, 728, 729, 730, 731, 732, 734, 735, 736,
  737, 738, 739, 740, 741, 742, 743, 744, 745, 746, 747, 748, 749, 750,
]);
const beamFrames = [
  [162, 54],
  [108, 54],
  [216, 0],
  [18, 72],
  [162, 0],
  [0, 72],
  [108, 72],
  [18, 36],
  [108, 0],
  [90, 0],
  [18, 54],
  [72, 0],
  [0, 54],
  [0, 0],
  [18, 0],
  [18, 18],
];
const neighborOffsets = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];
const fail = (unsupported) => ({ unsupported });
const modulo = (value, period) => ((value % period) + period) % period;

function at(region, x, y) {
  const own = cellAt(region, x, y);
  if (own) return own;
  const wx = region.rect.x + x,
    wy = region.rect.y + y;
  if (region.context) {
    const t = cellAt(
      region.context,
      wx - region.context.rect.x,
      wy - region.context.rect.y,
    );
    if (t) return t;
  }
  return typeof region.getWorldTile === "function"
    ? region.getWorldTile(wx, wy)
    : null;
}

function sprite(tile, extra = {}) {
  return {
    asset: `Tiles_${tile.type}.png`,
    type: tile.type,
    sx: tile.frameX,
    sy: tile.frameY,
    sw: 16,
    sh: 16,
    offsetX: 0,
    offsetY: 0,
    flipX: false,
    opacity: 1,
    fidelity: "static-stored-frame",
    ...extra,
  };
}

/** Read the post-load herb state by walking the modern header, never searching
 * for offsets. The returned state can be attached as region.herbContext. */
export function readWorldHerbContext(world) {
  if (
    !world ||
    !Number.isInteger(world.version) ||
    world.version < 269 ||
    world.version > 326
  )
    throw new FormatError("Herb metadata requires WLD version 269..326");
  const start = world.sections?.[0],
    end = world.sections?.[1];
  if (
    !(world.bytes instanceof Uint8Array) ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > world.bytes?.length
  )
    throw new FormatError("Invalid herb header section bounds");
  const r = new Reader(world.bytes, end);
  r.pos = start;
  const bool = () => {
    const n = r.u8();
    if (n > 1) throw new FormatError("Invalid boolean in herb metadata");
    return n === 1;
  };
  r.str();
  r.str();
  r.skip(24 + 4 + 16);
  const height = r.i32(),
    width = r.i32();
  if (
    height !== world.height ||
    width !== world.width ||
    height <= 0 ||
    width <= 0
  )
    throw new FormatError("Herb metadata world dimensions disagree");
  r.skip(4 + 5); // game mode, first five special-world flags
  const remixWorld = bool();
  r.skip(2 + (world.version >= 302 ? 1 : 0));
  r.skip(8 + (world.version >= 284 ? 8 : 0) + 1 + 68 + 8);
  const worldSurface = r.f64();
  r.skip(8); // rock layer
  const time = r.f64(),
    dayTime = bool(),
    moonPhase = r.i32(),
    bloodMoon = bool();
  bool(); // eclipse
  r.skip(8 + 1 + 11 + 7 + 3 + 4 + 2 + 20 + 8 + 1);
  const raining = bool();
  r.skip(4); // rain duration
  r.need(4);
  const cloudAlpha = r.view.getFloat32(r.pos, true);
  r.skip(4);
  if (
    !Number.isFinite(worldSurface) ||
    worldSurface < 0 ||
    worldSurface > height ||
    !Number.isFinite(time) ||
    time < 0 ||
    time > 86400 ||
    !Number.isInteger(moonPhase) ||
    moonPhase < 0 ||
    moonPhase > 7 ||
    !Number.isFinite(cloudAlpha) ||
    cloudAlpha < 0 ||
    cloudAlpha > 1
  )
    throw new FormatError("Invalid herb metadata values");
  return {
    dayTime,
    time,
    moonPhase,
    bloodMoon,
    raining,
    cloudAlpha,
    worldSurface,
    remixWorld,
    worldHeight: height,
    worldWidth: width,
    provenance: {
      formatVersion: world.version,
      startOffset: start,
      endOffset: r.pos,
      sourceRevision: "8255d34616c780af12079425ac92a0a7aed87d71",
    },
  };
}

export function isStaticHerbHarvestable(style, worldY, state) {
  if (!Number.isInteger(style) || style < 0 || style > 6) return null;
  if (style === 2 || style === 6) return false;
  if (
    !state ||
    typeof state.dayTime !== "boolean" ||
    typeof state.bloodMoon !== "boolean" ||
    typeof state.raining !== "boolean" ||
    typeof state.remixWorld !== "boolean" ||
    !Number.isInteger(state.moonPhase) ||
    state.moonPhase < 0 ||
    state.moonPhase > 7 ||
    !Number.isFinite(state.time) ||
    state.time < 0 ||
    !Number.isFinite(state.cloudAlpha) ||
    state.cloudAlpha < 0 ||
    state.cloudAlpha > 1 ||
    !Number.isFinite(state.worldSurface) ||
    !Number.isInteger(state.worldHeight)
  )
    return null;
  if (style === 0) return state.dayTime;
  if (style === 1) return !state.dayTime;
  if (style === 3)
    return !state.dayTime && (state.bloodMoon || state.moonPhase === 0);
  if (style === 4) return state.raining || state.cloudAlpha > 0;
  const sheltered = state.remixWorld
    ? worldY < state.worldHeight - 350
    : worldY > state.worldSurface;
  return (!state.raining || sheltered) && state.time > 40500;
}

function beam(region, x, y, tile, options) {
  if (tile.frameX != null || tile.frameY != null)
    return fail("Beam requires reconstructed rather than saved frames");
  const neighbors = neighborOffsets.map(([dx, dy]) =>
    at(region, x + dx, y + dy),
  );
  if (neighbors.some((t) => !t))
    return fail("Beam framing requires the eight-cell halo");
  if (
    neighbors.some(
      (t) =>
        t.active &&
        (!Number.isInteger(t.type) ||
          t.type < 0 ||
          t.type >= 754 ||
          !Number.isInteger(t.shape ?? 0) ||
          (t.shape ?? 0) < 0 ||
          (t.shape ?? 0) > 5),
    )
  )
    return fail("Unknown beam neighbor type or shape");
  const connect = neighbors.map((n, i) => {
    if (
      !n.active ||
      (!options.revealInvisible && !!n.invisibleBlock !== !!tile.invisibleBlock)
    )
      return false;
    const shape = n.shape || 0;
    if (
      (i === 0 && shape >= 4) ||
      (i === 3 && (shape === 2 || shape === 3)) ||
      (i === 1 && (shape === 2 || shape === 4)) ||
      (i === 2 && (shape === 3 || shape === 5))
    )
      return false;
    if (i === 3 && shape === 1) return false;
    if (i === 0 || i === 3) {
      if (
        !platforms.has(n.type) &&
        ((i === 0 && shape >= 1 && shape <= 3) || (i === 3 && shape >= 4))
      )
        return true;
      if (tile.type === 124 && !platforms.has(n.type) && solids.has(n.type))
        return true;
    }
    return n.type === tile.type;
  });
  // Active stone 379 is toggled by game runtime state, unavailable in the WLD.
  if (
    tile.type === 124 &&
    [neighbors[0], neighbors[3]].some((n) => n.active && n.type === 379)
  )
    return fail(
      "Wooden-beam attachment to active stone requires runtime solidity",
    );
  let mask = 0;
  for (let i = 0; i < 4; i++) if (connect[i]) mask |= 1 << i;
  let [sx, sy] = beamFrames[mask];
  if (mask === 15) {
    const [nw, ne, sw, se] = connect.slice(4);
    if (!nw && !ne) [sx, sy] = [108, 18];
    else if (!sw && !se) [sx, sy] = [108, 36];
    else if (!nw && !sw) [sx, sy] = [180, 0];
    else if (!ne && !se) [sx, sy] = [198, 0];
  }
  return {
    commands: [
      sprite(tile, {
        sx,
        sy: tile.type === 561 ? (sy / 18) * 22 : sy,
        sh: tile.type === 561 ? 20 : 18,
        offsetY: tile.type === 561 ? -2 : 0,
        fidelity: "approximate-static-beam-variation-zero",
      }),
    ],
  };
}

function biomeIndex(region, x, y, width) {
  const count = [0, 0, 0];
  for (let i = 0; i < width; i++) {
    const n = at(region, x + i, y);
    if (!n) return null;
    if (corrupt.has(n.type)) count[0]++;
    if (crimson.has(n.type)) count[1]++;
    if (hallow.has(n.type)) count[2]++;
  }
  const max = Math.max(...count);
  return max === 0 ? 0 : count[2] === max ? 1 : count[1] === max ? 2 : 3;
}

function anchoredBody(region, x, y, tile) {
  if (![0, 18].includes(tile.frameX) || ![0, 18].includes(tile.frameY))
    return fail("Anchored two-cell object has an unknown saved segment");
  const col = tile.frameX / 18,
    row = tile.frameY / 18;
  const anchor = at(region, x - col, y - row);
  if (
    !anchor?.active ||
    anchor.type !== tile.type ||
    anchor.frameX !== 0 ||
    anchor.frameY !== 0
  )
    return fail("Anchored object requires its saved origin cell");
  const big = tile.type === 751;
  const widths = big ? [25, 31] : [18, 18],
    heights = big ? [24, 22] : [14, 24];
  const phase = big
    ? modulo(region.rect.x + x - col + (region.rect.y + y - row) * 2, 7) * 46
    : 0;
  const command = sprite(tile, {
        sx: col ? widths[0] : 0,
        sy: phase + (row ? heights[0] : 0),
        sw: widths[col],
        sh: heights[row],
        offsetX: col ? 0 : big ? -9 : -2,
        offsetY: row ? 0 : big ? -8 : 2,
        paintId: anchor.paint || 0,
        fidelity: "static-anchored-body-partition",
      });
  // The verified 752 atlas is 38x36, while the source requests 36x38.
  // Native point-clamp sampling repeats its final row for the final two pixels.
  if (!big && row) {
    const main = { ...command, sh: 22 };
    return { commands: [main, ...[22, 23].map(offsetY => ({
      ...command, sy: 35, sh: 1, offsetY, fidelity: "static-anchored-point-clamp",
    }))] };
  }
  return { commands: [command] };
}

// [type, style stride, style axis, styles, masks, source wrap width/height].
const furnitureGlows = [
  [79, 36, "y", [27, 28], [53, 114], null, 36],
  [90, 36, "y", [27, 28], [52, 113], null, 36],
  [87, 54, "x", [26, 27], [64, 121], 54, null],
  [88, 54, "x", [24, 25], [59, 120], 54, null],
  [89, 54, "x", [29, 30], [66, 123], 54, null],
  [101, 54, "x", [28, 29], [60, 115], 54, null],
  [104, 36, "x", [24, 25], [51, 118], 36, null],
  [467, 36, "x", [48, 49], [56, 117], 36, null],
  [33, 22, "y", [26], [61], null, 22],
  [93, 54, "y", [27], [62], null, 54],
  [100, 36, "y", [27], [68], null, 36],
];

/** The caller applies visibility, asset bounds, paint and compositing. No
 * unknown frame-important tile is admitted by a generic 16-pixel fallback. */
export function planStaticFurnitureNext(region, x, y, tile, options = {}) {
  if (!tile || !supported.has(tile.type)) return null;
  if (
    !region?.rect ||
    !Number.isInteger(region.rect.x) ||
    !Number.isInteger(region.rect.y) ||
    !Number.isInteger(region.rect.width) ||
    !Number.isInteger(region.rect.height) ||
    region.rect.width < 1 ||
    region.rect.height < 1 ||
    region.rect.width > 512 ||
    region.rect.height > 512 ||
    region.rect.width * region.rect.height > 65536 ||
    !Array.isArray(region.cells) ||
    region.cells.length !== region.rect.width * region.rect.height ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= region.rect.width ||
    y >= region.rect.height
  )
    return fail("Static furniture requires world coordinates");
  if (tile.shape)
    return fail("Static furniture does not define slope or half-block drawing");
  if (beams.has(tile.type)) return beam(region, x, y, tile, options);
  if (
    !Number.isInteger(tile.frameX) ||
    !Number.isInteger(tile.frameY) ||
    tile.frameX < 0 ||
    tile.frameY < 0
  )
    return fail(
      "Static furniture requires nonnegative saved frame coordinates",
    );
  if (tile.type === 751 || tile.type === 752)
    return anchoredBody(region, x, y, tile);
  const c = sprite(tile),
    commands = [c],
    fx = tile.frameX,
    fy = tile.frameY;
  const wx = region.rect.x + x,
    wy = region.rect.y + y;
  if (height18.has(tile.type)) c.sh = 18;
  if (top2.has(tile.type)) c.offsetY = 2;
  if (tile.type === 33 || tile.type === 49) {
    c.sh = 20;
    c.offsetY = -4;
  }
  if ([411, 467, 469].includes(tile.type) && fy === 18) c.sh = 18;
  if (tile.type === 114 && fy > 0) c.sh = 18;
  if (tile.type === 132 || tile.type === 135) {
    c.sh = 18;
    c.offsetY = 2;
  }
  if (tile.type === 136) {
    c.offsetY = fx === 0 ? 2 : 0;
    c.offsetX = fx === 18 ? -2 : fx === 36 ? 2 : 0;
  }
  if (tile.type === 443) c.offsetY = Math.floor(fx / 36) >= 2 ? -2 : 2;
  if (tile.type === 519 || tile.type === 571) {
    c.flipX = wx % 2 === 0;
    c.fidelity = "static-zero-wind";
  }
  if (tile.type === 549) {
    c.offsetY = 2;
    c.fidelity = "static-zero-wind";
  }
  if (tile.type === 81) {
    c.sw = 24;
    c.sh = 26;
    c.offsetX = -4;
    c.offsetY = -8;
    c.flipX = wx % 2 === 0;
  }
  if (tile.type === 324) {
    c.sw = c.sh = 20;
    c.offsetX = c.offsetY = -2;
    c.flipX = wx % 2 === 0;
  }
  if (tile.type === 567) {
    c.sw = 26;
    c.sh = 18;
    c.offsetX = -5;
    c.offsetY = fy === 0 ? -2 : 0;
    c.flipX = wx % 2 === 0;
  }
  if (herbs.has(tile.type)) {
    if (fx % 18 || fx > 108 || fy !== 0)
      return fail("Unknown herb species or saved frame");
    c.sh = 20;
    c.offsetY = -2;
    c.flipX = wx % 2 === 0;
    c.fidelity = "static-zero-wind";
    if (tile.type === 83) {
      const blooming = isStaticHerbHarvestable(
        fx / 18,
        wy,
        options.herbContext || region.herbContext,
      );
      if (blooming === null)
        return fail("Mature herb requires saved day, moon and rain context");
      if (blooming) {
        c.asset = "Tiles_84.png";
        c.type = 84;
        if (fx === 90 && !tile.fullbrightBlock) {
          const pulse = options.mouseTextColor;
          if (!Number.isInteger(pulse) || pulse < 0 || pulse > 255)
            return fail(
              "Blooming fireblossom requires an explicit static glow pulse",
            );
          c.vertexColor = [255, pulse, pulse, Math.floor(pulse / 2)];
        }
      }
    }
  }
  if (tile.type === 227) {
    if (fx % 34 || fy !== 0) return fail("Unknown dye-plant saved frame");
    if (fx === 204)
      return fail("Cactus dye-plant variant requires the cactus root biome");
    c.sw = 32;
    c.sh = 38;
    c.offsetX = -8;
    c.offsetY = fx === 238 ? -6 : -20;
    c.flipX = wx % 2 === 0;
  }
  if (tile.type === 529 || tile.type === 530) {
    const wide = tile.type === 530;
    const belowX = wide ? x - (fx % 54) / 18 : x;
    const belowY = wide ? y - (fy % 36) / 18 + 2 : y + 1;
    const biome = biomeIndex(region, belowX, belowY, wide ? 4 : 1);
    if (biome === null)
      return fail("Coastal plant requires the source biome sampling halo");
    if (wide) {
      c.sy += biome * 36;
      c.offsetY = 2;
    } else {
      const width = region.source?.width ?? region.treeContext?.worldWidth;
      const beach = region.treeContext?.beachDistance;
      if (!biome && (!Number.isInteger(width) || !Number.isFinite(beach)))
        return fail("Sea oats require world width and beach distance");
      const style = biome
        ? biome + 1
        : wx < beach || wx > width - beach
          ? 1
          : 0;
      c.sy = style * 34;
      c.sh = 32;
      c.offsetY = -14;
      c.flipX = wx % 2 === 0;
    }
    c.fidelity = "static-biome-zero-wind";
  }
  if ([79, 90, 100, 42].includes(tile.type)) {
    const page = Math.floor(fy / 2016);
    c.sy %= 2016;
    c.sx += page * { 79: 144, 90: 144, 100: 72, 42: 36 }[tile.type];
    if (tile.type === 79) c.sh = 18;
  }
  if ([87, 88, 89, 101].includes(tile.type)) {
    const page = Math.floor(fx / 1998);
    c.sx %= 1998;
    c.sy += page * (tile.type === 101 ? 72 : 36);
  }
  if (tile.type === 104) {
    c.sx %= 2016;
    c.sy += Math.floor(fx / 2016) * 90;
  }
  if (tile.type === 93) {
    c.sy %= 1998;
    c.sx += Math.floor(fy / 1998) * 36;
  }
  if (tile.type === 100) c.offsetY = 2;
  if ([34, 42, 91].includes(tile.type)) {
    c.offsetY = -2;
    c.fidelity = "static-zero-wind";
    if (tile.type !== 34) {
      const height = tile.type === 91 ? 54 : 36;
      const topY = y - (fy % height) / 18;
      const n = at(region, x, topY - 1);
      if (!n) return fail("Hanging furniture requires its ceiling anchor halo");
      if (n.active && platforms.has(n.type) && !(n.shape || 0)) c.offsetY -= 8;
    }
  }
  if (tile.type === 215) {
    c.offsetY = 2;
    c.fidelity = "static-animation-zero";
    if (fy >= 36) c.sy += 252;
    else {
      const style = Math.floor(fx / 54);
      commands.push({
        ...c,
        asset: "Flame_15.png",
        paintId: 0,
        staticOverlay: true,
        vertexColor:
          style === 5
            ? [255, 0, 0, 0]
            : style === 14
              ? [50, 50, 100, 20]
              : style === 15
                ? [255, 255, 255, 200]
                : [255, 255, 255, 0],
        fidelity: "static-campfire-flame-zero",
      });
    }
  }
  for (const [
    id,
    stride,
    axis,
    styles,
    masks,
    wrapX,
    wrapY,
  ] of furnitureGlows) {
    if (tile.type !== id) continue;
    if (
      (id === 33 && fx >= 18) ||
      (id === 34 && fx >= 54) ||
      (id === 100 && fx >= 36)
    )
      break;
    const index = styles.indexOf(Math.floor((axis === "x" ? fx : fy) / stride));
    if (index < 0) break;
    commands.push({
      ...c,
      asset: `Glow_${masks[index]}.png`,
      sx: wrapX ? fx % wrapX : fx,
      sy: wrapY ? fy % wrapY : fy,
      paintId: 0,
      staticOverlay: true,
      vertexColor: index === 0 ? [250, 250, 250, 0] : [100, 100, 100, 0],
      fidelity: "static-furniture-glow-initial",
    });
    break;
  }
  if (STATIC_FURNITURE_PENDING_FLAMES[tile.type])
    return {
      commands,
      partial: true,
      pendingFlames: true,
      unsupported:
        "Furniture flame overlay requires source-confirmed frozen flame geometry",
      dependencies: [STATIC_FURNITURE_PENDING_FLAMES[tile.type]],
    };
  return { commands };
}
