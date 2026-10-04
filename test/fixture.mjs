/** Original synthetic parser fixtures; no proprietary world or artwork. */
export class Writer {
  constructor() {
    this.data = [];
  }
  u8(n) {
    this.data.push(n & 255);
    return this;
  }
  u16(n) {
    return this.u8(n).u8(n >>> 8);
  }
  i16(n) {
    return this.u16(n);
  }
  i32(n) {
    return this.u16(n).u16(n >>> 16);
  }
  bytes(a) {
    this.data.push(...a);
    return this;
  }
  zero(n) {
    for (let i = 0; i < n; i++) this.u8(0);
    return this;
  }
  str(s) {
    const b = new TextEncoder().encode(s);
    let n = b.length;
    while (n >= 128) {
      this.u8((n & 127) | 128);
      n >>>= 7;
    }
    this.u8(n);
    return this.bytes(b);
  }
  finish() {
    return Uint8Array.from(this.data);
  }
}
export function record({
  type = 1,
  wall = 0,
  frame = null,
  paint = 0,
  wallPaint = 0,
  liquid = 0,
  liquidKind = 1,
  shape = 0,
  red = false,
  blue = false,
  green = false,
  yellow = false,
  actuator = false,
  inactive = false,
  invisibleBlock = false,
  invisibleWall = false,
  fullbrightBlock = false,
  fullbrightWall = false,
  repeats = 0,
  runCode = null,
} = {}) {
  let h1 = 0,
    h2 = (red ? 2 : 0) | (blue ? 4 : 0) | (green ? 8 : 0) | (shape << 4),
    h3 =
      (actuator ? 2 : 0) |
      (inactive ? 4 : 0) |
      (paint ? 8 : 0) |
      (wallPaint ? 16 : 0) |
      (yellow ? 32 : 0) |
      (wall > 255 ? 64 : 0) |
      (liquidKind === 4 && liquid ? 128 : 0),
    h4 =
      (invisibleBlock ? 2 : 0) |
      (invisibleWall ? 4 : 0) |
      (fullbrightBlock ? 8 : 0) |
      (fullbrightWall ? 16 : 0);
  if (h4) h3 |= 1;
  if (h3) h2 |= 1;
  if (h2) h1 |= 1;
  if (type !== null) h1 |= 2 | (type > 255 ? 32 : 0);
  if (wall) h1 |= 4;
  if (liquid) h1 |= (liquidKind === 4 ? 1 : liquidKind) << 3;
  const code = runCode ?? (repeats === 0 ? 0 : repeats < 256 ? 1 : 2);
  h1 |= code << 6;
  const w = new Writer().u8(h1);
  if (h1 & 1) w.u8(h2);
  if (h2 & 1) w.u8(h3);
  if (h3 & 1) w.u8(h4);
  if (type !== null) {
    type > 255 ? w.u16(type) : w.u8(type);
    if (frame) w.i16(frame[0]).i16(frame[1]);
    if (paint) w.u8(paint);
  }
  if (wall) {
    w.u8(wall);
    if (wallPaint) w.u8(wallPaint);
  }
  if (liquid) w.u8(liquid);
  if (wall > 255) w.u8(wall >>> 8);
  if (code === 1) w.u8(repeats);
  else if (code > 1) w.i16(repeats);
  return w.finish();
}
export function fixtureWorld({
  width = 2,
  height = 3,
  version = 269,
  columns = null,
  importantIds = [21, 300],
  name = "Synthetic 世界",
  seed = "fixture-seed",
  tail = [],
} = {}) {
  const important = new Uint8Array(512);
  for (const id of importantIds) important[id] = 1;
  const header = new Writer()
    .str(name)
    .str(seed)
    .zero(24)
    .i32(12345)
    .i32(0)
    .i32(width * 16)
    .i32(0)
    .i32(height * 16)
    .i32(height)
    .i32(width);
  // Only the envelope and metadata consumed by this bounded reader are modeled.
  header.zero(128);
  const tiles = new Writer();
  if (columns) {
    for (const column of columns) for (const r of column) tiles.bytes(r);
  } else
    for (let x = 0; x < width; x++)
      tiles.bytes(record({ type: x % 2 ? 0 : 1, repeats: height - 1 }));
  tiles.bytes(tail);
  const format = new Writer()
    .i32(version)
    .bytes(new TextEncoder().encode("relogic"))
    .u8(2)
    .zero(12)
    .u16(3);
  const sectionPointerOffset = format.data.length;
  format.zero(12).u16(important.length);
  for (let i = 0; i < important.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b |= important[i + j] << j;
    format.u8(b);
  }
  const headerStart = format.data.length,
    tileStart = headerStart + header.data.length,
    tileEnd = tileStart + tiles.data.length;
  const out = new Writer()
    .bytes(format.finish())
    .bytes(header.finish())
    .bytes(tiles.finish())
    .finish();
  const view = new DataView(out.buffer);
  [headerStart, tileStart, tileEnd].forEach((v, i) =>
    view.setInt32(sectionPointerOffset + i * 4, v, true),
  );
  const headerStringBytes = new Writer().str(name).str(seed).data.length;
  return {
    bytes: out,
    important,
    headerStart,
    tileStart,
    tileEnd,
    sectionPointerOffset,
    heightOffset: headerStart + headerStringBytes + 44,
    widthOffset: headerStart + headerStringBytes + 48,
  };
}
export function allFlagsRecord(extra = {}) {
  return record({
    type: 300,
    wall: 513,
    frame: [-2, 324],
    paint: 31,
    wallPaint: 29,
    liquid: 217,
    liquidKind: 4,
    shape: 5,
    red: true,
    blue: true,
    green: true,
    yellow: true,
    actuator: true,
    inactive: true,
    invisibleBlock: true,
    invisibleWall: true,
    fullbrightBlock: true,
    fullbrightWall: true,
    ...extra,
  });
}
