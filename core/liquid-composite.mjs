import { planLiquids, liquidOmissionWarning } from "./liquid.mjs";
import { planShimmerLiquids } from "./liquid-shimmer.mjs";

function possibleShimmer(region, options) {
  const wet = (t) => t?.liquid > 0 && t.liquidKind === 4;
  if (region.cells.some(wet) || region.context?.cells?.some(wet)) return true;
  // A source above the extracted rectangle may produce a finite falling trail.
  const read = options.getWorldTile ?? region.getWorldTile;
  if (typeof read !== "function") return false;
  const r = region.rect;
  for (let x = Math.max(0, r.x - 1); x <= r.x + r.width; x++)
    for (let y = Math.max(0, r.y - 11); y < r.y; y++)
      if (wet(read(x, y))) return true;
  return false;
}

/** Preserve the established ordinary pass and merge the distinct Shimmer pass. */
export function planSceneLiquids(region, options = {}) {
  const plan = planLiquids(region, options);
  if (!options.enabled || !possibleShimmer(region, options)) return plan;
  const shimmer = planShimmerLiquids(region, options),
    support = plan.support;
  const oldOmission = support.unsupported ? liquidOmissionWarning(support) : null;
  const failed = new Map(shimmer.support.unsupportedCoordinates.map(c => [`${c.x},${c.y}`, c]));
  const resolved = new Map(
    shimmer.resolvedCoordinates.map((c) => [`${c.x},${c.y}`, c]),
  );
  const retained = [];
  for (const c of support.unsupportedCoordinates) {
    const match = resolved.get(`${c.x},${c.y}`);
    if (c.reason === "shimmer" && match) {
      support.unsupported--;
      support.unsupportedByReason.shimmer--;
    } else if (c.reason === "shimmer" && failed.has(`${c.x},${c.y}`)) {
      const replacement = failed.get(`${c.x},${c.y}`);
      support.unsupportedByReason.shimmer--;
      support.unsupportedByReason[replacement.reason] = (support.unsupportedByReason[replacement.reason] || 0) + 1;
      retained.push(replacement);
    } else retained.push(c);
  }
  if (support.unsupportedByReason.shimmer === 0)
    delete support.unsupportedByReason.shimmer;
  const seen = new Set(retained.map((c) => `${c.x},${c.y}`));
  for (const c of shimmer.support.unsupportedCoordinates) {
    const key = `${c.x},${c.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    retained.push(c);
    support.unsupported++;
    support.unsupportedByReason[c.reason] =
      (support.unsupportedByReason[c.reason] || 0) + 1;
  }
  support.unsupportedCoordinates = retained;
  support.shimmer = shimmer.support;
  support.drawn += shimmer.support.drawnCells;
  support.sourceGeometryDrawn += shimmer.support.drawnCells;
  plan.commands.push(...shimmer.commands);
  plan.requiredAssets = [
    ...new Set([...plan.requiredAssets, ...shimmer.requiredAssets]),
  ].sort();
  support.commandCount = plan.commands.length;
  if (oldOmission) plan.warnings = plan.warnings.filter(w => w !== oldOmission);
  if (support.unsupported) plan.warnings.push(liquidOmissionWarning(support));
  plan.warnings.push(
    "Shimmer uses frozen modern base/glitter sprites, time 0 by default, with source corner colors. Runtime distortion, particles and a running-game pixel oracle are unavailable.",
  );
  return plan;
}
