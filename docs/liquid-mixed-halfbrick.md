# Dry mixed halfbrick liquid

`core/liquid-mixed-halfbrick.mjs` resolves the five dry, solid halfbricks that remained after the special-context candidate. It is a bounded independent helper. It does not change the live planner, renderer, manifests, saved records or raw world bytes.

## API and insertion point

```js
const sampleMixed = createMixedHalfbrickLiquidSampler(region, {
  ...liquidOptions,
  waterfallRegistry,
  // Optional explicit 15-element frozen Main.liquidAlpha model:
  // liquidStyleAlpha: [...],
});
const result = sampleMixed(worldX, worldY);
```

Call only for an existing mixed-neighborhood rejection whose own tile is an active, non-actuated, known-solid halfbrick with **raw liquid zero**. A successful result contains `commands`, `requiredAssets`, `normalDrawn`, `occluded`, `gradientRows`, `clampedRows`, `primaryTexture`, `waterPresent`, `layerDecisions`, `waterfallDecision` and `liquidStyleAlpha`. A failure has an explicit reason and no partial commands.

Use the same `waterfallRegistry` as the waterfall renderer and other halfbrick helpers. Registered origins suppress the separate behind-tile pass. A false membership due to the chosen viewport/cap preserves it. Missing authoritative membership is rejected when registration remains geometrically possible. This suppression is independent of the normal upper-half liquid pass.

The default frozen liquid-style vector has 1 at the chosen `waterStyle` and 0 at every other index. This is an explicit, settled single-water-style rendering choice, **not a value recovered from WLD**. Callers can provide all 15 finite factors in [0,1] to model a different frozen source state. Results record a private copy of the vector so the rendering choice is reviewable.

The helper is deliberately limited to dry mixed halfbricks. It rejects wet targets, ordinary single-kind contexts, Shimmer, unknown solids, special Bubble/LilyPad/Grate dependencies and missing normal-pass context. Existing helpers remain responsible for those contexts. No input tile is recolored, relabeled as another liquid, or copied into a synthetic uniformly wet neighborhood.

## Direction and separate water layer

The behind-tile source walks its own eligible amount, then west, east, north and south. A dry target contributes nothing. Each non-water neighbor overwrites the primary texture. A water neighbor only records that a water layer is present; it does not overwrite the current lava/honey primary. Diagonals are not inputs to this pass. A positive south amount can overwrite the material even when it is at most 240 and therefore does not enable a south-only rectangle.

For these halfbricks all four cardinal directions are eligible. Geometry still follows the source's independent inflow flags: north, west, east, or south above 240. Max side level drives two-pixel quantization. Raw north liquid creates the source's 12- or 16-row behind quad and, underground, its top-zero/bottom-fullbright gradient. Source Y beyond the atlas bottom explicitly clamps to row 15.

The primary material chooses the first opacity factor. Lava uses the selected player lava opacity, honey uses 1, and water starts at 0.5, with the source's surface/wall adjustments. The resulting fullbright vertex endpoint is truncated to a byte.

When any eligible cardinal input contains water, the source finds the first active water style different from the primary and draws that additional water layer with the already computed vertex colors. The extra style's alpha is only an eligibility test at this call site; it is not multiplied into that first layer. Then the primary layer's already-quantized endpoint is multiplied by its own frozen liquid-style factor and truncated again. The helper preserves that order. A primary endpoint of zero contributes exactly zero premultiplied RGB and alpha and is recorded as `emitted: false`, rather than inventing a visible layer.

Normal liquid geometry is sampled separately with `createVisibleLiquidSampler` against the original unchanged world records. In a dry halfbrick with raw liquid above, the normal cache promotes its level and takes the north liquid type. Diagonal mixed kinds do not justify changing that seed. Failure in the normal pass discards any prepared behind commands atomically.

## Exact fixture cases

All five positions below have raw liquid zero in the pinned 8,400 × 2,400, version-315 fixture, SHA-256 `d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab`.

| Coordinate  | Source decision under the documented frozen model                                                                                 | Added liquid commands |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------: |
| (413,1668)  | East honey overwrites west lava; no water input; original `Liquid_11`                                                             |                     1 |
| (1608,2085) | Cardinal honey, diagonal lava; registered waterfall suppresses behind pass; no north normal pass                                  |                     0 |
| (4573,1943) | East lava is primary, south water enables extra water; extra `Liquid_0` inherits lava opacity 1, primary lava style alpha is zero |                     1 |
| (4640,2015) | Cardinal north water; lava exists only diagonally; 12 water gradient rows plus original normal upper-half command                 |                    13 |
| (4649,2015) | Cardinal north water; lava exists only diagonally; 12 water gradient rows plus original normal upper-half command                 |                    13 |

This adds 28 actual liquid commands across four drawn cells, with one correctly suppressed cell. It needs only existing `Liquid_0.png`, `Liquid_11.png` and `water_0.png`. The suppressed coordinate's waterfall is still drawn by the shared waterfall registry; the zero liquid command count is not an empty replacement for that waterfall.

The independent audit `artifacts/audit-mixed-halfbrick-liquid.mjs` verifies every saved raw record and the world bytes remain unchanged, renders five authentic-texture scene ROIs, and records the exact plans. `artifacts/liquid-mixed-halfbrick-coverage.json` reports zero missing/invalid assets and zero skipped effects. Added liquid changes 152, 0, 156, 144 and 144 pixels respectively. PNGs are `artifacts/liquid-mixed-halfbrick-X-Y.png`. These native fullbright comparisons are not running-game/GPU oracle captures.

Eleven dedicated tests cover directional precedence, low south amounts, diagonal independence, separate water/primary alpha factors, sequential byte truncation, original normal sampling, PointClamp, registry membership, wall suppression, explicit rejected contexts and atomic failure. The combined mixed-halfbrick, original halfbrick and waterfall suites pass 41 tests.

## Responsive shared-waterfall integration

The browser should not synchronously scan the entire world whenever a file or camera view changes. Its current `drawViewport` already computes `view.rect`, extracts `view.context`, and has revision/current-request checks. The smallest consistent addition is:

1. Keep a parsed immutable world and registry cache in a dedicated module Worker. Initialize it once per world revision. Preserve the original file bytes needed by existing export/edit flows; transferring their sole ArrayBuffer would detach it.
2. Request a registry for the explicit tile-aligned `view.rect`, frozen options and world revision. Return a snapshot ID, complete origin membership, scan/failure metadata and `commandsFor(region.rect)` for that **same snapshot**. A main-thread proxy can answer `hasOrigin` from the returned membership set only after a complete scan. Registry functions themselves are not structured-cloneable.
3. Pass that proxy to liquid/halfbrick planning and insert the returned waterfall commands in the matching scene. Publish the completed scene atomically only if its request/revision is still current. Never combine newly suppressed halfbricks with old waterfall commands or vice versa.
4. Permit one in-flight computation and retain only the newest pending viewport request while dragging. Keep the last completed scene visible. Discard stale responses with existing request/revision checks. Abort by replacing the worker on world changes if needed; an AbortSignal does not interrupt this synchronous scan loop by itself.
5. Cache by world revision, exact viewport rectangle and all frozen options. Full-world export uses one whole-world registry computed off the main thread, then reuses it for all output chunks. Chunk queries must retain intersecting overhang sprites even when their owners are outside the chunk.

At quality 1, a tile-aligned viewer viewport expands by 101 tiles to the left/top, 102 tiles to the right and 22 below, clipped to the source scan limits. Actual measurements on this fixture using the existing cold RLE accessor: an 84 × 64 view scans 53,669 cells in 117–193 ms; a 128 × 128 view scans 83,081 cells in about 300 ms. This is much less work than the approximately 6.8-second full-world scan, but still long enough to justify a Worker rather than merely an `async` wrapper or `requestAnimationFrame`. These are local measurements, not promised browser timings.

A viewer fresh-viewport snapshot and a full-world snapshot are distinct rendering models: scan/cap winners and the first-seen texture order can differ. Do not assemble a whole-world export from independently created viewport registries and claim equivalence. The existing shared-registry full scene/chunk tests establish equivalence only for chunks querying the **same** registry. If the viewport exceeds the explicit scan/command budgets, report it or select a clearly labeled lower-quality model; do not silently treat an incomplete registry as authoritative absence.

## Pinned source references

- [Raw cardinal inputs and registered-halfbrick suppression](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L3856-L3894)
- [Directional liquid selection, geometry, extra water and primary layer](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Drawing/TileDrawing.cs#L3932-L4181)
- [Water-style classification and gradual liquid-alpha updates](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria/Main.cs#L58378-L58428)
- [Normal halfbrick promotion and crop](https://github.com/Live-yum/TerrariaDecompiledSource/blob/8255d34616c780af12079425ac92a0a7aed87d71/Terraria.GameContent.Liquid/LiquidRenderer.cs#L513-L529)

No decompiled source text or original textures are included in distributed implementation files.
