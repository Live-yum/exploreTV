import {
  Reader,
  decodeRecord,
  validateRect,
  LIMITS,
  FormatError,
} from "./world.mjs";
const MAX = 16 * 1024 * 1024;
function hex(b) {
  return Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
}
function unhex(s) {
  if (
    typeof s !== "string" ||
    s.length > 128 ||
    s.length % 2 ||
    !/^[0-9a-f]+$/.test(s)
  )
    throw new FormatError("Invalid tile payload");
  return Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
}
export function crc32(text) {
  let crc = 0xffffffff;
  const byte = (b) => {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  };
  for (const character of text) {
    let c = character.codePointAt(0);
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 128) byte(c);
    else if (c < 2048) {
      byte(192 | (c >> 6));
      byte(128 | (c & 63));
    } else if (c < 65536) {
      byte(224 | (c >> 12));
      byte(128 | ((c >> 6) & 63));
      byte(128 | (c & 63));
    } else {
      byte(240 | (c >> 18));
      byte(128 | ((c >> 12) & 63));
      byte(128 | ((c >> 6) & 63));
      byte(128 | (c & 63));
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}
export function saveFragment(region) {
  const dictionary = [],
    ids = [],
    index = new Map();
  for (const raw of region.raw) {
    const value = hex(raw);
    if (!index.has(value)) {
      index.set(value, dictionary.length);
      dictionary.push(value);
    }
    ids.push(index.get(value));
  }
  const payload = {
    format: "exploreTV.tiles",
    schema: 1,
    version: region.version,
    rect: region.rect,
    source: region.source,
    important: Array.from(region.important),
    order: "column-major",
    dictionary,
    ids,
  };
  const text = JSON.stringify(payload);
  if (text.length > MAX) throw new FormatError("Fragment budget exceeded");
  return JSON.stringify({
    checksum: { algorithm: "crc32", value: crc32(text) },
    payload,
  });
}
export function loadFragment(text) {
  if (typeof text !== "string" || text.length > MAX)
    throw new FormatError("Fragment budget exceeded");
  let e;
  try {
    e = JSON.parse(text);
  } catch {
    throw new FormatError("Invalid fragment JSON");
  }
  const p = e?.payload;
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).some(
      (k) =>
        ![
          "format",
          "schema",
          "version",
          "rect",
          "source",
          "important",
          "order",
          "dictionary",
          "ids",
        ].includes(k),
    ) ||
    p.format !== "exploreTV.tiles"
  )
    throw new FormatError("Unsupported fragment structure");
  if (
    p.format !== "exploreTV.tiles" ||
    p.schema !== 1 ||
    p.order !== "column-major" ||
    !Number.isInteger(p.version) ||
    p.version < 269 ||
    p.version > 326
  )
    throw new FormatError("Unsupported fragment");
  if (
    !Number.isSafeInteger(p.source?.width) ||
    !Number.isSafeInteger(p.source?.height) ||
    p.source.width <= 0 ||
    p.source.height <= 0 ||
    typeof p.source.name !== "string" ||
    p.source.name.length > 4096 ||
    !Number.isInteger(p.source.id) ||
    p.source.id < -2147483648 ||
    p.source.id > 2147483647 ||
    Object.keys(p.source).some(
      (k) =>
        ![
          "signature",
          "name",
          "id",
          "width",
          "height",
          "worldSurface",
        ].includes(k),
    ) ||
    (p.source.worldSurface !== undefined &&
      (!Number.isFinite(p.source.worldSurface) ||
        p.source.worldSurface < 0 ||
        p.source.worldSurface > p.source.height)) ||
    p.source.width > 10000 ||
    p.source.height > 5000 ||
    !["relogic", "xindong"].includes(p.source.signature) ||
    p.source.width * p.source.height > LIMITS.worldTiles
  )
    throw new FormatError("Invalid source dimensions");
  const rect = validateRect(p.rect, p.source.width, p.source.height);
  if (
    !Array.isArray(p.important) ||
    p.important.length < 1 ||
    p.important.length > 4096 ||
    p.important.some((v) => v !== 0 && v !== 1)
  )
    throw new FormatError("Invalid frame table");
  if (
    !Array.isArray(p.dictionary) ||
    p.dictionary.length > rect.width * rect.height ||
    !Array.isArray(p.ids) ||
    p.ids.length !== rect.width * rect.height
  )
    throw new FormatError("Invalid cell count");
  if (
    p.dictionary.some(
      (value) => typeof value !== "string" || value.length > 128,
    )
  )
    throw new FormatError("Invalid tile payload");
  if (
    e?.checksum?.algorithm !== "crc32" ||
    crc32(JSON.stringify(p)) !== e.checksum.value
  )
    throw new FormatError("Fragment integrity mismatch");
  const important = Uint8Array.from(p.important),
    dictionary = p.dictionary.map((s) => {
      const raw = unhex(s),
        r = new Reader(raw),
        rec = decodeRecord(r, important);
      if (rec.repeats || r.pos !== raw.length || raw[0] & 192)
        throw new FormatError("Noncanonical cell payload");
      return rec;
    });
  const cells = [],
    raw = [];
  for (const id of p.ids) {
    if (!Number.isSafeInteger(id) || id < 0 || id >= dictionary.length)
      throw new FormatError("Invalid cell index");
    cells.push({ ...dictionary[id].tile });
    raw.push(dictionary[id].raw.slice());
  }
  return { rect, version: p.version, source: p.source, important, cells, raw };
}
export function restoreIntoRegion(target, fragment, x, y) {
  validateRect(
    { x, y, width: fragment.rect.width, height: fragment.rect.height },
    target.rect.width,
    target.rect.height,
  );
  if (
    target.version !== fragment.version ||
    hex(target.important) !== hex(fragment.important)
  )
    throw new FormatError("Tile format mismatch");
  const out = {
    ...target,
    rect: { ...target.rect },
    source: { ...target.source },
    important: Uint8Array.from(target.important),
    cells: target.cells.map((t) => ({ ...t })),
    raw: target.raw.map((b) => Uint8Array.from(b)),
  };
  for (let dx = 0; dx < fragment.rect.width; dx++)
    for (let dy = 0; dy < fragment.rect.height; dy++) {
      const src = dx * fragment.rect.height + dy,
        dst = (x + dx) * target.rect.height + y + dy;
      out.cells[dst] = { ...fragment.cells[src] };
      out.raw[dst] = Uint8Array.from(fragment.raw[src]);
    }
  return out;
}
/** Crop a loaded fragment without access to or mutation of its source world. */
export function cropFragment(fragment, rect) {
  rect = validateRect(rect, fragment.source.width, fragment.source.height);
  if (
    rect.x < fragment.rect.x ||
    rect.y < fragment.rect.y ||
    rect.x + rect.width > fragment.rect.x + fragment.rect.width ||
    rect.y + rect.height > fragment.rect.y + fragment.rect.height
  )
    throw new FormatError("Rectangle outside loaded fragment");
  const cells = [],
    raw = [];
  for (let x = rect.x; x < rect.x + rect.width; x++)
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      const i =
        (x - fragment.rect.x) * fragment.rect.height + y - fragment.rect.y;
      cells.push({ ...fragment.cells[i] });
      raw.push(Uint8Array.from(fragment.raw[i]));
    }
  return {
    rect,
    source: { ...fragment.source },
    version: fragment.version,
    important: Uint8Array.from(fragment.important),
    cells,
    raw,
  };
}
