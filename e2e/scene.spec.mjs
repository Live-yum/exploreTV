import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { readFile } from "node:fs/promises";
import { loadFragment } from "../core/fragment.mjs";
import { fixtureWorld, record } from "../test/fixture.mjs";
const fixture = fixtureWorld({
  width: 80,
  height: 60,
  columns: Array.from({ length: 80 }, (_, x) =>
    Array.from({ length: 60 }, (_, y) =>
      record({
        type: x % 2 ? 0 : 1,
        paint: ((x + 3 * y) % 30) + 1,
        red: x % 3 === 0,
      }),
    ),
  ),
});
function originalAtlas(type = 0) {
  const png = new PNG({ width: 288, height: 270 });
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = x % 256;
      png.data[i + 1] = y % 256;
      png.data[i + 2] = type ? 200 : 30;
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}
test("import, real sprite API, missing diagnostics, rectangle validation, save and reload", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByText("把建筑，留成一个片段。")).toBeVisible();
  await page.getByRole("button", { name: "染色：开启", exact: true }).click();
  async function upload(button, files) {
    const wait = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: button, exact: true }).click();
    await (await wait).setFiles(files);
  }
  await upload("1 导入 .wld", {
    name: "original-synthetic.wld",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(fixture.bytes),
  });
  await expect(page.getByText(/Synthetic 世界 · v269/)).toBeVisible();
  await page
    .getByRole("button", { name: "3 生成场景预览", exact: true })
    .click();
  await expect(page.getByText(/Missing textures:/)).toBeVisible();
  await upload("2 导入 PNG 贴图", [
    { name: "Tiles_1.png", mimeType: "image/png", buffer: originalAtlas(1) },
    { name: "Tiles_0.png", mimeType: "image/png", buffer: originalAtlas() },
  ]);
  await expect(page.getByText("2 张贴图已载入")).toBeVisible();
  await expect(page.getByText(/已绘制 2560 个贴图片段/)).toBeVisible();
  const pixels = await page
    .locator("canvas")
    .last()
    .evaluate((c) =>
      Array.from(c.getContext("2d").getImageData(2, 2, 1, 1).data),
    );
  expect(pixels[3]).toBe(255);
  await page.screenshot({
    path: `artifacts/synthetic-ui-${testInfo.project.name}.png`,
    fullPage: true,
  });
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "4 提取 / 保存 Tile", exact: true })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.tvtiles\.json$/);
  await expect(
    page.getByText(/已保存并重新读取验证 2560 个 Tile/),
  ).toBeVisible();
  await upload("打开已保存片段", await file.path());
  await expect(page.getByText(/已绘制 2560 个贴图片段/)).toBeVisible();
  const surface = page.locator("#selection-surface");
  const originalWidth = (await surface.boundingBox()).width;
  await page.getByRole("button", { name: "缩小", exact: true }).click();
  await expect(page.getByText("75%", { exact: true })).toBeVisible();
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  expect(box.width).toBeLessThan(originalWidth);
  const backing = await page
    .locator("canvas")
    .last()
    .evaluate((c) => ({
      width: c.width,
      height: c.height,
      cssWidth: c.getBoundingClientRect().width,
      cssHeight: c.getBoundingClientRect().height,
    }));
  expect(backing.width).toBe(Math.round(box.width));
  expect(backing.height).toBe(Math.round(box.height));
  expect(backing.cssWidth).toBe(box.width);
  expect(backing.cssHeight).toBe(box.height);
  const scale = box.width / (64 * 16);
  const samples = [
    [2, 3],
    [61, 37],
    [32, 20],
  ].map(([x, y]) => ({
    x,
    y,
    px: Math.floor((x * 16 + 8) * scale),
    py: Math.floor((y * 16 + 8) * scale),
  }));
  const colors = await page
    .locator("canvas")
    .last()
    .evaluate(
      (c, points) =>
        points.map((p) =>
          Array.from(c.getContext("2d").getImageData(p.px, p.py, 1, 1).data),
        ),
      samples,
    );
  samples.forEach((p, i) => {
    const u = Math.floor((p.px + 0.5) / scale) - p.x * 16,
      v = Math.floor((p.py + 0.5) / scale) - p.y * 16;
    expect(Math.abs(colors[i][0] - (90 + u))).toBeLessThanOrEqual(1);
    expect(Math.abs(colors[i][1] - v)).toBeLessThanOrEqual(1);
    expect(colors[i][2]).toBe((8 + p.x) % 2 ? 30 : 200);
    expect(colors[i][3]).toBe(255);
  });
  await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.22);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.72, {
    steps: 5,
  });
  await page.mouse.up();
  expect(errors).toEqual([]);
  await expect(page.locator(".field input").nth(0)).toHaveValue("15");
  await expect(page.locator(".field input").nth(1)).toHaveValue("8");
  await expect(page.locator(".field input").nth(2)).toHaveValue("20");
  await expect(page.locator(".field input").nth(3)).toHaveValue("21");
  await page
    .getByRole("button", { name: "3 生成场景预览", exact: true })
    .click();
  await expect(page.getByText(/已绘制 420 个贴图片段/)).toBeVisible();
  const cropDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "4 提取 / 保存 Tile", exact: true })
    .click();
  const cropped = await cropDownload;
  const restored = loadFragment(await readFile(await cropped.path(), "utf8"));
  expect(restored.rect).toEqual({ x: 15, y: 8, width: 20, height: 21 });
  for (let x = 0; x < 20; x++)
    for (let y = 0; y < 21; y++) {
      const cell = restored.cells[x * 21 + y];
      expect(cell.type).toBe((x + 15) % 2 ? 0 : 1);
      expect(cell.paint).toBe(((x + 15 + 3 * (y + 8)) % 30) + 1);
      expect(cell.wireRed).toBe((x + 15) % 3 === 0);
    }
  await upload("打开已保存片段", await cropped.path());
  await expect(page.getByText(/已绘制 420 个贴图片段/)).toBeVisible();
  await page.screenshot({
    path: `artifacts/synthetic-drag-selection-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await upload("2 导入 PNG 贴图", {
    name: "Tiles_2.png",
    mimeType: "image/png",
    buffer: originalAtlas().subarray(0, 24),
  });
  await expect(
    page.getByText("PNG 贴图解码失败", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("2 张贴图已载入")).toBeVisible();
  const inputs = page.locator(".field input");
  await inputs.nth(0).fill("-1");
  await page
    .getByRole("button", { name: "3 生成场景预览", exact: true })
    .click();
  await expect(
    page.getByText("Rectangle outside world", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
