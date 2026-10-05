# Full-detail world viewer

The H5 world viewer keeps every source coordinate navigable at the same native 16-pixel-per-Tile scale as a building detail. An 8400 × 2400 world has a logical extent of 134400 × 38400 pixels; it is never allocated as one giant image. This is a viewport renderer, not the earlier one-pixel-per-Tile overview or a prebuilt image pyramid.

## Run and explore

```sh
npm ci
npm run dev:viewer
```

Open <http://127.0.0.1:4174/>. `node scripts/serve-viewer.mjs` is the equivalent command. The local server binds only to loopback; `VIEWER_PORT` changes its port.

- **打开示例世界** opens `fixtures/example-world.wld` and `example/asset-manifest.json`, initially centered near source Tile `(4489, 489)` to show the building area. It lazily retrieves only needed entries from `example/assets/`. The map and each fetched PNG are checked against the manifest SHA-256 before use. See the resource notice in `example/assets/NOTICE.md` for the limited distribution conditions; the game artwork does not inherit the project's code license.
- Drag the view with the mouse or touch. Arrow keys pan a focused viewport. The mouse wheel zooms around the pointer; the +/− buttons zoom around the center. **100%** restores 16 screen pixels per Tile. The supported zoom range is 50%–400%.
- Enter source-world Tile **X** and **Y**, then choose **跳转**. Coordinates at every edge and corner are accessible; the camera clamps to the world bounds. Coordinate `(8399, 2399)` reaches the lower-right corner of the example.
- **导入 .wld** opens a supported modern world locally, with the same parser limits as the existing project. The viewer retains its bytes and builds its column-offset index once per import. It does not upload the selected file.
- **导入 PNG 贴图** selects local atlases. Only the currently required images are read and decoded. Names must be `Tiles_<id>.png`, `Wall_<id>.png`, or `water_<id>.png`. Use the PNG channel control to match the exporter: TConvert raw is the default; ordinary PNGs use standard straight RGBA. Local PNGs override an example atlas with the same name. Reopening a local world retains previously selected local PNG files, but clears decoded textures and does not silently use the example texture manifest for a different world.

The footer reports the source rectangle, zoom, effective pixels per Tile, and current-view coverage. Open **资源与渲染详情** to see working-region size, decoded texture bytes, fetched atlas count, unsupported IDs, missing assets, invalid crops, channel/paint failures, and renderer limits. “No known omissions in this viewport” is not a claim of perfect game fidelity or full-world rendering coverage.

## Genuine sprite crops and visible omissions

The viewer calls the existing `openWorld`, `extractRegion`, `planScene`, `prepareSceneFrames`, `renderScene`, and PNG/assets APIs. It crops actual atlas pixels, preserves raw PNG channels for the TConvert conversion path, and applies the same paint and static liquid implementations as detail rendering. No Tile palette or invented sprite is substituted.

Magenta crosses identify unsupported Tile cells; amber crosses identify unsupported liquid neighborhoods; red crosses identify missing textures, invalid crops, or unsupported channel/paint paths. They are on by default and can be hidden for inspection. Counts remain visible when the overlay is hidden. World data outside the supported static rendering paths is retained in the WLD but cannot be claimed as rendered terrain. Nonempty black areas may still correspond to unsupported or invisible content; inspect the diagnostics and overlays.

The viewer uses a static fullbright scene and deliberately has no dynamic lighting. The renderer still approximates ordinary block and wall adjacency, cross-material transitions, liquid geometry, and slopes. Trees, plants, furniture and special objects use the documented static source rules and necessary atlases. Runtime animation, background scenery, NPCs, particles, wiring overlays, and complete game framing rules are not reproduced. Supported furniture uses saved frame coordinates. The whole world can be explored, but not every game entity and visual behavior is implemented.

## Bounded work and stale navigation

The displayed canvas is at most 1920 × 1024 physical pixels, matching its CSS size independently of device pixel ratio. At 100% one atlas pixel equals one display-canvas pixel; smoothing is disabled. High-DPI devices do not multiply a giant world buffer. Two additional screen-sized surfaces hold staging and last committed pixels, allowing asynchronous replacement and an omission-overlay toggle without damaging the last completed frame.

A camera request decodes only the visible rectangle plus a clipped 12-Tile halo. The combined region is always within 65536 cells and each parser-side limit. At maximum display size and minimum zoom, it remains below that cell budget. The halo supplies framing neighbors and wall/torch overhang; offscreen commands are filtered before asset loading. The indexed WLD bytes and column offsets are retained, but a Tile-object array for all 20.16 million cells is never created.

The texture LRU retains at most 48 MiB, counting encoded PNGs, raw RGBA, and decoded platform image bytes. It evicts before decoding the next atlas, and renders ordered single-atlas batches so a working set cannot pin the entire 160-texture bundle. Each sprite-conversion batch stays below 450 frame keys and 7 MiB reserved frame pixels, below the core's 512-frame / 8-MiB cap. Frames are disposed after drawing. Temporary fetch chunks, parser records, browser decoder internals, and garbage-collection timing are outside the retained-cache metric; this is not a total browser-process memory guarantee.

Rendering requests are serialized and coalesced. A newer camera or import invalidates previous work and aborts its active network fetch. Generation checks after asynchronous operations prevent stale textures or an older frame from committing over a newer view. Failed resource loads remain explicit until local inputs or the world are reimported. Resize, repeated import, resource failure, and a changed camera do not allocate an unbounded queue of canvases.

## Server boundary

The development server exposes only the three viewer entry files, root `core/*.mjs` modules, the exact `fixtures/example-world.wld`, `example/asset-manifest.json`, and correctly named PNGs under `example/assets/`. It rejects other fixtures, private directories, artifacts, dotfiles, traversal, symlink redirects, and non-read methods. No directory listing or generic repository static root is provided. The viewer files can also be hosted with those same allowlisted paths; publication is separate from local startup.

## Shared core and uni-app

`core/viewport.mjs` has no DOM or Node dependency. It owns camera coordinates, zoom anchoring, bounded region calculation, command visibility, the LRU, and latest-request sequencing. A uni-app page can retain these APIs and the original parser/scene planner while substituting the existing `adapters/files.js` file-reading/image-loading and Canvas APIs. The new H5 entry supplies browser pointer, wheel, file, fetch, and Canvas adapters.

Running this H5 page in a WeChat webview is not a Weixin Mini Program implementation. A native Mini Program integration must wire `wx.chooseMessageFile`, filesystem/image creation, Canvas 2D, touch and lifecycle events, cancellation, and its platform download/packaging limits. The original uni-app build and fragment import paths remain separate. The large example WLD and PNG resources are not required in the Mini Program package.

## Verification

```sh
node --test test/viewport.test.mjs
npx playwright test e2e/world-viewer.spec.mjs
```

Unit checks cover real logical world extent, pointer anchored zoom, native-scale coordinate arithmetic, bounded halos and edge extraction, LRU eviction, stale async coalescing, and server file-access restrictions. Browser tests use a synthetic 8400 × 2400 RLE world and procedural gradient PNGs to assert exact atlas crop pixels, lazy loading, drag, zoom, far-coordinate jumps, explicit unsupported/missing-cell warnings, source reimport, high-DPI behavior, and resource bounds. A separate browser case loads the bundled authorized example, verifies detailed texture content and a real-world edge jump, and saves a building-area screenshot. No unrelated private fixture is needed.
