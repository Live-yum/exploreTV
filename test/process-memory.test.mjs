import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProcessMemorySampler } from "../scripts/process-memory.mjs";

const native = {
  rss: 50_000_000,
  heapTotal: 12_000_000,
  heapUsed: 8_000_000,
  external: 3_000_000,
  arrayBuffers: 2_000_000,
};
const heap = {
  total_heap_size: 12_000_000,
  used_heap_size: 8_000_000,
  external_memory: 3_000_000,
};
const missingProc = () => {
  throw Object.assign(new Error("uv_resident_set_memory cannot read /proc"), {
    code: "ENOENT",
  });
};

test("native current RSS and ArrayBuffer samples retain their measured values", () => {
  const sampler = createProcessMemorySampler({
    memoryUsage: () => native,
    resourceUsage: () => assert.fail("native sampling needs no fallback"),
    heapStatistics: () => assert.fail("native sampling needs no fallback"),
  });
  const result = sampler.sample();
  for (const key of Object.keys(native)) assert.equal(result[key], native[key]);
  assert.equal(result.rssCurrentAvailable, true);
  assert.equal(result.rssCurrentBytes, native.rss);
  assert.equal(result.arrayBuffersAvailable, true);
  assert.equal(sampler.status().currentRssSamples, 1);
  assert.equal(native.rssSource, undefined, "native sample is not mutated");
});

test("restricted /proc uses measured OS peak and V8, never zero native memory", () => {
  const sampler = createProcessMemorySampler({
    memoryUsage: missingProc,
    resourceUsage: () => ({ maxRSS: 123_456 }),
    heapStatistics: () => heap,
  });
  const result = sampler.sample();
  assert.equal(result.rss, 123_456 * 1024);
  assert.equal(result.osPeakRssBytes, result.rss);
  assert.equal(result.rssCurrentAvailable, false);
  assert.equal(result.rssCurrentBytes, null);
  assert.equal(result.rssSource, "resourceUsage.maxRSS-lifetime-peak");
  assert.equal(result.heapTotal, heap.total_heap_size);
  assert.equal(result.heapUsed, heap.used_heap_size);
  assert.equal(result.external, heap.external_memory);
  assert.equal(result.arrayBuffers, null);
  assert.equal(result.arrayBuffersAvailable, false);
  assert.equal(result.memorySamplingError.code, "ENOENT");
  assert.equal(sampler.status().lifetimePeakFallbackSamples, 1);
  assert.deepEqual(sampler.status().fallbackReasons, { ENOENT: 1 });
  sampler.status().fallbackReasons.ENOENT = 999;
  assert.equal(sampler.status().fallbackReasons.ENOENT, 1);
});

test("unexpected sampling failures and unavailable OS peaks fail closed", () => {
  const failure = new Error("programming failure");
  assert.throws(
    () =>
      createProcessMemorySampler({
        memoryUsage: () => {
          throw failure;
        },
      }).sample(),
    (error) => error === failure,
  );
  for (const maxRSS of [0, -1, undefined, NaN, Infinity])
    assert.throws(
      () =>
        createProcessMemorySampler({
          memoryUsage: missingProc,
          resourceUsage: () => ({ maxRSS }),
          heapStatistics: () => heap,
        }).sample(),
      /OS lifetime peak RSS/,
    );
  assert.throws(
    () =>
      createProcessMemorySampler({
        memoryUsage: missingProc,
        resourceUsage: () => ({ maxRSS: 100_000 }),
        heapStatistics: () => ({ ...heap, external_memory: undefined }),
      }).sample(),
    /V8 external memory/,
  );
});

test("an already instrumented peak sample is not relabeled as current RSS", () => {
  const inner = createProcessMemorySampler({
    memoryUsage: missingProc,
    resourceUsage: () => ({ maxRSS: 100_000 }),
    heapStatistics: () => heap,
  });
  const outer = createProcessMemorySampler({ memoryUsage: inner.sample });
  const result = outer.sample();
  assert.equal(result.rssCurrentAvailable, false);
  assert.equal(result.rssCurrentBytes, null);
  assert.equal(result.rssSource, "resourceUsage.maxRSS-lifetime-peak");
  assert.equal(result.arrayBuffers, null);
  assert.equal(outer.status().currentRssSamples, 0);
  assert.equal(outer.status().lifetimePeakFallbackSamples, 1);
});

test("opt-in preload handles legacy memoryUsage and memoryUsage.rss callers", () => {
  const url = new URL("../scripts/process-memory.mjs", import.meta.url).href;
  const program = `
    process.memoryUsage = Object.assign(() => {
      throw Object.assign(new Error("restricted /proc"), { code: "ENOENT" });
    }, { rss() { throw new Error("old rss method must be replaced"); } });
    const { installProcessMemoryFallback, getProcessMemorySamplingStatus } = await import(${JSON.stringify(url)});
    installProcessMemoryFallback();
    installProcessMemoryFallback();
    const sample = process.memoryUsage();
    const rss = process.memoryUsage.rss();
    console.log(JSON.stringify({ sample, rss, status: getProcessMemorySamplingStatus() }));
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", program],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.ok(result.sample.rss > 0);
  assert.ok(result.rss >= result.sample.rss);
  assert.equal(result.sample.rssCurrentAvailable, false);
  assert.equal(result.sample.arrayBuffers, null);
  assert.equal(result.status.processMemoryUsageOverrideInstalled, true);
  assert.equal(result.status.lifetimePeakFallbackSamples, 2);
});
