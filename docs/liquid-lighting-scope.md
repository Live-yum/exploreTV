# Static liquid and lighting scope

The liquid layer is **a frozen, fullbright flat-fill approximation**, disabled by default. It is not a port of Terraria's modern liquid geometry solver and is not a game screenshot. All planning code is original. No game source, textures, or private worlds are distributed by this feature.

## Planner contract

`planLiquids(region, options)` returns commands, required asset names, warning strings and a structured support report. `enabled: true` opts in. Cells are column-major. `region.rect` gives the selected world origin; optional `region.context` supplies surrounding cells with its own world rectangle. Only selected cells emit commands, positioned in selected-local 16-pixel coordinates. Input cells are never modified.

The parser's `liquidKind` values are storage values **1 water, 2 lava, 3 honey, 4 shimmer**. These normalize to game LiquidID 0, 1, 2, 3. The flat PNG names `water_N.png` correspond to source asset names `Images/Misc/water_N`. Water uses the explicitly selected `waterStyle` (default 0); lava uses 1; honey uses 11. Shimmer requires a distinct multipass color/sparkle implementation and is skipped, not substituted with another texture.

The optional `isSolid(tile)` callback supplies caller-known material classification. Active, non-actuated cells are considered solid only when that callback returns true. Without a callback, nearby active material is rejected as unknown, except ordinary platform type 19. A callback must not silently classify unknown active materials as supported non-solids. Shape and special-tile checks apply independently.

`frame` and `waterfallFrame` freeze separate 16-frame clocks; integer values wrap modulo 16. Each band has an 80-pixel stride. Source X 16 selects the waterfall clock, other X values select the normal clock. The special surface band uses Y 1280 when raw topology selects (16,0) and world Y exceeds `worldSurface - 40`. Supply `options.worldSurface` or `region.source.worldSurface`; absent metadata produces a warning and ordinary animated-band selection. `waterStyle` accepts water atlas IDs 0, 2–10, 12, 13, not lava/honey/shimmer IDs.

Each command records `opacity`, `frontOpacity`, `layer`, normalized `liquidType`, raw `liquidLevel`, world coordinates and `fidelity: flat-fill-approximation`. Default layer is background: source background alpha factor 1, multiplied by `lavaOpacity` for lava. Optional `layer: foreground` uses front factors 0.60 water and 0.95 lava/honey; lava again multiplies `lavaOpacity`. The renderer must apply command opacity and clip to the selected rectangle. A background-only preview should draw this layer before foreground tiles; drawing both passes indiscriminately is not equivalent to the game's full render-target composition.

## Deliberate approximation

Height is `ceil(liquidByte / 255 * 16)`, anchored to the bottom of a cell. Raw neighbor occupancy selects a texture family. Missing neighbors are treated as empty and counted. This does **not** implement source visible-level interpolation, minimum quarter-tile geometry, falling extensions, weighted boundary smoothing, or corner corrections. In particular, a single liquid byte produces one pixel in this preview, whereas source-derived visible geometry can enforce a larger minimum. No synthetic liquid is emitted into empty cells.

A conservative 3×3 neighborhood check skips liquid near active halfbricks, slopes, special overlap tiles 379/518/546, or different liquid types. Shimmer, malformed levels and unknown kinds are also skipped. Structured counts and world-coordinate reason entries identify omissions. Known full solids containing liquid are counted as `skippedSolid`. No shape clipping, special plants, bubble blocks, separate waterfall simulation, ripples, particles or runtime style crossfades are claimed.

## Why runtime lighting is not reconstructed

Fullbright is an inspection choice, not recovered world lighting. Modern lighting requires tile/wall light-block tables, emissive frame rules, scene ambient color, surface/underworld depth, biome water style, player status and scene decay, per-frame entity lights, several visual clocks and seeded random state. A saved world alone does not provide a reproducible runtime lighting frame.

The modern engine scans a 28-cell padded area, reserves 18 non-visible cells, performs two bidirectional blur passes, and depends on rendering/update state. Water attenuation includes seeded random factors. Any future simplified sunlight/emissive mode must be labelled a static approximation, state its explicit ambient/clock/seed assumptions and remain separate from this fullbright layer.

## Pinned behavioral references

All links refer to commit `8255d34616c780af12079425ac92a0a7aed87d71` of the public decompiled reference. These links document decisions; no source text is copied here.

- [Liquid IDs](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.ID/LiquidID.cs#L3-L13)
- [Liquid asset loading](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L150-L158)
- [Visible-level preparation and falling extensions](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L196-L280)
- [Edge topology, smoothing and corners](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L305-L526)
- [Normal liquid atlas/opacity draw rules](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L622-L672)
- [Shimmer's separate color and sparkle layers](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L682-L806)
- [Wind/pause-dependent animation clocks](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L841-L857)
- [Water style, crossfades and background invocation](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L58310-L58473)
- [Behind-tile special overlaps](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L3856-L3955)
- [Lighting scan/decay/player context](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.Graphics.Light/LightingEngine.cs#L115-L234)
- [Lighting blur](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.Graphics.Light/LightMap.cs#L86-L115) and [randomized water attenuation](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.Graphics.Light/LightMap.cs#L221-L235)
- [Light masks and liquid emissions](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.Graphics.Light/TileLightScanner.cs#L68-L164)

## Verification

`node --test test/liquid.test.mjs` covers defaults, immutability, storage-kind mapping, fill quantization, selected-local placement, padded context, both frozen clocks, surface-band selection, alpha, style validation and omission reasons. These are contract tests for the declared approximation, not game-render parity tests.
