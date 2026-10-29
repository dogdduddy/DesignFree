import { layoutInsertionReason, LayoutEditError } from "./layout-editing";
import { computeLayout } from "./flex-layout";
import { resolveDocumentStyles } from "./style-library";
import {
  createNode,
  duplicateNodes,
  getWorldTransform,
  getWorldBounds,
  invertMatrix,
  isNodeLocked,
  multiplyMatrices,
  parseDocument,
  selectionRoots,
  validateDocument,
  type Matrix,
  type SceneDocument,
} from "./core";
import { exportSvg } from "./renderers/svg";

export const CLIPBOARD_MIME = "application/x-draftroom+json";
type Placement = { parentId: string; local: Matrix; sourceLocal?: Matrix };
type Payload = {
  format: "draftroom/clipboard";
  version: 1;
  sourceDocumentId: string;
  document: SceneDocument;
  placements: Record<string, Placement>;
};

/** Only selected subtrees and their owned images cross the clipboard boundary. */
export function copySelection(doc: SceneDocument, ids: string[]) {
  doc = resolveDocumentStyles(doc);
  const roots = selectionRoots(doc, ids).filter((id) => !isNodeLocked(doc, id));
  if (!roots.length) return null;
  const root = createNode("page", null, { fill: { type: "none" } });
  const fragment: SceneDocument = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: "Clipboard",
    rootId: root.id,
    nodes: { [root.id]: root },
    assets: {},
  };
  const placements: Record<string, Placement> = {};
  const firstParent = doc.nodes[roots[0]].parentId!;
  const mixedParents = roots.some(
    (id) => doc.nodes[id].parentId !== firstParent,
  );
  // A mixed-parent selection keeps its relative geometry in the first parent's axes.
  const frameBasis = mixedParents
    ? invertMatrix(getWorldTransform(doc, firstParent))
    : null;
  const visit = (id: string) => {
    const n = structuredClone(doc.nodes[id]);
    // Clipboard is a portable geometry snapshot; component sources stay document-local.
    delete n.component;
    delete n.styleRefs;
    fragment.nodes[id] = n;
    if (n.assetId)
      fragment.assets[n.assetId] = structuredClone(doc.assets[n.assetId]);
    n.children.forEach(visit);
  };
  for (const id of roots) {
    visit(id);
    placements[id] = {
      parentId: doc.nodes[id].parentId!,
      sourceLocal: [...doc.nodes[id].transform],
      local: frameBasis
        ? multiplyMatrices(frameBasis, getWorldTransform(doc, id))
        : [...doc.nodes[id].transform],
    };
    fragment.nodes[id].parentId = root.id;
    fragment.nodes[id].transform = getWorldTransform(doc, id);
  }
  root.children = roots;
  validateDocument(fragment);
  const payload: Payload = {
    format: "draftroom/clipboard",
    version: 1,
    sourceDocumentId: doc.id,
    document: fragment,
    placements,
  };
  // Conservative visible-subtree bounds include overflowing children and strokes.
  // Clipped descendants may add whitespace, but cannot crop visible content.
  // Render from the complete source context: a copied fill/hug child can depend
  // on ancestors which are intentionally absent from the portable payload.
  const geometry = computeLayout(doc);
  const svgDoc = structuredClone(fragment);
  for (const id of Object.keys(fragment.nodes)) {
    if (id === root.id) continue;
    svgDoc.nodes[id].width = geometry.nodes[id].width;
    svgDoc.nodes[id].height = geometry.nodes[id].height;
    svgDoc.nodes[id].text = geometry.nodes[id].text;
    svgDoc.nodes[id].transform = roots.includes(id)
      ? getWorldTransform(geometry, id)
      : [...geometry.nodes[id].transform];
  }
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  const include = (id: string) => {
    const n = svgDoc.nodes[id];
    if (!n.visible) return;
    const b = getWorldBounds(svgDoc, id),
      m = getWorldTransform(svgDoc, id);
    const stroke = (n.stroke?.width ?? 0) / 2;
    const sx = stroke * (Math.abs(m[0]) + Math.abs(m[2]));
    const sy = stroke * (Math.abs(m[1]) + Math.abs(m[3]));
    x = Math.min(x, b.x - sx);
    y = Math.min(y, b.y - sy);
    right = Math.max(right, b.x + b.width + sx);
    bottom = Math.max(bottom, b.y + b.height + sy);
    n.children.forEach(include);
  };
  roots.forEach(include);
  if (!Number.isFinite(x)) {
    x = 0;
    y = 0;
    right = 1;
    bottom = 1;
  }
  svgDoc.nodes[root.id].width = Math.max(1, right - x);
  svgDoc.nodes[root.id].height = Math.max(1, bottom - y);
  for (const id of roots) {
    svgDoc.nodes[id].transform[4] -= x;
    svgDoc.nodes[id].transform[5] -= y;
  }
  return { json: JSON.stringify(payload), svg: exportSvg(svgDoc), ids: roots };
}

function readPayload(json: string): Payload {
  if (json.length > 50_000_000) throw new Error("Clipboard too large");
  const p = JSON.parse(json);
  if (
    p?.format !== "draftroom/clipboard" ||
    p.version !== 1 ||
    typeof p.sourceDocumentId !== "string" ||
    !p.placements ||
    typeof p.placements !== "object"
  )
    throw new Error("Unsupported clipboard format");
  p.document = parseDocument(JSON.stringify(p.document));
  for (const id of p.document.nodes[p.document.rootId].children) {
    if (isNodeLocked(p.document, id)) throw new Error("Locked clipboard root");
    const placement = Object.hasOwn(p.placements, id) && p.placements[id];
    if (
      !placement ||
      typeof placement.parentId !== "string" ||
      !Array.isArray(placement.local) ||
      placement.local.length !== 6 ||
      !placement.local.every(
        (v: unknown) => typeof v === "number" && Number.isFinite(v),
      ) ||
      (placement.sourceLocal !== undefined &&
        (!Array.isArray(placement.sourceLocal) ||
          placement.sourceLocal.length !== 6 ||
          !placement.sourceLocal.every(
            (v: unknown) => typeof v === "number" && Number.isFinite(v),
          )))
    )
      throw new Error("Invalid clipboard placement");
  }
  return p;
}

/** Duplicate's subtree remapping is shared by Cmd+D, Option drag and paste. */
export function pasteSelection(
  doc: SceneDocument,
  json: string,
  selection: string[],
) {
  const p = readPayload(json),
    fragment = p.document;
  const roots = fragment.nodes[fragment.rootId].children;
  if (!roots.length) return { document: doc, ids: [] };
  const selected = selection.length === 1 ? doc.nodes[selection[0]] : undefined;
  const target = selected?.type === "frame" ? selected : undefined;
  if (target && isNodeLocked(doc, target.id))
    throw new Error("Target frame is locked");
  const next = structuredClone(doc);
  const copied = duplicateNodes(fragment, roots);
  // Retain shared references when identical, remap collisions from another document.
  const assets: Record<string, string> = {};
  for (const [id, asset] of Object.entries(fragment.assets)) {
    const existing = Object.hasOwn(next.assets, id)
      ? next.assets[id]
      : undefined;
    const newId =
      existing && JSON.stringify(existing) !== JSON.stringify(asset)
        ? crypto.randomUUID()
        : id;
    assets[id] = newId;
    next.assets[newId] = { ...asset, id: newId };
  }
  const insert = (id: string) => {
    const node = copied.document.nodes[id];
    if (node.assetId) node.assetId = assets[node.assetId];
    next.nodes[id] = node;
    node.children.forEach(insert);
  };
  copied.ids.forEach((id, i) => {
    insert(id);
    const original = roots[i],
      placement = p.placements[original];
    const onActivePage = (id: string): boolean => {
      const node = doc.nodes[id];
      return (
        !!node &&
        (id === doc.rootId || (!!node.parentId && onActivePage(node.parentId)))
      );
    };
    const oldParent =
      p.sourceDocumentId === doc.id &&
      Object.hasOwn(doc.nodes, placement.parentId) &&
      onActivePage(placement.parentId)
        ? doc.nodes[placement.parentId]
        : undefined;
    const parent =
      target ??
      (oldParent &&
      ["page", "frame", "group"].includes(oldParent.type) &&
      !isNodeLocked(doc, oldParent.id)
        ? oldParent
        : doc.nodes[doc.rootId]);
    const node = next.nodes[id];
    const reason = layoutInsertionReason(doc, [node], parent.id);
    if (reason) throw new LayoutEditError(reason);
    const parentInverse = invertMatrix(getWorldTransform(doc, parent.id));
    node.parentId = parent.id;
    node.transform = target
      ? [...placement.local]
      : oldParent && parent.id === oldParent.id && placement.sourceLocal
        ? [...placement.sourceLocal]
        : multiplyMatrices(parentInverse, fragment.nodes[original].transform);
    next.nodes[parent.id].children.push(id);
  });
  validateDocument(next);
  return { document: next, ids: copied.ids };
}
