# Static cactus, coin piles, planter boxes and water plants

`core/static-plants-next.mjs` is an original, read-only geometry planner for tile
types 80, 332, 380, 518 and 656. It contains no game source, game executable or
texture payload. It is integrated into the shared renderer with the manifest containing only
the required original PNGs.

## API and integration

`planStaticPlantsNext(region, x, y, tile, options)` returns:

- `null` for another family's tile type;
- `{ commands }` for supported geometry, with at least one command;
- `{ unsupported }` describing a concrete missing dependency or malformed state.

`x` and `y` are local cell coordinates. The region uses the existing column-major
cell array and bounded `rect` contract. Reads first use the region, then its
optional `context`, then `getWorldTile(worldX, worldY)`. This accessor is necessary
for tall cactus roots outside a selection or the bounded render halo. Traversal
is capped at the smaller of the declared world height and 4,096 cells. The
planner never assigns tile fields, changes liquid, reframes neighboring records,
or serializes its reconstructed coordinates back into a fragment.

Commands match the existing furniture/misc shape: `asset`, `type`, source crop,
offsets, horizontal mirroring, opacity and fidelity. The caller supplies target
pixel coordinates and applies visibility, tile paint, texture bounds and
premultiplied compositing. Preserve command order for planter rope/body and glow
tulip body/mask. Overlay `paintId: 0` overrides the tile's paint.

Options:

- `revealInvisible`: reconnect planter/pile neighbors across echo-coating
  boundaries, matching the source's merge-culling mode.
- `mouseTextColor`: byte-range static glow pulse, default 255. This is explicitly
  a frozen approximation of runtime UI pulse, not a value inferred from WLD.

Unsupported conditions include incomplete neighbor/root access, unknown tile
metadata, invalid stored frames, shaped target bodies, active-stone solidity
when relevant, and invalid cactus roots that would require destructive game
validation. No unsupported target is hidden or reported as an empty success.

## Behavior and inspected contracts

All references below describe the inspected source revision
`8255d34616c780af12079425ac92a0a7aed87d71`. The implementation is a separate
JavaScript formulation of the draw facts; no source fragments are reproduced.

| Type             | Saved/reconstructed state                                | Static geometry                                                                                                          |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 80 Cactus        | WLD frame-important bit is false; recover trunk and arms | 16×16, y +2; frame topology from intact cactus/root cells; normal, corruption, hallow and crimson atlas row bands        |
| 332 GoldCoinPile | WLD frame-important bit is false                         | Eight-neighbor coin-metal merging with cardinal/slope/coating rules; variation zero; 16×16, y +2                         |
| 380 PlanterBox   | Saved style Y; X joins recomputed                        | 16×16; four left/right join states; rope behind only when upper and lower rope endpoints are within the source scan span |
| 518 LilyPad      | Saved style and liquid amount                            | 16×16; integer liquid-height displacement, solid ceiling cap, dry half-block and slope support cases                     |
| 656 GlowTulip    | Saved frame (0,0)                                        | 24×34, x −4/y −16; even-world-X flip; zero wind; separate unpainted Glow_329 additive layer                              |

- `WorldGen.cs`, `CheckCactus` (around 54587), `CactusFrame` (56828), and
  `GetCactusType` (48107): root descent can shift one column at an arm attachment;
  recover top, shaft, arm elbow, crown fork and isolated twig frames. A dye fruit
  above the cactus counts as continued growth. Atlas biome lookup uses the draw
  frame's trunk column and the source's twenty-cell sampling limit. Invalid roots
  are reported instead of running the source's tile-destruction side effects.
- `WorldGen.cs`, `TileFrameCosmetic` (82671–86125): coin pile normalization merges
  all four coin metals, applies neighbor slope/half-block and coating behavior,
  and selects the common cardinal/full-mask corner frames. Unsaved random
  `frameNumber` is frozen at zero and labeled approximate. No terrain randomness
  or gameplay falling-block simulation is claimed.
- `WorldGen.cs`, planter branch (86585–86653), `GetTileMergeCulling` (86127),
  `GetRopeEnds` (70561) and `IsRope` (70622): recompute only the horizontal join,
  retain saved style, and require the source's upper/lower rope endpoints. The
  upper endpoint chooses rope material and paint. Rope source Y is world
  `(x+y)%3*18`, source X is 90, with a 16×16 crop.
- `TileDrawing.cs`, `DrawBasicTile` (1531), `DrawTile_BackRope` (3798), and
  `GetTileDrawData` (4653/4683/5088/5168): rope precedes planter body; cactus and
  coin piles have the two-pixel floor offset. Lily height is based on integer
  `liquid/16 − 3`; solid ceilings cap upward displacement at eight pixels.
- `WorldGen.cs`, `SolidTile` (70652), and `Main.cs` initialization: lily ceiling
  solidity excludes solid-top, actuated and shaped tiles. Dry lily pads use the
  lower tile's half-block liquid or two upper-surface slope states. The stored
  plant position and style remain unchanged; `CheckLilyPad` gameplay movement,
  destruction, network messages and ongoing liquid simulation are not executed.
- `TileDrawing.cs`, glow selection (6164) and overlay draw (1361): tulip mask
  geometry matches the 24×34 body. Vertex color `[pulse,pulse,pulse,0]` deliberately
  retains RGB at alpha zero through the shared premultiplied/additive pipeline.
  `TileID.cs` identifies the tulip as wind-sensitive; this planner freezes wind.

## Original asset dependencies

The actual PNGs were read from the user-authorized `Live-yum/TConvert` output
directory `1.4.5.8ouput/Images`. They remain private review inputs. Content hashes
and fetched blob identities are recorded in `artifacts/plants-next-assets.json`.

| Asset         | Verified dimensions |
| ------------- | ------------------- |
| Tiles_80.png  | 126×216             |
| Tiles_332.png | 234×90              |
| Tiles_380.png | 72×144              |
| Tiles_518.png | 324×90              |
| Tiles_656.png | 26×36               |
| Glow_329.png  | 26×36               |

Planter back ropes additionally use the actual upper endpoint's `Tiles_N.png`.
None of the 280 fixture planter cells requires a rope layer; synthetic goldens
exercise that path, including mismatched upper/lower rope materials and paint.

## Verification

Run `node --test test/static-plants-next.test.mjs`. When the optional example
world exists, the test also requires the six original assets from
`example/assets` or `fixtures/private/plants-next` and checks every candidate
cell. Set `EXPLORETV_PLANTS_CROP_REPORT=1` to regenerate the private crop report.

The verified WLD is version 315, 8,400×2,400, SHA-256
`d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab`.
Its results are 238 cactus, 104 gold pile, 280 planter, 277 lily pad and 6 glow
tulip cells: 905 supported cells, 911 commands, 78 unique crops, six PNGs, zero
out-of-bounds crops, zero hidden cells and zero mutated records. All fixture
cacti resolve to crimson atlas bands. All reconstructed planter joins agree
with the saved joins, while synthetic tests cover changed joins.

Synthetic tests independently cover each cactus segment/biome, top dye fruit,
long root access and twenty-cell biome cutoff, invalid roots, all sixteen pile
cardinal masks, full-mask diagonal pairs, slope/coating behavior, all planter
joins, rope span/paint, liquid rounding, ceiling caps, dry support, mirroring and
explicit glow pulse. Private `artifacts/plants-next-verify-roi.mjs` renders five
actual-world component/context ROIs without editing the live renderer. Every
target draws nonblack pixels with valid assets. The selected glow sprite's RGB
sum rises from 175,812 at pulse 0, to 207,640 at 180, to 214,552 at 255; nonzero
pulses use one additive frame, confirming the alpha-zero layer is preserved.

These are original-asset crop and geometry proofs, not a game screenshot oracle.
Contextual QA uses the existing approximate world renderer with liquid drawing
disabled. Lighting, particles, time-dependent glow and wind are not simulated.
The private PNGs and world-derived artifacts are not public distribution files.
