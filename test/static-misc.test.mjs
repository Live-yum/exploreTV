import test from "node:test";
import assert from "node:assert/strict";
import {
  planStaticMisc,
  staticTrackRectangle,
  SOURCE_HIDDEN_TILES,
} from "../core/static-misc.mjs";

const tile = (type, frameX = 0, frameY = 0, extra = {}) => ({
  active: true,
  type,
  frameX,
  frameY,
  shape: 0,
  ...extra,
});
const region = (width = 3, height = 3) => ({
  rect: { x: 100, y: 600, width, height },
  cells: Array(width * height).fill(null),
});
const one = (t, reg = region(), x = 0, y = 0) => planStaticMisc(reg, x, y, t);

test("only source-proven particle emitters are hidden without requiring an atlas", () => {
  for (const id of SOURCE_HIDDEN_TILES) {
    const result = one(tile(id));
    assert.deepEqual(result.commands, []);
    assert.equal(result.hidden, true);
    assert.equal(result.fidelity, "source-hidden");
    assert.equal(result.reason, "particle-emitter-without-tile-body");
  }
  assert.equal(one(tile(372)), null);
  assert.equal(one(tile(376)), null);
});

test("detritus, beehives and cactus preserve segment framing and distinct zero-wind offsets", () => {
  for (const [id, x, y, offsetY] of [
    [233, 414, 54, 2],
    [444, 18, 18, -2],
    [484, 18, 18, 0],
  ]) {
    const c = one(tile(id, x, y)).commands[0];
    assert.deepEqual(
      [c.sx, c.sy, c.sw, c.sh, c.offsetY],
      [x, y, 16, 16, offsetY],
    );
  }
});

test("plant height and mirroring use absolute world position", () => {
  for (const id of [3, 24, 61, 71, 110, 201, 637, 703, 20]) {
    const a = one(tile(id, 54, 0)).commands[0];
    assert.equal(a.sh, id === 20 ? 18 : 20);
    assert.equal(a.flipX, true);
    assert.equal(one(tile(id, 54, 0), region(), 1, 0).commands[0].flipX, false);
    assert.equal(a.offsetY, 0);
  }
});

test("antlion larvae retain coordinate-dependent animation phase at time zero", () => {
  const a = one(tile(485, 72, 18)).commands[0];
  assert.equal(a.sy, 126);
  assert.equal(a.offsetY, 2);
  const reg = region();
  reg.rect.x = 99;
  assert.deepEqual(one(tile(485, 72, 18), reg, 1, 0).commands[0], a);
  const next = one(tile(485, 90, 18), region(), 1, 0).commands[0];
  assert.equal(next.sy, a.sy);
});

test("crystals retain premultiplied glow color and four attachment offsets", () => {
  for (const [fy, dx, dy] of [
    [0, 0, 2],
    [18, 0, -2],
    [36, 2, 0],
    [54, -2, 0],
  ]) {
    const result = one(tile(129, 18, fy));
    assert.equal(result.commands.length, 1);
    assert.deepEqual(
      [result.commands[0].offsetX, result.commands[0].offsetY],
      [dx, dy],
    );
    assert.deepEqual(result.commands[0].vertexColor, [255, 255, 255, 100]);
    assert.equal(result.commands[0].opacity, 1);
  }
});

test("shimmer crystals draw four offset halo crops then their static center", () => {
  const result = one(tile(129, 414, 0));
  assert.equal(result.commands.length, 5);
  assert.deepEqual(
    result.commands.map((c) => [c.sx, c.sy, c.offsetX, c.offsetY]),
    [
      [414, 72, 2, 2],
      [414, 72, 0, 4],
      [414, 72, -2, 2],
      [414, 72, 0, 0],
      [414, 0, 0, 2],
    ],
  );
  for (const c of result.commands.slice(0, 4)) {
    assert.equal(c.vertexColor[3], 38);
    assert.ok(c.vertexColor.slice(0, 3).every((v) => v >= 0 && v <= 76));
  }
  const sameWorld = region();
  sameWorld.rect.x = 99;
  assert.deepEqual(one(tile(129, 414, 0), sameWorld, 1, 0), result);
});

test("minecart values are track indices, with ordered front/back and downward continuation sprites", () => {
  const result = one(tile(314, 8, 9));
  assert.deepEqual(
    result.commands.map((c) => [c.sx, c.sy, c.offsetY, c.role]),
    [
      [18, 54, 0, "track-back"],
      [0, 54, 0, "track-front"],
      [0, 108, 16, "track-left-foot"],
      [18, 108, 16, "track-right-foot"],
    ],
  );
  assert.deepEqual(
    one(tile(314, 2, -1)).commands.map((c) => [c.sx, c.sy, c.offsetY]),
    [
      [36, 18, 0],
      [0, 126, -16],
    ],
  );
  assert.deepEqual(
    one(tile(314, 24, -1)).commands.map((c) => [c.sx, c.sy, c.offsetY]),
    [
      [36, 36, 0],
      [18, 126, -16],
    ],
  );
  assert.deepEqual(staticTrackRectangle(21), {
    sx: 18,
    sy: 72,
    sw: 16,
    sh: 16,
  });
  assert.deepEqual(staticTrackRectangle(35), {
    sx: 126,
    sy: 54,
    sw: 16,
    sh: 16,
  });
});

test("track switch paint preserves the source's asymmetric nonshared-connection rule", () => {
  const r = region(),
    t = tile(314, 4, 5, { paint: 7 });
  r.cells[7] = tile(314, 1, -1, { paint: 12 }); // right same row, no corresponding left paint
  r.cells[1] = tile(314, 1, -1, { paint: 2 }); // left same row for the back route
  const result = one(t, r, 1, 1);
  assert.equal(
    result.commands.find((c) => c.role === "track-front").paintId,
    7,
  );
  assert.equal(result.commands.find((c) => c.role === "track-back").paintId, 2);
  const t2 = tile(314, 1, 5, { paint: 7 });
  r.cells[8] = tile(314, 1, -1, { paint: 18, inactive: true });
  const shared = one(t2, r, 1, 1);
  assert.equal(
    shared.commands.find((c) => c.role === "track-front").paintId,
    12,
  );
  assert.equal(
    shared.commands.find((c) => c.role === "track-back").paintId,
    18,
  );
});

test("a track over a continuous rope draws the upper rope's texture and paint first", () => {
  const r = region(3, 13);
  r.cells = r.cells.map(() => tile(1, null, null));
  r.cells[13 + 3] = tile(353, null, null, { paint: 9 });
  r.cells[13 + 9] = tile(213, null, null, { paint: 4 });
  const t = tile(314, 1, -1);
  r.cells[13 + 6] = t;
  const snapshot = JSON.stringify(r);
  const result = one(t, r, 1, 6);
  assert.equal(result.commands[0].asset, "Tiles_353.png");
  assert.equal(result.commands[0].type, 353);
  assert.equal(result.commands[0].paintId, 9);
  assert.deepEqual([result.commands[0].sx, result.commands[0].sy], [90, 36]);
  assert.equal(result.commands[1].role, "track-front");
  assert.equal(JSON.stringify(r), snapshot);
  r.cells[13 + 5] = tile(1, null, null, { active: false });
  assert.equal(one(t, r, 1, 6).commands[0].role, "track-front");
});

test("malformed track indices, crystal attachments and saved frames are explicit failures", () => {
  for (const [fx, fy] of [
    [-1, -1],
    [36, -1],
    [1, -2],
    [1, 36],
    [1.5, -1],
  ])
    assert.match(one(tile(314, fx, fy)).unsupported, /indices/);
  assert.equal(staticTrackRectangle(40), null);
  assert.equal(staticTrackRectangle(-1), null);
  assert.match(one(tile(129, 1, 0)).unsupported, /alignment/);
  assert.match(one(tile(129, 0, 72)).unsupported, /attachment/);
  assert.match(one(tile(233, null, null)).unsupported, /saved frame/);
  assert.match(one(tile(484, 0, 0, { shape: 1 })).unsupported, /sloped/);
});
