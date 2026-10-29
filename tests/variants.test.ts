import { describe, it, expect } from "vitest";
import {
  createNode,
  DocumentHistory,
  updateNodes,
  serializeDocument,
  parseDocument,
  duplicateNodes,
  validateDocument,
} from "../src/core";
import { newDocument } from "../src/documents";
import {
  variantMembers,
  type Variant,
  makeComponent,
  createInstance,
  switchVariant,
  setVariantProperties,
  resetInstanceOverrides,
  type Instance,
} from "../src/components";
import { createVariant, editVariantSet } from "../src/variants";
function fixture() {
  const doc = newDocument();
  doc.nodes.main = createNode("frame", doc.rootId, {
    id: "main",
    children: ["label", "badge"],
    width: 200,
  });
  doc.nodes.label = createNode("text", "main", {
    id: "label",
    text: {
      content: "Default",
      fontFamily: "Noto Sans KR",
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 24,
    },
  });
  doc.nodes.badge = createNode("rectangle", "main", { id: "badge", width: 20 });
  doc.nodes[doc.rootId].children.push("main");
  const variant = createVariant(makeComponent(doc, "main"), "main");
  const instance = createInstance(variant.document, "main");
  return {
    h: new DocumentHistory(instance.document),
    id: instance.id,
    other: variant.id,
    label: variant.document.nodes[variant.id].children[0],
    badge: variant.document.nodes[variant.id].children[1],
  };
}
const link = (h: DocumentHistory, id: string) =>
  h.document.nodes[id].component as Instance;
describe("variants", () => {
  it("creates explicit keyed members and unique multidimensional property tuples", () => {
    const { h, other } = fixture();
    h.execute(
      setVariantProperties(h.document, other, {
        State: "Hover",
        Size: "Small",
      }),
    );
    expect(h.document.nodes.main.component).toMatchObject({
      variant: { properties: { State: "Default", Size: "Small" } },
    });
    expect(() =>
      setVariantProperties(h.document, other, {
        State: "Default",
        Size: "Small",
      }),
    ).toThrow();
    const next = createVariant(h.document, other);
    expect(next.document.nodes[next.id].component).toMatchObject({
      variant: { properties: { State: "Variant 2", Size: "Small" } },
    });
  });
  it("preserves leaf overrides, placement and shared materialized IDs through switch and history", () => {
    const { h, id, other, label } = fixture(),
      cid = link(h, id).nodeMap.label;
    h.execute(
      updateNodes(h.document, {
        [cid]: { text: { ...h.document.nodes[cid].text!, content: "Custom" } },
      }),
    );
    h.execute(
      updateNodes(h.document, {
        [label]: {
          text: {
            ...h.document.nodes[label].text!,
            content: "Hover",
            fontSize: 28,
          },
        },
      }),
    );
    const before = h.document;
    h.execute(switchVariant(h.document, id, other));
    expect(link(h, id).nodeMap[label]).toBe(cid);
    expect(h.document.nodes[cid].text).toMatchObject({
      content: "Custom",
      fontSize: 28,
    });
    expect(h.document.nodes[id].transform).toEqual(before.nodes[id].transform);
    const after = h.document;
    h.undo();
    expect(h.document).toEqual(before);
    h.redo();
    expect(h.document).toEqual(after);
    h.execute(switchVariant(h.document, id, "main"));
    expect(h.document.nodes[cid].text).toMatchObject({
      content: "Custom",
      fontSize: 16,
    });
  });
  it("retains absent-layer overrides through JSON reload and restores on return", () => {
    const { h, id, other, badge } = fixture(),
      bid = link(h, id).nodeMap.badge;
    h.execute(updateNodes(h.document, { [bid]: { width: 99 } }));
    const doc = h.document;
    delete doc.nodes[badge];
    doc.nodes[other].children = doc.nodes[other].children.filter(
      (x) => x !== badge,
    );
    h.execute(doc);
    h.execute(switchVariant(h.document, id, other));
    expect(h.document.nodes[bid]).toBeUndefined();
    const reloaded = new DocumentHistory(
      parseDocument(serializeDocument(h.document)),
    );
    reloaded.execute(switchVariant(reloaded.document, id, "main"));
    expect(
      reloaded.document.nodes[link(reloaded, id).nodeMap.badge].width,
    ).toBe(99);
  });
  it("captures edits on target and resets both active and dormant overrides", () => {
    const { h, id, other, label } = fixture();
    h.execute(switchVariant(h.document, id, other));
    const cid = link(h, id).nodeMap[label];
    h.execute(
      updateNodes(h.document, {
        [cid]: {
          text: { ...h.document.nodes[cid].text!, content: "New custom" },
        },
      }),
    );
    h.execute(switchVariant(h.document, id, "main"));
    expect(h.document.nodes[link(h, id).nodeMap.label].text!.content).toBe(
      "New custom",
    );
    h.execute(resetInstanceOverrides(h.document, id));
    h.execute(switchVariant(h.document, id, other));
    expect(h.document.nodes[link(h, id).nodeMap[label]].text!.content).toBe(
      "Default",
    );
  });
  it("keeps duplicate instances independent and ordinary main duplicates outside the set", () => {
    const { h, id, other } = fixture();
    h.execute(switchVariant(h.document, id, other));
    const copy = duplicateNodes(h.document, [id], { x: 24, y: 24 });
    h.execute(copy.document);
    expect(link(h, copy.ids[0]).sourceId).toBe(other);
    h.execute(switchVariant(h.document, copy.ids[0], "main"));
    expect(link(h, id).sourceId).toBe(other);
    const mainCopy = duplicateNodes(h.document, ["main"]);
    expect(mainCopy.document.nodes[mainCopy.ids[0]].component).toEqual({
      kind: "main",
    });
    expect(() => switchVariant(h.document, id, mainCopy.ids[0])).toThrow();
  });
  it("does not match duplicate names or newly introduced unrelated layers", () => {
    const { h, id, other, label } = fixture();
    const cid = link(h, id).nodeMap.label;
    h.execute(updateNodes(h.document, { [cid]: { name: "same", width: 123 } }));
    const d = h.document;
    d.nodes[label].name = "renamed";
    d.nodes.extra = createNode("text", other, {
      id: "extra",
      name: "same",
      text: { ...d.nodes[label].text! },
      width: 77,
    });
    d.nodes[other].children.unshift("extra");
    h.execute(d);
    h.execute(switchVariant(h.document, id, other));
    expect(h.document.nodes[link(h, id).nodeMap[label]].width).toBe(123);
    expect(h.document.nodes[link(h, id).nodeMap.extra].width).toBe(77);
  });
  it("rejects invalid property tuples and unsafe dormant override paths", () => {
    const { h, id, other } = fixture();
    expect(() => setVariantProperties(h.document, other, {})).toThrow();
    const d = h.document;
    (d.nodes[id].component as Instance).variantOverrides = {
      x: { paths: { "text.__proto__.x": "oops" } },
    };
    expect(() => validateDocument(d)).toThrow();
    const bad = h.document;
    const main = bad.nodes.main.component;
    if (main?.kind === "main")
      bad.nodes[other].component = structuredClone(main);
    expect(() => validateDocument(bad)).toThrow();
  });
  it("preserves partial stroke overrides when target omits source stroke", () => {
    const { h, id, other } = fixture();
    h.execute(
      updateNodes(h.document, {
        badge: { stroke: { color: "#ff0000", width: 2 } },
      }),
    );
    const bid = link(h, id).nodeMap.badge;
    h.execute(
      updateNodes(h.document, {
        [bid]: { stroke: { color: "#ff0000", width: 7 } },
      }),
    );
    h.execute(switchVariant(h.document, id, other));
    const targetBadge = h.document.nodes[other].children[1];
    expect(h.document.nodes[link(h, id).nodeMap[targetBadge]].stroke).toEqual({
      color: "#ff0000",
      width: 7,
    });
  });
  it("keeps independent dormant edits for each type of a changed layer role", () => {
    const { h, id, other, badge } = fixture();
    const d = h.document;
    d.nodes[badge] = createNode("text", other, { id: badge, width: 50 });
    h.execute(d);
    const bid = link(h, id).nodeMap.badge;
    h.execute(updateNodes(h.document, { [bid]: { width: 99 } }));
    h.execute(switchVariant(h.document, id, other));
    const tid = link(h, id).nodeMap[badge];
    expect(h.document.nodes[tid].width).toBe(50);
    h.execute(updateNodes(h.document, { [tid]: { width: 222 } }));
    h.execute(switchVariant(h.document, id, "main"));
    expect(h.document.nodes[link(h, id).nodeMap.badge].width).toBe(99);
    h.execute(switchVariant(h.document, id, other));
    expect(h.document.nodes[link(h, id).nodeMap[badge]].width).toBe(222);
  });
});

describe("visual variant set transactions", () => {
  const rowsOf = (d: import("../src/core").SceneDocument, source = "main") =>
    variantMembers(d, source).map((n) => ({
      id: n.id,
      name: n.name,
      values: Object.values(
        (n.component as { variant: Variant }).variant.properties,
      ),
    }));
  it("renames schema and states without replacing semantic keys or active/dormant overrides", () => {
    const { h, id, other } = fixture();
    const child = link(h, id).nodeMap.label;
    h.execute(
      updateNodes(h.document, {
        [child]: {
          text: { ...h.document.nodes[child].text!, content: "Custom text" },
        },
      }),
    );
    h.execute(switchVariant(h.document, id, other));
    const priorEntries = h.statistics.undoEntries;
    const before = h.document;
    expect(
      (before.nodes[id].component as Instance).variantOverrides,
    ).toBeDefined();
    const rows = rowsOf(before).map((r, i) => ({
      ...r,
      name: `State ${i}`,
      values: [i ? "Hover" : "Default", "Small"],
    }));
    h.execute(editVariantSet(before, "main", ["Interaction", "Size"], rows));
    expect(link(h, id)).toEqual(before.nodes[id].component);
    expect(
      (h.document.nodes[other].component as { variant: Variant }).variant.keys,
    ).toEqual(
      (before.nodes[other].component as { variant: Variant }).variant.keys,
    );
    expect(h.statistics.undoEntries).toBe(priorEntries + 1);
    h.undo();
    expect(h.document).toEqual(before);
    h.redo();
    expect(h.document.nodes[other].name).toBe("State 1");
  });
  it("rejects precise duplicate/invalid locations and locked members atomically", () => {
    const { h, other } = fixture(),
      d = h.document,
      rows = rowsOf(d);
    expect(() =>
      editVariantSet(
        d,
        "main",
        ["State"],
        rows.map((r) => ({ ...r, values: ["same"] })),
      ),
    ).toThrow(/상태 2.*상태 1/);
    expect(() => editVariantSet(d, "main", ["constructor"], rows)).toThrow(
      /축 1 이름/,
    );
    expect(() =>
      editVariantSet(
        d,
        "main",
        ["State"],
        rows.map((r) => ({ ...r, values: [""] })),
      ),
    ).toThrow(/상태 1 \/ 축 1/);
    d.nodes[other].locked = true;
    expect(() => editVariantSet(d, "main", ["Mode"], rows)).toThrow(
      /잠긴 원본/,
    );
    expect(h.statistics.undoEntries).toBe(0);
  });
  it("deletes a source with visible snapshot detachment and restores links in one undo", () => {
    const { h, id } = fixture(),
      before = h.document;
    h.execute(
      editVariantSet(
        before,
        "main",
        ["State"],
        rowsOf(before).filter((r) => r.id !== "main"),
      ),
    );
    expect(h.document.nodes.main).toBeUndefined();
    expect(h.document.nodes[id].component).toBeUndefined();
    expect(h.document.nodes[id].children).toEqual(before.nodes[id].children);
    h.undo();
    expect(h.document).toEqual(before);
  });
  it("keeps nested source rename/add/delete authored until history capture", () => {
    const { h: initial, other } = fixture();
    let d = initial.document;
    d.nodes.outer = createNode("frame", d.rootId, {
      id: "outer",
      children: ["main", other],
    });
    d.nodes.main.parentId = "outer";
    d.nodes[other].parentId = "outer";
    d.nodes[d.rootId].children = d.nodes[d.rootId].children.filter(
      (id) => id !== "main" && id !== other,
    );
    d.nodes[d.rootId].children.push("outer");
    d = makeComponent(d, "outer");
    const instance = createInstance(d, "outer");
    const h = new DocumentHistory(instance.document),
      before = h.document;
    let rows = rowsOf(before);
    rows[0].name = "Renamed";
    h.execute(editVariantSet(before, "main", ["State"], rows));
    const outerLink = h.document.nodes[instance.id].component as Instance;
    expect(outerLink.overrides.main?.name).toBeUndefined();
    h.execute(updateNodes(h.document, { main: { name: "Renamed again" } }));
    expect(h.document.nodes[outerLink.nodeMap.main].name).toBe("Renamed again");
    let draft = h.document;
    const a = createVariant(draft, "main"),
      b = createVariant(a.document, "main");
    h.execute(
      editVariantSet(b.document, "main", ["State"], rowsOf(b.document)),
    );
    expect(
      h.document.nodes[
        (h.document.nodes[instance.id].component as Instance).nodeMap[a.id]
      ],
    ).toBeDefined();
    h.execute(
      editVariantSet(
        h.document,
        "main",
        ["State"],
        rowsOf(h.document).filter((r) => r.id !== b.id),
      ),
    );
    expect(h.document.nodes[b.id]).toBeUndefined();
    const baseline = h.document,
      stats = h.statistics.undoEntries;
    const temporary = createVariant(baseline, "main");
    h.execute(
      editVariantSet(
        temporary.document,
        "main",
        ["State"],
        rowsOf(temporary.document).filter((r) => r.id !== temporary.id),
      ),
    );
    expect(h.document).toEqual(baseline);
    expect(h.statistics.undoEntries).toBe(stats);
  });
});
