/** Internal, bounded terrain commands for whole-world overview planning.
 *
 * The command stream keeps its exact draw order. An object is an unchanged
 * special command; a negative integer identifies one five-word terrain record:
 * [frame slot, destination x, destination y, owner x, owner y]. Frame templates
 * contain no destination coordinates or prepared pixels, and are immutable.
 */
export const OVERVIEW_COMMAND_STRIDE = 5;

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

/** The planner reserves the logical command budget before each append. */
export function createOverviewCommandBuffer(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 131072)
    throw new RangeError("Invalid compact overview command capacity");
  const records = new Int32Array(capacity * OVERVIEW_COMMAND_STRIDE),
    frames = [],
    wallSlots = new Map(),
    tileSlots = new Map();
  let length = 0;
  const append = (slot, dx, dy, x, y) => {
    if (length >= capacity)
      throw new RangeError("Compact overview command capacity exceeded");
    const offset = length * OVERVIEW_COMMAND_STRIDE;
    records[offset] = slot;
    records[offset + 1] = dx;
    records[offset + 2] = dy;
    records[offset + 3] = x;
    records[offset + 4] = y;
    return -++length;
  };
  return {
    records,
    frames,
    // These scalar-only calls never construct a command on a cache hit. The
    // caller retains unusual identifiers/shapes/paint on the reference path.
    wall(type, asset, variant, grid, paintId, x, y) {
      const key = (type * 256 + paintId) * 20 + variant;
      let slot = wallSlots.get(key);
      if (slot === undefined) {
        slot = frames.length;
        frames.push(
          Object.freeze({
            kind: "wall",
            asset,
            sx: grid[0] * 36,
            sy: grid[1] * 36,
            sw: 32,
            sh: 32,
            dw: 32,
            dh: 32,
            type,
            paintId,
            fidelity: "approximate",
          }),
        );
        wallSlots.set(key, slot);
      }
      return append(slot, x * 16 - 8, y * 16 - 8, x, y);
    },
    tile(type, asset, variant, frame, paintId, shape, x, y) {
      const key = ((type * 256 + paintId) * 6 + shape) * 16 + variant;
      let slot = tileSlots.get(key);
      if (slot === undefined) {
        slot = frames.length;
        const height = shape === 1 ? 8 : 16;
        const template = {
          kind: "tile",
          asset,
          sx: frame[0],
          sy: frame[1],
          sw: 16,
          sh: height,
          dw: 16,
          dh: height,
          type,
          ownerType: type,
          paintId,
          fidelity: "approximate",
        };
        if (shape >= 2) template.clip = slopeClips[shape];
        frames.push(Object.freeze(template));
        tileSlots.set(key, slot);
      }
      return append(slot, x * 16, y * 16 + (shape === 1 ? 8 : 0), x, y);
    },
    finish() {
      return {
        records: records.subarray(0, length * OVERVIEW_COMMAND_STRIDE),
        stride: OVERVIEW_COMMAND_STRIDE,
        frames: Object.freeze(frames),
      };
    },
  };
}

function terrainRecordOffset(plan, token) {
  const compact = plan?.compactTerrain,
    offset = (-token - 1) * OVERVIEW_COMMAND_STRIDE;
  if (
    !compact ||
    !Number.isInteger(token) ||
    token >= 0 ||
    compact.stride !== OVERVIEW_COMMAND_STRIDE ||
    !(compact.records instanceof Int32Array) ||
    offset < 0 ||
    offset + OVERVIEW_COMMAND_STRIDE > compact.records.length ||
    !compact.frames[compact.records[offset]]
  )
    throw new RangeError("Invalid compact overview command token");
  return offset;
}

/** Inspect immutable source/frame fields without allocating a command. */
export function getOverviewCommandTemplate(plan, command) {
  if (typeof command !== "number") return command;
  const offset = terrainRecordOffset(plan, command),
    compact = plan.compactTerrain;
  return compact.frames[compact.records[offset]];
}

/** Materialize only for fallback consumers of the public object contract. */
export function materializeOverviewCommand(plan, command) {
  if (typeof command !== "number") return command;
  const offset = terrainRecordOffset(plan, command),
    compact = plan.compactTerrain,
    frame = compact.frames[compact.records[offset]];
  const result = {
    ...frame,
    dx: compact.records[offset + 1],
    dy: compact.records[offset + 2],
    x: compact.records[offset + 3],
    y: compact.records[offset + 4],
  };
  // Public commands have private mutable clips. Do not expose the shared
  // immutable template or let a fallback consumer affect later commands.
  if (frame.clip) result.clip = frame.clip.map((point) => [...point]);
  return result;
}
