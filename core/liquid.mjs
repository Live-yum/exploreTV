/** Original bounded flat-fill preview; this is not the game's liquid geometry solver. */
const FRONT_ALPHA = [0.6, 0.95, 0.95];
const SPECIAL = new Set([379, 518, 546]);
const WATER_STYLES = new Set([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13]);
const frameIndex = (value) =>
  Number.isFinite(value) ? ((Math.trunc(value) % 16) + 16) % 16 : 0;
const opacity = (value) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
function at(region, wx, wy) {
  if (!region?.rect) return null;
  const { x, y, width, height } = region.rect;
  const dx = wx - x,
    dy = wy - y;
  return dx >= 0 && dy >= 0 && dx < width && dy < height
    ? (region.cells[dx * height + dy] ?? null)
    : null;
}

export function planLiquids(region, options = {}) {
  const support = {
    mode: options.enabled ? "flat-fill-approximation" : "disabled",
    lighting: "fullbright",
    liquidCells: 0,
    drawn: 0,
    skippedSolid: 0,
    unsupported: 0,
    unsupportedByReason: {},
    unsupportedCoordinates: [],
    missingContextCells: 0,
    worldSurfaceKnown: false,
    layer: options.layer === "foreground" ? "foreground" : "background",
  };
  const result = { commands: [], requiredAssets: [], warnings: [], support };
  if (!options.enabled) return result;
  const rect = region?.rect;
  if (
    !rect ||
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    rect.width > 512 ||
    rect.height > 512 ||
    rect.width * rect.height > 65536 ||
    region.cells?.length !== rect.width * rect.height
  )
    throw new RangeError("Invalid liquid region bounds");
  const waterStyle = options.waterStyle ?? 0;
  if (!WATER_STYLES.has(waterStyle))
    throw new RangeError("waterStyle must name a water atlas (0,2..10,12,13)");
  const worldSurface = options.worldSurface ?? region.source?.worldSurface;
  support.worldSurfaceKnown = Number.isFinite(worldSurface);
  const frame = frameIndex(options.frame ?? 0);
  const waterfallFrame = frameIndex(options.waterfallFrame ?? 0);
  const lavaOpacity = opacity(options.lavaOpacity ?? 1);
  const get = (x, y) => at(region, x, y) ?? at(region.context, x, y);
  const solid = (t) =>
    Boolean(t?.active && !t.inactive && options.isSolid?.(t));
  const reject = (x, y, reason) => {
    support.unsupported++;
    support.unsupportedByReason[reason] =
      (support.unsupportedByReason[reason] ?? 0) + 1;
    support.unsupportedCoordinates.push({ x, y, reason });
  };
  const assets = new Set();
  const { x: ox, y: oy, width, height } = region.rect;
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++) {
      const wx = ox + x,
        wy = oy + y,
        tile = get(wx, wy);
      if (!tile?.liquid) continue;
      support.liquidCells++;
      if (
        !Number.isInteger(tile.liquid) ||
        tile.liquid < 1 ||
        tile.liquid > 255
      ) {
        reject(wx, wy, "invalid-liquid-level");
        continue;
      }
      // World parser stores 1..4; Terraria LiquidID uses 0..3.
      const kind = tile.liquidKind - 1;
      if (kind === 3) {
        reject(wx, wy, "shimmer");
        continue;
      }
      if (![0, 1, 2].includes(kind)) {
        reject(wx, wy, "unknown-liquid-kind");
        continue;
      }
      let reason = null,
        missing = false;
      for (let nx = wx - 1; nx <= wx + 1; nx++)
        for (let ny = wy - 1; ny <= wy + 1; ny++) {
          const n = get(nx, ny);
          if (!n) {
            missing = true;
            continue;
          }
          if (n.active && !n.inactive) {
            if (n.shape)
              reason ??=
                n.shape === 1 ? "halfbrick-neighborhood" : "slope-neighborhood";
            if (SPECIAL.has(n.type)) reason ??= "special-tile-neighborhood";
            if (
              (typeof options.isSolid !== "function" ||
                options.isSolid(n) === undefined) &&
              n.type !== 19
            )
              reason ??= "unknown-solid-neighborhood";
          }
          if (n.liquid && n.liquidKind !== tile.liquidKind)
            reason ??= "mixed-liquid-neighborhood";
        }
      if (missing) support.missingContextCells++;
      if (reason) {
        reject(wx, wy, reason);
        continue;
      }
      if (solid(tile)) {
        support.skippedSolid++;
        continue;
      }
      const occupied = (dx, dy) => {
        const n = get(wx + dx, wy + dy);
        return (
          solid(n) || Boolean(n?.liquid && n.liquidKind === tile.liquidKind)
        );
      };
      // Raw-cell adjacency chooses an atlas family. No visible-level propagation or smoothing.
      const left = !occupied(-1, 0),
        right = !occupied(1, 0),
        top = !occupied(0, -1);
      let sx = left ? 0 : right ? 32 : 16;
      let baseY = top ? 0 : left || right ? (wy % 2 === 0 ? 32 : 16) : 48;
      if (left && right) {
        sx = 16;
        baseY = top ? 16 : 32;
      }
      const surface =
        sx === 16 &&
        baseY === 0 &&
        support.worldSurfaceKnown &&
        wy > worldSurface - 40;
      const fillHeight = Math.ceil((tile.liquid / 255) * 16);
      const topInset = 16 - fillHeight;
      const sy = surface
        ? 1280
        : baseY + (sx === 16 ? waterfallFrame : frame) * 80 + topInset;
      const texture = kind === 0 ? waterStyle : kind === 1 ? 1 : 11;
      const asset = `water_${texture}.png`;
      const frontOpacity = FRONT_ALPHA[kind] * (kind === 1 ? lavaOpacity : 1);
      const alpha =
        support.layer === "foreground"
          ? frontOpacity
          : kind === 1
            ? lavaOpacity
            : 1;
      result.commands.push({
        kind: "liquid",
        asset,
        sourceAsset: `Images/Misc/${asset}`,
        sx,
        sy,
        sw: 16,
        sh: fillHeight,
        dx: x * 16,
        dy: y * 16 + topInset,
        dw: 16,
        dh: fillHeight,
        opacity: alpha,
        frontOpacity,
        layer: support.layer,
        liquidType: kind,
        liquidLevel: tile.liquid,
        x,
        y,
        worldX: wx,
        worldY: wy,
        fidelity: "flat-fill-approximation",
      });
      assets.add(asset);
      support.drawn++;
    }
  result.requiredAssets = [...assets].sort();
  result.warnings.push(
    "Liquid preview is a frozen, fullbright flat-fill approximation; smoothing, falling trails, distortion, particles and behind-shape overlap are not reproduced.",
  );
  if (!support.worldSurfaceKnown)
    result.warnings.push(
      "worldSurface is unknown: special surface atlas selection is unavailable.",
    );
  if (support.missingContextCells)
    result.warnings.push(
      `${support.missingContextCells} liquid cells lack full neighbor context; missing neighbors are treated as empty.`,
    );
  if (support.unsupported)
    result.warnings.push(
      `${support.unsupported} liquid cells skipped: ${Object.entries(
        support.unsupportedByReason,
      )
        .map(([key, count]) => `${key}=${count}`)
        .join(", ")}.`,
    );
  return result;
}
