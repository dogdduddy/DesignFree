import { computeLayout } from "./flex-layout";
import {
  getWorldTransform,
  invertMatrix,
  transformPoint,
  selectionRoots,
  isNodeLocked,
  validateDocument,
} from "./core";
import type { SceneDocument, Point } from "./core";
import { frameAtPoint } from "./layers";

export type FlowDrop = {
  parentId: string;
  index: number;
  start: Point;
  end: Point;
};
const flow = (doc: SceneDocument, id: string) =>
  ["flex", "grid"].includes(doc.nodes[id]?.layout?.mode);

// Group bounds and component ownership need their own authoring operations.
export function canFlowDrag(doc: SceneDocument, ids: string[]): boolean {
  const roots = selectionRoots(doc, ids);
  return (
    roots.length > 0 &&
    roots.every((id) => {
      const node = doc.nodes[id];
      if (!node.parentId || node.type === "group" || isNodeLocked(doc, id))
        return false;
      for (let p: string | null = id; p; p = doc.nodes[p].parentId)
        if (doc.nodes[p].type === "group" || doc.nodes[p].component)
          return false;
      return true;
    })
  );
}

// Always resolve against the gesture's original geometry, avoiding preview feedback.
export function flowDropAt(
  doc: SceneDocument,
  geometry: SceneDocument,
  ids: string[],
  p: Point,
): FlowDrop | null {
  if (!canFlowDrag(doc, ids)) return null;
  let parentId = frameAtPoint(geometry, p, ids);
  while (!flow(doc, parentId) && doc.nodes[parentId]?.parentId)
    parentId = doc.nodes[parentId].parentId!;
  if (!flow(doc, parentId) || !canFlowDrag(doc, [parentId])) return null;
  const roots = new Set(selectionRoots(doc, ids));
  // Absolute children move freely within their current container. Converting
  // back to flow is an explicit inspector action; entering a new frame inserts.
  if (
    [...roots].every(
      (id) =>
        doc.nodes[id].parentId === parentId &&
        doc.nodes[id].layout.position === "absolute",
    )
  )
    return null;
  for (let a: string | null = parentId; a; a = doc.nodes[a].parentId)
    if (roots.has(a)) return null;
  const parent = geometry.nodes[parentId];
  const matrix = getWorldTransform(geometry, parentId);
  const q = transformPoint(invertMatrix(matrix), p);
  const vertical =
    parent.layout.mode === "flex" && parent.layout.direction === "column";
  const children = doc.nodes[parentId].children.filter(
    (id) =>
      !roots.has(id) &&
      doc.nodes[id].visible &&
      doc.nodes[id].layout.position !== "absolute",
  );
  let anchor: string | undefined,
    distance = Infinity;
  for (const id of children) {
    const n = geometry.nodes[id],
      x = n.transform[4],
      y = n.transform[5];
    const d = Math.hypot(
      Math.max(x - q.x, 0, q.x - x - n.width),
      Math.max(y - q.y, 0, q.y - y - n.height),
    );
    if (d < distance) {
      distance = d;
      anchor = id;
    }
  }
  let index = doc.nodes[parentId].children.length;
  let start: Point, end: Point;
  if (anchor) {
    const n = geometry.nodes[anchor],
      x = n.transform[4],
      y = n.transform[5];
    const after = vertical ? q.y >= y + n.height / 2 : q.x >= x + n.width / 2;
    index = doc.nodes[parentId].children.indexOf(anchor) + (after ? 1 : 0);
    start = vertical
      ? { x, y: y + (after ? n.height : 0) }
      : { x: x + (after ? n.width : 0), y };
    end = vertical
      ? { x: x + n.width, y: start.y }
      : { x: start.x, y: y + n.height };
  } else {
    const padding = parent.layout.padding ?? [0, 0, 0, 0];
    start = { x: padding[3], y: padding[0] };
    end = vertical
      ? { x: Math.max(start.x + 1, parent.width - padding[1]), y: start.y }
      : { x: start.x, y: Math.max(start.y + 1, parent.height - padding[2]) };
  }
  const result = {
    parentId,
    index,
    start: transformPoint(matrix, start),
    end: transformPoint(matrix, end),
  };
  if (parent.layout.mode === "grid") {
    // Explicit Grid placements can differ from sibling order. Show the actual
    // prospective destination, never the visual edge of an unrelated pinned cell.
    const next = computeLayout(applyFlowDrop(doc, ids, result));
    const id = next.nodes[parentId].children.find((id) => roots.has(id))!,
      n = next.nodes[id];
    const m = getWorldTransform(next, parentId);
    result.start = transformPoint(m, { x: n.transform[4], y: n.transform[5] });
    result.end = transformPoint(m, {
      x: n.transform[4],
      y: n.transform[5] + n.height,
    });
  }
  return result;
}

export function applyFlowDrop(
  doc: SceneDocument,
  ids: string[],
  drop: FlowDrop,
): SceneDocument {
  if (
    !canFlowDrag(doc, ids) ||
    !flow(doc, drop.parentId) ||
    !canFlowDrag(doc, [drop.parentId])
  )
    return doc;
  const chosen = new Set(selectionRoots(doc, ids)),
    roots: string[] = [];
  const visit = (id: string) => {
    if (chosen.has(id)) roots.push(id);
    else doc.nodes[id].children.forEach(visit);
  };
  visit(doc.rootId);
  for (let a: string | null = drop.parentId; a; a = doc.nodes[a].parentId)
    if (chosen.has(a)) return doc;
  const next = structuredClone(doc);
  const index = next.nodes[drop.parentId].children
    .slice(0, drop.index)
    .filter((id) => !chosen.has(id)).length;
  for (const id of roots) {
    const n = next.nodes[id];
    next.nodes[n.parentId!].children = next.nodes[n.parentId!].children.filter(
      (child) => child !== id,
    );
    n.parentId = drop.parentId;
    // Preserve authored sizes, transforms and Grid constraints. Only placement changes.
    if (n.layout.position === "absolute") n.layout.position = "flow";
  }
  next.nodes[drop.parentId].children.splice(index, 0, ...roots);
  validateDocument(next);
  return JSON.stringify(next) === JSON.stringify(doc) ? doc : next;
}
