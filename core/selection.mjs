import { validateRect } from "./world.mjs";
/** Convert either drag direction into a nonempty, cell-aligned half-open rectangle. */
export function rectangleFromDrag(
  start,
  end,
  view,
  displayWidth,
  displayHeight,
) {
  if (
    ![start.x, start.y, end.x, end.y, displayWidth, displayHeight].every(
      Number.isFinite,
    ) ||
    displayWidth <= 0 ||
    displayHeight <= 0
  )
    throw new Error("Invalid selection coordinates");
  const cell = (p) => ({
    x: Math.max(
      0,
      Math.min(view.width - 1, Math.floor((p.x / displayWidth) * view.width)),
    ),
    y: Math.max(
      0,
      Math.min(
        view.height - 1,
        Math.floor((p.y / displayHeight) * view.height),
      ),
    ),
  });
  const a = cell(start),
    b = cell(end);
  return {
    x: view.x + Math.min(a.x, b.x),
    y: view.y + Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x) + 1,
    height: Math.abs(a.y - b.y) + 1,
  };
}
export function moveRectangle(rect, dx, dy, worldWidth, worldHeight) {
  const next = {
    ...rect,
    x: Math.max(0, Math.min(worldWidth - rect.width, rect.x + dx)),
    y: Math.max(0, Math.min(worldHeight - rect.height, rect.y + dy)),
  };
  return validateRect(next, worldWidth, worldHeight);
}
