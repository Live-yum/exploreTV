import test from "node:test";
import assert from "node:assert/strict";
import { planScene } from "../core/renderer.mjs";
import { classifyTileDrawLayer } from "../core/static-waterfalls.mjs";
const air = { active: false, type: 0, shape: 0, liquid: 0, wall: 0 };
const tile = (type, extra = {}) => ({
  ...air,
  active: true,
  type,
  frameX: 0,
  frameY: 0,
  ...extra,
});
const waterfall = {
  kind: "waterfall",
  asset: "Waterfall_0.png",
  sx: 0,
  sy: 0,
  sw: 16,
  sh: 16,
  dx: 0,
  dy: 0,
  dw: 16,
  dh: 16,
  x: 0,
  y: 0,
};
const registry = {
  model: "fresh-static",
  scanComplete: true,
  failures: [],
  hasOrigin: () => false,
  commandsFor: () => [waterfall],
};
const options = {
  liquids: { enabled: true, layer: "foreground", waterfallRegistry: registry },
};
test("source raw draw layers place waterfalls after non-solids and before solids", () => {
  const r = {
    rect: { x: 100, y: 100, width: 2, height: 1 },
    cells: [tile(1), tile(33)],
    source: { worldSurface: 300 },
  };
  const p = planScene(r, options),
    i = p.commands.findIndex((c) => c.kind === "waterfall");
  assert.ok(i > 0);
  assert.ok(p.commands.slice(0, i).every((c) => c.ownerType === 33));
  assert.ok(p.commands.slice(i + 1).every((c) => c.ownerType === 1));
  assert.equal(p.support.waterfalls.commands, 1);
  assert.ok(p.requiredAssets.includes("Waterfall_0.png"));
  assert.throws(
    () => planScene(r, { ...options, maxCommands: p.commands.length - 1 }),
    /command budget/,
  );
});
test("draw layer uses owner type rather than an attached rope sprite material", () => {
  assert.equal(classifyTileDrawLayer(380), "solid");
  assert.equal(classifyTileDrawLayer(213), "non-solid");
  assert.equal(classifyTileDrawLayer(11), "solid");
  assert.equal(classifyTileDrawLayer(379), undefined);
  const r = {
    rect: { x: 100, y: 700, width: 3, height: 10 },
    cells: Array.from({ length: 30 }, () => air),
    source: { worldSurface: 300 },
  };
  const put = (x, y, t) => (r.cells[x * 10 + y] = t);
  put(1, 5, tile(380, { frameX: 54 }));
  put(1, 4, tile(380, { frameX: 54 }));
  put(1, 3, tile(213, { frameX: null, frameY: null }));
  put(1, 6, tile(365, { frameX: null, frameY: null }));
  const p = planScene(r, options),
    fall = p.commands.findIndex((c) => c.kind === "waterfall");
  const rope = p.commands.findIndex(
    (c) => c.role === "planter-back-rope" && c.y === 5,
  );
  assert.ok(rope > fall);
  assert.equal(p.commands[rope].type, 213);
  assert.equal(p.commands[rope].ownerType, 380);
});
test("registry failure remains visible and absent registry preserves original path", () => {
  const r = {
    rect: { x: 100, y: 100, width: 1, height: 1 },
    cells: [tile(1)],
    source: { worldSurface: 300 },
  };
  const p = planScene(r, {
    liquids: {
      enabled: true,
      waterfallRegistry: {
        ...registry,
        scanComplete: false,
        failures: [{ reason: "missing-context" }],
      },
    },
  });
  assert.ok(p.warnings.some((w) => w.includes("unresolved dependencies")));
  assert.equal(
    planScene(r).commands.some((c) => c.kind === "waterfall"),
    false,
  );
  assert.throws(
    () => planScene(r, { liquids: { enabled: true, waterfallRegistry: {} } }),
    /Invalid waterfall registry/,
  );
});
