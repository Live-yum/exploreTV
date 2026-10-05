# Static tree rendering

`core/static-trees.mjs` plans actual trunk, branch, crown, and ash-tree glow sprites. It uses saved tile frames, world tree variations, and the actual ground below each tree. It does not substitute a generic tile or marker when root or style information is missing.

Supported tree tile IDs are `5`, `323`, `583–589`, `596`, `616`, and `634`: common biome trees, palms, seven gem trees, cherry/willow trees, and ash trees. The pose is fixed at zero wind; leaf particles and emitted lighting are outside this static pass.

## API and context

```js
const result = planStaticTree(region, localX, localY, tile, {
  treeContext: region.treeContext,
  getWorldTile: region.getWorldTile,
  paintEnabled: true,
});
```

`x` and `y` are local tile coordinates within `region.rect`. `getWorldTile(worldX, worldY)` is a synchronous, read-only accessor; it receives absolute world coordinates. Both options default to the corresponding region properties. Metadata can also be carried in `region.source.treeContext`.

A successful result contains `commands`, `requiredAssets`, the resolved root and biome, and any foliage selection. Commands use the normal `kind: "tile"` shape, carry the original tree `type`, and include `treePart`, `treeStyle`, `foliageStyle`, and `fidelity: "source-static-tree"`. Ash overlay commands additionally carry `treeGlow: true` and use unpainted white glow textures.

A failed result contains a specific `reason` and, when a cell is unavailable, a `contextRequest` rectangle. Missing context does not select an arbitrary forest style. Normal tree trunks can require ground beyond a small render halo: the trunk search has a 512-row budget, while foliage searches at most 100 rows according to the source behavior. The actual verification world required up to 29 rows of root context.

Color-paint IDs 1–12 currently return `tree-paint-style-not-yet-supported` because their biome-specific paint masks require a separate implementation. Other paint IDs retain the existing paint path. The verified world's 13,523 tree cells all had paint ID 0. Invisible trees remain hidden unless `revealInvisible` is requested. Unsupported slope data is reported explicitly.

## Geometry and draw order

- Tree trunks are 20×20 crops with a horizontal offset of −2 pixels. Common-tree atlas columns change in 176-pixel steps according to the root biome; gem, vanity, and ash trunks use their own `Tiles_<id>.png` atlases.
- Stored branch frames identify the main trunk column, including the side-root and branch offsets. Left foliage uses the branch atlas's first 40-pixel column and a destination offset of (−24, −12); right foliage uses source x=42 and destination (0, −12).
- Common crowns use saved frames 0–2, with biome-specific dimensions and extra hallow variants. Their bottom-center anchor is the owning tile's (8, 16) pixel position. Hallow crowns can reach 140 pixels high, 124 pixels above their owning tile.
- Palms preserve the signed stored `frameY` as a horizontal bend offset. Crown cells do not also draw a generic trunk sprite. Coast palms use `Tree_Tops_15.png`; oasis palms use `Tree_Tops_21.png`. Oasis selection uses the source's 380-tile coast distance.
- Gem and ash crowns are 116×96; cherry/willow crowns are 118×96. Ash trees additionally draw `Glow_315.png`, `Glow_316.png`, and `Glow_317.png` for trunk, crown, and branches.

Large foliage images are partitioned into contiguous source rectangles at most 64×64 pixels. Destination positions receive identical offsets, so the pieces reconstruct the original sprite without scaling, gaps, or overlap. This preserves the existing bounded paint/frame cache instead of increasing its per-frame side limit.

The caller must use a visual halo of at least 10 tiles to include crown owners outside a chunk's core. Root lookup is separate and still requires the world accessor. Draw trunk and palm-trunk commands after walls but before ordinary foreground tiles; draw crown and branch commands in a later foliage pass. This reproduces the source's behind-tile trunk layer and later tree foliage pass. Keep ash glow sprites immediately after their corresponding base sprites within each pass.

## World-header metadata

`readWorldTreeContext(world)` in `core/world-tree-context.mjs` reads the existing header section for supported modern WLD versions 269–326. It walks fields in serialization order, with bounds checks; it does not search raw bytes for a plausible array length.

The parser reads `treeX[3]`, legacy `treeStyle[4]`, surface level, background styles, and the separately saved 13-entry `treeTopVariations` array. The legacy tree-style fields are not a substitute for the saved canopy variations. Forest boundaries use the source's inclusive comparisons. Jungle/snow variants use canopy entries 5 and 6. Hallow foliage intentionally follows `hallowBG`, matching the source routine.

Version-dependent fields before the tree arrays include the extra played timestamp at version 284, claimable-banner arrays at version 289, and the skyblock flag at version 302. The parser walks variable angler strings, kill/banner arrays, and party NPC arrays before the canopy-variation array. It returns offsets as provenance and refuses truncated, inconsistent, or out-of-budget metadata. Callers can retain a minimal synthetic or unsupported header as a world input while reporting that its tree metadata is unavailable.

## Fixed behavioral references

This is an original JavaScript implementation of the behavior below. Game source files and artwork are not embedded in this document.

- [TileDrawing at revision 8255d346](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs): `GetTreeBiome`, `GetTreeVariant`, `GetPalmTreeVariant`, `GetTileDrawData`, `DrawSingleTile`, and `DrawTrees` establish root-column selection, atlas offsets, signed palm bends, layers, anchors, and crown/branch rectangles.
- [WorldGen at the same revision](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/WorldGen.cs): the common/gem/vanity/ash foliage methods, tree-frame selection, ground tests, and palm coast boundary establish style and ground selection.
- [TreeTopsInfo](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent/TreeTopsInfo.cs), [WorldFile](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.IO/WorldFile.cs), [BannerSystem](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent/BannerSystem.cs), and [DD2Event](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Events/DD2Event.cs) establish the bounded header walk and conditional fields.
- [TileID](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.ID/TileID.cs) supplies the stone, moss, and grass ground classifications. [AssetInitializer](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.Initializers/AssetInitializer.cs) establishes the `Tree_Tops_`, `Tree_Branches_`, and `Glow_` asset names.

## Validation

```sh
node --test test/static-trees.test.mjs
```

The synthetic tests cover forest boundaries, jungle depth, snow world-side choice, hallow variants, crown reconstruction from bounded subrectangles, branch/root offsets, negative palm bends, coast/oasis differences, gem/vanity/ash families, static ash glow commands, explicit missing context, and versioned header fields with variable-length data.

The selected 8400×2400 world was independently scanned: all 13,523 cells in the 12 supported tree families produced plans without missing root/style context. All 20,073 resulting sprite crops fit the actual 56 PNG atlases and the 64-pixel frame-side budget. Forest, hallow, and palm regions were rendered using those real pixels and inspected. These checks verify the implemented source behavior and real asset compatibility; they are not a claim of comparison against an authoritative game screenshot.
