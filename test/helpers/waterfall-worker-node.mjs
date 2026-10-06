import { parentPort } from "node:worker_threads";
import { createWaterfallWorkerHandler } from "../../viewer/waterfall-worker.mjs";
const handle = createWaterfallWorkerHandler((message) =>
  parentPort.postMessage(message),
);
parentPort.on("message", handle);
