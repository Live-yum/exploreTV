# Static terrain and thorn sprites

`core/static-blocks.mjs` reconstructs source-atlas geometry for a bounded, explicitly checked family. It does not infer support from a name, from the presence of a PNG, or from a generic solid flag alone. This is original preview code; no reference implementation or game pixels are embedded.

| Types            | Classification         | Base draw                   | Extra static draw                                       |
| ---------------- | ---------------------- | --------------------------- | ------------------------------------------------------- |
| 162              | Breakable ice          | Full-solid 16×16 atlas crop | None                                                    |
| 384              | Living mahogany leaves | Full-solid 16×16 atlas crop | None; falling leaf particles omitted                    |
| 481, 482, 483    | Cracked dungeon bricks | Full-solid 16×16 atlas crop | None; brightness pulse fixed at time zero               |
| 381              | Lava moss              | Full-solid 16×16 atlas crop | `Glow_126.png`, color (150,100,50,0)                    |
| 539              | Argon moss             | Full-solid 16×16 atlas crop | `Glow_263.png`, color (225,0,125,0)                     |
| 633              | Ash grass              | Full-solid 16×16 atlas crop | `Glow_326.png`, white at the unlit white-light baseline |
| 32, 69, 352, 655 | Thorns                 | Non-solid 16×18 atlas crop  | None                                                    |

All eight solid types have explicit `tileSolid` assignments, no `tileFrameImportant` assignment, no `tileLargeFrames` assignment, and no special replacement of base dimensions in the inspected draw method. The thorn types are explicitly `tileCut`, do not have a solid assignment, and use the draw method's 18-pixel height override. Thorn roots connect only downward to 23, 60, 199, and 60 respectively. Thorns must not be used as solid ceiling or liquid-occlusion anchors.

## Framing contract and limitations

The frame is reconstructed on the ordinary 18-pixel atlas grid, using static variation zero and cardinal same-type connections. Thorns also include their explicit bottom-root connection. This preserves actual texture shapes, including transparent leaves and thorn tips. Cross-material merges, grass-to-underlying-material transitions, diagonal neighbors, specialized slope framing, and random frame variation remain an approximation. In particular, moss merges into stone, ash grass merges into ash, leaves merge into mahogany, and breakable ice has ice/snow merges in the full reference framing routine. The preview does not claim to recover those exact transitions. Solid slope and half-block clipping is the caller's responsibility and must apply equally to every returned layer.

`planStaticBlock(region,x,y,tile,options)` returns a normalized sprite, a `[base, overlay]` array, `null` for another family's type, or `{unsupported: reason}`. `options.revealInvisible` controls whether an invisible neighboring block contributes to the cardinal mask. Known types with supplied saved frames are rejected: this family expects the world's non-persisted terrain frames. Thorn slopes/half blocks are rejected rather than silently applying solid-block geometry.

Every sprite has `asset`, `sx`, `sy`, `sw`, `sh`, `offsetX`, `offsetY`, `flipX`, `opacity`, and `fidelity`. The base has the `approximate-static-block` or `approximate-static-thorn` fidelity label. Overlays have `staticOverlay:true`, `paintId:0`, `vertexColor:[r,g,b,a]`, and `static-glow-mask`. The renderer must retain the layer's explicit paint ID instead of inheriting the base tile's paint. These masks are separately rendered unpainted textures in the reference method.

The overlay's vertex color multiplies the texture's **premultiplied** channels before alpha splitting. `multiplyStaticVertexColor` supplies that calculation. A vertex alpha of zero does not mean invisible: moss masks retain RGB and contribute additively. Pass the product to the existing `splitPremultipliedRGBA` with the established opaque-scene contract. The frame cache key must include vertex color. A source-over-only rendering of a moss mask would lose its static color; an untinted mask would use the wrong color. Ash grass's white overlay is source-over. White-light previews do not reproduce varying emitted light or the source method's lighting-dependent ash-glow interpolation.

## Fixed source references

All references are pinned to `8255d34616c780af12079425ac92a0a7aed87d71`:

- [Tile names](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.ID/TileID.cs#L761), [moss and leaves](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.ID/TileID.cs#L1199), [cracked bricks](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.ID/TileID.cs#L1399), and [ash grass](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.ID/TileID.cs#L1703).
- Solid classification: `Main.cs` lines 7191/7203 (moss), 7327 (ice), 8098–8102 (cracked bricks), 8158 (ash grass), and 8478 (leaves). [Mask associations](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L10208) specify 381→126, 539→263, 633→326.
- [Draw data](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L4567) supplies the 16×16 default; [thorn override](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L4954) supplies height 18.
- [Static moss colors](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L132), [overlay color selection](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L1196), and [overlay drawing](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L1311) establish the separate same-frame mask pass. [Cracked-brick pulse](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L6789) is neutral at time zero.
- [Cosmetic framing](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L82677), [thorn roots and leaf merges](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L83329), [moss/grass transitions](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L83474), and [ordinary atlas frames](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L85687) justify the bounded approximation.

Tests cover static atlas selection, family-specific dimensions and anchors, hidden neighbors, preservation of unpainted overlays, additive alpha-zero color, input immutability, and explicit rejection of unrelated large-frame, saved-frame, or thorn-shape cases. No synthetic test is claimed to establish game screenshot parity.

## Additional ordinary materials

Types 158 (Rich Mahogany), 311 (Dynasty Wood), 321 (Boreal Wood), 357
(Marble), 369 (Granite), 399 (Crimson Hardened Sand), 495 (Shell Pile),
and 668 (Dirtiest Block) use their actual Tiles_<id> atlases and the existing
explicitly approximate static-block framing mode. The pinned Main initialization
marks these materials solid; GetTileDrawTexture selects their own type texture,
and they use the ordinary 16×16 source rectangle. No material-specific glow
layer or animation clock was identified for these types in TileDrawing.

This closes missing-resource cells, not exact framing parity. The existing
variant-zero cardinal approximation still omits dirt/cross-material merges,
some diagonal decisions and the source's adjacent-halfbrick seam corrections.
Boreal/Dynasty/Marble/Granite smooth-border seam handling is not silently claimed
as implemented. The source's dedicated slope-atlas set only includes 421/422;
these materials use the existing shape-clipping path. Raw Tile fields remain
unchanged.

Pinned references: [solid initialization](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L7681),
[wood and stone initialization](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L9692),
[shell/sand initialization](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L10334),
[type texture selection](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L1454),
[ordinary shape/seam drawing](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L1565).

The actual-world audit after this batch visits all 20,160,000 cells, adds 2,427
planned material cells, and leaves 2,750 explicit unsupported Tile cells. All
350 required PNGs are present and all source rectangles stay within their
atlases. Eight new atlases are fully decoded in regression tests; all 16
cardinal variants are in bounds and nonempty. A real mahogany-house rectangle
(275,1780), 64×56, renders 5,716 commands with zero missing/invalid textures
and unchanged fragment raw bytes. Its other 18 unsupported Tile cells remain
reported; the image is not a complete game-render oracle.
