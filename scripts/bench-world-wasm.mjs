#!/usr/bin/env node
/** Reproducible real-map JS/WASM benchmark; no synthetic speed claims. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

// This function deliberately uses browser-compatible code. Both Node and Chromium
// run precisely the same measurements and the same all-fields equality oracle.
async function runBenchmark({
  input,
  wasm,
  worldModule,
  wasmModule,
  runtimeName,
}) {
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b),
      i = sorted.length >>> 1;
    return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
  };
  const summarize = (values) => ({
    coldMs: values[0],
    warmMedianMs: median(values.slice(2)),
    samplesMs: values,
  });
  const setupStart = performance.now(),
    engine = await wasmModule.loadWasmCore(wasm);
  const compileAndProbeMs = performance.now() - setupStart;
  const jsOpen = [],
    wasmOpen = [],
    wasmOpenPhases = [];
  let js, accelerated;
  for (let i = 0; i < 9; i++) {
    let start = performance.now();
    js = worldModule.openWorld(input);
    jsOpen.push(performance.now() - start);
    if (accelerated) engine.disposeWorld(accelerated);
    start = performance.now();
    accelerated = engine.openWorld(input);
    wasmOpen.push(performance.now() - start);
    wasmOpenPhases.push(wasmModule.worldWasmStats(accelerated));
  }
  const equal = (a, b, label) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`JS/WASM mismatch: ${label}`);
  };
  for (const key of [
    "signature",
    "version",
    "name",
    "seed",
    "id",
    "width",
    "height",
    "worldSurface",
    "records",
    "sections",
    "columns",
    "important",
    "treeContext",
    "herbContext",
  ])
    equal(js[key], accelerated[key], key);
  const regions = [];
  for (const rect of [
    { x: 4000, y: 400, width: 128, height: 128 },
    { x: 2000, y: 1000, width: 256, height: 256 },
    { x: 7000, y: 2100, width: 128, height: 128 },
  ]) {
    const expected = worldModule.extractRegion(js, rect),
      actual = engine.extractRegion(accelerated, rect);
    equal(
      actual,
      expected,
      `every tile field and canonical byte ${JSON.stringify(rect)}`,
    );
    const jsMs = [],
      wasmMs = [],
      phases = [];
    for (let i = 0; i < 15; i++) {
      let start = performance.now();
      worldModule.extractRegion(js, rect);
      jsMs.push(performance.now() - start);
      start = performance.now();
      engine.extractRegion(accelerated, rect);
      wasmMs.push(performance.now() - start);
      phases.push(wasmModule.worldWasmStats(accelerated).lastExtract);
    }
    regions.push({
      rect,
      oracle: "all fields and canonical raw bytes equal",
      javascript: summarize(jsMs),
      wasmEndToEnd: summarize(wasmMs),
      wasmPhases: phases,
      speedup: median(jsMs.slice(2)) / median(wasmMs.slice(2)),
    });
  }
  const memoryBytes = wasmModule.worldWasmStats(accelerated).memoryBytes;
  engine.disposeWorld(accelerated);
  return {
    runtime: runtimeName,
    compileAndProbeMs,
    fileBytes: input.length,
    width: js.width,
    height: js.height,
    records: js.records,
    wasmMemoryBytes: memoryBytes,
    methodology:
      "9 alternating opens; 15 alternating extracts/rectangle; warm median excludes first 2. Open includes instantiate, allocate, full input copy, Rust parse, JS metadata copy/context. Extract includes Rust decode and all JS cell/raw conversion. Disk/network fetch excluded and measured separately for browser. Native timings are a separate result.",
    open: {
      javascript: summarize(jsOpen),
      wasmEndToEnd: summarize(wasmOpen),
      wasmPhases: wasmOpenPhases,
      speedup: median(jsOpen.slice(2)) / median(wasmOpen.slice(2)),
    },
    regions,
  };
}

const root = new URL("../", import.meta.url);
const input = await readFile(new URL("fixtures/example-world.wld", root));
const wasm = await readFile(
  new URL("wasm-core/dist/exploretv_wld_core.wasm", root),
);
const expectedHash =
  "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab";
if (createHash("sha256").update(input).digest("hex") !== expectedHash)
  throw new Error("Unexpected real-world fixture hash");
let result;
if (process.argv.includes("--browser")) {
  const { chromium } = await import("@playwright/test");
  const server = createServer(async (req, res) => {
    const path = req.url;
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>Real WLD WASM benchmark</title>");
      return;
    }
    if (
      !(
        /^\/core\/[a-z0-9-]+\.mjs$/.test(path) ||
        path === "/fixtures/example-world.wld" ||
        path === "/wasm-core/dist/exploretv_wld_core.wasm"
      )
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const bytes = await readFile(new URL(path.slice(1), root));
      res.writeHead(200, {
        "Content-Type": path.endsWith(".mjs")
          ? "text/javascript"
          : path.endsWith(".wasm")
            ? "application/wasm"
            : "application/octet-stream",
      });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_EXECUTABLE ||
        process.env.CHROMIUM_PATH ||
        undefined,
      headless: true,
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(`globalThis.runBenchmark = ${runBenchmark.toString()}`);
    result = await page.evaluate(async () => {
      const fetchStart = performance.now();
      const [input, wasm, worldModule, wasmModule] = await Promise.all([
        fetch("/fixtures/example-world.wld")
          .then((r) => r.arrayBuffer())
          .then((b) => new Uint8Array(b)),
        fetch("/wasm-core/dist/exploretv_wld_core.wasm").then((r) =>
          r.arrayBuffer(),
        ),
        import("/core/world.mjs"),
        import("/core/world-wasm.mjs"),
      ]);
      const fetchAndModuleLoadMs = performance.now() - fetchStart;
      return {
        ...(await globalThis.runBenchmark({
          input,
          wasm,
          worldModule,
          wasmModule,
          runtimeName: navigator.userAgent,
        })),
        fetchAndModuleLoadMs,
      };
    });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
} else {
  result = await runBenchmark({
    input,
    wasm,
    worldModule: await import("../core/world.mjs"),
    wasmModule: await import("../core/world-wasm.mjs"),
    runtimeName: `Node ${process.version}`,
  });
}
result.fixtureSha256 = expectedHash;
result.wasmSha256 = createHash("sha256").update(wasm).digest("hex");
result.wasmBytes = wasm.length;
result.capturedAt = new Date().toISOString();
const outputIndex = process.argv.indexOf("--output");
const json = JSON.stringify(result, null, 2) + "\n";
if (outputIndex >= 0) await writeFile(process.argv[outputIndex + 1], json);
else process.stdout.write(json);
console.error(
  `${result.runtime}: open ${result.open.javascript.warmMedianMs.toFixed(2)}ms JS / ${result.open.wasmEndToEnd.warmMedianMs.toFixed(2)}ms WASM (${result.open.speedup.toFixed(2)}x)`,
);
for (const r of result.regions)
  console.error(
    `${r.rect.x},${r.rect.y} ${r.rect.width}×${r.rect.height}: ${r.javascript.warmMedianMs.toFixed(2)}ms JS / ${r.wasmEndToEnd.warmMedianMs.toFixed(2)}ms WASM (${r.speedup.toFixed(2)}x)`,
  );
