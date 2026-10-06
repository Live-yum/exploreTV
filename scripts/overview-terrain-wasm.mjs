import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createOverviewTerrainPlanner } from "../core/overview-wasm.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let compiled = null;
function load() {
  if (compiled) return compiled;
  const base = new URL("../wasm-core/", import.meta.url);
  const bytes = readFileSync(new URL("dist/exploretv_wld_core.wasm", base));
  const build = JSON.parse(
    readFileSync(new URL("dist/build-info.json", base), "utf8"),
  );
  if (
    hash(bytes) !== build.sha256 ||
    hash(readFileSync(new URL("src/lib.rs", base))) !== build.sourceSha256 ||
    hash(readFileSync(new URL("src/overview.rs", base))) !==
      build.overviewSourceSha256
  )
    throw new Error("Terrain WASM build is stale; rebuild wasm-core/build.sh");
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length)
    throw new Error("Terrain WASM must be import-free");
  compiled = { module, binarySha256: build.sha256, build };
  return compiled;
}

/** Compilation and instance creation happen within the measured exporter process. */
export function createNodeOverviewTerrainPlanner() {
  try {
    const { module, binarySha256, build } = load();
    const planner = createOverviewTerrainPlanner(module);
    Object.assign(planner.stats, { binarySha256, build });
    return planner;
  } catch (error) {
    return {
      stats: {
        available: false,
        backend: "javascript-neighbourhoods",
        reason: String(error.message),
      },
      plan() {
        return null;
      },
      dispose() {},
    };
  }
}
