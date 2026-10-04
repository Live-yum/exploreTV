# Integration boundary

The isolated app uses Vue 3 + uni-app 3.0.0-alpha-5010220260604001, the same framework family and pinned compiler inspected in the requested viewer-app reference. It does not copy that application's components, private WASM, or source. H5 and Weixin builds are separate artifacts; a successful Weixin build is not a physical-device test.

- `core/`: platform-neutral byte reader, fragment codec, render planner. No Node, DOM, TextEncoder or TextDecoder runtime dependency.
- `adapters/files.js`: H5 File/Blob and Weixin chooseMessageFile/filesystem implementations. The `.js` extension is intentional: uni conditional preprocessing is not applied identically to `.mjs`.
- `features/scene-explorer/index.vue`: original standalone feature page and Canvas2D rendering.
- Future integration should inject the host's read-only world source/session, resource cache, canvas lifecycle, and memory accounting. Do not replace the existing world editing session or generate map-color textures.

## Resource bounds

World input <=64 MiB, dimensions <=10,000 by5,000 and <=24M cells. Index is4\*(width+1) bytes, not an object per cell. Parsing scans the tile section; current UI scan is synchronous and should move to the host's worker/stream service before shipping on low-end phones. Preview <=65,536 cells, each side<=512, output fit720x480. PNG preflight <=8MiB compressed and <=16MiB decoded per image, cache<=48MiB. Fragment JSON<=16MiB. Limits are prototype budgets, not measured mobile-device guarantees.

## Data guarantee and explicit exclusions

Canonical serialized Tile records retain all four header bytes (except normalized RLE bits), type, frame coordinates, walls, liquid, paint, wire flags, slope/halfblock, actuator/inactive, invisibility/fullbright and reserved bits. Selection is half-open and column-major. Original source signature/version, origin and source dimensions are retained. A dictionary reduces repetition. Reload reconstructs all raw per-cell bytes and derived fields, with strict bounds and CRC32 corruption detection. CRC32 is not authentication.

`restoreIntoRegion` restores into an independent in-memory Tile grid for equality checks. It is not a whole-world save writer or validated game import. The original `.wld` is never overwritten.

Selections truncate at their literal rectangle, including multi-cell furniture. Expand the rectangle to include complete objects. Chest inventories, sign text, tile-entity data, NPCs and other non-Tile sections are excluded. Their presence is not currently parsed; the UI states this unconditionally. Do not describe this as a complete building/world restoration.

Modern relogic and xindong signatures are supported for versions269–326. xindong recognition was checked against the requested TerraX format implementation and the exact supplied v315 fixture; offsets and entire tile-section endpoint were validated. Unknown signatures and versions fail closed. This is not support for modded worlds.

## Interaction contract

The canvas supports cell-aligned rectangle drag selection (H5 mouse and a Weixin touch adapter), visual zoom, and world-viewport panning. A pending selection disables export until regenerated. H5 browser tests exercise drag, zoom, save, reload, recrop, invalid input and missing/failed textures. Weixin is compiler- and static-boundary-verified only; touch correctness/performance on a physical Weixin device is not yet established. Imported fragments clear any open-world association and crop from their own bytes, preventing accidental extraction from a different world.

H5 uses the supported `hidpi=false` canvas property: uni-app otherwise wraps Canvas2D drawing and resizes the backing store automatically, which conflicts with this explicit bounded-preview scale. CSS pointer coordinates are normalized with the runtime `windowTop`, not a hard-coded navigation height. DPR 1 and 2 browser tests verify origin, backing size, visible sprite sample pixels and every exported cell. The Weixin touch/query path does not apply the H5 offset.
