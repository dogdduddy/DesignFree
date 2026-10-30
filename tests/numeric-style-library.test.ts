import { describe, expect, it } from "vitest";
import { createNode, DocumentHistory, validateDocument } from "../src/core";
import { newDocument } from "../src/documents";
import { computeLayout } from "../src/flex-layout";
import { layoutTransformBlocked } from "../src/layout-editing";
import {
  makeComponent,
  createInstance,
  reconcileComponents,
} from "../src/components";
import {
  bindStyle,
  resolveDocumentStyles,
  setStyleLibrary,
  switchTheme,
  validateStyleLibrary,
  type StyleLibrary,
  type StyleKind,
} from "../src/style-library";
import {
  diagnoseStyleLibrary,
  inspectStyleRelationships,
} from "../src/style-library-inspection";

function library(): StyleLibrary {
  return {
    tokens: {
      unit: { kind: "spacing", name: "Unit", value: 8 },
      alias: { kind: "spacing", name: "Alias", value: { ref: "unit" } },
      size: { kind: "number", name: "Size", value: 100 },
      round: { kind: "radius", name: "Round", value: 12 },
    },
    styles: {
      space: { kind: "spacing", name: "Space", value: { ref: "alias" } },
      size: { kind: "number", name: "Size", value: { ref: "size" } },
      round: { kind: "radius", name: "Round", value: { ref: "round" } },
    },
    themes: {
      roomy: { name: "Roomy", values: { unit: 20, size: 160, round: 30 } },
    },
  };
}
function fixture() {
  const doc = newDocument();
  doc.nodes.frame = createNode("frame", doc.rootId, {
    id: "frame",
    children: ["box"],
    width: 250,
    height: 200,
    layout: { mode: "flex", gap: 3, padding: [1, 2, 3, 4] },
  });
  doc.nodes.box = createNode("rectangle", "frame", {
    id: "box",
    width: 44,
    height: 55,
    radius: 2,
  });
  doc.nodes[doc.rootId].children = ["frame"];
  return setStyleLibrary(doc, library());
}
function bound() {
  let doc = fixture();
  doc = bindStyle(
    bindStyle(doc, "frame", "gap", "space"),
    "frame",
    "padding",
    "space",
  );
  for (const field of ["width", "height", "radius"] as const)
    doc = bindStyle(doc, "box", field, field === "radius" ? "round" : "size");
  return doc;
}

describe("D03 typed numeric tokens", () => {
  it("blocks free transforms when resolved dimensions differ from source geometry", () => {
    const doc = bound();
    expect(layoutTransformBlocked(doc, ["box"])).toBe(true);
    const detached = bindStyle(bindStyle(doc, "box", "width"), "box", "height");
    detached.nodes.frame.layout.mode = "absolute";
    expect(layoutTransformBlocked(detached, ["box"])).toBe(false);
  });
  it("resolves aliases and themes into layout while preserving authored fallbacks and serialization", () => {
    const doc = bound(),
      before = JSON.stringify(doc);
    const normal = computeLayout(doc),
      roomyDoc = switchTheme(doc, "roomy"),
      roomy = computeLayout(roomyDoc);
    expect(normal.nodes.frame.layout).toMatchObject({
      gap: 8,
      padding: [8, 8, 8, 8],
    });
    expect(normal.nodes.box).toMatchObject({
      width: 100,
      height: 100,
      radius: 12,
    });
    expect(roomy.nodes.box).toMatchObject({
      width: 160,
      height: 160,
      radius: 30,
    });
    expect(roomy.nodes.box.transform[4]).toBe(20);
    expect(roomy.nodes.box.transform[5]).toBe(20);
    expect(doc.nodes.box).toMatchObject({ width: 44, height: 55, radius: 2 });
    expect(doc.nodes.frame.layout).toMatchObject({
      gap: 3,
      padding: [1, 2, 3, 4],
    });
    expect(JSON.stringify(doc)).toBe(before);
    const imported = JSON.parse(JSON.stringify(roomyDoc));
    expect(() => validateDocument(imported)).not.toThrow();
    expect(computeLayout(imported)).toEqual(roomy);
  });
  it("detaches each numeric property at the current resolved value without changing sizing rules", () => {
    let doc = switchTheme(bound(), "roomy");
    doc.nodes.box.layout.width = "fill";
    for (const [id, fields] of [
      ["frame", ["gap", "padding"]],
      ["box", ["width", "height", "radius"]],
    ] as const)
      for (const field of fields) doc = bindStyle(doc, id, field);
    expect(doc.nodes.frame.layout).toMatchObject({
      gap: 20,
      padding: [20, 20, 20, 20],
    });
    expect(doc.nodes.box).toMatchObject({
      width: 160,
      height: 160,
      radius: 30,
      layout: { width: "fill" },
    });
    expect(doc.nodes.frame.styleRefs).toBeUndefined();
    expect(doc.nodes.box.styleRefs).toBeUndefined();
    expect(resolveDocumentStyles(switchTheme(doc)).nodes).toEqual(
      resolveDocumentStyles(doc).nodes,
    );
  });
  it("keeps bindings and library no-ops outside history and supports undo/redo", () => {
    const doc = bound(),
      history = new DocumentHistory(doc);
    expect(bindStyle(doc, "box", "width", "size")).toBe(doc);
    expect(bindStyle(doc, "frame", "radius")).toBe(doc);
    expect(setStyleLibrary(doc, library())).toBe(doc);
    history.execute(switchTheme(history.document, "roomy"));
    expect(history.statistics.undoEntries).toBe(1);
    history.undo();
    expect(computeLayout(history.document).nodes.box.width).toBe(100);
    history.redo();
    expect(computeLayout(history.document).nodes.box.width).toBe(160);
  });
  it.each(["number", "spacing", "radius"] as StyleKind[])(
    "rejects malformed %s literals including dormant theme values",
    (kind) => {
      for (const value of [-1, NaN, Infinity, 1e7 + 1, "8", null, {}, [8]]) {
        const l = library();
        l.tokens.probe = { kind, name: "Probe", value } as never;
        expect(() => validateStyleLibrary(l)).toThrow();
      }
      const l = library();
      l.tokens.probe = { kind, name: "Probe", value: 0 } as never;
      l.themes.roomy.values.probe = -1;
      expect(() => validateStyleLibrary(l)).toThrow();
    },
  );
  it("rejects cross-kind aliases, cycles, invalid binding keys and incompatible bindings", () => {
    const l = library();
    l.tokens.alias.value = { ref: "size" };
    expect(() => validateStyleLibrary(l)).toThrow();
    l.tokens.alias.value = { ref: "unit" };
    l.themes.roomy.values.unit = { ref: "alias" };
    expect(() => validateStyleLibrary(l)).toThrow();
    for (const [field, style] of [
      ["width", "space"],
      ["gap", "round"],
      ["padding", "round"],
      ["radius", "space"],
      ["number", "size"],
    ])
      expect(() =>
        bindStyle(fixture(), "box", field as never, style),
      ).toThrow();
    const generic = bindStyle(
      bindStyle(fixture(), "box", "radius", "size"),
      "frame",
      "padding",
      "size",
    );
    expect(resolveDocumentStyles(generic).nodes.frame.layout.padding).toEqual([
      100, 100, 100, 100,
    ]);
  });
  it("preserves inherited bindings and local overrides through component reconciliation", () => {
    const made = makeComponent(bound(), "frame");
    const instance = createInstance(made, "frame");
    const instanceRoot = instance.document.nodes[instance.id];
    const boxId =
      instanceRoot.component?.kind === "instance"
        ? instanceRoot.component.nodeMap.box
        : "";
    expect(resolveDocumentStyles(instance.document).nodes[boxId].radius).toBe(
      12,
    );
    const edited = bindStyle(instance.document, boxId, "radius", "size");
    const synced = reconcileComponents(edited, instance.document);
    expect(resolveDocumentStyles(synced).nodes[boxId].radius).toBe(100);
    const afterTheme = switchTheme(synced, "roomy");
    expect(resolveDocumentStyles(afterTheme).nodes[boxId].radius).toBe(160);
    expect(resolveDocumentStyles(afterTheme).nodes.box.radius).toBe(30);
    expect(() => validateDocument(afterTheme)).not.toThrow();
  });
  it("explains numeric chains and reports binding compatibility with accurate layer paths", () => {
    const doc = bound();
    expect(diagnoseStyleLibrary(doc.styleLibrary, doc)).toEqual([]);
    const relation = inspectStyleRelationships(doc).tokens.find(
      (entry) => entry.id === "unit",
    )!;
    expect(relation.chains[0].value).toBe(8);
    expect(relation.linkedLayers.map((link) => link.path)).toContain(
      "nodes.frame.styleRefs.padding",
    );
    const invalid = structuredClone(doc.styleLibrary!);
    invalid.styles.space = { kind: "radius", name: "Wrong", value: 8 };
    expect(
      diagnoseStyleLibrary(invalid, doc).some(
        (d) => d.path === "nodes.frame.styleRefs.gap",
      ),
    ).toBe(true);
  });
});
