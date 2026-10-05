import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { openWorld, extractRegion } from "../core/world.mjs";
import { decodePngRgba } from "../core/png-rgba.mjs";
import { fixtureWorld, record } from "../test/fixture.mjs";

const origin = "http://127.0.0.1:4174";
const worldBytes = Buffer.from(
  fixtureWorld({
    width: 8400,
    height: 2400,
    name: "Synthetic full-detail world",
    columns: Array.from({ length: 8400 }, (_, x) => [
      record({
        type: x === 4500 ? 300 : x >= 8200 && x < 8230 ? 2 : x % 2,
        frame: x === 4500 ? [0, 0] : null,
        repeats: 2399,
      }),
    ]),
  }).bytes,
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function atlas(type) {
  const png = new PNG({ width: 288, height: 128 });
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const index = (y * png.width + x) * 4;
      png.data.set([x % 256, y % 256, type ? 200 : 30, 255], index);
    }
  return PNG.sync.write(png);
}
const images = new Map([
  ["Tiles_0.png", atlas(0)],
  ["Tiles_1.png", atlas(1)],
  ["Tiles_6.png", atlas(6)],
]);
const manifest = {
  schemaVersion: 1,
  inputEncoding: "tconvert-game-raw",
  world: { sha256: hash(worldBytes) },
  textures: [...images].map(([file, bytes]) => ({
    file,
    bytes: bytes.length,
    sha256: hash(bytes),
    width: 288,
    height: 128,
  })),
};
async function routes(page, { delay = 0 } = {}) {
  const fetched = [];
  await page.route("**/fixtures/example-world.wld", (route) =>
    route.fulfill({
      body: worldBytes,
      contentType: "application/octet-stream",
    }),
  );
  await page.route("**/example/asset-manifest.json", (route) =>
    route.fulfill({ json: manifest }),
  );
  await page.route("**/example/assets/*.png", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    fetched.push(name);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const body = images.get(name);
    await route.fulfill(
      body ? { body, contentType: "image/png" } : { status: 404 },
    );
  });
  return fetched;
}
async function state(page) {
  return page
    .locator("#viewport")
    .evaluate((element) => ({ ...element.dataset }));
}
async function settled(page, after = null) {
  await expect
    .poll(async () => {
      const value = await state(page);
      return (
        value.busy === "false" &&
        value.revision &&
        (after === null || Number(value.revision) > Number(after))
      );
    })
    .toBeTruthy();
  return state(page);
}
async function jump(page, x, y) {
  const previous = await state(page);
  await page.locator("#tile-x").fill(String(x));
  await page.locator("#tile-y").fill(String(y));
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  return settled(page, previous.revision);
}
test("full detail camera pans, anchors zoom, reaches far edges, and shows omissions under fixed budgets", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fetched = await routes(page);
  await page.goto(origin);
  await page.getByRole("button", { name: "打开示例世界", exact: true }).click();
  const initial = await settled(page);
  expect(initial.worldWidth).toBe("8400");
  expect(initial.worldHeight).toBe("2400");
  expect(initial.zoom).toBe("1");
  expect(Number(initial.unsupported)).toBeGreaterThan(0);
  expect(fetched.sort()).toEqual(["Tiles_0.png", "Tiles_1.png"]);
  const backing = await page.locator("#world-canvas").evaluate((element) => ({
    width: element.width,
    height: element.height,
    cssWidth: element.getBoundingClientRect().width,
    cssHeight: element.getBoundingClientRect().height,
    pixel: [...element.getContext("2d").getImageData(2, 2, 1, 1).data],
  }));
  expect(backing.width).toBe(Math.floor(backing.cssWidth));
  expect(backing.height).toBe(Math.floor(backing.cssHeight));
  const wx = Math.floor(Number(initial.cameraX) + 2),
    wy = Math.floor(Number(initial.cameraY) + 2);
  expect(backing.pixel).toEqual([
    90 + (wx % 16),
    wy % 16,
    Math.floor(wx / 16) % 2 ? 200 : 30,
    255,
  ]);
  const box = await page.locator("#viewport").boundingBox();
  await page.mouse.move(box.x + 200, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + 296, box.y + 214, { steps: 5 });
  await page.mouse.up();
  const dragged = await settled(page, initial.revision);
  expect(Number(dragged.cameraX)).toBeCloseTo(Number(initial.cameraX) - 96, 5);
  expect(Number(dragged.cameraY)).toBeCloseTo(Number(initial.cameraY) - 64, 5);
  const requestedAnchor = { x: 231, y: 181 };
  await page.locator("#viewport").evaluate((element) => {
    element.addEventListener(
      "wheel",
      (event) => {
        const bounds = element.getBoundingClientRect();
        element.dataset.testWheelAnchor = JSON.stringify({
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        });
      },
      { capture: true, once: true },
    );
  });
  await page.mouse.move(box.x + requestedAnchor.x, box.y + requestedAnchor.y);
  await page.mouse.wheel(0, -200);
  const zoomed = await settled(page, dragged.revision);
  // Chromium quantizes wheel client coordinates. A fractional DOM top means
  // the delivered local anchor need not equal the mouse.move request exactly.
  const anchor = JSON.parse(zoomed.testWheelAnchor);
  expect(Math.abs(anchor.x - requestedAnchor.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(anchor.y - requestedAnchor.y)).toBeLessThanOrEqual(1);
  expect(Number(zoomed.zoom)).toBeGreaterThan(1);
  expect(Number(zoomed.cameraX) + anchor.x / Number(zoomed.zoom)).toBeCloseTo(
    Number(dragged.cameraX) + anchor.x,
    5,
  );
  expect(Number(zoomed.cameraY) + anchor.y / Number(zoomed.zoom)).toBeCloseTo(
    Number(dragged.cameraY) + anchor.y,
    5,
  );
  await page.locator("#zoom-reset").click();
  await settled(page, zoomed.revision);
  const far = await jump(page, 8399, 2399),
    farRect = JSON.parse(far.roi),
    farContext = JSON.parse(far.context);
  expect(farRect.x + farRect.width).toBe(8400);
  expect(farRect.y + farRect.height).toBe(2400);
  expect(farContext.x + farContext.width).toBe(8400);
  expect(farContext.y + farContext.height).toBe(2400);
  const missing = await jump(page, 8210, 1600);
  expect(Number(missing.omissions)).toBeGreaterThan(0);
  await expect(page.locator("#diagnostic-text")).toContainText(
    "Missing textures: Tiles_2.png",
  );
  await expect(page.locator("#coverage-summary")).toContainText("个单元有缺项");
  expect(Number(missing.decodedTiles)).toBeLessThanOrEqual(65536);
  expect(Number(missing.cachePeakBytes)).toBeLessThanOrEqual(48 * 1024 * 1024);
  expect(Number(missing.canvasPixels)).toBeLessThanOrEqual(1920 * 1024);
  await page.screenshot({
    path: `artifacts/world-viewer-synthetic-${testInfo.project.name}.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("newer navigation wins delayed texture loads; repeated import and max screen stay bounded", async ({
  page,
}) => {
  await routes(page, { delay: 180 });
  await page.goto(origin);
  await page.getByRole("button", { name: "打开示例世界", exact: true }).click();
  await expect(page.locator("#world-title")).toHaveText(
    "Synthetic full-detail world",
  );
  await page.locator("#tile-x").fill("100");
  await page.locator("#tile-y").fill("120");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await page.locator("#tile-x").fill("8300");
  await page.locator("#tile-y").fill("2200");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  const final = await settled(page);
  expect(JSON.parse(final.roi).x).toBeGreaterThan(8200);
  expect(JSON.parse(final.roi).y).toBeGreaterThan(2100);
  const revision = final.revision;
  await page.waitForTimeout(500);
  expect((await state(page)).revision).toBe(revision);
  await page.setViewportSize({ width: 3000, height: 1900 });
  await settled(page, revision);
  const box = await page.locator("#viewport").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.wheel(0, 10000);
  await expect.poll(async () => (await state(page)).zoom).toBe("0.5");
  const bounded = await settled(page);
  expect(Number(bounded.decodedTiles)).toBeLessThanOrEqual(65536);
  expect(Number(bounded.canvasPixels)).toBeLessThanOrEqual(1920 * 1024);
  await page.locator("#world-file").setInputFiles({
    name: "again.wld",
    mimeType: "application/octet-stream",
    buffer: worldBytes,
  });
  const imported = await settled(page, bounded.revision);
  expect(imported.zoom).toBe("1");
  await expect(page.locator("#diagnostic-text")).toContainText(
    "Missing textures:",
  );
  await page
    .locator("#texture-files")
    .setInputFiles(
      [...images]
        .filter(([name]) => name !== "Tiles_6.png")
        .map(([name, buffer]) => ({ name, buffer, mimeType: "image/png" })),
    );
  const restored = await settled(page, imported.revision);
  expect(Number(restored.drawn)).toBeGreaterThan(0);
  await expect(page.locator("#diagnostic-text")).not.toContainText(
    "Missing textures:",
  );
});
test("bundled authorized example opens native building detail and reaches the real world edge", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole("button", { name: "打开示例世界", exact: true }).click();
  await expect
    .poll(async () => (await state(page)).drawn, { timeout: 60000 })
    .toBeTruthy();
  const initial = await settled(page);
  expect(initial.worldWidth).toBe("8400");
  expect(initial.worldHeight).toBe("2400");
  expect(initial.zoom).toBe("1");
  expect(Number(initial.drawn)).toBeGreaterThan(100);
  expect(Number(initial.fetchedAssets)).toBeGreaterThan(0);
  expect(Number(initial.fetchedAssets)).toBeLessThan(160);
  await expect(page.locator("#diagnostic-text")).not.toContainText(
    "Missing textures:",
  );
  await expect(page.locator("#diagnostic-text")).not.toContainText(
    "SHA-256 与清单不符",
  );
  // Capture before the oracle so a failure still leaves the exact visible scene.
  await page.screenshot({
    path: `artifacts/world-viewer-example-building-${testInfo.project.name}.png`,
    fullPage: true,
  });
  const exampleWorld = openWorld(await readFile("fixtures/example-world.wld"));
  const samples = [];
  // Known example furniture: a platform, the top of a chair, and a workbench.
  // Compare every opaque source pixel against its saved WLD frame directly.
  // This checks real artwork/cropping, independent of the viewer's planner and
  // without assuming that this dark, sparse scene has an arbitrary color count.
  for (const [x, y, type] of [
    [4460, 488, 19],
    [4513, 499, 15],
    [4514, 500, 18],
  ]) {
    const tile = extractRegion(exampleWorld, { x, y, width: 1, height: 1 })
      .cells[0];
    expect(tile.active).toBe(true);
    expect(tile.type).toBe(type);
    expect(tile.paint).toBe(0);
    expect(tile.shape).toBe(0);
    expect(tile.invisibleBlock).toBe(false);
    const atlas = decodePngRgba(
      await readFile(`example/assets/Tiles_${type}.png`),
    );
    const before = samples.length;
    for (let v = 0; v < 16; v++)
      for (let u = 0; u < 16; u++) {
        const offset = ((tile.frameY + v) * atlas.width + tile.frameX + u) * 4;
        const expected = [...atlas.data.subarray(offset, offset + 4)];
        // Full alpha removes backend-dependent premultiplication/blend rounding.
        if (expected[3] !== 255) continue;
        samples.push({
          x: Math.floor(x * 16 + u - Number(initial.cameraX)),
          y: Math.floor(y * 16 + v - Number(initial.cameraY)),
          expected,
        });
      }
    expect(samples.length).toBeGreaterThan(before);
  }
  const actual = await page
    .locator("#world-canvas")
    .evaluate((element, points) => {
      const context = element.getContext("2d");
      return points.map((point) => {
        if (
          point.x < 0 ||
          point.y < 0 ||
          point.x >= element.width ||
          point.y >= element.height
        )
          throw new Error("Known scene sample is outside the current viewport");
        return [...context.getImageData(point.x, point.y, 1, 1).data];
      });
    }, samples);
  expect(actual).toEqual(samples.map((point) => point.expected));
  const previous = initial.revision;
  await page.locator("#tile-x").fill("8399");
  await page.locator("#tile-y").fill("2399");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await expect
    .poll(
      async () => {
        const value = await state(page);
        return (
          value.busy === "false" && Number(value.revision) > Number(previous)
        );
      },
      { timeout: 60000 },
    )
    .toBeTruthy();
  const far = await state(page),
    rect = JSON.parse(far.roi);
  expect(rect.x + rect.width).toBe(8400);
  expect(rect.y + rect.height).toBe(2400);
  expect(Number(far.decodedTiles)).toBeLessThanOrEqual(65536);
  expect(Number(far.cachePeakBytes)).toBeLessThanOrEqual(48 * 1024 * 1024);
  expect(Number(far.canvasPixels)).toBeLessThanOrEqual(1920 * 1024);
  expect(errors).toEqual([]);
});

test("real forest loads separate crowns and branches at native detail", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const treeRequests = new Set();
  page.on("request", (r) => {
    const name = r.url().split("/").pop();
    if (/^(Tree_(Tops|Branches)_|Flame_)/.test(name)) treeRequests.add(name);
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "打开示例世界", exact: true }).click();
  await expect
    .poll(async () => (await state(page)).drawn, { timeout: 60000 })
    .toBeTruthy();
  const first = await settled(page);
  await page.locator("#tile-x").fill("4422");
  await page.locator("#tile-y").fill("229");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await expect
    .poll(
      async () => {
        const s = await state(page);
        return (
          s.busy === "false" && Number(s.revision) > Number(first.revision)
        );
      },
      { timeout: 60000 },
    )
    .toBeTruthy();
  const current = await state(page);
  expect(current.zoom).toBe("1");
  expect(Number(current.cachePeakBytes)).toBeLessThanOrEqual(48 * 1024 * 1024);
  expect(treeRequests.has("Tree_Tops_10.png")).toBe(true);
  expect(treeRequests.has("Tree_Branches_10.png")).toBe(true);
  expect(treeRequests.has("Flame_15.png")).toBe(true);
  expect(current.unsupported).toBe("0");
  expect(current.omissions).toBe("0");
  await expect(page.locator("#diagnostic-text")).not.toContainText(
    "Missing textures:",
  );
  const green = await page.locator("#world-canvas").evaluate((c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i + 1] > d[i] * 1.3 && d[i + 1] > d[i + 2] * 1.15 && d[i + 1] > 45)
        n++;
    return n;
  });
  expect(green).toBeGreaterThan(500);
  await page.screenshot({
    path: `artifacts/world-viewer-real-forest-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test("real special objects and plants request their actual atlases with no unsupported Tile cells", async ({page}, testInfo) => {
  test.setTimeout(120000);
  const seen = new Set();
  page.on("request", r => seen.add(r.url().split("/").pop()));
  await page.goto(origin);
  await page.getByRole("button", {name:"打开示例世界",exact:true}).click();
  await expect.poll(async () => (await state(page)).drawn, {timeout:60000}).toBeTruthy();
  await settled(page);
  const points = [
    [835,847,"Extra_181.png","pylon"],
    [1373,1107,"SunOrb.png","altar"],
    [4549,488,"Extra_198.png","relic"],
    [214,799,"Glow_329.png","tulip"],
    [326,1252,"Flame_3.png","chandelier"],
    [6433,466,"Tiles_80.png","cactus"],
  ];
  for (const [x,y,asset,label] of points) {
    const before = Number((await state(page)).revision);
    await page.locator("#tile-x").fill(String(x));
    await page.locator("#tile-y").fill(String(y));
    await page.getByRole("button", {name:"跳转",exact:true}).click();
    await expect.poll(async () => {
      const s = await state(page); return s.busy === "false" && Number(s.revision) > before;
    }, {timeout:60000}).toBe(true);
    const current = await state(page);
    expect(current.backend).toBe("rust-wasm");
    expect(current.unsupported).toBe("0");
    expect(current.skipped).toBe("0");
    expect(seen.has(asset), label).toBe(true);
    await expect(page.locator("#diagnostic-text")).not.toContainText("Missing textures:");
    await page.screenshot({path:`artifacts/world-viewer-${label}-${testInfo.project.name}.png`,fullPage:true});
  }
});
