/** Original bounded static liquid subsets; see docs/liquid-lighting-scope.md. */
import { createVisibleLiquidSampler } from "./liquid-visible-level.mjs";
import { createHalfbrickLiquidSampler } from "./liquid-halfbrick.mjs";

const FRONT_ALPHA = [0.6, 0.95, 0.95];
const SPECIAL = new Set([379, 518, 546]);
const PLATFORMS = new Set([19, 427, 435, 436, 437, 438, 439]);
const BLOCKS_BACK_LIQUID = new Set([54, 541, 328, 459, 470]);
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

// Source-backed behind-solid geometry, restricted to crops contained in the
// actual 16px-high Liquid/LiquidSlope PNGs. PointClamp overflow is split below
// into valid source rows. No guessed polygon substitutes.
function behindShape(
  tile,
  neighbors,
  { texture, worldY, worldSurface, lavaOpacity, solid },
) {
  const [north, west, east, south] = neighbors;
  const half = tile.shape === 1;
  const slope = half ? 0 : tile.shape - 1;
  if (half && BLOCKS_BACK_LIQUID.has(tile.type)) return { occluded: true };
  if (!Number.isFinite(worldSurface))
    return { reason: "shape-world-surface-unknown" };
  if (half && north.liquid) return { reason: "halfbrick-overlap-neighborhood" };
  // The runtime waterfall manager can suppress this halfbrick branch.
  if (half && ((west.liquid || 0) > 160 || (east.liquid || 0) > 160))
    return { reason: "halfbrick-waterfall-neighborhood" };
  const fromWest = !!west.liquid && slope !== 1 && slope !== 3;
  const fromEast = !!east.liquid && slope !== 2 && slope !== 4;
  const fromNorth = !!north.liquid && slope !== 3 && slope !== 4;
  const fromSouth = (south.liquid || 0) > 240 && slope !== 1 && slope !== 2;
  const fromSelf = tile.liquid > (half ? 160 : 0);
  if (!(fromWest || fromEast || fromNorth || fromSouth || fromSelf))
    return { occluded: true };
  const level = Math.max(
    tile.liquid > (half ? 160 : 0) ? tile.liquid : 0,
    fromWest ? west.liquid : 0,
    fromEast ? east.liquid : 0,
  );
  let sy = 4,
    sh = 16,
    offsetY = 0;
  if (!((fromNorth && (fromWest || fromEast)) || (fromNorth && fromSouth))) {
    if (fromNorth) sh = 12;
    else if (fromSouth && !fromWest && !fromEast) {
      sh = 4;
      offsetY = 12;
    } else {
      offsetY = Math.floor((256 - level) / 32) * 2;
      sh = 16 - offsetY;
      sy = half ? 0 : offsetY;
    }
  }
  if (sh <= 0 || sy < 0 || sy >= 16 || sy + sh > 20)
    return { reason: "invalid-shape-source-crop" };
  let alpha = texture === 1 ? lavaOpacity : texture === 11 ? 1 : 0.5;
  if (!(texture === 1 && lavaOpacity < 1) && worldY <= worldSurface)
    alpha = tile.wall === 21 ? 0.9 : tile.wall > 0 ? 0.6 : 1;
  const fullSolid = (n) => solid(n) && !(n.shape || 0);
  if (
    (slope === 4 && !west.liquid && !fullSolid(west)) ||
    (slope === 3 && !east.liquid && !fullSolid(east))
  )
    return { occluded: true };
  return {
    asset: `${half ? "Liquid" : "LiquidSlope"}_${texture}.png`,
    sx: half ? 0 : 18 * (slope - 1),
    sy,
    sw: 16,
    sh,
    offsetY,
    opacity: alpha,
    layer: "behind-tile",
    drawBeforeTiles: true,
    fidelity: half
      ? "static-halfbrick-back-liquid"
      : "static-slope-liquid-atlas",
  };
}

export function planLiquids(region, options = {}) {
  const support = {
    mode: options.enabled ? "flat-fill-approximation" : "disabled",
    lighting: "fullbright",
    liquidCells: 0,
    shapeCandidateCells: 0,
    evaluatedCells: 0,
    drawn: 0,
    skippedSolid: 0,
    skippedOccluded: 0,
    shapeDrawn: 0,
    sourceGeometryDrawn: 0,
    visibleLevelDrawn: 0,
    clampedShapeCells: 0,
    gradientShapeCells: 0,
    gradientRows: 0,
    commandCount: 0,
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
    Boolean(
      t?.active &&
        !t.inactive &&
        !PLATFORMS.has(t.type) &&
        options.isSolid?.(t),
    );
  const reject = (x, y, reason) => {
    support.unsupported++;
    support.unsupportedByReason[reason] =
      (support.unsupportedByReason[reason] ?? 0) + 1;
    support.unsupportedCoordinates.push({ x, y, reason });
  };
  const assets = new Set();
  let sampleVisible, sampleHalfbrick;
  const visibleAt = (x, y) => {
    sampleVisible ??= createVisibleLiquidSampler(region, {
      ...options,
      worldSurface,
    });
    return sampleVisible(x, y);
  };
  const addVisible = (visible, ownShape) => {
    if (!visible.command) {
      support.skippedOccluded++;
      return;
    }
    result.commands.push(visible.command);
    assets.add(visible.command.asset);
    support.drawn++;
    support.sourceGeometryDrawn++;
    support.visibleLevelDrawn++;
    if (ownShape) support.shapeDrawn++;
  };
  const { x: ox, y: oy, width, height } = region.rect;
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++) {
      const wx = ox + x,
        wy = oy + y,
        tile = get(wx, wy);
      if (!tile) continue;
      // Behind-tile liquid can come from wet neighbors while the solid slope
      // stores zero liquid. Preserve that raw record and count it separately.
      const dryShape = !tile.liquid && tile.shape && solid(tile);
      let liquidKind = tile.liquidKind;
      if (!tile.liquid) {
        if (!dryShape) continue;
        const wetNeighbors = [
          get(wx, wy - 1),
          get(wx - 1, wy),
          get(wx + 1, wy),
          get(wx, wy + 1),
        ].filter((neighbor) => neighbor?.liquid);
        if (!wetNeighbors.length) continue;
        liquidKind = wetNeighbors[0].liquidKind;
        support.shapeCandidateCells++;
      } else support.liquidCells++;
      support.evaluatedCells++;
      if (
        !Number.isInteger(tile.liquid) ||
        tile.liquid < (dryShape ? 0 : 1) ||
        tile.liquid > 255
      ) {
        reject(wx, wy, "invalid-liquid-level");
        continue;
      }
      // World parser stores 1..4; Terraria LiquidID uses 0..3.
      const kind = liquidKind - 1;
      if (kind === 3) {
        reject(wx, wy, "shimmer");
        continue;
      }
      if (![0, 1, 2].includes(kind)) {
        reject(wx, wy, "unknown-liquid-kind");
        continue;
      }
      let reason = null,
        missing = false,
        nearShape = false;
      for (let nx = wx - 1; nx <= wx + 1; nx++)
        for (let ny = wy - 1; ny <= wy + 1; ny++) {
          const n = get(nx, ny);
          if (!n) {
            missing = true;
            continue;
          }
          if (n.active && !n.inactive) {
            if (
              !Number.isInteger(n.shape ?? 0) ||
              (n.shape ?? 0) < 0 ||
              (n.shape ?? 0) > 5
            )
              reason ??= "invalid-shape-neighborhood";
            if (n.shape) nearShape = true;
            if (SPECIAL.has(n.type)) reason ??= "special-tile-neighborhood";
            if (
              (typeof options.isSolid !== "function" ||
                typeof options.isSolid(n) !== "boolean") &&
              !PLATFORMS.has(n.type)
            )
              reason ??= "unknown-solid-neighborhood";
          }
          if (n.liquid && n.liquidKind !== liquidKind)
            reason ??= "mixed-liquid-neighborhood";
        }
      if (missing) support.missingContextCells++;
      if (reason) {
        reject(wx, wy, reason);
        continue;
      }
      const texture = kind === 0 ? waterStyle : kind === 1 ? 1 : 11;
      const frontOpacity = FRONT_ALPHA[kind] * (kind === 1 ? lavaOpacity : 1);
      const alpha =
        support.layer === "foreground"
          ? frontOpacity
          : kind === 1
            ? lavaOpacity
            : 1;
      const ownShape = tile.active && !tile.inactive && tile.shape;
      const surrounding = [];
      if (nearShape)
        for (let nx = wx - 1; nx <= wx + 1; nx++)
          for (let ny = wy - 1; ny <= wy + 1; ny++)
            if (nx !== wx || ny !== wy) surrounding.push(get(nx, ny));
      // When every surrounding site is fully wet with this liquid or a known
      // solid, the modern visible-level equations reduce to a full 16px cell:
      // all four walls are 0/1, edges are absent, smoothing/corners are identity.
      // This is a bounded, proven subset, not a dry-neighbor/falling guess.
      const stableFull =
        nearShape &&
        (tile.liquid === 255 ||
          (dryShape && tile.shape === 1 && get(wx, wy - 1)?.liquid === 255)) &&
        !missing &&
        surrounding.every(
          (n) => solid(n) || (n?.liquid === 255 && n.liquidKind === liquidKind),
        );
      if (ownShape) {
        if (!solid(tile)) {
          reject(wx, wy, "shape-non-solid");
          continue;
        }
        if (missing) {
          reject(wx, wy, "shape-missing-context");
          continue;
        }
        const neighbors = [
          get(wx, wy - 1),
          get(wx - 1, wy),
          get(wx + 1, wy),
          get(wx, wy + 1),
        ];
        // A wet halfbrick below full liquid uses the normal renderer's upper
        // half. With a wall its separate behind-tile pass is suppressed, so
        // this subset needs neither a second alpha layer nor a waterfall guess.
        if (
          tile.shape === 1 &&
          stableFull &&
          tile.wall > 0 &&
          neighbors[0].liquid === 255
        ) {
          const asset = `water_${texture}.png`;
          result.commands.push({
            kind: "liquid",
            asset,
            sourceAsset: `Images/Misc/${asset}`,
            sx: 16,
            sy: 56 + waterfallFrame * 80,
            sw: 16,
            sh: 8,
            dx: x * 16,
            dy: y * 16,
            dw: 16,
            dh: 8,
            opacity: alpha,
            frontOpacity,
            layer: support.layer,
            liquidType: kind,
            liquidLevel: tile.liquid,
            x,
            y,
            worldX: wx,
            worldY: wy,
            fidelity: "static-wet-halfbrick-top",
          });
          assets.add(asset);
          support.drawn++;
          support.shapeDrawn++;
          support.sourceGeometryDrawn++;
          continue;
        }
        const shape = behindShape(tile, neighbors, {
          texture,
          worldY: wy,
          worldSurface,
          lavaOpacity,
          solid,
        });
        if (shape.reason) {
          if (
            shape.reason === "halfbrick-overlap-neighborhood" &&
            tile.wall > 0
          ) {
            const visible = visibleAt(wx, wy);
            // Only this proven wall/halfbrick case suppresses the separate
            // behind pass. Normal-pass occlusion alone is insufficient.
            if (visible.supported && visible.behindTileSuppressed) {
              addVisible(visible, true);
              continue;
            }
            if (!visible.supported) {
              reject(wx, wy, visible.reason);
              continue;
            }
          }
          if (shape.reason === "halfbrick-overlap-neighborhood" || shape.reason === "halfbrick-waterfall-neighborhood") {
            sampleHalfbrick ??= createHalfbrickLiquidSampler(region, { ...options, worldSurface });
            const half = sampleHalfbrick(wx, wy);
            if (half.supported) {
              for (const command of half.commands) { result.commands.push(command); assets.add(command.asset); }
              if (half.commands.length) { support.drawn++; support.shapeDrawn++; support.sourceGeometryDrawn++; }
              else support.skippedOccluded++;
              if (half.normalDrawn) support.visibleLevelDrawn++;
              if (half.clampedRows) support.clampedShapeCells++;
              if (half.gradientRows) { support.gradientShapeCells++; support.gradientRows += half.gradientRows; }
              continue;
            }
            reject(wx, wy, half.reason);
            continue;
          }
          reject(wx, wy, shape.reason);
          continue;
        }
        if (shape.occluded) {
          support.skippedOccluded++;
          continue;
        }
        const common = {
          kind: "liquid",
          ...shape,
          sourceAsset: `Images/${shape.asset}`,
          dx: x * 16,
          dy: y * 16 + shape.offsetY,
          dw: shape.sw,
          dh: shape.sh,
          frontOpacity,
          liquidType: kind,
          liquidLevel: tile.liquid,
          x,
          y,
          worldX: wx,
          worldY: wy,
        };
        const bodyRows = Math.min(shape.sh, 16 - shape.sy);
        result.commands.push({ ...common, sh: bodyRows, dh: bodyRows });
        const clampRows = shape.sh - bodyRows;
        if (clampRows > 0) {
          // TileBatch fixes PointClamp. Sample the real last row and repeat it
          // only outside the texture boundary instead of performing an invalid
          // source read or substituting a triangle/solid color.
          result.commands.push({
            ...common,
            sy: 15,
            sh: 1,
            dy: common.dy + bodyRows,
            dh: clampRows,
            sourceSampling: "point-clamp-bottom",
          });
          support.clampedShapeCells++;
        }
        assets.add(shape.asset);
        support.drawn++;
        support.shapeDrawn++;
        support.sourceGeometryDrawn++;
        continue;
      }
      if (solid(tile)) {
        support.skippedSolid++;
        continue;
      }
      if (nearShape) {
        if (!stableFull) {
          if (missing) {
            reject(wx, wy, "shape-missing-context");
            continue;
          }
          const visible = visibleAt(wx, wy);
          if (visible.supported) addVisible(visible, false);
          else reject(wx, wy, visible.reason);
          continue;
        }
        const asset = `water_${texture}.png`;
        result.commands.push({
          kind: "liquid",
          asset,
          sourceAsset: `Images/Misc/${asset}`,
          sx: 16,
          sy: 48 + waterfallFrame * 80,
          sw: 16,
          sh: 16,
          dx: x * 16,
          dy: y * 16,
          dw: 16,
          dh: 16,
          opacity: alpha,
          frontOpacity,
          layer: support.layer,
          liquidType: kind,
          liquidLevel: tile.liquid,
          x,
          y,
          worldX: wx,
          worldY: wy,
          fidelity: "static-full-liquid-near-shape",
        });
        assets.add(asset);
        support.drawn++;
        support.sourceGeometryDrawn++;
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
      const asset = `water_${texture}.png`;
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
  support.commandCount = result.commands.length;
  result.warnings.push(
    "Liquid preview combines frozen fullbright flat fills with source-derived shape and visible-level subsets. Eligible shape-neighbor cells use smoothing and finite falling dependencies; general dry-cell trails, distortion and particles are not rendered.",
  );
  if (support.shapeDrawn)
    result.warnings.push(
      "Commands marked drawBeforeTiles must be drawn behind the foreground Tile layer; slope masks come from LiquidSlope PNGs, not invented triangle fills.",
    );
  if (!support.worldSurfaceKnown)
    result.warnings.push(
      "worldSurface is unknown: special surface atlas selection is unavailable.",
    );
  if (support.missingContextCells)
    result.warnings.push(
      `${support.missingContextCells} liquid candidates lack full neighbor context; shape geometry is rejected while the flat-fill approximation treats missing neighbors as empty.`,
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
