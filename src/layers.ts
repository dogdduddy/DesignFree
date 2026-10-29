import { computeLayout } from "./flex-layout";
import { flowContainer, layoutReparentReason } from "./layout-editing";
import {
  getWorldTransform,
  multiplyMatrices,
  invertMatrix,
  transformPoint,
  selectionRoots,
  isNodeLocked,
  normalizeGroupBounds,
  validateDocument,
} from "./core";
import type { SceneDocument, Point } from "./core";

// Scene traversal gives a stable paint order, independent of selection click order.
function orderedRoots(doc: SceneDocument, ids: string[]) {
  const roots = new Set(selectionRoots(doc, ids)),
    result: string[] = [];
  const visit = (id: string) => {
    if (roots.has(id)) result.push(id);
    else doc.nodes[id].children.forEach(visit);
  };
  visit(doc.rootId);
  return result;
}
export function moveLayers(
  doc: SceneDocument,
  ids: string[],
  parentId: string,
  index = doc.nodes[parentId]?.children.length ?? 0,
): SceneDocument {
  const roots = orderedRoots(doc, ids),
    parent = doc.nodes[parentId];
  if (
    !roots.length ||
    !parent ||
    !["page", "frame", "group"].includes(parent.type) ||
    isNodeLocked(doc, parentId) ||
    roots.some((id) => isNodeLocked(doc, id))
  )
    return doc;
  if (layoutReparentReason(doc, roots, parentId)) return doc;
  for (let p: string | null = parentId; p; p = doc.nodes[p].parentId)
    if (roots.includes(p)) return doc;
  try {
    // Geometry is read only for the intended coordinate conversion. Dimensions
    // and layout rules stay authored, including when either ancestor is in flow.
    const geometry = computeLayout(doc);
    const inv = invertMatrix(getWorldTransform(geometry, parentId));
    const next = structuredClone(doc),
      chosen = new Set(roots);
    const before = parent.children
      .slice(0, index)
      .filter((id) => !chosen.has(id)).length;
    for (const id of roots) {
      const n = next.nodes[id];
      next.nodes[n.parentId!].children = next.nodes[
        n.parentId!
      ].children.filter((child) => child !== id);
      // Layout moves keep authored local fallback coordinates, as canvas flow
      // insertion does. Leaving flow reveals those coordinates; never bake boxes.
      if (
        n.parentId !== parentId &&
        !flowContainer(parent) &&
        (!flowContainer(doc.nodes[n.parentId!]) ||
          n.layout.position === "absolute")
      )
        n.transform = multiplyMatrices(inv, getWorldTransform(geometry, id));
      if (
        n.parentId !== parentId &&
        flowContainer(parent) &&
        n.layout.position === "absolute"
      )
        n.layout.position = "flow";
      n.parentId = parentId;
    }
    next.nodes[parentId].children.splice(before, 0, ...roots);
    const normalized = normalizeGroupBounds(next);
    validateDocument(normalized);
    return JSON.stringify(normalized) === JSON.stringify(doc)
      ? doc
      : normalized;
  } catch {
    return doc;
  }
}
export function stepLayers(
  doc: SceneDocument,
  ids: string[],
  forward: boolean,
): SceneDocument {
  const roots = orderedRoots(doc, ids),
    chosen = new Set(roots);
  if (!roots.length || roots.some((id) => isNodeLocked(doc, id))) return doc;
  const next = structuredClone(doc);
  for (const parentId of new Set(roots.map((id) => doc.nodes[id].parentId!))) {
    const children = next.nodes[parentId].children;
    if (forward) {
      for (let i = children.length - 2; i >= 0; i--)
        if (chosen.has(children[i]) && !chosen.has(children[i + 1]))
          [children[i], children[i + 1]] = [children[i + 1], children[i]];
    } else {
      for (let i = 1; i < children.length; i++)
        if (chosen.has(children[i]) && !chosen.has(children[i - 1]))
          [children[i], children[i - 1]] = [children[i - 1], children[i]];
    }
  }
  return JSON.stringify(next) === JSON.stringify(doc) ? doc : next;
}
// Reverse paint traversal, respecting visibility, inherited locks and ancestor clipping.
export function frameAtPoint(
  doc: SceneDocument,
  p: Point,
  ids: string[],
): string {
  const ignored = new Set(selectionRoots(doc, ids));
  const visit = (id: string): string | null => {
    const n = doc.nodes[id];
    if (ignored.has(id) || !n.visible || n.locked) return null;
    let inside = false;
    try {
      const q = transformPoint(invertMatrix(getWorldTransform(doc, id)), p);
      inside = q.x >= 0 && q.y >= 0 && q.x <= n.width && q.y <= n.height;
    } catch {
      return null;
    }
    if (n.clipContent && !inside) return null;
    for (const child of [...n.children].reverse()) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return n.type === "frame" && inside ? id : null;
  };
  return visit(doc.rootId) ?? doc.rootId;
}
export function reparentCanvasDrop(
  doc: SceneDocument,
  ids: string[],
  p: Point,
): SceneDocument {
  const parentId = frameAtPoint(doc, p, ids);
  const moving = selectionRoots(doc, ids).filter((id) => {
    let ancestor = doc.nodes[id].parentId!;
    while (doc.nodes[ancestor].type === "group")
      ancestor = doc.nodes[ancestor].parentId!;
    return ancestor !== parentId;
  });
  return moveLayers(doc, moving, parentId);
}
