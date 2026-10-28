import { addPage } from "../src/documents";
import { describe, expect, it } from "vitest";
import { copySelection, pasteSelection } from "../src/clipboard";
import {
  createDemoDocument,
  createNode,
  getWorldTransform,
  validateDocument,
  DocumentHistory,
  duplicateNodes,
  invertMatrix,
  multiplyMatrices,
} from "../src/core";

function fixture() {
  const doc = createDemoDocument();
  const page = doc.nodes[doc.rootId];
  const f = createNode("frame", page.id, {
    id: "frame",
    transform: [1, 0.3, 0.2, 2, 70, 90],
    children: ["image"],
  });
  const image = createNode("image", f.id, {
    id: "image",
    assetId: Object.keys(doc.assets)[0],
    transform: [0, 1, -1, 0, 12, 15],
  });
  const target = createNode("frame", page.id, {
    id: "target",
    transform: [2, 0.1, 0.5, 1, 400, 500],
  });
  page.children = [f.id, target.id];
  doc.nodes = { [page.id]: page, frame: f, image, target };
  validateDocument(doc);
  return doc;
}
const data = (doc = fixture(), ids = ["frame", "image"]) =>
  copySelection(doc, ids)!;

describe("clipboard subtrees", () => {
  it("copies a selected ancestor once, including only referenced assets, without mutating input", () => {
    const doc = fixture(),
      before = structuredClone(doc);
    const p = JSON.parse(data(doc).json);
    expect(p.document.nodes[p.document.rootId].children).toEqual(["frame"]);
    expect(Object.keys(p.document.nodes)).toHaveLength(3);
    expect(p.document.assets).toEqual(doc.assets);
    expect(doc).toEqual(before);
    expect(data(doc).svg).toContain("<svg");
    expect(data(doc).svg).toContain(
      doc.assets[doc.nodes.image.assetId!].dataUrl,
    );
  });
  it("includes overflowing descendants and affine strokes in the SVG viewport", () => {
    const doc = fixture();
    doc.nodes.frame.transform = [1, 0, 0, 1, 0, 0];
    doc.nodes.image.transform = [2, 0, 0, 1, 200, -50];
    doc.nodes.image.stroke = { color: "#000000", width: 20 };
    const svg = data(doc).svg;
    expect(svg).toContain('width="420"');
    expect(svg).toContain('height="160"');
    expect(svg).toContain('viewBox="0 0 420 160"');
  });
  it("rejects externally supplied locked roots instead of shifting source placements", () => {
    const doc = fixture(),
      p = JSON.parse(data(doc, ["frame", "target"]).json);
    p.document.nodes.frame.locked = true;
    expect(() => pasteSelection(doc, JSON.stringify(p), [])).toThrow(
      "Locked clipboard root",
    );
    p.document.nodes.frame.locked = false;
    p.document.nodes[p.document.rootId].locked = true;
    expect(() => pasteSelection(doc, JSON.stringify(p), [])).toThrow(
      "Locked clipboard root",
    );
  });
  it("issues fresh IDs on every paste and preserves affine world position and image reference", () => {
    const doc = fixture(),
      json = data(doc, ["image"]).json;
    const first = pasteSelection(doc, json, []),
      second = pasteSelection(first.document, json, []);
    expect(new Set(["image", ...first.ids, ...second.ids]).size).toBe(3);
    const image = first.document.nodes[first.ids[0]];
    expect(image.parentId).toBe("frame");
    getWorldTransform(first.document, image.id).forEach((v, i) =>
      expect(v).toBeCloseTo(getWorldTransform(doc, "image")[i]),
    );
    expect(image.assetId).toBe(doc.nodes.image.assetId);
    expect(first.document.assets).toEqual(doc.assets);
  });
  it("uses original local coordinates inside a selected affine frame", () => {
    const doc = fixture();
    const pasted = pasteSelection(doc, data(doc, ["image"]).json, ["target"]);
    const node = pasted.document.nodes[pasted.ids[0]];
    expect(node.parentId).toBe("target");
    expect(node.transform).toEqual(doc.nodes.image.transform);
  });
  it("preserves relative affine geometry when pasting mixed-parent roots into a frame", () => {
    const doc = fixture();
    const other = createNode("ellipse", "target", {
      id: "other",
      transform: [1, 0, 0.4, 1, 25, 40],
    });
    doc.nodes.other = other;
    doc.nodes.target.children.push(other.id);
    const pasted = pasteSelection(doc, data(doc, ["image", "other"]).json, [
      "target",
    ]);
    const basis = invertMatrix(getWorldTransform(doc, "frame"));
    ["image", "other"].forEach((id, i) => {
      const expected = multiplyMatrices(basis, getWorldTransform(doc, id));
      pasted.document.nodes[pasted.ids[i]].transform.forEach((v, j) =>
        expect(v).toBeCloseTo(expected[j]),
      );
    });
  });
  it("remaps all nested parent/child IDs consistently with Cmd+D", () => {
    const doc = fixture();
    const pasted = pasteSelection(doc, data(doc).json, []);
    const duplicated = duplicateNodes(doc, ["frame"], { x: 24, y: 24 });
    const a = pasted.document.nodes[pasted.ids[0]],
      b = duplicated.document.nodes[duplicated.ids[0]];
    expect(a.name).toBe(b.name);
    expect(a.children).toHaveLength(1);
    expect(pasted.document.nodes[a.children[0]].parentId).toBe(a.id);
    expect(pasted.document.nodes[a.children[0]].transform).toEqual(
      duplicated.document.nodes[b.children[0]].transform,
    );
    expect(b.transform[4] - a.transform[4]).toBe(24);
  });
  it("keeps copy outside history and paste as one Undo/Redo with assets intact", () => {
    const doc = fixture(),
      h = new DocumentHistory(doc);
    const json = data(doc).json;
    expect(h.canUndo).toBe(false);
    const pasted = pasteSelection(doc, json, []);
    h.execute(pasted.document);
    h.undo();
    expect(h.document).toEqual(doc);
    expect(h.canUndo).toBe(false);
    h.redo();
    expect(h.document).toEqual(pasted.document);
  });
  it("pastes across documents at the copied world position, carrying images", () => {
    const doc = fixture(),
      target = fixture();
    target.id = "other";
    target.assets = {};
    delete target.nodes.image;
    target.nodes.frame.children = [];
    const pasted = pasteSelection(target, data(doc, ["image"]).json, []);
    expect(pasted.document.nodes[pasted.ids[0]].parentId).toBe(target.rootId);
    expect(getWorldTransform(pasted.document, pasted.ids[0])).toEqual(
      getWorldTransform(doc, "image"),
    );
    expect(pasted.document.assets).toEqual(doc.assets);
  });
  it("remaps colliding asset IDs without replacing existing images", () => {
    const doc = fixture(),
      target = fixture(),
      assetId = doc.nodes.image.assetId!;
    target.id = "other";
    target.assets[assetId].width += 1;
    const before = structuredClone(target);
    const pasted = pasteSelection(target, data(doc, ["image"]).json, []);
    const remapped = pasted.document.nodes[pasted.ids[0]].assetId!;
    expect(remapped).not.toBe(assetId);
    expect(pasted.document.assets[assetId]).toEqual(before.assets[assetId]);
    expect(pasted.document.assets[remapped].dataUrl).toBe(
      doc.assets[assetId].dataUrl,
    );
    expect(target).toEqual(before);
  });
  it("falls back to page after cut removes the original parent", () => {
    const doc = fixture(),
      json = data(doc, ["image"]).json;
    delete doc.nodes.image;
    delete doc.nodes.frame;
    doc.nodes[doc.rootId].children = ["target"];
    const pasted = pasteSelection(doc, json, []);
    expect(pasted.document.nodes[pasted.ids[0]].parentId).toBe(doc.rootId);
  });
  it("does not copy inherited locked selections and rejects a locked frame target atomically", () => {
    const doc = fixture();
    doc.nodes.frame.locked = true;
    expect(copySelection(doc, ["image"])).toBeNull();
    doc.nodes.frame.locked = false;
    doc.nodes.target.locked = true;
    const before = structuredClone(doc);
    expect(() => pasteSelection(doc, data(doc).json, ["target"])).toThrow(
      "locked",
    );
    expect(doc).toEqual(before);
  });
  it("rejects invalid JSON, formats, placements and unsafe images without changing target", () => {
    const doc = fixture(),
      before = structuredClone(doc),
      original = JSON.parse(data(doc).json);
    const badPlacement = structuredClone(original);
    badPlacement.placements.frame.local = [1, 2];
    const badImage = structuredClone(original);
    Object.values(badImage.document.assets).forEach(
      (a: any) => (a.dataUrl = "https://invalid/image.png"),
    );
    for (const json of [
      "bad",
      "{}",
      JSON.stringify({ ...original, version: 2 }),
      JSON.stringify(badPlacement),
      JSON.stringify(badImage),
    ])
      expect(() => pasteSelection(doc, json, [])).toThrow();
    expect(doc).toEqual(before);
  });
  it("rejects a singular target parent without partial changes", () => {
    const doc = fixture(),
      json = data(doc, ["image"]).json;
    doc.nodes.frame.transform = [0, 0, 0, 0, 0, 0];
    const before = structuredClone(doc);
    expect(() => pasteSelection(doc, json, [])).toThrow("Singular");
    expect(doc).toEqual(before);
  });
});

it("pastes into the active page when original parent belongs to another page", () => {
  const original = fixture();
  const payload = data(original, ["image"]).json;
  const document = addPage(original);
  const pasted = pasteSelection(document, payload, []);
  expect(pasted.document.nodes[pasted.ids[0]].parentId).toBe(document.rootId);
  expect(pasted.document.nodes.frame.children).toEqual(
    original.nodes.frame.children,
  );
  expect(getWorldTransform(pasted.document, pasted.ids[0])).toEqual(
    getWorldTransform(original, "image"),
  );
});
