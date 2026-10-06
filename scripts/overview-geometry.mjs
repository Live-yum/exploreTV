import { canonicalSlopeClip } from "./slope-overview-frame.mjs";

export function isIntegerOverviewDraw(c) {
  const opacity = c.opacity;
  return (
    (!c.clip || canonicalSlopeClip(c) !== null) &&
    (opacity === undefined ||
      (Number.isFinite(opacity) && opacity >= 0 && opacity <= 1)) &&
    Number.isSafeInteger(c.dx) &&
    Number.isSafeInteger(c.dy) &&
    Math.abs(c.dx) <= 0x3fffffff &&
    Math.abs(c.dy) <= 0x3fffffff &&
    Number.isSafeInteger(c.dw) &&
    Number.isSafeInteger(c.dh) &&
    c.dw > 0 &&
    c.dh > 0 &&
    c.dw <= 64 &&
    c.dh <= 64 &&
    c.dw === c.sw &&
    c.dh === c.sh
  );
}

/** Write a bounded output-cell rectangle, preserving Canvas edge margins. */
export function writeOverviewBounds(
  c,
  width,
  height,
  left,
  top,
  out,
  offset = 0,
) {
  const dx = c.dx,
    dy = c.dy,
    dw = c.dw,
    dh = c.dh;
  if (
    !Number.isFinite(dx) ||
    !Number.isFinite(dy) ||
    !Number.isFinite(dw) ||
    !Number.isFinite(dh) ||
    dw <= 0 ||
    dh <= 0
  ) {
    out[offset] = out[offset + 1] = 0;
    out[offset + 2] = width;
    out[offset + 3] = height;
    return false;
  }
  const pad =
    c.clip ||
    !Number.isInteger(dx) ||
    !Number.isInteger(dy) ||
    !Number.isInteger(dw) ||
    !Number.isInteger(dh)
      ? 1
      : 0;
  // Clamp BOTH ends while still doubles. Converting distant finite coordinates
  // into Int32 before clamping would wrap an empty rectangle into the scene.
  out[offset] = Math.min(
    width,
    Math.max(0, Math.floor((dx - left - pad) / 16)),
  );
  out[offset + 1] = Math.min(
    height,
    Math.max(0, Math.floor((dy - top - pad) / 16)),
  );
  out[offset + 2] = Math.max(
    0,
    Math.min(width, Math.ceil((dx + dw - left + pad) / 16)),
  );
  out[offset + 3] = Math.max(
    0,
    Math.min(height, Math.ceil((dy + dh - top + pad) / 16)),
  );
  return true;
}

/**
 * One bounded, immutable-plan analysis for opaque means and native partitioning.
 * Command indices belong to this exact working array, never to a frame key or
 * an asset. The optional provider avoids another command-object lookup table.
 * No command, texture, frame, or world-sized buffer is retained beyond the view.
 */
export function createOverviewGeometryAnalysis(
  plan,
  core,
  region,
  indexProvider = null,
) {
  const widthTiles = plan.width / 16,
    heightTiles = plan.height / 16,
    width = core.width,
    height = core.height,
    offsetX = core.x - region.rect.x,
    offsetY = core.y - region.rect.y,
    left = offsetX * 16,
    top = offsetY * 16,
    commands = plan.commands;
  if (
    ![widthTiles, heightTiles, width, height, offsetX, offsetY].every(
      Number.isSafeInteger,
    ) ||
    widthTiles < 1 ||
    heightTiles < 1 ||
    widthTiles * heightTiles > 65536 ||
    width < 1 ||
    height < 1 ||
    offsetX < 0 ||
    offsetY < 0 ||
    offsetX + width > widthTiles ||
    offsetY + height > heightTiles
  )
    throw new Error("Invalid shared overview geometry dimensions");
  const bounds = new Int32Array(commands.length * 4),
    integer = new Uint8Array(commands.length),
    last = new Int32Array(widthTiles * heightTiles).fill(-1),
    unsafe = new Uint8Array(width * height);
  const rectangle = new Int32Array(4);
  const coreBoundsAt = (index, out) => {
    const c = commands[index],
      offset = index * 4;
    // Translate already-rounded bounds only for exact small-integer arithmetic.
    // Almost-integer/extreme geometry must preserve subtraction before padding.
    if (
      integer[index] ||
      (Number.isSafeInteger(c.dx) &&
        Number.isSafeInteger(c.dy) &&
        Number.isSafeInteger(c.dw) &&
        Number.isSafeInteger(c.dh) &&
        Math.abs(c.dx) <= 0x3fffffff &&
        Math.abs(c.dy) <= 0x3fffffff &&
        c.dw > 0 &&
        c.dh > 0 &&
        c.dw <= 0x3fffffff &&
        c.dh <= 0x3fffffff)
    ) {
      out[0] = Math.min(width, Math.max(0, bounds[offset] - offsetX));
      out[1] = Math.min(height, Math.max(0, bounds[offset + 1] - offsetY));
      out[2] = Math.max(0, Math.min(width, bounds[offset + 2] - offsetX));
      out[3] = Math.max(0, Math.min(height, bounds[offset + 3] - offsetY));
    } else writeOverviewBounds(c, width, height, left, top, out);
  };
  let validGeometry = true,
    unsafeCells = 0;
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i],
      offset = i * 4,
      valid = writeOverviewBounds(
        c,
        widthTiles,
        heightTiles,
        0,
        0,
        bounds,
        offset,
      );
    integer[i] = Number(isIntegerOverviewDraw(c));
    if (!valid) validGeometry = false;
    if (validGeometry) {
      for (let y = bounds[offset + 1]; y < bounds[offset + 3]; y++) {
        const end = y * widthTiles + bounds[offset + 2];
        for (let p = y * widthTiles + bounds[offset]; p < end; p++) last[p] = i;
      }
    }
    if (!integer[i] && unsafeCells < unsafe.length) {
      if (!valid) {
        unsafe.fill(1);
        unsafeCells = unsafe.length;
      } else {
        coreBoundsAt(i, rectangle);
        for (let y = rectangle[1]; y < rectangle[3]; y++) {
          const end = y * width + rectangle[2];
          for (let p = y * width + rectangle[0]; p < end; p++)
            if (!unsafe[p]) {
              unsafe[p] = 1;
              unsafeCells++;
            }
        }
      }
    }
  }
  const indices = indexProvider
    ? null
    : new Map(commands.map((c, i) => [c, i]));
  const indexOf = (c) => {
    const i = indexProvider ? indexProvider.indexOf(c) : indices.get(c);
    return Number.isInteger(i) && i >= 0 && commands[i] === c ? i : -1;
  };
  return {
    commands,
    widthTiles,
    heightTiles,
    width,
    height,
    left,
    top,
    bounds,
    coreBoundsAt,
    integer,
    last,
    unsafe,
    unsafeCells,
    validGeometry,
    indexOf,
  };
}
