import { cellAt } from "./world.mjs";

/** Original static terrain rules; the inspected behavior is documented separately. */
export const STATIC_SOLID_BLOCKS = Object.freeze([
  162, 381, 384, 481, 482, 483, 539, 633,
]);
export const STATIC_THORN_TILES = Object.freeze([32, 69, 352, 655]);
export const STATIC_BLOCK_TILES = Object.freeze([
  ...STATIC_SOLID_BLOCKS,
  ...STATIC_THORN_TILES,
]);
const supported = new Set(STATIC_BLOCK_TILES);
const roots = new Map([
  [32, 23],
  [69, 60],
  [352, 199],
  [655, 60],
]);

// Cardinal attachment bits: top, left, right, bottom. Variant zero only.
const FRAMES = Object.freeze([
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
]);
const NEIGHBORS = [
  [0, -1, 1],
  [-1, 0, 2],
  [1, 0, 4],
  [0, 1, 8],
];
const glow = new Map([
  [
    381,
    { asset: "Glow_126.png", vertexColor: Object.freeze([150, 100, 50, 0]) },
  ],
  [
    539,
    { asset: "Glow_263.png", vertexColor: Object.freeze([225, 0, 125, 0]) },
  ],
  [
    633,
    { asset: "Glow_326.png", vertexColor: Object.freeze([255, 255, 255, 255]) },
  ],
]);

/** Multiply a premultiplied texture sample by the source renderer's vertex color.
 * Apply after texture paint processing and before premultiplied alpha splitting.
 * In particular, alpha-zero colors retain additive RGB instead of disappearing.
 */
export function multiplyStaticVertexColor(
  rgba,
  vertexColor = [255, 255, 255, 255],
) {
  if (
    rgba?.length !== 4 ||
    vertexColor?.length !== 4 ||
    ![...rgba, ...vertexColor].every(
      (v) => Number.isFinite(v) && v >= 0 && v <= 255,
    )
  ) {
    throw new RangeError(
      "Static vertex color needs four finite byte-range channels",
    );
  }
  return Uint8ClampedArray.from(rgba, (value, channel) =>
    Math.round((value * vertexColor[channel]) / 255),
  );
}

/**
 * A source-verified base sprite, or [base, static glow overlay]. Geometry uses
 * same-type cardinal approximation and a verified ground anchor for thorns.
 * The caller applies shape clipping to EVERY returned layer. Glow layers have
 * paintId=0 because the reference renderer draws them from unpainted masks.
 */
export function planStaticBlock(region, x, y, tile, options = {}) {
  if (!tile || !supported.has(tile.type)) return null;
  if (tile.frameX != null || tile.frameY != null) {
    return {
      unsupported: "Static terrain expects reconstructed, non-persisted frames",
    };
  }
  const thorn = roots.has(tile.type);
  if (thorn && tile.shape) {
    return {
      unsupported:
        "Thorn geometry does not support block slopes or half blocks",
    };
  }
  let mask = 0;
  for (const [dx, dy, bit] of NEIGHBORS) {
    const neighbor = cellAt(region, x + dx, y + dy);
    if (
      !neighbor?.active ||
      (neighbor.invisibleBlock && !options.revealInvisible)
    )
      continue;
    if (
      neighbor.type === tile.type ||
      (bit === 8 && thorn && neighbor.type === roots.get(tile.type))
    )
      mask |= bit;
  }
  const [sx, sy] = FRAMES[mask];
  const base = {
    asset: `Tiles_${tile.type}.png`,
    sx,
    sy,
    sw: 16,
    sh: thorn ? 18 : 16,
    offsetX: 0,
    offsetY: 0,
    flipX: false,
    opacity: 1,
    fidelity: thorn ? "approximate-static-thorn" : "approximate-static-block",
  };
  const layer = glow.get(tile.type);
  if (!layer) return base;
  return [
    base,
    {
      ...base,
      asset: layer.asset,
      vertexColor: layer.vertexColor,
      paintId: 0,
      staticOverlay: true,
      fidelity: "static-glow-mask",
    },
  ];
}
