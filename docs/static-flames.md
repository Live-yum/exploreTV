# Frozen furniture flame overlays

`core/static-flames.mjs` plans only the static flame sprites for tile types 33,
34, 42, 49, 93 and 100. These overlays require the existing furniture body.
They do not emit light, animate, spawn particles, or claim game-screenshot
equivalence. No game binary or copied decompiled implementation is included.

## Integration contract

Call `planStaticFlames(region, localX, localY, tile, options)` after planning the
furniture body and append its commands. The result is `null` for other tile
types, `{unsupported}` for unverified geometry/context, or an object containing
`commands`, `sourceDrawCount`, `style` and `offState`.

The commands use the same `asset`, `sx/sy/sw/sh`, `offsetX/offsetY`, `flipX`,
`opacity`, `paintId`, `vertexColor` and `staticOverlay` contract as furniture.
Keep their individual offsets and order. Convert destination coordinates with
`dx = localX * 16 + offsetX` and `dy = localY * 16 + offsetY`; do not replace
the jitter with the body destination. Every flame has `paintId: 0`, following
the unpainted flame texture path. Pass commands through the existing
`prepareSceneFrames` adapter so RGB with zero vertex alpha remains additive
over the opaque scene. Ignoring `vertexColor` changes both tint and blending.

`options.state` defaults to the exported `STATIC_FLAME_STATE`: unsigned
TileFrameSeed words `(low=0, high=0)`, `globalTimeWrappedHourly=0`, `wind=0`.
An explicit alternative unsigned seed or time in `[0,3600)` selects another
frozen snapshot. Nonzero wind is rejected. No timer or wall clock is read.
`options.revealInvisible` follows the existing scene visibility option.

For hanging objects, supply their complete read-only context through
`region.context` or `region.getWorldTile(worldX, worldY)`. The source chooses
an object seed from visible cells in column-major order, independently of the
selection origin. A missing anchor, missing preceding seed-selection cells,
or a missing lantern ceiling tile produces an explicit rejection. The
top-left chandelier occupies 3×3 cells; the lantern occupies 1×2 cells. Hidden
cells are not seed candidates unless invisible blocks are being revealed.
The source's special `(0,0)`/zero-seed sentinel is retained.

The planner does not load assets. The caller must include all assets named by
the commands in its normal preflight. Switched-off objects still retain their
source draws and texture requirements: a custom texture pack may put nonzero
pixels in an off-state column. Empty commands are used only for actual
source zero-flame styles or hidden/inactive cells. Do not clear another
furniture failure merely because this independent overlay planner succeeds.

## Source facts and deliberate distinctions

Facts were checked against `Live-yum/TerrariaDecompiledSource` commit
`8255d34616c780af12079425ac92a0a7aed87d71`, specifically:

- `Terraria.GameContent.Drawing/TileDrawing.cs`: normal routing near lines
  554–580; color helpers and `GetTileFlameData` at 1830–2704;
  `DrawSingleTile_Flames` at 2707–3490; draw-data atlas wrapping/height/offset
  rules; and `DrawMultiTileVinesInWind` at 9416–9790.
- `Terraria/Utils.cs`: `RandomNext`, `RandomNextSeed`, `RandomInt` at
  2415–2450; `WrappedLerp` near 305.
- `WorldGen.cs`: `IsBelowANonHammeredPlatform` near 38690.

The actual normal draw path matters:

| Type             | Texture      | Actual flame route | Geometry                                                |
| ---------------- | ------------ | ------------------ | ------------------------------------------------------- |
| 33, candle       | Flame_1.png  | Single tile        | 16×20; top −4                                           |
| 34, chandelier   | Flame_3.png  | Hanging multi-tile | 16×16; top −2; shared object seed                       |
| 42, lantern      | Flame_13.png | Hanging multi-tile | 16×16; top −2; another −8 below a non-hammered platform |
| 49, water candle | Flame_5.png  | Single tile        | 16×20; top −4                                           |
| 93, lamp         | Flame_4.png  | Single tile        | 16×16; top +2                                           |
| 100, candelabra  | Flame_2.png  | Single tile        | 16×16; top +2                                           |

The chandelier style is `floor(frameY/54) + 37*floor(frameX/108)`.
Its style 9 uses the multi-tile helper's three draws, each with exclusive
integer range `[-1,1)` multiplied by 2 on both axes. The single-tile method
contains a different style-9 recipe but is not the normal chandelier route.
Lantern style 11 likewise uses the helper's seven small-jitter draws.
Every hanging cell restarts the same selected object seed; the source does
not advance the shared seed between cells.

Lamp style 12 uses one draw with two jitter samples followed by independent
R/G/B samples from `[90,111)`. Lamp style 13 uses eight draws tinted
`(75,75,75,0)` in the actual single-tile method, even though its separate
helper specifies a different shade. These differences have regression tests.

Lantern atlas Y wraps at 2016 pixels and adds 36 pixels to X per page.
Candelabra uses the same Y period and adds 72 to X. Lamp wraps Y at 1998
and adds 36 to X. Candle and chandelier crops retain their saved atlas
coordinates. Shape variants are rejected; this implementation does not invent
half-block or slope flame geometry.

The generator recurrence uses multiplier 25214903917, increment 11 and a
48-bit mask, followed by the source's 31-bit extraction and signed-int
rejection sampling. Production uses exact base-65536 arithmetic and unsigned
32-bit words, with no BigInt requirement. Jitter multiplication uses float32
rounding. The synthetic Node tests compare it with independent BigInt
arithmetic, including a forced rejection and the zero-width range case.

## Texture requirements and measured fixture coverage

Six texture files were read from the authorized `Live-yum/TConvert`
`1.4.5.8ouput/Images` directory. Their byte hashes identify the actual inputs;
they were staged locally under the ignored private fixture directory, without
editing a distribution manifest.

| File         | PNG bounds | SHA-256                                                          |
| ------------ | ---------- | ---------------------------------------------------------------- |
| Flame_1.png  | 36×1412    | eb39a5b75dad1d73579d91916e59c8a0e28cfa01b652755f1f0ee5c78182f39b |
| Flame_2.png  | 142×2016   | a2ae91df9448d8c41e43b82f9a632f2b08e2c0d8bd6a0c11b99963db001b6db9 |
| Flame_3.png  | 214×2000   | e8d89570467e74dfc17cc588c54e9a3d18b57b5178629afc5b70dff3d7867677 |
| Flame_4.png  | 70×2048    | 9b0febccc0a81f0bb7d931d022277ebc674c2416aab4d33f4116f924bca39200 |
| Flame_5.png  | 18×22      | e661d5c8700c9283f52c99b880da20076315a27fa0473da3bd7096c76c731cfe |
| Flame_13.png | 70×2014    | 3b4def43c596a11e2eae1faf65542b33b3ab8486dd8d27c485679e60f98674e2 |

The public example WLD is SHA-256
`d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab`,
version 315, 8400×2400. A full record scan with world-coordinate halo access
produces the following bounded results. Source rectangles are half-open.

| Type  | Fixture cells | Off-state cells | Commands | Source crop union                  |
| ----- | ------------: | --------------: | -------: | ---------------------------------- |
| 33    |             5 |               0 |       35 | X [0,16), Y [22,570)               |
| 34    |          1440 |            1332 |    10080 | X [0,106), Y [0,1780)              |
| 42    |           108 |              28 |      756 | X [0,34), Y [36,1186)              |
| 49    |            28 |               0 |      196 | X [0,16), Y [0,20)                 |
| 93    |            78 |               3 |      546 | X [0,52), Y [540,1348)             |
| 100   |            88 |               0 |      616 | X [0,34), Y [792,1726)             |
| Total |          1747 |            1363 |    12229 | No invalid crops or rejected cells |

All four channels of the sampled original off-state crops are zero, but those
commands remain present. Tests also use a procedural nonzero off-state atlas
and verify its exact additive pixels, so original-atlas transparency cannot
silently become a rule for imported packs.

Run `node --test test/static-flames.test.mjs`. The fixture audit writes
`artifacts/static-flames-audit.json` when the example world and six textures
are available; the reported run completed without skipped tests. Source
facts, independent PRNG arithmetic, synthetic crop/color/jitter cases and
procedural pixel goldens are the verification basis. This is not a captured
game-window pixel oracle.

## Remaining limits

- Water-candle type 49 with off frameX 18 asks the game to sample outside its
  18-pixel-wide Flame_5 texture. The current bounded Canvas crop contract cannot
  represent this PointClamp case; the planner explicitly rejects it. This
  state does not occur in the measured fixture. It is not silently discarded
  based on this particular PNG's zero-valued right edge.
- Styles beyond the source's highest verified families are rejected: 63 for
  candle, 70 for chandelier/lantern, 64 for lamp/candelabra, and 0 for water
  candle. Unknown future resource layouts are not inferred from a large PNG.
- These six families do not implement torches, other flame/glow families,
  weather, dust, dynamic illumination, or nonzero wind.
- Subpixel rasterization, screen-coordinate float accumulation and Canvas
  8-bit composition can differ from the game's GPU output. The snapshot
  preserves source recipe data and float32 jitter, not an unknown runtime
  TileFrameSeed or camera/time state recovered from the WLD.
- A successful overlay plan does not complete unrelated body/glow/entity
  paths. Publication, renderer integration and asset-manifest updates belong
  to the integrating change; this candidate does not perform them.
