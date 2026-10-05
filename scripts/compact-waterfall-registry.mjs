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

function finishColumn(column) {
  if (column.constant) {
    column.data = null;
    return;
  }
  if (!column.integer) return;
  const { min, max } = column;
  const Type =
    min >= 0 && max <= 255
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
  if (Type !== Float64Array) column.data = new Type(column.data);
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
  if (
    !registry ||
    typeof registry.commandsFor !== "function" ||
    !registry.viewport ||
    registry.viewport.x !== 0 ||
    registry.viewport.y !== 0
  )
    throw new TypeError(
      "Compaction requires a complete whole-world waterfall registry",
    );
  const metadata = {};
  for (const [key, value] of Object.entries(registry))
    if (typeof value !== "function") metadata[key] = structuredClone(value);
  freezeTree(metadata);
  const commands = registry.commandsFor(metadata.viewport);
  const count = commands.length;
  const columns = [],
    fieldColumns = new Map(),
    templates = [],
    templateIds = new Map();
  let rowTemplates = new Uint32Array(count);
  const compile = (value, path, leaves) => {
    if (typeof value === "number") {
      const key = JSON.stringify(path);
      let column = fieldColumns.get(key);
      if (column === undefined) {
        column = columns.length;
        fieldColumns.set(key, column);
        columns.push({
          data: new Float64Array(count),
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
  const templateLeaves = [];
  for (let index = 0; index < count; index++) {
    const command = commands[index];
    // Source queries append these two derived fields; calculate them on demand.
    delete command.x;
    delete command.y;
    const key = signature(command);
    let template = templateIds.get(key);
    if (template === undefined) {
      template = templates.length;
      templateIds.set(key, template);
      const leaves = [];
      templates.push(compile(command, [], leaves));
      templateLeaves.push(leaves);
    }
    rowTemplates[index] = template;
    for (const leaf of templateLeaves[template]) {
      let value = command;
      for (const part of leaf.path) value = value[part];
      const column = columns[leaf.column];
      column.data[index] = value;
      if (!column.seen) {
        column.first = value;
        column.seen = true;
      } else if (!Object.is(value, column.first)) column.constant = false;
      if (!Number.isInteger(value) || Object.is(value, -0))
        column.integer = false;
      column.min = Math.min(column.min, value);
      column.max = Math.max(column.max, value);
    }
    commands[index] = null;
  }
  for (const column of columns) finishColumn(column);
  if (templates.length <= 256) rowTemplates = new Uint8Array(rowTemplates);
  else if (templates.length <= 65536)
    rowTemplates = new Uint16Array(rowTemplates);
  const buckets = new Map();
  if (count) {
    for (const key of ["dx", "dy", "dw", "dh"])
      if (!fieldColumns.has(JSON.stringify([key])))
        throw new TypeError(`Waterfall command has no numeric ${key}`);
    const get = (key, index) =>
      columnValue(columns[fieldColumns.get(JSON.stringify([key]))], index);
    for (let index = 0; index < count; index++) {
      const dx = get("dx", index),
        dy = get("dy", index),
        dw = get("dw", index),
        dh = get("dh", index);
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
}
