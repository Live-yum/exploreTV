# Browser waterfall registry worker

`core/waterfall-worker-client.mjs` coordinates one dedicated module worker at
`viewer/waterfall-worker.mjs`. The client imports no world parser or waterfall
scanner and has no synchronous fallback. The worker parses the WLD once per
installed world, keeps its read-only tile accessor, and builds fresh source
registries for explicitly requested viewport rectangles.

This is an independent transport layer. Viewer lifecycle/render integration,
serve allowlists and publishing are owned by the caller; neither this module nor
its tests upload files or change remote state.

## Stable API

```js
import { createWaterfallWorkerClient } from "./waterfall-worker-client.mjs";

const client = createWaterfallWorkerClient();
const initialized = await client.initialize(worldBytes, {
  revision: worldRevision,
});

const snapshot = await client.requestSnapshot({
  revision: worldRevision,
  requestId: viewportRequestId,
  viewport: view.rect,
  outputRect: region.rect, // defaults to viewport; may include a bounded halo
  options: { quality: 1, frame: 0, colorProfile: "xna" },
});
if (snapshot.status === "ready" && stillCurrent()) {
  // Use this exact snapshot for both waterfall sprites and liquid origin checks.
  const liquidOptions = { waterfallRegistry: snapshot };
  const commands = snapshot.commandsFor(region.rect);
}

client.dispose(); // alias of terminate(); permanent for this client instance
```

`initialize` resolves `{status:"ready", revision, world, parseMs}`. The world
metadata contains dimensions, format version and worldSurface, not the file's
Tile data. It may instead resolve a discarded status if replaced or terminated.

`requestSnapshot` resolves the **snapshot itself**, not a `{snapshot}` wrapper.
A successful result contains `status:"ready"`, the caller's `revision` and
`requestId`, and the source registry metadata: `model`, `scanComplete`, `scan`,
`viewport`, `quality`, `maxWaterfalls`, `cap`, `clocks`, `origins`, `originPlans`,
`failures`, `stats`, `requiredAssets`, plus `outputRect`, `commands`, `computeMs`.
Two methods are restored after structured clone:

- `hasOrigin(x,y)` queries the exact registered-origin membership. It returns
  `undefined` for an incomplete scan, matching the source registry; absence is
  not incorrectly claimed as `false` in that case.
- `commandsFor(rect)` filters/rebases the returned output commands while
  retaining cross-origin and layer order, including overhanging sprites. The
  rectangle must be contained in the snapshot's outputRect. Request another
  output rectangle when a larger area is needed.

Superseded requests and stale world revisions resolve
`{status:"discarded", reason, revision, requestId}`. They do not masquerade as
an empty successful registry. Real failures reject `WaterfallWorkerError`, with
`code`, a readable message, and relevant phase/revision/requestId fields. The
caller should retain its last committed frame and report the failure; it must
not run the source scan synchronously as a fallback.

The constructor accepts an optional browser-compatible `workerFactory`,
`workerURL`, and `timeoutMs` (default 30,000; range 1–120,000). These also make
lifecycle behavior testable without a UI. `getState()` exposes the channel state,
world revision, generation and active/pending caller request IDs.

## Scheduling, replacement and ownership

- At most one physical snapshot computation is in flight. At most one pending
  viewport is retained, always the latest. Superseded promises resolve promptly;
  the worker's synchronous computation finishes before the latest pending request
  starts. A new request never causes a second concurrent scan.
- Requests made during initialization occupy the same single latest-pending slot.
- Every request echoes the caller's world revision and viewport request ID. An
  additional internal sequence distinguishes repeated request IDs. Results from
  earlier generations, revisions or sequences cannot replace current results.
- `initialize` creates a new worker generation and terminates the previous worker,
  even if the caller reuses a revision number. It discards old requests and frees
  the old world's bytes, index and tile-column cache with that worker. The same
  client can initialize successive worlds without a separate dispose call.
- `dispose()`/`terminate()` permanently closes the client and discards outstanding
  work. Both names are idempotent. Create a new client before working after a
  permanent disposal.
- Initialization and active physical requests have a timeout. A superseded
  computation retains its physical timeout: if it never replies, the worker is
  terminated and the latest pending promise rejects rather than remaining busy
  indefinitely. Errors/decoding failures/timeouts need a fresh initialization.
  An ordinary per-snapshot validation/computation error leaves the parsed world
  ready for another request.

Initialization copies the exact input ArrayBuffer or typed-array view into a new
owned Uint8Array, then transfers **only that copy's buffer**. Main-thread bytes
are neither detached nor modified. Subarray inputs transfer exactly their view,
not unrelated bytes in the caller's backing store. Viewport rectangles and array
options are likewise captured by value before enqueueing.

## Scope and bounds

The worker calls `openWorld` and `getWorldTileAccessor` inside its own thread.
World limits remain the parser's 64-MiB file and 24-million-tile limits. The
initial parsing/index pass necessarily reads the installed file once; requests
reuse that parsed world rather than reopening or scanning the whole map.

Viewport and output rectangles are mandatory bounded requests: positive integer
sizes, at most 512 tiles per side and 65,536 tiles total, within the world. The
source registry receives exactly `options.viewport = request.viewport`; an
options object cannot override it or fall through to the source's whole-world
default. Output filtering does not rescan Tile records.

The source's default `maxWaterfalls=1000`, quality scaling, origin eligibility,
registration order, origin failure behavior and first-seen-texture/layer order
are retained. No default 100,000-origin override is introduced. A caller can
explicitly select another supported source cap through options. Sprite output
is additionally capped at 131,072 commands. Source functions, callbacks, signals,
or arbitrary objects cannot be sent as options; use the supported serializable
clock/style/quality/cap fields.

A viewport snapshot is one consistent registry for that viewport and its output
halo. Use it for all liquid and waterfall decisions in the same scene commit.
Do not combine independently capped viewport registries into a whole-world
export; the existing export-specific shared registry has different scope.

## Tests and measured behavior

Run `node --test test/waterfall-worker.test.mjs`. Thirteen tests cover owned
transfers, sliced buffers, initialization queueing, one-inflight/latest-pending
behavior, stale generation/revision/sequence rejection, same-revision replacement,
recoverable errors, crashes, decoding errors, timeouts, termination, membership
uncertainty, sprite overhangs and ordering. A real Node worker thread uses the
same exported production handler and matches the direct source registry on a
synthetic world. Client tests use a controlled Worker-compatible transport to
exercise races deterministically.

The actual 8400×2400/v315 WLD, SHA-256
`d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab`,
was also parsed and queried in a real worker thread. Viewport x4358/y225, 84×64,
scans a 287×187 source halo: **53,669 cells**, not 20,160,000 world cells. It
registers 44 origins, returns 1,331 visible commands, and reports zero failures.
The default source cap stays 1000. Main-thread interval callbacks continue during
the scan, and the original input hash remains unchanged. Observed local compute
runs varied with host load (about 103–218 ms); initialization was separately
measured. The latest machine-readable timings and counts are in
`artifacts/waterfall-worker/actual-viewport.json`.

A separate real-browser smoke script imports the production client and launches
the production dedicated module worker through an ephemeral loopback server:

```sh
node --test scripts/test-waterfall-worker-browser.mjs
```

Run it after installing Playwright's browser, or with installed Chromium at
`/usr/bin/chromium`. It is intentionally outside `npm test`'s test-file glob and
fails visibly if browser launch/protocol execution fails. This environment's
browser attempt was blocked by local socket permissions; an escalated launch
then failed in environment mount setup. Those attempts do not count as browser
validation. Dedicated-browser confirmation remains for the capable CI/browser
environment; the worker-thread transport, production handler and lifecycle tests
have passed here.

## Integrated viewer timing

The viewer reports main index parsing, auxiliary worker parsing and each viewport
scan separately. Its first-visible-frame measurement starts with the file/example
load action and ends at the first committed canvas, including reads, worker setup
and texture handling. The Rust core microbenchmark is not this end-to-end value.
The functional browser suite records one sample for each backend as diagnostic
smoke evidence; those samples do not establish a statistically controlled speedup.
