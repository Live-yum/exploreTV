# Direct small panorama export

The full-detail and small panoramas are separate outputs. `export:full` still
exports 16 pixels per world tile. `export:overview` reads a `.wld` and the real
PNG textures directly and writes a small full-extent panorama, defaulting to
one pixel per world tile. An 8400×2400 world produces **8400×2400**, without
first creating a 134400×38400 PNG or 9,900 full-detail PNG pieces.

## Run

```sh
npm ci --ignore-scripts
node --expose-gc scripts/export-overview.mjs \
  fixtures/example-world.wld example/assets artifacts/world-overview.png \
  --expect-world-sha256 d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab
```

Or use `npm run export:overview -- <world.wld> <png-directory> <output.png>`.
The example paths are for the authorized bundled example; your own local
world/texture paths are supported. Inputs remain read-only and no export is
uploaded or published by these commands. Original artwork rights and the
existing [asset notice](../example/assets/NOTICE.md) still apply.

Choose a fresh output filename; existing final and partial PNGs are refused.
The parent directory is created. A final PNG appears only after all rows have
been written. Ctrl-C/SIGTERM removes this attempt's partial PNG and records an
aborted progress state. A machine crash can leave a `.partial` file; it is not
a finished panorama. There is no resume option.

## Options

| Option                           | Meaning                                                      |
| -------------------------------- | ------------------------------------------------------------ |
| `--pixels-per-tile <1\|2\|4\|8>` | Output scale; default 1                                      |
| `--band-tiles <1..32>`           | Render band height; default 32 world tiles                   |
| `--chunk-tiles <1..252>`         | Render chunk width; default 128 world tiles                  |
| `--region <x,y,width,height>`    | Optional crop in world tiles; omitted means the entire world |
| `--expect-world-sha256 <hash>`   | Refuse a different input file                                |
| `--input-encoding <encoding>`    | `tconvert-game-raw` (default) or `standard-straight`         |
| `--compression-level <0..9>`     | PNG compression level; default 6                             |
| `--help`                         | Display usage without opening files                          |

Integer scales divide 16 exactly, so every reduction block aligns to a world
tile and chunk boundaries need no interpolation. Fractional scales and arbitrary
pixel dimensions are intentionally unsupported. Use the unchanged
[full-resolution exporter](full-resolution-export.md) for 16 px/tile, optional
full-detail compatibility pieces, and full-resolution pilot regions. The
small exporter rejects `--tiles` to avoid accidentally generating large files.

## Fidelity and bounded memory

The small exporter uses the **same compositor** as the full-resolution path:
original atlases, stored frames, walls, paint, source alpha encoding, frozen
liquids, and the explicit whole-world static-waterfall registry. It renders
each bounded region with the same ten-tile halo at 16 px/tile. After compositing
to the same opaque black scene, it averages every 16×16 source pixel block
(default scale), immediately discards that high-resolution region, and streams
the reduced band to the final PNG.

This is exact aligned box/area reduction in the composited encoded-sRGB byte
space. Accumulation is premultiplied-alpha aware, with one rounding step; the
current fullbright compositor produces alpha 255 everywhere. Every thin line
and transparent source pixel contributes to the final pixel according to its
composited coverage. Small features may still visually blend away at overview
scale. No map-color palette, representative source-pixel sample, or reduced
texture atlas replaces the detailed composition.

For the example, the output band is just **8400×32×4 = 1,075,200 bytes**. The
renderer still needs a bounded high-resolution core/halo canvas, sparse world
index, decoded assets and frame caches. It does not allocate a full-world
high-resolution canvas or a full-width high-resolution band. Native allocator
and renderer overhead mean RSS is higher than the output band size; measured
peak RSS is reported rather than inferred from that buffer.

The full-detail renderer still does its work. This path eliminates the huge
PNG's compression, disk storage and subsequent read/decode, plus optional piece
encoding, but does not promise a proportional rendering speedup. The default
32-tile bands differ from the full export's 16-tile default, also affecting
halo work. Do not treat measurements on different machines or different settings
as a controlled speed benchmark.

All documented game-rendering approximations remain: frozen fullbright preview,
terrain/wall adjacency approximations, no dynamic game lighting, NPCs, particles
or live background scenery. Reduction adds no supported objects. Missing atlases,
invalid crops, unsupported tiles/liquid neighborhoods and effect failures remain
visible in the report. Black can represent empty space or an omitted feature.

## Provenance and verification

An output `world-overview.png` has:

- `world-overview.png.json`: full input extent, input/source/texture hashes,
  output SHA-256, render and output scales, reduction method, complete command
  and omission counts, processed cells, rows, chunks, buffer sizes, elapsed time,
  reduction time (included in render time), compression time and peak RSS.
- `world-overview.png.progress.json`: last completed band and terminal state.

Basic verification streams every PNG CRC, hash and inflated row without
allocating its complete image:

```sh
node scripts/verify-export.mjs artifacts/world-overview.png
```

For ordinary-size small outputs (up to 128 MiB decoded), independently compare
bounded full-detail renders against the small panorama:

```sh
node scripts/verify-overview.mjs \
  fixtures/example-world.wld example/assets artifacts/world-overview.png --example
```

This writes `.fidelity.json` in addition to `.verification.json`. It checks all
output alpha values, exact extent/cell/row counts, current source-code hashes,
every recorded texture hash, and thirteen real patches:
all four corners, center, render seams, surface/forest, water, lava, honey, rain,
Shimmer and mixed half-bricks. Each patch is rendered as one bounded full-detail
image and area-reduced using a separately implemented pixel sum. All compared
bytes must match exactly. `--example` pins the public world and also requires
its known omission counts to remain zero; omit it for generic local worlds.
The whole-file PNG check covers all rows, while visual comparisons deliberately
remain bounded patches. This is a compositor regression baseline, not a
pixel-perfect running-game oracle.

Tests compare all four scales with full-export baselines, including odd world
sizes and band/chunk boundaries, alpha contracts, thin features, invalid flags,
full extent/crops and interrupted/duplicate exports:

```sh
node --test test/overview-export.test.mjs test/export-world.test.mjs test/png-stream.test.mjs
```

## Rebuild in GitHub Actions

`Export direct small panorama` is separate from `Export full-resolution example`.
A PR head commit containing `[export-overview]` requests the direct small rebuild;
ordinary commits skip that expensive job. Manual `workflow_dispatch` is supported
once the workflow exists on the default branch. It does not launch the full
export. The workflow has read-only repository permissions.

The job checks pinned resources, runs tests, exports the actual world, verifies
full PNG structure and the thirteen fidelity patches, and uploads
`direct-small-panorama-<commit>` containing the PNG and JSON reports. Budgets are
45 minutes for export, 2 GiB sampled RSS, 128 MiB output, and 512 MiB initial free
disk; the overall job has a 60-minute timeout. Artifacts expire after seven days.
This is neither a release nor a deployment.
