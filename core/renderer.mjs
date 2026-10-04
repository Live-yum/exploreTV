/** Original texture-only preview planner. See docs/rendering-scope.md for fidelity limits. */
import { cellAt } from "./world.mjs";
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
]);
const ordinary = new Set(ORDINARY_BLOCKS);
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
function slopePolygon(shape) {
  return {
    2: [
      [0, 0],
      [16, 16],
      [0, 16],
    ],
    3: [
      [0, 16],
      [16, 0],
      [16, 16],
    ],
    4: [
      [0, 0],
      [16, 0],
      [0, 16],
    ],
    5: [
      [0, 0],
      [16, 0],
      [16, 16],
    ],
  }[shape];
}
export function planScene(region, options = {}) {
  const { revealInvisible = false, tiles = true, walls = true } = options;
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
  const commands = [],
    assets = new Set(),
    unsupported = new Map(),
    unsupportedCells = [];
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
  };
  const visible = (t) => t?.active && (revealInvisible || !t.invisibleBlock);
  const add = (c) => {
    commands.push(c);
    assets.add(c.asset);
  };
  const reject = (t, x, y) => {
    unsupportedCells.push({
      x: x + (region.rect.x || 0),
      y: y + (region.rect.y || 0),
      type: t.type,
    });
    support.unsupportedTiles++;
    unsupported.set(t.type, (unsupported.get(t.type) || 0) + 1);
  };
  // Whole wall pass first, so a wall crop cannot cover a foreground sprite.
  if (walls)
    for (let x = 0; x < w; x++)
      for (let y = 0; y < h; y++) {
        const t = cellAt(region, x, y);
        if (!t?.wall) continue;
        if (!revealInvisible && (t.invisibleWall || t.wall === 318)) {
          support.hiddenWalls++;
          continue;
        }
        let mask = maskAt(
          region,
          x,
          y,
          (n) =>
            n?.wall > 0 &&
            (revealInvisible || (!n.invisibleWall && n.wall !== 318)),
        );
        if (mask === 15)
          mask +=
            WALL_CENTER[modulo3(x + (region.rect.x || 0))][
              modulo3(y + (region.rect.y || 0))
            ];
        const [gx, gy] = WALL_GRID[mask];
        add({
          kind: "wall",
          asset: "Wall_" + t.wall + ".png",
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
          fidelity: "approximate",
        });
        support.walls++;
        support.approximateWalls++;
      }
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      const t = cellAt(region, x, y);
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
      let sx,
        sy,
        sh = 16,
        sw = 16,
        offsetX = 0,
        offsetY = 0,
        fidelity;
      const hasFrame =
        Number.isInteger(t.frameX) &&
        Number.isInteger(t.frameY) &&
        t.frameX >= 0 &&
        t.frameY >= 0;
      if (hasFrame && stored.has(t.type)) {
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
        asset: "Tiles_" + t.type + ".png",
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
        fidelity,
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
    }
  const warnings = [
    "Static unlit texture preview; not a pixel-exact Terraria screenshot. Region-edge framing has no outside-neighbor context.",
  ];
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
  if (support.paint)
    warnings.push(
      support.paint +
        " painted cells shown with their unpainted source textures.",
    );
  if (support.liquid)
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
  return {
    commands,
    warnings,
    support,
    unsupportedCells,
    requiredAssets: [...assets].sort(),
    width: w * 16,
    height: h * 16,
  };
}
/** Preflight all textures before strict drawing. Never substitutes colors or invented sprites. */
export function renderScene(context, plan, assets, { strict = false } = {}) {
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
  const warnings = [...plan.warnings];
  if (missing.size)
    warnings.push("Missing textures: " + missingAssets.join(", "));
  if (invalid.size)
    warnings.push(
      "Invalid dimensions or out-of-bounds sprite crops: " +
        invalidAssets.join(", "),
    );
  if (strict && (missing.size || invalid.size))
    throw new Error(warnings.slice(plan.warnings.length).join("; "));
  let drawn = 0;
  context.save();
  try {
    context.imageSmoothingEnabled = false;
    context.beginPath();
    context.rect(0, 0, plan.width, plan.height);
    context.clip();
    for (const c of plan.commands) {
      if (missing.has(c.asset) || invalid.has(c.asset)) continue;
      context.save();
      try {
        if (c.clip) {
          context.beginPath();
          c.clip.forEach(([x, y], i) =>
            context[i ? "lineTo" : "moveTo"](c.dx + x, c.dy + y),
          );
          context.closePath();
          context.clip();
        }
        context.drawImage(
          get(c.asset),
          c.sx,
          c.sy,
          c.sw,
          c.sh,
          c.dx,
          c.dy,
          c.dw,
          c.dh,
        );
        drawn++;
      } finally {
        context.restore();
      }
    }
  } finally {
    context.restore();
  }
  return { drawn, missingAssets, invalidAssets, warnings };
}
