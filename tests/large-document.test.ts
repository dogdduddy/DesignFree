import { describe, it, expect } from "vitest";
import {
  DocumentHistory,
  createBenchmarkDocument,
  createNode,
  updateNodes,
  type SceneDocument,
} from "../src/core";
import { layerRows, layerWindow } from "../src/layer-window";
import { culledClips, clippedOutside } from "../src/renderers/visibility";
import { sceneMarkup } from "../src/renderers/svg";

describe("bounded reversible history", () => {
  it("restores added/deleted nodes, assets, hierarchy and metadata exactly", () => {
    const original = createBenchmarkDocument(1000),
      h = new DocumentHistory(original);
    const next = structuredClone(original),
      id = next.nodes.page.children[0];
    const remove = (id: string) => {
      next.nodes[id].children.forEach(remove);
      delete next.nodes[id];
    };
    remove(id);
    next.nodes.page.children.shift();
    next.nodes.added = createNode("image", "page", {
      id: "added",
      assetId: "new",
    });
    next.nodes.page.children.push("added");
    next.assets.new = { ...next.assets.pattern, id: "new" };
    delete next.assets.pattern;
    // Replace remaining image references atomically along with asset deletion.
    for (const node of Object.values(next.nodes))
      if (node.assetId) node.assetId = "new";
    next.name = "Replaced";
    next.id = "new-document";
    h.execute(next);
    const committed = h.document;
    next.assets.new.dataUrl = "mutated";
    next.nodes.added.name = "mutated";
    h.undo();
    expect(h.document).toEqual(original);
    h.redo();
    expect(h.document).toEqual(committed);
    const detached = h.document;
    detached.nodes.added.width = 999;
    h.undo();
    h.redo();
    expect(h.document).toEqual(committed);
  });
  it("keeps only changed node payloads across 100 small edits of a 10000-node document", () => {
    const h = new DocumentHistory(createBenchmarkDocument(10000));
    for (let i = 0; i < 101; i++)
      h.execute(updateNodes(h.document, { "bench-2": { name: `Edit ${i}` } }));
    expect(h.statistics.undoEntries).toBe(100);
    expect(h.statistics.retainedPatchBytes).toBeLessThan(200_000);
    for (let i = 0; i < 100; i++) h.undo();
    expect(h.document.nodes["bench-2"].name).toBe("Edit 0");
    expect(h.canUndo).toBe(false);
    expect(h.statistics.redoEntries).toBe(100);
    for (let i = 0; i < 100; i++) h.redo();
    expect(h.document.nodes["bench-2"].name).toBe("Edit 100");
  }, 30_000);
  it("evicts oldest entries for a byte budget and clears history for an oversized edit", () => {
    const doc = createBenchmarkDocument(100),
      probe = new DocumentHistory(doc);
    probe.execute(updateNodes(doc, { "bench-2": { name: "one" } }));
    const bytes = probe.statistics.retainedPatchBytes;
    const h = new DocumentHistory(doc, bytes + 10);
    h.execute(updateNodes(doc, { "bench-2": { name: "one" } }));
    h.execute(updateNodes(h.document, { "bench-2": { name: "two" } }));
    expect(h.statistics.undoEntries).toBe(1);
    h.undo();
    expect(h.document.nodes["bench-2"].name).toBe("one");
    expect(h.statistics.retainedPatchBytes).toBeLessThanOrEqual(bytes + 10);
    h.execute(
      updateNodes(h.document, { "bench-2": { name: "x".repeat(5000) } }),
    );
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.document.nodes["bench-2"].name.length).toBe(5000);
  });
  it("retains redo for a net-zero gesture and cancels preview before undo", () => {
    const d = createBenchmarkDocument(100),
      h = new DocumentHistory(d);
    h.execute(updateNodes(d, { "bench-2": { width: 100 } }));
    h.undo();
    h.beginTransaction();
    h.preview(updateNodes(d, { "bench-2": { width: 500 } }));
    h.preview(d);
    h.commitTransaction();
    expect(h.canRedo).toBe(true);
    h.redo();
    h.beginTransaction();
    h.preview(updateNodes(h.document, { "bench-2": { width: 900 } }));
    h.undo();
    expect(h.document).toEqual(d);
    expect(h.statistics.redoEntries).toBe(1);
  });
});
describe("conservative clip culling and layer windows", () => {
  it("prunes offscreen clipped ancestors, never unclipped/text overflow; export remains whole", () => {
    const d = createBenchmarkDocument(1000);
    const off = d.nodes[d.nodes.page.children.at(-1)!];
    off.transform = [1, 0.2, 0.3, 1, 5000, 5000];
    const viewport = { x: 0, y: 0, zoom: 1 };
    const excluded = culledClips(d, viewport, 1024, 768);
    expect(excluded.has(off.id)).toBe(true);
    expect(sceneMarkup(d, excluded).length).toBeLessThan(sceneMarkup(d).length);
    off.clipContent = false;
    expect(culledClips(d, viewport, 1024, 768).has(off.id)).toBe(false);
    off.type = "text";
    off.clipContent = true;
    expect(clippedOutside(off, off.transform, 1024, 768)).toBe(false);
  });
  it("keeps affine stroke/antialias margins and includes a frame when pan reveals it", () => {
    const d = createBenchmarkDocument(100),
      n = d.nodes["bench-1"];
    n.width = 10;
    n.height = 10;
    n.stroke = { color: "#000000", width: 20, position: "outside" };
    n.transform = [2, 1, 0.5, 2, -42, 100];
    expect(clippedOutside(n, n.transform, 1024, 768)).toBe(false);
    n.transform = [1, 0, 0, 1, 2000, 100];
    expect(culledClips(d, { x: 0, y: 0, zoom: 1 }, 1024, 768).has(n.id)).toBe(
      true,
    );
    expect(
      culledClips(d, { x: -1500, y: 0, zoom: 1 }, 1024, 768).has(n.id),
    ).toBe(false);
  });
  it("flattens hierarchy in paint order, respects collapse and bounds row count at end", () => {
    const d = createBenchmarkDocument(10000),
      rows = layerRows(d, new Set());
    expect(rows).toHaveLength(9999);
    expect(rows[0]).toEqual({ id: "bench-1", depth: 0 });
    expect(rows[1]).toEqual({ id: "bench-2", depth: 1 });
    expect(layerRows(d, new Set(["bench-1"]))).toHaveLength(9975);
    const range = layerWindow(rows.length, 33000, 660);
    expect(range.end - range.start).toBe(36);
    const end = layerWindow(rows.length, 1e9, 660);
    expect(end.end).toBe(rows.length);
    expect(end.end - end.start).toBe(28);
    expect(layerWindow(100, 0, 100)).toEqual({ start: 0, end: 100 });
  });
});
