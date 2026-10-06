import test from "node:test";
import assert from "node:assert/strict";
import {
  isIntegerOverviewDraw,
  partitionSoftwareOverview,
  SOFTWARE_OVERVIEW_INTEGER,
  SOFTWARE_OVERVIEW_UNSAFE,
  SOFTWARE_OVERVIEW_SAFE,
  SOFTWARE_OVERVIEW_NATIVE,
} from "../scripts/software-overview.mjs";

const command = (extra = {}) => ({
  dx: 16,
  dy: 16,
  dw: 16,
  dh: 16,
  sw: 16,
  sh: 16,
  ...extra,
});
const core = { x: 11, y: 21, width: 4, height: 3 },
  region = { rect: { x: 10, y: 20, width: 8, height: 8 } };

// Intentionally retain the original array/callback/nested-loop geometry as an
// independent oracle for the optimized scalar, summed-area implementation.
function referenceInteger(c) {
  const slope =
    c.dw === 16 &&
    c.dh === 16 &&
    !c.vertexColors &&
    [
      "[[0,0],[16,16],[0,16]]",
      "[[0,16],[16,0],[16,16]]",
      "[[0,0],[16,0],[0,16]]",
      "[[0,0],[16,0],[16,16]]",
    ].includes(JSON.stringify(c.clip)) &&
    [c.flipX, c.flipY].every(
      (value) => value === undefined || typeof value === "boolean",
    );
  return (
    (!c.clip || slope) &&
    (c.opacity === undefined ||
      (Number.isFinite(c.opacity) && c.opacity >= 0 && c.opacity <= 1)) &&
    [c.dx, c.dy, c.dw, c.dh].every(Number.isSafeInteger) &&
    Math.abs(c.dx) <= 0x3fffffff &&
    Math.abs(c.dy) <= 0x3fffffff &&
    c.dw > 0 &&
    c.dh > 0 &&
    c.dw <= 64 &&
    c.dh <= 64 &&
    c.dw === c.sw &&
    c.dh === c.sh
  );
}

function oracle(plan, target, source) {
  const width = target.width,
    height = target.height,
    left = (target.x - source.rect.x) * 16,
    top = (target.y - source.rect.y) * 16,
    unsafe = new Uint8Array(width * height);
  const bounds = (c) => {
    if (
      ![c.dx, c.dy, c.dw, c.dh].every(Number.isFinite) ||
      c.dw <= 0 ||
      c.dh <= 0
    )
      return [0, 0, width, height];
    const pad =
      c.clip || ![c.dx, c.dy, c.dw, c.dh].every(Number.isInteger) ? 1 : 0;
    return [
      Math.max(0, Math.floor((c.dx - left - pad) / 16)),
      Math.max(0, Math.floor((c.dy - top - pad) / 16)),
      Math.min(width, Math.ceil((c.dx + c.dw - left + pad) / 16)),
      Math.min(height, Math.ceil((c.dy + c.dh - top + pad) / 16)),
    ];
  };
  for (const c of plan.commands) {
    if (referenceInteger(c)) continue;
    const [x0, y0, x1, y1] = bounds(c);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) unsafe[y * width + x] = 1;
  }
  return {
    unsafe,
    classify(c) {
      let flags = referenceInteger(c) ? SOFTWARE_OVERVIEW_INTEGER : 0;
      const [x0, y0, x1, y1] = bounds(c);
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++)
          flags |= unsafe[y * width + x]
            ? SOFTWARE_OVERVIEW_UNSAFE
            : SOFTWARE_OVERVIEW_SAFE;
      return flags;
    },
  };
}

test("integer overview eligibility accepts exact opacity variants and flips", () => {
  for (const opacity of [undefined, 0, 1 / 255, 0.3, 0.5, 254 / 255, 1])
    for (const flip of [
      {},
      { flipX: true },
      { flipY: true },
      { flipX: true, flipY: true },
    ])
      assert.equal(isIntegerOverviewDraw(command({ opacity, ...flip })), true);
  for (const extra of [
    { opacity: -0.01 },
    { opacity: 1.01 },
    { opacity: NaN },
    { opacity: Infinity },
    { opacity: "1" },
    { opacity: null },
    { dx: 0.5 },
    { dy: Infinity },
    { dx: 0x40000000 },
    { dw: 0 },
    { dw: 8 },
    { dh: 65, sh: 65 },
    { clip: [] },
  ])
    assert.equal(
      isIntegerOverviewDraw(command(extra)),
      false,
      JSON.stringify(extra),
    );
});

test("classification distinguishes safe, mixed, wholly unsafe and off-core draws", () => {
  const safe = command({ opacity: 0.3 }),
    complex = command({ dx: 32, dw: 15 }),
    whollyUnsafe = command({ dx: 32, opacity: 0.5 }),
    mixed = command({ dw: 32, sw: 32 }),
    outside = command({ dx: -32 }),
    plan = { commands: [safe, complex, whollyUnsafe, mixed, outside] },
    result = partitionSoftwareOverview(plan, core, region);
  assert.equal(result.unsafeCells, 1);
  assert.deepEqual([...result.unsafe], [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (const [c, expected] of [
    [safe, SOFTWARE_OVERVIEW_NATIVE],
    [complex, SOFTWARE_OVERVIEW_UNSAFE],
    [whollyUnsafe, SOFTWARE_OVERVIEW_INTEGER | SOFTWARE_OVERVIEW_UNSAFE],
    [
      mixed,
      SOFTWARE_OVERVIEW_INTEGER |
        SOFTWARE_OVERVIEW_UNSAFE |
        SOFTWARE_OVERVIEW_SAFE,
    ],
    [outside, SOFTWARE_OVERVIEW_INTEGER],
  ]) {
    assert.equal(result.classify(c), expected);
    assert.equal(result.classify(c), expected, "cached classification");
    assert.equal(
      result.touchesUnsafe(c),
      !!(expected & SOFTWARE_OVERVIEW_UNSAFE),
    );
    assert.equal(
      result.shouldDrawNative(c),
      (expected & SOFTWARE_OVERVIEW_NATIVE) === SOFTWARE_OVERVIEW_NATIVE,
    );
  }
  assert.equal(result.shouldDrawNative(whollyUnsafe), false);
  assert.equal(result.shouldDrawNative(mixed), true);
});

test("clipping and fractional edges conservatively include neighboring output cells", () => {
  for (const c of [
    command({
      dx: 32,
      dy: 32,
      clip: [
        [0, 0],
        [16, 0],
        [0, 15],
      ],
    }),
    command({ dx: 32.25, dy: 32 }),
  ]) {
    const result = partitionSoftwareOverview({ commands: [c] }, core, region);
    assert.equal(result.unsafeCells, 9);
    assert.deepEqual([...result.unsafe], [1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0]);
  }
});

test("invalid geometry marks the complete core; extreme finite off-core coordinates stay empty", () => {
  for (const extra of [{ dx: NaN }, { dh: Infinity }, { dw: -1 }, { dh: 0 }]) {
    const invalid = command(extra),
      normal = command(),
      result = partitionSoftwareOverview(
        { commands: [invalid, normal] },
        core,
        region,
      );
    assert.equal(result.unsafeCells, core.width * core.height);
    assert.equal(result.shouldDrawNative(normal), false);
    assert.equal(result.touchesUnsafe(normal), true);
  }
  const distant = [
    command({ dx: 1e100 }),
    command({ dx: -1e100 }),
    command({ dy: 1e100, opacity: -1 }),
    command({ dy: -1e100, clip: [] }),
  ];
  const result = partitionSoftwareOverview({ commands: distant }, core, region);
  assert.equal(result.unsafeCells, 0);
  for (const c of distant) {
    assert.equal(result.classify(c), 0);
    assert.equal(result.touchesUnsafe(c), false);
    assert.equal(result.shouldDrawNative(c), false);
  }
});

test("summed-area classification matches the independent rectangle oracle across shifted cores", () => {
  let seed = 0x89bace;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  for (let scene = 0; scene < 80; scene++) {
    const source = { rect: { x: random(20), y: random(20) } },
      target = {
        x: source.rect.x + random(8),
        y: source.rect.y + random(8),
        width: 1 + random(16),
        height: 1 + random(12),
      },
      left = (target.x - source.rect.x) * 16,
      top = (target.y - source.rect.y) * 16,
      commands = [];
    for (let i = 0; i < 40; i++) {
      const dw = 1 + random(64),
        dh = 1 + random(64),
        c = command({
          dx: left + random(target.width * 16 + 80) - 40,
          dy: top + random(target.height * 16 + 80) - 40,
          dw,
          dh,
          sw: dw,
          sh: dh,
          opacity: random(256) / 255,
          flipX: !!random(2),
          flipY: !!random(2),
        });
      switch (random(8)) {
        case 0:
          c.dx += 0.25;
          break;
        case 1:
          c.dy -= 0.75;
          break;
        case 2:
          c.clip = [
            [0, 0],
            [dw, 0],
            [0, dh],
          ];
          break;
        case 3:
          c.dw += 1;
          break;
        case 4:
          c.opacity = 1.1;
          break;
      }
      commands.push(c);
    }
    const plan = { commands },
      expected = oracle(plan, target, source),
      actual = partitionSoftwareOverview(plan, target, source);
    assert.deepEqual(actual.unsafe, expected.unsafe, `scene ${scene}`);
    assert.equal(
      actual.unsafeCells,
      expected.unsafe.reduce((sum, value) => sum + value, 0),
    );
    for (const c of commands) {
      assert.equal(actual.classify(c), expected.classify(c), `scene ${scene}`);
      assert.equal(
        actual.classify(c),
        expected.classify(c),
        `cached scene ${scene}`,
      );
    }
  }
});
