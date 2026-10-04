import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { fixtureWorld } from "../test/fixture.mjs";
const fixture = fixtureWorld({ width: 80, height: 60 });
function originalAtlas() {
  const png = new PNG({ width: 288, height: 270 });
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = x % 256;
      png.data[i + 1] = y % 256;
      png.data[i + 2] = (x + y) % 256;
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}
test("import, real sprite API, missing diagnostics, rectangle validation, save and reload", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByText("把建筑，留成一个片段。")).toBeVisible();
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
    { name: "Tiles_1.png", mimeType: "image/png", buffer: originalAtlas() },
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
  await page.screenshot({ path: "artifacts/synthetic-ui.png", fullPage: true });
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
  await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.22);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.72, {
    steps: 5,
  });
  await page.mouse.up();
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
  await upload("打开已保存片段", await cropped.path());
  await expect(page.getByText(/已绘制 420 个贴图片段/)).toBeVisible();
  await page.screenshot({
    path: "artifacts/synthetic-drag-selection.png",
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
