import { describe, it, expect } from "vitest";
import {
  createNode,
  getWorldTransform,
  groupNodes,
  ungroupNodes,
  DocumentHistory,
} from "../src/core";
import type { SceneDocument } from "../src/core";
import {
  layoutTransformBlocked,
  layoutGroupBlocked,
  layoutReparentReason,
} from "../src/layout-editing";
import { moveLayers } from "../src/layers";
import { copySelection, pasteSelection } from "../src/clipboard";
import { computeLayout } from "../src/flex-layout";
import {
  resizeSelection,
  transformFrame,
  rotateSelection,
} from "../src/transforms";

function fixture(mode: "flex" | "grid"): SceneDocument {
  return {
    schemaVersion: 1,
    id: "layout-edit",
    name: "Layout edit",
    rootId: "p",
    assets: {},
    nodes: {
      p: createNode("page", null, { id: "p", children: ["f", "g"] }),
      f: createNode("frame", "p", {
        id: "f",
        width: 400,
        height: 240,
        transform: [1, 0.2, 0.1, 1, 50, 60],
        children: ["a", "b"],
        layout: {
          mode,
          gap: 10,
          padding: [10, 10, 10, 10],
          grid: { columns: [{ fr: 1 }, { fr: 1 }] },
        },
      }),
      g: createNode("frame", "p", {
        id: "g",
        transform: [1, 0.1, 0, 1, 500, 20],
      }),
      a: createNode("rectangle", "f", {
        id: "a",
        width: 50,
        height: 30,
        transform: [1, 0.2, 0, 1, 77, 88],
        layout: {
          mode: "absolute",
          width: "fill",
          minWidth: 15,
          grid: { column: 2, columnSpan: 2 },
        },
      }),
      b: createNode("rectangle", "f", {
        id: "b",
        width: 60,
        height: 40,
        transform: [1, 0, 0, 1, 180, 100],
      }),
    },
  };
}

describe.each(["flex", "grid"] as const)("%s authoring edits", (mode) => {
  it("copies a fill child and a full container without baking computed geometry", () => {
    const doc = fixture(mode),
      before = structuredClone(doc);
    const json = copySelection(doc, ["a"])!.json;
    const payload = JSON.parse(json);
    expect(payload.document.nodes.a.width).toBe(50);
    expect(payload.document.nodes.a.layout).toEqual(doc.nodes.a.layout);
    const pasted = pasteSelection(doc, json, []);
    expect(pasted.document.nodes[pasted.ids[0]]).toMatchObject({
      parentId: "f",
      transform: doc.nodes.a.transform,
      width: 50,
      layout: doc.nodes.a.layout,
    });
    const nested = pasteSelection(doc, copySelection(doc, ["f"])!.json, ["g"]);
    const f = nested.document.nodes[nested.ids[0]];
    expect(f.layout).toEqual(doc.nodes.f.layout);
    expect(nested.document.nodes[f.children[0]].layout).toEqual(
      doc.nodes.a.layout,
    );
    expect(nested.document.nodes[f.children[0]].transform).toEqual(
      doc.nodes.a.transform,
    );
    expect(doc).toEqual(before);
    const h = new DocumentHistory(doc);
    h.execute(pasted.document);
    h.undo();
    expect(h.document).toEqual(doc);
    expect(h.canUndo).toBe(false);
    h.redo();
    expect(h.document).toEqual(pasted.document);
  });
  it("uses computed ancestor allocation for the SVG only", () => {
    const doc = fixture(mode);
    const computed = computeLayout(doc).nodes.a;
    expect(computed.width).not.toBe(doc.nodes.a.width);
    const copy = copySelection(doc, ["a"])!;
    expect(copy.svg).toContain(`width="${computed.width}"`);
    expect(JSON.parse(copy.json).document.nodes.a.width).toBe(50);
  });
  it("moves into and out of flow using authored local fallbacks and one history step", () => {
    const doc = fixture(mode),
      h = new DocumentHistory(doc);
    const next = moveLayers(doc, ["a"], "g");
    expect(next.nodes.a).toEqual({ ...doc.nodes.a, parentId: "g" });
    h.execute(next);
    h.undo();
    expect(h.document).toEqual(doc);
    expect(h.canUndo).toBe(false);
    const restored = moveLayers(next, ["a"], "f", 0);
    expect(restored.nodes.a).toEqual(doc.nodes.a);
    expect(moveLayers(doc, ["a"], "f", 1)).toBe(doc);
    const absolute = structuredClone(next);
    absolute.nodes.a.layout.position = "absolute";
    const inserted = moveLayers(absolute, ["a"], "f");
    expect(inserted.nodes.a.layout).toEqual({
      ...doc.nodes.a.layout,
      position: "flow",
    });
    expect(inserted.nodes.a.transform).toEqual(doc.nodes.a.transform);
    expect(moveLayers(doc, ["f"], "a")).toBe(doc);
  });
  it("allows fixed outer container transforms and grouping without rewriting descendants", () => {
    const doc = fixture(mode);
    expect(layoutTransformBlocked(doc, ["f"])).toBe(false);
    expect(layoutGroupBlocked(doc, ["f"])).toBe(false);
    const frame = transformFrame(doc, ["f"])!;
    const resized = resizeSelection(doc, frame, {
      x: 0,
      y: 0,
      width: 500,
      height: 300,
    });
    expect(resized.nodes.a).toEqual(doc.nodes.a);
    expect(resized.nodes.f.layout).toEqual(doc.nodes.f.layout);
    const rotated = rotateSelection(doc, frame, 30);
    expect(rotated.nodes.a).toEqual(doc.nodes.a);
    const grouped = groupNodes(doc, ["f"]);
    expect(grouped.document.nodes.a).toEqual(doc.nodes.a);
    expect(grouped.document.nodes.f.layout).toEqual(doc.nodes.f.layout);
    expect(ungroupNodes(grouped.document, grouped.ids).document).toEqual(doc);
  });
  it("blocks flow transforms/groups but unlocks fixed absolute children", () => {
    const doc = fixture(mode);
    expect(layoutTransformBlocked(doc, ["b"])).toBe(true);
    doc.nodes.b.layout.position = "absolute";
    expect(layoutTransformBlocked(doc, ["b"])).toBe(false);
    expect(layoutGroupBlocked(doc, ["b"])).toBe(true);
    doc.nodes.f.layout.width = "hug";
    expect(layoutTransformBlocked(doc, ["b"])).toBe(true);
  });
});

it("reparents an absolute child through nested flow ancestors using computed axes only", () => {
  const doc = fixture("flex");
  doc.nodes.outer = createNode("frame", "p", {
    id: "outer",
    width: 600,
    height: 400,
    children: ["f"],
    layout: { mode: "flex" },
    transform: [1, 0.1, 0.2, 1, 20, 30],
  });
  doc.nodes.p.children = ["outer", "g"];
  doc.nodes.f.parentId = "outer";
  doc.nodes.f.transform = [1, 0, 0, 1, 400, 100];
  doc.nodes.b.layout.position = "absolute";
  const before = computeLayout(doc);
  const moved = moveLayers(doc, ["b"], "g");
  const after = computeLayout(moved);
  getWorldTransform(after, "b").forEach((v, i) =>
    expect(v).toBeCloseTo(getWorldTransform(before, "b")[i]),
  );
  expect(moved.nodes.b.layout).toEqual(doc.nodes.b.layout);
  expect(moved.nodes.b.width).toBe(doc.nodes.b.width);
  expect(moved.nodes.f).toEqual({ ...doc.nodes.f, children: ["a"] });
});

it("copies computed text wrapping into SVG only, retaining auto-width authoring in JSON", () => {
  const doc = fixture("flex");
  doc.nodes.f.width = 40;
  doc.nodes.f.layout.padding = [0, 0, 0, 0];
  doc.nodes.f.children = ["a"];
  delete doc.nodes.b;
  const text = createNode("text", "f", {
    id: "a",
    width: 100,
    height: 30,
    layout: { mode: "absolute", width: "fill" },
    text: {
      content: "abcdefghij",
      fontSize: 16,
      fontFamily: "sans-serif",
      fontWeight: 400,
      lineHeight: 1.2,
      sizing: "auto-width",
    },
  });
  doc.nodes.a = text;
  const copied = copySelection(doc, ["a"])!;
  expect(computeLayout(doc).nodes.a.text!.sizing).toBe("fixed");
  expect(copied.svg.match(/<tspan /g)!.length).toBeGreaterThan(1);
  expect(JSON.parse(copied.json).document.nodes.a.text.sizing).toBe(
    "auto-width",
  );
  expect(doc.nodes.a).toEqual(text);
});

it("rejects group-flow insertions and unsafe group-bound edits without touching other children", () => {
  const doc = fixture("flex");
  const grouped = groupNodes(doc, ["g"]);
  const groupId = grouped.ids[0];
  expect(moveLayers(grouped.document, [groupId], "f")).toBe(grouped.document);
  expect(layoutReparentReason(grouped.document, [groupId], "f")).toContain(
    "그룹",
  );
  expect(() =>
    pasteSelection(doc, copySelection(grouped.document, [groupId])!.json, [
      "f",
    ]),
  ).toThrow("그룹");
  // Imported group-flow structures cannot be extended or have children removed.
  const imported = structuredClone(grouped.document);
  imported.nodes.p.children = ["f"];
  imported.nodes.f.children.push(groupId);
  imported.nodes[groupId].parentId = "f";
  expect(moveLayers(imported, ["b"], groupId)).toBe(imported);
  expect(moveLayers(imported, ["g"], "p")).toBe(imported);
  expect(() =>
    pasteSelection(imported, copySelection(doc, ["b"])!.json, ["g"]),
  ).toThrow("그룹");
  // A direct group destination rejects derived children even outside flow.
  expect(moveLayers(grouped.document, ["a"], groupId)).toBe(grouped.document);
});
