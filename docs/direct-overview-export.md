# Direct panorama: bounded memory and time

`export:overview` reads a `.wld` and real PNG textures directly. The bundled
8400×2400 world produces **8400×2400**, with every source tile covered. It does
not first write a 134400×38400 image or 9,900 full-detail pieces.
`export:full` still supplies the unchanged 16-pixel-per-tile output.

The current acceptance limits are **500,000,000 bytes total generation RSS** and
**600 seconds cold end-to-end**, with **less than 300,000,000 bytes preferred**. MB here is
decimal, not MiB. The preferred target is distinct from the hard limit. Results
must be measured on the actual machine; there is no universal runtime promise.

## Run

```sh
npm ci --ignore-scripts
npm run export:overview -- \
  fixtures/example-world.wld example/assets artifacts/world-overview.png \
  --expect-world-sha256 d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab
```

The npm command starts Node with `--expose-gc --max-old-space-size=48
--max-semi-space-size=4`. For direct invocation, include those same flags:

```sh
node --expose-gc --max-old-space-size=48 --max-semi-space-size=4 \
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
| `--band-tiles <1..128>`          | Render band height, default 48                       |
| `--chunk-tiles <1..252>`         | Render chunk width, default 120                      |
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

- The overview caches exact prepared frames, up to 2,048 frames / 2 MiB pixel
  storage. Native object overhead is additional. Source registration, dimensions,
  encoding, paint and vertex effects participate in keys; live borrowers pin
  frames until done. Private per-plan frame keys are interned once.
- Raw paint 0/31 is already an identity in the premultiplied shader contract.
  Redundant shader work and unused raw-mode scratch canvases are skipped.
- Static planner families use one exact numeric type-bitmask lookup per active
  tile to avoid calling unrelated handlers and allocating their option objects.
  Family membership comes from the existing exported type lists; precedence,
  overlapping families, malformed IDs and failure paths are unchanged.
- Immutable PNG snapshots (8 MiB / 512 entries) retain stable source/frame
  identities while a separate 8 MiB raw atlas LRU decodes on demand. A plan
  borrows compressed descriptors, not every decoded atlas. Active snapshots have
  a hard 32 MiB / 512-identity cap, checked before bounded file reads; failures
  unwind the whole borrow. Retained and active allocation totals are reported.
- Repeated IDAT streams use a 512-entry SHA-256 acceptance cache and bounded
  native inflation. Every distinct stream first passes the original strict
  validator, including its 4,096-block limit. Reference-valid streams rejected
  by native zlib remain on the reference path. CRC, dimensions, ordering and
  filters are checked on every decode. The native output slab reserves one
  extra byte to avoid an exact-fill EOF check allocating a second slab.
- Node can reconstruct PNG rows in that same freshly inflated backing buffer,
  eliminating a second atlas-sized allocation. Encoded-input aliases, offset
  views and oversized pooled slabs fall back to copying. Cache accounting uses
  the entire retained backing allocation. Browser/WeChat defaults still copy
  and have no Node dependency.
- Halo tiles continue to participate in planning, validation and logical command
  accounting. Only native draws whose entire positive-size destination lies
  outside the exported core, with a conservative one-pixel boundary margin,
  are omitted. Overhanging, clipped, translucent and additive sprites that can
  touch the core retain the ordinary compositor.
- Sparse RLE checkpoints and bounded per-region cursors avoid repeatedly decoding
  whole columns for neighboring tiles. Read-only parsing can omit unused raw
  record copies. The fragment path still keeps its original raw records.
- The complete 1,969-origin / 82,467-command example waterfall registry streams
  each successful origin directly into exact typed columns. A numeric stable
  sort preserves layer/texture order without retaining the whole object scene
  and a second whole-world query copy. Templates and a spatial index remain. Its
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
- The image-only CLI skips unused system-font loading. Programmatic imports
  leave their process's font policy unchanged.
- Native surfaces are reused and sized to the exported core, while the complete
  ten-tile halo still participates in planning. Integer translation preserves
  draw coordinates and blending. Proven blank/fully replaced cores avoid a
  needless full-detail readback; exact opaque means are still applied afterward.
- Chunk-local plans and readbacks leave scope before collection. Minor and major
  GC alternate, with a **macrotask** yield after every chunk for N-API finalizers;
  bands also get a major collection. GC and finalizer time are reported. Dropping
  the macrotask or calling `clearAllCache()` alone did not bound native buffers.

Independent averaging of translucent textures is not used: it would change
occlusion. All composited source pixels contribute to exact aligned area means
in the same encoded-sRGB byte space. Small detail can visually blend away at
this output scale; use `export:full` to inspect original pixels.

The output band is 8400×48×4 = **1,612,800 bytes**. RSS additionally includes
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

### Current memory optimization

The complete local candidate produced the same 8400×2400 PNG in **300.589 s**.
Its conservative complete-process peak was **282,091,520 B**, below the preferred
300 MB target. Exporter lifetime peak was 230,273,024 B; the native monitor,
Node harness and 1 MiB reporting reserve are included in the larger number.
The unchanged `18f8a8d` baseline measured 316.887 s / 447,864,832 B on this host.
Other local engineering tests contended for CPU during this batch, so these wall
times are observations, **not a controlled speedup claim**. `/proc` exposed a
namespace mismatch locally; the report explicitly marks simultaneous sampling
unavailable and uses Linux `wait4` whole-lifetime peaks rather than a renderer-only
snapshot. Node 24.19.0 / Linux x64 / Xeon Platinum 8573C, 9 available CPUs.

Every one of the **20,160,000 pixels**, all **384 textures**, **17,624,141 logical
commands** and **13 independent real regions** passed. Canonical RGBA SHA-256:
`7564e85d94724f452cd76c03409fea512fb57966fb933303a6db832d4b86013e`.
The PNG also remained byte-identical in this run. Exact local reports, source
hashes, memory samples and phase counters are in the
[measurement summary](benchmarks/overview-memory-20261006.json).

CI now measures pinned `18f8a8d` and the candidate **sequentially on one runner**,
with identical installed dependencies and lockfile. Both start with empty
application caches and include startup through shutdown; OS file-cache state is
uncontrolled. Both must pass hard budgets and independent fidelity. Its
`sequential-comparison.json` reports measured runtime/memory changes, including
regressions, alongside the current head's ordinary cold benchmark and fidelity.
No CI result is implied by the local measurements above.

Setup-only profiling independently reduced waterfall peak RSS from 199.6 MB to
144.5 MB and time from 8.42 s to 7.22 s. All 82,467 commands, 1,969 memberships
and 39 whole/stripe queries matched the pre-edit reference. This setup-only
measurement is not substituted for complete-generation acceptance.

### Previous runtime optimization (`18f8a8d`)

A sequential fresh-process comparison on Linux x64 / Node 24.19.0 / Xeon
Platinum 8573C (9 available logical CPUs, one renderer) measured:

| Metric                             | Unchanged `4b28af7` |     `18f8a8d` |
| ---------------------------------- | ------------------: | ------------: |
| Startup through process exit       |           384.267 s |     300.762 s |
| Conservative complete-process peak |       443,600,896 B | 457,863,168 B |
| Raw texture loading/decoding       |             76.85 s |       13.02 s |
| Native draw stage                  |             90.59 s |       62.94 s |

That run saved **83.505 s / 21.7%**. Its application caches started empty; OS file
cache state was not controlled. Brief diagnostic tests also ran during the
baseline, but no other full render benchmark ran concurrently. These results
are not a universal latency promise or a cross-machine comparison. The measured
memory increase was 14.26 MB; the 500 MB hard limit passed, while the then-preferred
200 MB target and a strict five-minute goal were not met by this local run.

The candidate preserved all **20,160,000 pixels**, 17,624,141 logical commands,
384 source textures and thirteen independent real-region comparisons. The
validated-stream cache saw 380 first-use strict inflations and 9,715 native
repeats, with no evictions or fallbacks on this corpus. It culled 5,608,464 native
halo draws while keeping their necessary planning/validation context. Detailed
[measurement summary](benchmarks/overview-optimization-20261005.json) records the
source hashes and full-lifetime memory accounting. Same-head CI independently
rebuilds and verifies the full output.

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

Additional measured experiments for this optimization batch:

- Repeated decoding of the same 384-texture corpus took 0.223 s after strict
  first-use validation, versus 1.389 s with the original decoder. First-use
  optimized decoding took 0.704 s. Every raw byte, including hidden RGB and low
  alpha, matched the original. This is a decoder microbenchmark, not an export
  speedup; application caches still start empty in full acceptance runs.
- On the same 8400×128 region, conservative core-only native drawing reduced
  the draw stage from 7.08 s to 5.22 s. Whole ROI time was 34.63 s versus 32.58 s,
  including the unchanged world-wide setup. Encoded PNGs were identical.
- Skipping per-command canvas save/restore was rechecked: draw time was 7.08 s
  versus 7.05 s, with no useful repeatable benefit. That change was removed.
- Re-encoding the same verified 8400×2400 pixels: PNG levels 1/3/6/9 took
  1.145/1.322/1.969/12.634 s and produced 19,265,785/18,235,416/16,984,482/
  16,860,515 bytes. Level 1 saved less than one second but added 2.28 MB; level 9
  saved only 124 KB at a large time cost. Default level 6 is retained. PNG
  compression is not the principal export bottleneck.

Do not divide timings from different machines/settings into a controlled speedup
claim. The current below-300 MB preference must be reported separately even when the 500 MB
hard limit and ten-minute limit pass.

## Verification

The PNG report records source/input/384 texture hashes, complete extent, cells,
rows, commands and omissions, cache counters, region/GC/finalizer phase times, per-band heap/external/RSS
samples, runtime/CPU details and OS RSS. `.progress.json` records terminal state. No full-resolution feature or
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
`direct-small-panorama-<commit>` for seven days, including both runs’ JSON
reports, the candidate PNG and available diagnostics
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
runtime and memory measurement. The preferred below-300 MB result is explicitly
reported, never inferred from the hard-limit pass.
