import { classifyTileDrawLayer } from "./static-waterfalls.mjs";
/** Original texture-only preview planner. See docs/rendering-scope.md for fidelity limits. */
import { cellAt } from "./world.mjs";
import { planSceneLiquids } from "./liquid-composite.mjs";
import { isSolidOrSlopedTile } from "./tile-solidity.mjs";
import { planStaticNature, STATIC_NATURE_TYPES } from "./static-nature.mjs";
export { STATIC_NATURE_TYPES } from "./static-nature.mjs";
import { planStaticObject, STATIC_OBJECT_TILES } from "./static-objects.mjs";
export { STATIC_OBJECT_TILES } from "./static-objects.mjs";
import {
  planStaticBlock,
  STATIC_BLOCK_TILES,
  STATIC_SOLID_BLOCKS,
} from "./static-blocks.mjs";
export { STATIC_BLOCK_TILES, STATIC_SOLID_BLOCKS } from "./static-blocks.mjs";
import { planStaticTree, STATIC_TREE_TYPES } from "./static-trees.mjs";
export { STATIC_TREE_TYPES } from "./static-trees.mjs";
import {
  planStaticMisc,
  STATIC_MISC_TILES,
  SOURCE_HIDDEN_TILES,
} from "./static-misc.mjs";
export { STATIC_MISC_TILES, SOURCE_HIDDEN_TILES } from "./static-misc.mjs";
import {
  planStaticFurnitureNext,
  STATIC_FURNITURE_NEXT_TILES,
} from "./static-furniture-next.mjs";
export { STATIC_FURNITURE_NEXT_TILES } from "./static-furniture-next.mjs";
import { planStaticFlames } from "./static-flames.mjs";
import {
  planStaticPlantsNext,
  STATIC_PLANTS_NEXT_TILES,
} from "./static-plants-next.mjs";
import {
  planStaticSpecialObject,
  STATIC_SPECIAL_OBJECT_TILES,
  STATIC_SPECIAL_OBJECT_HALO,
} from "./static-special-objects.mjs";
// Match each planner's first type guard once per tile. Keep independent bits:
// families may overlap, and their existing precedence and failure paths matter.
const PLAN_SPECIAL = 1,
  PLAN_PLANTS = 2,
  PLAN_FURNITURE = 4,
  PLAN_MISC = 8,
  PLAN_TREE = 16,
  PLAN_NATURE = 32,
  PLAN_OBJECT = 64,
  PLAN_BLOCK = 128;
const plannerFamilies = [
  [PLAN_SPECIAL, STATIC_SPECIAL_OBJECT_TILES],
  [PLAN_PLANTS, STATIC_PLANTS_NEXT_TILES],
  [PLAN_FURNITURE, STATIC_FURNITURE_NEXT_TILES],
  [PLAN_MISC, STATIC_MISC_TILES],
  [PLAN_TREE, STATIC_TREE_TYPES],
  [PLAN_NATURE, STATIC_NATURE_TYPES],
  [PLAN_OBJECT, STATIC_OBJECT_TILES],
  [PLAN_BLOCK, STATIC_BLOCK_TILES],
];
const staticPlannerMasks = new Uint8Array(
  1 + Math.max(...plannerFamilies.flatMap(([, types]) => types)),
);
for (const [bit, types] of plannerFamilies)
  for (const type of types) staticPlannerMasks[type] |= bit;
const BLOCK_FRAME = [
  [162, 54],
  [108, 54],
  [216, 0],
  [18, 72],
  [162, 0],
  [0, 72],
  [108, 72],
  [18, 36],
  [108, 0],
  [90, 0],
  [18, 54],
  [72, 0],
  [0, 54],
  [0, 0],
  [18, 0],
  [18, 18],
];
const WALL_GRID = [
  [9, 3],
  [6, 3],
  [12, 0],
  [1, 4],
  [9, 0],
  [0, 4],
  [6, 4],
  [1, 2],
  [6, 0],
  [5, 0],
  [1, 3],
  [4, 0],
  [0, 3],
  [0, 0],
  [1, 0],
  [1, 1],
  [6, 1],
  [6, 2],
  [10, 0],
  [11, 0],
];
const WALL_CENTER = [
  [2, 0, 0],
  [0, 1, 4],
  [0, 3, 0],
];
const NEIGHBORS = [
  [0, -1, 1],
  [-1, 0, 2],
  [1, 0, 4],
  [0, 1, 8],
];
export const ORDINARY_BLOCKS = Object.freeze([
  0, 1, 2, 6, 7, 8, 9, 22, 23, 25, 30, 37, 38, 39, 40, 41, 43, 44, 45, 46, 47,
  48, 53, 56, 57, 58, 59, 60, 63, 64, 65, 66, 67, 68, 70, 75, 76, 107, 108, 109,
  111, 112, 116, 117, 118, 119, 120, 121, 122, 140, 147, 161, 163, 164, 166,
  167, 168, 169, 175, 176, 177, 179, 180, 181, 182, 183, 189, 190, 191, 192,
  193, 194, 195, 196, 197, 198, 199, 200, 202, 203, 204, 206, 208, 211, 221,
  222, 223, 224, 225, 226, 229, 230, 232, 234, 239, 248, 250, 251, 252, 253,
  // Source-verified full solids with ordinary 18px frames; merges stay approximate.
  123,
  151, 367, 368, 383, 396, 397, 402, 403, 404,
]);
const ordinary = new Set(ORDINARY_BLOCKS);
// Common terrain accounts for most whole-world commands. Reuse its immutable
// names; command geometry remains private to each scene.
const ordinaryAssets = [];
for (const type of ORDINARY_BLOCKS) ordinaryAssets[type] = `Tiles_${type}.png`;
const wallAssets = Array.from(
  { length: 1024 },
  (_, type) => `Wall_${type}.png`,
);
export const STORED_FRAME_TILES = Object.freeze([
  4, 10, 11, 14, 15, 18, 19, 21, 27, 172,
]);
const stored = new Set(STORED_FRAME_TILES);
const modulo3 = (n) => ((n % 3) + 3) % 3;
function maskAt(region, x, y, predicate) {
  let mask = 0;
  for (const [dx, dy, bit] of NEIGHBORS)
    if (predicate(cellAt(region, x + dx, y + dy))) mask |= bit;
  return mask;
}
function storedHeight(type, y) {
  if ((type === 14 || type === 21) && y === 18) return 18;
  if (type === 15 && y % 40 === 18) return 18;
  if (type === 27 && y % 74 === 54) return 18;
  if (type === 172 && y % 38 === 18) return 18;
  return 16;
}
const SLOPE_COORDINATES = Object.freeze({
  2: Object.freeze([0, 0, 16, 16, 0, 16]),
  3: Object.freeze([0, 16, 16, 0, 16, 16]),
  4: Object.freeze([0, 0, 16, 0, 0, 16]),
  5: Object.freeze([0, 0, 16, 0, 16, 16]),
});
function slopePolygon(shape) {
  const points = SLOPE_COORDINATES[shape];
  if (!Array.isArray(points)) return points;
  // Plans expose mutable clips. Allocate only the chosen triangle, keeping
  // every returned polygon and point private to that command as before.
  return [
    [points[0], points[1]],
    [points[2], points[3]],
    [points[4], points[5]],
  ];
}
export const MAX_SCENE_COMMANDS = 131072;
export function planScene(region, options = {}) {
  const maxCommands = options.maxCommands ?? MAX_SCENE_COMMANDS;
  if (
    !Number.isSafeInteger(maxCommands) ||
    maxCommands < 1 ||
    maxCommands > MAX_SCENE_COMMANDS
  )
    throw new Error("Invalid scene command budget");
  let commandCount = 0;
  const { revealInvisible = false, tiles = true, walls = true } = options;
  const paintEnabled = options.paintEnabled === true;
  const w = region?.rect?.width,
    h = region?.rect?.height;
  if (
    !Number.isSafeInteger(w) ||
    !Number.isSafeInteger(h) ||
    w < 1 ||
    h < 1 ||
    w > 512 ||
    h > 512 ||
    w * h > 65536 ||
    region.cells?.length !== w * h
  )
    throw new Error("Invalid or oversized scene region");
  const cells = region.cells,
    commands = [],
    assets = new Set(),
    unsupported = new Map(),
    unsupportedCells = [],
    foliageCommands = [],
    trunkCommands = [],
    specialBehind = [],
    specialAbove = [],
    contextOmissions = [],
    sourceHiddenCells = [];
  const support = {
    tiles: 0,
    walls: 0,
    storedFrames: 0,
    approximateTiles: 0,
    approximateWalls: 0,
    unsupportedTiles: 0,
    hiddenTiles: 0,
    hiddenWalls: 0,
    paint: 0,
    liquid: 0,
    wires: 0,
    inactive: 0,
    coatings: 0,
    shapes: 0,
    staticTorches: 0,
    approximateRopes: 0,
    staticNature: 0,
    staticObjects: 0,
    staticBlocks: 0,
    staticTrees: 0,
    staticMisc: 0,
    staticFurniture: 0,
    staticFlames: 0,
    staticPlants: 0,
    staticSpecialObjects: 0,
    contextCommands: 0,
    sourceHiddenTiles: 0,
  };
  const visible = (t) => t?.active && (revealInvisible || !t.invisibleBlock);
  const reserve = () => {
    if (++commandCount > maxCommands)
      throw new Error(
        "Scene command budget exceeded; choose a smaller preview region",
      );
  };
  const emit = (c) => {
    commands.push(c);
    assets.add(c.asset);
  };
  const add = (c) => {
    reserve();
    emit(c);
  };
  const queueCommand = (list, c) => {
    reserve();
    list.push(c);
  };
  const reject = (t, x, y, reason) => {
    unsupportedCells.push({
      x: x + (region.rect.x || 0),
      y: y + (region.rect.y || 0),
      type: t.type,
      ...(reason ? { reason } : {}),
    });
    support.unsupportedTiles++;
    unsupported.set(t.type, (unsupported.get(t.type) || 0) + 1);
  };
  const appendSprite = (c, t, x, y, contextOnly = false) => {
    const command = {
      kind: "tile",
      x,
      y,
      type: c.type ?? t.type,
      ...c,
      ownerType: t.type,
      dx: x * 16 + (c.offsetX || 0),
      dy: y * 16 + (c.offsetY || 0),
      dw: c.sw,
      dh: c.sh,
      paintId: paintEnabled ? (c.paintId ?? t.paint ?? 0) : 0,
      ...(contextOnly ? { contextOnly: true } : {}),
    };
    if (
      contextOnly &&
      (command.dx >= w * 16 ||
        command.dy >= h * 16 ||
        command.dx + command.dw <= 0 ||
        command.dy + command.dh <= 0)
    )
      return;
    if (c.specialLayer === "behind-object")
      queueCommand(specialBehind, command);
    else if (c.specialLayer === "over-tiles")
      queueCommand(specialAbove, command);
    else add(command);
    if (contextOnly) support.contextCommands++;
  };
  // Whole wall pass first, so a wall crop cannot cover a foreground sprite.
  if (walls)
    for (let x = 0; x < w; x++)
      for (let y = 0; y < h; y++) {
        const i = x * h + y,
          t = cells[i];
        if (!t?.wall) continue;
        if (!revealInvisible && (t.invisibleWall || t.wall === 318)) {
          support.hiddenWalls++;
          continue;
        }
        // Match cellAt's region-edge contract without allocating a predicate
        // and four iterator tuples for every wall.
        const north = y > 0 ? cells[i - 1] : null,
          west = x > 0 ? cells[i - h] : null,
          east = x + 1 < w ? cells[i + h] : null,
          south = y + 1 < h ? cells[i + 1] : null;
        let mask =
          (north?.wall > 0 &&
          (revealInvisible || (!north.invisibleWall && north.wall !== 318))
            ? 1
            : 0) |
          (west?.wall > 0 &&
          (revealInvisible || (!west.invisibleWall && west.wall !== 318))
            ? 2
            : 0) |
          (east?.wall > 0 &&
          (revealInvisible || (!east.invisibleWall && east.wall !== 318))
            ? 4
            : 0) |
          (south?.wall > 0 &&
          (revealInvisible || (!south.invisibleWall && south.wall !== 318))
            ? 8
            : 0);
        if (mask === 15)
          mask +=
            WALL_CENTER[modulo3(x + (region.rect.x || 0))][
              modulo3(y + (region.rect.y || 0))
            ];
        const [gx, gy] = WALL_GRID[mask];
        add({
          kind: "wall",
          asset:
            typeof t.wall === "number" && wallAssets[t.wall] !== undefined
              ? wallAssets[t.wall]
              : "Wall_" + t.wall + ".png",
          sx: gx * 36,
          sy: gy * 36,
          sw: 32,
          sh: 32,
          dx: x * 16 - 8,
          dy: y * 16 - 8,
          dw: 32,
          dh: 32,
          x,
          y,
          type: t.wall,
          paintId: paintEnabled ? t.wallPaint || 0 : 0,
          fidelity: "approximate",
        });
        support.walls++;
        support.approximateWalls++;
      }
  const liquidPlan = planSceneLiquids(region, {
    ...options.liquids,
    isSolid: isSolidOrSlopedTile,
  });
  if (liquidPlan.support.layer === "background")
    for (const command of liquidPlan.commands.filter((c) => !c.drawBeforeTiles))
      add(command);
  for (const command of liquidPlan.commands.filter((c) => c.drawBeforeTiles))
    add(command);
  const tilePassStart = commands.length;
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      const i = x * h + y,
        t = cells[i];
      if (!t) continue;
      if (t.paint || t.wallPaint) support.paint++;
      if (t.liquid) support.liquid++;
      if (t.wireRed || t.wireBlue || t.wireGreen || t.wireYellow || t.actuator)
        support.wires++;
      if (t.inactive) support.inactive++;
      if (t.fullbrightBlock || t.fullbrightWall) support.coatings++;
      if (!tiles || !t.active) continue;
      if (!visible(t)) {
        support.hiddenTiles++;
        continue;
      }
      const shape = t.shape || 0;
      if (shape > 5 || shape < 0) {
        reject(t, x, y);
        continue;
      }
      // The numeric check preserves Set.has semantics for malformed/string IDs.
      const planners =
        typeof t.type === "number" ? staticPlannerMasks[t.type] || 0 : 0;
      // The ordinary branch has no family-specific dependencies. Resolve it
      // before setting up the rare object/tree/animation paths, while retaining
      // their precedence if a future family starts handling an ordinary type.
      const ordinaryAsset =
        typeof t.type === "number" ? ordinaryAssets[t.type] : undefined;
      if (
        !planners &&
        ordinaryAsset !== undefined &&
        !(
          Number.isInteger(t.frameX) &&
          Number.isInteger(t.frameY) &&
          t.frameX >= 0 &&
          t.frameY >= 0
        )
      ) {
        const north = y > 0 ? cells[i - 1] : null,
          west = x > 0 ? cells[i - h] : null,
          east = x + 1 < w ? cells[i + h] : null,
          south = y + 1 < h ? cells[i + 1] : null,
          type = t.type;
        const mask =
          (north?.active &&
          north.type === type &&
          (revealInvisible || !north.invisibleBlock)
            ? 1
            : 0) |
          (west?.active &&
          west.type === type &&
          (revealInvisible || !west.invisibleBlock)
            ? 2
            : 0) |
          (east?.active &&
          east.type === type &&
          (revealInvisible || !east.invisibleBlock)
            ? 4
            : 0) |
          (south?.active &&
          south.type === type &&
          (revealInvisible || !south.invisibleBlock)
            ? 8
            : 0);
        const frame = BLOCK_FRAME[mask];
        const command = {
          kind: "tile",
          asset: ordinaryAsset,
          sx: frame[0],
          sy: frame[1],
          sw: 16,
          sh: 16,
          dx: x * 16,
          dy: y * 16,
          dw: 16,
          dh: 16,
          x,
          y,
          type,
          ownerType: type,
          paintId: paintEnabled ? t.paint || 0 : 0,
          fidelity: "approximate",
        };
        if (shape === 1) {
          command.sh = 8;
          command.dh = 8;
          command.dy += 8;
          support.shapes++;
        } else if (shape >= 2) {
          command.clip = slopePolygon(shape);
          support.shapes++;
        }
        add(command);
        support.tiles++;
        support.approximateTiles++;
        continue;
      }
      const special =
        planners & PLAN_SPECIAL
          ? planStaticSpecialObject(region, x, y, t, {
              revealInvisible,
              mouseTextColor: options.mouseTextColor,
            })
          : null;
      const plant =
        !special && planners & PLAN_PLANTS
          ? planStaticPlantsNext(region, x, y, t, {
              revealInvisible,
              mouseTextColor: options.mouseTextColor,
            })
          : null;
      let furniture =
        !special && !plant && planners & PLAN_FURNITURE
          ? planStaticFurnitureNext(region, x, y, t, {
              revealInvisible,
              paintEnabled,
            })
          : null;
      if (furniture?.pendingFlames) {
        const flame = planStaticFlames(region, x, y, t, {
          revealInvisible,
          state: options.flameState,
        });
        furniture =
          flame && !flame.unsupported
            ? {
                commands: [...furniture.commands, ...flame.commands],
                completedFlames: true,
              }
            : {
                unsupported:
                  flame?.unsupported || "Missing verified furniture flame plan",
              };
      }
      const misc =
        special ||
        plant ||
        furniture ||
        (planners & PLAN_MISC
          ? planStaticMisc(region, x, y, t, {
              revealInvisible,
              paintEnabled,
            })
          : null);
      if (misc) {
        if (misc.unsupported) {
          reject(t, x, y, misc.unsupported);
          continue;
        }
        if (misc.hidden) {
          support.sourceHiddenTiles++;
          sourceHiddenCells.push({
            x: x + region.rect.x,
            y: y + region.rect.y,
            type: t.type,
            reason: misc.reason,
          });
          continue;
        }
        for (const c of misc.commands) appendSprite(c, t, x, y);
        support.tiles++;
        if (special) support.staticSpecialObjects++;
        else if (plant) support.staticPlants++;
        else if (furniture) {
          support.staticFurniture++;
          if (furniture.completedFlames) support.staticFlames++;
        } else support.staticMisc++;
        continue;
      }
      if (planners & PLAN_TREE) {
        const tree = planStaticTree(region, x, y, t, {
          revealInvisible,
          paintEnabled,
          treeContext: options.treeContext || region.treeContext,
          getWorldTile: options.getWorldTile || region.getWorldTile,
        });
        if (!tree.supported) {
          reject(t, x, y, tree.reason);
          continue;
        }
        for (const c of tree.commands) {
          if (c.treePart === "trunk" || c.treePart === "palm-trunk")
            queueCommand(trunkCommands, { ...c, ownerType: t.type });
          else queueCommand(foliageCommands, { ...c, ownerType: t.type });
        }
        support.tiles++;
        support.staticTrees++;
        continue;
      }
      let sx,
        sy,
        sh = 16,
        sw = 16,
        offsetX = 0,
        offsetY = 0,
        fidelity,
        flipX = false,
        opacity = 1,
        spriteAsset = `Tiles_${t.type}.png`,
        extraLayers = [];
      const hasFrame =
        Number.isInteger(t.frameX) &&
        Number.isInteger(t.frameY) &&
        t.frameX >= 0 &&
        t.frameY >= 0;
      const nature =
        planners & PLAN_NATURE
          ? planStaticNature(region, x, y, t, { revealInvisible })
          : null;
      const object =
        planners & PLAN_OBJECT
          ? planStaticObject(region, x, y, t, { revealInvisible })
          : null;
      const block =
        planners & PLAN_BLOCK
          ? planStaticBlock(region, x, y, t, { revealInvisible })
          : null;
      if (nature) {
        if (!nature.supported) {
          reject(t, x, y, nature.reason);
          continue;
        }
        ({ sx, sy, sw, sh, offsetX, offsetY, flipX, opacity, fidelity } =
          nature);
        support.staticNature++;
      } else if (object) {
        if (object.unsupported || shape) {
          reject(t, x, y, object.unsupported || "shaped-static-object");
          continue;
        }
        ({ sx, sy, sw, sh, offsetX, offsetY, flipX, opacity, fidelity } =
          object);
        support.staticObjects++;
      } else if (block) {
        if (block.unsupported) {
          reject(t, x, y, block.unsupported);
          continue;
        }
        const layers = Array.isArray(block) ? block : [block];
        const base = layers[0];
        extraLayers = layers.slice(1);
        ({ sx, sy, sw, sh, offsetX, offsetY, flipX, opacity, fidelity } = base);
        spriteAsset = base.asset;
        support.staticBlocks++;
      } else if (hasFrame && stored.has(t.type)) {
        sx = t.frameX;
        sy = t.frameY;
        if (t.type === 18) {
          const wrap = Math.floor(sx / 2016);
          sx -= 2016 * wrap;
          sy += 20 * wrap;
        }
        sh = storedHeight(t.type, sy);
        if (t.type === 4) {
          sw = sh = 20;
          offsetX = -2;
          const above = cellAt(region, x, y - 1);
          if (
            visible(above) &&
            ordinary.has(above.type) &&
            !above.inactive &&
            !above.shape
          )
            offsetY = 4;
          support.staticTorches++;
        }
        fidelity = "stored-frame";
        support.storedFrames++;
      } else if (!hasFrame && t.type === 353) {
        const ropeTypes = new Set([213, 353, 365, 366, 504]);
        const connects = (n) =>
          visible(n) &&
          !n.inactive &&
          (ropeTypes.has(n.type) || (ordinary.has(n.type) && !n.shape));
        const up = connects(cellAt(region, x, y - 1));
        const down = connects(cellAt(region, x, y + 1));
        const side = (n) =>
          visible(n) &&
          (n.type === 353 || (!up && ordinary.has(n.type) && !n.inactive));
        const mask =
          (up ? 1 : 0) |
          (side(cellAt(region, x - 1, y)) ? 2 : 0) |
          (side(cellAt(region, x + 1, y)) ? 4 : 0) |
          (down ? 8 : 0);
        [sx, sy] = BLOCK_FRAME[mask];
        fidelity = "approximate-rope";
        support.approximateRopes++;
      } else if (!hasFrame && ordinary.has(t.type)) {
        const mask = maskAt(
          region,
          x,
          y,
          (n) => visible(n) && n.type === t.type,
        );
        [sx, sy] = BLOCK_FRAME[mask];
        fidelity = "approximate";
        support.approximateTiles++;
      } else {
        reject(t, x, y);
        continue;
      }
      const command = {
        kind: "tile",
        asset: spriteAsset,
        sx,
        sy,
        sw,
        sh,
        dx: x * 16 + offsetX,
        dy: y * 16 + offsetY,
        dw: sw,
        dh: sh,
        x,
        y,
        type: t.type,
        ownerType: t.type,
        paintId: paintEnabled ? t.paint || 0 : 0,
        fidelity,
        ...(flipX ? { flipX: true } : {}),
        ...(opacity !== 1 ? { opacity } : {}),
      };
      if (shape === 1) {
        command.sh = 8;
        command.dh = 8;
        command.dy += 8;
        support.shapes++;
      } else if (shape >= 2) {
        command.clip = slopePolygon(shape);
        support.shapes++;
      }
      add(command);
      for (const layer of extraLayers) {
        const overlay = {
          ...command,
          asset: layer.asset,
          paintId: layer.paintId ?? command.paintId,
          vertexColor: layer.vertexColor,
          staticOverlay: true,
          fidelity: layer.fidelity,
        };
        add(overlay);
      }
      support.tiles++;
    }
  // Selection-only contexts carry source neighbors without adding saved Tile data.
  // Whole-world/viewport paths already plan an expanded rectangle before cropping.
  if (tiles && region.context) {
    const ctx = region.context,
      halo = STATIC_SPECIAL_OBJECT_HALO;
    for (let x = -halo; x < w + halo; x++)
      for (let y = -halo; y < h + halo; y++) {
        if (x >= 0 && y >= 0 && x < w && y < h) continue;
        const wx = region.rect.x + x,
          wy = region.rect.y + y;
        const t = cellAt(ctx, wx - ctx.rect.x, wy - ctx.rect.y);
        if (!visible(t) || !STATIC_SPECIAL_OBJECT_TILES.includes(t.type))
          continue;
        const extra = planStaticSpecialObject(region, x, y, t, {
          revealInvisible,
          mouseTextColor: options.mouseTextColor,
        });
        if (extra?.unsupported) {
          contextOmissions.push({
            x: wx,
            y: wy,
            type: t.type,
            reason: extra.unsupported,
          });
          continue;
        }
        for (const c of extra?.commands || []) appendSprite(c, t, x, y, true);
      }
  }
  const ordinaryTileCommands = commands.splice(tilePassStart);
  // Preserve full-scene owner traversal when context bodies enter a cropped ROI.
  // Without appended context owners all three groups already follow the
  // column-major tile traversal. A stable sort is needed only for the ROI path.
  if (tiles && region.context) {
    const byOwner = (a, b) => a.x - b.x || a.y - b.y;
    ordinaryTileCommands.sort(byOwner);
    specialBehind.sort(byOwner);
    specialAbove.sort(byOwner);
  }
  const tileGroups = [
    specialBehind,
    trunkCommands,
    ordinaryTileCommands,
    foliageCommands,
    specialAbove,
  ];
  const registry =
    options.liquids?.enabled && options.liquids?.waterfallRegistry;
  if (registry) {
    if (
      typeof registry.commandsFor !== "function" ||
      typeof registry.hasOrigin !== "function"
    )
      throw new Error("Invalid waterfall registry");
    // Classify each owner once. Compact the private groups in place to retain
    // their solid pass without a second command array or repeated Set lookups.
    for (const group of tileGroups) {
      let retained = 0;
      for (const c of group) {
        const layer = classifyTileDrawLayer(c.ownerType ?? c.type);
        if (layer === "non-solid") emit(c);
        else {
          group[retained++] = c;
          if (layer === undefined)
            contextOmissions.push({
              x: region.rect.x + c.x,
              y: region.rect.y + c.y,
              type: c.ownerType ?? c.type,
              reason: "unknown-waterfall-tile-draw-layer",
            });
        }
      }
      group.length = retained;
    }
    const waterfalls = registry.commandsFor(region.rect);
    for (const c of waterfalls) add(c);
    for (const group of tileGroups) for (const c of group) emit(c);
    support.waterfalls = {
      commands: waterfalls.length,
      model: registry.model,
      scanComplete: registry.scanComplete,
      stats: registry.stats,
      failures: registry.failures || [],
    };
  } else {
    for (const group of tileGroups) for (const c of group) emit(c);
  }
  if (liquidPlan.support.layer === "foreground")
    for (const command of liquidPlan.commands.filter((c) => !c.drawBeforeTiles))
      add(command);
  const warnings = [
    "Static unlit texture preview; not a pixel-exact Terraria screenshot. Region-edge framing has no outside-neighbor context.",
  ];
  if (contextOmissions.length)
    warnings.push(
      `${contextOmissions.length} neighboring object owners have unresolved overhang dependencies; preview is incomplete.`,
    );
  if (support.sourceHiddenTiles)
    warnings.push(
      `${support.sourceHiddenTiles} particle-emitter cells intentionally have no static Tile body in the source; no replacement sprite is drawn.`,
    );
  if (support.staticMisc)
    warnings.push(
      `${support.staticMisc} misc cells use source-specific saved/indexed frames, static phases and required alpha/glow layers.`,
    );
  if (support.staticTrees)
    warnings.push(
      `${support.staticTrees} tree cells use real root/world-style metadata and separate trunk/branch/crown textures at zero wind; dynamic leaves and lighting are omitted.`,
    );
  if (support.staticBlocks)
    warnings.push(
      `${support.staticBlocks} static terrain cells use source-based base/glow layers and fixed adjacency variation; cross-material merges remain approximate.`,
    );
  if (support.staticObjects)
    warnings.push(
      `${support.staticObjects} object cells use source-based saved-frame geometry at animation zero / zero wind; emitted glow and motion are not reconstructed.`,
    );
  if (support.staticNature)
    warnings.push(
      `${support.staticNature} nature cells use source-based fixed variant / zero-wind static framing; random variants and dynamic vine-strip effects are not reconstructed.`,
    );
  if (support.staticTorches)
    warnings.push(
      support.staticTorches +
        " torches use the stored base sprite at animation time 0; flame overlays, particles and emitted light are omitted. Ceiling offset uses supported solid neighbors only.",
    );
  if (support.approximateRopes)
    warnings.push(
      support.approximateRopes +
        " vine-rope cells use static variant 0 and supported-neighbor attachment framing; full solid/rope-anchor classification and off-region context are not reproduced.",
    );
  if (support.approximateTiles)
    warnings.push(
      support.approximateTiles +
        " block cells use approximate same-type adjacency; cross-material merges, grass transitions, random variants and diagonal framing are not reproduced.",
    );
  if (support.approximateWalls)
    warnings.push(
      support.approximateWalls +
        " walls use approximate static framing; large-frame patterns, wall truncation by special tiles and animated frames are not reproduced.",
    );
  if (support.unsupportedTiles)
    warnings.push(
      support.unsupportedTiles +
        " unsupported tile cells skipped (type:count " +
        [...unsupported]
          .sort((a, b) => a[0] - b[0])
          .map(([k, v]) => k + ":" + v)
          .join(", ") +
        ").",
    );
  if (support.paint && !paintEnabled)
    warnings.push(
      support.paint +
        " painted cells shown with their unpainted source textures.",
    );
  if (support.liquid && !options.liquids?.enabled)
    warnings.push(
      support.liquid + " liquid cells preserved in data but not rendered.",
    );
  if (support.wires)
    warnings.push(
      support.wires +
        " wiring/actuator cells preserved in data; overlays not rendered.",
    );
  if (support.inactive)
    warnings.push(
      support.inactive +
        " actuated cells shown without the game darkening effect.",
    );
  if (support.coatings)
    warnings.push(
      support.coatings +
        " fullbright coating cells preserved; lighting is disabled for this preview.",
    );
  if (support.shapes)
    warnings.push(
      support.shapes +
        " half/slope cells use simplified geometry; special slope frames and neighbor edge corrections are omitted.",
    );
  if (paintEnabled && support.paint)
    warnings.push(
      "Paint uses source-derived pixel formulas with explicit input-channel association; unsupported masks/alpha paths are reported separately.",
    );
  if (support.waterfalls) {
    warnings.push(
      "Waterfalls use a fresh static viewport registry, frozen frame/style and bounded source traversal; this does not reproduce an aged runtime registry.",
    );
    if (!support.waterfalls.scanComplete || support.waterfalls.failures.length)
      warnings.push(
        "Waterfall registry has unresolved dependencies; preview is incomplete.",
      );
  }
  warnings.push(...liquidPlan.warnings);
  support.liquidDrawing = liquidPlan.support;
  return {
    commands,
    warnings,
    support,
    unsupportedCells,
    sourceHiddenCells,
    contextOmissions,
    paintEnabled,
    requiredAssets: [...assets].sort(),
    width: w * 16,
    height: h * 16,
  };
}
/** Preflight all textures before strict drawing. Never substitutes colors or invented sprites. */
export function renderScene(
  context,
  plan,
  assets,
  { strict = false, sceneFrames = null } = {},
) {
  const get = (name) =>
    assets instanceof Map ? assets.get(name) : assets?.[name];
  const missing = new Set(),
    invalid = new Set();
  for (const c of plan.commands) {
    const image = get(c.asset);
    if (!image) {
      missing.add(c.asset);
      continue;
    }
    const width = image.naturalWidth ?? image.width,
      height = image.naturalHeight ?? image.height;
    if (
      !(width > 0 && height > 0) ||
      c.sx < 0 ||
      c.sy < 0 ||
      c.sx + c.sw > width ||
      c.sy + c.sh > height
    )
      invalid.add(c.asset);
  }
  const missingAssets = [...missing].sort(),
    invalidAssets = [...invalid].sort();
  const warnings = [...plan.warnings, ...(sceneFrames?.warnings || [])];
  if (missing.size)
    warnings.push("Missing textures: " + missingAssets.join(", "));
  if (invalid.size)
    warnings.push(
      "Invalid dimensions or out-of-bounds sprite crops: " +
        invalidAssets.join(", "),
    );
  if (strict && (missing.size || invalid.size))
    throw new Error(warnings.slice(plan.warnings.length).join("; "));
  let drawn = 0,
    skippedEffects = 0;
  context.save();
  try {
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    if (sceneFrames?.support.additiveFrames) {
      context.globalCompositeOperation = "lighter";
      if (context.globalCompositeOperation !== "lighter")
        throw new Error(
          "Canvas additive blend is unavailable; cannot preserve painted alpha",
        );
      context.globalCompositeOperation = "source-over";
    }
    context.imageSmoothingEnabled = false;
    context.beginPath();
    context.rect(0, 0, plan.width, plan.height);
    context.clip();
    if (sceneFrames?.opaqueScene) {
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.fillStyle = "#000000";
      context.fillRect(0, 0, plan.width, plan.height);
    }
    for (const c of plan.commands) {
      if (missing.has(c.asset) || invalid.has(c.asset)) continue;
      const frame = sceneFrames?.resolve(c);
      if (frame?.unsupported || (c.vertexColors && !frame?.base)) {
        skippedEffects++;
        if (
          c.vertexColors &&
          !frame &&
          !warnings.includes(
            "Corner vertex colors require a prepared scene frame; no untinted fallback was drawn.",
          )
        )
          warnings.push(
            "Corner vertex colors require a prepared scene frame; no untinted fallback was drawn.",
          );
        continue;
      }
      context.save();
      try {
        if (c.opacity !== undefined)
          context.globalAlpha =
            (Number.isFinite(context.globalAlpha) ? context.globalAlpha : 1) *
            c.opacity;
        if (c.clip) {
          context.beginPath();
          c.clip.forEach(([x, y], i) =>
            context[i ? "lineTo" : "moveTo"](c.dx + x, c.dy + y),
          );
          context.closePath();
          context.clip();
        }
        const flipX = !!c.flipX && !frame?.uvFlipApplied,
          flipY = !!c.flipY && !frame?.uvFlipApplied;
        const transformed = flipX || flipY;
        const drawX = transformed ? 0 : c.dx,
          drawY = transformed ? 0 : c.dy;
        if (transformed) {
          context.translate(
            c.dx + (flipX ? c.dw : 0),
            c.dy + (flipY ? c.dh : 0),
          );
          context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
        }
        const frameWidth = frame?.base ? (frame.width ?? c.sw) : c.sw,
          frameHeight = frame?.base ? (frame.height ?? c.sh) : c.sh;
        context.drawImage(
          frame?.base || get(c.asset),
          frame?.base ? 0 : c.sx,
          frame?.base ? 0 : c.sy,
          frameWidth,
          frameHeight,
          drawX,
          drawY,
          c.dw,
          c.dh,
        );
        if (frame?.additive) {
          context.globalCompositeOperation = "lighter";
          if (context.globalCompositeOperation !== "lighter")
            throw new Error(
              "Canvas additive blend is unavailable; cannot preserve painted alpha",
            );
          context.drawImage(
            frame.additive,
            0,
            0,
            frameWidth,
            frameHeight,
            drawX,
            drawY,
            c.dw,
            c.dh,
          );
        }
        drawn++;
      } finally {
        context.restore();
      }
    }
  } finally {
    context.restore();
  }
  return {
    drawn,
    skippedEffects,
    paintSupport: sceneFrames?.support || null,
    missingAssets,
    invalidAssets,
    warnings,
  };
}
