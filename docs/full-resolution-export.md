# Full-resolution world export

`scripts/export-world.mjs` exports the entire supported world scene at **16 pixels per world tile**, including all pixels between viewports. It writes one PNG as a stream. It uses the same original renderer as the small panorama and does not introduce additional game-object support.

For an 8400×2400 world, the output is **134400×38400 pixels**, or 5,160,960,000 pixels. The uncompressed RGBA data is 20,643,840,000 bytes, but the exporter never writes a raw file of that size or allocates a canvas for the whole image.

## Run

After `npm ci`, supply a supported world file and a local directory of authorized RGBA8 PNG atlases:

```sh
node --expose-gc scripts/export-world.mjs \
  fixtures/example-world.wld example/assets \
  artifacts/full-resolution.png \
  --tiles artifacts/full-resolution-tiles
```

The world and texture paths are inputs, not a guarantee that those files are included in a particular checkout. Supply your own authorized textures if the asset bundle is unavailable. Exporting a local file does not upload or publish it. Redistribution permission for game artwork must be verified separately.

All three positional paths are required. The final PNG and optional tile directory must not already exist; choose new paths for another export. The PNG must be outside the final tile directory. The output's parent directories are created as needed.

`--tiles` requires a directory argument. It writes ordinary-size PNG pieces and a manifest in addition to the single full-resolution PNG. This is useful because the full image exceeds many image viewers' dimension, pixel-count, or memory limits. A standards-valid PNG does not imply that a browser, image editor, or phone can display it. Compatibility pieces have dimensions at most 4032×512 pixels, and use the same rendered pixels as the stream.

## Options

| Option                         | Meaning                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `--tiles <directory>`          | Also write PNG pieces and their exact pixel placement manifest                       |
| `--band-tiles <1..32>`         | Height of the in-memory full-width band; default 16 tiles, or 256 pixels             |
| `--chunk-tiles <1..252>`       | Width of each rendered piece; default 128 tiles, or 2048 pixels                      |
| `--region <x,y,width,height>`  | Export a smaller rectangle in world tile coordinates, for a pilot or selected region |
| `--expect-world-sha256 <hash>` | Require the exact 64-character hexadecimal SHA-256 of the input world                |
| `--input-encoding <encoding>`  | `tconvert-game-raw` by default, or `standard-straight` for matching RGBA8 inputs     |
| `--compression-level <0..9>`   | zlib compression level; default 6                                                    |
| `--help`                       | Print usage without reading or writing files                                         |

Omitting `--region` exports the entire world. A region export is explicitly marked as such in its report. There is no scale or downsampling option: output remains 16 pixels per tile.

Compatibility output is limited to 100,000 pieces so the manifest stays bounded. Increase the band or chunk size if your settings exceed that limit; the default large-world export uses 9,900 pieces.

For example, first measure a representative strip from your own world:

```sh
node --expose-gc scripts/export-world.mjs \
  /path/to/world.wld /path/to/authorized-pngs \
  artifacts/pilot.png --region 0,640,8400,32
```

Use coordinates and dimensions that fit the input world. PNG size and export time depend on the world's texture complexity, empty space, compression level, and whether compatibility pieces are also written. A pilot estimates them; it does not guarantee the full export's size or duration.

## Streaming and memory bounds

The exporter reads the world's validated column index and builds sparse RLE row checkpoints, allowing scanline-order access without repeatedly decoding entire columns. Only the currently rendered region, native canvases, bounded texture/frame caches, and one RGBA band are needed.

For the 134400-pixel-wide example, the default band is 134400×256×4 = **137,625,600 bytes**, about 131.25 MiB. Increasing `--band-tiles` to 32 doubles that band allocation. The renderer adds a two-tile halo to each piece so wall overlap and neighbor framing are preserved, then copies only the non-overlapping core into the band. PNG pieces contain the same core pixels. The native rendering canvas is bounded by the configured piece width and band height, never by the world's full pixel dimensions.

The PNG writer uses RGBA8, scanline Sub filtering, streaming zlib compression, bounded IDAT chunks with CRCs, and writable-stream backpressure. It verifies each band's byte length and rejects too many or too few rows. The final byte count and SHA-256 refer to the encoded PNG, not the raw pixel stream.

Other parser, PNG-input, frame-cache, and texture-cache bounds remain those described in [the overview documentation](full-world.md). Node/native allocator overhead can exceed the visible band/cache sizes; the export report includes sampled RSS and the operating system's peak RSS. `--expose-gc` permits garbage collection between bands.

## Outputs and completion

For an output named `artifacts/full-resolution.png`:

- `full-resolution.png` is the single full-resolution image.
- `full-resolution.png.json` records exact dimensions, rows, encoded bytes, output SHA-256, input world SHA-256, loaded texture hashes, executed source-code hashes, tile support lists, draw/omission counts, timing, and memory measurements.
- `full-resolution.png.progress.json` records the latest completed band and changes to `done` only after the PNG has finished.
- The optional tile directory contains PNG pieces plus `manifest.json`. Each entry has its pixel rectangle relative to the export origin, original world rectangle, byte count, and SHA-256. The manifest also records the full pixel dimensions and world origin.

The renderer verifies that every world cell in the export rectangle is processed, every pixel row is written, and every planned draw command is drawn or has exactly one recorded failure. Tile pieces collectively cover the whole image exactly once; edge pieces can be smaller.

A PNG is written to an exclusively created adjacent `.partial` file and becomes the final filename only after complete row-count validation and stream completion. Cancelling with Ctrl-C or terminating through the supported abort signal removes that partial file and the exporter's own temporary tile directory. Existing final outputs are preserved. The progress JSON remains and records an aborted status. A hard process or machine crash can leave partial files for manual inspection/removal; they are not complete exports. There is no resume option.

## Fidelity and compatibility

This is full-resolution static texture rendering, not a game screenshot or a guarantee that every Terraria feature is implemented. Ordinary blocks and walls retain approximate adjacency, cross-material merges and random variants are not reproduced, and dynamic lighting/background scenery/NPCs/particles are omitted. Supported liquid textures are frozen approximations. Unsupported tile types, liquid neighborhoods, missing PNGs, invalid crops, and unsupported effects appear in the report. Increasing export resolution does not fill these gaps.

The separate overview coverage mask is useful when inspecting omissions spatially. The full-resolution export's counts provide the same supported-path accounting without embedding misleading replacement textures in the image. Black pixels can be genuine empty space or an omitted feature.

## Verification

Verify an actual export without decoding the full image into memory:

```sh
node scripts/verify-export.mjs artifacts/full-resolution.png --tiles artifacts/full-resolution-tiles
```

This writes `full-resolution.png.verification.json`. Use `--report <path>` to choose another report path. The verifier checks every PNG chunk CRC, streams all IDAT data through bounded 1-MiB decompression chunks, validates filter values and the exact declared scanline byte/row count, computes the encoded SHA-256, and compares the neighboring export report when present. For pieces, it checks each file's hash, size, header dimensions, and manifest coordinates, then verifies exact one-time coverage with a one-byte-per-world-cell mask. It does not allocate the full-resolution image or decode all piece pixels. PNG chunks, encoded inputs, manifest size, piece count, and piece file sizes have explicit verification budgets.

```sh
node --test test/png-stream.test.mjs test/export-world.test.mjs test/full-world-cli.test.mjs
```

The tests use synthetic worlds and artwork. They compare streamed pixels against an independently assembled, single-region render; reconstruct the full image from its pieces; verify exact one-time coverage across odd chunk/band edges; test RLE records crossing checkpoint boundaries; exercise small images and real-world PNG width; and verify malformed input, incomplete rows, cancellation, partial cleanup, and output hashes. No giant canvas or game artwork is needed for these tests.

## GitHub Actions download

The `Export full-resolution example` workflow rebuilds the authorized bundled example. An explicit `[export-full]` marker in the PR head commit message starts the expensive export; ordinary commits only run a small request check. `workflow_dispatch` is also supported once this workflow is available on the repository default branch.

The job verifies the pinned world and texture hashes, applies a 45-minute export limit, a 2 GiB sampled RSS limit and a 6 GiB output limit, and requires 8 GiB free disk before starting. The entire job has a 60-minute timeout. It streams a second independent pass over the completed PNG to verify chunk CRC, all inflated scanlines, dimensions and SHA, then verifies every compatibility tile and its exact layout.

Successful runs provide separate `full-resolution-panorama`, `full-resolution-tiles` and `full-resolution-verification` artifacts. Download from the run's Artifacts section; GitHub may require signing in. Artifacts expire after 7 days. They are not a GitHub Release or a hosted viewing site. The panorama can exceed normal image-viewer limits; use the runtime world viewer for navigation and the ordinary-size pieces for compatible image tools.
