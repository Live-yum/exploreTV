# Direct panorama: bounded memory and time

`export:overview` reads a `.wld` and real PNG textures directly. The bundled
8400×2400 world produces **8400×2400**, with every source tile covered. It does
not first write a 134400×38400 image or 9,900 full-detail pieces.
`export:full` still supplies the unchanged 16-pixel-per-tile output.

The current acceptance limits are **500,000,000 bytes total generation RSS** and
**600 seconds cold end-to-end**, with **200,000,000 bytes preferred**. MB here is
decimal, not MiB. The preferred target is distinct from the hard limit. Results
must be measured on the actual machine; there is no universal runtime promise.

## Run

```sh
npm ci --ignore-scripts
npm run export:overview -- \
  fixtures/example-world.wld example/assets artifacts/world-overview.png \
  --expect-world-sha256 d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab
```

The npm command starts Node with `--expose-gc --max-old-space-size=96
--max-semi-space-size=2`. For direct invocation, include those same flags:

```sh
node --expose-gc --max-old-space-size=96 --max-semi-space-size=2 \
  scripts/export-overview.mjs world.wld textures output.png
```

Large programmatic overview exports also require that bounded Node configuration;
otherwise they fail before building the costly world-wide effect registry.
There is one renderer process, no renderer child processes and no parallel-worker
option. Native library threads are included in that process's RSS.

Inputs remain read-only and nothing is uploaded by the export. The bundled
world and 384 textures retain their existing [asset notice](../example/assets/NOTICE.md).
Choose a fresh output filename: existing final and partial PNGs are refused.
The final PNG appears only after every row is written. Ctrl-C/SIGTERM removes
this attempt's partial PNG and records an aborted progress state. A crash may
leave `.partial`; it is not a completed image. There is no resume mode. A late
budget failure may retain a complete PNG for diagnostics, but its aborted
progress sidecar prevents it from passing export verification.

| Option                           | Meaning                                              |
| -------------------------------- | ---------------------------------------------------- |
| `--pixels-per-tile <1\|2\|4\|8>` | Output scale, default 1                              |
| `--band-tiles <1..128>`          | Render band height, default 64                       |
| `--chunk-tiles <1..252>`         | Render chunk width, default 128                      |
| `--region <x,y,width,height>`    | Optional world-tile crop, default whole world        |
| `--expect-world-sha256 <hash>`   | Refuse a different world                             |
| `--input-encoding <encoding>`    | `tconvert-game-raw` (default) or `standard-straight` |
| `--compression-level <0..9>`     | PNG compression level, default 6                     |
| `--help`                         | Usage without opening inputs                         |

Integer scales divide 16 exactly; fractional scales and arbitrary dimensions are
unsupported. The overview rejects `--tiles`. Full-resolution export keeps its
original 16-row default, 32-row maximum and optional piece output. Different
worlds/scales/chunks can require more work; exceeding a resource limit is an
explicit failure, not a completed lower-quality panorama.

## Exact optimizations

The original scene planner, atlas crops, paint, alpha-over/additive blending,
frozen liquids, complete waterfall registry and ten-tile halo remain in use.

- The overview caches exact prepared frames, up to 1,024 frames / 2 MiB pixel
  storage. Native object overhead is additional. Source registration, dimensions,
  encoding, paint and vertex effects participate in keys; live borrowers pin
  frames until done. Private per-plan frame keys are interned once.
- Raw paint 0/31 is already an identity in the premultiplied shader contract.
  Redundant shader work and unused raw-mode scratch canvases are skipped.
- Raw PNG atlases are decoded once into raw RGBA when needed, without a duplicate
  native atlas image. A 16 MiB LRU bounds retained raw texture data. Standard
  straight-alpha input retains its ordinary native-image path.
- Sparse RLE checkpoints and bounded per-region cursors avoid repeatedly decoding
  whole columns for neighboring tiles. Read-only parsing can omit unused raw
  record copies. The fragment path still keeps its original raw records.
- The complete 1,969-origin / 82,467-command example waterfall registry is
  compacted into exact typed columns plus templates and a spatial index. Its
  numeric/index storage is 3,219,369 bytes. Query order, nested colors, field
  presence and numeric precision remain exact. The ordinary renderer/verifier
  can still use the original registry as an independent reference.
- At **1 px/tile only**, an aligned, unscaled, unclipped, unflipped final 16×16
  frame proven fully opaque after paint can supply its exact cached mean.
  Every later touching draw blocks unsafe use. A preceding command is omitted
  only when its entire destination is covered by proven cells. Transparency,
  alpha holes, additive effects, walls, liquids, slopes and overhangs otherwise
  use the original full-detail compositor before area reduction. Validation
  and complete logical command accounting remain intact.
- After each bounded chunk, explicit GC is followed by a **macrotask** yield so
  N-API ImageData finalizers run. GC alone in a microtask-only loop did not stop
  native readback accumulation. `clearAllCache()` did not solve that problem.

Independent averaging of translucent textures is not used: it would change
occlusion. All composited source pixels contribute to exact aligned area means
in the same encoded-sRGB byte space. Small detail can visually blend away at
this output scale; use `export:full` to inspect original pixels.

The output band is 8400×64×4 = **2,150,400 bytes**. RSS additionally includes
world/index data, effect registry, bounded detailed canvases, caches, V8 and
native allocator overhead. Buffer arithmetic alone is not a memory measurement.
The exporter checks OS peak RSS and elapsed time after chunks. CI additionally
monitors the exporter plus its harness and validates their conservative summed
OS peaks, including all native threads.

## Measurements and rejected approaches

Final acceptance evidence is the exact commit's `cold-benchmark.json` and
`.fidelity.json`, published by the direct-overview workflow. The former includes
process startup through shutdown, world read/parse, registry/index creation,
texture decoding, cold cache construction, composition, reduction and PNG write.
Dependency installation and separate correctness verification are excluded.
Application caches start empty; OS file-cache state is uncontrolled. No persistent
texture cache or separately claimed warm whole-world result is required.

Exploratory runs, **not current acceptance results**:

- Four render workers generated the complete image in 157.28 s on a Linux x64
  Xeon Platinum 8573C / Node 24.19.0 machine with 9 available logical CPUs, but
  used about 3.15 GB. This was rejected under the newer memory limit. Parallel
  export is not shipped as the default or a supposedly compliant option.
- An initial serial low-memory version took 671.85 s and peaked at 467,140,608
  bytes for the exporter alone. It missed the runtime target and left inadequate
  harness-memory margin. It is not a passing result.
- Both exploratory whole images matched all **20,160,000 pixels** of the earlier
  independent full-detail reduction. Canonical decoded RGBA SHA-256:
  `7564e85d94724f452cd76c03409fea512fb57966fb933303a6db832d4b86013e`.
  PNG file hashes can differ with compression/stream boundaries.
- A fully ordered cached tile-stack compositor was pixel-exact, but a real
  8400×128 ROI took 69.99 s versus 43.85 s for the simpler compact-registry path.
  It was rejected: key construction, cache misses and native readbacks outweighed
  fewer draw calls. The default keeps only the proven opaque-final shortcut.
- An isolated gcc `-O3` C reduction kernel took 4.24 ms for a real 16 MiB chunk,
  but subprocess plus pipe overhead raised it to 83.30 ms versus 19.01 ms for
  in-process JS (ten-run medians). Native subprocess reduction was rejected.
  Thirty-five BigInt-oracle cases covered all factors and alpha edge values.
- A linear JS reduction variant measured 16.08 ms and alpha-checked opaque JS
  22.48 ms. Reduction was a minor stage, so neither is added to the default.
- A new Rust/WASM reducer could not be built locally because the temporary
  compiler was no longer installed. Existing WASM copy timings alone are not a
  reducer benchmark. The existing decoder, committed module and CI Rust build
  remain unchanged; no unmeasured speedup is claimed.

Do not divide timings from different machines/settings into a controlled speedup
claim. The 200 MB preference must be reported separately even when the 500 MB
hard limit and ten-minute limit pass.

## Verification

The PNG report records source/input/384 texture hashes, complete extent, cells,
rows, commands and omissions, cache counters, phase times, runtime/CPU details and
OS RSS. `.progress.json` records terminal state. No full-resolution feature or
previously supported object is removed.

```sh
node scripts/verify-export.mjs artifacts/world-overview.png
node scripts/verify-overview.mjs \
  fixtures/example-world.wld example/assets artifacts/world-overview.png --example
npm test
```

`--example` requires the complete pinned texture set and original command counts,
zero known omissions, all pixel alpha values, and the **entire decoded pixel
hash**. It also independently renders thirteen real patches including world
corners, seams, trees, water, lava, honey, rain, Shimmer and mixed half-bricks.
Generic worlds can omit `--example`. Comparison decoding is bounded to 128 MiB;
larger outputs retain the streaming PNG verifier.

Tests cover all paint IDs, alpha edge values, clips, flips, overlaps, additive
channels, LRU ownership, source invalidation, RLE/checkpoint boundaries, compact
registry field/order equality, all output scales, odd seams, cancelled/duplicate
exports and lossless fragment records. This verifies a static compositor baseline,
not a pixel-perfect running-game oracle. Fullbright lighting, frozen effects,
approximate terrain/wall joins and omitted runtime scenery/NPCs remain documented.

## GitHub Actions

A PR head message containing `[export-overview]` requests the direct rebuild.
`[export-full]` remains separate; the giant export is not implicitly regenerated.
The workflow is read-only and uploads PNG and reports as
`direct-small-panorama-<commit>` for seven days, including available diagnostics
on failure. It does not merge, release, deploy or change credentials.

Generation fails acceptance at ≥600 seconds or a conservative sum above
**500,000,000 bytes**. A tiny C monitor uses Linux `wait4` for the exporter's
entire-lifetime OS peak, including shutdown; the monitor and Node harness peaks
are also included, plus a 1 MiB reporting-tail reserve. Their contemporaneous
process-tree RSS is sampled each second where `/proc` exposes a consistent
process namespace; unavailable sampling is explicitly marked and acceptance
still uses the conservative full-lifetime peak sum. Building the measurement-only helper
with the installed C compiler occurs before timing; the ordinary npm export
requires neither the helper nor a compiler. The exporter creates no children. There is a 128 MiB output guard
and a 512 MiB free-disk minimum. Verification runs after generation, outside its
runtime and memory measurement. The preferred 200 MB result is explicitly
reported, never inferred from the hard-limit pass.
