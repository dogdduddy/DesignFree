import {
  getWorldTransform,
  invertMatrix,
  multiplyMatrices,
  transformPoint,
  type Matrix,
  type SceneDocument,
} from "./core";
import { arrangeableRoots } from "./arrangement";
import type { Bounds } from "./measurement";

export interface SnapGuide {
  start: { x: number; y: number };
  end: { x: number; y: number };
  axis: "x" | "y";
  targetId: string;
}
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export const SNAP_THRESHOLD_PX = 6;

function box(doc: SceneDocument, id: string, inverse: Matrix): Bounds {
  const n = doc.nodes[id],
    m = multiplyMatrices(inverse, getWorldTransform(doc, id));
  const points = [
    [0, 0],
    [n.width, 0],
    [0, n.height],
    [n.width, n.height],
  ].map(([x, y]) => transformPoint(m, { x, y }));
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(...points.map((p) => p.x)) - x,
    height: Math.max(...points.map((p) => p.y)) - y,
  };
}
function targets(doc: SceneDocument, ids: string[]) {
  const excluded = new Set<string>();
  const exclude = (id: string) => {
    excluded.add(id);
    doc.nodes[id].children.forEach(exclude);
  };
  ids.forEach(exclude);
  const candidates = new Set<string>();
  for (const id of ids) {
    const parent = doc.nodes[doc.nodes[id].parentId!];
    if (!parent) continue;
    parent.children.forEach((id) => candidates.add(id));
    if (parent.type === "frame") candidates.add(parent.id);
  }
  return [...candidates]
    .filter((id) => {
      if (excluded.has(id)) return false;
      let n = doc.nodes[id];
      while (n) {
        if (!n.visible) return false;
        n = doc.nodes[n.parentId!];
      }
      return true;
    })
    .sort();
}
function snap(
  doc: SceneDocument,
  ids: string[],
  basis: Matrix,
  source: Bounds,
  zoom: number,
  resize = false,
) {
  const inverse = invertMatrix(basis);
  const candidates = targets(doc, ids).map((id) => ({
    id,
    b: box(doc, id, inverse),
  }));
  const delta = { x: 0, y: 0 },
    guides: SnapGuide[] = [];
  if (!(zoom > 0)) return { delta, guides };
  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? "width" : "height",
      cross = axis === "x" ? "y" : "x",
      crossSize = axis === "x" ? "height" : "width";
    // Perpendicular distance between parallel lines, in CSS screen pixels.
    const determinant = Math.abs(basis[0] * basis[3] - basis[1] * basis[2]);
    const screenScale =
      (zoom * determinant) /
      (axis === "x"
        ? Math.hypot(basis[2], basis[3])
        : Math.hypot(basis[0], basis[1]));
    let best:
      { correction: number; value: number; id: string; b: Bounds } | undefined;
    for (const { id, b } of candidates) {
      for (const fraction of resize ? [1, 0.5] : [0, 0.5, 1]) {
        const anchor = source[axis] + source[size] * fraction;
        for (const value of [
          b[axis],
          b[axis] + b[size] / 2,
          b[axis] + b[size],
        ]) {
          const correction = (value - anchor) / (resize ? fraction : 1);
          // Resize threshold measures the moving anchor, not the size change.
          if (Math.abs(value - anchor) * screenScale > SNAP_THRESHOLD_PX + 1e-8)
            continue;
          if (!best || Math.abs(correction) < Math.abs(best.correction) - 1e-8)
            best = { correction, value, id, b };
        }
      }
    }
    if (best) {
      delta[axis] = best.correction;
      const low = Math.min(source[cross], best.b[cross]),
        high = Math.max(
          source[cross] + source[crossSize],
          best.b[cross] + best.b[crossSize],
        );
      guides.push({
        axis,
        targetId: best.id,
        start: transformPoint(
          basis,
          axis === "x" ? { x: best.value, y: low } : { x: low, y: best.value },
        ),
        end: transformPoint(
          basis,
          axis === "x"
            ? { x: best.value, y: high }
            : { x: high, y: best.value },
        ),
      });
    }
  }
  return { delta, guides };
}

/** Same-parent selections snap in the parent's axes; mixed parents use world axes. */
export function snapMove(
  doc: SceneDocument,
  selection: string[],
  dx: number,
  dy: number,
  zoom: number,
) {
  const ids = arrangeableRoots(doc, selection);
  if (!ids.length) return { dx, dy, guides: [] as SnapGuide[] };
  const parent = doc.nodes[ids[0]].parentId;
  const basis =
    parent && ids.every((id) => doc.nodes[id].parentId === parent)
      ? getWorldTransform(doc, parent)
      : IDENTITY;
  const inverse = invertMatrix(basis),
    boxes = ids.map((id) => box(doc, id, inverse));
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  const localDelta = {
    x: inverse[0] * dx + inverse[2] * dy,
    y: inverse[1] * dx + inverse[3] * dy,
  };
  const result = snap(
    doc,
    ids,
    basis,
    {
      x: x + localDelta.x,
      y: y + localDelta.y,
      width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
      height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
    },
    zoom,
  );
  return {
    dx: dx + basis[0] * result.delta.x + basis[2] * result.delta.y,
    dy: dy + basis[1] * result.delta.x + basis[3] * result.delta.y,
    guides: result.guides,
  };
}

/** Bottom/right resize preserves the authored origin and linear transform. */
export function snapResize(
  doc: SceneDocument,
  id: string,
  width: number,
  height: number,
  zoom: number,
) {
  const result = snap(
    doc,
    [id],
    getWorldTransform(doc, id),
    { x: 0, y: 0, width, height },
    zoom,
    true,
  );
  const w = Math.max(8, width + result.delta.x),
    h = Math.max(8, height + result.delta.y);
  return {
    width: w,
    height: h,
    guides: result.guides.filter((g) =>
      g.axis === "x"
        ? w === width + result.delta.x
        : h === height + result.delta.y,
    ),
  };
}
