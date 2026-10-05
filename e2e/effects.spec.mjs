import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { readFile } from "node:fs/promises";
import { fixtureWorld, record } from "../test/fixture.mjs";
import { loadFragment } from "../core/fragment.mjs";
const flat = (width, height, rgba) => {
  const p = new PNG({ width, height });
  for (let i = 0; i < p.data.length; i += 4) p.data.set(rgba, i);
  return PNG.sync.write(p);
};
const world = fixtureWorld({
  width: 1,
  height: 1,
  columns: [
    [
      record({
        type: null,
        wall: 1,
        wallPaint: 26,
        liquid: 255,
        liquidKind: 1,
      }),
    ],
  ],
});
test("paint/channel contracts and liquid controls preserve sprite layering and raw Tile data", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const upload = async (name, files) => {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name, exact: true }).click();
    await (await chooser).setFiles(files);
  };
  const pixel = () =>
    page
      .locator("canvas")
      .last()
      .evaluate((c) =>
        Array.from(c.getContext("2d").getImageData(8, 8, 1, 1).data),
      );
  const near = async (expected) => {
    await expect
      .poll(async () => {
        const actual = await pixel();
        return Math.max(...actual.map((v, i) => Math.abs(v - expected[i])));
      })
      .toBeLessThanOrEqual(2);
  };
  await upload("1 导入 .wld", {
    name: "original-effects.wld",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(world.bytes),
  });
  await upload("2 导入 PNG 贴图", [
    {
      name: "Wall_1.png",
      mimeType: "image/png",
      buffer: flat(468, 180, [128, 128, 128, 128]),
    },
    {
      name: "water_0.png",
      mimeType: "image/png",
      buffer: flat(48, 1360, [20, 40, 200, 255]),
    },
  ]);
  await page
    .getByRole("button", { name: "3 生成场景预览", exact: true })
    .click();
  await expect(page.getByText(/已绘制 2 个贴图片段/)).toBeVisible();
  await near([89, 101, 197, 255]);
  await page.screenshot({
    path: `artifacts/synthetic-effects-composite-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "液体层：前景", exact: true }).click();
  await near([20, 40, 200, 255]);
  await page
    .getByRole("button", { name: "液体：静态近似", exact: true })
    .click();
  await near([192, 192, 192, 255]);
  await page
    .getByRole("button", { name: "画布：黑底预乘合成", exact: true })
    .click();
  await expect(
    page.getByText(/premultiplied-excess-needs-opaque-scene/),
  ).toBeVisible();
  await near([0, 0, 0, 0]);
  await page.screenshot({
    path: `artifacts/synthetic-effects-transparent-refusal-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "染色：开启", exact: true }).click();
  await near([255, 255, 255, 128]);
  await page
    .getByRole("button", { name: "PNG通道：TConvert原始", exact: true })
    .click();
  await near([128, 128, 128, 128]);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "4 提取 / 保存 Tile", exact: true })
    .click();
  const saved = await download;
  const fragment = loadFragment(await readFile(await saved.path(), "utf8"));
  expect(fragment.cells[0].wallPaint).toBe(26);
  expect(fragment.cells[0].liquid).toBe(255);
  expect(fragment.cells[0].liquidKind).toBe(1);
  await page.screenshot({
    path: `artifacts/synthetic-effects-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "PNG通道：标准透明", exact: true })
    .click();
  await page.getByRole("button", { name: "画布：透明", exact: true }).click();
  for (const alpha of [1, 0]) {
    await upload("2 导入 PNG 贴图", [
      {
        name: "Wall_1.png",
        mimeType: "image/png",
        buffer: flat(468, 180, [60, 30, 15, alpha]),
      },
    ]);
    await near([60, 30, 15, 255]);
  }
  await page.screenshot({
    path: `artifacts/synthetic-effects-hidden-rgb-${testInfo.project.name}.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
