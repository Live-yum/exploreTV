/** Original frozen halfbrick liquid plans. See docs/liquid-halfbrick.md. */
import { isSolidOrSlopedTile } from "./tile-solidity.mjs";
import { createVisibleLiquidSampler } from "./liquid-visible-level.mjs";

const WATER_STYLES = new Set([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13]);
const BLOCKS_BACK = new Set([54, 541, 328, 459, 470]);
const SPECIAL = new Set([379, 518, 546]);
const CLOUD_ORIGINS = new Set([196, 460, 717]);
const alpha = (value) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
const fail = (reason) => ({ supported: false, reason });

function at(region, x, y) {
  if (!region?.rect) return null;
  const dx = x - region.rect.x,
    dy = y - region.rect.y;
  return dx >= 0 && dy >= 0 && dx < region.rect.width && dy < region.rect.height
    ? (region.cells[dx * region.rect.height + dy] ?? null)
    : null;
}

/**
 * Reuse one sampler per region. This only plans a requested halfbrick; callers
 * must not add it over an already supported liquid cell. No game cache is read.
 */
export function createHalfbrickLiquidSampler(region, options = {}) {
  const rect = region?.rect;
  if (
    !rect ||
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    region.cells?.length !== rect.width * rect.height
  )
    throw new RangeError("Invalid halfbrick liquid region");
  const waterStyle = options.waterStyle ?? 0;
  if (!WATER_STYLES.has(waterStyle))
    throw new RangeError("Invalid water atlas");
  const worldSurface = options.worldSurface ?? region.source?.worldSurface;
  const lavaOpacity = alpha(options.lavaOpacity ?? 1);
  const isSolid = options.isSolid ?? isSolidOrSlopedTile;
  const reader = options.getWorldTile ?? region.getWorldTile;
  const get = (x, y) =>
    at(region, x, y) ??
    at(region.context, x, y) ??
    (typeof reader === "function" ? reader(x, y) : null);
  const fullSolid = (tile) => isSolid(tile) && !(tile.shape ?? 0);
  let sampleVisible;

  return function sample(worldX, worldY) {
    if (!Number.isSafeInteger(worldX) || !Number.isSafeInteger(worldY))
      throw new RangeError("Invalid halfbrick liquid coordinate");
    const tile = get(worldX, worldY);
    if (!tile) return fail("halfbrick-missing-context");
    if (tile.shape !== 1 || !tile.active || tile.inactive)
      return fail("halfbrick-active-shape-required");
    const neighborhood = [];
    for (let x = worldX - 1; x <= worldX + 1; x++)
      for (let y = worldY - 1; y <= worldY + 1; y++) {
        const n = get(x, y);
        if (!n) return fail("halfbrick-missing-context");
        if (
          !Number.isInteger(n.liquid ?? 0) ||
          (n.liquid ?? 0) < 0 ||
          (n.liquid ?? 0) > 255
        )
          return fail("halfbrick-invalid-liquid-level");
        if (
          !Number.isInteger(n.shape ?? 0) ||
          (n.shape ?? 0) < 0 ||
          (n.shape ?? 0) > 5
        )
          return fail("halfbrick-invalid-shape");
        // Behind-tile drawing ignores liquid carried by type 379 even when
        // inactive, while the normal cache has different rules. Keep this
        // exceptional disagreement explicit instead of mixing both passes.
        if (n.type === 379 && n.liquid)
          return fail("halfbrick-special-tile-neighborhood");
        if (n.active && !n.inactive) {
          if (SPECIAL.has(n.type))
            return fail("halfbrick-special-tile-neighborhood");
          if (typeof isSolid(n) !== "boolean")
            return fail("halfbrick-unknown-solid-neighborhood");
        }
        if (n.liquid && ![1, 2, 3, 4].includes(n.liquidKind))
          return fail("halfbrick-unknown-liquid-kind");
        neighborhood.push(n);
      }
    if (!isSolid(tile)) return fail("halfbrick-non-solid");
    if (!Number.isFinite(worldSurface))
      return fail("halfbrick-world-surface-unknown");
    const north = get(worldX, worldY - 1),
      west = get(worldX - 1, worldY);
    const east = get(worldX + 1, worldY),
      south = get(worldX, worldY + 1);
    const wetKinds = new Set(
      neighborhood.filter((n) => n.liquid).map((n) => n.liquidKind),
    );
    if (wetKinds.has(4)) return fail("halfbrick-shimmer");
    if (wetKinds.size > 1) return fail("halfbrick-mixed-liquid-neighborhood");
    if (!wetKinds.size)
      return {
        supported: true,
        commands: [],
        requiredAssets: [],
        occluded: true,
      };
    const liquidKind = [...wetKinds][0],
      kind = liquidKind - 1;
    const texture = kind === 0 ? waterStyle : kind === 1 ? 1 : 11;
    const fromNorth = north.liquid > 0,
      fromWest = west.liquid > 0,
      fromEast = east.liquid > 0;
    const fromSouth = south.liquid > 240,
      fromSelf = tile.liquid > 160;
    const needsBack =
      !BLOCKS_BACK.has(tile.type) &&
      !(fromNorth && tile.wall > 0) &&
      (fromNorth || fromWest || fromEast || fromSouth || fromSelf);
    let waterfallDecision = "not-needed";
    if (needsBack && (west.liquid > 160 || east.liquid > 160)) {
      // CheckForWaterfall searches registered origin coordinates, not raw wet
      // sides. Reject possible origins: viewport/quality limits/cache age are
      // runtime state. A fresh static scan cannot register a disproved origin.
      const openSide = (n) => !n.liquid && !fullSolid(n) && (n.shape ?? 0) <= 1;
      const halfOrigin =
        (north.liquid < 16 || fullSolid(north)) &&
        (openSide(west) || openSide(east));
      const cloudOrigin =
        north.active && CLOUD_ORIGINS.has(north.type) && !tile.liquid;
      if (halfOrigin || cloudOrigin)
        return fail("halfbrick-waterfall-state-required");
      waterfallDecision = "fresh-scan-ineligible";
    } else if (needsBack) waterfallDecision = "no-high-side";

    const commands = [],
      assets = new Set();
    let gradientRows = 0,
      clampedRows = 0;
    if (needsBack) {
      let sourceY = 4,
        height = 16,
        offsetY = 0;
      if (!(fromNorth && (fromWest || fromEast || fromSouth))) {
        if (fromNorth) height = 12;
        else if (fromSouth && !fromWest && !fromEast) {
          height = 4;
          offsetY = 12;
        } else {
          const level = Math.max(
            fromSelf ? tile.liquid : 0,
            west.liquid || 0,
            east.liquid || 0,
          );
          offsetY = Math.trunc((256 - level) / 32) * 2;
          height = 16 - offsetY;
          sourceY = 0;
        }
      }
      if (
        height < 1 ||
        height > 16 ||
        sourceY < 0 ||
        sourceY >= 16 ||
        sourceY + height > 20
      )
        return fail("halfbrick-invalid-source-crop");
      let opacity = kind === 1 ? lavaOpacity : kind === 2 ? 1 : 0.5;
      if (!(kind === 1 && lavaOpacity < 1) && worldY <= worldSurface)
        opacity = tile.wall === 21 ? 0.9 : tile.wall > 0 ? 0.6 : 1;
      // Fullbright byte colors are multiplied on the CPU before interpolation.
      const bottomByte = Math.trunc(Math.fround(255 * Math.fround(opacity)));
      const gradient = fromNorth && worldY > worldSurface;
      const asset = `Liquid_${texture}.png`,
        x = worldX - rect.x,
        y = worldY - rect.y;
      const base = {
        kind: "liquid",
        asset,
        sourceAsset: `Images/${asset}`,
        sx: 0,
        sw: 16,
        dx: x * 16,
        dw: 16,
        layer: "behind-tile",
        drawBeforeTiles: true,
        liquidType: kind,
        liquidLevel: tile.liquid ?? 0,
        x,
        y,
        worldX,
        worldY,
        fidelity: gradient
          ? "static-halfbrick-liquid-gradient"
          : "static-halfbrick-liquid-back",
      };
      if (gradient) {
        // Unit-height destination strips sample the original PointClamp texture
        // at native pixel centers, with the source quad's vertical color ramp.
        for (let row = 0; row < height; row++) {
          const sourceRow = sourceY + row;
          commands.push({
            ...base,
            sy: Math.min(15, sourceRow),
            sh: 1,
            dy: y * 16 + offsetY + row,
            dh: 1,
            opacity: (bottomByte / 255) * ((row + 0.5) / height),
            gradientRow: row,
            gradientHeight: height,
            vertexAlphaEndpoints: [0, bottomByte],
            ...(sourceRow >= 16
              ? { sourceSampling: "point-clamp-bottom" }
              : {}),
          });
          if (sourceRow >= 16) clampedRows++;
        }
        gradientRows = height;
      } else {
        const rows = Math.min(height, 16 - sourceY);
        commands.push({
          ...base,
          sy: sourceY,
          sh: rows,
          dy: y * 16 + offsetY,
          dh: rows,
          opacity: bottomByte / 255,
        });
        if (rows < height) {
          clampedRows = height - rows;
          commands.push({
            ...base,
            sy: 15,
            sh: 1,
            dy: y * 16 + offsetY + rows,
            dh: clampedRows,
            opacity: bottomByte / 255,
            sourceSampling: "point-clamp-bottom",
          });
        }
      }
      assets.add(asset);
    }
    let normalDrawn = false;
    // Without raw liquid above the normal renderer treats the solid halfbrick
    // as a solid cell. Unwalled partial raw liquid is explicitly invisible.
    if (fromNorth && (tile.wall > 0 || !tile.liquid || tile.liquid === 255)) {
      sampleVisible ??= createVisibleLiquidSampler(region, {
        ...options,
        isSolid,
        worldSurface,
      });
      const normal = sampleVisible(worldX, worldY);
      if (!normal.supported) return fail(normal.reason);
      if (normal.command) {
        commands.push(normal.command);
        assets.add(normal.command.asset);
        normalDrawn = true;
      }
    }
    return {
      supported: true,
      commands,
      requiredAssets: [...assets].sort(),
      occluded: commands.length === 0,
      gradientRows,
      clampedRows,
      normalDrawn,
      waterfallDecision,
    };
  };
}
