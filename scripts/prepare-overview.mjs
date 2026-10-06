import { buildNativeReducer } from "./native-reducer-build.mjs";
import { buildNativeBlitter } from "./native-blitter.mjs";

// Preparation is explicit and independent of world inputs. It can be completed
// once at installation/deployment, before any user's world is opened.
try {
  if (process.argv.length > 2)
    throw new Error("Usage: npm run prepare:overview");
  const reducer = await buildNativeReducer();
  const blitter = await buildNativeBlitter();
  console.log(JSON.stringify({ phase: "prepared", reducer, blitter }, null, 2));
} catch (error) {
  console.error(`prepare-overview: ${error.message}`);
  process.exitCode = 1;
}
