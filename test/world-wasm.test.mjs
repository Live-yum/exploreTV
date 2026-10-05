import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  openWorld,
  extractRegion,
  extractSceneRegion,
  FormatError,
} from "../core/world.mjs";
import {
  loadWasmCore,
  loadWorldEngine,
  extractRegionWasm,
  disposeWorldWasm,
  worldWasmStats,
} from "../core/world-wasm.mjs";
import { fixtureWorld, record, allFlagsRecord } from "./fixture.mjs";
import { saveFragment, loadFragment } from "../core/fragment.mjs";

// These tests require the real Rust-produced binary. A missing binary is a test
// failure, never a skipped test or a mocked JS implementation.
const wasmBytes = await readFile(
  new URL("../wasm-core/dist/exploretv_wld_core.wasm", import.meta.url),
);
const engine = await loadWasmCore(wasmBytes);
function compare(input, rect) {
  const js = openWorld(input),
    wasm = engine.openWorld(input);
  assert.deepEqual(wasm, js);
  rect ??= { x: 0, y: 0, width: js.width, height: js.height };
  const actual = engine.extractRegion(wasm, rect),
    expected = extractRegion(js, rect);
  assert.deepEqual(actual, expected);
  assert.deepEqual(
    loadFragment(saveFragment(actual)),
    loadFragment(saveFragment(expected)),
  );
  engine.disposeWorld(wasm);
  return actual;
}

test("real Rust WASM ABI is import-free and has a 128MiB memory ceiling", async () => {
  const module = await WebAssembly.compile(wasmBytes);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const { exports } = new WebAssembly.Instance(module, {});
  assert.equal(exports.abi_version(), 1);
  assert.equal(exports.cell_bytes(), 32);
  assert.throws(() => exports.memory.grow(2049), RangeError);
  assert.equal(exports.extract_region(0, 0, 1, 1), 18);
  assert.equal(exports.prepare(64 * 1024 * 1024 + 1), 0);
  assert.equal(exports.last_error(), 2);
  exports.prepare(0);
  assert.equal(exports.open_world(), 1);
});

test("synthetic versions, strings, sections, metadata and all field values match JS", () => {
  for (const version of [269, 283, 284, 301, 302, 315, 326]) {
    const f = fixtureWorld({
      version,
      width: 1,
      height: 3,
      columns: [[allFlagsRecord({ repeats: 2 })]],
    });
    compare(f.bytes);
    f.bytes.set(new TextEncoder().encode("xindong"), 4);
    compare(f.bytes);
  }
});

test("liquids, signed frames, high walls, all slopes and alternate RLE encodings match", () => {
  for (const runCode of [0, 1, 2, 3])
    for (const liquidKind of [1, 2, 3, 4])
      for (let shape = 0; shape <= 7; shape++) {
        const repeats = runCode ? 3 : 0;
        const f = fixtureWorld({
          width: 1,
          height: repeats + 1,
          columns: [[allFlagsRecord({ repeats, runCode, liquidKind, shape })]],
        });
        compare(f.bytes);
      }
  compare(
    fixtureWorld({
      width: 1,
      height: 1,
      columns: [
        [
          record({
            type: null,
            wall: 513,
            wallPaint: 7,
            liquid: 211,
            liquidKind: 2,
          }),
        ],
      ],
    }).bytes,
  );
  compare(
    fixtureWorld({
      width: 1,
      height: 1,
      columns: [[Uint8Array.from([3, 129, 1, 128, 1])]],
    }).bytes,
  );
});

test("RLE partial slices are independent canonical raw bytes and preserve Buffer offsets", () => {
  const f = fixtureWorld();
  const bytes = Buffer.concat([
    Buffer.from([9, 8]),
    Buffer.from(f.bytes),
    Buffer.from([7]),
  ]).subarray(2, f.bytes.length + 2);
  const before = bytes.slice();
  const actual = compare(bytes, { x: 0, y: 1, width: 2, height: 2 });
  actual.raw[0][0] = 255;
  assert.notEqual(actual.raw[1][0], 255);
  assert.deepEqual(bytes, before);
});

test("parser errors reject without partial world results and agree with JS", () => {
  const f = fixtureWorld();
  const invalid = [
    ...[268, 327].map((version) => fixtureWorld({ version }).bytes),
    f.bytes.subarray(0, -1),
    new Uint8Array(),
    fixtureWorld({ tail: [0] }).bytes,
    fixtureWorld({ width: 1, height: 2, columns: [[record({ repeats: 2 })]] })
      .bytes,
    fixtureWorld({
      width: 1,
      height: 1,
      columns: [[record({ repeats: -1, runCode: 2 })]],
    }).bytes,
  ];
  for (const [offset, value] of [
    [4, 0],
    [11, 1],
  ]) {
    const changed = f.bytes.slice();
    changed[offset] = value;
    invalid.push(changed);
  }
  for (const [offset, value] of [
    [f.sectionPointerOffset + 4, 1],
    [f.widthOffset, -1],
    [f.widthOffset, 10001],
    [f.heightOffset, 5001],
    [f.widthOffset, 2147483647],
  ]) {
    const changed = f.bytes.slice();
    new DataView(changed.buffer).setInt32(offset, value, true);
    invalid.push(changed);
  }
  for (const bytes of invalid) {
    assert.throws(() => openWorld(bytes), FormatError);
    assert.throws(() => engine.openWorld(bytes), FormatError);
  }
});

test("every truncation of a four-header record is bounded and rejected", () => {
  const f = fixtureWorld({
    width: 1,
    height: 1,
    columns: [[allFlagsRecord()]],
  });
  for (let length = 0; length < f.bytes.length; length++) {
    assert.throws(
      () => engine.openWorld(f.bytes.subarray(0, length)),
      FormatError,
    );
  }
});

test("rectangle validation precedes ABI integer coercion", () => {
  const world = engine.openWorld(
    fixtureWorld({ width: 700, height: 700 }).bytes,
  );
  for (const rect of [
    { x: 0.5, y: 0, width: 1, height: 1 },
    { x: -1, y: 0, width: 1, height: 1 },
    { x: Number.MAX_SAFE_INTEGER, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 699, y: 0, width: 2, height: 1 },
    { x: 0, y: 0, width: 513, height: 1 },
    { x: 0, y: 0, width: 512, height: 512 },
  ])
    assert.throws(() => engine.extractRegion(world, rect), FormatError);
  engine.disposeWorld(world);
});

test("direct ABI coordinates are checked; failed extraction erases stale output", async () => {
  const { exports: e } = new WebAssembly.Instance(
    await WebAssembly.compile(wasmBytes),
    {},
  );
  const f = fixtureWorld();
  const pointer = e.prepare(f.bytes.length);
  new Uint8Array(e.memory.buffer, pointer, f.bytes.length).set(f.bytes);
  assert.equal(e.open_world(), 0);
  assert.equal(e.extract_region(0, 0, 1, 1), 0);
  assert.equal(e.output_len(), 32);
  assert.equal(e.extract_region(0xffffffff, 0, 2, 1), 15);
  assert.equal(e.output_len(), 0);
  assert.equal(e.extract_region(0, 0, 1, 1), 0);
  e.release();
  assert.equal(e.output_len(), 0);
});

test("multiple worlds, repeated extraction and disposal preserve JS-owned outputs", () => {
  const f1 = fixtureWorld(),
    f2 = fixtureWorld({ width: 1, height: 1, columns: [[allFlagsRecord()]] });
  const a = engine.openWorld(f1.bytes),
    b = engine.openWorld(f2.bytes);
  const rect = { x: 0, y: 0, width: 1, height: 1 };
  const ar = engine.extractRegion(a, rect),
    br = engine.extractRegion(b, rect);
  assert.equal(br.cells[0].type, 300);
  assert.notEqual(ar.cells[0].type, 300);
  assert.deepEqual(engine.extractRegion(a, rect), ar);
  assert.ok(worldWasmStats(a).memoryBytes < 128 * 1024 * 1024);
  disposeWorldWasm(a);
  disposeWorldWasm(a);
  assert.equal(worldWasmStats(a), null);
  assert.deepEqual(extractRegionWasm(a, rect), ar);
  assert.deepEqual(engine.extractRegion(b, rect), br);
  disposeWorldWasm(b);
  assert.deepEqual(br.raw[0], allFlagsRecord());
});

test("scene halo and JS random-access lookup preserve metadata and fragment boundaries", () => {
  const input = fixtureWorld({ width: 40, height: 30 }).bytes;
  const js = openWorld(input),
    wasm = engine.openWorld(input),
    rect = { x: 12, y: 12, width: 4, height: 3 };
  const a = extractSceneRegion(js, rect, 8),
    b = engine.extractSceneRegion(wasm, rect, 8);
  const { getWorldTile: ja, ...aa } = a,
    { getWorldTile: wa, ...bb } = b;
  assert.deepEqual(bb, aa);
  assert.deepEqual(wa(39, 29), ja(39, 29));
  assert.equal(loadFragment(saveFragment(b)).cells.length, 12);
  engine.disposeWorld(wasm);
});

test("real example-world full column index and representative rectangles match every field and byte", async () => {
  const input = await readFile(
    new URL("../fixtures/example-world.wld", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(input).digest("hex"),
    "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab",
  );
  const beforeHash = createHash("sha256").update(input).digest("hex");
  const js = openWorld(input),
    wasm = engine.openWorld(input);
  assert.deepEqual(wasm, js); // all 8,401 column offsets, frame table, records and metadata
  const rects = [
    { x: 0, y: 0, width: 1, height: 1 },
    { x: 8399, y: 2399, width: 1, height: 1 },
    { x: 2000, y: 1000, width: 256, height: 256 },
    ...[0, 1900, 4000, 7000, 8272].flatMap((x) =>
      [0, 400, 1000, 2100, 2272].map((y) => ({
        x,
        y,
        width: 128,
        height: 128,
      })),
    ),
  ];
  for (const rect of rects)
    assert.deepEqual(engine.extractRegion(wasm, rect), extractRegion(js, rect));
  assert.equal(createHash("sha256").update(input).digest("hex"), beforeHash);
  engine.disposeWorld(wasm);
});

test("unavailable, malformed or incompatible WASM falls back to the unchanged JS engine", async () => {
  for (const [source, options] of [
    [wasmBytes, { runtime: null }],
    [new Uint8Array([1, 2]), {}],
    [new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), {}],
  ]) {
    const fallback = await loadWorldEngine(source, options);
    assert.equal(fallback.backend, "javascript");
    assert.ok(fallback.fallbackReason);
    const input = fixtureWorld().bytes;
    assert.deepEqual(fallback.openWorld(input), openWorld(input));
  }
});

test("deterministic malformed-input mutations agree with the JS acceptance boundary", () => {
  let seed = 0x18abc91;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const f = fixtureWorld({
    width: 3,
    height: 5,
    columns: [
      [allFlagsRecord({ repeats: 4 })],
      [record({ repeats: 2 }), record({ type: null, repeats: 1 })],
      [record({ wall: 513, liquid: 180, liquidKind: 4, repeats: 4 })],
    ],
  });
  for (let i = 0; i < 400; i++) {
    const bytes = f.bytes.slice();
    for (let j = 0; j < 1 + (i % 4); j++)
      bytes[random() % bytes.length] ^= 1 << random() % 8;
    let js, accelerated, jsError, wasmError;
    try {
      js = openWorld(bytes);
    } catch (error) {
      jsError = error;
    }
    try {
      accelerated = engine.openWorld(bytes);
    } catch (error) {
      wasmError = error;
    }
    assert.equal(
      !!wasmError,
      !!jsError,
      `acceptance differs for mutation ${i}`,
    );
    if (!jsError) {
      assert.deepEqual(accelerated, js);
      const rect = {
        x: 0,
        y: 0,
        width: Math.min(js.width, 3),
        height: Math.min(js.height, 5),
      };
      assert.deepEqual(
        engine.extractRegion(accelerated, rect),
        extractRegion(js, rect),
      );
      engine.disposeWorld(accelerated);
    }
  }
});

test("deterministic mixed-column worlds preserve independently generated records", () => {
  let seed = 0x87654321;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let trial = 0; trial < 24; trial++) {
    const columns = [];
    for (let x = 0; x < 8; x++) {
      const column = [];
      for (let y = 0; y < 48; ) {
        const length = Math.min(1 + (random() % 7), 48 - y),
          framed = random() % 3 === 0;
        column.push(
          record({
            type: framed ? 300 : random() % 5 === 0 ? null : random() % 20,
            frame: framed
              ? [(random() % 65536) - 32768, (random() % 65536) - 32768]
              : null,
            wall: random() % 1024,
            paint: random() % 32,
            wallPaint: random() % 32,
            liquid: random() % 256,
            liquidKind: 1 + (random() % 4),
            shape: random() % 8,
            red: !!(random() & 128),
            blue: !!(random() & 256),
            green: !!(random() & 512),
            yellow: !!(random() & 64),
            actuator: !!(random() & 32),
            inactive: !!(random() & 16),
            invisibleBlock: !!(random() & 8),
            invisibleWall: !!(random() & 4),
            fullbrightBlock: !!(random() & 2),
            fullbrightWall: !!(random() & 1),
            repeats: length - 1,
            runCode: 1 + (random() % 3),
          }),
        );
        y += length;
      }
      columns.push(column);
    }
    compare(fixtureWorld({ width: 8, height: 48, columns }).bytes, {
      x: 1,
      y: 3,
      width: 6,
      height: 39,
    });
  }
});
