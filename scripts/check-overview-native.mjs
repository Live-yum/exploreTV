import assert from "node:assert/strict";
import { nativeBlitterStatus } from "./native-blitter.mjs";
import { nativeReducerStatus } from "./native-reducer.mjs";

// CI must exercise the prepared implementation. Runtime exports can still use
// the documented Canvas/JavaScript fallback on unsupported installations.
assert.ok(
  nativeBlitterStatus.available,
  `Native compositor unavailable: ${nativeBlitterStatus.reason}`,
);
assert.ok(
  nativeReducerStatus.available,
  `Native reducer unavailable: ${nativeReducerStatus.reason}`,
);
console.log(
  JSON.stringify({
    compositor: nativeBlitterStatus,
    reducer: nativeReducerStatus,
  }),
);
