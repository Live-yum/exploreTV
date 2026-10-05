import { readWorldTreeContext } from "./world-tree-context.mjs";
import { decodeUtf8 } from "./utf8.mjs";
/** Original bounded modern WLD tile reader; no game source/assets bundled. */
export const LIMITS = Object.freeze({
  fileBytes: 64 * 1024 * 1024,
  worldTiles: 24_000_000,
  regionTiles: 65_536,
  regionSide: 512,
});
export class FormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "FormatError";
  }
}
export class Reader {
  constructor(bytes, end = bytes.length) {
    this.bytes = bytes;
    this.pos = 0;
    this.end = end;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(n) {
    if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.end)
      throw new FormatError(`Truncated data at ${this.pos}`);
  }
  u8() {
    this.need(1);
    return this.bytes[this.pos++];
  }
  u16() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16() {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64() {
    this.need(8);
    const value = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return value;
  }
  skip(n) {
    this.need(n);
    this.pos += n;
  }
  str() {
    let n = 0,
      s = 0,
      b;
    do {
      if (s >= 35) throw new FormatError("Invalid string length");
      b = this.u8();
      n += (b & 127) * 2 ** s;
      s += 7;
    } while (b & 128);
    if (n > 4096) throw new FormatError("String too long");
    this.need(n);
    const out = decodeUtf8(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return out;
  }
}
export function validateRect(rect, width, height) {
  if (
    !rect ||
    !["x", "y", "width", "height"].every((k) => Number.isSafeInteger(rect[k]))
  )
    throw new FormatError("Rectangle requires integer coordinates");
  const { x, y, width: w, height: h } = rect;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > width || y + h > height)
    throw new FormatError("Rectangle outside world");
  if (
    w > LIMITS.regionSide ||
    h > LIMITS.regionSide ||
    w * h > LIMITS.regionTiles
  )
    throw new FormatError("Region budget exceeded");
  return { x, y, width: w, height: h };
}
export function decodeRecord(r, important) {
  const start = r.pos,
    h1 = r.u8(),
    h2 = h1 & 1 ? r.u8() : 0,
    h3 = h2 & 1 ? r.u8() : 0,
    h4 = h3 & 1 ? r.u8() : 0;
  const tile = {
    active: !!(h1 & 2),
    type: 0,
    frameX: null,
    frameY: null,
    wall: 0,
    paint: 0,
    wallPaint: 0,
    liquid: 0,
    liquidKind: 0,
    shape: (h2 >> 4) & 7,
    wireRed: !!(h2 & 2),
    wireBlue: !!(h2 & 4),
    wireGreen: !!(h2 & 8),
    wireYellow: !!(h3 & 32),
    actuator: !!(h3 & 2),
    inactive: !!(h3 & 4),
    invisibleBlock: !!(h4 & 2),
    invisibleWall: !!(h4 & 4),
    fullbrightBlock: !!(h4 & 8),
    fullbrightWall: !!(h4 & 16),
  };
  if (tile.active) {
    tile.type = h1 & 32 ? r.u16() : r.u8();
    if (tile.type >= important.length)
      throw new FormatError("Tile type outside frame table");
    if (important[tile.type]) {
      tile.frameX = r.i16();
      tile.frameY = r.i16();
    }
    if (h3 & 8) tile.paint = r.u8();
  }
  if (h1 & 4) {
    tile.wall = r.u8();
    if (h3 & 16) tile.wallPaint = r.u8();
  }
  const liquid = (h1 >> 3) & 3;
  if (liquid) {
    tile.liquid = r.u8();
    tile.liquidKind = h3 & 128 ? 4 : liquid;
  }
  if (h3 & 64) tile.wall |= r.u8() << 8;
  const end = r.pos,
    code = h1 >> 6,
    repeats = code === 0 ? 0 : code === 1 ? r.u8() : r.i16();
  if (repeats < 0) throw new FormatError("Negative RLE");
  const raw = Uint8Array.from(r.bytes.subarray(start, end));
  raw[0] &= 63;
  return { tile, raw, repeats };
}
export function openWorld(input) {
  const bytes = ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  if (bytes.length > LIMITS.fileBytes)
    throw new FormatError("World file size budget exceeded");
  const r = new Reader(bytes),
    version = r.i32();
  if (version < 269 || version > 326)
    throw new FormatError(
      `Unsupported WLD version ${version}; supported 269–326`,
    );
  const signature = String.fromCharCode(...bytes.subarray(4, 11));
  if (!["relogic", "xindong"].includes(signature))
    throw new FormatError("Invalid WLD magic");
  r.skip(7);
  if (r.u8() !== 2) throw new FormatError("Not a world file");
  r.skip(12);
  const count = r.u16();
  if (count < 3 || count > 32) throw new FormatError("Invalid section count");
  const sections = [];
  for (let i = 0; i < count; i++) sections.push(r.i32());
  for (let i = 0; i < count; i++)
    if (
      sections[i] < r.pos ||
      sections[i] > bytes.length ||
      (i && sections[i] < sections[i - 1])
    )
      throw new FormatError("Invalid section offsets");
  const types = r.u16();
  if (types < 1 || types > 4096) throw new FormatError("Invalid frame table");
  const important = new Uint8Array(types);
  let bit = 0;
  for (let i = 0; i < types; i++) {
    if (i % 8 === 0) bit = r.u8();
    important[i] = !!(bit & (1 << i % 8));
  }
  if (r.pos !== sections[0]) throw new FormatError("Header section mismatch");
  r.end = sections[1];
  const name = r.str(),
    seed = r.str();
  r.skip(24);
  const id = r.i32();
  r.skip(16);
  const height = r.i32(),
    width = r.i32();
  if (
    width <= 0 ||
    height <= 0 ||
    width > 10000 ||
    height > 5000 ||
    width * height > LIMITS.worldTiles
  )
    throw new FormatError("World dimensions exceed budget");
  // Optional scene metadata. Layout is fixed for the explicitly supported versions.
  // A fragment never needs the rest of the world header or non-Tile sections.
  let worldSurface;
  const sceneMetadataSkip =
    4 + (version >= 302 ? 9 : 8) + 8 + (version >= 284 ? 8 : 0) + 1 + 68 + 8;
  if (r.pos + sceneMetadataSkip + 8 <= r.end) {
    r.skip(sceneMetadataSkip);
    const candidate = r.f64();
    if (Number.isFinite(candidate) && candidate >= 0 && candidate <= height)
      worldSurface = candidate;
  }
  r.pos = sections[1];
  r.end = sections[2];
  const columns = new Uint32Array(width + 1);
  let records = 0;
  for (let x = 0; x < width; x++) {
    columns[x] = r.pos;
    for (let y = 0; y < height; ) {
      const rec = decodeRecord(r, important);
      if (y + rec.repeats >= height)
        throw new FormatError("RLE crosses column");
      y += rec.repeats + 1;
      records++;
    }
  }
  columns[width] = r.pos;
  if (r.pos !== sections[2])
    throw new FormatError("Tile section length mismatch");
  const world = {
    signature,
    version,
    name,
    seed,
    id,
    width,
    height,
    worldSurface,
    bytes,
    important,
    sections,
    columns,
    records,
  };
  try {
    world.treeContext = readWorldTreeContext(world);
  } catch (error) {
    world.treeContextUnavailableReason = String(error.message || error).slice(
      0,
      200,
    );
  }
  return Object.freeze(world);
}
export function extractRegion(world, rect) {
  rect = validateRect(rect, world.width, world.height);
  const cells = [],
    raw = [],
    r = new Reader(world.bytes, world.sections[2]);
  for (let x = rect.x; x < rect.x + rect.width; x++) {
    r.pos = world.columns[x];
    let y = 0;
    while (y < rect.y + rect.height) {
      const rec = decodeRecord(r, world.important),
        end = y + rec.repeats + 1;
      for (
        let yy = Math.max(y, rect.y);
        yy < Math.min(end, rect.y + rect.height);
        yy++
      ) {
        cells.push({ ...rec.tile });
        raw.push(rec.raw.slice());
      }
      y = end;
    }
  }
  return {
    rect,
    version: world.version,
    important: world.important.slice(),
    cells,
    raw,
    source: {
      signature: world.signature,
      name: world.name,
      id: world.id,
      width: world.width,
      height: world.height,
      ...(world.worldSurface === undefined
        ? {}
        : { worldSurface: world.worldSurface }),
    },
  };
}
export function cellAt(region, x, y) {
  if (x < 0 || y < 0 || x >= region.rect.width || y >= region.rect.height)
    return null;
  return region.cells[x * region.rect.height + y];
}
/** Read-only render halo. It is intentionally excluded from fragment serialization. */
export function extractSceneRegion(world, rect, padding = 12) {
  if (!Number.isSafeInteger(padding) || padding < 0 || padding > 16)
    throw new FormatError("Invalid render padding");
  const region = extractRegion(world, rect);
  region.treeContext = world.treeContext;
  region.treeContextUnavailableReason = world.treeContextUnavailableReason;
  region.getWorldTile = getWorldTileAccessor(world);
  const x = Math.max(0, region.rect.x - padding),
    y = Math.max(0, region.rect.y - padding);
  const width =
    Math.min(world.width, region.rect.x + region.rect.width + padding) - x;
  const height =
    Math.min(world.height, region.rect.y + region.rect.height + padding) - y;
  if (
    width <= LIMITS.regionSide &&
    height <= LIMITS.regionSide &&
    width * height <= LIMITS.regionTiles
  ) {
    region.context = extractRegion(world, { x, y, width, height });
  } else
    region.contextUnavailableReason =
      "Render halo exceeds the bounded region budget";
  return region;
}

// At most sixteen decoded RLE columns remain reachable per open world.
const worldLookups = new WeakMap();
export function getWorldTileAccessor(world) {
  if (worldLookups.has(world)) return worldLookups.get(world);
  const columns = new Map();
  const lookup = (x, y) => {
    if (
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= world.width ||
      y >= world.height
    )
      return null;
    let runs = columns.get(x);
    if (runs) {
      columns.delete(x);
      columns.set(x, runs);
    } else {
      runs = [];
      const reader = new Reader(world.bytes, world.sections[2]);
      reader.pos = world.columns[x];
      let end = 0;
      while (end < world.height) {
        const record = decodeRecord(reader, world.important);
        end += record.repeats + 1;
        runs.push({ end, tile: Object.freeze(record.tile) });
      }
      columns.set(x, runs);
      if (columns.size > 16) columns.delete(columns.keys().next().value);
    }
    let lo = 0,
      hi = runs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (y < runs[mid].end) hi = mid;
      else lo = mid + 1;
    }
    return runs[lo].tile;
  };
  lookup.cacheInfo = () => ({ columns: columns.size, maxColumns: 16 });
  worldLookups.set(world, lookup);
  return lookup;
}
