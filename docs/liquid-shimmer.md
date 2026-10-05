# Frozen Shimmer liquid sprites

`core/liquid-shimmer.mjs` is an isolated planner and raster helper. It uses the
actual Shimmer atlases, world-coordinate colors, two-triangle interpolation,
base/sparkle draw order and separate behind-tile passes. It does not relabel
Shimmer as water, recolor a water image, invent a polygon or change saved Tile
records. Nothing in this module installs a shader or executes a game binary.

The selected default snapshot is modern liquid rendering, animation frame 0,
`timeForVisualEffects = 0`, `colorProfile = "xna"`, background pass. This is an
explicit reproducible rendering profile, **not** platform detection and not a
claim that every Terraria runtime has identical Color packing. Dynamic lighting
is unnecessary here: the inspected Shimmer helpers overwrite all four lighting
colors. There is no custom Shimmer shader in `DrawShimmer`.

## Source evidence

The Terraria reference is pinned to
[`8255d34616c780af12079425ac92a0a7aed87d71`](https://github.com/Live-yum/TerrariaDecompiledSource/tree/8255d34616c780af12079425ac92a0a7aed87d71).
Only facts and an original implementation are included; no reference source or
shader binary is copied into the deliverable.

- `Terraria.GameContent.Liquid/LiquidRenderer.cs`, `InternalPrepareDraw`,
  approximately 163–617: normal liquid geometry, halfbrick inheritance, dry
  bridges, ten-cell Shimmer fall attenuation, edge smoothing, corners and the
  extraction of `VisibleType == 3` into the special cache.
- The same file, 682–806: `DrawShimmer`, colors, noise and frames. Base uses
  `Images/Misc/water_14`, Y=1280 for the special surface row, otherwise the
  normal animation clock times 80. It never substitutes the waterfall clock.
  Sparkles start again from the unanimated geometry crop, add 48 to source X
  and use the world-coordinate Shimmer frame times 80. Interior sparkle cells
  require even X+Y. The source's `top` test is crop X != 16 or crop Y%80 != 48;
  it does not simply mean the pond surface.
- `Terraria/Main.cs`, 58439–58472: modern/retro dispatch, source behind-tile pass,
  normal liquids then Shimmer; the separate active-tile-518 interaction.
  `hslToRgb` and `hue2rgb`, 48740–48799, perform the hue calculation in double
  after a float hue and explicitly use `Math.Round` (ties to even).
- `Terraria.GameContent.Drawing/TileDrawing.cs`, 449–466 and 523–533:
  behind-block and solid-tile prepass calls. `DrawTile_LiquidBehindTile`,
  3856–4181, selects geometry and calls `SetShimmerVertexColors` **after** the
  ordinary water alpha, wall suppression and halfbrick gradient. Those earlier
  lighting reductions are overwritten for Shimmer. `DrawPartialLiquid`,
  4531–4563, uses `Liquid_14` behind ordinary blocks; the solid-tile prepass
  selects `LiquidSlope_14` for slopes. These are distinct source passes.
- `Terraria.Graphics/TileBatch.cs`, 178–183, 199, 215–228, 640–664: vertex order
  TL, TR, BR, BL; triangles 0-1-2 and 0-2-3; PointClamp; normal SpriteBatch blend
  and effect defaults. The diagonal is TL→BR, not a bilinear patch.
- `Terraria/Utils.cs`, `Remap` and `GetLerpValue`: clamped remapping used by the
  interior glitter envelope. Shimmer's base Vector4.Lerp weight is instead
  deliberately **unclamped**, including its negative values.

The ordinary default framework pixel effect multiplies sampled texture RGBA by
interpolated vertex RGBA. Premultiplied AlphaBlend uses source One and
destination InverseSourceAlpha. Source-only corroboration:
[FNA SpriteEffect](https://github.com/FNA-XNA/FNA/blob/master/src/Graphics/Effect/StockEffects/HLSL/SpriteEffect.fx)
and [FNA BlendState](https://github.com/FNA-XNA/FNA/blob/master/src/Graphics/States/BlendState.cs).
Sparkle vertices have alpha zero and nonzero RGB. Their RGB therefore adds to
the current destination while leaving destination alpha unchanged.

### Color packing profiles and reproducible golden values

A namespace/reference to `Microsoft.Xna.Framework` in the pinned project does
not by itself identify the actual runtime implementation on every platform.
The default `xna` profile is a deliberate snapshot choice. The alternative
`fna` profile makes the relevant byte-packing difference explicit.

- `xna`: normalized float/vector Color constructor multiplies in float, clamps
  and rounds ties to even; Color×float truncates channel products toward zero.
- `fna`: constructor and Color×float truncate after their float arithmetic.
- Main.hslToRgb's explicit double `Math.Round` remains ties to even in both.
- Quantization is not postponed: base is White×opacity, then ToVector4×base
  color, then a Color constructor. Glitter is HSL Color, alpha=0, ToVector4×
  glitter opacity, Color constructor, then Color×cache opacity.

The XNA evidence is a publicly recorded test of genuine XNA 4.0, read as data;
no assembly was executed for this work:

- [Oracle test source, pinned CNA commit](https://github.com/libcna/cna/blob/009d40f5dd085c4e674d3479675fac84b12b3e0a/tools/xna-pipeline-oracle/framework/FrameworkPackingOracle.cs#L114)
- [Recorded XNA 4.0 results at the same commit](https://github.com/libcna/cna/blob/009d40f5dd085c4e674d3479675fac84b12b3e0a/tests/reference/xna40/framework/framework-packing-oracle.json)
- [FNA Color implementation](https://github.com/FNA-XNA/FNA/blob/master/src/Color.cs)

Recorded XNA constructor quarters are `[64,128,191,255]`; midpoint channel
inputs 126.5,127.5,128.5,129.5 produce `[126,128,128,130]`; White×0.5 produces
`[127,127,127,127]`. FNA's float constructor truncates those quarter inputs.

The module's test has these fixed source-derived color goldens:

| Operation at world (0,0), visual time 0 | xna             | fna             |
| --------------------------------------- | --------------- | --------------- |
| Base top-left, opacity 1                | 169,138,240,255 | 169,137,239,255 |
| Base top-left, opacity 0.5              | 84,68,119,127   | 84,68,119,127   |
| Top sparkle, opacity 1                  | 128,0,0,0       | 127,0,0,0       |

## API and integration contract

`createShimmerLiquidSampler(region, options)` returns a memoized function of
world X/Y. `planShimmerLiquids(region, options)` enumerates a bounded region.
The region/cell format is the existing column-major decoded world format;
`region.context` and a read-only `getWorldTile` callback can provide context.
All saved fields and raw bytes remain unchanged.

Options include `frame`, `timeForVisualEffects`, `colorProfile`, `worldSurface`,
`isSolid`, `getWorldTile`, `layer: "background" | "foreground"` and an optional
`hasWaterfall(worldX,worldY)` returning true/false from a known registry.
`renderMode: "retro"` is explicitly unsupported. Missing or unknown context
returns a reason instead of assuming empty tiles or a different liquid.

Sampler success is `{supported:true, commands, requiredAssets, occluded,
normalDrawn, shapeDrawn}`; failure is `{supported:false, reason}`. The planner
also reports saved Shimmer cells separately from dry shape and other candidates.
A stored wet-cell coverage denominator must not include dry shape candidates.

Commands preserve the existing sprite fields `asset`, source crop, destination,
world coordinates, liquid level/type, layer and `drawBeforeTiles`. They add:

- `vertexColors: {topLeft, topRight, bottomLeft, bottomRight}`, each RGBA8.
- `interpolation: "triangles-tl-br"`, `inputEncoding: "tconvert-game-raw"`.
- `shimmerPart: "base" | "glitter" | "behind-tile"`.
- `opacity: 1`: the source opacity has already been applied to vertex colors.
  Do not multiply the same opacity a second time in the draw consumer.
- Optional `vertexDomain: {x,y,width,height}` keeps the original quad's color
  interpolation when an overflowing slope crop is split into valid PointClamp
  rows. Background `Liquid_14` is 72 pixels high and needs no false 16px clamp.

Render behind-tile commands before the foreground Tile layer. Within normal
Shimmer rendering, preserve each cell's base-before-glitter order. Background
and foreground plans are two different source passes; choose the actual pass
being rendered rather than drawing both wholesale into the same pipeline slot.

`shimmerBaseVertexColors(x,y,opacity=1,time=0,{colorProfile="xna"}={})` and
`shimmerGlitterVertexColors(x,y,opacity=1,top=true,time=0,{colorProfile="xna"}={})`
are shared with Shimmer waterfalls. Lower-level exports are `shimmerBaseColor`
(the unquantized source Vector4), `shimmerWave`, `shimmerGlitterColor`,
`shimmerGlitterOpacity`, `shimmerFrame`, and `shimmerNoise`.

`interpolateShimmerVertexColors(vertices,u,v)` returns floating byte channels.
For u>=v it uses TL×(1−u)+TR×(u−v)+BR×v; otherwise TL×(1−v)+BL×(v−u)+BR×u.
`rasterizeShimmerCommand(command,rawImage)` returns at most a 64×64 crop,
`{width,height,data,encoding:"premultiplied-excess"}`, using native pixel centers.
It also handles compatible waterfall source commands, including flipped UVs.
No pixel is expanded into an individual scene draw command.

The raster helper requires the original decoded PNG sample bytes, preserving
alpha-zero RGB. Canvas straight-alpha readback loses this information. Output
must be composited as P+D×(1−A), or split into source-over and additive parts
while retaining draw order on an opaque scene target. Directly putting output
into straight-alpha ImageData and drawing it normally is incorrect.

### Prepared scene frames

`prepareSceneFrames` now accepts `vertexColors` directly. It preserves original
raw channels, applies paint and any uniform vertex tint first, then samples the
four-corner ramp using native destination pixel centers. Corner frames have
`width=dw`, `height=dh`, and `uvFlipApplied=true`; ordinary frames retain source
crop dimensions and `uvFlipApplied=false`. `renderScene` reads those dimensions
and only applies UV flips that were not already baked into a prepared frame.
Texture flips do not reverse the destination's corner-color ramp.

The corner cache key contains ordered four-corner colors, destination size,
relative vertex-domain offsets/size, UV flips and interpolation mode, in addition
to the existing asset/crop/paint/uniform-color fields. Translated equivalent
quads reuse frames; clamped subintervals and different destination sizes do not.
Malformed corner metadata, incompatible declared input encoding, missing raw
channels, frame budgets and nonrepresentable transparent output remain explicit
failures. A corner command without a prepared frame is skipped with a warning;
its untinted source image is never silently drawn.

`test/scene-frames-corners.test.mjs` adds 13 tests for native triangles, retained
low/zero-alpha RGB, XY UV flips, clamped gradient intervals, cache identity,
legacy-frame compatibility, opacity, paint/tint order and eight-layer blending.
The actual frozen pond uses 439 prepared frames including its flat backdrop,
with zero skipped commands; full-image pixels differ by at most two channel
levels from the independent raw-pixel compositor. Eight mixed synthetic layers
use the existing conservative six-byte accumulated Canvas tolerance. These are
CPU/Canvas comparisons, not graphics-driver or running-game screenshot claims.

## Original assets

Read-only retrieval used the authorized `Live-yum/TConvert` repository under
`1.4.5.8ouput/Images`. PNGs remain under ignored `fixtures/private/shimmer/`;
asset-manifest publication is the parent task's separate integration step.

| Asset                | Dimensions | SHA-256                                                            |
| -------------------- | ---------- | ------------------------------------------------------------------ |
| `Misc/water_14.png`  | 144×1360   | `7b48569dce7f0d3216ef74ca641112a47f582b4852a97226a61c2d8ce66dcb3f` |
| `Liquid_14.png`      | 306×72     | `45261d749203308678cf0fe57928da64b2db6629e2e90546a1b655d036a4caa5` |
| `LiquidSlope_14.png` | 72×16      | `ec12687d55d0d1b10efe190eeaefd95964129718080de0b22dded95407405d5d` |

Git blob IDs respectively:
`f1d3616e1cd55a5730263f526dd7396296697c95`,
`a0d61eb0966522be938a58f970750904e75cfcdf`,
`d2e5a97f7a2fcc058aacc05f69dfc9c138b9efc8`.

## Verification and current saved-world coverage

Run `node --test test/liquid-shimmer.test.mjs`. Ten focused tests cover byte
profiles, independent BigInt noise arithmetic, frame truncation, separate clocks,
geometry, alpha rules, halfbricks/slopes, known failures, triangle interpolation,
raw additive channels, immutable input and actual original-texture pixels.
The fixture-backed test is skipped explicitly if the private assets/world are
unavailable; its synthetic tests remain runnable.

World `8400×2400`, version 315, SHA-256
`d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab`
was scanned through every saved RLE column. It contains **739 saved wet Shimmer
cells**, all inactive/shape-0/no-wall: 61 with level 127 and 678 with level 255,
within x801–861/y852–867. The previous 763 omission events are those 739 plus
**24 dry stone slopes/halfbricks**, not 763 saved wet cells.

For the complete pond ROI x789/y840, 85×40 tiles, both layer plans cover all
739 saved wet cells and all 24 dry shape candidates, with zero unsupported:

- 752 normal base sprites = 739 stored wet cells plus 13 dry halfbrick tops.
- 413 glitter sprites in either pass.
- 72 background behind-tile sprites = 24 dry shapes plus 48 adjacent full-solid
  cells; foreground has 82 after ten required PointClamp crop splits.
- 1,237 background commands; 1,247 foreground commands. No per-pixel commands.
- 61 other dry candidates are correctly occluded. No saved liquid bytes are
  altered, and smaller-ROI commands preserve crops and world-coordinate colors.
- Both plans rasterized 579,776 native pixels; 42,880 samples retained nonzero
  RGB with alpha zero. Glitter changes 21,440 pixels in the background ROI.

Generated evidence under `artifacts/shimmer/`:
`coverage.json`, `actual-pond-scene.png`, `actual-pond-component.png`, and
`actual-pond-base-only.png`. The scene PNG uses original terrain assets through
the existing terrain planner, plus this module's background Shimmer snapshot.
Terrain framing remains subject to that planner's preexisting approximations.
The separate component image exposes the liquid draw result, and the no-glitter
image verifies that additive sparkle contributes visible texture pixels.

## Prepared-frame budget (whole pond)

The frame-0/time-0 pond commands were deduplicated by asset, crop, destination
size, four corner colors, vertex domain and UV flips. Shimmer alone needs 438
background frames (384,640 base bytes + 262,656 additive bytes = 647,296 bytes)
or 452 foreground frames (388,736 + 262,656 = 651,392 bytes). Literal versus
relative vertex-domain keys yield the same counts in this particular pond.
Use relative destination-to-domain offsets for safe reusable keys; absolute
screen positions needlessly prevent reuse when the sampled ramp is identical.

The same ROI's existing terrain needs another 92 frames. Thus a complete scene
requires **530 background-profile frames or 544 foreground-profile frames**,
exceeding `maxFrames=512` even though their actual base/additive totals are only
807,312 and 811,408 bytes. In source layer order, a single first-512 preparation
would skip 24 terrain commands for the background profile; the foreground
profile would skip two base and 30 glitter commands. Geometry coverage alone
must therefore never imply complete prepared/rendered output.

Keep the existing 512-frame/8-MiB limits. Prepare, draw and dispose ordered
batches while retaining one opaque destination and clearing it only once.
The measured ROI fits in two dynamically budgeted batches. A generic conservative
batch limit of 256 distinct frames also respects 8 MiB at the existing worst-case
64×64 pixels and two RGBA buffers per frame. Include legacy paint/kind/type/
vertex-color keys in addition to the new corner/domain fields, and report
frame-budget failures separately if a caller chooses a single bounded prepare.
`artifacts/shimmer/frame-budget.json` records all counts, bytes and ordered batch
boundaries; `artifacts/shimmer/measure-frame-budget.mjs` reproduces them. No core
planner, shader helper or global frame limit was changed for this measurement.

## Deliberate limits

This is a source-derived frozen snapshot, not an in-game screenshot oracle.
GPU interpolation/target quantization can differ by low byte values. The test
checks source arithmetic and an independently described mathematical blend;
it does not certify a specific graphics driver's rasterization.

The geometry implementation is an independent Shimmer-aware adaptation of this
project's authored visible-liquid sampler. It retains the raw liquid identity
through all stages. It handles bounded interior dependencies; missing context,
unknown solidity/special tile neighborhoods, recursion beyond 384 dependencies,
invalid crops and ambiguous mixed behind-tile liquids return explicit failures.
It does not reproduce viewport-edge/stale cache artifacts.

Potential halfbrick waterfall origins require a known `hasWaterfall` answer.
Where source origin predicates prove a cell ineligible, the planner assumes a
fresh static origin scan; it does not reproduce stale runtime waterfall caches.
Retro rendering, biome postprocessing, particles, distortion, active tile 518
interactions and other runtime scene state are not implemented here. Neither
waterStyle nor the player's lava opacity affects the Shimmer path. General
scene integration, asset publication and dynamic lighting are outside this
isolated module.

## Integrated bounded scene path

The shared scene planner now merges this pass through `liquid-composite.mjs`.
Successful Shimmer coordinates replace only matching Shimmer omission reports;
ordinary successful liquid commands are preserved. The ordinary saved-cell
statistics and the separate `support.shimmer` candidate statistics have distinct
domains: the latter also counts derived dry trails and solid-neighbor sprites.

The Vue preview uses contiguous prepare/render/dispose batches. Each batch
reserves at most 256 distinct frames and 8 MiB including additive surfaces, and
the scene background is initialized once. The standalone viewport and native
export retain their streaming batches with destination-size corner reservations.
No frame is skipped merely because a complete pond needs more than 512 distinct
frames. Tests cover 600-frame scenes, additive ordering across batches, error
cleanup, and the bundled 739-wet-cell pond with 24 dry shape candidates.

The complete integrated planner audit processes 20,160,000 cells. With the shared
static waterfall registry and dry mixed-halfbrick rules it leaves zero known
liquid omissions in the specified fixture, using 384 necessary textures with
zero missing or invalid crops. This is local validation until the corresponding
commit and exact-head CI run are published; it is not a running-game
pixel-equivalence claim.
