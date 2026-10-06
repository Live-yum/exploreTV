/** Original cobweb adjacency rules. Source facts and integration: docs/cobweb-shapes.md. */
const PLATFORMS = new Set([19, 427, 435, 436, 437, 438, 439]);
const COBWEB = 51;
const TILE_COUNT = 754;

/**
 * Return whether one neighbor joins a normal-shaped cobweb's static frame.
 * Indices are N, W, E, S, NW, NE, SW, SE, matching static-nature.mjs.
 * noAttach is the host's existing Set of verified tileNoAttach IDs.
 * The host still owns region/halo/center validation and frame selection.
 * This function reads Tile records without altering any field or source byte.
 */
export function cobwebConnects(
  neighbor,
  index,
  noAttach,
  { revealInvisible = false, invisibleBlock = false } = {},
) {
  if (!Number.isInteger(index) || index < 0 || index > 7)
    throw new RangeError("Invalid cobweb neighbor direction");
  if (typeof noAttach?.has !== "function")
    throw new TypeError("Verified cobweb no-attach facts are required");
  if (!neighbor) throw new TypeError("A real cobweb neighbor is required");
  if (!neighbor.active) return false;
  if (
    !Number.isInteger(neighbor.type) ||
    neighbor.type < 0 ||
    neighbor.type >= TILE_COUNT
  )
    throw new RangeError("Unknown cobweb neighbor type");
  const shape = neighbor.shape ?? 0;
  if (!Number.isInteger(shape) || shape < 0 || shape > 5)
    throw new RangeError("Invalid cobweb neighbor shape");

  // Core shape 1 is a half brick; shapes 2–5 are game slopes 1–4.
  // First remove cardinal faces which do not reach the center tile.
  let type = neighbor.type;
  const openFace =
    (index === 0 && (shape === 4 || shape === 5)) ||
    (index === 1 && (shape === 2 || shape === 4)) ||
    (index === 2 && (shape === 3 || shape === 5)) ||
    (index === 3 && (shape === 1 || shape === 2 || shape === 3));
  if (openFace) type = -1;

  // A full horizontal contact is normalized to the center type before the
  // no-attach test. This includes otherwise excluded, non-platform types.
  if (type >= 0 && !PLATFORMS.has(type)) {
    if (
      (index === 0 && shape >= 1 && shape <= 3) ||
      (index === 3 && (shape === 4 || shape === 5))
    )
      type = COBWEB;
  }
  // The original side half-brick comparison uses the actual neighbor type.
  if ((index === 1 || index === 2) && shape === 1 && neighbor.type !== COBWEB)
    type = -1;

  const attached = type >= 0 && !noAttach.has(type);
  // Cull after shape normalization and attachment, so a hidden normalized
  // neighbor cannot reconnect itself. Each diagonal is culled independently.
  return (
    attached &&
    (revealInvisible || !!neighbor.invisibleBlock === !!invisibleBlock)
  );
}
