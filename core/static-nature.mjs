/** Original static sprite planner. Source contracts and limits: docs/static-nature.md. */
import { cobwebConnects } from "./cobweb-shapes.mjs";
export const STATIC_VINE_TYPES = Object.freeze([
  52, 62, 115, 205, 382, 528, 638,
]);
export const STATIC_NATURE_TYPES = Object.freeze([51, ...STATIC_VINE_TYPES]);
// Facts from the pinned vanilla 1.4.5.8 initialization. Includes its 435–439 loop.
export const COBWEB_NO_ATTACH = Object.freeze([
  3, 4, 10, 13, 14, 15, 16, 17, 18, 19, 20, 21, 27, 50, 86, 87, 88, 89, 90, 91,
  92, 93, 94, 95, 96, 97, 98, 99, 101, 102, 110, 114, 134, 387, 388, 390, 427,
  435, 436, 437, 438, 439, 441, 467, 468, 469, 486, 487, 488, 489, 490, 497,
  564, 565, 568, 569, 570, 572, 580, 590, 593, 594, 595, 615, 620, 704, 707,
]);
const types = new Set(STATIC_NATURE_TYPES);
const noAttach = new Set(COBWEB_NO_ATTACH);
const platforms = new Set([19, 427, 435, 436, 437, 438, 439]);
const KNOWN_TILE_COUNT = 754;
// Fixed variation 0, N/W/E/S bits 1/2/4/8, in PNG pixel coordinates.
const FRAMES = [
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
const OFFSETS = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];
const unsupported = (reason) => ({ supported: false, reason });

function validRegion(region) {
  const r = region?.rect;
  return (
    r &&
    [r.x, r.y, r.width, r.height].every(Number.isSafeInteger) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.width > 0 &&
    r.height > 0 &&
    r.width <= 512 &&
    r.height <= 512 &&
    r.width * r.height <= 65536 &&
    Array.isArray(region.cells) &&
    region.cells.length === r.width * r.height
  );
}

function lookup(region, worldX, worldY) {
  for (const candidate of [region, region.context]) {
    if (!candidate) continue;
    const r = candidate.rect;
    const x = worldX - r.x,
      y = worldY - r.y;
    if (x >= 0 && y >= 0 && x < r.width && y < r.height)
      return candidate.cells[x * r.height + y] ?? null;
  }
  return null;
}

function selectFrame(connected) {
  let mask = 0;
  for (let i = 0; i < 4; i++) if (connected[i]) mask |= 1 << i;
  if (mask !== 15) return FRAMES[mask];
  const [nw, ne, sw, se] = connected.slice(4);
  if (!nw && !ne) return [108, 18];
  if (!sw && !se) return [108, 36];
  if (!nw && !sw) return [180, 0];
  if (!ne && !se) return [198, 0];
  return FRAMES[15];
}

// The shared framing rules normalize adjacent slopes before checking type.
// core shape 1 is halfbrick; shapes 2–5 are game slopes 1–4.
function vineConnects(neighbor, index, type) {
  const shape = neighbor.shape || 0;
  const same = neighbor.type === type;
  if (index === 0) {
    if (shape === 4 || shape === 5) return false;
    if (shape >= 1 && shape <= 3 && !platforms.has(neighbor.type)) return true;
  } else if (index === 3) {
    if (shape >= 1 && shape <= 3) return false;
    if ((shape === 4 || shape === 5) && !platforms.has(neighbor.type))
      return true;
  } else if (index === 1) {
    if (shape === 2 || shape === 4 || (shape === 1 && !same)) return false;
  } else if (index === 2) {
    if (shape === 3 || shape === 5 || (shape === 1 && !same)) return false;
  }
  return same;
}

/**
 * x/y are selection-local tile coordinates; rect.x/y are world coordinates.
 * Return null for a type outside this module, or an explicit supported result.
 * Neither Tile records nor raw serialized data are modified.
 */
export function planStaticNature(
  region,
  x,
  y,
  tile,
  { revealInvisible = false } = {},
) {
  if (!tile || !types.has(tile.type)) return null;
  if (
    !validRegion(region) ||
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= region.rect.width ||
    y >= region.rect.height
  )
    return unsupported("invalid-region");
  if (region.context && !validRegion(region.context))
    return unsupported("invalid-context");
  if (!tile.active) return unsupported("inactive-tile");
  if (!revealInvisible && tile.invisibleBlock)
    return unsupported("invisible-block");
  if ((tile.shape ?? 0) !== 0) return unsupported("shaped-nature-tile");
  if (tile.frameX != null || tile.frameY != null)
    return unsupported("unexpected-stored-frame");
  const worldX = region.rect.x + x,
    worldY = region.rect.y + y;
  const source = region.source;
  const hasDimensions =
    Number.isSafeInteger(source?.width) &&
    source.width > 0 &&
    Number.isSafeInteger(source?.height) &&
    source.height > 0;
  const neighbors = [];
  for (const [dx, dy] of OFFSETS) {
    const nx = worldX + dx,
      ny = worldY + dy;
    if (
      nx < 0 ||
      ny < 0 ||
      (hasDimensions && (nx >= source.width || ny >= source.height))
    )
      return unsupported("world-boundary");
    const neighbor = lookup(region, nx, ny);
    if (!neighbor) return unsupported("missing-halo");
    if (neighbor.active) {
      if (
        !Number.isInteger(neighbor.type) ||
        neighbor.type < 0 ||
        neighbor.type >= KNOWN_TILE_COUNT
      )
        return unsupported("unknown-neighbor-type");
      const shape = neighbor.shape ?? 0;
      if (!Number.isInteger(shape) || shape < 0 || shape > 5)
        return unsupported("invalid-neighbor-shape");
    }
    neighbors.push(neighbor);
  }
  const connected = neighbors.map((neighbor, index) => {
    if (tile.type === 51)
      return cobwebConnects(neighbor, index, noAttach, {
        revealInvisible,
        invisibleBlock: tile.invisibleBlock,
      });
    if (!neighbor.active) return false;
    if (!revealInvisible && !!neighbor.invisibleBlock !== !!tile.invisibleBlock)
      return false;
    return vineConnects(neighbor, index, tile.type);
  });
  const [sx, sy] = selectFrame(connected);
  const cobweb = tile.type === 51;
  return {
    supported: true,
    sx,
    sy,
    sw: 16,
    sh: 16,
    offsetX: 0,
    offsetY: cobweb ? 0 : -4,
    flipX: !cobweb && worldX % 2 === 0,
    opacity: cobweb ? 0.5 : 1,
    fidelity: cobweb ? "approximate-cobweb" : "static-vine-zero-wind",
    reason: null,
  };
}
