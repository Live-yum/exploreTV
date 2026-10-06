/** World-independent ordinary frame recipes. IDs are part of the compiled asset ABI. */
export const OVERVIEW_FRAME_RECIPE_VERSION = 1;
export const WALL_RECIPE_BASE = 0x01000000;
export const BLOCK_FRAME = Object.freeze(
  [
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
  ].map(Object.freeze),
);
export const WALL_GRID = Object.freeze(
  [
    [9, 3],
    [6, 3],
    [12, 0],
    [1, 4],
    [9, 0],
    [0, 4],
    [6, 4],
    [1, 2],
    [6, 0],
    [5, 0],
    [1, 3],
    [4, 0],
    [0, 3],
    [0, 0],
    [1, 0],
    [1, 1],
    [6, 1],
    [6, 2],
    [10, 0],
    [11, 0],
  ].map(Object.freeze),
);
export const ORDINARY_BLOCKS = Object.freeze([
  0, 1, 2, 6, 7, 8, 9, 22, 23, 25, 30, 37, 38, 39, 40, 41, 43, 44, 45, 46, 47,
  48, 53, 56, 57, 58, 59, 60, 63, 64, 65, 66, 67, 68, 70, 75, 76, 107, 108, 109,
  111, 112, 116, 117, 118, 119, 120, 121, 122, 140, 147, 161, 163, 164, 166,
  167, 168, 169, 175, 176, 177, 179, 180, 181, 182, 183, 189, 190, 191, 192,
  193, 194, 195, 196, 197, 198, 199, 200, 202, 203, 204, 206, 208, 211, 221,
  222, 223, 224, 225, 226, 229, 230, 232, 234, 239, 248, 250, 251, 252, 253,
  // Source-verified full solids with ordinary 18px frames; merges stay approximate.
  123,
  151, 367, 368, 383, 396, 397, 402, 403, 404,
]);
const slopeClips = Object.freeze({
  2: Object.freeze([
    Object.freeze([0, 0]),
    Object.freeze([16, 16]),
    Object.freeze([0, 16]),
  ]),
  3: Object.freeze([
    Object.freeze([0, 16]),
    Object.freeze([16, 0]),
    Object.freeze([16, 16]),
  ]),
  4: Object.freeze([
    Object.freeze([0, 0]),
    Object.freeze([16, 0]),
    Object.freeze([0, 16]),
  ]),
  5: Object.freeze([
    Object.freeze([0, 0]),
    Object.freeze([16, 0]),
    Object.freeze([16, 16]),
  ]),
});

const ordinary = new Set(ORDINARY_BLOCKS);
export function overviewFrameRecipeId(
  kind,
  type,
  variant,
  shape = 0,
  paintId = 0,
) {
  if (
    !Number.isInteger(type) ||
    !Number.isInteger(variant) ||
    !Number.isInteger(shape) ||
    (paintId !== 0 && paintId !== 31)
  )
    throw new RangeError("Invalid overview frame recipe");
  const paint = paintId === 31 ? 1 : 0;
  if (
    kind === "tile" &&
    ordinary.has(type) &&
    variant >= 0 &&
    variant < 16 &&
    shape >= 0 &&
    shape < 6
  )
    return 1 + ((type * 6 + shape) * 16 + variant) * 2 + paint;
  if (
    kind === "wall" &&
    type > 0 &&
    type <= 65535 &&
    variant >= 0 &&
    variant < 20 &&
    shape === 0
  )
    return WALL_RECIPE_BASE + type * 40 + variant * 2 + paint;
  throw new RangeError("Invalid overview frame recipe");
}
function decode(id) {
  if (!Number.isSafeInteger(id) || id < 1)
    throw new RangeError("Invalid overview frame recipe ID");
  const wall = id >= WALL_RECIPE_BASE,
    code = id - (wall ? WALL_RECIPE_BASE : 1),
    paintId = code % 2 ? 31 : 0;
  const value = Math.floor(code / 2),
    variant = value % (wall ? 20 : 16),
    shape = wall ? 0 : Math.floor(value / 16) % 6,
    type = Math.floor(value / (wall ? 20 : 96)),
    kind = wall ? "wall" : "tile";
  if (overviewFrameRecipeId(kind, type, variant, shape, paintId) !== id)
    throw new RangeError("Invalid overview frame recipe ID");
  return { kind, type, variant, shape, paintId };
}
export function canonicalOverviewFrameRecipeId(id) {
  const { kind, type, variant, shape } = decode(id);
  return overviewFrameRecipeId(kind, type, variant, shape, 0);
}
export function overviewFrameRecipe(id) {
  const { kind, type, variant, shape, paintId } = decode(id);
  if (kind === "wall") {
    const [x, y] = WALL_GRID[variant];
    return Object.freeze({
      kind,
      asset: `Wall_${type}.png`,
      sx: x * 36,
      sy: y * 36,
      sw: 32,
      sh: 32,
      dw: 32,
      dh: 32,
      type,
      paintId,
      fidelity: "approximate",
    });
  }
  const [sx, sy] = BLOCK_FRAME[variant],
    height = shape === 1 ? 8 : 16;
  return Object.freeze({
    kind,
    asset: `Tiles_${type}.png`,
    sx,
    sy,
    sw: 16,
    sh: height,
    dw: 16,
    dh: height,
    type,
    ownerType: type,
    paintId,
    fidelity: "approximate",
    ...(shape >= 2 ? { clip: slopeClips[shape] } : {}),
  });
}
export function* overviewFrameRecipeIds({
  tileTypes = ORDINARY_BLOCKS,
  wallTypes = [],
  paintIds = [0],
} = {}) {
  for (const type of tileTypes)
    for (const paint of paintIds)
      for (let shape = 0; shape < 6; shape++)
        for (let variant = 0; variant < 16; variant++)
          yield overviewFrameRecipeId("tile", type, variant, shape, paint);
  for (const type of wallTypes)
    for (const paint of paintIds)
      for (let variant = 0; variant < 20; variant++)
        yield overviewFrameRecipeId("wall", type, variant, 0, paint);
}
