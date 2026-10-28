import {
  getWorldBounds,
  getWorldTransform,
  invertMatrix,
  isNodeLocked,
  selectionRoots,
  updateNodes,
  type Matrix,
  type SceneDocument,
  type SceneNode,
} from "./core";

export type Alignment =
  "left" | "center-x" | "right" | "top" | "center-y" | "bottom";
const EPSILON = 1e-8;
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function parentInverse(doc: SceneDocument, id: string): Matrix {
  const parentId = doc.nodes[id].parentId;
  return parentId ? invertMatrix(getWorldTransform(doc, parentId)) : IDENTITY;
}

/** Only editable selection roots contribute to the arrangement reference bounds. */
export function arrangeableRoots(doc: SceneDocument, ids: string[]): string[] {
  const eligible = ids.filter((id) => {
    if (
      !Object.hasOwn(doc.nodes, id) ||
      id === doc.rootId ||
      doc.nodes[id].type === "page" ||
      isNodeLocked(doc, id)
    )
      return false;
    let node: SceneNode | undefined = doc.nodes[id];
    while (node) {
      if (!node.visible) return false;
      node = node.parentId ? doc.nodes[node.parentId] : undefined;
    }
    try {
      parentInverse(doc, id);
      const bounds = getWorldBounds(doc, id);
      return Object.values(bounds).every(Number.isFinite);
    } catch {
      return false;
    }
  });
  return selectionRoots(doc, eligible);
}

function translate(
  doc: SceneDocument,
  changes: Record<string, Partial<SceneNode>>,
  id: string,
  dx: number,
  dy: number,
) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  if (Math.abs(dx) <= EPSILON && Math.abs(dy) <= EPSILON) return true;
  const inverse = parentInverse(doc, id);
  const transform: Matrix = [...doc.nodes[id].transform];
  transform[4] += inverse[0] * dx + inverse[2] * dy;
  transform[5] += inverse[1] * dx + inverse[3] * dy;
  if (!transform.every(Number.isFinite)) return false;
  changes[id] = { transform };
  return true;
}

export function alignNodes(
  doc: SceneDocument,
  ids: string[],
  alignment: Alignment,
): SceneDocument {
  const roots = arrangeableRoots(doc, ids);
  if (roots.length < 2) return doc;
  const bounds = roots.map((id) => getWorldBounds(doc, id));
  const x = Math.min(...bounds.map((b) => b.x));
  const y = Math.min(...bounds.map((b) => b.y));
  const right = Math.max(...bounds.map((b) => b.x + b.width));
  const bottom = Math.max(...bounds.map((b) => b.y + b.height));
  const changes: Record<string, Partial<SceneNode>> = {};
  for (const [index, id] of roots.entries()) {
    const b = bounds[index];
    let dx = 0,
      dy = 0;
    switch (alignment) {
      case "left":
        dx = x - b.x;
        break;
      case "center-x":
        dx = x / 2 + right / 2 - b.width / 2 - b.x;
        break;
      case "right":
        dx = right - b.width - b.x;
        break;
      case "top":
        dy = y - b.y;
        break;
      case "center-y":
        dy = y / 2 + bottom / 2 - b.height / 2 - b.y;
        break;
      case "bottom":
        dy = bottom - b.height - b.y;
        break;
    }
    if (!translate(doc, changes, id, dx, dy)) return doc;
  }
  return Object.keys(changes).length ? updateNodes(doc, changes) : doc;
}

function distributionPlan(doc: SceneDocument, ids: string[], axis: "x" | "y") {
  const roots = arrangeableRoots(doc, ids);
  if (roots.length < 3) return null;
  const extent = axis === "x" ? "width" : "height";
  const items = roots.map((id) => ({ id, bounds: getWorldBounds(doc, id) }));
  items.sort(
    (a, b) =>
      a.bounds[axis] - b.bounds[axis] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const first = items[0].bounds,
    last = items[items.length - 1].bounds;
  const gap =
    (last[axis] +
      last[extent] -
      first[axis] -
      items.reduce((sum, item) => sum + item.bounds[extent], 0)) /
    (items.length - 1);
  if (!Number.isFinite(gap)) return null;
  const positions = [first[axis]];
  let position = first[axis] + first[extent] + gap;
  for (let i = 1; i < items.length - 1; i++) {
    // Preserve exact coordinates for already arranged objects, including epsilon noise.
    positions.push(
      Math.abs(position - items[i].bounds[axis]) <= EPSILON
        ? items[i].bounds[axis]
        : position,
    );
    position += items[i].bounds[extent] + gap;
  }
  positions.push(last[axis]);
  for (let i = 1; i < items.length; i++) {
    if (!Number.isFinite(positions[i]) || positions[i] < positions[i - 1])
      return null;
    // The next invocation must resolve equal leading edges to this same order.
    if (positions[i] === positions[i - 1] && items[i].id < items[i - 1].id)
      return null;
  }
  for (let i = 1; i < items.length - 1; i++) {
    const delta = positions[i] - items[i].bounds[axis];
    if (
      !translate(
        doc,
        {},
        items[i].id,
        axis === "x" ? delta : 0,
        axis === "y" ? delta : 0,
      )
    )
      return null;
  }
  return { items, positions };
}

/** Whether fixed endpoints permit equal gaps without changing spatial order. */
export function canDistribute(
  doc: SceneDocument,
  ids: string[],
  axis: "x" | "y",
): boolean {
  return distributionPlan(doc, ids, axis) !== null;
}

/** Equal edge-to-edge gaps, including overlap, with the spatial endpoints fixed. */
export function distributeNodes(
  doc: SceneDocument,
  ids: string[],
  axis: "x" | "y",
): SceneDocument {
  const plan = distributionPlan(doc, ids, axis);
  if (!plan) return doc;
  const { items, positions } = plan;
  const changes: Record<string, Partial<SceneNode>> = {};
  for (let i = 1; i < items.length - 1; i++) {
    const { id, bounds } = items[i];
    const delta = positions[i] - bounds[axis];
    if (
      !translate(
        doc,
        changes,
        id,
        axis === "x" ? delta : 0,
        axis === "y" ? delta : 0,
      )
    )
      return doc;
  }
  return Object.keys(changes).length ? updateNodes(doc, changes) : doc;
}
