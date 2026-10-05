# Bounded Rust → WebAssembly WLD core

## Scope and provenance

This is an original, dependency-free Rust implementation of the existing
`core/world.mjs` WLD tile contract. It accelerates modern WLD envelope validation,
RLE column indexing, and rectangle extraction. It does not implement rendering,
asset decoding, sprite planning, Canvas drawing, full-world export, or compression.
No private TerraX code, game code, credentials, or game assets are in the crate.
The unchanged JavaScript reader remains the oracle and startup fallback.

Supported WLD versions: **269–326 inclusive**; signatures `relogic` and `xindong`.
All tile fields and unknown header bits in canonical raw records are preserved.
Source bytes are never modified. Frame coordinates remain signed, absent frames
remain `null`, and the liquid high-wall-byte ordering matches the JS reader.

## Build and tests

Install official Rust 1.85.1 with `wasm32-unknown-unknown`, then from the repository:

```sh
sh wasm-core/build.sh
(cd wasm-core && cargo test --locked)
node --test test/world-wasm.test.mjs
node scripts/bench-world-wasm.mjs --output wasm-core/bench/node-wasm.json
node scripts/bench-world-wasm.mjs --browser --output wasm-core/bench/chromium-wasm.json
(cd wasm-core && cargo run --locked --release --bin bench-world -- ../fixtures/example-world.wld > bench/native-rust.json)
```

The build script changes into the crate, so its `.cargo/config.toml` memory/stack
limits apply. Do not replace it with a repository-root `cargo --manifest-path`
invocation that omits those linker flags. The crate has no registry dependencies.
The fixture is the actual 12,512,653-byte, 8400×2400 v315 world, SHA-256
`d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab`.

Outputs:

- `wasm-core/dist/exploretv_wld_core.wasm`
- `wasm-core/dist/build-info.json`: Rust version, source and binary SHA-256,
  artifact size, target, ABI and verified memory limit

The WASM tests require the real compiled artifact; missing binary does **not**
become a skipped test or a mocked decoder. They compare every field and canonical
raw byte in 28 real-map rectangles, all 8,401 column offsets, frame tables, source
metadata, fragment roundtrip, all flags/slopes/liquid types, signed frames,
reserved bits, RLE forms, truncation, bounds, memory ceilings, disposal, 400
deterministic byte mutations and 24 mixed-column generated worlds. They do
not claim every expanded tile of the 20,160,000-cell real map was compared.

## JS integration

```js
import { loadWorldEngine } from "./core/world-wasm.mjs";
const engine = await loadWorldEngine("/wasm-core/dist/exploretv_wld_core.wasm");
const world = engine.openWorld(bytes);
const region = engine.extractSceneRegion(world, rect, 12);
// Before replacing or closing this world:
engine.disposeWorld(world);
```

`engine.backend` is `rust-wasm` or `javascript`; fallback additionally has
`fallbackReason`. Missing WASM support, unavailable binary, CSP rejection and ABI
mismatch use the unchanged JS engine. Invalid WLD files still raise `FormatError`;
parser errors are not silently retried through a looser path.

Compilation is asynchronous and cached by the engine; each `openWorld` creates an
independent instance. Opening and extraction are synchronous after initialization.
For main-thread responsiveness on unusually large files, the caller can move the
engine into a Worker; this crate does not silently create workers.

The world object retains the same `bytes`, JS-owned `columns`, `important`,
`sections`, `treeContext`, `herbContext` and optional metadata as the JS world.
Existing JS lookup, fragment serialization and rendering need no data-model change.
`extractRegionWasm` accepts an ordinary JS world and falls back automatically.
After disposal the world remains readable using its JS data, and previously
returned regions remain valid. No detachable WASM memory views escape the adapter.

Treat the opened world's source bytes and index arrays as immutable. In particular,
do not modify the original input buffer or `world.bytes` after opening: WASM owns
an internal input snapshot while JavaScript readers reference the original buffer.
For edited data, open a new world. This matches the viewer's read-only source flow;
it is not a synchronization protocol for mutable source bytes.

## ABI 1 and limits

The module has no imports: no WASI, threads, atomics, shared memory, JS callbacks,
or dynamically generated JS. It exports owned-buffer operations rather than
accepting arbitrary host pointers:

- `prepare(byteLength) → inputPointer`; inspect `last_error`, then copy input
- `open_world() → errorCode`
- `meta_ptr`, `sections_ptr`, `columns_ptr`, `important_ptr`, `world_surface`
- `extract_region(x,y,width,height) → errorCode`
- `output_ptr`, `output_len`, `release`
- `abi_version() = 1`, `cell_bytes() = 32`

Descriptor words: version, width, height, signed world ID bits, record count,
name offset/length, seed offset/length, section count, frame-table length,
column count, cell stride. Words and cells are explicitly little endian.
The adapter reacquires memory views after allocation/growth and copies metadata.

Each column-major cell is exactly 32 bytes:

| Offset   | Meaning                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| 0–1      | flags: active/red/blue/green/yellow/actuator/inactive/invisibleBlock/invisibleWall/fullbrightBlock/fullbrightWall/hasFrames |
| 2–3      | unsigned tile type                                                                                                          |
| 4–5, 6–7 | signed frame X, Y                                                                                                           |
| 8–9      | unsigned wall type                                                                                                          |
| 10–14    | paint, wallPaint, liquid, liquidKind, shape                                                                                 |
| 15       | canonical raw record length                                                                                                 |
| 16–31    | canonical raw bytes, then zero padding                                                                                      |

The repeat bits are cleared only in the copied canonical record. Unknown header
bits remain unchanged. Repeated tile results have independent raw-byte arrays.

Limits: 64 MiB input, 24 million tiles, maximum 10000×5000 world dimensions,
4096 frame types, 32 sections, 4096 bytes per header string, 512 per rectangle
side and 65,536 selected cells. WASM linear memory is hard-capped at 128 MiB per
instance; the linked stack is 1 MiB and packed rectangle output is at most 2 MiB.
Large inputs do not allocate a dense world grid. Multiple concurrently retained
worlds still consume multiple instances, so the app must dispose replaced worlds.
Direct ABI rectangles also reject wrapping coordinates and budgets. Failed
requests clear old output. A failed open cannot retain a previous valid world.

## Browser and WeChat boundary

Use `application/wasm` for the one fixed binary path. The viewer's restrictive
CSP must explicitly permit WASM compilation; the narrow directive is
`script-src 'self' 'wasm-unsafe-eval'`, not general `unsafe-eval`. Keep the permission limited to this application when WebAssembly is enabled.

The standalone Chromium benchmark measures the compiled module independently of
viewer integration. Passing it alone is not evidence that the viewer loaded WASM.
The integrated viewer must additionally verify backend state, actual binary fetch,
world replacement/disposal and fallback with its real CSP and routes.

A WeChat mini-program may use `WXWebAssembly` with a packaged binary and different
loading rules. This adapter does not claim to implement that platform loader.
It defaults to JavaScript when standard `WebAssembly` is unavailable. No WeChat
real-device test has been performed; H5/Node verification is not a real-device
compatibility claim.

## Benchmarks and interpretation

`wasm-core/bench/js-baseline.json` was captured before Rust implementation.
The post-build Node/Chromium scripts alternate 9 opens and 15 extractions per
rectangle, report all raw timings, and use a warm median excluding the first two.
They check actual-field/byte equality before timing each real-world rectangle.

WASM end-to-end open includes instance creation, allocation, the complete input
copy, Rust parsing/indexing, JS metadata copies and optional scene metadata.
Extraction includes Rust work **and** conversion to all JS tile objects and
independent raw arrays. Compilation/probe and browser asset fetch are reported
separately. `worldWasmStats(world)` exposes the phase timings and memory use.

Native Rust timing has no JS input transfer, JS output materialization or browser
runtime overhead. It is reported separately and must not be described as browser
speed. Results are environment-specific microbenchmarks, not a guarantee for every
map/device or a measured acceleration of full-world rendering/export.

### Local verification snapshot (2026-10-05)

The first post-build run on Node v24.19.0 measured warm medians:

| Operation               | JavaScript | WASM including JS transfer/conversion | Speedup |
| ----------------------- | ---------: | ------------------------------------: | ------: |
| Open real 12.5 MB world |  784.02 ms |                             104.83 ms |   7.48× |
| (4000,400), 128×128     |    4.41 ms |                               3.36 ms |   1.31× |
| (2000,1000), 256×256    |   38.91 ms |                              15.49 ms |   2.51× |
| (7000,2100), 128×128    |   14.71 ms |                               3.41 ms |   4.31× |

The separate native Rust median open was 66.40 ms. This is **not** a browser
result. The complete machine-readable timings, phases and artifact hash are in
`wasm-core/bench/node-wasm.json` and `native-rust.json`.

## Verified independent Chromium CI result

[Actions at 63b9eb4](https://github.com/Live-yum/exploreTV/actions/runs/37274206922)
rebuilt the committed artifact byte-for-byte and ran the real module in Chromium
145.0.7632.6, separately from the product viewer. Warm end-to-end medians:

| Operation | JavaScript | WASM, including copies and JS output | Ratio |
| --- | ---: | ---: | ---: |
| Open actual world | 477.90 ms | 73.30 ms | 6.52× |
| (4000,400), 128×128 | 1.20 ms | 1.20 ms | 1.00× |
| (2000,1000), 256×256 | 20.40 ms | 8.60 ms | 2.37× |
| (7000,2100), 128×128 | 7.70 ms | 2.30 ms | 3.35× |

These are parser/extraction measurements, not end-to-end scene drawing or full-PNG
export speedups. Compilation and fetch are separately recorded in
`wasm-core/bench/ci-wasm-chromium.json`. The same CI's Node run showed one small
shallow rectangle slower with WASM (2.36 ms JS, 3.76 ms WASM), so acceleration is
not universal. See `ci-wasm-node.json` for all samples. Hardware, browser, JIT and
allocation behavior affect results; these measurements are not mobile guarantees.
The integration uses the compiled core in the standalone viewer and the Vue H5
fragment page. The standalone server permits only the fixed WASM binary URL and
adds the narrow `wasm-unsafe-eval` CSP token; it does not permit general
`unsafe-eval`. `?engine=javascript` forces the original standalone reader for
comparison. Diagnostics report the active backend and fallback reason.

WASM loading/compilation failures retain the JavaScript path. Malformed worlds
are rejected without silently switching decoders or discarding the last valid
world. World replacement and fragment-only imports release WASM handles; emitted
fragments keep independent raw Tile bytes. The mini-program build explicitly
keeps the JavaScript reader, without assuming `WXWebAssembly` has the standard
browser API. Actual WeChat-device WASM loading remains unimplemented/unverified.

The integration adds browser checks at DPR 1 and 2 for a real binary response,
active backend, byte-identical Canvas output versus forced JS, repeated imports,
invalid-world rejection and missing-binary fallback. See the corresponding
exact-head Actions result for execution evidence; implementation alone is not
browser acceptance.
