import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** Explicit, offline build: headers must already be installed or supplied. */
export async function buildNativeReducer({
  include,
  compiler = process.env.CC || "cc",
} = {}) {
  if (!["linux", "darwin"].includes(process.platform))
    throw new Error(
      "Native reducer build currently supports Linux and macOS; JavaScript fallback remains available",
    );
  if (!include) {
    try {
      include = require("node-api-headers").include_dir;
    } catch {
      throw new Error(
        "Install the pinned node-api-headers development dependency, or pass --include <directory containing node_api.h>",
      );
    }
  }
  include = resolve(include);
  await readFile(resolve(include, "node_api.h"));
  const sourcePath = fileURLToPath(
    new URL("./native-reducer.c", import.meta.url),
  );
  const outputPath = fileURLToPath(
    new URL(
      `../artifacts/native/native-reducer-${process.platform}-${process.arch}.node`,
      import.meta.url,
    ),
  );
  const buildId = `${process.pid}.${randomUUID()}`;
  const temporaryPath = `${outputPath}.${buildId}.partial`;
  const temporarySource = `${outputPath}.${buildId}.c`;
  const temporaryReceipt = `${outputPath}.${buildId}.json.partial`;
  // Compile the same immutable bytes the receipt hashes, even if an editor
  // changes the repository source while the compiler is running.
  const source = await readFile(sourcePath);
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const flags = [
    "-O3",
    "-std=c11",
    "-DNAPI_VERSION=8",
    "-DNODE_GYP_MODULE_NAME=exploretv_native_reducer",
    "-fPIC",
    "-shared",
    "-Wall",
    "-Wextra",
  ];
  if (process.platform === "darwin") flags.push("-undefined", "dynamic_lookup");
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(temporarySource, source);
    const built = spawnSync(
      compiler,
      [...flags, "-I", include, temporarySource, "-o", temporaryPath],
      {
        encoding: "utf8",
        shell: false,
        maxBuffer: 1024 * 1024,
      },
    );
    if (built.error) throw built.error;
    if (built.status !== 0)
      throw new Error(
        `Native reducer compilation failed (${built.status}): ${built.stderr || built.stdout}`,
      );
    const binarySha256 = createHash("sha256")
      .update(await readFile(temporaryPath))
      .digest("hex");
    await writeFile(
      temporaryReceipt,
      JSON.stringify(
        {
          version: 2,
          platform: process.platform,
          arch: process.arch,
          sourceSha256,
          binarySha256,
          napiVersion: 8,
          compiler,
          flags,
        },
        null,
        2,
      ) + "\n",
    );
    await rename(temporaryPath, outputPath);
    await rename(temporaryReceipt, outputPath + ".json");
    return { outputPath, sourceSha256, binarySha256, napiVersion: 8 };
  } finally {
    await rm(temporaryPath, { force: true });
    await rm(temporarySource, { force: true });
    await rm(temporaryReceipt, { force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === "--include"))
      throw new Error(
        "Usage: node scripts/native-reducer-build.mjs [--include <headers-directory>]",
      );
    console.log(JSON.stringify(await buildNativeReducer({ include: args[1] })));
  } catch (error) {
    console.error(`native-reducer-build: ${error.message}`);
    process.exitCode = 1;
  }
}
