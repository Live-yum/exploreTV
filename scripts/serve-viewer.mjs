import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".wld": "application/octet-stream",
  ".wasm": "application/wasm",
};
/** Never expose the checkout root, private fixtures, artifacts, or dotfiles. */
export function allowedViewerPath(pathname) {
  if (
    pathname === "/" ||
    pathname === "/viewer/" ||
    pathname === "/viewer/index.html"
  )
    return "viewer/index.html";
  if (/^\/viewer\/(?:viewer\.mjs|style\.css)$/.test(pathname))
    return pathname.slice(1);
  if (/^\/core\/[a-z][a-z0-9-]*\.mjs$/.test(pathname)) return pathname.slice(1);
  if (
    pathname === "/wasm-core/dist/exploretv_wld_core.wasm" ||
    pathname === "/fixtures/example-world.wld" ||
    pathname === "/example/asset-manifest.json"
  )
    return pathname.slice(1);
  if (
    /^\/example\/assets\/(?:(?:Tiles_|Wall_|water_|Tree_Tops_|Tree_Branches_|Glow_|Liquid_|Flame_|LiquidSlope_|Extra_)\d+|SunAltar|SunOrb)\.png$/.test(
      pathname,
    )
  )
    return pathname.slice(1);
  return null;
}
export function createViewerServer(root = repository) {
  const base = resolve(root);
  return createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end();
        return;
      }
      const rawPath = (request.url || "").split("?")[0];
      const pathname = decodeURIComponent(rawPath);
      const relative = allowedViewerPath(pathname);
      if (!relative) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      const filename = resolve(base, relative),
        actual = await realpath(filename);
      // A symlink may not turn an allowed URL into access to another checkout file.
      if (actual !== filename || !actual.startsWith(base + sep)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      const bytes = await readFile(actual);
      response.writeHead(200, {
        "Content-Type": types[extname(actual)] || "application/octet-stream",
        "Content-Length": bytes.length,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const port = Number(process.env.VIEWER_PORT || 4174);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid VIEWER_PORT");
  createViewerServer().listen(port, "127.0.0.1", () =>
    process.stdout.write(`World viewer: http://127.0.0.1:${port}/\n`),
  );
}
