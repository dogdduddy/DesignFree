import { describe, expect, it } from "vitest";
import {
  createDemoDocument,
  createNode,
  duplicateNodes,
  selectionRoots,
  DocumentHistory,
  getWorldTransform,
  updateNodes,
  validateDocument,
} from "../src/core";

function fixture() {
  const doc = createDemoDocument();
  const root = doc.nodes[doc.rootId];
  const parent = createNode("frame", root.id, {
    id: "parent",
    transform: [1, 0.3, 0.2, 2, 70, 90],
  });
  const image = createNode("image", parent.id, {
    id: "image",
    assetId: Object.keys(doc.assets)[0],
    transform: [0, 1, -1, 0, 12, 15],
  });
  root.children = [parent.id];
  parent.children = [image.id];
  doc.nodes = { [root.id]: root, parent, image };
  validateDocument(doc);
  return doc;
}
describe("subtree duplication shared by command and modifier drag", () => {
  it("deduplicates selected roots and deeply remaps hierarchy while sharing image assets", () => {
    const doc = fixture(),
      original = structuredClone(doc);
    const copied = duplicateNodes(doc, ["parent", "image", "parent"]);
    expect(selectionRoots(doc, ["parent", "image", "parent"])).toEqual([
      "parent",
    ]);
    expect(copied.ids).toHaveLength(1);
    const parent = copied.document.nodes[copied.ids[0]];
    const child = copied.document.nodes[parent.children[0]];
    expect(parent.parentId).toBe(doc.rootId);
    expect(child.id).not.toBe("image");
    expect(child.parentId).toBe(parent.id);
    expect(child.transform).toEqual(doc.nodes.image.transform);
    expect(child.assetId).toBe(doc.nodes.image.assetId);
    expect(getWorldTransform(copied.document, child.id)).toEqual(
      getWorldTransform(doc, "image"),
    );
    expect(copied.document.assets).toEqual(doc.assets);
    copied.document.nodes[child.id].transform[4] += 3;
    expect(doc).toEqual(original);
  });
  it("respects inherited locks and preserves the command's 24-unit root offset", () => {
    const doc = fixture();
    doc.nodes.parent.locked = true;
    expect(duplicateNodes(doc, ["image"]).ids).toEqual([]);
    doc.nodes.parent.locked = false;
    const copied = duplicateNodes(doc, ["parent"], { x: 24, y: 24 });
    expect(copied.document.nodes[copied.ids[0]].transform).toEqual([
      1, 0.3, 0.2, 2, 94, 114,
    ]);
    expect(
      copied.document.nodes[copied.document.nodes[copied.ids[0]].children[0]]
        .transform,
    ).toEqual(doc.nodes.image.transform);
  });
  it("keeps multiple sibling roots and clone movement in one undo/redo transaction", () => {
    const doc = fixture();
    const sibling = createNode("rectangle", doc.rootId, { id: "sibling" });
    doc.nodes.sibling = sibling;
    doc.nodes[doc.rootId].children.push(sibling.id);
    const h = new DocumentHistory(doc);
    h.beginTransaction();
    const copied = duplicateNodes(doc, ["parent", "image", "sibling"]);
    expect(copied.ids).toHaveLength(2);
    const node = copied.document.nodes[copied.ids[0]];
    const tr = [...node.transform] as typeof node.transform;
    tr[4] += 42;
    h.preview(updateNodes(copied.document, { [node.id]: { transform: tr } }));
    h.commitTransaction();
    const moved = h.document;
    h.undo();
    expect(h.document).toEqual(doc);
    expect(h.canUndo).toBe(false);
    h.redo();
    expect(h.document).toEqual(moved);
    h.beginTransaction();
    h.preview(duplicateNodes(h.document, copied.ids).document);
    h.cancelTransaction();
    expect(h.document).toEqual(moved);
  });
});
