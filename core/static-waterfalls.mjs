/** Fresh, deterministic waterfall scene; source facts in docs/static-waterfalls.md. */
import {
  isSolidOrSlopedTile,
  SOURCE_SOLID_TILE_TYPES,
  SOURCE_TILE_COUNT,
} from "./tile-solidity.mjs";
import {
  shimmerBaseVertexColors,
  shimmerGlitterVertexColors,
} from "./liquid-shimmer.mjs";

const BLOCKS_BACK = new Set([54, 541, 328, 459, 470]);
const CLOUDS = new Map([
  [196, 11],
  [460, 22],
  [717, 26],
]);
const STYLE = new Map([
  [0, 0],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 9],
  [9, 10],
  [10, 13],
  [12, 23],
  [13, 24],
]);
const top = (t) => t.shape === 2 || t.shape === 3;
const bottom = (t) => t.shape === 4 || t.shape === 5;
const half = (t) => t.shape === 1;
const f = Math.fround;
const byte = (n) => Math.max(0, Math.min(255, Math.trunc(n)));
const key = (x, y) => `${x},${y}`;
export const SOURCE_SOLID_DRAW_LAYER_OVERRIDES = Object.freeze([
  11, 470, 475, 78, 579,
]);
const drawSolid = new Set([
  ...SOURCE_SOLID_TILE_TYPES,
  ...SOURCE_SOLID_DRAW_LAYER_OVERRIDES,
]);

/** Pass the owner tile's type, including for its secondary overlay sprites. */
export function classifyTileDrawLayer(type) {
  if (
    !Number.isInteger(type) ||
    type < 0 ||
    type >= SOURCE_TILE_COUNT ||
    type === 379
  )
    return undefined;
  return drawSolid.has(type) ? "solid" : "non-solid";
}

function rectValid(r) {
  return (
    r &&
    [r.x, r.y, r.width, r.height].every(Number.isSafeInteger) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.width > 0 &&
    r.height > 0
  );
}

/** Tile-space viewport, matching a native-scale screen whose edges lie on tiles. */
export function waterfallScanBounds(width, height, viewport, quality = 1) {
  if (
    ![width, height].every((n) => Number.isSafeInteger(n) && n >= 3) ||
    !rectValid(viewport) ||
    viewport.x + viewport.width > width ||
    viewport.y + viewport.height > height ||
    !Number.isFinite(quality) ||
    quality < 0 ||
    quality > 1
  )
    throw new RangeError("Invalid waterfall scan bounds");
  const distance = Math.trunc(f(f(75) * f(quality))) + 25;
  const x = Math.max(1, viewport.x - 1 - distance),
    y = Math.max(1, viewport.y - 1 - distance);
  return {
    x,
    y,
    width: Math.max(
      0,
      Math.min(width - 1, viewport.x + viewport.width + 2 + distance) - x,
    ),
    height: Math.max(
      0,
      Math.min(height - 1, viewport.y + viewport.height + 22) - y,
    ),
    distance,
  };
}

function failure(reason, x, y) {
  const e = new Error(reason);
  Object.assign(e, { waterfallFailure: true, reason, x, y });
  return e;
}

/**
 * Scan once for the complete scene; reuse this registry for every render/export
 * chunk. Input tiles are read only. Membership is independent of draw support.
 */
export function createStaticWaterfallRegistry(world, options = {}) {
  const { width, height, worldSurface, getTile } = world ?? {};
  if (typeof getTile !== "function" || !Number.isFinite(worldSurface))
    throw new TypeError("Waterfall world accessor and surface are required");
  const quality = options.quality ?? 1,
    viewport = options.viewport ?? { x: 0, y: 0, width, height };
  const scan = waterfallScanBounds(width, height, viewport, quality);
  if (scan.width * scan.height > 40000000)
    throw new RangeError("Waterfall scan exceeds forty-million-cell budget");
  const maxCommands = options.maxCommands ?? 131072;
  if (
    !Number.isSafeInteger(maxCommands) ||
    maxCommands < 1 ||
    maxCommands > 1048576
  )
    throw new RangeError("Invalid waterfall command budget");
  if (
    !Number.isFinite(options.timeForVisualEffects ?? 0) ||
    !["xna", "fna"].includes(options.colorProfile ?? "xna")
  )
    throw new RangeError("Invalid frozen waterfall color clock/profile");
  const maxWaterfalls = options.maxWaterfalls ?? 1000;
  if (
    !Number.isSafeInteger(maxWaterfalls) ||
    maxWaterfalls < 0 ||
    maxWaterfalls > 100000
  )
    throw new RangeError("Invalid waterfall draw limit");
  const cap = Math.trunc(f(f(maxWaterfalls) * f(quality)));
  const clocks = {};
  for (const [name, max] of [
    ["frame", 15],
    ["slowFrame", 15],
    ["rainFrame", 7],
    ["rainBackgroundFrame", 7],
    ["snowFrame", 7],
    ["lavaRainFrame", 7],
    ["lavaRainBackgroundFrame", 7],
  ]) {
    const value = options[name] ?? 0;
    if (!Number.isInteger(value) || value < 0 || value > max)
      throw new RangeError(`Invalid waterfall ${name}`);
    clocks[name] = value;
  }
  const waterStyle = options.waterStyle ?? 0;
  if (!STYLE.has(waterStyle))
    throw new RangeError("Invalid waterfall water style");
  const disco = options.discoColor ?? [255, 0, 0];
  if (
    !Array.isArray(disco) ||
    disco.length !== 3 ||
    !disco.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
  )
    throw new RangeError("Invalid frozen disco color");
  const isSolid = options.isSolid ?? isSolidOrSlopedTile;
  const get = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height)
      throw failure("waterfall-world-edge-dependency", x, y);
    const t = getTile(x, y);
    if (!t || typeof t.active !== "boolean")
      throw failure("waterfall-missing-context", x, y);
    if (
      !Number.isInteger(t.liquid ?? 0) ||
      (t.liquid ?? 0) < 0 ||
      (t.liquid ?? 0) > 255 ||
      !Number.isInteger(t.shape ?? 0) ||
      (t.shape ?? 0) < 0 ||
      (t.shape ?? 0) > 5 ||
      (t.liquid && ![1, 2, 3, 4].includes(t.liquidKind))
    )
      throw failure("waterfall-invalid-tile", x, y);
    return t;
  };
  const solid = (t, draw = false) => {
    if (draw && t.type === 546) return false;
    const value = isSolid(t);
    if (typeof value !== "boolean") throw failure("waterfall-unknown-solidity");
    return value && !(t.shape ?? 0);
  };
  const origins = [],
    members = new Set(),
    failures = [];
  let eligible = 0,
    scanComplete = true;
  const register = (x, y, type, source) => {
    eligible++;
    if (origins.length < cap) {
      const origin = { x, y, type, source, index: origins.length };
      origins.push(origin);
      members.add(key(x, y));
    }
  };
  try {
    for (let x = scan.x; x < scan.x + scan.width; x++)
      for (let y = scan.y; y < scan.y + scan.height; y++) {
        const t = get(x, y);
        if (!t.active) continue;
        if (half(t)) {
          const n = get(x, y - 1);
          if ((n.liquid ?? 0) < 16 || solid(n)) {
            const w = get(x - 1, y),
              e = get(x + 1, y);
            const open = (a) => !a.liquid && !solid(a) && (a.shape ?? 0) <= 1;
            if ((w.liquid > 160 || e.liquid > 160) && (open(w) || open(e))) {
              const kinds = [n.liquidKind, w.liquidKind, e.liquidKind];
              register(
                x,
                y,
                kinds.includes(2)
                  ? 1
                  : kinds.includes(3)
                    ? 14
                    : kinds.includes(4)
                      ? 25
                      : 0,
                "halfbrick",
              );
            }
          }
        }
        if (CLOUDS.has(t.type)) {
          const s = get(x, y + 1);
          if (!solid(s) && !s.liquid && (s.shape ?? 0) <= 1)
            register(x, y + 1, CLOUDS.get(t.type), "cloud");
        }
      }
  } catch (e) {
    if (!e.waterfallFailure) throw e;
    scanComplete = false;
    failures.push({ phase: "scan", reason: e.reason, x: e.x, y: e.y });
  }
  const allCommands = [],
    assets = new Set(),
    originPlans = [];
  const extendedDistance = Math.trunc(
    f(f(f(40) * f(f(width) / f(4200))) * f(quality)),
  );
  const traversalBound = Math.max(scan.distance, extendedDistance);
  if (traversalBound > 4096)
    throw new RangeError("Waterfall traversal exceeds 4096 steps");
  const emitFor =
    (origin, output) =>
    (type, x, y, sx, sy, sw, sh, dx, dy, flipX, color, step, rawAlpha = 1) => {
      if (sh <= 0 || sw <= 0) return;
      if (
        allCommands.length + output.length + (type === 25 ? 2 : 1) >
        maxCommands
      )
        throw failure("waterfall-command-budget", x, y);
      const asset = `Waterfall_${type}.png`;
      const c = {
        kind: "waterfall",
        asset,
        sourceAsset: `Images/${asset}`,
        sx,
        sy,
        sw,
        sh,
        dx,
        dy,
        dw: sw,
        dh: sh,
        worldX: x,
        worldY: y,
        originX: origin.x,
        originY: origin.y,
        originIndex: origin.index,
        step,
        layer: "waterfall-before-solid-tiles",
        drawBeforeSolidTiles: true,
        fidelity: "fresh-static-waterfall",
        ...(flipX ? { flipX: true } : {}),
      };
      if (type === 25) {
        const time = options.timeForVisualEffects ?? 0;
        const colorOptions = { colorProfile: options.colorProfile ?? "xna" };
        c.vertexColors = shimmerBaseVertexColors(
          x,
          y,
          rawAlpha,
          time,
          colorOptions,
        );
        output.push(c, {
          ...c,
          sy: sy + 42,
          vertexColors: shimmerGlitterVertexColors(
            x,
            y,
            rawAlpha,
            true,
            time,
            colorOptions,
          ),
          shimmerLayer: "sparkle",
        });
        return;
      }
      if (color.every((v) => v === color[0])) c.opacity = color[0] / 255;
      else c.vertexColor = color;
      output.push(c);
    };
  const alphaAt = (type, y, step, limit, tile) => {
    let alpha =
      type === 1
        ? 1
        : type === 14
          ? f(0.8)
          : type === 25
            ? f(0.75)
            : (tile.wall &&
                  (options.showInvisibleWalls ||
                    (tile.wall !== 318 && !tile.invisibleWall))) ||
                y >= worldSurface
              ? f(0.6)
              : 1;
    if (step > limit - 10) alpha = f(alpha * f(f(limit - step) / f(10)));
    return alpha;
  };
  const planRain = (origin, output) => {
    const type = origin.type,
      limit = Math.trunc(scan.distance / (type === 22 ? 2 : 4));
    let x = origin.x,
      y = origin.y;
    if (
      y + limit < viewport.y ||
      x < viewport.x - 20 ||
      x > viewport.x + viewport.width + 20
    )
      return { steps: 0, reason: "outside-rain-view" };
    const emit = emitFor(origin, output),
      parity = x % 2 === 0;
    const fg =
      ((type === 22
        ? clocks.snowFrame
        : type === 26
          ? clocks.lavaRainFrame
          : clocks.rainFrame) +
        (parity ? 3 : 0)) %
      8;
    const bg =
      ((type === 26
        ? clocks.lavaRainBackgroundFrame
        : clocks.rainBackgroundFrame) +
        (parity ? 2 : 0)) %
      8;
    let drawX = x * 16 + (y % 2 === 0 ? 1 : 0),
      drawY = y * 16,
      cropHeight = 16,
      last = false;
    const north = get(x, y - 1);
    if (north.active && bottom(north)) drawY -= 16;
    for (let step = 0; step < limit; step++) {
      const fade = step > limit - 8 ? f(f(limit - step) / f(8)) : 1;
      const color = (factor) =>
        (type === 26 ? [255, 255, 255, 127] : [255, 255, 255, 255]).map((n) =>
          byte(f(n * f(f(factor) * fade))),
        );
      if (type !== 22)
        emit(
          type === 26 ? 27 : 12,
          x,
          y,
          bg * 18,
          0,
          16,
          cropHeight,
          drawX,
          drawY,
          false,
          color(type === 26 ? 0.4 : 0.3),
          step,
        );
      emit(
        type,
        x,
        y,
        fg * 18,
        0,
        16,
        cropHeight,
        drawX,
        drawY,
        false,
        color(type === 26 ? 0.9 : 0.6),
        step,
      );
      if (last) return { steps: step + 1, reason: "solid-rain-end" };
      y++;
      if (y >= height) return { steps: step + 1, reason: "world-end" };
      const next = get(x, y);
      last = solid(next, true);
      if (next.liquid > 0) {
        const crop = Math.trunc(f(f(16) * f(f(next.liquid) / f(255)))) & 0xfe;
        if (crop >= 15) return { steps: step + 1, reason: "liquid-rain-end" };
        cropHeight -= crop;
        if (cropHeight <= 0)
          throw failure("waterfall-rain-accumulated-crop", x, y);
      }
      drawX += y % 2 === 0 ? 1 : -1;
      drawY += 16;
    }
    return { steps: limit, reason: "distance" };
  };
  const planFall = (origin, output) => {
    const emit = emitFor(origin, output);
    let type = origin.type === 0 ? STYLE.get(waterStyle) : origin.type;
    const frameX =
      32 * ([1, 14, 25].includes(type) ? clocks.slowFrame : clocks.frame);
    let x = origin.x,
      y = origin.y,
      offset = 0,
      previousDX = 0,
      previousDY = 0,
      direction = 0,
      previousDirection = 0,
      previousSlope = 0,
      previousType = 0,
      turns = 0,
      limit = scan.distance,
      previousColor = [255, 255, 255, 255];
    for (let step = 0; step < limit; step++) {
      if (step >= traversalBound)
        throw failure("waterfall-traversal-budget", x, y);
      if (turns >= 2) return { steps: step, reason: "direction-reversal" };
      const t = get(x, y);
      if (solid(t, true)) return { steps: step, reason: "solid-end" };
      const w = get(x - 1, y),
        s = get(x, y + 1),
        e = get(x + 1, y);
      if (solid(s, true) && !half(t)) offset = 8;
      else if (previousDY) offset = 0;
      const lastDirection = previousDirection;
      let slope = 0,
        dx = 0,
        dy = 0,
        slopeTurn = false;
      if (top(s) && !half(t) && s.type !== 19) {
        slopeTurn = true;
        slope = dx = s.shape === 2 ? 1 : -1;
        direction = previousDirection = dx;
        dy = 1;
      } else if (
        (!solid(s, true) && !bottom(s) && !half(t)) ||
        (!s.active && !half(t))
      ) {
        turns = 0;
        dy = 1;
      } else if (
        (solid(w, true) || top(w) || w.liquid > 0) &&
        !solid(e, true) &&
        !e.liquid
      ) {
        if (direction === -1) turns++;
        dx = direction = 1;
      } else if (
        (solid(e, true) || top(e) || e.liquid > 0) &&
        !solid(w, true) &&
        !w.liquid
      ) {
        if (direction === 1) turns++;
        dx = direction = -1;
      } else if (
        ((!solid(e, true) && !top(t)) || !e.liquid) &&
        !solid(w, true) &&
        !top(t) &&
        !w.liquid
      )
        dx = direction;
      else turns++;
      if (turns >= 2) {
        direction *= -1;
        dx *= -1;
      }
      if (![1, 14, 25].includes(type)) {
        const contactType = t.active ? t.type : s.active ? s.type : -1;
        if (contactType === 160) type = 2;
        else if (contactType >= 262 && contactType <= 268)
          type = 15 + contactType - 262;
      }
      const alpha = alphaAt(type, y, step, limit, t);
      let color = [...(type === 2 ? disco : [255, 255, 255]), 255].map((n) =>
        byte(f(f(n) * alpha)),
      );
      const crop = Math.trunc((t.liquid ?? 0) / 16),
        px = x * 16,
        py = y * 16;
      const draw = (
        ty,
        sourceY,
        sw,
        sh,
        offX,
        offY,
        flip,
        tint = color,
        sourceX = frameX,
      ) =>
        emit(
          ty,
          x,
          y,
          sourceX,
          sourceY,
          sw,
          sh,
          px + offX,
          py + offY,
          flip,
          tint,
          step,
          alpha,
        );
      if (slopeTurn && direction !== lastDirection)
        draw(
          type,
          24,
          32,
          14 - crop,
          lastDirection === 1 ? -16 : 0,
          14,
          lastDirection === 1,
        );
      if (
        !previousDX &&
        slope &&
        previousDY === 1 &&
        direction !== previousDirection
      ) {
        slope = 0;
        direction = previousDirection;
        color = [255, 255, 255, 255];
        draw(type, 24, 32, 16 - crop, -16, 16, true);
      }
      if (previousSlope && !dx && dy === 1)
        draw(
          type,
          0,
          16,
          8 - crop,
          0,
          offset + 8,
          direction === 1,
          direction === 1 && previousType !== type ? previousColor : color,
        );
      if (offset === 8 && previousDY === 1 && !previousSlope)
        draw(
          previousType !== type ? previousType : type,
          24,
          32,
          8,
          previousDirection === -1 ? 0 : -16,
          0,
          previousDirection !== -1,
          previousType !== type ? previousColor : color,
        );
      if (slope && !previousDX)
        draw(
          previousType !== type ? previousType : type,
          24,
          32,
          16 - crop,
          lastDirection === 1 ? -16 : 0,
          0,
          lastDirection === 1,
          previousType !== type ? previousColor : color,
        );
      if (dy === 1 && !slope && !previousSlope) {
        if (!previousDY)
          draw(type, 0, 16, 16 - crop, 0, offset, direction !== -1);
        else
          draw(
            previousType !== type ? previousType : type,
            24,
            32,
            16 - crop,
            direction === -1 ? 0 : -16,
            0,
            direction !== -1,
            previousType !== type ? previousColor : color,
          );
      } else if (dx && (!t.liquid || half(t))) {
        if (slope)
          for (let slice = 0; slice < 8; slice++) {
            offset = 8;
            let vertical = dx === 1 ? slice * 2 : 14 - slice * 2;
            if (!previousDX && (dx === 1 ? slice < 2 : slice > 5)) vertical = 4;
            draw(
              type,
              0,
              2,
              8,
              slice * 2,
              offset + vertical,
              true,
              color,
              frameX + 16 + (dx === 1 ? 14 - slice * 2 : slice * 2),
            );
          }
        else
          draw(
            type,
            0,
            16,
            BLOCKS_BACK.has(t.type) || BLOCKS_BACK.has(s.type) ? 8 : 16,
            0,
            offset,
            dx === 1,
            color,
            frameX + 16,
          );
      } else if (!dx && !dy) {
        if (!t.liquid || half(t))
          draw(type, 0, 16, 16, 0, offset, false, color, frameX + 16);
        return { steps: step + 1, reason: "stationary-end" };
      }
      if (t.liquid > 0 && !half(t))
        return { steps: step + 1, reason: "liquid-end" };
      previousDY = dy;
      previousDirection = direction;
      previousDX = dx;
      x += dx;
      y += dy;
      previousSlope = slope;
      previousColor = color;
      previousType = type;
      if ([w, e, s].some((n) => n.active && (n.type === 189 || n.type === 196)))
        limit = extendedDistance;
      if (x < 0 || y < 0 || x >= width || y >= height)
        return { steps: step + 1, reason: "world-end" };
    }
    return { steps: limit, reason: "distance" };
  };
  if (scanComplete)
    for (const origin of origins) {
      const output = [];
      try {
        const detail = [11, 22, 26].includes(origin.type)
          ? planRain(origin, output)
          : planFall(origin, output);
        originPlans.push({
          ...origin,
          supported: true,
          commandCount: output.length,
          ...detail,
        });
        for (const c of output) {
          assets.add(c.asset);
          allCommands.push(c);
        }
      } catch (e) {
        if (!e.waterfallFailure) throw e;
        const issue = {
          ...origin,
          supported: false,
          phase: "draw",
          reason: e.reason,
          dependencyX: e.x,
          dependencyY: e.y,
          commandCount: 0,
        };
        originPlans.push(issue);
        failures.push(issue);
      }
    }
  // Each source step explicitly sets its layer. Further texture switches in
  // that step increment the stack. TileBatch batches by stack and first-seen
  // texture identity, preserving insertion order inside each resulting batch.
  const textureOrder = new Map();
  let previous = null,
    stack = 0;
  for (const c of allCommands) {
    const newStep =
      !previous ||
      previous.originIndex !== c.originIndex ||
      previous.step !== c.step;
    if (newStep)
      stack = [11, 22, 26].includes(origins[c.originIndex].type) ? 0 : 256;
    else if (previous.asset !== c.asset) stack++;
    if (!textureOrder.has(c.asset))
      textureOrder.set(c.asset, textureOrder.size);
    c.batchLayerStack = stack;
    c.batchTextureOrder = textureOrder.get(c.asset);
    previous = c;
  }
  allCommands.sort(
    (a, b) =>
      a.batchLayerStack - b.batchLayerStack ||
      a.batchTextureOrder - b.batchTextureOrder,
  );
  const buckets = new Map(),
    bucketSize = 64;
  for (let i = 0; i < allCommands.length; i++) {
    const c = allCommands[i];
    for (
      let bx = Math.floor(c.dx / 16 / bucketSize);
      bx <= Math.floor((c.dx + c.dw - 1) / 16 / bucketSize);
      bx++
    )
      for (
        let by = Math.floor(c.dy / 16 / bucketSize);
        by <= Math.floor((c.dy + c.dh - 1) / 16 / bucketSize);
        by++
      ) {
        const k = key(bx, by);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(i);
      }
  }
  return {
    model: "fresh-static",
    scanComplete,
    scan,
    viewport: { ...viewport },
    quality,
    maxWaterfalls,
    cap,
    maxCommands,
    traversalBound,
    clocks: {
      ...clocks,
      timeForVisualEffects: options.timeForVisualEffects ?? 0,
    },
    colorProfile: options.colorProfile ?? "xna",
    discoColor: [...disco],
    showInvisibleWalls: options.showInvisibleWalls === true,
    waterStyle,
    origins,
    originPlans,
    failures,
    requiredAssets: [...assets].sort(),
    stats: {
      eligible,
      registered: origins.length,
      capped: eligible - origins.length,
      commands: allCommands.length,
      unsupportedOrigins: originPlans.filter((p) => !p.supported).length,
    },
    hasOrigin(x, y) {
      return scanComplete ? members.has(key(x, y)) : undefined;
    },
    commandsFor(rect) {
      if (
        !rectValid(rect) ||
        rect.x + rect.width > width ||
        rect.y + rect.height > height
      )
        throw new RangeError("Invalid waterfall output rectangle");
      const selected = new Set();
      for (
        let bx = Math.floor(rect.x / bucketSize);
        bx <= Math.floor((rect.x + rect.width - 1) / bucketSize);
        bx++
      )
        for (
          let by = Math.floor(rect.y / bucketSize);
          by <= Math.floor((rect.y + rect.height - 1) / bucketSize);
          by++
        )
          for (const i of buckets.get(key(bx, by)) ?? []) selected.add(i);
      const left = rect.x * 16,
        top = rect.y * 16,
        right = (rect.x + rect.width) * 16,
        bottom = (rect.y + rect.height) * 16;
      return [...selected]
        .sort((a, b) => a - b)
        .map((i) => allCommands[i])
        .filter(
          (c) =>
            c.dx < right &&
            c.dy < bottom &&
            c.dx + c.dw > left &&
            c.dy + c.dh > top,
        )
        .map((c) => ({
          ...c,
          dx: c.dx - left,
          dy: c.dy - top,
          x: c.worldX - rect.x,
          y: c.worldY - rect.y,
        }));
    },
  };
}
