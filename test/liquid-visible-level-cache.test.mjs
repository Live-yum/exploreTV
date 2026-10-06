import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createVisibleLiquidSampler } from "../core/liquid-visible-level.mjs";
import { planLiquids } from "../core/liquid.mjs";

// Keep the previous string/has/get cache as an independent oracle while using
// the same source equations. This checks every returned command and rejection,
// rather than assuming that equality of a few packed keys proves fidelity.
const moduleUrl = new URL("../core/liquid-visible-level.mjs", import.meta.url);
const source = readFileSync(moduleUrl, "utf8");
const oldMemo = `  const memo = (compute) => {
    const cache = new Map();
    return (x, y) => {
      const key = \`\${x},\${y}\`;
      if (cache.has(key)) {
        const value = cache.get(key);
        if (value instanceof Unsupported) throw value;
        return value;
      }
      if (++depth > 384) {
        depth--;
        reject("visible-dependency-depth");
      }
      try {
        const value = compute(x, y);
        cache.set(key, value);
        return value;
      } catch (error) {
        if (error instanceof Unsupported && error.reason !== "visible-dependency-depth")
          cache.set(key, error);
        throw error;
      } finally {
        depth--;
      }
    };
  };`;
const referenceSource = source.replace(
  /^  const memo = \(compute\) => \{[\s\S]*?^  \};/m,
  () => oldMemo,
);
assert.notEqual(
  referenceSource,
  source,
  "legacy cache oracle must be installed",
);
const referenceUrl = `data:text/javascript;base64,${Buffer.from(referenceSource).toString("base64")}`;
const { createVisibleLiquidSampler: referenceSampler } = await import(
  referenceUrl
);
const liquidUrl = new URL("../core/liquid.mjs", import.meta.url);
const referenceLiquidSource = readFileSync(liquidUrl, "utf8").replace(
  /from "(\.\/[^\"]+)"/g,
  (_, path) =>
    `from ${JSON.stringify(path === "./liquid-visible-level.mjs" ? referenceUrl : new URL(path, liquidUrl).href)}`,
);
const { planLiquids: referencePlan } = await import(
  `data:text/javascript;base64,${Buffer.from(referenceLiquidSource).toString("base64")}`
);

const empty = Object.freeze({ active: false, liquid: 0, shape: 0 });
const solid = Object.freeze({ active: true, type: 1, liquid: 0, shape: 0 });
const wet = (liquid = 255, extra = {}) =>
  Object.freeze({ ...empty, liquid, liquidKind: 1, ...extra });
const options = {
  enabled: true,
  worldSurface: 300,
  isSolid: (t) => t.type === 1,
};

function region(x, y, width, height, read) {
  return {
    rect: { x, y, width, height },
    cells: Array.from({ length: width * height }, (_, i) =>
      read(x + Math.floor(i / height), y + (i % height)),
    ),
    getWorldTile: read,
  };
}

function compareQueries(input, queries, opts = options) {
  const current = createVisibleLiquidSampler(input, opts);
  const previous = referenceSampler(input, opts);
  for (const [x, y] of [...queries, ...queries.toReversed(), ...queries]) {
    assert.equal(
      JSON.stringify(current(x, y)),
      JSON.stringify(previous(x, y)),
      `${x},${y}`,
    );
  }
}

test("numeric liquid memo preserves byte-exact states across packed-range boundaries", () => {
  for (const [ox, oy] of [
    [0, 0],
    [32765, 32765],
    [32768, 32768],
    [65535, 65535],
    [Number.MAX_SAFE_INTEGER - 64, Number.MAX_SAFE_INTEGER - 64],
  ]) {
    const read = (x, y) => {
      const dx = x - ox,
        dy = y - oy;
      if (dy < -1 || dy > 5 || dx < -1 || dx > 5) return solid;
      if ((dx + 2 * dy) % 7 === 0)
        return wet(127, { active: true, type: 1, shape: 1, wall: 1 });
      if ((dx + dy) % 4 === 0) return empty;
      return wet((Math.abs(dx * 19 + dy * 37) % 254) + 1);
    };
    const input = region(ox, oy, 5, 5, read);
    const before = JSON.stringify(input);
    const queries = Array.from({ length: 49 }, (_, i) => [
      ox + Math.floor(i / 7) - 1,
      oy + (i % 7) - 1,
    ]);
    compareQueries(input, queries);
    assert.equal(JSON.stringify(input), before);
  }
});

test("large and negative coordinates never alias numeric keys or each other", () => {
  const positions = [
    [0, 32768],
    [1, 0],
    [0, -1],
    [-1, 32767],
    [32768, 5],
    [131072, 5],
    [0, 5],
    [1, 65535],
    [2, 32767],
    [Number.MAX_SAFE_INTEGER - 1, 52],
    [Number.MIN_SAFE_INTEGER + 1, 52],
  ];
  const cells = new Map(
    positions.map(([x, y], i) => [`${x},${y}`, wet(17 + i * 19)]),
  );
  const read = (x, y) => cells.get(`${x},${y}`) ?? solid;
  compareQueries(region(10, 10, 1, 1, read), positions);
});

test("single cache lookup retains cached failures, independent samplers and depth protection", () => {
  for (const invalid of [
    wet(256),
    wet(255, { shape: 6 }),
    wet(255, { liquidKind: 8 }),
    wet(255, { active: true, type: 379 }),
    wet(255, { active: true, type: 999 }),
  ]) {
    const read = (x, y) => (x === 100 && y === 100 ? invalid : solid);
    compareQueries(
      region(100, 100, 1, 1, read),
      [
        [100, 100],
        [103, 103],
      ],
      { ...options, isSolid: (t) => (t.type === 1 ? true : undefined) },
    );
  }
  const missing = {
    rect: { x: 100, y: 100, width: 1, height: 1 },
    cells: [wet()],
  };
  compareQueries(missing, [[100, 100]]);
  const unbounded = (x) => (x === 100 ? wet(1) : empty);
  compareQueries(region(100, 100, 1, 1, unbounded), [[100, 100]]);
  const full = createVisibleLiquidSampler(
    region(100, 100, 1, 1, () => wet()),
    options,
  );
  const dry = createVisibleLiquidSampler(
    region(100, 100, 1, 1, () => solid),
    options,
  );
  assert.ok(full(100, 100).command);
  assert.equal(dry(100, 100).occluded, true);
  for (const value of [
    NaN,
    Infinity,
    -Infinity,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    "100",
    null,
  ]) {
    assert.throws(() => full(value, 100), /Invalid visible-liquid coordinate/);
    assert.throws(() => full(100, value), /Invalid visible-liquid coordinate/);
  }
});

test("liquid planner commands, assets and all support diagnostics match the previous cache", () => {
  for (const origin of [100, 32765]) {
    const read = (x, y) => {
      const dx = x - origin,
        dy = y - origin;
      if (dx < 0 || dy < 0 || dx >= 12 || dy >= 12) return solid;
      if (dx % 4 === 0)
        return wet(127, { active: true, type: 1, shape: 1, wall: 1 });
      if (dx % 4 === 1) return wet(dy % 3 === 0 ? 1 : 255);
      return dy % 5 === 0 ? empty : wet(127);
    };
    const input = region(origin, origin, 12, 12, read);
    for (const layer of ["background", "foreground"]) {
      const opts = {
        ...options,
        layer,
        frame: 3,
        waterfallFrame: 7,
        waterfallRegistry: { hasOrigin: () => false },
      };
      const actual = planLiquids(input, opts);
      const expected = referencePlan(input, opts);
      assert.equal(JSON.stringify(actual), JSON.stringify(expected));
      assert.ok(actual.support.visibleLevelDrawn > 0);
    }
  }
});
