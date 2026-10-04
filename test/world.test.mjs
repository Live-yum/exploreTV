import test from "node:test";
import assert from "node:assert/strict";
import {
  openWorld,
  extractRegion,
  decodeRecord,
  Reader,
  validateRect,
  FormatError,
} from "../core/world.mjs";
import {
  saveFragment,
  loadFragment,
  restoreIntoRegion,
  crc32,
} from "../core/fragment.mjs";
import { fixtureWorld, record, allFlagsRecord } from "./fixture.mjs";
const whole = (w) =>
  extractRegion(w, { x: 0, y: 0, width: w.width, height: w.height });
const resign = (p) =>
  JSON.stringify({
    checksum: { algorithm: "crc32", value: crc32(JSON.stringify(p)) },
    payload: p,
  });
test("reads synthetic modern header, Unicode strings, dimension order and column RLE", () => {
  const f = fixtureWorld(),
    w = openWorld(f.bytes);
  assert.equal(w.width, 2);
  assert.equal(w.height, 3);
  assert.equal(w.name, "Synthetic 世界");
  assert.equal(w.records, 2);
  assert.deepEqual(
    whole(w).cells.map((t) => t.type),
    [1, 1, 1, 0, 0, 0],
  );
  assert.equal(w.columns[2], f.tileEnd);
});
test("supports both declared version endpoints; rejects outside range", () => {
  for (const version of [269, 326])
    assert.equal(openWorld(fixtureWorld({ version }).bytes).version, version);
  for (const version of [268, 327])
    assert.throws(
      () => openWorld(fixtureWorld({ version }).bytes),
      /Unsupported/,
    );
});
test("all four tile headers, high type, signed frames, paints, wires, coatings and shimmer decode", () => {
  const f = fixtureWorld({
      width: 1,
      height: 1,
      columns: [[allFlagsRecord()]],
    }),
    r = whole(openWorld(f.bytes)),
    t = r.cells[0];
  assert.equal(t.type, 300);
  assert.equal(t.wall, 513);
  assert.equal(t.frameX, -2);
  assert.equal(t.frameY, 324);
  assert.equal(t.paint, 31);
  assert.equal(t.wallPaint, 29);
  assert.equal(t.liquid, 217);
  assert.equal(t.liquidKind, 4);
  assert.equal(t.shape, 5);
  for (const key of [
    "active",
    "wireRed",
    "wireBlue",
    "wireGreen",
    "wireYellow",
    "actuator",
    "inactive",
    "invisibleBlock",
    "invisibleWall",
    "fullbrightBlock",
    "fullbrightWall",
  ])
    assert.equal(t[key], true, key);
  assert.deepEqual(r.raw[0], allFlagsRecord());
});
test("high wall byte follows paint and liquid, not wall low byte", () => {
  const raw = record({
      type: null,
      wall: 513,
      wallPaint: 7,
      liquid: 211,
      liquidKind: 2,
    }),
    important = new Uint8Array(512);
  const decoded = decodeRecord(new Reader(raw), important);
  assert.equal(decoded.tile.wall, 513);
  assert.equal(decoded.tile.wallPaint, 7);
  assert.equal(decoded.tile.liquid, 211);
  assert.equal(decoded.tile.liquidKind, 2);
  assert.deepEqual([...raw].slice(-4), [1, 7, 211, 2]);
});
test("all liquid kinds and shape encodings preserved", () => {
  for (let liquidKind = 1; liquidKind <= 4; liquidKind++)
    for (let shape = 0; shape <= 5; shape++) {
      const t = decodeRecord(
        new Reader(record({ liquid: 128, liquidKind, shape })),
        new Uint8Array(512),
      ).tile;
      assert.equal(t.liquidKind, liquidKind);
      assert.equal(t.shape, shape);
    }
});
test("RLE byte, short, and alternate short flags expand and canonicalize identically", () => {
  for (const runCode of [1, 2, 3]) {
    const f = fixtureWorld({
        width: 1,
        height: 3,
        columns: [[record({ repeats: 2, runCode })]],
      }),
      r = whole(openWorld(f.bytes));
    assert.equal(r.cells.length, 3);
    for (const raw of r.raw) assert.deepEqual(raw, record());
  }
});
test("RLE may not be negative or cross a column", () => {
  assert.throws(
    () =>
      openWorld(
        fixtureWorld({
          width: 1,
          height: 2,
          columns: [[record({ repeats: 2 })]],
        }).bytes,
      ),
    /crosses column/,
  );
  assert.throws(
    () =>
      openWorld(
        fixtureWorld({
          width: 1,
          height: 1,
          columns: [[record({ repeats: -1, runCode: 2 })]],
        }).bytes,
      ),
    /Negative RLE/,
  );
});
test("truncation, extra tile bytes, bad metadata and section offsets rejected", () => {
  const f = fixtureWorld();
  assert.throws(() => openWorld(f.bytes.subarray(0, -1)), FormatError);
  assert.throws(
    () => openWorld(fixtureWorld({ tail: [0] }).bytes),
    /section length mismatch/,
  );
  const magic = f.bytes.slice();
  magic[4] = 0;
  assert.throws(() => openWorld(magic), /magic/);
  const filetype = f.bytes.slice();
  filetype[11] = 1;
  assert.throws(() => openWorld(filetype), /Not a world/);
  const offset = f.bytes.slice();
  new DataView(offset.buffer).setInt32(f.sectionPointerOffset + 4, 1, true);
  assert.throws(() => openWorld(offset), /offset/);
});
test("world dimensions reject negative and overflow-sized products before allocation", () => {
  for (const [width, height] of [
    [-1, 3],
    [10001, 3],
    [10000, 5000],
    [2147483647, 2147483647],
  ]) {
    const f = fixtureWorld();
    const v = new DataView(f.bytes.buffer);
    v.setInt32(f.widthOffset, width, true);
    v.setInt32(f.heightOffset, height, true);
    assert.throws(() => openWorld(f.bytes), /dimensions/);
  }
});
test("region bounds reject fractions, negative, empty, overflow and budget excess", () => {
  const invalid = [
    { x: 0.5, y: 0, width: 1, height: 1 },
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 1, y: 0, width: 2, height: 1 },
    { x: Number.MAX_SAFE_INTEGER, y: 0, width: 1, height: 1 },
  ];
  for (const rect of invalid)
    assert.throws(() => validateRect(rect, 2, 3), FormatError);
  assert.throws(
    () => validateRect({ x: 0, y: 0, width: 513, height: 1 }, 1000, 1000),
    /budget/,
  );
  assert.throws(
    () => validateRect({ x: 0, y: 0, width: 512, height: 512 }, 1000, 1000),
    /budget/,
  );
});
test("extracts partial RLE runs into independent canonical records", () => {
  const r = extractRegion(openWorld(fixtureWorld().bytes), {
    x: 0,
    y: 1,
    width: 2,
    height: 2,
  });
  assert.deepEqual(
    r.cells.map((t) => t.type),
    [1, 1, 0, 0],
  );
  r.raw[0][0] = 255;
  assert.notEqual(r.raw[1][0], 255);
});
test("fragment roundtrip preserves every canonical record and all derived state", () => {
  const f = fixtureWorld({
      width: 1,
      height: 3,
      columns: [[allFlagsRecord({ repeats: 2 })]],
    }),
    r = whole(openWorld(f.bytes)),
    restored = loadFragment(saveFragment(r));
  assert.deepEqual(restored, r);
  assert.equal(JSON.parse(saveFragment(r)).payload.dictionary.length, 1);
  restored.raw[0][0] ^= 1;
  assert.notDeepEqual(restored.raw[0], restored.raw[1]);
});
test("checksum detects mutation; CRC matches the standard check vector", () => {
  assert.equal(crc32("123456789"), "cbf43926");
  const e = JSON.parse(saveFragment(whole(openWorld(fixtureWorld().bytes))));
  e.payload.ids[0] = 1;
  assert.throws(() => loadFragment(JSON.stringify(e)), /integrity/);
});
test("valid checksum does not bypass structural validation", () => {
  const base = JSON.parse(
    saveFragment(whole(openWorld(fixtureWorld().bytes))),
  ).payload;
  const cases = [
    (p) => {
      p.ids[0] = -1;
    },
    (p) => {
      p.ids[0] = 99;
    },
    (p) => {
      p.important[0] = 2;
    },
    (p) => {
      p.rect.width = 0.5;
    },
    (p) => {
      p.dictionary[0] = "ff";
    },
    (p) => {
      p.dictionary[0] = "420100";
    },
    (p) => {
      p.dictionary[0] = "020100";
    },
    (p) => {
      p.ids.pop();
    },
    (p) => {
      p.version = 327;
    },
  ];
  for (const mutate of cases) {
    const p = structuredClone(base);
    mutate(p);
    assert.throws(() => loadFragment(resign(p)), FormatError);
  }
});
test("unknown reserved header bits survive canonical fragment roundtrip", () => {
  const f = fixtureWorld({
    width: 1,
    height: 1,
    columns: [[Uint8Array.from([3, 129, 1, 128, 1])]],
  });
  const r = whole(openWorld(f.bytes));
  assert.deepEqual(loadFragment(saveFragment(r)).raw, r.raw);
});
test("restore is nonmutating and its returned cells, raw records and metadata are isolated", () => {
  const target = whole(openWorld(fixtureWorld().bytes)),
    fragment = whole(
      openWorld(
        fixtureWorld({ width: 1, height: 1, columns: [[allFlagsRecord()]] })
          .bytes,
      ),
    );
  const before = saveFragment(target),
    otherBefore = saveFragment(fragment),
    out = restoreIntoRegion(target, fragment, 1, 1);
  assert.equal(out.cells[4].type, 300);
  assert.equal(target.cells[4].type, 0);
  assert.equal(saveFragment(target), before);
  assert.equal(saveFragment(fragment), otherBefore);
  out.cells[0].type = 99;
  out.raw[0][0] = 255;
  out.important[0] = 1;
  out.rect.x = 3;
  out.source.name = "changed";
  assert.equal(saveFragment(target), before);
  assert.equal(saveFragment(fragment), otherBefore);
  assert.throws(() => restoreIntoRegion(target, fragment, 2, 0), /outside/);
  const incompatible = { ...fragment, version: 326 };
  assert.throws(
    () => restoreIntoRegion(target, incompatible, 0, 0),
    /format mismatch/,
  );
});
test("Node Buffer RLE canonicalization never alters source or aliases outputs", () => {
  const f = fixtureWorld(),
    buffer = Buffer.from(f.bytes),
    before = Buffer.from(buffer),
    w = openWorld(buffer),
    r = whole(w);
  assert.deepEqual(buffer, before);
  assert.equal(buffer[f.tileStart] & 192, 64);
  r.raw[0][0] = 255;
  assert.deepEqual(buffer, before);
  assert.notEqual(r.raw[1][0], 255);
  const offsetBuffer = Buffer.concat([
    Buffer.from([99, 99]),
    buffer,
    Buffer.from([88]),
  ]).subarray(2, buffer.length + 2);
  assert.equal(openWorld(offsetBuffer).width, 2);
});

test("known xindong world signature is accepted and preserved without rewriting input", () => {
  const fixture = fixtureWorld();
  fixture.bytes.set(new TextEncoder().encode("xindong"), 4);
  const before = fixture.bytes.slice(),
    world = openWorld(fixture.bytes);
  assert.equal(world.signature, "xindong");
  const region = extractRegion(world, { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(loadFragment(saveFragment(region)).source.signature, "xindong");
  assert.deepEqual(fixture.bytes, before);
});
test("checksum-valid fragment metadata cannot bypass source format bounds or poison rectangle state", () => {
  const region = whole(openWorld(fixtureWorld().bytes)),
    p = JSON.parse(saveFragment(region)).payload;
  for (const bad of [
    { ...p, source: { ...p.source, width: 8_000_000, height: 3 } },
    { ...p, source: { ...p.source, signature: "malformed" } },
  ])
    assert.throws(() => loadFragment(resign(bad)), /source/);
  p.rect.extra = "metadata";
  const loaded = loadFragment(resign(p));
  assert.deepEqual(Object.keys(loaded.rect), ["x", "y", "width", "height"]);
  assert.deepEqual(loadFragment(saveFragment(loaded)).raw, region.raw);
});
test("large irrelevant payload is rejected before checksum work", () => {
  const s = JSON.stringify({
    checksum: { algorithm: "crc32", value: "bad" },
    payload: { junk: "x".repeat(15 * 1024 * 1024) },
  });
  assert.throws(() => loadFragment(s), /structure/);
});
test("loaded fragment can be cropped independently without borrowing a different open world", async () => {
  const { cropFragment } = await import("../core/fragment.mjs");
  const region = extractRegion(
    openWorld(fixtureWorld({ width: 8, height: 6 }).bytes),
    { x: 2, y: 1, width: 4, height: 4 },
  );
  const cropped = cropFragment(loadFragment(saveFragment(region)), {
    x: 3,
    y: 2,
    width: 2,
    height: 2,
  });
  assert.deepEqual(cropped.raw[0], region.raw[5]);
  assert.equal(cropped.raw.length, 4);
  assert.throws(
    () => cropFragment(region, { x: 0, y: 0, width: 2, height: 2 }),
    /loaded fragment/,
  );
  cropped.raw[0][0] = 255;
  assert.notEqual(cropped.raw[0][0], region.raw[5][0]);
});
