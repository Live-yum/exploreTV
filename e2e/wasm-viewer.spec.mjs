import { test, expect } from "@playwright/test";

const origin = "http://127.0.0.1:4174";
async function openExample(page, suffix = "") {
  await page.goto(origin + "/" + suffix);
  await page.getByRole("button", { name: "打开示例世界", exact: true }).click();
  await expect
    .poll(
      async () => page.locator("#viewport").evaluate((e) => ({ ...e.dataset })),
      { timeout: 60000 },
    )
    .toMatchObject({ busy: "false", worldWidth: "8400", worldHeight: "2400" });
  await expect
    .poll(
      async () =>
        Number(await page.locator("#viewport").getAttribute("data-drawn")),
      { timeout: 60000 },
    )
    .toBeGreaterThan(0);
}
async function picture(page) {
  return page
    .locator("#world-canvas")
    .evaluate((c) => c.toDataURL("image/png"));
}

test("actual viewer loads Rust WASM under its CSP and matches the JS-rendered world", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const wasmResponses = [];
  page.on("response", (r) => {
    if (r.url().endsWith(".wasm"))
      wasmResponses.push({
        status: r.status(),
        type: r.headers()["content-type"],
      });
  });
  await openExample(page);
  await expect(page.locator("#viewport")).toHaveAttribute(
    "data-backend",
    "rust-wasm",
  );
  expect(wasmResponses).toContainEqual({
    status: 200,
    type: "application/wasm",
  });
  expect(
    Number(
      await page.locator("#viewport").getAttribute("data-wasm-memory-bytes"),
    ),
  ).toBeLessThanOrEqual(128 * 1024 * 1024);
  const wasm = await picture(page);
  const wasmUiTiming = await page.locator("#viewport").evaluate(e => ({...e.dataset}));
  expect(Number(wasmUiTiming.firstViewportMs)).toBeGreaterThanOrEqual(Number(wasmUiTiming.openMs));
  expect(Number(wasmUiTiming.waterfallParseMs)).toBeGreaterThan(0);
  const previous = Number(
    await page.locator("#viewport").getAttribute("data-revision"),
  );
  await page.getByRole("button", { name: "打开示例世界", exact: true }).click();
  await expect
    .poll(
      async () => {
        const s = await page
          .locator("#viewport")
          .evaluate((e) => ({ ...e.dataset }));
        return s.busy === "false" && Number(s.revision) > previous;
      },
      { timeout: 60000 },
    )
    .toBe(true);
  expect(await picture(page)).toBe(wasm);
  await page.screenshot({
    path: `artifacts/wasm-viewer-${info.project.name}.png`,
    fullPage: true,
  });
  const malformed = Buffer.alloc(32);
  malformed.writeInt32LE(315);
  await page
    .locator("#world-file")
    .setInputFiles({
      name: "broken.wld",
      mimeType: "application/octet-stream",
      buffer: malformed,
    });
  await expect(page.locator("#load-status")).toContainText("Invalid WLD magic");
  await expect(page.locator("#viewport")).toHaveAttribute(
    "data-backend",
    "rust-wasm",
  );
  expect(await picture(page)).toBe(wasm);
  const afterFailure = Number(
    await page.locator("#viewport").getAttribute("data-revision"),
  );
  await page.locator("#tile-x").fill("835");
  await page.locator("#tile-y").fill("847");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await expect
    .poll(
      async () => {
        const s = await page
          .locator("#viewport")
          .evaluate((e) => ({ ...e.dataset }));
        return (
          s.busy === "false" &&
          Number(s.revision) > afterFailure &&
          s.waterfallBackend === "worker"
        );
      },
      { timeout: 60000 },
    )
    .toBe(true);
  // Restore the same camera before comparing the JS oracle.
  await page.locator("#tile-x").fill("4489");
  await page.locator("#tile-y").fill("489");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await expect(page.locator("#viewport")).toHaveAttribute("data-busy", "false");
  expect(await picture(page)).toBe(wasm);
  await openExample(page, "?engine=javascript");
  await expect(page.locator("#viewport")).toHaveAttribute(
    "data-backend",
    "javascript",
  );
  expect(await picture(page)).toBe(wasm);
  const javascriptUiTiming = await page.locator("#viewport").evaluate(e => ({...e.dataset}));
  await info.attach("viewer-ui-timing-smoke.json", {contentType:"application/json",body:JSON.stringify({note:"Single functional smoke samples; not a statistically controlled speed benchmark. First viewport includes fetch, worker initialization and texture processing.",wasm:wasmUiTiming,javascript:javascriptUiTiming},null,2)});
});

test("unavailable WASM fails back to the JS viewer without losing a world", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.route("**/wasm-core/dist/exploretv_wld_core.wasm", (route) =>
    route.fulfill({ status: 404, body: "Unavailable for fallback test" }),
  );
  await openExample(page);
  await expect(page.locator("#viewport")).toHaveAttribute(
    "data-backend",
    "javascript",
  );
  await expect(page.locator("#viewport")).toHaveAttribute(
    "data-fallback-reason",
    /404/,
  );
  const first = await picture(page);
  const previous = Number(
    await page.locator("#viewport").getAttribute("data-revision"),
  );
  await page.getByRole("button", { name: "打开示例世界", exact: true }).click();
  await expect
    .poll(
      async () => {
        const s = await page
          .locator("#viewport")
          .evaluate((e) => ({ ...e.dataset }));
        return s.busy === "false" && Number(s.revision) > previous;
      },
      { timeout: 60000 },
    )
    .toBe(true);
  expect(await picture(page)).toBe(first);
});

test("failed replacement worker preserves the installed world encoding and navigation", async ({
  page,
}) => {
  test.setTimeout(90000);
  await openExample(page);
  await page.locator("#encoding").selectOption("standard-straight");
  await expect(page.locator("#viewport")).toHaveAttribute("data-busy", "false");
  const before = Number(
    await page.locator("#viewport").getAttribute("data-revision"),
  );
  const oldPixels = await picture(page);
  await page.route("**/viewer/waterfall-worker.mjs", (route) =>
    route.fulfill({
      status: 404,
      body: "Worker unavailable for replacement test",
    }),
  );
  await page.getByRole("button", { name: "打开示例世界", exact: true }).click();
  await expect(page.locator("#load-status")).toHaveClass(/error/);
  await expect(page.locator("#encoding")).toHaveValue("standard-straight");
  expect(await picture(page)).toBe(oldPixels);
  await page.locator("#tile-x").fill("835");
  await page.locator("#tile-y").fill("847");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await expect
    .poll(
      async () => {
        const s = await page
          .locator("#viewport")
          .evaluate((e) => ({ ...e.dataset }));
        return (
          s.busy === "false" &&
          Number(s.revision) > before &&
          s.waterfallBackend === "worker"
        );
      },
      { timeout: 60000 },
    )
    .toBe(true);
  await expect(page.locator("#encoding")).toHaveValue("standard-straight");
});
