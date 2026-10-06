import { cellAt } from "./world.mjs";

export const SOURCE_HIDDEN_TILES = Object.freeze([373, 374, 375, 461, 709]);
export const STATIC_MISC_TILES = Object.freeze([
  3, 20, 24, 61, 71, 110, 129, 201, 233, 314, 373, 374, 375, 444, 461, 484, 485,
  637, 703, 709,
]);
const supported = new Set(STATIC_MISC_TILES);
const emitters = new Set(SOURCE_HIDDEN_TILES);
const plants = new Set([3, 24, 61, 71, 110, 201, 637, 703]);
const ropeTypes = new Set([213, 214, 353, 365, 366, 504, 449, 450, 451]);
// Original metadata table: atlas cell X/Y and left/right connection heights.
const TRACKS = [
  [0, 0, -1, -1],
  [1, 0, 1, 1],
  [2, 1, -1, 1],
  [3, 1, 1, -1],
  [0, 2, 2, 1],
  [1, 2, 1, 2],
  [0, 1, 1, 0],
  [1, 1, 0, 1],
  [0, 3, 0, 2],
  [1, 3, 2, 0],
  [4, 1, 2, -1],
  [5, 1, -1, 2],
  [6, 1, 0, -1],
  [7, 1, -1, 0],
  [2, 0, -1, 1],
  [3, 0, 1, -1],
  [4, 0, 2, -1],
  [5, 0, -1, 2],
  [6, 0, 0, -1],
  [7, 0, -1, 0],
  [0, 4, -1, -1],
  [1, 4, 1, 1],
  [0, 5, -1, 1],
  [1, 5, 1, -1],
  [2, 2, -1, 1],
  [3, 2, 1, -1],
  [4, 2, 2, -1],
  [5, 2, -1, 2],
  [6, 2, 0, -1],
  [7, 2, -1, 0],
  [2, 3, 1, 1],
  [3, 3, 1, 1],
  [4, 3, 0, 2],
  [5, 3, 2, 0],
  [6, 3, 0, 2],
  [7, 3, 2, 0],
  [0, 6],
  [1, 6],
  [1, 7],
  [0, 7],
];
const regularBumpers = new Set([2, 3, 10, 11, 12, 13]);
const trackId = (id) => Number.isInteger(id) && id >= 0 && id < 36;

export function staticTrackRectangle(index) {
  if (!Number.isInteger(index) || index < 0 || index >= TRACKS.length)
    return null;
  return {
    sx: TRACKS[index][0] * 18,
    sy: TRACKS[index][1] * 18,
    sw: 16,
    sh: 16,
  };
}

function at(region, x, y) {
  const local = cellAt(region, x, y);
  if (local || !region.context) return local;
  return cellAt(
    region.context,
    region.rect.x + x - region.context.rect.x,
    region.rect.y + y - region.context.rect.y,
  );
}

function trackPaint(region, x, y, tile) {
  const own = tile.paint || 0;
  if (tile.frameY === -1) return [own, own];
  const front = TRACKS[tile.frameX],
    back = TRACKS[tile.frameY];
  const sample = (side, connection) => {
    const n = at(
      region,
      x + side,
      y + (connection === 0 ? -1 : connection === 2 ? 1 : 0),
    );
    return n?.active && n.type === 314 ? n.paint || 0 : 0;
  };
  const choose = (frame) => {
    const left = sample(-1, frame[2]),
      right = sample(1, frame[3]);
    if (front[2] === back[2]) return right || left || own;
    if (front[3] === back[3]) return left || right || own;
    if (!right) return left || own;
    if (left) return frame[3] <= frame[2] ? right : left;
    return own;
  };
  return [choose(front), choose(back)];
}

function ropeBehindTrack(region, x, y) {
  let top = null,
    distance = 0;
  for (let d = 1; d <= 5; d++) {
    const t = at(region, x, y - d);
    if (!t?.active) break;
    if (ropeTypes.has(t.type)) {
      top = t;
      distance = d;
      break;
    }
  }
  if (!top) return null;
  for (let d = 1; d <= 6 - distance; d++) {
    const t = at(region, x, y + d);
    if (!t?.active) break;
    if (ropeTypes.has(t.type)) return top;
  }
  return null;
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

function tracks(region, x, y, tile) {
  if (!trackId(tile.frameX) || (tile.frameY !== -1 && !trackId(tile.frameY))) {
    return {
      unsupported:
        "Minecart frame fields must be front/back track indices 0–35 or back=-1",
    };
  }
  const [frontPaint, backPaint] = trackPaint(region, x, y, tile),
    commands = [];
  const add = (id, paintId, offsetY, role) =>
    commands.push(
      sprite(tile, {
        ...staticTrackRectangle(id),
        paintId,
        offsetY,
        role,
        fidelity: "static-track-index",
      }),
    );
  const rope = ropeBehindTrack(region, x, y);
  if (rope)
    commands.push(
      sprite(rope, {
        sx: 90,
        sy: ((region.rect.x + x + region.rect.y + y) % 3) * 18,
        paintId: rope.paint || 0,
        role: "track-back-rope",
        fidelity: "static-track-rope",
      }),
    );
  if (tile.frameY !== -1) add(tile.frameY, backPaint, 0, "track-back");
  add(tile.frameX, frontPaint, 0, "track-front");
  for (const [connection, decoration, role] of [
    [2, 36, "track-left-foot"],
    [3, 37, "track-right-foot"],
  ]) {
    if (tile.frameY !== -1 && TRACKS[tile.frameY][connection] === 2)
      add(decoration, backPaint, 16, role);
    if (TRACKS[tile.frameX][connection] === 2)
      add(decoration, frontPaint, 16, role);
  }
  if (regularBumpers.has(tile.frameX)) add(39, frontPaint, -16, "track-bumper");
  else if (tile.frameX >= 24 && tile.frameX <= 29)
    add(38, frontPaint, -16, "track-bouncy-bumper");
  return { commands };
}

function shimmerCrystalColor(worldX, worldY) {
  const hue = 0.7 + Math.sin(worldX * 0.3 + worldY * 0.7) * 0.16;
  // Fully saturated, half-lightness HSL expressed as a triangular RGB wave.
  const channel = (offset) => {
    const k = (hue * 12 + offset) % 12;
    const value = 1 - Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.floor(Math.round(value * 127.5) * 0.3);
  };
  return [channel(0), channel(8), channel(4), 38];
}

function crystals(region, x, y, tile) {
  if (tile.frameX % 18 || ![0, 18, 36, 54].includes(tile.frameY)) {
    return {
      unsupported: "Crystal frame has an unknown attachment or style alignment",
    };
  }
  const center = sprite(tile, {
    offsetX: tile.frameY < 36 ? 0 : tile.frameY === 36 ? 2 : -2,
    offsetY: tile.frameY < 36 ? (tile.frameY === 0 ? 2 : -2) : 0,
    vertexColor: [255, 255, 255, 100],
    fidelity: "static-crystal",
  });
  if (tile.frameX < 324) return { commands: [center] };
  center.sx = 324 + (((tile.frameX - 324) / 18) % 6) * 18;
  const color = shimmerCrystalColor(region.rect.x + x, region.rect.y + y);
  const commands = [
    [2, 0],
    [0, 2],
    [-2, 0],
    [0, -2],
  ].map(([dx, dy]) => ({
    ...center,
    sy: center.sy + 72,
    offsetX: center.offsetX + dx,
    offsetY: center.offsetY + dy,
    vertexColor: color,
    staticOverlay: true,
    fidelity: "static-crystal-halo",
  }));
  commands.push(center);
  return { commands };
}

/** Static bodies, particle-only emitters, and index-framed tracks.
 * Return {commands:[geometry,...]}, {commands:[],hidden:true,reason},
 * {unsupported:reason}, or null for a different family's tile type.
 */
export function planStaticMisc(region, x, y, tile, options = {}) {
  if (!tile || !supported.has(tile.type)) return null;
  if (emitters.has(tile.type))
    return {
      commands: [],
      hidden: true,
      fidelity: "source-hidden",
      reason: "particle-emitter-without-tile-body",
    };
  if (tile.shape)
    return {
      unsupported:
        "Static object family does not define sloped or half-block sprites",
    };
  if (tile.type === 314) return tracks(region, x, y, tile);
  if (
    !Number.isInteger(tile.frameX) ||
    !Number.isInteger(tile.frameY) ||
    tile.frameX < 0 ||
    tile.frameY < 0
  ) {
    return {
      unsupported: "Static object requires nonnegative saved frame coordinates",
    };
  }
  if (tile.type === 129) return crystals(region, x, y, tile);
  const out = sprite(tile);
  if (plants.has(tile.type) || tile.type === 20) {
    out.sh = tile.type === 20 ? 18 : 20;
    out.flipX = (region.rect.x + x) % 2 === 0;
    out.fidelity = "static-zero-wind";
  } else if (tile.type === 233 || tile.type === 485) {
    out.offsetY = 2;
    out.fidelity = "static-zero-wind";
    if (tile.type === 485) {
      const topX = region.rect.x + x - tile.frameX / 18;
      const topY = region.rect.y + y - tile.frameY / 18;
      out.sy += ((((topX + topY) % 4) + 4) % 4) * 36;
      out.fidelity = "static-zero-time-phase";
    }
  } else if (tile.type === 444) {
    out.offsetY = -2;
    out.fidelity = "static-zero-wind";
  }
  return { commands: [out] };
}
