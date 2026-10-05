/** Bounded source-proved contexts. See docs/liquid-special-context.md. */
import { isSolidOrSlopedTile } from "./tile-solidity.mjs";
import { createVisibleLiquidSampler } from "./liquid-visible-level.mjs";

const LILY_CACHE = Symbol("liquid-cache:lily-nonsolid-nonplatform");
const WATER_STYLES = new Set([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13]);
const reject = (reason) => ({ supported: false, reason });
const alpha = (value) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
function at(region, x, y) {
  if (!region?.rect) return null;
  const dx = x - region.rect.x,
    dy = y - region.rect.y;
  return dx >= 0 && dy >= 0 && dx < region.rect.width && dy < region.rect.height
    ? (region.cells[dx * region.rect.height + dy] ?? null)
    : null;
}

export function createSpecialLiquidContextSampler(region, options = {}) {
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
    throw new RangeError("Invalid special liquid region");
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
  let sampleNormal;
  function normalAt(x, y) {
    if (!sampleNormal) {
      const projected = new WeakMap();
      const cacheCell = (tile) => {
        if (!tile || tile.type !== 518) return tile;
        if (!projected.has(tile))
          projected.set(tile, { ...tile, type: LILY_CACHE });
        return projected.get(tile);
      };
      const cacheRegion = (source) =>
        source && { ...source, cells: source.cells.map(cacheCell) };
      const cacheView = {
        ...cacheRegion(region),
        context: cacheRegion(region.context),
        getWorldTile: (wx, wy) => cacheCell(get(wx, wy)),
      };
      // This private cache descriptor asserts only source-proved material facts.
      // Active/halfbrick/shape, wall, level and liquid kind are unchanged. It is
      // never passed to the tile renderer or used as a texture ID.
      sampleNormal = createVisibleLiquidSampler(cacheView, {
        ...options,
        worldSurface,
        getWorldTile: cacheView.getWorldTile,
        isSolid: (tile) => (tile.type === LILY_CACHE ? false : isSolid(tile)),
      });
    }
    return sampleNormal(x, y);
  }

  return function sample(worldX, worldY) {
    if (!Number.isSafeInteger(worldX) || !Number.isSafeInteger(worldY))
      throw new RangeError("Invalid special liquid coordinate");
    const tile = get(worldX, worldY);
    if (!tile) return reject("special-missing-context");
    const neighborhood = [];
    for (let x = worldX - 1; x <= worldX + 1; x++)
      for (let y = worldY - 1; y <= worldY + 1; y++) {
        const n = get(x, y);
        if (!n) return reject("special-missing-context");
        if (
          !Number.isInteger(n.liquid ?? 0) ||
          (n.liquid ?? 0) < 0 ||
          (n.liquid ?? 0) > 255
        )
          return reject("special-invalid-liquid-level");
        if (
          !Number.isInteger(n.shape ?? 0) ||
          (n.shape ?? 0) < 0 ||
          (n.shape ?? 0) > 5
        )
          return reject("special-invalid-shape");
        if (n.active && !n.inactive) {
          if (n.type === 379) return reject("special-bubble-runtime-solid");
          if (n.type === 546) return reject("special-grate-context");
          if (typeof isSolid(n) !== "boolean")
            return reject("special-unknown-solid-neighborhood");
        }
        if (n.type === 379 && n.liquid)
          return reject("special-bubble-liquid-context");
        if (n.liquid && ![1, 2, 3, 4].includes(n.liquidKind))
          return reject("special-unknown-liquid-kind");
        if (n.liquid && n.liquidKind === 4)
          return reject("special-shimmer-context");
        neighborhood.push(n);
      }
    if (!Number.isFinite(worldSurface))
      return reject("special-world-surface-unknown");
    const kinds = new Set(
      neighborhood.filter((n) => n.liquid).map((n) => n.liquidKind),
    );
    if (!kinds.size) return reject("special-no-raw-liquid-context");
    const solid = isSolid(tile),
      x = worldX - rect.x,
      y = worldY - rect.y;
    let lilyUnderlay;
    if (tile.active && tile.type === 518) {
      if (tile.inactive) return reject("special-lily-actuation-context");
      if (options.layer !== "foreground")
        return reject("special-lily-background-layer");
      if (
        tile.shape ||
        tile.invisibleBlock ||
        !Number.isInteger(tile.frameX) ||
        tile.frameX < 0 ||
        tile.frameX > 306 ||
        tile.frameX % 18 ||
        ![0, 18, 36].includes(tile.frameY)
      )
        return reject("special-lily-sprite-context");
      if (!tile.liquid) return reject("special-dry-lily-context");
      let lift = Math.floor(tile.liquid / 16) - 3;
      if (lift > 8 && fullSolid(get(worldX, worldY - 1))) lift = 8;
      // Existing planStaticPlantsNext already supplies this exact tile sprite.
      // Record the layering requirement; never emit a duplicate tile command.
      lilyUnderlay = {
        asset: "Tiles_518.png",
        sx: tile.frameX,
        sy: tile.frameY,
        sw: 16,
        sh: 16,
        dx: x * 16,
        dy: y * 16 - lift,
        dw: 16,
        dh: 16,
      };
    }
    if (!solid) {
      if (!tile.liquid) return reject("special-dry-normal-cell");
      const normal = normalAt(worldX, worldY);
      if (!normal.supported) return reject(normal.reason);
      // A wet raw seed resets its own type/opacity after incoming trails. Do
      // not choose a neighbor's kind merely because the neighborhood is mixed.
      if (normal.command && normal.command.liquidType !== tile.liquidKind - 1)
        return reject("special-normal-type-mismatch");
      return {
        supported: true,
        commands: normal.command ? [normal.command] : [],
        requiredAssets: normal.command ? [normal.command.asset] : [],
        normalDrawn: !!normal.command,
        occluded: !!normal.occluded,
        contextRule:
          kinds.size > 1 ? "raw-seed-mixed-normal" : "known-nonsolid-normal",
        ...(lilyUnderlay ? { lilyUnderlay } : {}),
      };
    }
    // Only the observed ordinary solid-slope neighbors of lily pads need this
    // pass. Mixed behind-tile liquid can require additional style layers.
    if (kinds.size > 1) return reject("special-mixed-behind-liquid-context");
    if (!tile.shape)
      return {
        supported: true,
        commands: [],
        requiredAssets: [],
        occluded: true,
        contextRule: "known-full-solid",
      };
    if (tile.shape === 1) return reject("special-halfbrick-context");
    const slope = tile.shape - 1;
    const north = get(worldX, worldY - 1),
      west = get(worldX - 1, worldY);
    const east = get(worldX + 1, worldY),
      south = get(worldX, worldY + 1);
    const n = north.liquid > 0 && slope !== 3 && slope !== 4;
    const w = west.liquid > 0 && slope !== 1 && slope !== 3;
    const e = east.liquid > 0 && slope !== 2 && slope !== 4;
    const s = south.liquid > 240 && slope !== 1 && slope !== 2;
    if (!(n || w || e || s || tile.liquid))
      return {
        supported: true,
        commands: [],
        requiredAssets: [],
        occluded: true,
        contextRule: "slope-no-inflow",
      };
    if (
      (slope === 4 && !west.liquid && !fullSolid(west)) ||
      (slope === 3 && !east.liquid && !fullSolid(east))
    )
      return {
        supported: true,
        commands: [],
        requiredAssets: [],
        occluded: true,
        contextRule: "slope-open-side",
      };
    const kind = [...kinds][0] - 1,
      texture = kind === 0 ? waterStyle : kind === 1 ? 1 : 11;
    let sy = 4,
      height = 16,
      offsetY = 0;
    if (!(n && (w || e || s))) {
      if (n) height = 12;
      else if (s && !w && !e) {
        height = 4;
        offsetY = 12;
      } else {
        const level = Math.max(
          tile.liquid || 0,
          w ? west.liquid : 0,
          e ? east.liquid : 0,
        );
        offsetY = Math.trunc((256 - level) / 32) * 2;
        height = 16 - offsetY;
        sy = offsetY;
      }
    }
    if (height < 1 || sy < 0 || sy >= 16 || sy + height > 20)
      return reject("special-invalid-slope-crop");
    let opacity = kind === 1 ? lavaOpacity : kind === 2 ? 1 : 0.5;
    if (!(kind === 1 && lavaOpacity < 1) && worldY <= worldSurface)
      opacity = tile.wall === 21 ? 0.9 : tile.wall > 0 ? 0.6 : 1;
    const asset = `LiquidSlope_${texture}.png`,
      bodyRows = Math.min(height, 16 - sy);
    const command = {
      kind: "liquid",
      asset,
      sourceAsset: `Images/${asset}`,
      sx: 18 * (slope - 1),
      sy,
      sw: 16,
      sh: bodyRows,
      dx: x * 16,
      dy: y * 16 + offsetY,
      dw: 16,
      dh: bodyRows,
      opacity,
      layer: "behind-tile",
      drawBeforeTiles: true,
      liquidType: kind,
      liquidLevel: tile.liquid ?? 0,
      x,
      y,
      worldX,
      worldY,
      fidelity: "static-slope-liquid-atlas",
    };
    const commands = [command],
      clampedRows = height - bodyRows;
    if (clampedRows)
      commands.push({
        ...command,
        sy: 15,
        sh: 1,
        dy: command.dy + bodyRows,
        dh: clampedRows,
        sourceSampling: "point-clamp-bottom",
      });
    return {
      supported: true,
      commands,
      requiredAssets: [asset],
      clampedRows,
      normalDrawn: false,
      contextRule: "ordinary-slope-near-lily",
    };
  };
}
