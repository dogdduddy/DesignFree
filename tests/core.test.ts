import { describe, expect, it } from "vitest";
import {
  createNode,
  createDemoDocument,
  createBenchmarkDocument,
  DocumentHistory,
  getWorldTransform,
  multiplyMatrices,
  invertMatrix,
  transformPoint,
  screenToWorld,
  worldToScreen,
  reparentNode,
  hitTest,
  updateNodes,
  parseDocument,
  serializeDocument,
  type SceneDocument,
} from "../src/core";
function geometry(): SceneDocument {
  const root = createNode("page", null, {
    id: "root",
    width: 1000,
    height: 1000,
  });
  const a = createNode("frame", "root", {
    id: "a",
    transform: [0, 2, -2, 0, 300, 100],
    width: 100,
    height: 100,
  });
  const b = createNode("frame", "root", {
    id: "b",
    transform: [1, 0.3, 0.2, 1, 500, 50],
  });
  const child = createNode("rectangle", "a", {
    id: "c",
    transform: [1, 0, 0, 1, 20, 30],
    width: 40,
    height: 20,
  });
  root.children = ["a", "b"];
  a.children = ["c"];
  return {
    schemaVersion: 1,
    id: "test",
    name: "Geometry",
    rootId: "root",
    nodes: { root, a, b, c: child },
    assets: {},
  };
}
function near(a: number[], b: number[]) {
  a.forEach((n, i) => expect(n).toBeCloseTo(b[i], 9));
}
describe("affine authoring geometry", () => {
  it("roundtrips nested local/world/screen with scale, rotation, shear and zoom", () => {
    const d = geometry();
    const m = getWorldTransform(d, "c");
    const p = { x: 17, y: 11 };
    const v = { x: -74, y: 31, zoom: 0.25 };
    const result = transformPoint(
      invertMatrix(m),
      screenToWorld(worldToScreen(transformPoint(m, p), v), v),
    );
    near([result.x, result.y], [17, 11]);
    near(multiplyMatrices(m, invertMatrix(m)), [1, 0, 0, 1, 0, 0]);
    expect(() => invertMatrix([1, 2, 2, 4, 0, 0])).toThrow();
  });
  it("reparents between nonidentity parents preserving all world corners", () => {
    const d = geometry(),
      before = getWorldTransform(d, "c");
    const next = reparentNode(d, "c", "b");
    near(getWorldTransform(next, "c"), before);
    expect(d.nodes.a.children).toEqual(["c"]);
    expect(next.nodes.a.children).toEqual([]);
    expect(next.nodes.b.children).toEqual(["c"]);
    expect(() => reparentNode(d, "a", "c")).toThrow();
    expect(() => reparentNode(d, "a", "a")).toThrow();
  });
  it("honors topmost paint order, hidden/locked ancestors and parent clipping", () => {
    let d = geometry();
    const p = transformPoint(getWorldTransform(d, "c"), { x: 10, y: 10 });
    expect(hitTest(d, p)).toBe("c");
    d = updateNodes(d, { a: { locked: true } });
    expect(hitTest(d, p)).toBe(null);
    d = updateNodes(d, { a: { locked: false, visible: false } });
    expect(hitTest(d, p)).toBe(null);
    d = updateNodes(d, {
      a: { visible: true, clipContent: true },
      c: { transform: [1, 0, 0, 1, 110, 0] },
    });
    const outside = transformPoint(getWorldTransform(d, "c"), { x: 10, y: 10 });
    expect(hitTest(d, outside)).toBe(null);
    d = updateNodes(d, { a: { clipContent: false } });
    expect(hitTest(d, outside)).toBe("c");
  });
});
describe("transaction snapshots", () => {
  it("exposes only committed snapshots across preview, cancel, commit, undo and redo", () => {
    const h = new DocumentHistory(geometry());
    const original = h.committedDocument;
    h.beginTransaction();
    h.preview(updateNodes(h.document, { c: { width: 777 } }));
    expect(h.document.nodes.c.width).toBe(777);
    expect(h.committedDocument).toEqual(original);
    const detached = h.committedDocument;
    detached.nodes.c.width = 999;
    expect(h.committedDocument).toEqual(original);
    h.cancelTransaction();
    expect(h.committedDocument).toEqual(original);
    h.beginTransaction();
    h.preview(updateNodes(h.document, { c: { width: 888 } }));
    h.commitTransaction();
    expect(h.committedDocument.nodes.c.width).toBe(888);
    h.undo();
    expect(h.committedDocument).toEqual(original);
    h.redo();
    expect(h.committedDocument.nodes.c.width).toBe(888);
  });
  it("makes a whole drag one undo, supports redo and cancel, isolates external mutation", () => {
    const initial = geometry(),
      h = new DocumentHistory(initial);
    initial.name = "mutated";
    expect(h.document.name).toBe("Geometry");
    h.beginTransaction();
    for (let i = 1; i <= 20; i++)
      h.preview(
        updateNodes(h.document, { c: { transform: [1, 0, 0, 1, 20 + i, 30] } }),
      );
    h.commitTransaction();
    expect(h.canUndo).toBe(true);
    h.undo();
    expect(h.document.nodes.c.transform[4]).toBe(20);
    expect(h.canUndo).toBe(false);
    h.redo();
    expect(h.document.nodes.c.transform[4]).toBe(40);
    h.beginTransaction();
    h.preview(updateNodes(h.document, { c: { width: 500 } }));
    h.cancelTransaction();
    expect(h.document.nodes.c.width).toBe(40);
    const external = h.document;
    external.nodes.c.width = 999;
    expect(h.document.nodes.c.width).toBe(40);
  });
  it("preserves redo when a transaction is unchanged and discards on new edit", () => {
    const h = new DocumentHistory(geometry());
    h.execute(updateNodes(h.document, { c: { width: 12 } }));
    h.undo();
    h.beginTransaction();
    h.commitTransaction();
    expect(h.canRedo).toBe(true);
    h.execute(updateNodes(h.document, { c: { width: 13 } }));
    expect(h.canRedo).toBe(false);
  });
});
describe("document boundary", () => {
  it("roundtrips demo without editor transient state", () => {
    const doc = createDemoDocument();
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
    expect(serializeDocument(doc)).not.toContain("selection");
  });
  it("rejects unsupported versions, dangling references, cycles, unsafe assets and nonfinite geometry", () => {
    for (const mutate of [
      (d: any) => (d.schemaVersion = 2),
      (d: any) => (d.nodes.a.parentId = "b"),
      (d: any) => d.nodes.c.children.push("root"),
      (d: any) => (d.nodes.c.width = Infinity),
      (d: any) => {
        d.nodes.c.type = "image";
        d.nodes.c.assetId = "missing";
      },
      (d: any) => d.nodes.root.children.push("__proto__"),
    ]) {
      const doc = geometry();
      mutate(doc);
      expect(() => serializeDocument(doc)).toThrow();
    }
    const doc = createDemoDocument();
    doc.assets.pattern.dataUrl = "https://untrusted.invalid/image.png";
    expect(() => parseDocument(JSON.stringify(doc))).toThrow();
  });
  it("rejects external or executable paint references at import", () => {
    for (const unsafe of [
      "url(https://attacker.invalid/paint.svg#x)",
      "javascript:alert(1)",
      "red; background:url(https://attacker.invalid)",
    ]) {
      const d = geometry();
      d.nodes.c.fill = { type: "solid", color: unsafe };
      expect(() => parseDocument(JSON.stringify(d))).toThrow();
      d.nodes.c.fill = { type: "none" };
      d.nodes.c.stroke = { color: unsafe, width: 1 };
      expect(() => parseDocument(JSON.stringify(d))).toThrow();
    }
  });
  it("generates exact 100/1000/10000 totals with mixed clipping, gradients, text and images", () => {
    for (const count of [100, 1000, 10000]) {
      const doc = createBenchmarkDocument(count);
      expect(Object.keys(doc.nodes)).toHaveLength(count);
      expect(parseDocument(serializeDocument(doc))).toEqual(doc);
      const nodes = Object.values(doc.nodes);
      expect(nodes.some((n) => n.clipContent)).toBe(true);
      expect(nodes.some((n) => n.type === "text")).toBe(true);
      expect(nodes.some((n) => n.type === "image")).toBe(true);
      expect(nodes.some((n) => n.fill.type === "linear")).toBe(true);
    }
  });
});
