import { join } from "node:path";
import { textureSource, ASSET_LIMITS } from "../core/assets.mjs";
import {
  BLOCK_FRAME,
  WALL_GRID,
  OVERVIEW_FRAME_RECIPE_VERSION,
  overviewFrameRecipeId,
  overviewFrameRecipe,
  canonicalOverviewFrameRecipeId,
} from "../core/overview-frame-recipes.mjs";
import {
  OVERVIEW_FRAME_PACK_SCHEMA,
  OVERVIEW_FRAME_PACK_BAKE_VERSION,
  OVERVIEW_FRAME_PACK_RECORD_BYTES as RECORD_BYTES,
  OVERVIEW_FRAME_PACK_LIMITS as LIMITS,
  overviewFramePackSha256 as sha256,
  overviewFramePackRuleHashes,
  overviewFramePackBaker,
  readOverviewFramePackFile,
} from "./overview-frame-pack-format.mjs";

const validHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value, low, high) =>
  Number.isSafeInteger(value) && value >= low && value <= high;
function requireCondition(value, message) {
  if (!value) throw new Error(`Invalid overview frame pack: ${message}`);
}
const sameFields = (a, b) =>
  a &&
  typeof a === "object" &&
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(b).every(([key, value]) => a[key] === value);

function shapeOf(command) {
  if (!command.clip) return command.sh === 8 ? 1 : 0;
  const p = command.clip;
  const shapes = [
    [
      [0, 0],
      [16, 16],
      [0, 16],
    ],
    [
      [0, 16],
      [16, 0],
      [16, 16],
    ],
    [
      [0, 0],
      [16, 0],
      [0, 16],
    ],
    [
      [0, 0],
      [16, 0],
      [16, 16],
    ],
  ];
  return (
    shapes.findIndex(
      (points) =>
        Array.isArray(p) &&
        p.length === 3 &&
        p.every(
          (point, i) =>
            Array.isArray(point) &&
            point.length === 2 &&
            point[0] === points[i][0] &&
            point[1] === points[i][1],
        ),
    ) + 2
  );
}
function commandRecipeId(command) {
  if (
    !command ||
    typeof command !== "object" ||
    (command.opacity !== undefined && command.opacity !== 1) ||
    (command.paintId !== undefined &&
      command.paintId !== 0 &&
      command.paintId !== 31) ||
    (command.flipX !== undefined && command.flipX !== false) ||
    (command.flipY !== undefined && command.flipY !== false) ||
    command.vertexColor != null ||
    command.vertexColors != null
  )
    return null;
  const wall = command.kind === "wall";
  if (!wall && command.kind !== "tile") return null;
  const shape = wall ? 0 : shapeOf(command);
  if (command.clip && (wall || shape < 2)) return null;
  if (command.shape !== undefined && command.shape !== shape) return null;
  const grid = wall ? WALL_GRID : BLOCK_FRAME;
  const variant = grid.findIndex(
    ([x, y]) =>
      command.sx === x * (wall ? 36 : 1) && command.sy === y * (wall ? 36 : 1),
  );
  if (variant < 0) return null;
  try {
    const id = overviewFrameRecipeId(
      command.kind,
      command.type,
      variant,
      shape,
      command.paintId ?? 0,
    );
    const recipe = overviewFrameRecipe(id);
    if (
      ["asset", "sx", "sy", "sw", "sh", "dw", "dh"].some(
        (key) => command[key] !== recipe[key],
      )
    )
      return null;
    return id;
  } catch {
    return null;
  }
}

/** No pixel page cache: the direct renderer owns every returned page and its budget. */
export function openOverviewFramePack({
  packDir,
  inputEncoding = "tconvert-game-raw",
} = {}) {
  requireCondition(
    typeof packDir === "string" && packDir.length > 0,
    "directory",
  );
  requireCondition(inputEncoding === "tconvert-game-raw", "input encoding");
  const manifestBytes = readOverviewFramePackFile(
    join(packDir, "manifest.json"),
    LIMITS.manifestBytes,
  );
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  requireCondition(
    manifest.schema === OVERVIEW_FRAME_PACK_SCHEMA &&
      manifest.bakeVersion === OVERVIEW_FRAME_PACK_BAKE_VERSION &&
      manifest.recipeVersion === OVERVIEW_FRAME_RECIPE_VERSION &&
      manifest.inputEncoding === inputEncoding &&
      manifest.opaqueScene === true,
    "format/rules/channel contract",
  );
  requireCondition(
    sameFields(manifest.ruleHashes, overviewFramePackRuleHashes()),
    "preparer source hashes",
  );
  requireCondition(
    sameFields(manifest.baker, overviewFramePackBaker()),
    "pixel baker identity",
  );
  requireCondition(
    integer(manifest.frames, 1, LIMITS.frames) &&
      integer(manifest.uniqueFrames, 1, manifest.frames),
    "frame count",
  );
  requireCondition(
    integer(manifest.pageBytes, 8192, LIMITS.pageBytes) &&
      manifest.pageBytes % 4096 === 0,
    "page size",
  );
  requireCondition(
    Array.isArray(manifest.sources) &&
      integer(manifest.sources.length, 1, LIMITS.sources),
    "source count",
  );
  requireCondition(
    Array.isArray(manifest.pages) &&
      integer(manifest.pages.length, 1, LIMITS.pages),
    "page count",
  );
  requireCondition(
    manifest.index?.file === "index.bin" &&
      manifest.index.recordBytes === RECORD_BYTES &&
      manifest.index.bytes === manifest.frames * RECORD_BYTES &&
      validHash(manifest.index.sha256),
    "index contract",
  );
  const sourceByName = new Map();
  for (const [sourceIndex, source] of manifest.sources.entries()) {
    requireCondition(
      /^(Tiles|Wall)_(0|[1-9][0-9]*)\.png$/.test(source.name) &&
        !sourceByName.has(source.name) &&
        validHash(source.sha256) &&
        integer(source.bytes, 24, ASSET_LIMITS.encodedBytes) &&
        integer(source.width, 1, 4096) &&
        integer(source.height, 1, 4096) &&
        source.width * source.height * 4 <= ASSET_LIMITS.decodedBytes,
      "source identity/dimensions",
    );
    sourceByName.set(source.name, Object.freeze({ ...source, sourceIndex }));
  }
  let pixelBytes = 0;
  for (const [i, page] of manifest.pages.entries()) {
    requireCondition(
      page.file === `page-${String(i).padStart(5, "0")}.bin` &&
        integer(page.bytes, 1, manifest.pageBytes) &&
        page.bytes % 4 === 0 &&
        validHash(page.sha256),
      "page identity",
    );
    pixelBytes += page.bytes;
    Object.freeze(page);
  }
  requireCondition(
    pixelBytes === manifest.pixelBytes && pixelBytes <= LIMITS.pixelBytes,
    "pixel byte count",
  );
  const index = readOverviewFramePackFile(
    join(packDir, "index.bin"),
    LIMITS.frames * RECORD_BYTES,
    manifest.index.bytes,
  );
  requireCondition(sha256(index) === manifest.index.sha256, "index hash");
  const view = new DataView(index.buffer),
    sourceCounts = new Uint32Array(manifest.sources.length);
  let previous = -1,
    logicalPixelBytes = 0;
  for (let p = 0; p < index.byteLength; p += RECORD_BYTES) {
    const id = view.getUint32(p, true),
      sourceIndex = view.getUint16(p + 4, true),
      pageId = view.getUint16(p + 6, true);
    const base = view.getUint32(p + 8, true),
      additive = view.getUint32(p + 12, true),
      width = view.getUint16(p + 16, true),
      height = view.getUint16(p + 18, true);
    const flags = view.getUint32(p + 20, true),
      mean = view.getUint32(p + 24, true),
      reserved = view.getUint32(p + 28, true);
    requireCondition(
      id > previous &&
        sourceIndex < manifest.sources.length &&
        pageId < manifest.pages.length,
      "index ordering/references",
    );
    const recipe = overviewFrameRecipe(id),
      source = manifest.sources[sourceIndex],
      page = manifest.pages[pageId],
      planeBytes = width * height * 4;
    requireCondition(
      canonicalOverviewFrameRecipeId(id) === id &&
        recipe.asset === source.name &&
        width === recipe.sw &&
        height === recipe.sh &&
        recipe.sx + width <= source.width &&
        recipe.sy + height <= source.height,
      "recipe/source crop",
    );
    const shape = recipe.clip ? shapeOf(recipe) : 0;
    requireCondition(
      (flags & ~0x703) === 0 &&
        flags >> 8 === shape &&
        !!(flags & 1) === !!recipe.clip &&
        reserved === 0,
      "frame flags",
    );
    requireCondition(
      base % 4 === 0 &&
        base + planeBytes <= page.bytes &&
        (additive === 0xffffffff ||
          (additive % 4 === 0 &&
            additive === base + planeBytes &&
            additive + planeBytes <= page.bytes)),
      "plane bounds",
    );
    requireCondition(
      flags & 2
        ? !recipe.clip &&
            width === 16 &&
            height === 16 &&
            mean >>> 24 === 255 &&
            additive === 0xffffffff
        : mean === 0,
      "opaque mean",
    );
    logicalPixelBytes += planeBytes * (additive === 0xffffffff ? 1 : 2);
    sourceCounts[sourceIndex]++;
    previous = id;
  }
  requireCondition(
    sourceCounts.every((count) => count > 0),
    "source without validated frame recipes",
  );
  requireCondition(
    manifest.logicalPixelBytes === logicalPixelBytes,
    "logical pixel byte count",
  );
  const ownedDescriptors = new WeakSet(),
    verifiedPages = new WeakMap();
  // The strictly ordered binary index is already the complete ID lookup.
  // Cache metadata by bounded row number instead of retaining two Map entries
  // per recipe; pixel ownership remains exclusively with the direct renderer.
  let descriptors = new Array(manifest.frames),
    bindings = new WeakMap(),
    disposed = false;
  const stats = {
    available: true,
    manifestSha256: sha256(manifestBytes),
    indexSha256: manifest.index.sha256,
    pagesSha256: Object.freeze(manifest.pages.map((p) => p.sha256)),
    ruleHashes: Object.freeze({ ...manifest.ruleHashes }),
    sourceHashes: Object.freeze(
      Object.fromEntries(manifest.sources.map((s) => [s.name, s.sha256])),
    ),
    frames: manifest.frames,
    uniqueFrames: manifest.uniqueFrames,
    logicalPixelBytes,
    pageCount: manifest.pages.length,
    pixelBytes,
    onDiskBytes: pixelBytes + index.byteLength + manifestBytes.byteLength,
    indexBytes: index.buffer.byteLength,
    manifestBytes: manifestBytes.byteLength,
    sourceVerifications: 0,
    validationFailures: 0,
    pageReads: 0,
    pageBytesRead: 0,
    lookups: 0,
    lookupHits: 0,
  };
  const assertActive = () => {
    if (disposed) throw new Error("Overview frame pack is disposed");
  };
  const sourceInfo = (name, hash, encodedBytes) => {
    assertActive();
    const info = sourceByName.get(name);
    if (!info) return null;
    if (info.sha256 !== hash || info.bytes !== encodedBytes) {
      stats.validationFailures++;
      return null;
    }
    return info;
  };
  return {
    stats,
    sourceInfo,
    bindVerifiedSource(source, name, hash, encodedBytes) {
      const info = sourceInfo(name, hash, encodedBytes);
      if (
        !info ||
        (source?.naturalWidth ?? source?.width) !== info.width ||
        (source?.naturalHeight ?? source?.height) !== info.height ||
        !textureSource(source)
      )
        return false;
      bindings.set(source, { info, registration: textureSource(source) });
      stats.sourceVerifications++;
      return true;
    },
    lookup(source, recipeOrCommand, command = null) {
      assertActive();
      stats.lookups++;
      const binding = bindings.get(source);
      if (
        !binding ||
        binding.registration !== textureSource(source) ||
        (source.naturalWidth ?? source.width) !== binding.info.width ||
        (source.naturalHeight ?? source.height) !== binding.info.height
      )
        return null;
      let id;
      try {
        if (typeof recipeOrCommand === "number") {
          id = canonicalOverviewFrameRecipeId(recipeOrCommand);
          if (
            command &&
            canonicalOverviewFrameRecipeId(commandRecipeId(command)) !== id
          )
            return null;
        } else
          id = canonicalOverviewFrameRecipeId(commandRecipeId(recipeOrCommand));
      } catch {
        return null;
      }
      let low = 0,
        high = manifest.frames;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (view.getUint32(middle * RECORD_BYTES, true) < id) low = middle + 1;
        else high = middle;
      }
      if (low === manifest.frames) return null;
      const p = low * RECORD_BYTES;
      if (
        view.getUint32(p, true) !== id ||
        view.getUint16(p + 4, true) !== binding.info.sourceIndex
      )
        return null;
      let descriptor = descriptors[low];
      if (!descriptor) {
        const pageId = view.getUint16(p + 6, true),
          flags = view.getUint32(p + 20, true);
        descriptor = Object.freeze({
          recipeId: id,
          pageId,
          pageBytes: manifest.pages[pageId].bytes,
          baseOffset: view.getUint32(p + 8, true),
          additiveOffset: view.getUint32(p + 12, true),
          width: view.getUint16(p + 16, true),
          height: view.getUint16(p + 18, true),
          mean: flags & 2 ? new Uint8Array(index.buffer, p + 24, 4) : null,
          clipShape: flags >> 8,
          uvFlipApplied: !!(flags & 1),
        });
        descriptors[low] = descriptor;
        ownedDescriptors.add(descriptor);
      }
      stats.lookupHits++;
      return descriptor;
    },
    readPage(descriptor) {
      assertActive();
      requireCondition(
        ownedDescriptors.has(descriptor),
        "foreign page descriptor",
      );
      const page = manifest.pages[descriptor.pageId];
      try {
        const bytes = readOverviewFramePackFile(
          join(packDir, page.file),
          manifest.pageBytes,
          page.bytes,
        );
        stats.pageBytesRead += bytes.byteLength;
        requireCondition(sha256(bytes) === page.sha256, "page hash");
        verifiedPages.set(bytes, descriptor.pageId);
        stats.pageReads++;
        return bytes;
      } catch (error) {
        stats.validationFailures++;
        throw error;
      }
    },
    frame(descriptor, bytes) {
      assertActive();
      requireCondition(
        ownedDescriptors.has(descriptor) &&
          verifiedPages.get(bytes) === descriptor.pageId &&
          bytes.byteOffset === 0 &&
          bytes.byteLength === descriptor.pageBytes &&
          bytes.buffer.byteLength === descriptor.pageBytes,
        "unverified page backing",
      );
      const size = descriptor.width * descriptor.height * 4;
      return {
        base: new Uint8Array(bytes.buffer, descriptor.baseOffset, size),
        additive:
          descriptor.additiveOffset === 0xffffffff
            ? null
            : new Uint8Array(bytes.buffer, descriptor.additiveOffset, size),
        width: descriptor.width,
        height: descriptor.height,
        mean: descriptor.mean,
        uvFlipApplied: descriptor.uvFlipApplied,
        clipShape: descriptor.clipShape || undefined,
        opacityByte: descriptor.clipShape ? 255 : undefined,
        bytes: size * (descriptor.additiveOffset === 0xffffffff ? 1 : 2),
      };
    },
    dispose() {
      disposed = true;
      bindings = new WeakMap();
      descriptors = [];
    },
  };
}
