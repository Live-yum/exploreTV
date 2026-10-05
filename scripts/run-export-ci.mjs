// CI-only bounded wrapper for the explicitly selected bundled example export.
import { spawn } from "node:child_process";
import { statfsSync, readdirSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = "artifacts/full-resolution";
const fs = statfsSync(".");
if (fs.bavail * fs.bsize < 8 * 1024 ** 3)
  throw new Error("At least 8 GiB free disk required before full export");
const child = spawn(
  process.execPath,
  [
    "--max-old-space-size=1536",
    "--expose-gc",
    "scripts/export-world.mjs",
    "fixtures/example-world.wld",
    "example/assets",
    root + "/world-16px.png",
    "--tiles",
    root + "/tiles",
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
  console.error("CI export budget exceeded: " + reason);
  child.kill("SIGTERM");
  killTimer = setTimeout(() => child.kill("SIGKILL"), 10000);
}
const timer = setInterval(() => {
  try {
    const bytes = directoryBytes(root);
    const status = readFileSync(`/proc/${child.pid}/status`, "utf8"),
      rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) * 1024;
    if (bytes > 6 * 1024 ** 3) stop("6 GiB output");
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
