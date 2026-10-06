# Proven special liquid contexts

`core/liquid-special-context.mjs` supplies source-backed normal liquid near lily pads, around sloped platforms, and at mixed-kind wet seeds; it also handles the five observed ordinary solid slopes next to lily pads. `core/liquid.mjs` now integrates it at the four original failure groups below. Existing successful liquid commands, Tile sprites and saved records remain unchanged.

## Actual blockers before implementation

The complete public fixture scan inspected every reported coordinate before choosing a supported subset. The inventory is `artifacts/liquid-special-inventory.json`, produced by `artifacts/inventory-special-liquid.mjs`.

| Existing reason                     | Events | Actual context                                                         |
| ----------------------------------- | -----: | ---------------------------------------------------------------------- |
| `special-tile-neighborhood`         |  1,116 | All are blocked by type 518 LilyPad in the immediate neighborhood      |
| `visible-special-tile-neighborhood` |     64 | Every traced cache failure reaches type 518 at horizontal distance two |
| `shape-non-solid`                   |     97 | All own tiles are type 19 platforms: 52 shape-2 and 45 shape-3 records |
| `mixed-liquid-neighborhood`         |     16 | 11 genuinely wet non-solid cells and five dry solid halfbricks         |

The direct group contains 277 lily pads themselves, 636 empty foreground cells, and 203 other active tiles. Five of those other active tiles are dry solid slopes. There are 1,648 lily-neighbor incidences across the 1,116 unique events, so incidences must not be reported as distinct omitted cells.

The 64 extended failures were traced through the actual visible-level reader. First blocked lily positions relative to the target are (-2,-1): 18, (+2,0): 19, (+2,-1): 12 and (-2,0): 15. Repeated reads of the same tile are deduplicated. No type-379 or type-546 record blocks this actual candidate set.

The mixed-kind events comprise two lava/honey, five water/honey and nine water/lava neighborhoods. The two lava/honey events and three water/lava events are dry halfbricks; those five remain unresolved. The eleven wet cells are eight empty foreground cells, two type-74 plant cells and one type-165 cell. Their raw liquid kind is saved and remains authoritative for the normal pass.

Type names matter: **379 is Bubble**, 518 is LilyPad and 546 is Grate in the pinned TileID source. Bubble's solidity changes during the game update; it is not treated as a known non-solid. Grate has its own behind-liquid branch. Neither is silently admitted just because this fixture's remaining special contexts happen to involve lily pads.

## API and minimal integration

```js
import { createSpecialLiquidContextSampler } from "./liquid-special-context.mjs";

const sampleSpecial = createSpecialLiquidContextSampler(region, {
  ...liquidOptions,
  layer: "foreground",
});
const result = sampleSpecial(worldX, worldY);
```

Construct one sampler per immutable region/context and reuse it. It accepts the existing world-surface, water-style, frozen-frame, layer and lava-opacity options; the default material predicate is the complete `isSolidOrSlopedTile`. `region.context` and a decoded `getWorldTile` accessor supply real dependencies. Missing context is never replaced with empty or fully wet cells.

Successful results contain `commands`, `requiredAssets`, `normalDrawn`, `contextRule` and optional `clampedRows`/`lilyUnderlay`. An occluded supported result has no commands. Failures have a precise reason and no partial output.

Only invoke this candidate at original failures:

1. The top-level `special-tile-neighborhood` or `mixed-liquid-neighborhood` preflight rejection
2. The own-shape `shape-non-solid` rejection
3. A returned `visible-special-tile-neighborhood` rejection

Append successful commands and required assets, or retain an explicit failure. Preserve the ordinary counters: one evaluated/drawn cell regardless of the number of source rows, `sourceGeometryDrawn` once, `visibleLevelDrawn` for a normal command, and `shapeDrawn`/`clampedShapeCells` for the ordinary solid-slope result. A platform's shaped Tile record does not turn its normal liquid command into a solid-slope mask.

Do not remove the global mixed-kind check or the entire special-tile guard. Other branches still need them. Do not invoke the candidate over a currently successful liquid coordinate. Add the new module to the same package/asset and provenance lists as the other liquid helpers during integration; the candidate itself changes none of those lists.

## Lily geometry and the existing tile sprite

`Main` initializes 518 as non-solid and not a platform. `LiquidRenderer` uses the raw amount/kind, wall, halfbrick state, solidity and platform membership to build its geometry cache. Lily's ID has no additional geometry rule there. Its special treatment occurs in `Main.DrawTileInWater`: the existing saved 16×16 tile sprite is placed at an integer lift of `floor(liquid / 16) - 3`, capped at eight pixels when a full solid tile is above it, before the liquid sprite is drawn.

The preview's existing `planStaticPlantsNext` already supplies that exact wet-lily Tile command in the foreground composition. The helper returns a `lilyUnderlay` requirement containing the expected crop and position; it emits **no new Tile command**. The actual audit verifies all 277 expected underlays against exactly one existing type-518 Tile command each. This preserves the existing painted tile texture and avoids drawing the lily twice.

Own lily cells require `layer: foreground` in this candidate because the existing foreground composition places the tile before liquid. Background ordering is explicitly rejected, as are dry, shaped, invisible, actuated or unsupported-style own lily records. Those limitations are separate from known neighboring lily material facts. The source's dry-lily support rules remain the existing tile planner's responsibility.

To reuse the already-tested normal geometry solver without weakening its global guard, the helper constructs a **liquid-cache-only descriptor** for type 518. A private symbol replaces its type token and the cache callback supplies the proved non-solid/non-platform classification. Every other field, including `active`, `inactive`, raw `liquid`, `liquidKind`, `wall` and `shape`, is preserved. Other tile types retain their real IDs. This view is never supplied to the tile renderer and never selects a texture asset. Original records are not modified.

This adapter is justified specifically by the cache's complete raw-input contract. It is not a general exception mechanism for Bubble, Grate or unknown tiles. Tests compare it with an equivalent known non-solid cache input and with an erased-air input: the equivalent input matches, while erasing the lily's liquid produces different geometry. Extended dependencies use the same descriptor through the real world accessor.

## Platforms and mixed wet seeds

Type 19 is solid-top and a member of the platform set, so `SolidOrSlopedTile` excludes it in the normal liquid renderer. The cache also excludes platforms from halfbrick promotion. Its Tile slope flags do not warrant a solid liquid mask. The helper preserves the platform ID and shape and uses the normal visible-level equations; it does not clip water to a made-up triangle or replace the platform sprite.

The source normal pass resets a wet seed's visible type and opacity to its own raw type when processing that cell. Incoming trails can raise its visible level, but they do not authorize replacing its saved kind with a neighbor's kind. The helper passes all raw kinds to the normal solver and verifies the returned type matches the target's raw kind. Tests include a partial water seed whose level is raised by honey above: the resulting asset remains `water_0.png`.

This reasoning does not cover the five dry mixed halfbricks. Their behind-tile pass can choose types in directional order and require additional style/color layers. They remain `special-mixed-behind-liquid-context`, rather than arbitrarily selecting water, lava or honey. Shimmer and any context involving Shimmer remain outside this candidate.

## Ordinary slopes beside lilies

The five observed dry solid slopes use the same source-derived behind-slope equations and original `LiquidSlope_0.png` columns as the already-supported shape path. Lily neighbors retain their actual liquid amounts and non-solid material classification. Directional inflows, two-pixel level quantization, full-solid side occlusion and PointClamp splits are preserved. Synthetic tests compare every slope orientation's crop, destination, opacity, layer and clamp split with the established ordinary-neighbor planner. Mixed behind-slope/halfbrick cases are still rejected.

## Full-world result

The final scan processed all **20,160,000** cells of `fixtures/example-world.wld`, SHA-256 `d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab`. It verified the six relevant source modules stayed unchanged during the scan. The baseline renderer hash is `51bc36a8f25419175a7ae6e428f27706507f666f5f2ee4c55d8e64ff6bad8461` and the liquid planner hash is `2dea9e387624ee923744e1575e644b18aa82bca3a37a8f3a644b6620816117f3`.

- Total liquid omission events: **3,528 → 2,240**
- Candidate events inspected: **1,293**
- Newly supported/drawn cells: **1,288**
- New source commands: **1,290**, including two explicit PointClamp continuation commands
- Resolved original groups: **1,116 direct lily contexts, 64 extended lily contexts, 97 shaped platforms and 11 mixed wet cells**
- Existing lily Tile underlays verified without duplication: **277**
- New missing assets or out-of-bounds crops: **zero**

All previously successful liquid coordinates are excluded from this augmentation; the audit asserts that none receives a replacement or duplicate plan. The five newly supported ordinary slopes are dry shape candidates; the other 1,283 supported targets carry their original nonzero liquid bytes. No raw amount or kind is changed.

The four existing required assets are `water_0.png`, `water_1.png`, `water_11.png` and `LiquidSlope_0.png`. The existing `Tiles_518.png` underlay texture is reused by the original tile planner. Remaining omissions are exactly **1,472 possible-waterfall origins, 763 Shimmer events and five dry mixed halfbricks**. Bubble/Grate contexts are still rejected if encountered elsewhere. This result is not a claim that all liquid rendering is finished.

Audit script/report: `artifacts/audit-special-liquid.mjs` and `artifacts/liquid-special-coverage.json`.

## Integrated verification

The integrated `core/liquid.mjs` SHA-256 is `7c4697118e0c45e2031a59449f374b9b876ae98a894177957b6a639084099675`. `artifacts/liquid-special-integration-comparison.json` compares it directly with the saved pre-integration planner (`2dea9e387624ee923744e1575e644b18aa82bca3a37a8f3a644b6620816117f3`) across the entire world. All **968,789 previously successful liquid cells retain byte-identical command objects**, with zero lost cells or newly omitted coordinates. Commands increase from 1,177,348 to 1,178,638; omission events drop from 3,528 to 2,240.

The renderer and frame adapter concurrently received a separately owned Shimmer pass. This does not affect the direct old/new `planLiquids` comparison; its two directly compared liquid modules remained unchanged during that check. The independent combined-scene report, `artifacts/coverage-special-integrated.json`, therefore records **1,477** remaining events: 1,472 waterfall-state cases and five dry mixed halfbricks. It also verifies zero unsupported Tiles, zero missing textures, zero invalid crops and 379 required assets. The Shimmer reduction is attributed to that separate composition change, not to this helper.

The six related test files pass **79 tests**, including eight dedicated integration tests. The integration adds `specialContextDrawn` and `lilyUnderlayCells` counters without duplicating evaluated-cell counts. Three integrated ROI renders retain the candidate's exact resulting pixels (`candidatePixelsChanged: 0` for every ROI); their report is `artifacts/liquid-special-integrated-qa.json`. No renderer, frame-adapter or public resource-list edit was needed for this integration.

## Tests and native pixels

The ten tests in `test/liquid-special-context.test.mjs` cover cache-field preservation versus erased air, extended neighbors, saved lily crop/lift, foreground underlay ordering, rejected lily states, solid-top platforms, mixed-kind wet seed identity, dry mixed rejection, ordinary slope parity, unknown/special contexts and an asymmetric foreground composition pixel check. Original cells remain unchanged and no duplicate lily Tile command is emitted.

Strict fullbright frozen-frame ROI comparisons used the actual assets from `example/assets`, with the existing raw-game channel pipeline:

| ROI               | World rectangle   | Added commands | Changed pixels |
| ----------------- | ----------------- | -------------: | -------------: |
| Lily pond         | (465,416), 28×24  |             11 |          2,423 |
| Sloped platform   | (306,1254), 28×24 |              3 |            720 |
| Mixed water/honey | (928,1244), 28×24 |              2 |            352 |

All three had zero missing textures, invalid crops, skipped effects and candidate failures. Images are `artifacts/liquid-special-{lily-pond,sloped-platform,mixed-water-honey}.png`; the report is `artifacts/liquid-special-qa.json`. The audit and images demonstrate actual source-pixel additions. They are not a running-game pixel oracle or a reconstruction of runtime lighting/camera/cache state.

## Pinned behavioral references

Terraria commit `8255d34616c780af12079425ac92a0a7aed87d71`; no decompiled source text is distributed by this candidate.

- [Bubble, LilyPad and Grate IDs](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.ID/TileID.cs#L1195-L1529)
- [Raw liquid-cache fields and seed preparation](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L191-L245)
- [Wet source type/opacity and falling contributions](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L250-L280)
- [DrawTileInWater before normal liquid](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L634-L673)
- [Wet lily saved sprite and displacement](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L58458-L58477)
- [Wet lily skipped by ordinary single-tile drawing](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L872-L884)
- [Behind-liquid special, mixed and directional branches](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L3856-L4181)
- [SolidOrSlopedTile](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L70525-L70563)
