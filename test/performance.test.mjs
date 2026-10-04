import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { openWorld, extractRegion } from "../core/world.mjs";
import { saveFragment, loadFragment } from "../core/fragment.mjs";
import { fixtureWorld } from "./fixture.mjs";

test("large synthetic world remains column-indexed, bounded region roundtrip", () => {
  const source = fixtureWorld({ width: 8400, height: 2400 });
  const start = performance.now(),
    world = openWorld(source.bytes);
  assert.equal(world.columns.byteLength, (8400 + 1) * 4);
  assert.equal(world.records, 8400);
  const region = extractRegion(world, {
    x: 4000,
    y: 1000,
    width: 256,
    height: 256,
  });
  assert.equal(region.raw.length, 65536);
  const restored = loadFragment(saveFragment(region));
  assert.deepEqual(restored.raw[65535], region.raw[65535]);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 10000, `Budget exceeded: ${elapsed}ms`);
  console.log(
    `20.16M synthetic cells: ${elapsed.toFixed(1)}ms; index ${world.columns.byteLength} bytes`,
  );
});
