import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const isCli =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
// The image-only CLI never draws text; avoid scanning and retaining system fonts.
// Programmatic consumers keep their process-wide font policy unchanged.
if (isCli) process.env.DISABLE_SYSTEM_FONTS_LOAD ??= "1";
const { parseExportCli, exportWorld } = await import("./export-world.mjs");

const USAGE = `Usage: npm run export:overview -- <world.wld> <png-directory> <output.png> [options]

Directly export a small full-extent panorama from the world and real textures.
Each bounded region is composited at 16 px/tile, area-reduced immediately, and
streamed to the final PNG. No giant full-resolution PNG or tile files are made.
  --pixels-per-tile <1|2|4|8>    Output scale; default 1 (8400x2400 for a large world)
  --band-tiles <1..128>         Bounded render stripe height; default 48
  --chunk-tiles <1..252>        Bounded render width; default 120
  --region <x,y,width,height>   Optional world-tile crop; default entire world
  --expect-world-sha256 <hash>  Refuse a different input world
  --input-encoding <encoding>  tconvert-game-raw (default) or standard-straight
  --compression-level <0..9>   PNG zlib level; default 6
  --help                       Print help without accessing inputs

Uses the full-detail compositor, including halo, alpha, paint, liquids and
static waterfalls. All source pixels contribute; no map-palette substitution.
Existing output files are refused. Full-detail export remains export-world.mjs.`;

export function parseOverviewCli(argv) {
  if (argv.includes("--help")) return { help: true };
  let pixelsPerTile = 1;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tiles")
      throw new Error(
        "Direct overview does not emit full-resolution tile files",
      );
    if (argv[i] === "--pixels-per-tile") {
      const value = argv[++i];
      if (!/^(1|2|4|8)$/.test(value ?? ""))
        throw new Error("--pixels-per-tile must be 1, 2, 4 or 8");
      pixelsPerTile = Number(value);
    } else rest.push(argv[i]);
  }
  const config = parseExportCli(rest, { pixelsPerTile });
  if (!rest.includes("--band-tiles")) config.bandTiles = 48;
  if (!rest.includes("--chunk-tiles")) config.chunkTiles = 120;
  return { ...config, pixelsPerTile };
}

export async function exportOverview(config, options) {
  if (![1, 2, 4, 8].includes(config.pixelsPerTile ?? 1))
    throw new Error("Overview pixelsPerTile must be 1, 2, 4 or 8");
  return exportWorld(
    { ...config, pixelsPerTile: config.pixelsPerTile ?? 1 },
    options,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error("Export cancelled by signal"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const config = parseOverviewCli(process.argv.slice(2));
    if (config.help) console.log(USAGE);
    else {
      const result = await exportOverview(config, {
        signal: controller.signal,
        onProgress: (progress) => console.log(JSON.stringify(progress)),
      });
      console.log(
        JSON.stringify({
          phase: "done",
          png: result.png,
          report: `${config.outputPath}.json`,
          runtimeSeconds: result.runtimeSeconds,
        }),
      );
    }
  } catch (error) {
    console.error(`export-overview: ${error.message}`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
