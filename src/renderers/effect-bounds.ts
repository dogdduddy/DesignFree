import { transformPoint, type SceneDocument } from "../core";
/** Conservative local-space filter region, including transformed overflowing descendants.
 * Four sigma bounds the supported Gaussian shadow; font ink gets generous metric padding.
 */
export function effectBounds(doc: SceneDocument, id: string) {
  const node = doc.nodes[id];
  const ink = node.text ? node.text.fontSize * 2 : 0;
  const stroke = node.stroke?.width ?? 0;
  let left = -stroke - ink,
    top = -stroke - ink;
  let right = node.width + stroke + ink,
    bottom = node.height + stroke + ink;
  for (const childId of node.children) {
    const child = doc.nodes[childId];
    if (!child.visible) continue;
    const b = effectBounds(doc, childId);
    for (const [x, y] of [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x, b.y + b.height],
      [b.x + b.width, b.y + b.height],
    ]) {
      const p = transformPoint(child.transform, { x, y });
      left = Math.min(left, p.x);
      top = Math.min(top, p.y);
      right = Math.max(right, p.x);
      bottom = Math.max(bottom, p.y);
    }
  }
  for (const effect of node.effects ?? []) {
    const pad = effect.blur * 4;
    left += Math.min(0, effect.x - pad);
    right += Math.max(0, effect.x + pad);
    top += Math.min(0, effect.y - pad);
    bottom += Math.max(0, effect.y + pad);
  }
  return {
    x: left - 1,
    y: top - 1,
    width: Math.max(1, right - left + 2),
    height: Math.max(1, bottom - top + 2),
  };
}
