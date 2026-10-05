# Static special objects

The explicit allowlist is Lihzahrd Altar (237), Teleportation Pylon (597),
Master Trophy / relic (617), and Rainbow Boulder (711). The planner includes
their stored tile bodies and their visible sprite overlays. These objects are
never classified as particle-only, hidden, or empty successful plans.

## Source observations and snapshot

This is an original implementation based on the user-designated revision
`8255d34616c780af12079425ac92a0a7aed87d71` of
[TileDrawing.cs](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs).
Relevant locations are the special registration at 706–717 and 4284–4287,
rainbow geometry and drawing at 1699–1741 and 5005–5013, altar glow at
3492–3495 and orb at 8044–8047, base offsets at 5347–5360, and the relic/pylon
draw paths at 8758–8890. No decompiled implementation or game binary is bundled.

`STATIC_SPECIAL_OBJECT_SNAPSHOT` explicitly freezes visual time, tile animation
frame, tile frame counter, and altar rotation at zero. A separate static
mouse-text pulse is fixed at 255, rather than making the altar's visible glow
depend on an uninitialized UI byte. `options.mouseTextColor` can select another
byte-valued pulse. The existing unlit preview uses white ambient color.
Fullbright and invisible coating ownership remains attached to the commands;
this module does not compute dynamic lighting.

- The altar has six base cells, six unpainted `SunAltar` additive crops, and one
  26×26 `SunOrb` owned by its top-middle cell. The orb starts five pixels left
  and 49 pixels above that owner. Rotation is zero.
- Pylon bases keep their stored style and draw two pixels down. One 30×46
  crystal uses column `3 + style` in the 14×8 `Extra_181` atlas. Its frozen row
  is `floor(((originWorldX + originWorldY) % 64) / 8)`: resetting the animation
  counter does not remove this coordinate phase. The figure and six additive
  halo copies are centered at object-local `(24,24)`.
- Relic bases wrap stored X to 54 and Y to 144, with a two-pixel floor offset.
  Their 50×50 figure is row `storedOriginX / 54` in `Extra_198`, which has 28
  rows. The second 72-pixel direction group flips the figure horizontally.
  A figure and six halo copies are centered at `(24,24)`.
- Rainbow boulders retain per-cell 20-pixel height, 16/18-pixel width, and the
  right-column minus-one X offset. Only the top-left cell emits the three
  frozen red/green/blue halos. Each halo draws all four quadrants from the
  alternate X+38 mask using the origin's painted texture. The bottom halo
  source rectangles extend two pixels beyond the 38-pixel texture; separate
  one-pixel crops repeat its last row to implement point-clamp without an
  out-of-bounds read. No transparent placeholder is substituted.

Pylon and relic special figures use unpainted Extra textures, and their
visibility/fullbright control comes from the object's `(1,1)` child. Their
ordinary bases retain each cell's own paint. Altar overlays are unpainted;
rainbow halos use top-left paint. Source colors with alpha zero remain additive
colors and must go through the existing raw-channel frame preparation.

## Integration contract

`planStaticSpecialObject(region, x, y, tile, options)` returns `null` for an
unrelated type, `{ commands }` for a supported cell, or `{ unsupported }` with
a concrete reason. It does not mutate tiles, region state, options, or WLD
bytes. Known families reject unaligned/unknown frames, unsupported shapes,
missing/mismatched origin tiles, and missing/mismatched pylon/relic `(1,1)`
children. There is no generic object fallback.

Coordinates are relative to `region.rect`. The four-cell bounded halo is
accepted for `x/y`, including negative coordinates, provided world coordinates
remain nonnegative. Dependencies are read from region cells, `region.context`,
then `options.getWorldTile` or `region.getWorldTile`. The caller must apply
visibility to the current owner cell and pass `revealInvisible` consistently.

Each command has the existing `asset`, `sx/sy/sw/sh`, `offsetX/offsetY`, `type`,
`paintId`, `flipX`, `opacity`, and optional `vertexColor` properties. Preserve
the command's paint override: a pylon child can control fullbright visibility
without painting its unpainted Extra texture. All source rectangles are
integer-bounded and at most 50×50, below the frame preparation side limit of 64. Raw TConvert assets require `inputEncoding: "tconvert-game-raw"` and an
opaque scene for additive terms.

Extra commands also carry `staticOverlay: true`, `specialOverlay: true`,
`role`, and `specialLayer`:

| Layer           | Meaning                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `behind-object` | Rainbow halos after walls and before ordinary object bodies            |
| `with-body`     | Altar surface glow alongside that cell's body                          |
| `over-tiles`    | Pylon/relic figures and halos, and the altar orb, after ordinary tiles |

Only the source owner emits an entire extra: top-left for pylon/relic/rainbow,
top-middle for the altar orb. Calling all object cells does not duplicate
whole objects. Enumerate each world owner once when combining region and halo.
Clip all commands to the requested pixel rectangle. For a compact ROI, collect
intersecting commands from surrounding owners even when their cells are not
inside the selection. This includes overflowing bodies, not just extras:
rainbow bodies can extend four pixels down and one pixel left; pylon/relic
bases extend two pixels down. Do not count halo-only cells as selected tiles or
include them in saved fragments.

Relative to an extra's emitting cell, the combined conservative pixel bounds
are X `[-7,55]` and Y `[-49,55]`. Thus four cells of planning halo in every
direction are sufficient. Expanded viewport/full-export planning followed by
cropping already satisfies this requirement; independent selection contexts
need explicit intersection collection.

## Narrow asset dependency

Eight files were read individually from the authorized TConvert image folder.
They total 39,706 encoded bytes. Only these files are required; no texture
archive is needed. Staged files and their blob SHA/SHA-256 provenance are in
`fixtures/private/static-special-objects/`; integration/publication owns any
copy to the public example manifest. The original module does not include any
of these image bytes.

| Asset           | PNG dimensions | Actual-map minimum crop bounds |
| --------------- | -------------- | ------------------------------ |
| `Tiles_237.png` | 54×36          | 52×34                          |
| `SunAltar.png`  | 54×36          | 52×34                          |
| `SunOrb.png`    | 26×26          | 26×26                          |
| `Tiles_597.png` | 594×72         | 592×70                         |
| `Extra_181.png` | 420×368        | 420×368                        |
| `Tiles_617.png` | 54×144         | 52×70                          |
| `Extra_198.png` | 50×1400        | 50×150                         |
| `Tiles_711.png` | 74×38          | 74×38                          |

## Verification

Run `node --test test/static-special-objects.test.mjs`. Eight tests cover all
11 pylon styles and both directions of all 28 relic styles, unique ownership,
source bounds, missing context refusal, paint/coating sampling, source-byte
immutability, coordinate-stable phases, raw frame preparation, and exact
pixel equality between a large render and smaller ROIs with owners outside
the selection. The raw-asset test skips when the private authorized textures
are absent; all synthetic geometry tests remain executable without them.

The actual example WLD is 8400×2400, version 315, SHA-256
`d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab`.
Its 98 special cells comprise six altar, 48 pylon, 24 relic, and 20 rainbow
boulder cells: 12 objects total. All produce complete plans, totaling 267
commands and 89 distinct source crops across all eight verified assets.
Set `EXPLORETV_SPECIAL_CROP_REPORT=1` to write
`artifacts/static-specials-crops.json`.

Local actual-map proof renders cover all 12 objects with zero missing assets,
out-of-bounds crops, or skipped prepared effects. The comparison images show
the complete object beside a body-only view. Adding visible overlays changes
744 pixels in the altar ROI, 1,528–1,564 in pylon ROIs, 3,884 in each overlapping
two-relic ROI, and 234 in each rainbow ROI. These reports and images use the
`artifacts/static-specials-*` prefix. This validates actual texture geometry
and composition, not GPU-exact equality to an in-game screenshot. Animated
bobbing/rotation, random particles, selection outlines, and dynamic emitted
light are outside this frozen static view.
