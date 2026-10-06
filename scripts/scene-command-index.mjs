/**
 * One bounded command-to-index table shared by frame and geometry lookups.
 * Frame identities and geometry classifications stay in indexed arrays, rather
 * than separate object-keyed maps. No annotations or mutation of commands are
 * required, including frozen, reused, or externally supplied registry objects.
 */
export function createSceneCommandIndex(commands) {
  if (!Array.isArray(commands) || commands.length > 131072)
    throw new RangeError("Invalid scene command index budget");
  const positions = new Map(),
    keys = new Array(commands.length);
  let disposed = false;
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    if (!command || typeof command !== "object")
      throw new TypeError("Invalid scene command index entry");
    positions.set(command, i);
  }
  const indexOf = (command) => {
    if (disposed) throw new Error("Scene command index is disposed");
    const index = positions.get(command);
    return index !== undefined && commands[index] === command ? index : -1;
  };
  return {
    indexOf,
    get(command) {
      const index = indexOf(command);
      return index < 0 ? undefined : keys[index];
    },
    set(command, key) {
      const index = indexOf(command);
      if (index < 0) throw new Error("Command is absent from indexed scene");
      keys[index] = key;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      positions.clear();
      keys.length = 0;
      commands = null;
    },
  };
}
