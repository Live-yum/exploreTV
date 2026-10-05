import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { chromium } from "@playwright/test";
import { fixtureWorld, record } from "../test/fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const browserPath = [chromium.executablePath(), "/usr/bin/chromium"].find(
  (path) => existsSync(path),
);
test("dedicated browser module worker loads the production entry and returns a fresh snapshot", async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/test.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<!doctype html><html><body>Worker protocol test</body></html>",
      );
      return;
    }
    const relative = decodeURIComponent(url.pathname.slice(1)),
      path = resolve(root, relative);
    if (!path.startsWith(root + sep) && !path.startsWith(root)) {
      response.writeHead(403).end();
      return;
    }
    if (
      !(
        relative.startsWith("core/") ||
        relative === "viewer/waterfall-worker.mjs"
      ) ||
      !relative.endsWith(".mjs")
    ) {
      response.writeHead(404).end();
      return;
    }
    try {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(readFileSync(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: browserPath,
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/test.html`);
    const columns = Array.from({ length: 260 }, (_, x) =>
      x === 120
        ? [
            record({ type: null, repeats: 79 }),
            record({ type: 196 }),
            record({ type: null, repeats: 178 }),
          ]
        : [record({ type: null, repeats: 259 })],
    );
    const bytes = fixtureWorld({ width: 260, height: 260, columns }).bytes;
    const result = await page.evaluate(
      async (values) => {
        const { createWaterfallWorkerClient } = await import(
            "/core/waterfall-worker-client.mjs"
          ),
          client = createWaterfallWorkerClient(),
          input = Uint8Array.from(values);
        try {
          const initialized = await client.initialize(input, { revision: 9 });
          const snapshot = await client.requestSnapshot({
            revision: 9,
            requestId: 4,
            viewport: { x: 100, y: 70, width: 84, height: 64 },
          });
          return {
            initialized: initialized.status,
            status: snapshot.status,
            revision: snapshot.revision,
            requestId: snapshot.requestId,
            inputLength: input.byteLength,
            defaultCap: snapshot.maxWaterfalls,
            registered: snapshot.stats.registered,
            commands: snapshot.commands.length,
            hasCloudOrigin: snapshot.hasOrigin(120, 81),
            queriedCommands: snapshot.commandsFor(snapshot.outputRect).length,
            state: client.getState().state,
          };
        } finally {
          client.dispose();
        }
      },
      [...bytes],
    );
    assert.equal(result.initialized, "ready");
    assert.equal(result.status, "ready");
    assert.equal(result.revision, 9);
    assert.equal(result.requestId, 4);
    assert.equal(result.inputLength, bytes.byteLength);
    assert.equal(result.defaultCap, 1000);
    assert.equal(result.registered, 1);
    assert.equal(result.hasCloudOrigin, true);
    assert.ok(result.commands > 0);
    assert.equal(result.queriedCommands, result.commands);
    assert.equal(result.state, "ready");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
