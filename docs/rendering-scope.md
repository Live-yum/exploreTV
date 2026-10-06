# Texture rendering scope

This renderer is an original, dependency-free JavaScript preview planner and Canvas2D adapter. It does not embed Terraria source, game art, extracted sprites, or generated substitutes. Supply legally obtained PNG textures named `Tiles_<id>.png` and `Wall_<id>.png`. Missing textures and sprite rectangles outside an image produce explicit diagnostics. Strict asset mode aborts before drawing any command. No colored fallback is drawn.

## What is rendered

- Walls are drawn first: 32×32 source rectangles on a 36-pixel atlas grid, centered on a 16-pixel world cell. A static neighborhood-based frame is selected. Different wall types connect, as in the game's wall framing.
- Ordinary blocks on an explicit allowlist use 16×16 texture crops and an approximate same-type four-neighbor frame. Texture frames are not guessed as `(0,0)`.
- Stored frames are used only for the small explicitly supported set: static torch bases (4), closed/open doors (10/11), tables (14), chairs (15), workbenches (18), platforms (19), chests (21), sunflowers (27), and sinks (172). Bottom-row height adjustments are implemented for the supported types. No animation, furniture state update, glow, or dynamic effects are simulated.
- Torch bases use 20×20 stored-frame crops, centered with a −2-pixel X offset. A recognized solid ceiling adds 4 pixels vertically. Flame overlays, particles and emitted light are omitted; animation time is fixed at zero.
- Vine ropes (353) use static variant 0 with rope/known-solid neighbor attachment framing. Unknown solid anchors and outside-region neighbors are not inferred. This remains an explicit approximation.
- Half blocks use an 8-pixel source crop lowered into the cell. Slopes use simple triangular clipping. This is a geometry approximation, not the game's stepped strip renderer or specialized slope framing.
- Invisible coatings and echo walls are hidden by default; reveal mode is explicit. Cell data and canonical raw record bytes are never mutated by rendering.

## Deliberate limits

This is a static unlit preview, not a pixel-exact game screenshot. Exact terrain framing involves material-specific merges, grass edges, diagonal neighbors, slopes, frame randomization, and multi-cell rules. Ordinary terrain frames and wall frames are not persisted in the world file; they must be reconstructed. This implementation reports that approximation rather than claiming recovered original frames.

At a selected region boundary, outside-neighbor context is unavailable. Large-pattern walls, wall truncation by special foreground tiles, animated walls, specialized plants/trees, unsupported furniture, water/lava/honey/shimmer, paint shaders, lighting, glow masks, wiring overlays, entity sprites, and backgrounds are not reproduced. Unsupported tile IDs are skipped with per-ID counts. Painted tiles use the unpainted supplied texture and report this. Actuated tiles are shown without the game's darkening. Fullbright coating has no distinct effect in an unlit preview. Stored-frame support does not imply all in-game special rendering effects are reproduced.

`planScene(region, options)` returns commands, warnings, support counters, required asset filenames, and pixel width/height. Options: `tiles`, `walls`, `revealInvisible`. `renderScene(context, plan, assets, {strict})` draws only supplied images; `assets` can be a Map or filename-keyed object. It reports drawn count, missing asset names, invalid asset names, and warnings. The caller owns canvas sizing and clearing.

## Source observations

The pinned reference repository reports public visibility but no license; no decompiled implementation is included here. Relevant mechanics were inspected at commit `8255d34616c780af12079425ac92a0a7aed87d71`:

- [WorldFile.LoadWorldTiles and section parsing](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.IO/WorldFile.cs#L2524): frame-importance bitmap controls persisted frame coordinates; absent frames require reconstruction.
- [General terrain cosmetic framing](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L82677): same-type adjacency is only a subset of the complete material-specific behavior.
- [Wall framing](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Framing.cs#L343): cardinal neighbors, interior patterns, and 36-pixel frame grid.
- [Wall drawing](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/WallDrawing.cs#L76): 32-pixel crops, 16-pixel cell pitch, and −8-pixel placement offset.
- [Tile draw-data adjustments](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L4567): per-type dimensions and offsets prevent treating every saved frame as a universal 16×16 sprite.

Public CI tests use mocked drawing contexts, actual Canvas pixel comparisons against original procedural atlases, and synthetic tile metadata, not proprietary artwork. They verify ordering, coordinates, clipping intent, invisibility, diagnostics, no-fallback behavior, and immutability; they do not establish visual parity with a real world and matching game assets.

## Version boundary

The supplied real test world is the xindong v315 format; texture examples come from the user-specified 1.4.5.8 output. Reading a supported serialized format does not establish all tile-ID or texture-layout compatibility between versions. Sprite bounds are validated against actual imported dimensions. There is no authoritative game screenshot oracle in this prototype. A pixel-crop test validates source-to-canvas copying, not game rendering equivalence.

Additional source observations: [torch dimensions and offsets](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L4729), [rope attachment framing](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L83183).
