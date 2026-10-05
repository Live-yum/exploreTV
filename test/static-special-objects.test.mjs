import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  openWorld,
  Reader,
  decodeRecord,
  getWorldTileAccessor,
} from "../core/world.mjs";
import {
  planStaticSpecialObject,
  STATIC_SPECIAL_OBJECT_TILES,
  STATIC_SPECIAL_OBJECT_ASSETS,
  STATIC_SPECIAL_OBJECT_SNAPSHOT,
} from "../core/static-special-objects.mjs";

const tile = (type, frameX = 0, frameY = 0, extra = {}) => ({
  active: true,
  type,
  frameX,
  frameY,
  shape: 0,
  ...extra,
});
function object(type, style = 0, direction = 0, worldX = 100, worldY = 200) {
  const width = type === 711 ? 2 : 3,
    height = type === 237 || type === 711 ? 2 : 4;
  return {
    rect: { x: worldX, y: worldY, width, height },
    cells: Array.from({ length: width * height }, (_, i) =>
      tile(
        type,
        style * width * 18 + Math.floor(i / height) * 18,
        direction * height * 18 + (i % height) * 18,
      ),
    ),
  };
}
const get = (r, x, y) => r.cells[x * r.rect.height + y];
const one = (r, x = 0, y = 0, options = {}) =>
  planStaticSpecialObject(r, x, y, get(r, x, y), options);
const whole = (r, options = {}) =>
  r.cells.flatMap((t, i) => {
    const result = one(
      r,
      Math.floor(i / r.rect.height),
      i % r.rect.height,
      options,
    );
    assert.equal(result.unsupported, undefined);
    assert.ok(result.commands.length > 0);
    return result.commands;
  });
const role = (commands, name) => commands.filter((c) => c.role === name);
function assertBounds(c) {
  const size = STATIC_SPECIAL_OBJECT_ASSETS[c.asset];
  assert.ok(size, c.asset);
  assert.ok([c.sx, c.sy, c.sw, c.sh].every(Number.isSafeInteger));
  assert.ok(c.sx >= 0 && c.sy >= 0 && c.sw > 0 && c.sh > 0);
  assert.ok(c.sw <= 64 && c.sh <= 64);
  assert.ok(
    c.sx + c.sw <= size[0] && c.sy + c.sh <= size[1],
    JSON.stringify(c),
  );
}

test("special families reject malformed geometry, unrelated IDs and unavailable origins", () => {
  const r = object(237);
  assert.equal(planStaticSpecialObject(r, 0, 0, tile(999)), null);
  assert.match(
    planStaticSpecialObject(null, 0, 0, tile(237)).unsupported,
    /coordinates/,
  );
  for (const frameX of [-18, 1, NaN, null])
    assert.match(
      planStaticSpecialObject(r, 0, 0, tile(237, frameX)).unsupported,
      /saved frames/,
    );
  assert.match(
    planStaticSpecialObject(r, 0, 0, tile(237, 54)).unsupported,
    /unknown/,
  );
  assert.match(
    planStaticSpecialObject(r, 0, 0, tile(237, 0, 0, { shape: 1 })).unsupported,
    /half-block/,
  );
  const fragment = {
    rect: { x: 101, y: 200, width: 1, height: 1 },
    cells: [tile(237, 18)],
  };
  assert.match(one(fragment).unsupported, /origin tile/);
  const pylon = object(597);
  pylon.cells[5] = { active: false };
  assert.match(one(pylon).unsupported, /child tile/);
  const relic = object(617);
  get(relic, 1, 1).frameX += 54;
  assert.match(one(relic).unsupported, /child tile/);
});

test("all 11 pylon and 28 bidirectional relic styles have bounded complete geometry", () => {
  for (const [type, styles, directions] of [
    [597, 11, 1],
    [617, 28, 2],
  ])
    for (let style = 0; style < styles; style++)
      for (let direction = 0; direction < directions; direction++) {
        const r = object(type, style, direction);
        const before = JSON.stringify(r),
          commands = whole(r);
        assert.equal(commands.length, 19);
        assert.equal(role(commands, "body").length, 12);
        assert.equal(
          role(commands, type === 597 ? "pylon-crystal" : "relic-figure")
            .length,
          1,
        );
        const figure = commands.find(
          (c) => c.role.endsWith("crystal") || c.role.endsWith("figure"),
        );
        assert.equal(figure.flipX, type === 617 && direction === 1);
        assert.equal(figure.paintId, 0);
        if (type === 597) {
          assert.deepEqual(
            [figure.sx, figure.sy, figure.sw, figure.sh],
            [(3 + style) * 30, 230, 30, 46],
          );
        } else
          assert.deepEqual(
            [figure.sx, figure.sy, figure.sw, figure.sh],
            [0, style * 50, 50, 50],
          );
        commands.forEach(assertBounds);
        assert.equal(JSON.stringify(r), before);
      }
  assert.deepEqual(STATIC_SPECIAL_OBJECT_SNAPSHOT, {
    globalTime: 0,
    tileFrame: 0,
    tileFrameCounter: 0,
    sunCircle: 0,
    mouseTextColor: 255,
    lighting: "unlit-white",
  });
});

test("altar includes every glow segment and exactly one visible top-middle orb", () => {
  const r = object(237),
    commands = whole(r);
  assert.equal(commands.length, 13);
  assert.equal(role(commands, "altar-glow").length, 6);
  const [orb] = role(commands, "altar-orb");
  assert.deepEqual(
    [orb.sw, orb.sh, orb.offsetX, orb.offsetY],
    [26, 26, -5, -49],
  );
  assert.deepEqual(orb.vertexColor, [255, 255, 255, 0]);
  assert.equal(orb.specialLayer, "over-tiles");
  commands.forEach(assertBounds);
  assert.match(one(r, 0, 0, { mouseTextColor: 256 }).unsupported, /pulse/);
  assert.deepEqual(
    one(r, 1, 0, { mouseTextColor: 190 }).commands.at(-1).vertexColor,
    [190, 190, 190, 0],
  );
});

test("rainbow draws three colored halos only once and point-clamps overflowing bottom rows", () => {
  const r = object(711),
    commands = whole(r);
  assert.equal(commands.length, 28);
  assert.equal(role(commands, "body").length, 4);
  assert.equal(role(commands, "rainbow-halo").length, 24);
  commands.forEach(assertBounds);
  assert.equal(
    commands.filter((c) => c.fidelity === "static-special-point-clamp").length,
    12,
  );
  assert.ok(
    role(commands, "rainbow-halo").every(
      (c) => c.specialLayer === "behind-object",
    ),
  );
  assert.deepEqual(
    one(r, 1, 1).commands.map((c) => [c.sw, c.sh, c.offsetX]),
    [[18, 20, -1]],
  );
  assert.deepEqual(
    [
      ...new Set(
        role(commands, "rainbow-halo").map((c) => c.vertexColor.join()),
      ),
    ],
    ["76,0,0,0", "0,76,0,0", "0,0,76,0"],
  );
  assert.equal(one(r).commands.at(-1).role, "body");
});

test("paint, visibility and coating ownership follow the sampled source tile", () => {
  for (const type of [597, 617]) {
    const r = object(type);
    Object.assign(get(r, 0, 0), { paint: 7 });
    Object.assign(get(r, 1, 1), {
      paint: 13,
      fullbrightBlock: true,
      invisibleBlock: true,
    });
    assert.equal(one(r).commands.length, 1);
    const out = one(r, 0, 0, { revealInvisible: true }).commands;
    assert.equal(out[0].paintId, 7);
    assert.ok(
      out
        .slice(1)
        .every((c) => c.paintId === 0 && c.fullbrightBlock && c.invisibleBlock),
    );
  }
  const b = object(711);
  Object.assign(get(b, 0, 0), { paint: 7, fullbrightBlock: true });
  get(b, 1, 1).paint = 13;
  assert.ok(
    role(whole(b), "rainbow-halo").every(
      (c) => c.paintId === 7 && c.fullbrightBlock,
    ),
  );
  assert.equal(one(b, 1, 1).commands[0].paintId, 13);
  get(b, 0, 0).invisibleBlock = true;
  assert.equal(one(b).commands.length, 1);
  assert.equal(one(b, 0, 0, { revealInvisible: true }).commands.length, 25);
});

test("origin coordinate phases and relative output are invariant under ROI partitioning", () => {
  for (const type of STATIC_SPECIAL_OBJECT_TILES) {
    const r = object(type, 0, 0, 835, 847);
    for (let x = 0; x < r.rect.width; x++)
      for (let y = 0; y < r.rect.height; y++) {
        const fragment = {
          rect: { x: r.rect.x + x, y: r.rect.y + y, width: 1, height: 1 },
          cells: [get(r, x, y)],
          context: r,
        };
        assert.deepEqual(one(fragment), one(r, x, y));
      }
    const outside = {
      rect: { x: r.rect.x, y: r.rect.y - 4, width: 1, height: 1 },
      cells: [{ active: false }],
      context: r,
    };
    assert.deepEqual(
      planStaticSpecialObject(outside, 0, 4, get(r, 0, 0)),
      one(r),
    );
  }
});

const worldPath = new URL("../fixtures/example-world.wld", import.meta.url);
test(
  "actual 8400×2400 map covers every special cell with legal crops and no mutation",
  {
    skip: !existsSync(worldPath),
  },
  () => {
    const bytes = readFileSync(worldPath),
      before = createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      before,
      "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab",
    );
    const world = openWorld(bytes),
      lookup = getWorldTileAccessor(world),
      reader = new Reader(world.bytes, world.sections[2]);
    const counts = {},
      roles = {},
      crops = new Map(),
      objects = [],
      ids = new Set(STATIC_SPECIAL_OBJECT_TILES);
    let totalCommands = 0;
    for (let x = 0; x < world.width; x++) {
      reader.pos = world.columns[x];
      for (let y = 0; y < world.height; ) {
        const record = decodeRecord(reader, world.important),
          t = record.tile;
        if (t.active && ids.has(t.type))
          for (let yy = y; yy <= y + record.repeats; yy++) {
            const r = {
              rect: { x, y: yy, width: 1, height: 1 },
              cells: [t],
              getWorldTile: lookup,
            };
            const result = one(r);
            assert.equal(
              result.unsupported,
              undefined,
              JSON.stringify({ x, y: yy, t, result }),
            );
            assert.ok(result.commands.length > 0);
            counts[t.type] = (counts[t.type] || 0) + 1;
            if (
              t.frameX % (t.type === 711 ? 36 : 54) === 0 &&
              t.frameY % (t.type === 237 || t.type === 711 ? 36 : 72) === 0
            )
              objects.push({
                type: t.type,
                x,
                y: yy,
                frameX: t.frameX,
                frameY: t.frameY,
              });
            for (const c of result.commands) {
              assertBounds(c);
              totalCommands++;
              roles[c.role] = (roles[c.role] || 0) + 1;
              const key = [c.asset, c.sx, c.sy, c.sw, c.sh].join(":");
              crops.set(key, {
                asset: c.asset,
                sx: c.sx,
                sy: c.sy,
                sw: c.sw,
                sh: c.sh,
              });
            }
          }
        y += record.repeats + 1;
      }
    }
    assert.deepEqual(counts, { 237: 6, 597: 48, 617: 24, 711: 20 });
    assert.equal(objects.length, 12);
    assert.equal(totalCommands, 267);
    assert.equal(roles["altar-orb"], 1);
    assert.equal(roles["pylon-crystal"], 4);
    assert.equal(roles["relic-figure"], 2);
    assert.equal(roles["rainbow-halo"], 120);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), before);
    const requiredAssets = Object.entries(STATIC_SPECIAL_OBJECT_ASSETS).map(
      ([asset, pngBounds]) => {
        const used = [...crops.values()].filter((c) => c.asset === asset);
        const filename = [
          new URL(
            `../fixtures/private/static-special-objects/${asset}`,
            import.meta.url,
          ),
          new URL(`../example/assets/${asset}`, import.meta.url),
        ].find(existsSync);
        if (filename) {
          const png = readFileSync(filename);
          assert.deepEqual(
            [png.readUInt32BE(16), png.readUInt32BE(20)],
            pngBounds,
          );
        }
        return {
          asset,
          pngBounds,
          verifiedAsset: !!filename,
          uniqueCrops: used.length,
          minimumWidth: Math.max(...used.map((c) => c.sx + c.sw)),
          minimumHeight: Math.max(...used.map((c) => c.sy + c.sh)),
          crops: used,
        };
      },
    );
    const report = {
      worldSha256: before,
      typeCells: counts,
      objects,
      totalCommands,
      roles,
      uniqueCrops: crops.size,
      requiredAssets,
    };
    if (process.env.EXPLORETV_SPECIAL_CROP_REPORT === "1") {
      mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
      writeFileSync(
        new URL("../artifacts/static-specials-crops.json", import.meta.url),
        JSON.stringify(report, null, 2) + "\n",
      );
    }
    console.log(
      JSON.stringify({
        staticSpecials: {
          typeCells: counts,
          totalCommands,
          uniqueCrops: crops.size,
          objects: objects.length,
        },
      }),
    );
  },
);

test(
  "raw special textures prepare without skipped effects and retain exact ROI edge pixels",
  {
    skip: !Object.keys(STATIC_SPECIAL_OBJECT_ASSETS).every((name) =>
      existsSync(
        new URL(
          `../example/assets/${name}`,
          import.meta.url,
        ),
      ),
    ),
  },
  async () => {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const { registerTextureSource } = await import("../core/assets.mjs");
    const { decodePngRgba } = await import("../core/png-rgba.mjs");
    const { prepareSceneFrames } = await import("../core/scene-frames.mjs");
    const { renderScene } = await import("../core/renderer.mjs");
    const assets = new Map();
    for (const name of Object.keys(STATIC_SPECIAL_OBJECT_ASSETS)) {
      const bytes = readFileSync(
        new URL(
          `../example/assets/${name}`,
          import.meta.url,
        ),
      );
      assets.set(
        name,
        registerTextureSource(await loadImage(bytes), {
          pngBytes: bytes,
          rawRgba: decodePngRgba(bytes),
        }),
      );
    }
    function render(rect, ob) {
      const lookup = (wx, wy) => get(ob, wx - ob.rect.x, wy - ob.rect.y);
      // Unlike the tiny get() helper, this lookup must reject out-of-object cells.
      const boundedLookup = (wx, wy) =>
        wx < ob.rect.x ||
        wy < ob.rect.y ||
        wx >= ob.rect.x + ob.rect.width ||
        wy >= ob.rect.y + ob.rect.height
          ? { active: false }
          : lookup(wx, wy);
      const r = {
        rect,
        cells: Array.from({ length: rect.width * rect.height }, (_, i) =>
          boundedLookup(
            rect.x + Math.floor(i / rect.height),
            rect.y + (i % rect.height),
          ),
        ),
        getWorldTile: boundedLookup,
      };
      const behind = [],
        ordinary = [],
        over = [];
      for (let x = -4; x < rect.width + 4; x++)
        for (let y = -4; y < rect.height + 4; y++) {
          const t = boundedLookup(rect.x + x, rect.y + y);
          if (!t.active) continue;
          const out = planStaticSpecialObject(r, x, y, t);
          assert.equal(out.unsupported, undefined);
          for (const c of out.commands) {
            const cmd = {
              kind: "tile",
              ...c,
              dx: x * 16 + c.offsetX,
              dy: y * 16 + c.offsetY,
              dw: c.sw,
              dh: c.sh,
            };
            if (
              cmd.dx + cmd.dw <= 0 ||
              cmd.dy + cmd.dh <= 0 ||
              cmd.dx >= rect.width * 16 ||
              cmd.dy >= rect.height * 16
            )
              continue;
            (c.specialLayer === "over-tiles"
              ? over
              : c.specialLayer === "behind-object"
                ? behind
                : ordinary
            ).push(cmd);
          }
        }
      const plan = {
        width: rect.width * 16,
        height: rect.height * 16,
        commands: [...behind, ...ordinary, ...over],
        warnings: [],
      };
      const frames = prepareSceneFrames(plan, assets, createCanvas, {
        inputEncoding: "tconvert-game-raw",
        opaqueScene: true,
      });
      assert.equal(frames.support.unsupportedCommands, 0);
      const canvas = createCanvas(plan.width, plan.height),
        ctx = canvas.getContext("2d");
      const result = renderScene(ctx, plan, assets, {
        strict: true,
        sceneFrames: frames,
      });
      assert.equal(result.skippedEffects, 0);
      frames.dispose();
      return { canvas, ctx };
    }
    for (const type of STATIC_SPECIAL_OBJECT_TILES) {
      const ob = object(
        type,
        type === 597 ? 10 : type === 617 ? 27 : 0,
        type === 617 ? 1 : 0,
        100,
        200,
      );
      const big = { x: 96, y: 196, width: 12, height: 12 },
        full = render(big, ob);
      for (const narrow of [
        { x: 100, y: 196, width: 3, height: 4 }, // Includes the orb above an entirely absent owner.
        { x: 99, y: 199, width: 1, height: 6 }, // Left halo with owner to the right.
        { x: 101, y: 201, width: 1, height: 1 }, // Middle cell, origin in context.
        { x: 100, y: 204, width: 3, height: 1 }, // Body overflow from owner above.
      ]) {
        const part = render(narrow, ob);
        assert.deepEqual(
          part.ctx.getImageData(0, 0, narrow.width * 16, narrow.height * 16)
            .data,
          full.ctx.getImageData(
            (narrow.x - big.x) * 16,
            (narrow.y - big.y) * 16,
            narrow.width * 16,
            narrow.height * 16,
          ).data,
          `ROI clipping differs for ${type} at ${narrow.x},${narrow.y}`,
        );
      }
    }
  },
);
