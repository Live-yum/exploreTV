# Fresh static waterfalls

`core/static-waterfalls.mjs` creates a deterministic waterfall scene from decoded saved tiles. It uses the original `Images/Waterfall_N.png` atlases, frozen animation clocks, and fullbright colors. It never rewrites a tile, liquid amount, or saved world byte.

This is an explicit **fresh scan**, not recovery of a running game's cached waterfall list. The source normally refreshes that list every 30 calls. Its viewport, graphics quality, configured count limit, animation clocks, water-style crossfade, and earlier world mutations are not saved waterfall state in a WLD.

## API and shared snapshot

```js
const registry = createStaticWaterfallRegistry(
  {
    width: world.width,
    height: world.height,
    worldSurface: world.worldSurface,
    getTile: getWorldTileAccessor(world),
  },
  {
    viewport: { x: 0, y: 0, width: world.width, height: world.height },
    quality: 1,
    maxWaterfalls: 100000,
    frame: 0,
    slowFrame: 0,
    waterStyle: 0,
  },
);

const isRegistered = registry.hasOrigin(worldX, worldY);
const commands = registry.commandsFor(chunkRect);
```

The viewport is a tile-aligned, native-scale camera rectangle. Omission selects the whole world. `maxWaterfalls` defaults to the source's **1,000**, while this example deliberately selects a **100,000-origin static full-world limit**. The latter is a chosen export quality setting, not the game's default. Effective capacity is the truncated float32 product of the configured limit and quality. Quality zero registers no origins.

Create the registry once for the scene and reuse it for every viewport crop and export chunk. Recreating it per chunk changes scan bounds, column-major cap winners and halfbrick suppression. `commandsFor` selects sprites by their actual destination rectangle, including 32-pixel continuation pieces extending from adjacent tiles, and translates them to selection-local coordinates. Negative local positions are intentional overhangs. The output canvas supplies final clipping; a chunk must not discard a command solely because its owner/origin is outside that chunk.

The object exposes `scan`, `viewport`, `scanComplete`, `quality`, `maxWaterfalls`, `cap`, `maxCommands`, `traversalBound`, `clocks`, `waterStyle`, `colorProfile`, `discoColor`, `showInvisibleWalls`, `origins`, `originPlans`, `failures`, `requiredAssets` and `stats`. `hasOrigin` returns a boolean after a complete scan, or `undefined` when a missing or unknown dependency prevented completing the scan. Registration remains separate from rendering: an unsupported origin still has membership and an explicit draw failure, never a fabricated empty waterfall success.

Inputs should represent one immutable snapshot. Source records may be shared/frozen RLE records; the implementation reads them without temporary assignments. In particular, the source's temporary non-solid treatment of type 546 during drawing is local predicate behavior, not a mutation of the input or global solidity table.

## Registration and traversal

The fresh scan expands its camera bounds by the quality-dependent waterfall distance horizontally and upward, plus 20 tiles downward after the normal viewport margins. It excludes the outermost world columns/rows. Candidate order is column-major.

Halfbrick registration uses active tile state, the raw north level/full-solid check, a side liquid amount above 160, and an opposite dry, unsloped, non-full-solid side. The own halfbrick need not pass the liquid renderer's material-solidity test, and registration intentionally does not reject an actuated halfbrick merely because it is actuated. Lava takes priority over honey, then shimmer, then water when classifying raw north/side liquid kinds. Cloud tile types 196, 460 and 717 register types 11, 22 and 26 one tile below a dry, unsloped, non-full-solid lower cell. Both registration paths can coexist; source duplicate registrations are retained as separate draws while membership is a set.

Ordinary traversal reproduces horizontal selection, full-solid stops, sloped descents, direction reversal limits, liquid end cropping, halfbrick offsets, blocking-glass height changes, color-changing contact tiles, original 16/32-pixel continuation pieces and eight two-pixel slope slices. Base distance is `trunc(75 * quality) + 25`. Contact with the source's cloud-adjacent materials can reset it to `trunc(40 * (worldWidth / 4200) * quality)`, which can exceed the base distance in a wide world. The explicit traversal bound covers both values.

Rain-family paths use their shorter source distances, parity-dependent frame/X offsets, native front/back atlases, optional bottom-slope origin shift, solid landing behavior, cumulative liquid crop and final eight-step fade. An invalid accumulated crop is an explicit atomic failure rather than a stretched or invented texture.

Frozen frames default to zero. Ordinary falls use `frame` (0–15); lava/honey/shimmer use `slowFrame` (0–15). Rain-family clocks `rainFrame`, `rainBackgroundFrame`, `snowFrame`, `lavaRainFrame` and `lavaRainBackgroundFrame` accept 0–7. `timeForVisualEffects` defaults to zero. `discoColor` defaults to an explicit `[255, 0, 0]`. Wind does not enter the source waterfall geometry. Lighting emission, random dust, ambient sound and runtime water-style crossfades are not simulated.

Source fullbright opacity and distance fade are quantized into byte colors before drawing. Equal RGBA colors use a single opacity factor; unequal colors use premultiplied `vertexColor`. Waterfall type 25 reuses the separately verified shimmer color kernel, emitting native base and `sourceY + 42` sparkle sprites with `vertexColors` and no duplicate opacity multiplication. The renderer must support the shared corner-color metadata. `colorProfile` explicitly selects `xna` (default) or `fna` constructor rounding behavior.

## Layering and halfbrick suppression

The source draws waterfalls after the non-solid tile pass (including its tree/vine post-draw work), and before the solid tile pass. Commands declare `drawBeforeSolidTiles: true` and `layer: "waterfall-before-solid-tiles"`; callers must insert them in that position.

`classifyTileDrawLayer(type)` returns `"solid"`, `"non-solid"`, or `undefined`. This classification uses raw `tileSolid`, with true overrides for 11, 470, 475, 78 and 579. It does **not** remove solid-top tiles, actuated tiles, or `NotReallySolid` tiles. Pass the **owner tile's type**, not a secondary sprite's texture type. Unknown types and the runtime-dependent Bubble type 379 return `undefined`.

Ordering inside the waterfall pass also matters. `TileBatch` groups by layer/stack then first-seen texture identity. Each waterfall/rain step resets its layer; texture changes within the same step advance the stack. The registry preserves this batching order before building its spatial index, including rain backgrounds before foregrounds and material-transition pieces. Simply sorting by origin or adding each waterfall independently would change overlaps.

The behind-halfbrick liquid pass must consult this **same registry** when a raw side exceeds 160. If the coordinate is registered, suppress only that behind-tile liquid pass. A separate normal upper-half liquid pass may still be visible. A registered waterfall draw failure must remain visible in strict coverage diagnostics; membership is not evidence that drawing succeeded. If a coordinate is excluded by the selected cap or viewport, membership is false and its source behind-liquid pass remains eligible. Do not erase cap-excluded origins from the halfbrick model or infer registration from wet neighbors alone.

## Bounded behavior

The registry rejects scans over 40 million cells, configured origin limits above 100,000, and traversal bounds above 4,096 steps. The command budget defaults to 131,072 and can explicitly increase up to 1,048,576. Exceeding the budget discards the complete affected origin's prepared commands and reports `waterfall-command-budget`. A 64-tile spatial bucket index returns intersecting commands in global draw order. Per-origin failures are atomic; scan failures invalidate authoritative membership for the entire incomplete scan.

Unknown solidity (including active type 379), missing context, invalid liquid/shape data, outside-world traversal dependencies and invalid rain crop state remain named failures. The world border is not silently replaced by fabricated empty cells. Ordinary zero-command paths can be valid, such as a registered origin immediately blocked by a full solid; their recorded stop reason distinguishes them from failures.

## Actual fixture verification

The full-world scan used `fixtures/example-world.wld`, 8,400 × 2,400, version 315, SHA-256 `d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab`. Model: full-world viewport, quality 1, configured origin limit 100,000, all clocks zero, water style 0.

- 1,969 registered origins, none capped: 858 water, 586 lava, 29 honey halfbrick origins and 496 ordinary rain origins
- 82,467 authentic texture commands; zero unsupported origins and zero invalid source crops
- Exactly 1,472 registrations correspond to the previous `halfbrick-waterfall-state-required` group; the other halfbrick registration is in the separate mixed-liquid group
- Required original atlases: `Waterfall_0.png`, `Waterfall_1.png`, `Waterfall_11.png`, `Waterfall_12.png`, `Waterfall_14.png`
- Original world bytes unchanged

Four fullbright static scene comparisons used the raw-game premultiplied-channel adapter and the original local atlases. The source calls were grouped into their actual tile passes. Compared with the same scenes without waterfall commands, water/lava/honey/rain ROIs changed 4,153 / 1,515 / 4,550 / 71,867 pixels. Every ROI's complete render matched a 2 × 2 tiled rendering of the **same shared registry** byte-for-byte, including commands whose owner was outside a chunk. All four had zero missing textures, invalid crops or skipped effects. These are native texture and seam checks, not running-game screenshots or proof of GPU-identical rounding.

The independent local audit is `artifacts/audit-static-waterfalls.mjs`; its report is `artifacts/static-waterfalls-coverage.json`; images are `artifacts/static-waterfalls-{water,lava,honey,rain}.png`. QA artifacts and original textures are ignored private inputs, not distributed game assets. All 28 original atlases have been inspected/downloaded to `fixtures/private/waterfalls` for bounded synthetic coverage, but only the five above are needed by this fixture.

`test/static-waterfalls.test.mjs` exercises source draw-layer facts, viewport and quality margins, origin thresholds, raw liquid precedence, active/actuated registration, cap order, ordinary/slow clocks, style mapping, left/right overhangs, slope slices, material transitions, unknown dependencies, rain types/crop/layers, shimmer corner metadata, chunk queries, extended distance, immutability and explicit resource budgets.

## Pinned behavioral references

No decompiled source or compiled shaders are included in this implementation. Behavioral references are pinned to `8255d34616c780af12079425ac92a0a7aed87d71`:

- [Origin membership, refresh, scan bounds and registration](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WaterfallManager.cs#L94-L261)
- [Rain and waterfall traversal, crops and material changes](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WaterfallManager.cs#L329-L1007)
- [Shimmer overlay and opacity](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WaterfallManager.cs#L1009-L1091)
- [Static draw-layer selection](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L4509-L4517) and [five layer overrides](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.ID/TileID.cs#L219-L231)
- [Behind-halfbrick suppression](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L3856-L3894)
- [Non-solid, waterfall and solid pass order](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L64279-L64329)
- [TileBatch batch key/order](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.Graphics/TileBatch.cs#L34-L69), [stack behavior](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.Graphics/TileBatch.cs#L423-L447) and [layered flush](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.Graphics/TileBatch.cs#L672-L707)
