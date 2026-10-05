// Bounded rebuild of only the explicitly selected bundled direct overview.
import { spawn } from "node:child_process";
import { statfsSync, readdirSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = "artifacts/direct-overview";
const fs = statfsSync(".");
if (fs.bavail * fs.bsize < 512 * 1024 ** 2)
  throw new Error("At least 512 MiB free disk required for overview export");
const child = spawn(
  process.execPath,
  [
    "--max-old-space-size=1536",
    "--expose-gc",
    "scripts/export-overview.mjs",
    "fixtures/example-world.wld",
    "example/assets",
    root + "/world-1px.png",
    "--expect-world-sha256",
    "d551a6b360c7af49a07dadbb1e82223ac43ad398e2054c29f500ec5e8b5b1cab",
  ],
  { stdio: "inherit" },
);
const started = Date.now();
let stopped = false,
  killTimer;
function directoryBytes(path) {
  let total = 0;
  try {
    for (const name of readdirSync(path)) {
      const p = join(path, name),
        s = lstatSync(p);
      if (s.isDirectory()) total += directoryBytes(p);
      else if (s.isFile()) total += s.size;
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return total;
}
function stop(reason) {
  if (stopped) return;
  stopped = true;
  console.error("CI overview budget exceeded: " + reason);
  child.kill("SIGTERM");
  killTimer = setTimeout(() => child.kill("SIGKILL"), 10000);
}
const timer = setInterval(() => {
  try {
    const rss =
      Number(
        readFileSync(`/proc/${child.pid}/status`, "utf8").match(
          /^VmRSS:\s+(\d+)/m,
        )?.[1] || 0,
      ) * 1024;
    if (directoryBytes(root) > 128 * 1024 ** 2) stop("128 MiB output");
    if (rss > 2 * 1024 ** 3) stop("2 GiB RSS");
    if (Date.now() - started > 45 * 60 * 1000) stop("45 minute runtime");
  } catch (e) {
    if (e.code !== "ENOENT") stop("resource monitor failed");
  }
}, 10000);
child.once("error", (e) => {
  clearInterval(timer);
  console.error(e.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  clearInterval(timer);
  clearTimeout(killTimer);
  process.exitCode = stopped ? 1 : (code ?? 1);
});
process.once("SIGTERM", () => stop("workflow cancellation"));
