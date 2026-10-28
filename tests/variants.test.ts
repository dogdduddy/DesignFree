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
  makeComponent,
  createInstance,
  switchVariant,
  setVariantProperties,
  resetInstanceOverrides,
  type Instance,
} from "../src/components";
import { createVariant } from "../src/variants";
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
