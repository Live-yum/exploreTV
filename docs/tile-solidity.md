# Source-backed tile solidity

`core/tile-solidity.mjs` supplies a complete, bounded classification for the pinned vanilla tile IDs. It replaces the assumption that a tile is solid or non-solid according to whether the preview already has a rendering implementation for it. This is a candidate module; the live renderer and liquid planner were not changed during this task.

## API and minimal integration

```js
import { isSolidOrSlopedTile } from "./tile-solidity.mjs";

const liquidPlan = planLiquids(region, {
  ...options.liquids,
  isSolid: isSolidOrSlopedTile,
});
```

In `core/renderer.mjs`, replace the entire existing `isSolid` callback passed to `planLiquids` with this predicate. Do not combine it with `ORDINARY_BLOCKS`, supported sprite lists or texture existence. The caller still owns actual tile records and missing world context. The liquid planner retains its special-tile, mixed-liquid, shape and shimmer exclusions.

- `classifyTileSolidity(type)` returns the material classification used by the default `WorldGen.SolidOrSlopedTile` predicate, excluding per-cell activation.
- `isSolidOrSlopedTile(tile)` additionally checks the decoded cell's `active` and `inactive` state. Halfbricks and slopes keep their material's solidity. An absent/inactive cell does not block liquid; a missing or malformed record remains unknown.
- Both return `true`, `false` or `undefined`. Unknown IDs, IDs outside the pinned range, and active runtime-changing type 379 return `undefined`. Neither function coerces strings into tile IDs.
- Optional `{ includePlatforms: true }` matches the source predicate's optional platform inclusion. The normal liquid renderer needs the default `false`. Solid-top furniture 239 and 380 remains excluded even with platform inclusion because neither is a platform.
- Read-only exports record `SOURCE_TILE_COUNT`, `SOURCE_SOLID_TILE_TYPES`, `SOURCE_SOLID_TOP_TILE_TYPES`, `SOURCE_PLATFORM_TILE_TYPES` and `TILE_SOLIDITY_SOURCE`. The solid list is the raw initialization table and therefore includes 379; callers should use the functions rather than treating that raw list as a runtime guarantee.

When integrating, add `core/tile-solidity.mjs` to the provenance lists in `scripts/audit-world.mjs`, `scripts/render-full-world.mjs` and `scripts/export-world.mjs`. No new asset, renderer geometry or shader support is required.

## Complete initialization evidence

The reference is pinned to commit `8255d34616c780af12079425ac92a0a7aed87d71`. `TileID.Count` is 754. `Main.tileSolid` and `Main.tileSolidTop` are newly allocated boolean arrays of exactly this length, so IDs 0–753 initially have proven false entries. This bounded default is a source fact; it is not an assumption that an unrecognized material is air.

Initialization calls `Initialize_TileAndNPCData1` before `Initialize_TileAndNPCData2`, even though their bodies appear in the opposite textual order. Both complete bodies were examined in actual call order. The independent local extractor accounted for every assignment to these arrays, including all numeric loop assignments:

- 255–268: solid
- 435–439: both solid and solid-top
- 727–732: solid

There are 324 true raw solid entries and 84 true solid-top entries. Their intersection is exactly 19, 239, 380, 427 and 435–439. The platform set is 19, 427 and 435–439. After excluding solid-top entries and reserving active type 379 as unknown, the default material predicate produces **314 true, 439 false and one undefined** result across the 754 known IDs.

The full solid-top table matters. It contains furniture entries beyond platforms; simply excluding the seven platform IDs would incorrectly retain 239 and 380 as liquid-blocking solids. The source predicate also excludes actuated cells and includes sloped/halfbrick material, unlike the separate `SolidTile` predicate, which excludes slopes and halfbricks.

Rolling cactus 484 is explicitly initialized solid at Main line 7646. Its membership in an implemented sprite group cannot make it non-solid. Tests verify that it blocks a normal liquid pass and that actuation disables this blocking. Other useful cross-checks include closed door 10 (solid), open door 11 (non-solid), cobweb 51 (non-solid), and the high-range defaults 751–753 (non-solid in this pinned source).

The only `Main` assignments outside the two initialization bodies toggle type 379 during the per-frame world update. It remains unknown. `WorldGen` also changes several tables temporarily during world generation, including boulders/rolling cactus, cracked bricks and biome blocks. Generation backs up the original solid table and restores it in its `finally` path. This helper models a loaded vanilla world using the initialized/restored table, not an in-progress generation pass, a modded table, or a runtime snapshot taken inside a temporary mutation. It does not blanket-reject all generation-mutated materials or silently assume the current phase for type 379.

Local evidence files `artifacts/extract-tile-solidity-facts.py` and `artifacts/tile-solidity-source-facts.json` independently extract both initialization bodies in call order, expand every array-writing range, record assignment line numbers and reject unresolved array assignments. The audit compares all exported table entries and all 754 classifier results with those independently extracted facts. Only factual ID tables and original implementation code are distributed, not decompiled source text.

## Full-world before/after audit

`artifacts/audit-tile-solidity.mjs` compares the current live `planScene` liquid commands/report with `planLiquids` using only the new callback. It does not patch either module. The input is `fixtures/example-world.wld`, 8400×2400, SHA-256 `d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab`. All 20,160,000 cells were processed. The final audited renderer hash is `a97f5f4fd4fd7dd5fe22a6183ae0b1c88df99843af429ba0cd808479b850fade`, and the final audit verified that all four source modules remained unchanged during the scan.

The baseline had already improved since the earlier 16,736/837 unknown-reason counts mentioned in planning. This fixed scan measured:

| Metric                                      | Existing callback | Source classifier |
| ------------------------------------------- | ----------------: | ----------------: |
| Total liquid omission events                |            32,865 |            16,251 |
| Immediate unknown-solid events              |            16,245 |                 0 |
| Extended visible-level unknown-solid events |               797 |                 0 |
| Cells with liquid commands                  |           939,465 |           956,066 |
| Liquid commands                             |           968,315 |           985,613 |

**16,614 omission events disappear:** 16,601 gain actual liquid commands; seven are supported without a visible command; six are proved solid cells that correctly emit no normal liquid command. This distinction prevents counting every resolved report event as newly painted liquid. New shape cells can have more than one valid command because existing PointClamp overflow splits remain in effect.

Another 428 immediate unknown-solid events are reclassified as existing geometry limitations after the material becomes known: 93 halfbrick-waterfall, 180 halfbrick-overlap, 15 shape-non-solid, 116 special-tile and 24 extended special-tile dependencies. These events remain explicitly unresolved. The full result has **zero new omission coordinates, zero lost previously rendered cells and zero changed commands at previously supported cells**. The fixture therefore did not exercise a previously emitted incorrect 484 liquid command; that correction is established by the source fact and synthetic negative test rather than falsely attributed to these observed map changes.

All 985,613 candidate commands were checked against the actual PNG dimensions. There were **zero missing assets and zero invalid crops**. The same nine water/lava/honey normal and shape PNGs suffice. No runtime active-stone cell was inferred to be air. Its existing special-tile guard remains visible in the report.

Remaining omissions are 11,372 halfbrick overlaps, 2,823 waterfall-state halfbricks, 1,116 special-tile neighborhoods, 64 extended special-tile neighborhoods, 97 non-solid shapes, 16 mixed-liquid cases and 763 shimmer cases. Correct material classification does not establish complete liquid rendering.

## Tests and visual evidence

`node --test test/tile-solidity.test.mjs test/liquid.test.mjs test/liquid-visible-level.test.mjs` passes 48 tests, including seven new tests for the complete ID domain, expanded range endpoints, rolling cactus/door facts, all solid-top/platform distinctions, slopes/halfbricks/actuation, unknown/malformed values and the liquid-planner callback contract.

Two actual-map ROI comparisons use strict source-texture rendering with original game-channel handling and frozen fullbright liquid frames:

- World rectangle (0,492), 28×24: 41 added commands and 9,688 changed pixels around known non-solid ocean plants/decorations
- World rectangle (70,1928), 28×24: one added command and 256 changed pixels from a resolved extended liquid dependency

Both have zero missing textures, zero invalid crops and zero skipped effects. They are saved as `artifacts/tile-solidity-known-nonsolid.png` and `artifacts/tile-solidity-extended-neighbor.png`, with `artifacts/tile-solidity-qa.json`. The full audit is `artifacts/tile-solidity-coverage.json`. These are local QA artifacts; there is no running-game pixel oracle or claim that other framing/lighting limitations have disappeared.

## Pinned source references

- [Boolean table allocation](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L1480-L1482)
- [Initialization call order](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L6790-L6792)
- [Initialization body 2 and solid-top entries](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L6982-L8606)
- [Initialization body 1 and numeric ranges](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L8615-L10790)
- [Rolling cactus and boulder solid flags](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L7644-L7655)
- [Runtime active-stone toggles](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L17969-L18025)
- [Platform set](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.ID/TileID.cs#L243) and [tile count](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.ID/TileID.cs#L1945)
- [SolidOrSlopedTile predicate](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L70525-L70563)
- [World-generation backup and finally restoration](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L11100-L11140), [table restore](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L22710-L22716)
