import {
  getWorldTransform,
  invertMatrix,
  transformPoint,
  type Point,
  type SceneDocument,
} from "./core";

export type MarqueeBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export function marqueeBox(a: Point, b: Point): MarqueeBox {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Full authored-box containment; a contained frame represents its entire subtree. */
export function marqueeSelection(
  doc: SceneDocument,
  a: Point,
  b: Point,
  scope = doc.rootId,
): string[] {
  const box = marqueeBox(a, b),
    result: string[] = [];
  const within = (p: Point) =>
    p.x >= box.x - 1e-8 &&
    p.y >= box.y - 1e-8 &&
    p.x <= box.x + box.width + 1e-8 &&
    p.y <= box.y + box.height + 1e-8;
  function visit(id: string) {
    const n = doc.nodes[id];
    if (!n || !n.visible || n.locked) return;
    const m = getWorldTransform(doc, id);
    // Ignore singular geometry, matching point hit testing.
    try {
      invertMatrix(m);
    } catch {
      return;
    }
    const corners = [
      { x: 0, y: 0 },
      { x: n.width, y: 0 },
      { x: n.width, y: n.height },
      { x: 0, y: n.height },
    ].map((p) => transformPoint(m, p));
    // Clip the authored quadrilateral against every ancestor's rectangular clip box.
    // Rounded corners and glyph/ellipse outlines are intentionally box based here.
    let visible = corners;
    let parent = n.parentId;
    while (parent && visible.length) {
      const ancestor = doc.nodes[parent];
      if (!ancestor.visible || ancestor.locked) return;
      if (ancestor.clipContent) {
        const matrix = getWorldTransform(doc, parent);
        let inv;
        try {
          inv = invertMatrix(matrix);
        } catch {
          return;
        }
        visible = visible.map((p) => transformPoint(inv, p));
        for (const [axis, edge, sign] of [
          ["x", 0, 1],
          ["x", ancestor.width, -1],
          ["y", 0, 1],
          ["y", ancestor.height, -1],
        ] as const) {
          const input = visible;
          visible = [];
          for (let i = 0; i < input.length; i++) {
            const p = input[i],
              q = input[(i + 1) % input.length];
            const dp = (p[axis] - edge) * sign,
              dq = (q[axis] - edge) * sign;
            if (dp >= 0) visible.push(p);
            if (dp >= 0 !== dq >= 0) {
              const t = dp / (dp - dq);
              visible.push({
                x: p.x + t * (q.x - p.x),
                y: p.y + t * (q.y - p.y),
              });
            }
          }
        }
        visible = visible.map((p) => transformPoint(matrix, p));
      }
      parent = ancestor.parentId;
    }
    const area = Math.abs(
      visible.reduce((sum, p, i) => {
        const q = visible[(i + 1) % visible.length];
        return sum + p.x * q.y - q.x * p.y;
      }, 0),
    );
    if (n.type !== "page" && corners.every(within) && area > 1e-8) {
      result.push(id);
      return;
    }
    if (n.type !== "group") for (const child of n.children) visit(child);
  }
  // Scope is a container, never a candidate, even when the rectangle covers it.
  const container = doc.nodes[scope];
  if (container?.visible && !container.locked)
    for (const id of container.children) visit(id);
  return result;
}
