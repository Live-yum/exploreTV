import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
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
  const backing = await page
    .locator("#world-canvas")
    .evaluate((element) => ({
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
  const anchor = { x: 231, y: 181 };
  await page.mouse.move(box.x + anchor.x, box.y + anchor.y);
  await page.mouse.wheel(0, -200);
  const zoomed = await settled(page, dragged.revision);
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
  await page
    .locator("#world-file")
    .setInputFiles({
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
  const colors = await page.locator("#world-canvas").evaluate((element) => {
    const data = element
        .getContext("2d")
        .getImageData(0, 0, element.width, element.height).data,
      colors = new Set();
    for (let index = 0; index < data.length; index += 28)
      colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
    return colors.size;
  });
  expect(colors).toBeGreaterThan(100);
  await page.screenshot({
    path: `artifacts/world-viewer-example-building-${testInfo.project.name}.png`,
    fullPage: true,
  });
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
