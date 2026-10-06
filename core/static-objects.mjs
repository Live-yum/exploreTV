/** Original static sprite rules. Source observations: docs/static-objects.md. */
export const STATIC_OBJECT_TILES = Object.freeze([
  28, 73, 74, 105, 113, 165, 178, 184, 185, 186, 187, 506,
]);

const supported = new Set(STATIC_OBJECT_TILES);
const tallPlants = new Set([73, 74, 113]);

/**
 * Resolve one saved object cell to a sprite, without modifying the world.
 * Coordinates x/y are relative to region.rect; offsets and sizes are pixels.
 * The caller applies visibility, paint, clipping, and asset-bound validation.
 * This is animation frame zero with no wind or emitted-light simulation.
 */
export function planStaticObject(region, x, y, tile, options = {}) {
  if (!tile || !supported.has(tile.type)) return null;
  const { frameX, frameY, type } = tile;
  if (
    !Number.isInteger(frameX) ||
    !Number.isInteger(frameY) ||
    frameX < 0 ||
    frameY < 0
  ) {
    return {
      unsupported: "Static object requires nonnegative saved frame coordinates",
    };
  }

  const sprite = {
    asset: `Tiles_${type}.png`,
    sx: frameX,
    sy: frameY,
    sw: 16,
    sh: 16,
    offsetX: 0,
    offsetY: 0,
    flipX: false,
    opacity: 1,
    fidelity: "static-stored-frame",
  };

  if (tallPlants.has(type)) {
    const worldX = (region?.rect?.x || 0) + x;
    sprite.sh = 32;
    sprite.offsetY = -12;
    sprite.flipX = worldX % 2 === 0;
    sprite.fidelity = "static-zero-wind";
  } else if (type === 184) {
    // This moss uses four different attachment origins. Its side sprites are
    // already oriented in the atlas; a runtime rotation is not needed at rest.
    const direction = Math.floor(frameY / 54);
    if (direction > 3) {
      return {
        unsupported: "Long-moss frame has an unknown attachment direction",
      };
    }
    const top = frameY <= 36 ? 2 : frameY <= 108 ? -2 : 0;
    sprite.sw = 20;
    sprite.offsetX = direction === 3 ? 2 : -2;
    sprite.offsetY = direction < 2 ? top : top / 2;
    sprite.fidelity = "static-zero-wind";
  } else if (type === 178) {
    sprite.offsetY = frameY <= 36 ? 2 : 0;
  } else if (type !== 165) {
    sprite.offsetY = 2;
    if (type === 185 && frameY === 18) {
      const row = Math.floor(frameX / 1908);
      sprite.sx %= 1908;
      sprite.sy += row * 18;
    } else if (type === 187) {
      const row = Math.floor(frameX / 1890);
      sprite.sx %= 1890;
      sprite.sy += row * 36;
    }
  }
  return sprite;
}
