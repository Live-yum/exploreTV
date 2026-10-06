# Frozen source-derived liquid geometry

`core/liquid-visible-level.mjs` is an original, deterministic implementation of the interior normal-liquid geometry equations in the pinned behavioral reference. It closes a large subset of the existing planner's `shape-visible-level-neighborhood` omissions. It also handles walled halfbricks with liquid above, for which the source suppresses the separate behind-tile pass.

`core/liquid.mjs` integrates this helper for previously unresolved non-solid liquid cells near shapes and eligible walled halfbrick overlaps. It produces frozen fullbright commands using the existing original PNG atlases. It is not a screenshot or a claim of pixel parity with the running game.

## API

```js
import { createVisibleLiquidSampler } from "./liquid-visible-level.mjs";

const sampleVisible = createVisibleLiquidSampler(region, {
  isSolid, // true/false only for proved material classifications; undefined otherwise
  worldSurface,
  waterStyle: 0,
  frame: 0,
  waterfallFrame: 0,
  lavaOpacity: 1,
  waterOpacity: 1,
  layer: "foreground",
});
const result = sampleVisible(worldX, worldY);
```

Construct one sampler per planned region and reuse it for candidates. It memoizes dependencies without mutating input records. `region.rect` and `region.cells` use the existing column-major contract. `region.context` may supply surrounding records. `options.getWorldTile`, otherwise `region.getWorldTile`, may supply additional decoded records when a dependency falls outside these rectangles. There is no implicit air outside either rectangle. The world accessor already returned by `readIndexedRegion` is suitable.

- `{ supported: true, command, behindTileSuppressed }` contains one normal-liquid command. Coordinates are relative to `region.rect`; the command also retains world coordinates and the raw liquid byte. Its `fidelity` is `static-source-visible-level`.
- `{ supported: true, occluded: true, behindTileSuppressed }` means this normal pass has no visible command. It does **not** establish that every other liquid pass is absent.
- `{ supported: false, reason }` preserves a specific unresolved dependency. Do not reinterpret it as an empty cell or a full liquid cell.
- `behindTileSuppressed: true` establishes the bounded case of an active known-solid halfbrick, a wall, and nonzero raw liquid above. Only this flag allows a successful normal result to replace an existing halfbrick-overlap omission.

Water styles accept 0, 2–10, 12 and 13. Lava selects `water_1.png`, honey selects `water_11.png`. All three verified atlases have dimensions 48×1360. Both 16-frame clocks wrap independently. Atlas X after cropping chooses the clock, including corner crops whose X is neither 0, 16 nor 32. Surface draws use Y 1280. No source rectangle crosses the verified atlas boundary; an invalid rectangle is an explicit failure rather than a clipped-and-stretched replacement.

## Integration boundaries

The planner retains its existing malformed-input, unknown-solid, mixed-kind, special-tile and missing-context checks. It instantiates the sampler lazily after those checks, using the same proved `isSolid` callback and liquid options.

1. In the non-solid `nearShape && !stableFull` branch, missing immediate context still rejects the target. Otherwise, a supported sample appends its command (if any) and marks the cell drawn or occluded. A failed sample retains an explicit omission under the helper's precise reason.
2. When `behindShape` reports `halfbrick-overlap-neighborhood` and the own tile has a wall, the planner samples the normal pass. It accepts only `supported && behindTileSuppressed`. The source's behind-tile alpha is zero for this exact case, so no second shape command is needed.
3. Existing saturated-shape subsets, slope `LiquidSlope` commands, other halfbrick passes, and fallback rejections remain intact. A normal-pass `occluded` result by itself cannot remove an unsolved behind-tile requirement.

Example branch fragment:

```js
const visible = sampleVisible(wx, wy);
if (visible.supported && (!ownShape || visible.behindTileSuppressed)) {
  if (visible.command) {
    result.commands.push(visible.command);
    assets.add(visible.command.asset);
    support.drawn++;
    support.sourceGeometryDrawn++;
    if (ownShape) support.shapeDrawn++;
  } else support.skippedOccluded++;
  continue;
}
```

This logic belongs only in the two qualified branches described above, not as a replacement for all own-shape handling. Global counters count the original liquid/dry-shape candidate exactly once. The implemented planner additionally increments `visibleLevelDrawn` for helper commands, and takes `commandCount` from the final commands array. These commands remain in the selected normal foreground/background layer; they are not `drawBeforeTiles` shape commands.

The helper can calculate dry bridges and short falling extensions, but this integration intentionally queries existing omission coordinates. Emitting commands into every dry cell, or replacing all approximate flat fills, would be a separate integration change requiring new accounting and scene-level review.

## Geometry and dependency boundaries

The solver normalizes raw bytes with single-precision arithmetic, promotes wet-above halfbricks, bridges qualifying opposite raw-liquid neighbors, and computes finite liquid trails (water 10 cells, lava 3, honey 2). Raw and bridge seeds can inherit a larger incoming level, so chains of partial seed cells may depend farther north than a fixed ten-cell halo. The sampler follows those actual dependencies; it does not assume ten cells always suffice.

The normal pass then computes the four visible walls, weighted boundary smoothing, ordered corner corrections, the quarter-cell lower bound, halfbrick upper-half restriction, atlas crops and opacity. The two corner passes preserve the source's column-major order: already-visited west/north dependencies and not-yet-visited east/south dependencies are distinct. A full local seed may safely terminate upstream level evaluation because no incoming level can exceed one and its own source resets opacity/type. This shortcut does not bypass any neighbor subsequently needed for edges, smoothing or corners.

The sampler refuses missing decoded records, unknown active-material solidity, malformed liquid/shape/kind records, the special overlap tiles 379/518/546, missing world-surface metadata for visible commands, shimmer output, invalid atlas crops and excessively deep dependency chains. Inactive tiles and the source's explicit platform set are treated as non-solid. Every other active material requires an explicit boolean callback result. The depth safeguard reports `visible-dependency-depth`; it never invents a terminating solid or a full liquid seed.

This is interior geometry evaluated from actual dependencies with fresh deterministic state. The game's finite draw cache, viewport padding, previous-frame cache contents, wave distortion, lighting and separate WaterfallManager state are not available in a saved world. Results near absent world boundaries remain unsupported. The helper does not reproduce runtime water-style crossfades, special in-water tile overlays, shimmer's separate color/sparkle passes, unwalled-halfbrick overlap gradients, or the separate waterfall manager. These omissions must remain visible in reports.

## Verification and actual-map evidence

`node --test test/liquid.test.mjs test/liquid-visible-level.test.mjs` passes 41 tests. It covers walled wet and dry halfbricks, unwalled negative cases, solid slopes, minimum geometry, weighted smoothing, ordered concave corners and their clock selection, same-kind dry bridges, different liquid trail lengths, solid interruption, inherited levels/source opacity, world-local offsets, foreground alpha, missing/unknown dependencies, shimmer rejection, malformed records, immutability and the depth safeguard. Integration tests also verify one-command accounting, unchanged raw dry-shape records, normal-pass layering and unknown dependencies beyond the original 3×3 preflight.

A full scan of `fixtures/example-world.wld` (SHA-256 `d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab`, 8400×2400) compared the helper against the resource checkpoint's existing omission coordinates:

- 42,032 candidates in the three relevant original reason groups
- 27,238 newly supported commands: 26,932 `shape-visible-level-neighborhood` and 306 `halfbrick-overlap-neighborhood`
- 13,839 candidates still needing a separate behind pass, 915 rejected for unknown solid dependencies, and 40 rejected for special-tile dependencies
- 0 invalid source crops and no new asset requirements

These initial candidate counts describe report events, not that many previously wet world cells: the original audit includes dry solid-shape candidates. The helper's stricter dependency checks can identify unknown materials outside the original 3×3 preflight and must be preserved.

The integrated full-world audit in `artifacts/coverage-visible-level-integrated.json` verifies the predicted reduction: **60,624 → 33,386 total liquid omissions**, with all 20,160,000 cells processed, zero missing assets, zero invalid crops, and the same 266 required assets. The previous `shape-visible-level-neighborhood` group is fully classified: 26,932 successful commands, 827 unknown-solid dependency rejections and 40 special-tile dependency rejections. Halfbrick overlaps add 306 successful commands and reclassify 10 failures as unknown-solid dependencies. The combined new precise failure group is therefore 837 unknown-solid and 40 special-tile events. Unwalled overlaps and waterfall-state-dependent cases remain unresolved. The earlier 915 candidate unknown-solid count also included halfbrick cases the narrow integration does not attempt.

Ignored local QA outputs are `artifacts/liquid-visible-level-audit.json`, `artifacts/liquid-visible-level-qa.json`, and three side-by-side PNGs. They are local evidence, not distributed game textures or source files. Strict renders used original texture bytes, frozen frame 0, the existing raw-game channel handling and no skipped effects:

- Water surface, world rectangle (14,750), 30×24: 3 added commands, 384 changed pixels
- Lava halfbrick, (30,2168), 28×24: 16 added commands, 3,648 changed pixels
- Water halfbrick, (268,772), 28×24: 2 added commands, 384 changed pixels

The integrated renderer repeated all three ROIs with the same added-command and changed-pixel counts; these outputs use the `liquid-visible-level-integrated-` prefix. All three had zero missing assets and zero invalid crops. Pixel changes show that actual atlas sprites fill previously omitted locations; they are not a comparison with a game-render oracle. Unrelated Tile/Wall framing remains subject to the existing renderer's fidelity limits.

## Pinned behavioral references

Reference commit: `8255d34616c780af12079425ac92a0a7aed87d71`. No decompiled source text is distributed with this implementation.

- [Raw, visible and falling liquid preparation](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L191-L282)
- [Wall geometry, smoothing, ordered corrections and draw-cache crops](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L284-L535)
- [Frozen normal-liquid atlas and opacity selection](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L622-L672)
- [Halfbrick behind-pass wall suppression and unwalled gradient](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L4137-L4157)
- [SolidOrSlopedTile material, platform and actuator checks](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/WorldGen.cs#L70525-L70563)
