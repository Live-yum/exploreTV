import { createStaticWaterfallRegistry } from "../core/static-waterfalls.mjs";

/** Exact, read-only, low-heap storage for a complete static waterfall scene. */
const BUCKET_SIZE = 64;
const bucketKey = (x, y) => `${x},${y}`;

function signature(value) {
  if (typeof value === "number") return "#";
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (Array.isArray(value)) return `[${value.map(signature).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.keys(value)
      .map((key) => `${JSON.stringify(key)}:${signature(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function freezeTree(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function finishColumn(column, count, order) {
  if (column.constant) {
    column.data = null;
    return;
  }
  const { min, max } = column;
  const Type = !column.integer
    ? Float64Array
    : min >= 0 && max <= 255
      ? Uint8Array
      : min >= -128 && max <= 127
        ? Int8Array
        : min >= 0 && max <= 65535
          ? Uint16Array
          : min >= -32768 && max <= 32767
            ? Int16Array
            : min >= -2147483648 && max <= 2147483647
              ? Int32Array
              : min >= 0 && max <= 4294967295
                ? Uint32Array
                : Float64Array;
  const data = new Type(count);
  if (order) {
    for (let i = 0; i < count; i++) data[i] = column.data[order[i]];
  } else data.set(column.data.subarray(0, count));
  column.data = data;
}

function columnValue(column, index) {
  return column.constant ? column.first : column.data[index];
}

function restore(spec, columns, index) {
  if (spec.type === "number") return columnValue(columns[spec.column], index);
  if (spec.type === "constant") return spec.value;
  if (spec.type === "array")
    return spec.entries.map((entry) => restore(entry, columns, index));
  const value = {};
  for (const [key, entry] of spec.entries)
    value[key] = restore(entry, columns, index);
  return value;
}

// This separate factory intentionally cannot close over the source registry,
// source commands, or the temporary compilation maps/Float64 buffers.
function makeRegistry(
  metadata,
  columns,
  templates,
  rowTemplates,
  buckets,
  fieldColumns,
) {
  const { width, height } = metadata.viewport;
  const members = new Set(metadata.origins.map(({ x, y }) => bucketKey(x, y)));
  const dxColumn = columns[fieldColumns.get('["dx"]')];
  const dyColumn = columns[fieldColumns.get('["dy"]')];
  const dwColumn = columns[fieldColumns.get('["dw"]')];
  const dhColumn = columns[fieldColumns.get('["dh"]')];
  const registry = {
    ...metadata,
    hasOrigin(x, y) {
      return metadata.scanComplete ? members.has(bucketKey(x, y)) : undefined;
    },
    commandsFor(rect) {
      if (
        !rect ||
        ![rect.x, rect.y, rect.width, rect.height].every(
          Number.isSafeInteger,
        ) ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.x + rect.width > width ||
        rect.y + rect.height > height
      )
        throw new RangeError("Invalid waterfall output rectangle");
      const selected = new Set();
      for (
        let bx = Math.floor(rect.x / BUCKET_SIZE);
        bx <= Math.floor((rect.x + rect.width - 1) / BUCKET_SIZE);
        bx++
      )
        for (
          let by = Math.floor(rect.y / BUCKET_SIZE);
          by <= Math.floor((rect.y + rect.height - 1) / BUCKET_SIZE);
          by++
        )
          for (const index of buckets.get(bucketKey(bx, by)) ?? [])
            selected.add(index);
      const left = rect.x * 16,
        top = rect.y * 16;
      const right = (rect.x + rect.width) * 16,
        bottom = (rect.y + rect.height) * 16;
      const output = [];
      for (const index of [...selected].sort((a, b) => a - b)) {
        const dx = columnValue(dxColumn, index),
          dy = columnValue(dyColumn, index);
        if (
          dx >= right ||
          dy >= bottom ||
          dx + columnValue(dwColumn, index) <= left ||
          dy + columnValue(dhColumn, index) <= top
        )
          continue;
        const command = restore(templates[rowTemplates[index]], columns, index);
        command.dx = dx - left;
        command.dy = dy - top;
        command.x = command.worldX - rect.x;
        command.y = command.worldY - rect.y;
        output.push(command);
      }
      return output;
    },
  };
  Object.defineProperties(registry, {
    compactStorageBytes: {
      value:
        rowTemplates.byteLength +
        columns.reduce((sum, col) => sum + (col.data?.byteLength ?? 0), 0) +
        [...buckets.values()].reduce(
          (sum, bucket) => sum + bucket.byteLength,
          0,
        ),
    },
    compactTemplateCount: { value: templates.length },
  });
  return Object.freeze(registry);
}

/**
 * Snapshot an already validated createStaticWaterfallRegistry whole-world
 * registry. Numeric leaves (including nested colors/domains) use exact typed
 * columns; templates retain field presence and every nonnumeric value. The
 * original registry is never kept alive by the returned object. Output sprites
 * follow the source's dx/dy/x/y translation; other fields, including a possible
 * vertexDomain, retain exactly the values supplied by the source query.
 */
export function compactWaterfallRegistry(registry) {
  validateViewport(registry);
  if (typeof registry.commandsFor !== "function")
    throw new TypeError("Waterfall registry must provide commandsFor");
  const store = createCompactCommandStore();
  const commands = registry.commandsFor(registry.viewport);
  for (let index = 0; index < commands.length; index++) {
    store.append(commands[index]);
    commands[index] = null;
  }
  return store.finish(registry);
}

function validateViewport(registry) {
  if (
    !registry ||
    !registry.viewport ||
    registry.viewport.x !== 0 ||
    registry.viewport.y !== 0
  )
    throw new TypeError(
      "Compaction requires a complete whole-world waterfall registry",
    );
}

/**
 * Plan directly into bounded numeric columns. Only one origin's provisional
 * commands exist at a time; no complete object registry or full-world query is
 * created. Stable batch ordering is applied to numeric rows at finalization.
 */
export function createCompactStaticWaterfallRegistry(world, options = {}) {
  const viewport = options.viewport ?? {
    x: 0,
    y: 0,
    width: world?.width,
    height: world?.height,
  };
  validateViewport({ viewport });
  if (viewport.width !== world?.width || viewport.height !== world?.height)
    throw new TypeError("Compaction requires the complete world dimensions");
  return createStaticWaterfallRegistry(world, {
    ...options,
    commandStore: createCompactCommandStore({ sortBatches: true }),
  });
}

function createCompactCommandStore({ sortBatches = false } = {}) {
  let capacity = 1024,
    count = 0,
    finished = false,
    rowTemplates = new Uint32Array(capacity);
  const columns = [],
    fieldColumns = new Map(),
    templates = [],
    templateIds = new Map(),
    templateLeaves = [];
  const compile = (value, path, leaves) => {
    if (typeof value === "number") {
      const key = JSON.stringify(path);
      let column = fieldColumns.get(key);
      if (column === undefined) {
        column = columns.length;
        fieldColumns.set(key, column);
        columns.push({
          data: null,
          first: undefined,
          seen: false,
          constant: true,
          integer: true,
          min: Infinity,
          max: -Infinity,
        });
      }
      leaves.push({ path, column });
      return { type: "number", column };
    }
    if (Array.isArray(value))
      return {
        type: "array",
        entries: value.map((child, key) =>
          compile(child, [...path, key], leaves),
        ),
      };
    if (value && typeof value === "object")
      return {
        type: "object",
        entries: Object.keys(value).map((key) => [
          key,
          compile(value[key], [...path, key], leaves),
        ]),
      };
    return { type: "constant", value };
  };
  const append = (source) => {
    if (finished)
      throw new Error("Waterfall command store is already finished");
    if (count === capacity) {
      capacity *= 2;
      const rows = new Uint32Array(capacity);
      rows.set(rowTemplates);
      rowTemplates = rows;
      for (const column of columns) {
        if (!column.data) continue;
        const data = new Float64Array(capacity);
        data.set(column.data);
        column.data = data;
      }
    }
    // Public queries append these two derived fields. Never mutate their result
    // or the underlying source command while dropping them from stored rows.
    let command = source;
    if (Object.hasOwn(source, "x") || Object.hasOwn(source, "y")) {
      command = { ...source };
      delete command.x;
      delete command.y;
    }
    const key = signature(command);
    let template = templateIds.get(key);
    if (template === undefined) {
      template = templates.length;
      templateIds.set(key, template);
      const leaves = [];
      templates.push(compile(command, [], leaves));
      templateLeaves.push(leaves);
    }
    rowTemplates[count] = template;
    for (const leaf of templateLeaves[template]) {
      let value = command;
      for (const part of leaf.path) value = value[part];
      const column = columns[leaf.column];
      if (!column.seen) {
        column.first = value;
        column.seen = true;
      } else if (column.constant && !Object.is(value, column.first)) {
        column.constant = false;
        column.data = new Float64Array(capacity);
        column.data.fill(column.first, 0, count);
      }
      if (column.data) column.data[count] = value;
      if (!Number.isInteger(value) || Object.is(value, -0))
        column.integer = false;
      column.min = Math.min(column.min, value);
      column.max = Math.max(column.max, value);
    }
    count++;
  };
  const finish = (registry) => {
    if (finished)
      throw new Error("Waterfall command store is already finished");
    finished = true;
    validateViewport(registry);
    const metadata = {};
    for (const [key, value] of Object.entries(registry))
      if (typeof value !== "function") metadata[key] = structuredClone(value);
    freezeTree(metadata);
    let order = null;
    if (sortBatches && count) {
      const layer = columns[fieldColumns.get('["batchLayerStack"]')],
        texture = columns[fieldColumns.get('["batchTextureOrder"]')];
      order = Uint32Array.from({ length: count }, (_, i) => i);
      order.sort(
        (a, b) =>
          columnValue(layer, a) - columnValue(layer, b) ||
          columnValue(texture, a) - columnValue(texture, b) ||
          a - b,
      );
    }
    for (const column of columns) finishColumn(column, count, order);
    const RowType =
      templates.length <= 256
        ? Uint8Array
        : templates.length <= 65536
          ? Uint16Array
          : Uint32Array;
    const rows = new RowType(count);
    if (order) {
      for (let i = 0; i < count; i++) rows[i] = rowTemplates[order[i]];
    } else rows.set(rowTemplates.subarray(0, count));
    rowTemplates = rows;
    const buckets = new Map();
    if (count) {
      for (const key of ["dx", "dy", "dw", "dh"])
        if (!fieldColumns.has(JSON.stringify([key])))
          throw new TypeError(`Waterfall command has no numeric ${key}`);
      const dxColumn = columns[fieldColumns.get('["dx"]')],
        dyColumn = columns[fieldColumns.get('["dy"]')],
        dwColumn = columns[fieldColumns.get('["dw"]')],
        dhColumn = columns[fieldColumns.get('["dh"]')];
      for (let index = 0; index < count; index++) {
        const dx = columnValue(dxColumn, index),
          dy = columnValue(dyColumn, index),
          dw = columnValue(dwColumn, index),
          dh = columnValue(dhColumn, index);
        for (
          let bx = Math.floor(dx / 16 / BUCKET_SIZE);
          bx <= Math.floor((dx + dw - 1) / 16 / BUCKET_SIZE);
          bx++
        )
          for (
            let by = Math.floor(dy / 16 / BUCKET_SIZE);
            by <= Math.floor((dy + dh - 1) / 16 / BUCKET_SIZE);
            by++
          ) {
            const key = bucketKey(bx, by);
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(index);
          }
      }
    }
    for (const [key, bucket] of buckets)
      buckets.set(key, Uint32Array.from(bucket));
    return makeRegistry(
      metadata,
      columns,
      templates,
      rowTemplates,
      buckets,
      fieldColumns,
    );
  };
  return { append, finish };
}
