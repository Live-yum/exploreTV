import { prepareSceneFrames, sceneFrameKey } from "../core/scene-frames.mjs";

// Metadata follows a prepared frame's lifetime, including cache eviction. It
// never retains a frame or its native canvas after the owning cache releases it.
const opaqueMeans = new WeakMap();
function frameMean(frame) {
  if (
    !frame?.base ||
    frame.additive ||
    frame.width !== 16 ||
    frame.height !== 16
  )
    return null;
  if (opaqueMeans.has(frame)) return opaqueMeans.get(frame);
  const pixels = frame.base.getContext("2d").getImageData(0, 0, 16, 16).data;
  let r = 0,
    g = 0,
    b = 0,
    opaque = true;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] !== 255) {
      opaque = false;
      break;
    }
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
  }
  const mean = opaque
    ? Uint8Array.of(
        Math.round(r / 256),
        Math.round(g / 256),
        Math.round(b / 256),
        255,
      )
    : null;
  opaqueMeans.set(frame, mean);
  return mean;
}

/**
 * Exact 1-pixel-per-tile shortcut, applied AFTER ordinary fallback composition.
 * A cell qualifies only when the LAST command touching it is an aligned,
 * unscaled, unclipped, unflipped 16x16 frame proven opaque after paint/tint.
 * Every later command participates in the last-touch map, including transparent
 * sprites, liquids, additive effects, slopes and oversized wall/tree frames.
 * Earlier draws may be omitted only if their ENTIRE destination covers safe
 * cells. Other commands retain their original order and normal compositor.
 */
export function prepareOpaqueOverview(
  plan,
  assets,
  createCanvas,
  { frameCache = null, inputEncoding = "tconvert-game-raw", keyCache = null } = {},
) {
  const widthTiles = plan.width / 16,
    heightTiles = plan.height / 16;
  if (
    !Number.isSafeInteger(widthTiles) ||
    !Number.isSafeInteger(heightTiles) ||
    widthTiles < 1 ||
    heightTiles < 1 ||
    widthTiles * heightTiles > 65536
  )
    throw new Error("Invalid opaque overview scene dimensions");
  const safe = new Uint8Array(widthTiles * heightTiles),
    rgba = new Uint8Array(safe.length * 4),
    skip = new Set(),
    result = {
      widthTiles,
      heightTiles,
      safe,
      rgba,
      skip,
      eligibleTiles: 0,
      candidateTiles: 0,
      uniqueCandidateFrames: 0,
      skippedCommands: 0,
      totalCommands: plan.commands.length,
    };
  // Invalid geometry cannot establish absence of overlap. Conservatively leave
  // all work to the ordinary compositor rather than infer a usable rectangle.
  if (
    plan.commands.some(
      (c) =>
        ![c.dx, c.dy, c.dw, c.dh].every(Number.isFinite) ||
        c.dw <= 0 ||
        c.dh <= 0,
    )
  )
    return result;
  const last = new Int32Array(safe.length).fill(-1),
    bounds = new Int32Array(plan.commands.length * 4);
  for (let i = 0; i < plan.commands.length; i++) {
    const c = plan.commands[i],
      offset = i * 4;
    // Fractional and clipped draws are expanded conservatively by a pixel to
    // avoid making any assumption about rasterizer edge coverage.
    const pad =
      c.clip || ![c.dx, c.dy, c.dw, c.dh].every(Number.isInteger) ? 1 : 0;
    const x0 = Math.max(0, Math.floor((c.dx - pad) / 16)),
      y0 = Math.max(0, Math.floor((c.dy - pad) / 16)),
      x1 = Math.min(widthTiles, Math.ceil((c.dx + c.dw + pad) / 16)),
      y1 = Math.min(heightTiles, Math.ceil((c.dy + c.dh + pad) / 16));
    bounds[offset] = x0;
    bounds[offset + 1] = y0;
    bounds[offset + 2] = x1;
    bounds[offset + 3] = y1;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) last[y * widthTiles + x] = i;
  }
  const groups = new Map();
  for (let i = 0; i < last.length; i++) {
    if (last[i] < 0) continue;
    const c = plan.commands[last[i]];
    if (
      c.dx !== (i % widthTiles) * 16 ||
      c.dy !== Math.floor(i / widthTiles) * 16 ||
      c.dw !== 16 ||
      c.dh !== 16 ||
      c.sw !== 16 ||
      c.sh !== 16 ||
      c.clip ||
      c.flipX ||
      c.flipY ||
      (c.opacity !== undefined && c.opacity !== 1)
    )
      continue;
    result.candidateTiles++;
    const key = keyCache?.get(c) ?? sceneFrameKey(c);
    let group = groups.get(key);
    if (!group) {
      group = { command: c, indices: [] };
      groups.set(key, group);
    }
    group.indices.push(i);
  }
  const unique = [...groups.values()];
  result.uniqueCandidateFrames = unique.length;
  // Candidate frames are exactly 16x16: 450 unique frames stay below both the
  // ordinary frame-count limit and the 8-MiB preparation byte limit.
  for (let start = 0; start < unique.length; start += 450) {
    const batch = unique.slice(start, start + 450),
      frames = prepareSceneFrames(
        { ...plan, commands: batch.map((g) => g.command) },
        assets,
        createCanvas,
        { frameCache, inputEncoding, opaqueScene: true, keyCache },
      );
    try {
      for (const group of batch) {
        const mean = frameMean(frames.resolve(group.command));
        if (!mean) continue;
        for (const i of group.indices) {
          safe[i] = 1;
          rgba.set(mean, i * 4);
          result.eligibleTiles++;
        }
      }
    } finally {
      frames.dispose();
    }
  }
  for (let i = 0; i < plan.commands.length; i++) {
    const offset = i * 4;
    let covered = true;
    outer: for (let y = bounds[offset + 1]; y < bounds[offset + 3]; y++)
      for (let x = bounds[offset]; x < bounds[offset + 2]; x++)
        if (!safe[y * widthTiles + x]) {
          covered = false;
          break outer;
        }
    if (covered) skip.add(plan.commands[i]);
  }
  result.skippedCommands = skip.size;
  return result;
}

/** Overwrite only proven cells in an already reduced 1-pixel-per-tile core. */
export function applyOpaqueOverview(data, core, region, prepared) {
  const offsetX = core.x - region.rect.x,
    offsetY = core.y - region.rect.y;
  if (
    data.length !== core.width * core.height * 4 ||
    ![offsetX, offsetY, core.width, core.height].every(Number.isSafeInteger) ||
    offsetX < 0 ||
    offsetY < 0 ||
    core.width < 1 ||
    core.height < 1 ||
    offsetX + core.width > prepared.widthTiles ||
    offsetY + core.height > prepared.heightTiles
  )
    throw new Error("Invalid opaque overview reduced core");
  for (let y = 0; y < core.height; y++)
    for (let x = 0; x < core.width; x++) {
      const i = (offsetY + y) * prepared.widthTiles + offsetX + x;
      if (prepared.safe[i])
        data.set(
          prepared.rgba.subarray(i * 4, i * 4 + 4),
          (y * core.width + x) * 4,
        );
    }
  return data;
}
