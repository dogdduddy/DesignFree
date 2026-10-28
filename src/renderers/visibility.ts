import {
  multiplyMatrices,
  transformPoint,
  type Matrix,
  type SceneDocument,
  type SceneNode,
  type Viewport,
} from "../core";

/** Only prune clipped subtrees. Unclipped children and text ink may exceed authored boxes. */
export function clippedOutside(
  node: SceneNode,
  matrix: Matrix,
  width: number,
  height: number,
) {
  if (
    !node.clipContent ||
    node.type === "text" ||
    node.effects?.length ||
    node.styleRefs?.effect
  )
    return false;
  const corners = [
    [0, 0],
    [node.width, 0],
    [0, node.height],
    [node.width, node.height],
  ].map(([x, y]) => transformPoint(matrix, { x, y }));
  // Full stroke width conservatively includes outside borders; 2 device pixels cover AA.
  const stroke = node.stroke?.width ?? 0;
  const px = stroke * (Math.abs(matrix[0]) + Math.abs(matrix[2])) + 2;
  const py = stroke * (Math.abs(matrix[1]) + Math.abs(matrix[3])) + 2;
  return (
    Math.max(...corners.map((p) => p.x)) + px < 0 ||
    Math.min(...corners.map((p) => p.x)) - px > width ||
    Math.max(...corners.map((p) => p.y)) + py < 0 ||
    Math.min(...corners.map((p) => p.y)) - py > height
  );
}
export function culledClips(
  doc: SceneDocument,
  viewport: Viewport,
  width: number,
  height: number,
) {
  const excluded = new Set<string>();
  // An ancestor shadow can project an offscreen child back into view.
  if (
    Object.values(doc.nodes).some(
      (n) => n.effects?.length || n.styleRefs?.effect,
    )
  )
    return excluded;
  function visit(id: string, parent: Matrix) {
    const node = doc.nodes[id];
    if (!node.visible) return;
    const matrix = multiplyMatrices(parent, node.transform);
    if (clippedOutside(node, matrix, width, height)) {
      excluded.add(id);
      return;
    }
    node.children.forEach((child) => visit(child, matrix));
  }
  visit(doc.rootId, [
    viewport.zoom,
    0,
    0,
    viewport.zoom,
    viewport.x,
    viewport.y,
  ]);
  return excluded;
}
