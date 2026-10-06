# Full-world texture overview

The command-line renderer reads a supported `.wld` file, draws the supported scene from actual PNG sprite crops in bounded chunks, and saves a static, fullbright panorama. It uses the same original rendering core as the viewer. It does not open or change the viewer application.

## Inputs and redistribution

Supply your own world file and authorized PNG textures. Having a local copy of Terraria or a texture exporter does not by itself establish permission to redistribute the game's artwork. This tool does not download, upload, publish, or copy an asset bundle into the project. Keep supplied PNGs local unless the relevant redistribution permission has been verified.

The planned example-map location is `fixtures/example-world.wld`. That path is a packaging plan, not a promise that the file is already included. Until it is provided, pass any supported world file you are authorized to use.

The texture directory is flat and uses these case-sensitive names:

- `Tiles_<id>.png` for foreground tile atlases
- `Wall_<id>.png` for wall atlases
- `water_0.png`, `water_1.png`, and `water_11.png` for the supported water, lava, and honey atlases

PNG inputs must be non-interlaced RGBA8 files accepted by the bounded PNG reader. Each encoded file is limited to 8 MiB, each side to 4096 pixels, and decoded RGBA to 16 MiB. The source bytes are validated before the native image decoder is called.

## Run

Install the project's dependencies first with `npm ci`. All three paths are required; there are no machine-specific defaults.

```sh
node --expose-gc scripts/render-full-world.mjs \
  /path/to/world.wld \
  /path/to/authorized-pngs \
  artifacts/world-preview
```

Start with a fast RLE inventory to discover which atlas files the supported render paths need:

```sh
node scripts/render-full-world.mjs \
  /path/to/world.wld /path/to/authorized-pngs artifacts/world-preview \
  --inventory-only
```

The inventory counts repeated records without allocating an object for every world cell. `requiredTextures` is ordered by cell count and reports whether each named input exists. A liquid atlas's inventory count is an upper bound: some liquid neighborhoods will be unsupported during scene planning.

Optional details use world tile coordinates and retain 16 pixels per tile:

```sh
node --expose-gc scripts/render-full-world.mjs \
  /path/to/world.wld /path/to/authorized-pngs artifacts/world-preview \
  --detail base:100,100,128,64 \
  --detail cave:400,500,192,128
```

Use rectangles appropriate to your world. Each side must be 1–252 tiles, the rectangle must fit entirely inside the world, and at most 16 details are accepted. Names must contain only letters, digits, underscores, and hyphens, beginning with a letter or digit; names are unique ignoring case. Invalid rectangles are rejected before output is created.

Other options:

- `--expect-world-sha256 <64 hexadecimal characters>` refuses a different world before creating output.
- `--input-encoding tconvert-game-raw` is the default. It preserves raw PNG channels for the game's premultiplied texture representation and paint formulas.
- `--input-encoding standard-straight` is for ordinary straight-alpha RGBA8 PNGs. Choose this only when it describes your exporter; the renderer cannot infer channel association from the filename.
- `--help` prints usage without reading or writing files.

## Outputs

All output stays in the directory you specify. Reusing that directory overwrites the named output files; use a new directory to preserve an earlier run.

| File                           | Meaning                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `full-world.png`               | One output pixel per world tile, reduced from actual 16-pixel sprite rendering through four successive 2× bilinear reductions |
| `full-world-detail-<name>.png` | Optional native-resolution detail                                                                                             |
| `full-world-inventory.json`    | Source dimensions, SHA-256, RLE counts, tile/wall/liquid inventory, and required texture filenames                            |
| `full-world-coverage.png`      | Transparent, coordinate-aligned omission mask                                                                                 |
| `full-world-coverage.json`     | Draw counts, omissions by type or reason, resource hashes, source-code hashes, details, memory measurements, and limitations  |
| `full-world-progress.json`     | Latest completed vertical strip, or final completion status                                                                   |

The renderer completes even when some textures or scene features are unavailable. A successful exit means processing finished; inspect the coverage report before treating the image as sufficiently complete for your purpose. Missing resources are never replaced by invented sprites or palette colors.

The coverage PNG is indexed-color and has one pixel for each world tile. Palette indices are lossless bit flags: `1` unsupported tile, `2` unsupported liquid neighborhood, `4` missing texture, `8` invalid crop, and `16` unsupported paint/channel effect. Flags can combine. Magenta indicates unsupported tiles, amber indicates unsupported liquid neighborhoods, and red takes priority for resource/crop/effect failures. Transparent pixels have no flagged omission, but still carry the approximation limits below. A black region in the panorama may be empty space or an omitted feature; consult the mask.

SHA-256 hashes identify the input world, textures actually loaded, current renderer, entry script, and local rendering dependencies. The report also captures the actual tile support lists. It does not infer or claim a Git commit identity. No world name, private filename, selected detail rectangle, or historical source hash is hardcoded into the renderer.

## Bounds and fidelity

The WLD reader enforces its existing limits: at most 64 MiB input and 24 million world cells, with bounded dimensions and supported format versions. The panorama uses four RGBA bytes per world cell, plus a one-byte-per-cell coverage mask. It never allocates a full-resolution canvas for the entire world: an 8400×2400 world produces an 8400×2400 overview rather than a 134400×38400 canvas.

Main rendering uses 128×128-tile chunks with a ten-tile visual halo. Only a narrow group of decoded columns is retained, and each full-resolution chunk is at most 2112×2112 pixels. Optional details can use a bounded 4096×4096 intermediate canvas. Sprite conversion is partitioned into ordered batches below the core's 512-frame / 8-MiB limit; prepared frame canvases are disposed after each batch. The source asset cache has an 80-MiB retention target and can temporarily exceed that target while loading the current chunk's working set. The report records the observed cache peak and sampled process RSS; these are measurements, not a hard process-memory guarantee. `--expose-gc` permits collection between vertical strips.

The final report asserts that every world cell was processed, unsupported tile counts agree with the independent RLE inventory, and every planned command was either drawn or assigned exactly one reported failure. Halo cells are excluded from whole-world and detail omission counts.

This is a static unlit texture preview, not a pixel-exact game screenshot. Blocks and walls use approximate adjacency. Cross-material merges, grass transitions, random variants, background scenery, particles, NPCs, and wiring overlays are not reproduced. Liquids are frozen flat-fill approximations; unsupported neighborhoods and shimmer are reported. Invisible blocks and walls remain hidden. These limitations also apply to transparent pixels in the coverage mask.

## Regression check

```sh
node --test test/full-world-cli.test.mjs
```

The focused checks create their own tiny world and synthetic gradient atlas in a temporary directory. They cover CLI validation, input hash rejection, out-of-world details, inventory-only operation, chunk-boundary consistency, missing/unsupported-cell accounting, output dimensions, and source hash reporting without using game artwork or a private world.
