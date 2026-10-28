import { expect, it } from "vitest";
import { createNode, DocumentHistory, updateNodes, validateDocument } from "../src/core";
import { newDocument } from "../src/documents";
import {
  createInstance,
  makeComponent,
  switchVariant,
  type Instance,
} from "../src/components";
import { createVariant } from "../src/variants";

it("review drops incompatible frame overrides after a variant child changes type", () => {
  let d = newDocument();
  d.nodes.main = createNode("frame", d.rootId, {
    id: "main",
    children: ["child"],
  });
  d.nodes.child = createNode("frame", "main", { id: "child", name: "Child" });
  d.nodes[d.rootId].children.push("main");
  d = makeComponent(d, "main");
  const v = createVariant(d, "main");
  const targetChild = v.document.nodes[v.id].children[0];
  v.document.nodes[targetChild] = createNode("text", v.id, {
    id: targetChild,
    name: "Child",
    width: 100,
  });
  const a = createInstance(v.document, "main");
  const h = new DocumentHistory(a.document);
  const cid = (h.document.nodes[a.id].component as Instance).nodeMap.child;
  h.execute(updateNodes(h.document, { [cid]: { width: 444 } }));
  h.execute(switchVariant(h.document, a.id, v.id));
  const switched = h.document.nodes[a.id].component as Instance;
  expect(h.document.nodes[switched.nodeMap[targetChild]].width).toBe(100);
  h.execute(switchVariant(h.document, a.id, "main"));
  const returned = h.document.nodes[a.id].component as Instance;
  expect(h.document.nodes[returned.nodeMap.child].width).toBe(444);
});

it("review assigns variant keys after nested source instances expand", () => {
  let d = newDocument();
  d.nodes.inner = createNode("frame", d.rootId, { id: "inner" });
  d.nodes.outer = createNode("frame", d.rootId, { id: "outer" });
  d.nodes[d.rootId].children.push("outer", "inner");
  d = makeComponent(makeComponent(d, "inner"), "outer");
  const nested = createInstance(d, "inner", "outer");
  const v = createVariant(nested.document, "outer");
  const h = new DocumentHistory(v.document);
  const edit = h.document;
  edit.nodes.newChild = createNode("text", "inner", { id: "newChild" });
  edit.nodes.inner.children.push("newChild");
  h.execute(edit);
  const result = h.document;
  const nestedLink = result.nodes[nested.id].component as Instance;
  const outer = result.nodes.outer.component;
  if (outer?.kind !== "main") throw new Error("Expected main");
  expect(outer.variant?.keys[nestedLink.nodeMap.newChild]).toBeTypeOf("string");
});

it("review switches nested variant structure while propagating containing instances", () => {
  let d = newDocument();
  d.nodes.main = createNode("frame", d.rootId, {
    id: "main",
    children: ["child"],
  });
  d.nodes.child = createNode("rectangle", "main", { id: "child" });
  d.nodes.outer = createNode("frame", d.rootId, { id: "outer" });
  d.nodes[d.rootId].children.push("main", "outer");
  d = makeComponent(makeComponent(d, "main"), "outer");
  const v = createVariant(d, "main");
  const removed = v.document.nodes[v.id].children[0];
  delete v.document.nodes[removed];
  v.document.nodes[v.id].children = [];
  const nested = createInstance(v.document, "main", "outer");
  const outer = createInstance(nested.document, "outer");
  const h = new DocumentHistory(outer.document);
  expect(() =>
    h.execute(switchVariant(h.document, nested.id, v.id)),
  ).not.toThrow();
  expect(h.document.nodes[nested.id].children).toEqual([]);
  expect(
    h.document.nodes[h.document.nodes[outer.id].children[0]].children,
  ).toEqual([]);
});

it("review propagates nested variant leaf changes without recording inherited overrides", () => {
  let d = newDocument();
  d.nodes.main = createNode("frame", d.rootId, { id: "main", children: ["child"] });
  d.nodes.child = createNode("rectangle", "main", { id: "child", width: 40 });
  d.nodes.outer = createNode("frame", d.rootId, { id: "outer" });
  d.nodes[d.rootId].children.push("main", "outer");
  d = makeComponent(makeComponent(d, "main"), "outer");
  const v = createVariant(d, "main");
  const variantChild = v.document.nodes[v.id].children[0];
  v.document.nodes[variantChild].width = 80;
  const nested = createInstance(v.document, "main", "outer");
  const outer = createInstance(nested.document, "outer");
  const h = new DocumentHistory(outer.document);
  h.execute(switchVariant(h.document, nested.id, v.id));
  const nestedChild = (h.document.nodes[nested.id].component as Instance).nodeMap[variantChild];
  const outerLink = h.document.nodes[outer.id].component as Instance;
  expect(outerLink.overrides[nestedChild]).toBeUndefined();
  expect(h.document.nodes[outerLink.nodeMap[nestedChild]].width).toBe(80);
  h.execute(updateNodes(h.document, { [variantChild]: { width: 120 } }));
  expect(h.document.nodes[outerLink.nodeMap[nestedChild]].width).toBe(120);
});

it("review rejects malformed dormant stroke options before restoring them", () => {
  let d = newDocument();
  d.nodes.main = createNode("frame", d.rootId, { id: "main" });
  d.nodes[d.rootId].children.push("main");
  d = makeComponent(d, "main");
  const a = createInstance(d, "main");
  for (const stroke of [
    { width: 1, color: "invalid" },
    { width: 1, color: "#f00", opacity: 2 },
    { width: 1, color: "#f00", dash: [-1] },
    { width: 1, color: "#f00", position: "bad" },
  ]) {
    const bad = structuredClone(a.document);
    (bad.nodes[a.id].component as Instance).variantOverrides = {
      "frame:test": { paths: {}, stroke: stroke as never },
    };
    expect(() => validateDocument(bad)).toThrow();
  }
});
