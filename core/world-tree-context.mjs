import { Reader, FormatError } from "./world.mjs";

/** Bounded read-only tree metadata from the supported modern WLD header.
 * Field order follows the fixed 8255d346 world-header serialization contract;
 * offsets are walked, never guessed by searching for a plausible array length.
 */
export function readWorldTreeContext(world) {
  if (!world || world.version < 269 || world.version > 326)
    throw new FormatError("Tree metadata requires WLD version 269..326");
  const r = new Reader(world.bytes, world.sections[1]);
  r.pos = world.sections[0];
  r.str();
  r.str();
  r.skip(24 + 4 + 16); // generator version, GUID, world ID and pixel bounds
  const height = r.i32(),
    width = r.i32();
  if (height !== world.height || width !== world.width)
    throw new FormatError("Tree metadata world dimensions disagree");
  const flagsOffset = r.pos;
  r.skip(4); // game mode
  const flags = {};
  for (const name of [
    "drunkWorld",
    "getGoodWorld",
    "tenthAnniversaryWorld",
    "dontStarveWorld",
    "notTheBeesWorld",
    "remixWorld",
    "noTrapsWorld",
    "zenithWorld",
  ])
    flags[name] = Boolean(r.u8());
  if (world.version >= 302) flags.skyblockWorld = Boolean(r.u8());
  r.skip(8 + (world.version >= 284 ? 8 : 0) + 1); // dates, moon type
  const treeX = Array.from({ length: 3 }, () => r.i32());
  const treeStyle = Array.from({ length: 4 }, () => r.i32());
  r.skip(40 + 8); // cave boundaries/styles, ice/jungle/hell backgrounds, spawn
  const worldSurface = r.f64();
  r.skip(23 + 8 + 1); // rock/time/day/moon/blood/eclipse, dungeon, crimson
  r.skip(11 + 7 + 3 + 4 + 2); // boss/rescue/event flags, orb count, altars/hardmode
  r.skip(20 + 8 + 1 + 1 + 4 + 4 + 12); // invasion, rain, hardmode ore tiers
  const backgrounds = Array.from({ length: 8 }, () => r.u8());
  r.skip(10); // cloud background, cloud count and wind
  const count = (value, maximum, label) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
      throw new FormatError(`Invalid ${label} count in tree metadata`);
    return value;
  };
  const anglers = count(r.i32(), 10000, "angler");
  for (let i = 0; i < anglers; i++) r.str();
  r.skip(8 + 8); // angler quest and rescue flags; invasion start/cultist delay
  r.skip(count(r.i16(), 10000, "banner kill") * 4);
  if (world.version >= 289)
    r.skip(count(r.i16(), 10000, "claimable banner") * 2);
  r.skip(1 + 9 + 9); // fast-forward and defeated/active event flags
  r.skip(2 + 4); // party flags and cooldown
  r.skip(count(r.i32(), 10000, "party NPC") * 4);
  r.skip(13 + 4 + 5 + 1 + 7); // sandstorm, DD2, later backgrounds, book, lantern
  const variationsOffset = r.pos;
  const variationCount = count(r.i32(), 13, "tree variation");
  if (variationCount !== 13)
    throw new FormatError("Expected the modern 13-entry tree variation array");
  const treeTopVariations = Array.from({ length: variationCount }, () =>
    r.i32(),
  );
  if (
    !treeX.every((n, i) => n >= 0 && n <= width && (!i || n >= treeX[i - 1])) ||
    !treeTopVariations.every((n) => n >= 0 && n <= 255) ||
    !Number.isFinite(worldSurface) ||
    worldSurface < 0 ||
    worldSurface > height
  )
    throw new FormatError("Invalid tree metadata values");
  return {
    treeX,
    treeStyle,
    treeTopVariations,
    jungleBG: backgrounds[2],
    snowBG: backgrounds[3],
    hallowBG: backgrounds[4],
    worldSurface,
    worldWidth: width,
    worldHeight: height,
    beachDistance: 380,
    ...flags,
    provenance: {
      formatVersion: world.version,
      flagsOffset,
      variationsOffset,
      endOffset: r.pos,
      sourceRevision: "8255d34616c780af12079425ac92a0a7aed87d71",
    },
  };
}
