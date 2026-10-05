import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VIEWPORT_LIMITS,
  viewportSize,
  clampCamera,
  panCamera,
  zoomCamera,
  jumpCamera,
  screenToWorld,
  viewportRegion,
  visibleCommands,
  ByteLruCache,
  LatestRenderQueue,
} from "../core/viewport.mjs";
import { openWorld, extractRegion } from "../core/world.mjs";
import { fixtureWorld } from "./fixture.mjs";
import {
  allowedViewerPath,
  createViewerServer,
} from "../scripts/serve-viewer.mjs";
const world = { width: 8400, height: 2400 },
  size = { width: 1280, height: 720 };

test("full world coordinates stay reachable at native 16 px per tile", () => {
  let camera = jumpCamera({ x: 0, y: 0, zoom: 1 }, 8399, 2399, world, size);
  assert.deepEqual(camera, { x: 134400 - 1280, y: 38400 - 720, zoom: 1 });
  let view = viewportRegion(camera, world, size);
  assert.equal(view.rect.x + view.rect.width, 8400);
  assert.equal(view.rect.y + view.rect.height, 2400);
  assert.equal(view.rect.width, 80);
  assert.equal(view.rect.height, 45);
  camera = jumpCamera(camera, 0, 0, world, size);
  view = viewportRegion(camera, world, size);
  assert.equal(view.context.x, 0);
  assert.equal(view.context.y, 0);
  assert.equal(view.context.width, view.rect.width + VIEWPORT_LIMITS.halo);
  assert.throws(() => jumpCamera(camera, 8400, 1, world, size), /Coordinates/);
  assert.throws(() => jumpCamera(camera, 1.5, 1, world, size), /Coordinates/);
});
test("pointer anchored zoom and drag use world pixels, independent of display density", () => {
  const camera = { x: 20000, y: 9000, zoom: 1 },
    anchor = { x: 207, y: 433 };
  const before = screenToWorld(camera, anchor.x, anchor.y);
  const after = zoomCamera(camera, 2.3, anchor, world, size);
  assert.deepEqual(screenToWorld(after, anchor.x, anchor.y), before);
  assert.deepEqual(panCamera(camera, 32, -48, world, size), {
    x: 19968,
    y: 9048,
    zoom: 1,
  });
  assert.equal(zoomCamera(camera, 0.01, anchor, world, size).zoom, 0.5);
  assert.equal(zoomCamera(camera, 100, anchor, world, size).zoom, 4);
});
test("maximum screen at minimum zoom retains a bounded halo at every world corner", () => {
  const display = viewportSize(100000, 100000);
  assert.deepEqual(display, { width: 1920, height: 1024 });
  for (const [x, y] of [
    [0, 0],
    [4489, 489],
    [8399, 0],
    [0, 2399],
    [8399, 2399],
  ]) {
    const camera = jumpCamera({ x: 0, y: 0, zoom: 0.5 }, x, y, world, display);
    const view = viewportRegion(camera, world, display);
    assert.ok(view.context.width * view.context.height <= 65536);
    assert.ok(view.context.x >= 0 && view.context.y >= 0);
    assert.ok(view.context.x + view.context.width <= world.width);
    assert.ok(view.context.y + view.context.height <= world.height);
  }
  assert.throws(() => viewportSize(NaN, 5), /Invalid/);
  assert.throws(
    () => clampCamera({ x: 0, y: 0, zoom: Infinity }, world, size),
    /Invalid/,
  );
});
test("indexed 8400x2400 WLD decodes only requested far-edge region", () => {
  const parsed = openWorld(fixtureWorld(world).bytes);
  assert.equal(parsed.columns.length, 8401);
  const view = viewportRegion(
    jumpCamera({ x: 0, y: 0, zoom: 1 }, 8399, 2399, parsed, size),
    parsed,
    size,
  );
  const region = extractRegion(parsed, view.context);
  assert.equal(region.cells.length, view.context.width * view.context.height);
  assert.ok(region.cells.length < 10000);
  assert.equal(region.cells.at(-1).type, 0);
});
test("visible command filter includes wall overhang and excludes offscreen halo", () => {
  const commands = [
    { dx: 8, dy: 16, dw: 32, dh: 32 },
    { dx: 0, dy: 0, dw: 16, dh: 16 },
    { dx: 32, dy: 16, dw: 16, dh: 16 },
    { dx: 64, dy: 16, dw: 16, dh: 16 },
  ];
  assert.deepEqual(
    visibleCommands(
      { commands },
      { x: 0, y: 0 },
      { x: 32, y: 16, zoom: 1 },
      { width: 32, height: 16 },
    ),
    [commands[0], commands[2]],
  );
});
test("LRU accounts raw/image bytes, evicts least recent, and refuses oversized sources", () => {
  const disposed = [],
    cache = new ByteLruCache(100, (item) => disposed.push(item));
  cache.set("a", "A", 40);
  cache.set("b", "B", 40);
  cache.get("a");
  cache.set("c", "C", 30);
  assert.deepEqual(disposed, ["B"]);
  assert.equal(cache.bytes, 70);
  assert.equal(cache.peakBytes, 80);
  cache.reserve(90);
  assert.equal(cache.bytes, 0);
  assert.throws(() => cache.set("big", "big", 101), /budget/);
  assert.equal(cache.entries.size, 0);
});
test("serial render queue discards stale asynchronous results and coalesces pending navigation", async () => {
  let resolveFirst;
  const started = [],
    committed = [],
    errors = [];
  const queue = new LatestRenderQueue(
    async (value, current) => {
      started.push(value);
      if (value === 1)
        await new Promise((resolve) => {
          resolveFirst = resolve;
        });
      return { value, current: current() };
    },
    (result) => committed.push(result),
    (error) => errors.push(error),
  );
  queue.request(1);
  queue.request(2);
  queue.request(3);
  resolveFirst();
  await queue.idle();
  assert.deepEqual(started, [1, 3]);
  assert.deepEqual(committed, [{ value: 3, current: true }]);
  assert.deepEqual(errors, []);
});
test("viewer URL allowlist excludes private files, encoded traversal, and unrelated assets", () => {
  assert.equal(allowedViewerPath("/"), "viewer/index.html");
  assert.equal(allowedViewerPath("/wasm-core/dist/exploretv_wld_core.wasm"), "wasm-core/dist/exploretv_wld_core.wasm");
  assert.equal(allowedViewerPath("/wasm-core/dist/other.wasm"), null);
  assert.equal(allowedViewerPath("/wasm-core/.cargo/config.toml"), null);
  assert.equal(
    allowedViewerPath("/fixtures/example-world.wld"),
    "fixtures/example-world.wld",
  );
  assert.equal(
    allowedViewerPath("/example/assets/Tiles_1.png"),
    "example/assets/Tiles_1.png",
  );
  for (const path of [
    "/fixtures/private/world.wld",
    "/artifacts/full-world.png",
    "/package.json",
    "/.git/config",
    "/viewer/../package.json",
    "/example/assets/../../../package.json",
    "/example/assets/logo.png",
  ])
    assert.equal(allowedViewerPath(path), null);
});
test("viewer server denies traversal, symlink escapes, and non-read methods", async () => {
  const root = await mkdtemp(join(tmpdir(), "exploretv-viewer-"));
  await mkdir(join(root, "viewer"));
  await mkdir(join(root, "core"));
  await mkdir(join(root, "wasm-core/dist"), { recursive: true });
  await writeFile(join(root, "wasm-core/dist/exploretv_wld_core.wasm"), new Uint8Array([0,97,115,109,1,0,0,0]));
  await writeFile(join(root, "viewer/index.html"), "viewer");
  await writeFile(join(root, "secret.mjs"), "private");
  await symlink(join(root, "secret.mjs"), join(root, "core/leak.mjs"));
  const server = createViewerServer(root);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await (await fetch(url)).text(), "viewer");
    const wasm = await fetch(url + "/wasm-core/dist/exploretv_wld_core.wasm");
    assert.equal(wasm.headers.get("content-type"), "application/wasm");
    const policy = wasm.headers.get("content-security-policy");
    assert.ok(policy.includes("script-src 'self' 'wasm-unsafe-eval'"));
    assert.ok(!policy.includes("'unsafe-eval'"));
    assert.equal((await fetch(url + "/core/leak.mjs")).status, 403);
    assert.equal(
      (await fetch(url + "/viewer/%2e%2e%2fsecret.mjs")).status,
      404,
    );
    assert.equal(
      (await fetch(url + "/fixtures/private/world.wld")).status,
      404,
    );
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
    assert.equal(
      (await fetch(url, { method: "HEAD" })).headers.get("content-type"),
      "text/html; charset=utf-8",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
