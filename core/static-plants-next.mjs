import { cellAt } from "./world.mjs";

/** Original static plans. Source contracts: docs/static-plants-next.md. */
export const STATIC_PLANTS_NEXT_TILES = Object.freeze([80, 332, 380, 518, 656]);
const supported = new Set(STATIC_PLANTS_NEXT_TILES);
const platforms = new Set([19, 427, 435, 436, 437, 438, 439]);
const ropes = new Set([213, 214, 353, 365, 366, 504, 449, 450, 451]);
const piles = new Set([330, 331, 332, 333]);
const sandBiomes = new Map([
  [53, 0],
  [112, 54],
  [116, 108],
  [234, 162],
]);
// Initialization facts, including the 255..268, 435..439 and 727..732 ranges.
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
const solidTops = new Set([19, 239, 380, 427, 435, 436, 437, 438, 439]);
const offsets = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];
// N/W/E/S bits; unsaved variation is fixed at zero.
const frames = [
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
const fail = (unsupported) => ({ unsupported });
const isCactus = (t) => t.active && t.type === 80;
const typeOf = (t) => (t.active ? t.type : -1);

function validRegion(r) {
  return (
    r?.rect &&
    [r.rect.x, r.rect.y, r.rect.width, r.rect.height].every(
      Number.isSafeInteger,
    ) &&
    r.rect.x >= 0 &&
    r.rect.y >= 0 &&
    r.rect.width > 0 &&
    r.rect.height > 0 &&
    r.rect.width <= 512 &&
    r.rect.height <= 512 &&
    r.rect.width * r.rect.height <= 65536 &&
    Array.isArray(r.cells) &&
    r.cells.length === r.rect.width * r.rect.height
  );
}

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

function read(region, x, y) {
  const t = at(region, x, y);
  if (!t)
    throw new Error(
      "Required plant neighbor or root lies outside the available world accessor/halo",
    );
  if (
    t.active &&
    (!Number.isInteger(t.type) ||
      t.type < 0 ||
      t.type >= 754 ||
      !Number.isInteger(t.shape ?? 0) ||
      (t.shape ?? 0) < 0 ||
      (t.shape ?? 0) > 5)
  )
    throw new Error("Plant neighbor has an unknown type or shape");
  return t;
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

function solid(t, rejectTops = false) {
  if (
    !t.active ||
    (rejectTops && (solidTops.has(t.type) || t.inactive || t.shape || 0))
  )
    return false;
  if (t.active && t.type === 379)
    throw new Error("Active-stone neighbor requires runtime solidity");
  return solids.has(t.type);
}

function cactus(region, x, y, tile) {
  if (tile.frameX != null || tile.frameY != null)
    return fail("Cactus requires reconstructed, non-persisted frames");
  let rootX = x,
    rootY = y;
  const height = region.source?.height ?? region.treeContext?.worldHeight;
  const limit =
    Number.isSafeInteger(height) && height > 0 ? Math.min(height, 4096) : 4096;
  let root;
  for (let step = 0; step < limit; step++) {
    root = read(region, rootX, rootY);
    if (!isCactus(root)) break;
    rootY++;
    if (!isCactus(read(region, rootX, rootY))) {
      if (
        isCactus(read(region, rootX - 1, rootY)) &&
        isCactus(read(region, rootX - 1, rootY - 1)) &&
        rootX >= x
      )
        rootX--;
      if (
        isCactus(read(region, rootX + 1, rootY)) &&
        isCactus(read(region, rootX + 1, rootY - 1)) &&
        rootX <= x
      )
        rootX++;
    }
    root = null;
  }
  if (!root)
    return fail("Cactus root exceeds the bounded world-height traversal");
  if (!root.active || root.inactive || root.shape || !sandBiomes.has(root.type))
    return fail(
      "Cactus has no intact sand root; resolving it requires destructive game validation",
    );
  const west2 = typeOf(read(region, x - 2, y)),
    west = typeOf(read(region, x - 1, y)),
    east = typeOf(read(region, x + 1, y));
  const above = read(region, x, y - 1),
    below = read(region, x, y + 1);
  const up = above.active && above.type === 227 ? 80 : typeOf(above),
    down = typeOf(below);
  const sw = typeOf(read(region, x - 1, y + 1)),
    se = typeOf(read(region, x + 1, y + 1));
  const side = x - rootX;
  if (side === 0 && down !== 80 && !sandBiomes.has(down))
    return fail("Cactus trunk has a broken root connection");
  if (side !== 0 && down !== 80 && west !== 80 && east !== 80)
    return fail("Cactus arm has a broken trunk connection");
  let sx, sy;
  if (side === 0) {
    const leftArm = west === 80 && sw !== 80 && west2 !== 80;
    const rightArm = east === 80 && se !== 80;
    sx = leftArm ? (rightArm ? 90 : 72) : rightArm ? 18 : 0;
    sy = up !== 80 ? 0 : sx !== 0 || solid(below) ? 36 : 18;
  } else if (side === -1 || side === 1) {
    const joins = (side === -1 ? east : west) === 80;
    sx = joins && up !== 80 && down !== 80 ? 108 : side === -1 ? 54 : 36;
    sy =
      sx === 108
        ? side === -1
          ? 36
          : 18
        : joins && down !== 80
          ? 36
          : up !== 80
            ? 0
            : 18;
  } else
    return fail("Cactus arm is more than one column from its recovered trunk");
  // Biome lookup uses the draw frame's trunk column and a twenty-cell limit.
  const sampleX =
    x +
    (sx === 36 ? -1 : sx === 54 ? 1 : sx === 108 ? (sy === 18 ? -1 : 1) : 0);
  let seen = false,
    biome = 0;
  for (let d = 0; d <= 20; d++) {
    const t = read(region, sampleX, y + d);
    if (isCactus(t)) seen = true;
    if (seen && solid(t)) {
      biome = sandBiomes.get(t.type) ?? 0;
      break;
    }
  }
  return {
    commands: [
      sprite(tile, {
        sx,
        sy: sy + biome,
        offsetY: 2,
        fidelity: "static-reconstructed-cactus",
      }),
    ],
  };
}

function goldPile(region, x, y, tile, options) {
  if (tile.frameX != null || tile.frameY != null)
    return fail("Gold coin pile requires reconstructed, non-persisted frames");
  const connected = offsets.map(([dx, dy], i) => {
    const n = read(region, x + dx, y + dy),
      shape = n.shape || 0;
    if (
      !n.active ||
      (!options.revealInvisible && !!n.invisibleBlock !== !!tile.invisibleBlock)
    )
      return false;
    if (
      (i === 0 && shape >= 4) ||
      (i === 3 && shape >= 1 && shape <= 3) ||
      (i === 1 && (shape === 2 || shape === 4)) ||
      (i === 2 && (shape === 3 || shape === 5))
    )
      return false;
    if ((i === 1 || i === 2) && shape === 1 && n.type !== tile.type)
      return false;
    if (
      !platforms.has(n.type) &&
      ((i === 0 && shape >= 1 && shape <= 3) || (i === 3 && shape >= 4))
    )
      return true;
    return piles.has(n.type);
  });
  let mask = 0;
  for (let i = 0; i < 4; i++) if (connected[i]) mask |= 1 << i;
  let [sx, sy] = frames[mask];
  if (mask === 15) {
    const [nw, ne, sw, se] = connected.slice(4);
    if (!nw && !ne) [sx, sy] = [108, 18];
    else if (!sw && !se) [sx, sy] = [108, 36];
    else if (!nw && !sw) [sx, sy] = [180, 0];
    else if (!ne && !se) [sx, sy] = [198, 0];
  }
  return {
    commands: [
      sprite(tile, {
        sx,
        sy,
        offsetY: 2,
        fidelity: "approximate-static-coin-pile-variation-zero",
      }),
    ],
  };
}

function backRope(region, x, y) {
  let top, distance;
  for (let d = 1; d <= 5; d++) {
    const t = read(region, x, y - d);
    if (!t.active) return null;
    if (ropes.has(t.type)) {
      top = t;
      distance = d;
      break;
    }
  }
  if (!top) return null;
  for (let d = 1; d <= 6 - distance; d++) {
    const t = read(region, x, y + d);
    if (!t.active) return null;
    if (ropes.has(t.type))
      return sprite(top, {
        sx: 90,
        sy: ((region.rect.x + x + region.rect.y + y) % 3) * 18,
        paintId: top.paint || 0,
        role: "planter-back-rope",
        fidelity: "static-planter-back-rope",
      });
  }
  return null;
}

function planter(region, x, y, tile, options) {
  if (
    tile.frameX % 18 ||
    tile.frameX > 54 ||
    tile.frameY % 18 ||
    tile.frameY > 126
  )
    return fail("Planter box has an unknown saved join or style");
  const joined = (dx) => {
    const t = read(region, x + dx, y);
    return (
      t.active &&
      t.type === 380 &&
      (options.revealInvisible || !!t.invisibleBlock === !!tile.invisibleBlock)
    );
  };
  const left = joined(-1),
    right = joined(1),
    sx = left ? (right ? 18 : 36) : right ? 0 : 54;
  const rope = backRope(region, x, y);
  return {
    commands: [
      ...(rope ? [rope] : []),
      sprite(tile, { sx, fidelity: "static-planter-reconstructed-join" }),
    ],
  };
}

function lily(region, x, y, tile) {
  if (
    tile.frameX % 18 ||
    tile.frameX > 306 ||
    ![0, 18, 36].includes(tile.frameY)
  )
    return fail("Lily pad has an unknown saved style");
  if (!Number.isInteger(tile.liquid) || tile.liquid < 0 || tile.liquid > 255)
    return fail("Lily pad requires its saved liquid amount");
  let lift = Math.floor(tile.liquid / 16) - 3;
  if (lift > 8 && solid(read(region, x, y - 1), true)) lift = 8;
  if (tile.liquid === 0) {
    const t = read(region, x, y + 1);
    if (t.active && !t.inactive) {
      if (t.shape === 1) {
        if (!Number.isInteger(t.liquid) || t.liquid < 0 || t.liquid > 255)
          return fail("Lily pad half-block support requires saved liquid");
        lift = -16 + Math.max(8, Math.floor(t.liquid / 16));
      } else if (t.shape === 2 || t.shape === 3) lift -= 4;
    }
  }
  return {
    commands: [
      sprite(tile, {
        offsetY: lift === 0 ? 0 : -lift,
        fidelity: "static-saved-liquid-height",
      }),
    ],
  };
}

/** No mutation; visibility, paint, premultiplied compositing and bounds are caller-owned. */
export function planStaticPlantsNext(region, x, y, tile, options = {}) {
  if (!tile || !supported.has(tile.type)) return null;
  if (
    !validRegion(region) ||
    (region.context && !validRegion(region.context)) ||
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= region.rect.width ||
    y >= region.rect.height
  )
    return fail("Static plants require bounded world coordinates and cells");
  if (!tile.active) return fail("Static plant tile is not active");
  if (tile.shape)
    return fail("Static plants do not define sloped or half-block bodies");
  try {
    if (tile.type === 80) return cactus(region, x, y, tile);
    if (tile.type === 332) return goldPile(region, x, y, tile, options);
    if (
      !Number.isInteger(tile.frameX) ||
      !Number.isInteger(tile.frameY) ||
      tile.frameX < 0 ||
      tile.frameY < 0
    )
      return fail("Static plant requires nonnegative saved frame coordinates");
    if (tile.type === 380) return planter(region, x, y, tile, options);
    if (tile.type === 518) return lily(region, x, y, tile);
    if (tile.frameX !== 0 || tile.frameY !== 0)
      return fail("Glow tulip has an unknown saved frame");
    const pulse = options.mouseTextColor ?? 255;
    if (!Number.isInteger(pulse) || pulse < 0 || pulse > 255)
      return fail("Glow tulip static pulse must be a byte");
    const base = sprite(tile, {
      sw: 24,
      sh: 34,
      offsetX: -4,
      offsetY: -16,
      flipX: (region.rect.x + x) % 2 === 0,
      fidelity: "static-zero-wind",
    });
    return {
      commands: [
        base,
        {
          ...base,
          asset: "Glow_329.png",
          paintId: 0,
          staticOverlay: true,
          vertexColor: [pulse, pulse, pulse, 0],
          fidelity: "approximate-static-glow-pulse",
        },
      ],
    };
  } catch (error) {
    return fail(error.message);
  }
}
