/** Original static tree planner derived from the documented 8255d346 behavior.
 * It reads real world roots/styles and never guesses an oak tree on missing data.
 */
export const STATIC_TREE_TYPES = Object.freeze([
  5, 323, 583, 584, 585, 586, 587, 588, 589, 596, 616, 634,
]);
export const TREE_CONTEXT_LIMITS = Object.freeze({
  rootRows: 512,
  foliageRows: 100,
  spriteSide: 64,
  foliageHaloTiles: 10,
});

function at(region, wx, wy) {
  if (!region?.rect) return null;
  const { x, y, width, height } = region.rect;
  if (wx < x || wy < y || wx >= x + width || wy >= y + height) return null;
  return region.cells[(wx - x) * height + wy - y] ?? null;
}
function refusal(reason, request = null) {
  return {
    supported: false,
    reason,
    commands: [],
    requiredAssets: [],
    ...(request ? { contextRequest: request } : {}),
  };
}
function localLookup(region, options) {
  return (wx, wy) =>
    at(region, wx, wy) ??
    at(region.context, wx, wy) ??
    (options.getWorldTile ?? region.getWorldTile)?.(wx, wy) ??
    null;
}
function shiftedTrunkX(x, frameX, frameY) {
  let result = x;
  if (frameX === 66 && frameY <= 45) result++;
  if (frameX === 88 && frameY >= 66 && frameY <= 110) result--;
  if (frameY >= 198) {
    if (frameX === 66) result--;
    if (frameX === 44) result++;
  } else if (frameY >= 132) {
    if (frameX === 22) result--;
    if (frameX === 44) result++;
  }
  return result;
}
const FOLIAGE_GROUNDS = new Set([
  2, 477, 23, 661, 70, 199, 662, 60, 147, 109, 492,
]);
function findRoot(get, x, y, type) {
  for (let offset = 0; offset < TREE_CONTEXT_LIMITS.rootRows; offset++) {
    const tile = get(x, y + offset);
    if (!tile)
      return {
        reason: "tree-root-context-required",
        request: { x, y: y + offset, width: 1, height: 1 },
      };
    if (!tile.active || tile.type !== type) return { x, y: y + offset, tile };
  }
  return {
    reason: "tree-root-scan-budget",
    request: { x, y, width: 1, height: TREE_CONTEXT_LIMITS.rootRows },
  };
}
const GEM_GROUNDS = new Set([
  1, 25, 117, 203, 182, 180, 179, 381, 183, 181, 534, 536, 539, 625, 627,
]);
const VANITY_GROUNDS = new Set([2, 23, 199, 109, 477, 492]);
function findFoliageGround(get, x, y, worldHeight, treeType) {
  const suitable = (type) =>
    treeType === 5
      ? FOLIAGE_GROUNDS.has(type)
      : treeType === 634
        ? type === 633
        : [596, 616].includes(treeType)
          ? VANITY_GROUNDS.has(type)
          : GEM_GROUNDS.has(type);
  for (let offset = 0; offset < TREE_CONTEXT_LIMITS.foliageRows; offset++) {
    if (Number.isInteger(worldHeight) && y + offset >= worldHeight)
      return { none: true };
    const tile = get(x, y + offset);
    if (!tile)
      return {
        reason: "tree-foliage-context-required",
        request: { x, y: y + offset, width: 1, height: 1 },
      };
    // The source foliage search tests the tile type, not solidity/adjacency.
    if (suitable(tile.type)) return { x, y: y + offset, tile };
  }
  return { none: true };
}
function trunkBiome(root, metadata) {
  if (!root.tile.active) return -1;
  switch (root.tile.type) {
    case 23:
    case 661:
      return 0;
    case 60:
      return Number.isFinite(metadata.worldSurface)
        ? root.y > metadata.worldSurface
          ? 5
          : 1
        : null;
    case 109:
    case 492:
      return 2;
    case 147:
      return 3;
    case 199:
    case 662:
      return 4;
    case 70:
      return 6;
    default:
      return -1;
  }
}
function foliageStyle(floor, anchorX, frame, metadata) {
  let style,
    width = 80,
    height = 80;
  const variations = metadata.treeTopVariations;
  switch (floor.tile.type) {
    case 2:
    case 477: {
      if (
        !Array.isArray(metadata.treeX) ||
        metadata.treeX.length !== 3 ||
        !Array.isArray(variations) ||
        variations.length < 4
      )
        return { reason: "tree-forest-style-metadata-required" };
      const zone =
        floor.x <= metadata.treeX[0]
          ? 0
          : floor.x <= metadata.treeX[1]
            ? 1
            : floor.x <= metadata.treeX[2]
              ? 2
              : 3;
      const variation = variations[zone];
      if (!Number.isInteger(variation) || variation < 0 || variation > 5)
        return { reason: "invalid-forest-tree-variation" };
      style = variation === 0 ? 0 : variation + 5;
      break;
    }
    case 23:
    case 661:
      style = 1;
      break;
    case 199:
    case 662:
      style = 5;
      break;
    case 70:
      style = 14;
      break;
    case 60: {
      if (!Number.isFinite(metadata.worldSurface))
        return { reason: "tree-world-surface-metadata-required" };
      height = 96;
      if (floor.y > metadata.worldSurface) {
        style = 13;
        width = 116;
      } else {
        if (!Number.isInteger(variations?.[5]))
          return { reason: "tree-jungle-style-metadata-required" };
        style = variations[5] === 1 ? 11 : 2;
        width = style === 11 ? 116 : 114;
      }
      break;
    }
    case 147: {
      if (
        !Number.isInteger(variations?.[6]) ||
        !Number.isInteger(metadata.worldWidth)
      )
        return { reason: "tree-snow-style-metadata-required" };
      const variation = variations[6];
      style = 4;
      if (variation === 0) style = anchorX % 10 === 0 ? 18 : 12;
      if ([2, 3, 32, 4, 42, 5, 7].includes(variation)) {
        const a =
          variation % 2 === 0
            ? anchorX < Math.trunc(metadata.worldWidth / 2)
            : anchorX > Math.trunc(metadata.worldWidth / 2);
        style = a ? 16 : 17;
      }
      break;
    }
    case 109:
    case 492: {
      if (!Number.isInteger(metadata.hallowBG))
        return { reason: "tree-hallow-background-metadata-required" };
      height = 140;
      style =
        metadata.hallowBG === 4
          ? 19
          : [2, 3].includes(metadata.hallowBG)
            ? 20
            : 3;
      if (style === 19) width = 120;
      frame += (anchorX % (style === 20 ? 6 : 3)) * 3;
      break;
    }
    default:
      return { reason: "unsupported-tree-foliage-ground" };
  }
  return { style, frame, width, height };
}

/** x/y are region-local tile coordinates; getWorldTile receives world coordinates.
 * Large real foliage sprites are split into <=64px crops so existing bounded
 * paint/channel conversion can render them without changing their geometry.
 */
export function planStaticTree(region, x, y, tile, options = {}) {
  if (!tile?.active || !STATIC_TREE_TYPES.includes(tile.type))
    return refusal("not-a-static-tree");
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !region?.rect)
    return refusal("invalid-tree-coordinate");
  if (
    ![tile.frameX, tile.frameY].every(Number.isInteger) ||
    tile.frameX < 0 ||
    (tile.type !== 323 && tile.frameY < 0)
  )
    return refusal("invalid-tree-frame");
  if (tile.shape) return refusal("unsupported-tree-shape");
  if (tile.invisibleBlock && !options.revealInvisible)
    return { supported: true, hidden: true, commands: [], requiredAssets: [] };
  const metadata = {
    worldWidth: region.source?.width,
    worldHeight: region.source?.height,
    worldSurface: region.source?.worldSurface,
    ...region.source?.treeContext,
    ...region.treeContext,
    ...options.treeContext,
  };
  const wx = region.rect.x + x,
    wy = region.rect.y + y,
    get = localLookup(region, options);
  const rootX =
    tile.type === 5 ? shiftedTrunkX(wx, tile.frameX, tile.frameY) : wx;
  const root = findRoot(get, rootX, wy, tile.type);
  if (root.reason) return refusal(root.reason, root.request);
  const commands = [];
  const paintId = options.paintEnabled === false ? 0 : tile.paint || 0;
  if (paintId >= 1 && paintId <= 12)
    return refusal("tree-paint-style-not-yet-supported");
  const add = ({
    asset,
    sx,
    sy,
    sw,
    sh,
    offsetX,
    offsetY,
    part,
    style,
    foliageStyle: foliageVariant = 0,
    glow = false,
  }) => {
    for (let py = 0; py < sh; py += TREE_CONTEXT_LIMITS.spriteSide)
      for (let px = 0; px < sw; px += TREE_CONTEXT_LIMITS.spriteSide) {
        const width = Math.min(TREE_CONTEXT_LIMITS.spriteSide, sw - px),
          height = Math.min(TREE_CONTEXT_LIMITS.spriteSide, sh - py);
        commands.push({
          kind: "tile",
          asset,
          sx: sx + px,
          sy: sy + py,
          sw: width,
          sh: height,
          dx: x * 16 + offsetX + px,
          dy: y * 16 + offsetY + py,
          dw: width,
          dh: height,
          x,
          y,
          type: tile.type,
          paintId: glow ? 0 : paintId,
          ...(glow ? { treeGlow: true } : {}),
          flipX: false,
          flipY: false,
          treePart: part,
          treeStyle: style,
          foliageStyle: foliageVariant,
          fidelity: "source-static-tree",
        });
      }
  };
  let foliage = null,
    biome;
  if (tile.type !== 323) {
    biome = tile.type === 5 ? trunkBiome(root, metadata) : 0;
    if (biome === null) return refusal("tree-world-surface-metadata-required");
    add({
      asset: `Tiles_${tile.type}.png`,
      sx: tile.frameX + (tile.type === 5 ? 176 * (biome + 1) : 0),
      sy: tile.frameY,
      sw: 20,
      sh: 20,
      offsetX: -2,
      offsetY: 0,
      part: "trunk",
      style: biome,
    });
    if (tile.type === 634)
      add({
        asset: "Glow_315.png",
        sx: tile.frameX,
        sy: tile.frameY,
        sw: 20,
        sh: 20,
        offsetX: -2,
        offsetY: 0,
        part: "trunk",
        style: 0,
        glow: true,
      });
    if (tile.frameY >= 198 && [22, 44, 66].includes(tile.frameX)) {
      const xOffset = tile.frameX === 44 ? 1 : tile.frameX === 66 ? -1 : 0;
      const floor = findFoliageGround(
        get,
        wx + xOffset,
        wy,
        metadata.worldHeight,
        tile.type,
      );
      if (floor.reason) return refusal(floor.reason, floor.request);
      if (floor.none)
        foliage = { omittedBySource: "no-compatible-ground-within-100-rows" };
      else {
        const frame = tile.frameY === 220 ? 1 : tile.frameY === 242 ? 2 : 0;
        const data =
          tile.type === 5
            ? foliageStyle(floor, wx, frame, metadata)
            : {
                style:
                  tile.type === 634
                    ? 31
                    : tile.type === 596
                      ? 29
                      : tile.type === 616
                        ? 30
                        : tile.type - 561,
                frame,
                width: [596, 616].includes(tile.type) ? 118 : 116,
                height: 96,
              };
        if (data.reason) return refusal(data.reason);
        foliage = {
          ...data,
          root: { x: floor.x, y: floor.y, type: floor.tile.type },
        };
        if (tile.frameX === 22)
          add({
            asset: `Tree_Tops_${data.style}.png`,
            sx: data.frame * (data.width + 2),
            sy: 0,
            sw: data.width,
            sh: data.height,
            offsetX: 8 - data.width / 2,
            offsetY: 16 - data.height,
            part: "crown",
            style: data.style,
          });
        else
          add({
            asset: `Tree_Branches_${data.style}.png`,
            sx: tile.frameX === 44 ? 0 : 42,
            sy: data.frame * 42,
            sw: 40,
            sh: 40,
            offsetX: tile.frameX === 44 ? -24 : 0,
            offsetY: -12,
            part: tile.frameX === 44 ? "left-branch" : "right-branch",
            style: data.style,
          });
        if (tile.type === 634) {
          if (tile.frameX === 22)
            add({
              asset: "Glow_316.png",
              sx: data.frame * (data.width + 2),
              sy: 0,
              sw: data.width,
              sh: data.height,
              offsetX: 8 - data.width / 2,
              offsetY: 16 - data.height,
              part: "crown",
              style: data.style,
              glow: true,
            });
          else
            add({
              asset: "Glow_317.png",
              sx: tile.frameX === 44 ? 0 : 42,
              sy: data.frame * 42,
              sw: 40,
              sh: 40,
              offsetX: tile.frameX === 44 ? -24 : 0,
              offsetY: -12,
              part: tile.frameX === 44 ? "left-branch" : "right-branch",
              style: data.style,
              glow: true,
            });
        }
      }
    }
  } else {
    if (!Number.isInteger(metadata.worldWidth))
      return refusal("palm-world-width-metadata-required");
    const beachDistance = metadata.beachDistance ?? 380;
    const oasis =
      wx >= beachDistance && wx <= metadata.worldWidth - beachDistance;
    biome = root.tile.active
      ? ({ 53: 0, 234: 1, 116: 2, 112: 3 }[root.tile.type] ?? -1)
      : -1;
    if (oasis) biome += 4;
    if (biome < 0 || biome > 7) return refusal("invalid-palm-ground-variant");
    if (tile.frameX >= 88 && tile.frameX <= 132) {
      const frame = tile.frameX === 110 ? 1 : tile.frameX === 132 ? 2 : 0;
      const wide = biome >= 4,
        style = wide ? 21 : 15,
        width = wide ? 114 : 80,
        height = wide ? 98 : 80;
      foliage = { style, frame, width, height };
      add({
        asset: `Tree_Tops_${style}.png`,
        sx: frame * (width + 2),
        sy: wide ? (biome - 4) * 98 : biome * 82,
        sw: width,
        sh: height,
        offsetX: tile.frameY - (wide ? 48 : 32),
        offsetY: 16 + (wide ? 2 : 0) - height,
        part: "palm-crown",
        style,
        foliageStyle: biome,
      });
    } else {
      add({
        asset: "Tiles_323.png",
        sx: tile.frameX,
        sy: 22 * biome,
        sw: 20,
        sh: 20,
        offsetX: tile.frameY - 2,
        offsetY: 0,
        part: "palm-trunk",
        style: biome,
      });
    }
  }
  return {
    supported: true,
    commands,
    requiredAssets: [...new Set(commands.map((c) => c.asset))].sort(),
    biome,
    root: { x: root.x, y: root.y, type: root.tile.type },
    foliage,
    fidelity: "source-static-tree",
    staticPose: "zero-wind",
    omissions: ["wind motion", "leaf particles", "dynamic lighting"],
  };
}
