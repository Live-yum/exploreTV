import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const path = new URL("./dist/exploretv_wld_core.wasm", import.meta.url);
const bytes = await readFile(path),
  module = await WebAssembly.compile(bytes);
if (WebAssembly.Module.imports(module).length)
  throw new Error("WASM must be import-free");
const { exports } = new WebAssembly.Instance(module, {});
if (exports.abi_version() !== 1 || exports.cell_bytes() !== 32)
  throw new Error("Unexpected ABI");
if (exports.overview_abi_version() !== 2)
  throw new Error("Unexpected terrain planning ABI");
let limited = false;
try {
  exports.memory.grow(2049);
} catch (error) {
  if (error instanceof RangeError) limited = true;
  else throw error;
}
if (!limited) throw new Error("Missing WASM linear-memory limit");
const info = {
  artifact: "exploretv_wld_core.wasm",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
  abiVersion: 1,
  cellBytes: 32,
  overviewAbiVersion: 2,
  maxLinearMemoryBytes: 128 * 1024 * 1024,
  target: "wasm32-unknown-unknown",
  rustc: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
  sourceSha256: createHash("sha256")
    .update(await readFile(new URL("./src/lib.rs", import.meta.url)))
    .digest("hex"),
  overviewSourceSha256: createHash("sha256")
    .update(await readFile(new URL("./src/overview.rs", import.meta.url)))
    .digest("hex"),
  imports: [],
  profile:
    "release, opt-level=3, LTO, codegen-units=1, panic=abort, strip=true",
};
await writeFile(
  new URL("./dist/build-info.json", import.meta.url),
  JSON.stringify(info, null, 2) + "\n",
);
console.log(
  `${info.artifact}: ${info.bytes} bytes, ABI ${info.abiVersion}, SHA256 ${info.sha256}`,
);
