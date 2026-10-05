/** Dry mixed-halfbrick source plans; see docs/liquid-mixed-halfbrick.md. */
import { isSolidOrSlopedTile } from "./tile-solidity.mjs";
import { createVisibleLiquidSampler } from "./liquid-visible-level.mjs";

const WATER = new Set([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13]);
const SPECIAL = new Set([379, 518, 546]);
const BLOCKS_BACK = new Set([54, 541, 328, 459, 470]);
const CLOUDS = new Set([196, 460, 717]);
const fail = (reason) => ({ supported: false, reason });
const f = Math.fround;
const at = (region, x, y) => {
  if (!region?.rect) return null;
  const dx = x - region.rect.x,
    dy = y - region.rect.y;
  return dx >= 0 && dy >= 0 && dx < region.rect.width && dy < region.rect.height
    ? (region.cells[dx * region.rect.height + dy] ?? null)
    : null;
};

export function createMixedHalfbrickLiquidSampler(region, options = {}) {
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
    throw new RangeError("Invalid mixed halfbrick region");
  const waterStyle = options.waterStyle ?? 0,
    worldSurface = options.worldSurface ?? region.source?.worldSurface;
  if (!WATER.has(waterStyle))
    throw new RangeError("Invalid mixed halfbrick water style");
  const styleAlpha =
    options.liquidStyleAlpha ??
    Array.from({ length: 15 }, (_, i) => Number(i === waterStyle));
  if (
    !Array.isArray(styleAlpha) ||
    styleAlpha.length !== 15 ||
    !styleAlpha.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
  )
    throw new RangeError("Invalid frozen liquid-style alpha vector");
  const frozenAlpha = styleAlpha.map(f),
    isSolid = options.isSolid ?? isSolidOrSlopedTile;
  const lavaOpacity = Number.isFinite(options.lavaOpacity ?? 1)
    ? Math.max(0, Math.min(1, options.lavaOpacity ?? 1))
    : 1;
  const reader = options.getWorldTile ?? region.getWorldTile;
  const get = (x, y) =>
    at(region, x, y) ??
    at(region.context, x, y) ??
    (typeof reader === "function" ? reader(x, y) : null);
  const fullSolid = (t) => isSolid(t) && !(t.shape ?? 0);
  let sampleNormal;
  return (worldX, worldY) => {
    if (!Number.isSafeInteger(worldX) || !Number.isSafeInteger(worldY))
      throw new RangeError("Invalid mixed halfbrick coordinate");
    const tile = get(worldX, worldY);
    if (!tile) return fail("mixed-halfbrick-missing-context");
    if (!tile.active || tile.inactive || tile.shape !== 1 || tile.liquid)
      return fail("mixed-halfbrick-dry-active-shape-required");
    const neighborhood = [];
    for (let x = worldX - 1; x <= worldX + 1; x++)
      for (let y = worldY - 1; y <= worldY + 1; y++) {
        const n = get(x, y);
        if (!n) return fail("mixed-halfbrick-missing-context");
        if (
          !Number.isInteger(n.liquid ?? 0) ||
          (n.liquid ?? 0) < 0 ||
          (n.liquid ?? 0) > 255 ||
          !Number.isInteger(n.shape ?? 0) ||
          (n.shape ?? 0) < 0 ||
          (n.shape ?? 0) > 5
        )
          return fail("mixed-halfbrick-invalid-record");
        if (n.liquid && ![1, 2, 3, 4].includes(n.liquidKind))
          return fail("mixed-halfbrick-unknown-liquid-kind");
        if (n.liquid && n.liquidKind === 4)
          return fail("mixed-halfbrick-shimmer-context");
        if (
          (n.type === 379 && n.liquid) ||
          (n.active && !n.inactive && SPECIAL.has(n.type))
        )
          return fail("mixed-halfbrick-special-context");
        if (n.active && !n.inactive && typeof isSolid(n) !== "boolean")
          return fail("mixed-halfbrick-unknown-solidity");
        neighborhood.push(n);
      }
    if (!isSolid(tile)) return fail("mixed-halfbrick-non-solid");
    if (!Number.isFinite(worldSurface))
      return fail("mixed-halfbrick-world-surface-unknown");
    const kinds = new Set(
      neighborhood.filter((n) => n.liquid).map((n) => n.liquidKind),
    );
    if (kinds.size < 2) return fail("mixed-halfbrick-mixed-context-required");
    const north = get(worldX, worldY - 1),
      west = get(worldX - 1, worldY),
      east = get(worldX + 1, worldY),
      south = get(worldX, worldY + 1);
    const fromNorth = north.liquid > 0,
      fromWest = west.liquid > 0,
      fromEast = east.liquid > 0,
      fromSouth = south.liquid > 240;
    let needsBack =
      !BLOCKS_BACK.has(tile.type) &&
      !(fromNorth && tile.wall > 0) &&
      (fromNorth || fromWest || fromEast || fromSouth);
    let waterfallDecision = "not-needed";
    if (needsBack && (west.liquid > 160 || east.liquid > 160)) {
      const registered = options.waterfallRegistry?.hasOrigin(worldX, worldY);
      if (options.waterfallRegistry && typeof registered !== "boolean")
        return fail("mixed-halfbrick-waterfall-state-required");
      if (typeof registered === "boolean") {
        waterfallDecision = registered
          ? "registered-suppress-behind"
          : "snapshot-not-registered";
        if (registered) needsBack = false;
      } else {
        const open = (n) => !n.liquid && !fullSolid(n) && (n.shape ?? 0) <= 1;
        if (
          ((north.liquid < 16 || fullSolid(north)) &&
            (open(west) || open(east))) ||
          (north.active && CLOUDS.has(north.type))
        )
          return fail("mixed-halfbrick-waterfall-state-required");
        waterfallDecision = "fresh-scan-ineligible";
      }
    }
    // Directional non-water selection and water presence are independent facts.
    // Even a south amount <=240 can select the material without enabling a
    // south-only rectangle. Diagonal kinds do not enter this behind pass.
    let primaryTexture = 0,
      waterPresent = false;
    for (const n of [west, east, north, south])
      if (n.liquid) {
        if (n.liquidKind === 1) waterPresent = true;
        else primaryTexture = n.liquidKind === 2 ? 1 : 11;
      }
    if (primaryTexture === 0) primaryTexture = waterStyle;
    const layerDecisions = [],
      commands = [],
      assets = new Set();
    let gradientRows = 0,
      clampedRows = 0;
    if (needsBack) {
      let sy = 4,
        height = 16,
        offsetY = 0;
      if (!(fromNorth && (fromWest || fromEast || fromSouth))) {
        if (fromNorth) height = 12;
        else if (fromSouth && !fromWest && !fromEast) {
          height = 4;
          offsetY = 12;
        } else {
          offsetY =
            Math.trunc(
              (256 - Math.max(west.liquid || 0, east.liquid || 0)) / 32,
            ) * 2;
          height = 16 - offsetY;
          sy = 0;
        }
      }
      if (height < 1 || height > 16 || sy < 0 || sy + height > 20)
        return fail("mixed-halfbrick-invalid-source-crop");
      let opacity =
        primaryTexture === 1 ? lavaOpacity : primaryTexture === 11 ? 1 : 0.5;
      if (!(primaryTexture === 1 && lavaOpacity < 1) && worldY <= worldSurface)
        opacity = tile.wall === 21 ? 0.9 : tile.wall > 0 ? 0.6 : 1;
      const bottomByte = Math.trunc(f(f(255) * f(opacity))),
        gradient = fromNorth && worldY > worldSurface;
      const extraWater = waterPresent
        ? [...WATER].find((i) => frozenAlpha[i] > 0 && i !== primaryTexture)
        : undefined;
      const layers = [];
      if (extraWater !== undefined)
        layers.push({
          texture: extraWater,
          bottomByte,
          role: "additional-water",
        });
      layers.push({
        texture: primaryTexture,
        bottomByte:
          extraWater === undefined
            ? bottomByte
            : Math.trunc(f(bottomByte * frozenAlpha[primaryTexture])),
        role: "directional-primary",
      });
      for (const layer of layers) {
        layerDecisions.push({ ...layer, emitted: layer.bottomByte > 0 });
        if (!layer.bottomByte) continue;
        const asset = `Liquid_${layer.texture}.png`,
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
          x,
          y,
          worldX,
          worldY,
          layer: "behind-tile",
          drawBeforeTiles: true,
          liquidType: layer.texture === 1 ? 1 : layer.texture === 11 ? 2 : 0,
          liquidLevel: 0,
          fidelity: "static-dry-mixed-halfbrick",
          mixedLayer: layer.role,
        };
        if (gradient)
          for (let row = 0; row < height; row++) {
            commands.push({
              ...base,
              sy: Math.min(15, sy + row),
              sh: 1,
              dy: y * 16 + offsetY + row,
              dh: 1,
              opacity: (layer.bottomByte / 255) * ((row + 0.5) / height),
              gradientRow: row,
              gradientHeight: height,
              vertexAlphaEndpoints: [0, layer.bottomByte],
              ...(sy + row >= 16
                ? { sourceSampling: "point-clamp-bottom" }
                : {}),
            });
            gradientRows++;
            if (sy + row >= 16) clampedRows++;
          }
        else {
          const body = Math.min(height, 16 - sy);
          commands.push({
            ...base,
            sy,
            sh: body,
            dy: y * 16 + offsetY,
            dh: body,
            opacity: layer.bottomByte / 255,
          });
          if (body < height) {
            commands.push({
              ...base,
              sy: 15,
              sh: 1,
              dy: y * 16 + offsetY + body,
              dh: height - body,
              opacity: layer.bottomByte / 255,
              sourceSampling: "point-clamp-bottom",
            });
            clampedRows += height - body;
          }
        }
        assets.add(asset);
      }
    }
    let normalDrawn = false;
    if (fromNorth) {
      sampleNormal ??= createVisibleLiquidSampler(region, {
        ...options,
        isSolid,
        worldSurface,
      });
      const normal = sampleNormal(worldX, worldY);
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
      normalDrawn,
      gradientRows,
      clampedRows,
      waterfallDecision,
      primaryTexture,
      waterPresent,
      layerDecisions,
      liquidStyleAlpha: [...frozenAlpha],
      contextRule: "dry-mixed-halfbrick-directional-layers",
    };
  };
}
