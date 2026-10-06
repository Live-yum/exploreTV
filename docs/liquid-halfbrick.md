# Static halfbrick liquid overlap

`core/liquid-halfbrick.mjs` is integrated into the two previously unresolved halfbrick omission branches. It draws original liquid atlas pixels, reconstructs the source's fullbright vertical vertex-color ramp, and preserves the separate normal upper-half pass when required. The integration preserves previously supported commands and changes no saved Tile fields.

## API and integration boundary

```js
import { createHalfbrickLiquidSampler } from "./liquid-halfbrick.mjs";

const sampleHalfbrick = createHalfbrickLiquidSampler(region, options);
const result = sampleHalfbrick(worldX, worldY);
```

Create one sampler per region and reuse it. Options follow the existing liquid interface: `worldSurface`, `waterStyle`, `frame`, `waterfallFrame`, `lavaOpacity`, `layer`, and optional `isSolid`/`getWorldTile`. The default solidity predicate is the complete source-backed `isSolidOrSlopedTile`. Selected cells and optional context are column-major; a world accessor supplies additional dependencies without guessing missing cells. Input records remain unchanged.

- A successful result contains `supported: true`, `commands`, `requiredAssets`, `occluded`, `gradientRows`, `clampedRows`, `normalDrawn` and `waterfallDecision`.
- An unsuccessful result contains `supported: false` and a precise `reason`, with no partial commands. In particular, a missing normal-pass dependency discards any already prepared behind-pass commands.
- Every command has selection-local pixel coordinates, the original raw liquid byte and world coordinates. Behind-pass commands set `drawBeforeTiles: true`. Normal-pass commands keep the configured foreground/background layer.
- The sampler only accepts an active, non-actuated, known-solid halfbrick. It rejects malformed records, unknown solid classifications, mixed liquid, shimmer, special overlap tiles and missing required context. Wet type-379 neighbors remain rejected even when inactive because the behind and normal passes handle their raw liquid differently.

The minimal live integration is limited to existing `halfbrick-overlap-neighborhood` and `halfbrick-waterfall-neighborhood` failures from `behindShape`, after the current shared preflight and existing successful walled-halfbrick branch. Lazily sample that coordinate. If supported, append all returned commands and assets; otherwise preserve a reported failure using the returned reason. Do not apply the sampler to cells that already have successful liquid commands.

Count a supported cell once: increment `drawn`, `shapeDrawn` and `sourceGeometryDrawn` when it has commands, or `skippedOccluded` otherwise. `commandCount` still comes from the final command array. `normalDrawn` can increment `visibleLevelDrawn` once; it does not add another evaluated world cell. `clampedRows > 0` counts one clamped shape cell. Optional gradient-cell/row statistics may be exposed separately. Keep the raw `liquidCells` versus dry `shapeCandidateCells` accounting unchanged.

The existing renderer already honors command opacity, native source crops and `drawBeforeTiles`. No new renderer or shader operation is required. Add the new module to asset/package and provenance lists when integrating; the integration includes the new module in provenance lists.

## Behind and normal geometry

The source uses raw north/west/east/south amounts for the behind-tile pass. The own halfbrick only contributes its stored amount when it exceeds 160. A south-only inflow requires more than 240. North-only input chooses a 12-pixel-high source rectangle beginning at source Y 4; north plus an eligible side or south inflow uses 16 pixels beginning at Y 4. Side/self-only input uses the source's two-pixel quantization of `(256 - level) / 32`. A south-only input uses a four-pixel strip at destination Y 12.

Halfbricks use `Liquid_N.png`, not an invented triangle or a uniform color fill. Water uses the selected water style, lava uses 1 and honey uses 11. The separate normal renderer uses its existing `water_N.png` geometry helper and frozen clocks:

- With raw liquid above, dry and completely full halfbricks can draw the normal upper-half pass.
- An unwalled halfbrick with a nonzero partial raw amount explicitly hides that normal pass.
- Without raw liquid above, this known-solid halfbrick has no normal liquid command.
- A wall plus liquid above suppresses the separate behind pass. `BlocksWaterDrawingBehindSelf` also suppresses the corresponding behind pass; neither fact alone suppresses an otherwise visible normal pass.

The helper emits the source-backed combination of these passes. It does not replace the saved liquid byte with a synthetic full value.

## Gradient, premultiplied channels and PointClamp

For underground halfbricks with raw liquid above, the source zeros both top vertex colors while retaining the bottom vertex colors. The resulting ramp spans the source quad's actual height, 12 or 16 pixels, rather than always spanning a full tile. Above or exactly at world surface, the source keeps uniform corner colors.

The fullbright bottom corner is quantized to a byte after the source opacity multiplication. Water's underground endpoint is 127; fully opaque lava/honey endpoints are 255. This integer truncation is also documented by the [XNA-compatible FNA Color multiplication implementation](https://github.com/FNA-XNA/FNA/blob/master/src/Color.cs#L1741-L1763). Player lava opacity is clamped and applied before endpoint quantization. Runtime lighting gradients and water-style crossfades remain outside this frozen single-style model.

Each gradient command reads a single authentic atlas row and draws one native destination row. For zero-based row `r`, quad height `h` and bottom byte `b`, the normalized factor is `(b / 255) * ((r + 0.5) / h)`. Sampling pixel centers reproduces the linear ramp at native 16-pixel tile resolution. No replacement bitmap or color polygon is generated.

The factor is applied **once**, through `command.opacity`. `vertexAlphaEndpoints` is evidence metadata; commands intentionally do not set `vertexColor`. Thus `scene-frames` does not multiply the same ramp into texture bytes, and its cached source rows can be shared between commands with different interpolation factors.

For a raw premultiplied sample `(P, A)`, row factor `t` and opaque background `B`, the expected color is `P*t + B*(1 - A*t)`, with alpha normalized consistently. The existing source-over/additive decomposition receives the same factor on both terms. New tests verify all 16 rows for ordinary premultiplied RGBA, RGB greater than alpha, and nonzero RGB with alpha zero. They compare the analytic result rounded to bytes within the existing adapter's two-byte Canvas quantization allowance. Double application of the ramp or loss of additive RGB fails these checks.

The actual `Liquid` textures are 16 pixels high. Source Y 4 plus a 16-row quad extends four rows past their bottom; TileBatch uses PointClamp. Those rows explicitly read source row 15 and retain their own gradient factors. Uniform-color overflow uses one valid body crop and one repeated last-row crop. No source rectangle crosses the texture boundary and no cropped remainder is stretched to approximate the missing image.

## What can be established about waterfalls

`CheckForWaterfall` tests registered origin coordinates. A raw side amount above 160 is only an initial condition; it does not establish that the halfbrick is registered.

The pinned `FindWaterfalls` halfbrick branch requires all of the following: a high wet side; raw north amount below 16 or a full solid tile above; and an opposite side with zero liquid, no full solid tile, and no slope. A dry halfbrick side counts as open because its slope is zero and `SolidTile` excludes halfbricks. A sloped side does not count as open. Actuation is respected by the solidity predicate.

The helper also checks a second way to register the same coordinate: a cloud of type 196, 460 or 717 above can register a rain/lava-rain/snow origin in the dry halfbrick below. Testing only the halfbrick branch would miss these origins.

If either origin is geometrically possible and the behind pass needs the check, the helper returns **`halfbrick-waterfall-state-required`**. It does not assume that the source's count, quality, viewport limits or cached state enable or disable the waterfall. It does not emit a replacement waterfall texture or drop the unresolved event.

If no registration path is possible, the result records `waterfallDecision: fresh-scan-ineligible`. This is a static reconstruction from a fresh scan of the saved world, not recovery of a previously cached game's state. `FindWaterfalls` normally refreshes periodically; stale origins left by earlier changes cannot be recovered from a WLD. The helper's other decision values are `no-high-side` and `not-needed`. A fully suppressed behind pass need not ask for waterfall state.

### Explicit shared registry

The live helper also accepts `options.waterfallRegistry`, with a synchronous `hasOrigin(worldX, worldY)` method. It queries membership only when the source behind pass is otherwise needed and a raw side exceeds 160. `true` records `registered-suppress-behind` and suppresses only that behind pass; the independent normal upper-half command remains. `false` records `snapshot-not-registered` and permits the source behind geometry, including a geometrically eligible origin excluded by the snapshot's cap. `undefined` or any other non-boolean value remains `halfbrick-waterfall-state-required`; an incomplete supplied registry never falls back to a local negative guess.

Without a registry, the existing fresh-scan proof/rejection behavior remains unchanged. Walls, blocked-behind materials and low side amounts retain their source short circuits when membership cannot affect the result. The registry must be the same snapshot used for waterfall drawing, with its viewport, quality and cap choices explicit. This helper neither builds a registry per cell nor alters its source records.

`test/liquid-waterfall-registry.test.mjs` verifies complete and cap-zero registries, a genuinely incomplete scan, positive membership despite changed local eligibility, dry/partial/full raw halfbricks, preserved normal commands, strict tri-state values, source short circuits, world-coordinate receiver binding, raw-record immutability and shared mixed-halfbrick integration. The separately defined dry mixed-halfbrick helper is now reached only from the corresponding special-context rejection; it retains registry uncertainty and records resolved-versus-drawn cells separately.

## Verified full-world coverage

The full scan of `fixtures/example-world.wld` processed all 20,160,000 cells. Input SHA-256: `d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab`. The baseline renderer hash is `51bc36a8f25419175a7ae6e428f27706507f666f5f2ee4c55d8e64ff6bad8461`. All five relevant source modules remained unchanged during the scan.

- Original total liquid omissions: **16,251**
- Halfbrick candidates evaluated: **14,195**
- Newly supported candidates: **12,723**, comprising all **11,372** original halfbrick overlaps and **1,351** original waterfall-neighborhood failures
- Remaining possible-waterfall origins: **1,472**, explicitly rejected
- New total liquid omissions: **3,528**
- New actual source commands: **191,735**, including **178,800** gradient rows, with **11,372** normal upper-half commands
- Gradient cells: **11,265**; cells with explicit PointClamp bottom rows: **11,010**
- New missing textures or invalid source crops: **zero**

**All 12,723 newly supported cells in this fixture are dry halfbrick candidates whose raw saved liquid amount is zero.** They are not 12,723 newly discovered wet records. Water, lava and honey account for 6,238, 6,461 and 24 supported candidates respectively. Existing supported liquid cells and their commands are left intact; the audit explicitly rejects any attempt to append these plans over a previously successful liquid cell.

Only the existing six `Liquid_0/1/11.png` and `water_0/1/11.png` assets are needed. Other original omission groups remain unchanged: 97 non-solid shapes, 1,116 special-tile neighborhoods, 16 mixed-liquid cases, 64 extended special-tile dependencies and 763 shimmer cases. This candidate does not complete all liquid rendering.

The independent local audit script/report are `artifacts/audit-halfbrick-liquid.mjs` and `artifacts/liquid-halfbrick-coverage.json`. These ignored QA artifacts are not distributed source or texture copies.

## Tests and actual pixel comparisons

`test/liquid-halfbrick.test.mjs` has 13 tests covering gradient endpoints/height, uniform surface alpha, raw amount thresholds, original atlas identity, normal/behind pass combination, wall suppression, shape/actuator waterfall eligibility, cloud-origin exceptions, missing/unknown contexts, atomic rejection, native texture pixels, explicit PointClamp, raw premultiplied/additive goldens and input immutability.

Three strict fullbright frozen-frame ROI comparisons used the actual PNG assets and existing raw-game channel pipeline:

| ROI           | World rectangle   | Added commands | Changed pixels |
| ------------- | ----------------- | -------------: | -------------: |
| Water overlap | (18,682), 28×24   |             82 |            904 |
| Lava overlap  | (28,1685), 28×24  |             17 |            148 |
| Honey overlap | (327,1908), 28×24 |             17 |            148 |

All three had zero missing assets, invalid crops, skipped effects or candidate failures. Images are `artifacts/liquid-halfbrick-{water,lava,honey}-overlap.png`; the report is `artifacts/liquid-halfbrick-qa.json`. These show actual changes to previously omitted halfbrick areas. They are not a running-game pixel oracle; native GPU rounding, lighting, camera cache history and other existing renderer fidelity limits are not reconstructed.

## Pinned behavioral references

Terraria reference commit: `8255d34616c780af12079425ac92a0a7aed87d71`. No decompiled source text is included in the candidate implementation.

- [Behind-liquid invocation and tile layering](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L449-L531)
- [Raw inputs, waterfall suppression and rectangle selection](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L3856-L4118)
- [Opacity, wall suppression and top-vertex gradient](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L4119-L4181)
- [Halfbrick texture selection](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L4531-L4560)
- [Normal halfbrick visibility and crop](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L513-L529)
- [Waterfall origin cache, cadence, geometry, viewport and count limits](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WaterfallManager.cs#L94-L261)
- [PointClamp sampler](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.Graphics/TileBatch.cs#L194-L200) and [quad vertex colors](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.Graphics/TileBatch.cs#L640-L654)

## Integrated verification

The shared liquid planner now invokes this sampler only for its two targeted old failure reasons. Full-world integrated audit repeats the predicted 3,528 remaining events, with all 20,160,000 cells visited, zero unsupported Tile cells and zero missing/out-of-bounds source textures. Raw wet-cell and dry shape-candidate counters remain separate. The existing halfbrick tests now assert one counted cell for the 12-row behind ramp and optional normal upper-half pass, while eligible waterfalls stay explicit.
