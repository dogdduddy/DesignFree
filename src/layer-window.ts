import type { SceneDocument } from "./core";
export const LAYER_ROW_HEIGHT = 33;
export function layerRows(doc: SceneDocument, collapsed: ReadonlySet<string>) {
  const rows: { id: string; depth: number }[] = [];
  function visit(id: string, depth: number) {
    rows.push({ id, depth });
    if (!collapsed.has(id))
      doc.nodes[id].children.forEach((child) => visit(child, depth + 1));
  }
  doc.nodes[doc.rootId].children.forEach((id) => visit(id, 0));
  return rows;
}
export function layerWindow(count: number, scrollTop: number, height: number) {
  if (count <= 500) return { start: 0, end: count };
  const top = Math.min(
    scrollTop,
    Math.max(0, count * LAYER_ROW_HEIGHT - height),
  );
  return {
    start: Math.max(0, Math.floor(top / LAYER_ROW_HEIGHT) - 8),
    end: Math.min(count, Math.ceil((top + height) / LAYER_ROW_HEIGHT) + 8),
  };
}
