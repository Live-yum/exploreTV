import { cellAt } from "./world.mjs";

/** Original bounded draw plans; source observations: docs/static-special-objects.md. */
export const STATIC_SPECIAL_OBJECT_TILES = Object.freeze([237, 597, 617, 711]);
export const STATIC_SPECIAL_OBJECT_HALO = 4;
export const STATIC_SPECIAL_OBJECT_SNAPSHOT = Object.freeze({
  globalTime: 0,
  tileFrame: 0,
  tileFrameCounter: 0,
  sunCircle: 0,
  mouseTextColor: 255,
  lighting: "unlit-white",
});
export const STATIC_SPECIAL_OBJECT_ASSETS = Object.freeze({
  "Tiles_237.png": [54, 36],
  "Tiles_597.png": [594, 72],
  "Tiles_617.png": [54, 144],
  "Tiles_711.png": [74, 38],
  "SunAltar.png": [54, 36],
  "SunOrb.png": [26, 26],
  "Extra_181.png": [420, 368],
  "Extra_198.png": [50, 1400],
});
const supported = new Set(STATIC_SPECIAL_OBJECT_TILES);
const fail = (unsupported) => ({ unsupported });
const visible = (tile, options) =>
  tile?.active && (options.revealInvisible || !tile.invisibleBlock);

function at(region, x, y, options) {
  const own = cellAt(region, x, y);
  if (own) return own;
  const wx = region.rect.x + x,
    wy = region.rect.y + y;
  if (region.context) {
    const halo = cellAt(
      region.context,
      wx - region.context.rect.x,
      wy - region.context.rect.y,
    );
    if (halo) return halo;
  }
  const lookup = options.getWorldTile || region.getWorldTile;
  return typeof lookup === "function" ? lookup(wx, wy) : null;
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
    paintId: tile.paint || 0,
    fullbrightBlock: !!tile.fullbrightBlock,
    invisibleBlock: !!tile.invisibleBlock,
    fidelity: "static-special-stored-frame",
    role: "body",
    ...extra,
  };
}

function overlay(tile, extra) {
  return sprite(tile, {
    staticOverlay: true,
    specialOverlay: true,
    specialLayer: "over-tiles",
    fidelity: "static-special-zero-time",
    ...extra,
  });
}

// The source's point-clamp sampling repeats the last row. Materialize those
// repetitions as legal one-pixel source crops instead of permitting overflow.
function clampBottom(command, height) {
  const available = height - command.sy;
  if (command.sh <= available) return [command];
  const out = [{ ...command, sh: available }];
  for (let row = available; row < command.sh; row++)
    out.push({
      ...command,
      sy: height - 1,
      sh: 1,
      offsetY: command.offsetY + row,
      fidelity: "static-special-point-clamp",
    });
  return out;
}

function orbitOffsets(count, radius) {
  // Float32 angle increments match the frozen source's orbital phases.
  const f = Math.fround,
    step = f(1 / count),
    tau = f(Math.PI * 2);
  return Array.from({ length: count }, (_, i) => {
    let phase = 0;
    for (let k = 0; k < i; k++) phase = f(phase + step);
    const angle = f(tau * phase);
    return [f(f(Math.cos(angle)) * radius), f(f(Math.sin(angle)) * radius)];
  });
}

function rainbowHalo(origin, wx, wy) {
  const commands = [],
    colors = [
      [76, 0, 0, 0],
      [0, 76, 0, 0],
      [0, 0, 76, 0],
    ];
  for (const [phase, vector] of orbitOffsets(3, 4).entries()) {
    // Floor after adding the absolute world position, as the source does.
    const dx = Math.floor(Math.fround(wx * 16 + vector[0])) - wx * 16;
    const dy = Math.floor(Math.fround(wy * 16 + vector[1])) - wy * 16;
    for (let col = 0; col < 2; col++)
      for (let row = 0; row < 2; row++) {
        commands.push(
          ...clampBottom(
            overlay(origin, {
              sx: 38 + col * 18,
              sy: row * 18,
              sw: 16 + col * 2,
              sh: 20 + row * 2,
              offsetX: col * 16 + dx,
              offsetY: row * 16 + dy,
              vertexColor: colors[phase],
              role: "rainbow-halo",
              specialLayer: "behind-object",
            }),
            38,
          ),
        );
      }
  }
  return commands;
}

/**
 * Plan one cell, plus the extras uniquely owned by that cell. Coordinates are
 * relative to region.rect and may reach four cells into its read-only halo.
 * The caller filters invisible cells, clips, and draws over-tiles commands
 * after ordinary tiles. It must also enumerate intersecting halo owners.
 * Returns null for unrelated types, {commands}, or {unsupported}; never claims
 * missing objects as empty-success. No Tile or supplied options are mutated.
 */
export function planStaticSpecialObject(region, x, y, tile, options = {}) {
  if (!tile || !supported.has(tile.type)) return null;
  const r = region?.rect;
  if (
    !r ||
    ![r.x, r.y, r.width, r.height, x, y].every(Number.isSafeInteger) ||
    r.x < 0 ||
    r.y < 0 ||
    r.width < 1 ||
    r.height < 1 ||
    r.width > 512 ||
    r.height > 512 ||
    r.width * r.height > 65536 ||
    !Array.isArray(region.cells) ||
    region.cells.length !== r.width * r.height ||
    x < -4 ||
    y < -4 ||
    x >= r.width + 4 ||
    y >= r.height + 4 ||
    r.x + x < 0 ||
    r.y + y < 0
  )
    return fail("Static special object requires bounded world coordinates");
  if (tile.shape)
    return fail(
      "Static special object does not define sloped or half-block sprites",
    );
  const { type, frameX: fx, frameY: fy } = tile;
  if (
    ![fx, fy].every(Number.isSafeInteger) ||
    fx < 0 ||
    fy < 0 ||
    fx % 18 ||
    fy % 18
  )
    return fail(
      "Static special object requires aligned nonnegative saved frames",
    );
  const width = type === 711 ? 2 : 3;
  const height = type === 237 || type === 711 ? 2 : 4;
  const styles = type === 597 ? 11 : type === 617 ? 28 : 1;
  const directions = type === 617 ? 2 : 1;
  if (fx >= width * 18 * styles || fy >= height * 18 * directions)
    return fail("Static special object has an unknown style or segment");
  const col = (fx / 18) % width,
    row = (fy / 18) % height;
  const ox = x - col,
    oy = y - row;
  const origin = col === 0 && row === 0 ? tile : at(region, ox, oy, options);
  if (
    !origin?.active ||
    origin.type !== type ||
    origin.frameX !== fx - col * 18 ||
    origin.frameY !== fy - row * 18
  )
    return fail("Static special object requires its matching origin tile");
  const wx = r.x + ox,
    wy = r.y + oy;
  const base = sprite(tile, { originX: wx, originY: wy });
  const commands = [base];

  if (type === 597 || type === 617) {
    const gate = at(region, ox + 1, oy + 1, options);
    if (
      !gate?.active ||
      gate.type !== type ||
      gate.frameX !== origin.frameX + 18 ||
      gate.frameY !== origin.frameY + 18
    )
      return fail(
        "Pylon or relic requires its matching visibility/coating child tile",
      );
    base.offsetY = 2;
    if (type === 617) {
      base.sx %= 54;
      base.sy %= 144;
    }
    if (
      col === 0 &&
      row === 0 &&
      visible(origin, options) &&
      visible(gate, options)
    ) {
      const pylon = type === 597,
        sizeX = pylon ? 30 : 50,
        sizeY = pylon ? 46 : 50;
      const floating = overlay(gate, {
        asset: pylon ? "Extra_181.png" : "Extra_198.png",
        sx: pylon ? (3 + fx / 54) * 30 : 0,
        sy: pylon ? Math.floor(((wx + wy) % 64) / 8) * 46 : (fx / 54) * 50,
        sw: sizeX,
        sh: sizeY,
        offsetX: 24 - sizeX / 2,
        offsetY: 24 - sizeY / 2,
        flipX: !pylon && fy >= 72,
        paintId: 0,
        originX: wx,
        originY: wy,
        visibilityX: wx + 1,
        visibilityY: wy + 1,
        role: pylon ? "pylon-crystal" : "relic-figure",
        vertexColor: pylon ? [178, 178, 178, 178] : [255, 255, 255, 255],
      });
      commands.push(floating);
      for (const [dx, dy] of orbitOffsets(6, 6))
        commands.push({
          ...floating,
          offsetX: floating.offsetX + dx,
          offsetY: floating.offsetY + dy,
          vertexColor: pylon ? [20, 20, 20, 0] : [17, 17, 17, 0],
          role: pylon ? "pylon-halo" : "relic-halo",
        });
    }
  } else if (type === 237) {
    const pulse =
      options.mouseTextColor ?? STATIC_SPECIAL_OBJECT_SNAPSHOT.mouseTextColor;
    if (!Number.isInteger(pulse) || pulse < 0 || pulse > 255)
      return fail("Altar requires a byte-valued static mouse-text pulse");
    const half = Math.floor(pulse / 2);
    commands.push(
      overlay(tile, {
        asset: "SunAltar.png",
        paintId: 0,
        role: "altar-glow",
        vertexColor: [half, half, half, 0],
        specialLayer: "with-body",
        originX: r.x + x,
        originY: r.y + y,
      }),
    );
    if (col === 1 && row === 0 && visible(tile, options))
      commands.push(
        overlay(tile, {
          asset: "SunOrb.png",
          sx: 0,
          sy: 0,
          sw: 26,
          sh: 26,
          offsetX: -5,
          offsetY: -49,
          paintId: 0,
          vertexColor: [pulse, pulse, pulse, 0],
          role: "altar-orb",
          originX: r.x + x,
          originY: r.y + y,
        }),
      );
  } else {
    base.sw = fx ? 18 : 16;
    base.sh = 20;
    base.offsetX = fx ? -1 : 0;
    if (col === 0 && row === 0 && visible(origin, options))
      commands.unshift(...rainbowHalo(origin, wx, wy));
  }
  return { commands };
}
