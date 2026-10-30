import { describe, it, expect } from "vitest";
import {
  createNode,
  DocumentHistory,
  duplicateNodes,
  updateNodes,
  validateDocument,
  type SceneDocument,
} from "../src/core";
import { createInstance, makeComponent } from "../src/components";
import { migratePages } from "../src/documents";
import {
  hotspots,
  previewTarget,
  pruneInteractions,
  screenOf,
  screens,
  startScreen,
  validInteractions,
  type Interaction,
} from "../src/prototype";
import { exportSvg } from "../src/renderers/svg";

const link = (destinationId: string, transition: Interaction["action"]["transition"] = { type: "instant" }): Interaction[] => [
  { trigger: "click", action: { type: "navigate", destinationId, transition } },
];
function fixture(): SceneDocument {
  const page = createNode("page", null, { id: "page", width: 1000, height: 800, children: ["a", "b", "loose"] });
  const a = createNode("frame", "page", { id: "a", name: "A", width: 200, height: 300, clipContent: true, children: ["group", "hidden"] });
  const group = createNode("group", "a", { id: "group", transform: [1, 0, 0, 1, 20, 20], width: 100, height: 40, children: ["label"], interactions: link("b", { type: "dissolve", duration: 300 }) });
  const label = createNode("rectangle", "group", { id: "label", width: 100, height: 40 });
  const hidden = createNode("rectangle", "a", { id: "hidden", transform: [1, 0, 0, 1, 20, 100], visible: false, interactions: link("b") });
  const b = createNode("frame", "page", { id: "b", name: "B", transform: [1, 0, 0, 1, 300, 0], width: 200, height: 300, children: ["out"] });
  const out = createNode("rectangle", "b", { id: "out", transform: [1, 0, 0, 1, 250, 0], width: 50, height: 50, interactions: link("a") });
  const loose = createNode("rectangle", "page", { id: "loose", transform: [1, 0, 0, 1, 600, 0] });
  return { schemaVersion: 1, id: "doc", name: "doc", rootId: "page", nodes: { page, a, group, label, hidden, b, out, loose }, assets: {} };
}

describe("prototype link model", () => {
  it("accepts click/navigate with instant or bounded dissolve only", () => {
    expect(validInteractions(link("x"))).toBe(true);
    expect(validInteractions(link("x", { type: "dissolve", duration: 300 }))).toBe(true);
    for (const bad of [
      [{ trigger: "hover", action: { type: "navigate", destinationId: "x", transition: { type: "instant" } } }],
      [{ trigger: "click", action: { type: "url", destinationId: "x", transition: { type: "instant" } } }],
      [{ trigger: "click", action: { type: "navigate", destinationId: "", transition: { type: "instant" } } }],
      link("x", { type: "dissolve", duration: -1 }),
      link("x", { type: "dissolve", duration: 20000 }),
      [{ trigger: "click", action: { type: "navigate", destinationId: "x", transition: { type: "instant", duration: 1 } } }],
      [{ ...link("x")[0], extra: 1 }],
      Array(9).fill(link("x")[0]),
      {},
    ])
      expect(validInteractions(bad)).toBe(false);
    const doc = fixture();
    expect(() => validateDocument(doc)).not.toThrow();
    doc.nodes.loose.prototypeStartId = "a";
    expect(() => validateDocument(doc)).toThrow();
    const pageLink = fixture();
    pageLink.nodes.page.interactions = link("a");
    expect(() => validateDocument(pageLink)).toThrow();
  });
  it("finds screens, the screen of a layer and the start screen", () => {
    const doc = fixture();
    expect(screens(doc).map((s) => s.id)).toEqual(["a", "b"]);
    expect(screenOf(doc, "label")).toBe("a");
    expect(screenOf(doc, "loose")).toBeNull();
    expect(startScreen(doc)).toBe("a");
    expect(startScreen(doc, ["out"])).toBe("b");
    doc.nodes.page.prototypeStartId = "b";
    expect(startScreen(doc, ["label"])).toBe("b");
  });
  it("prunes links and start screens that stop pointing at a screen of the page", () => {
    const doc = fixture();
    expect(pruneInteractions(doc)).toBe(doc);
    // Deleting B drops links to it and the start screen; A's link survives.
    const deleted = structuredClone(doc);
    deleted.nodes.page.prototypeStartId = "b";
    delete deleted.nodes.b;
    delete deleted.nodes.out;
    deleted.nodes.page.children = ["a", "loose"];
    const pruned = pruneInteractions(deleted);
    expect(pruned.nodes.group.interactions).toBeUndefined();
    expect(pruned.nodes.page.prototypeStartId).toBeUndefined();
    expect(deleted.nodes.group.interactions).toBeDefined();
    // Nesting B inside A stops it being a screen.
    const nested = structuredClone(doc);
    nested.nodes.b.parentId = "a";
    nested.nodes.a.children.push("b");
    nested.nodes.page.children = ["a", "loose"];
    expect(pruneInteractions(nested).nodes.group.interactions).toBeUndefined();
    // A screen on another page is not a valid destination.
    const paged = migratePages(structuredClone(doc));
    const other = createNode("page", null, { id: "page2", children: ["c"] });
    const c = createNode("frame", "page2", { id: "c" });
    paged.nodes.page2 = other;
    paged.nodes.c = c;
    paged.pageIds!.push("page2");
    paged.nodes.out.interactions = link("c");
    expect(pruneInteractions(paged).nodes.out.interactions).toBeUndefined();
    // A linked layer moved out of every screen loses its link.
    const loose = structuredClone(doc);
    loose.nodes.group.parentId = "page";
    loose.nodes.a.children = ["hidden"];
    loose.nodes.page.children.push("group");
    expect(pruneInteractions(loose).nodes.group.interactions).toBeUndefined();
    // Pruning is idempotent when one node needs both cleanups.
    const both = structuredClone(deleted);
    both.nodes.group.interactions = link("b");
    const once = pruneInteractions(both);
    expect(pruneInteractions(once)).toBe(once);
  });
  it("remaps links between duplicated screens and keeps others", () => {
    const doc = fixture();
    const pair = duplicateNodes(doc, ["a", "b"]).document;
    const [aCopy, bCopy] = pair.nodes.page.children.slice(-2);
    const groupCopy = pair.nodes[pair.nodes[aCopy].children[0]];
    expect(groupCopy.interactions![0].action.destinationId).toBe(bCopy);
    expect(pair.nodes[pair.nodes[bCopy].children[0]].interactions![0].action.destinationId).toBe(aCopy);
    const single = duplicateNodes(doc, ["a"]).document;
    const only = single.nodes[single.nodes[single.nodes.page.children.at(-1)!].children[0]];
    expect(only.interactions![0].action.destinationId).toBe("b");
  });
  it("prunes inside the same history commit as the deletion", () => {
    const h = new DocumentHistory(fixture());
    const next = h.document;
    delete next.nodes.b;
    delete next.nodes.out;
    next.nodes.page.children = ["a", "loose"];
    h.execute(next);
    expect(h.document.nodes.group.interactions).toBeUndefined();
    h.undo();
    expect(h.document.nodes.group.interactions).toEqual(link("b", { type: "dissolve", duration: 300 }));
    expect(h.statistics.undoEntries).toBe(0);
  });
  it("targets the deepest visible layer and bubbles to the nearest link", () => {
    const doc = fixture();
    expect(previewTarget(doc, "a", { x: 30, y: 30 })?.id).toBe("group");
    expect(previewTarget(doc, "a", { x: 30, y: 105 })).toBeNull(); // hidden layer
    expect(previewTarget(doc, "a", { x: 5, y: 5 })).toBeNull();
    // Content clipped by its screen cannot be clicked.
    expect(previewTarget(doc, "b", { x: 260, y: 10 })).toBeNull();
    doc.nodes.b.clipContent = true;
    expect(previewTarget(doc, "b", { x: 199, y: 10 })).toBeNull();
    doc.nodes.out.transform = [1, 0, 0, 1, 150, 0];
    expect(previewTarget(doc, "b", { x: 160, y: 10 })?.interaction.action.destinationId).toBe("a");
    // Locks do not apply in preview.
    doc.nodes.out.locked = true;
    expect(previewTarget(doc, "b", { x: 160, y: 10 })?.id).toBe("out");
    expect(hotspots(doc, "a")).toEqual([{ id: "group", x: 20, y: 20, width: 100, height: 40 }]);
    // A link to the screen being shown is not a hotspot.
    doc.nodes.group.interactions = link("a");
    expect(previewTarget(doc, "a", { x: 30, y: 30 })).toBeNull();
    expect(hotspots(doc, "a")).toEqual([]);
  });
  it("lets instances override links and keeps them out of exports", () => {
    let doc = fixture();
    doc = makeComponent(doc, "group");
    const { document } = createInstance(doc, "group", "b");
    const h = new DocumentHistory(document);
    const instance = Object.values(h.document.nodes).find((n) => n.component?.kind === "instance")!;
    expect(instance.interactions).toEqual(link("b", { type: "dissolve", duration: 300 }));
    h.execute(updateNodes(h.document, { [instance.id]: { interactions: link("a") } }));
    const overridden = h.document.nodes[instance.id];
    expect(overridden.interactions).toEqual(link("a"));
    expect(overridden.component?.kind === "instance" && overridden.component.overrides.group?.interactions).toEqual(link("a"));
    expect(exportSvg(h.document)).not.toContain("navigate");
  });
});
