import { it, expect } from "vitest";
import { createNode, DocumentHistory, duplicateNodes } from "../src/core";
import { newDocument } from "../src/documents";
import { makeComponent, createInstance } from "../src/components";
it("review duplicate instance keeps requested placement and name", () => {
  const d = newDocument();
  const n = createNode("frame", d.rootId, { id: "main", name: "Card" });
  d.nodes.main = n;
  d.nodes[d.rootId].children.push("main");
  const instance = createInstance(makeComponent(d, "main"), "main");
  const h = new DocumentHistory(instance.document);
  const original = h.document.nodes[instance.id];
  const dup = duplicateNodes(h.document, [instance.id], { x: 24, y: 24 });
  h.execute(dup.document);
  expect(h.document.nodes[dup.ids[0]].transform[4]).toBe(
    original.transform[4] + 24,
  );
  expect(h.document.nodes[dup.ids[0]].name).toBe(original.name + " copy");
});
import { updateNodes } from "../src/core";
import type { Instance } from "../src/components";
it("review normalized group instance placement remains stable after child override", () => {
  const d = newDocument();
  const n = createNode("group", d.rootId, { id: "main", children: ["rect"] });
  const r = createNode("rectangle", "main", { id: "rect" });
  d.nodes.main = n;
  d.nodes.rect = r;
  d.nodes[d.rootId].children.push("main");
  const a = createInstance(makeComponent(d, "main"), "main");
  const h = new DocumentHistory(a.document);
  const cid = (h.document.nodes[a.id].component as Instance).nodeMap.rect;
  const t = [...h.document.nodes[cid].transform] as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  t[4] = -20;
  h.execute(updateNodes(h.document, { [cid]: { transform: t } }));
  const moved = [...h.document.nodes[a.id].transform] as typeof t;
  moved[4] += 10;
  h.execute(updateNodes(h.document, { [a.id]: { transform: moved } }));
  expect(h.document.nodes[a.id].transform[4]).toBe(moved[4]);
});
import { reconcileComponents } from "../src/components";
import { validateDocument } from "../src/core";
it("review sparse imported nested instances expand dependent source trees", () => {
  const d = newDocument();
  const base = createNode("frame", d.rootId, {
    id: "m0",
    children: ["leaf"],
    component: { kind: "main" },
  });
  d.nodes.m0 = base;
  d.nodes.leaf = createNode("rectangle", "m0", { id: "leaf" });
  d.nodes[d.rootId].children.push("m0");
  for (let level = 1; level <= 8; level++) {
    const mid = "m" + level,
      sourceId = "m" + (level - 1);
    const main = createNode("frame", d.rootId, {
      id: mid,
      component: { kind: "main" },
    });
    d.nodes[mid] = main;
    d.nodes[d.rootId].children.push(mid);
    for (let i = 0; i < 2; i++) {
      const id = mid + "i" + i;
      const n = createNode("frame", mid, {
        id,
        component: {
          kind: "instance",
          sourceId,
          nodeMap: { [sourceId]: id },
          overrides: {},
        },
      });
      d.nodes[id] = n;
      main.children.push(id);
    }
  }
  validateDocument(d);
  expect(Object.keys(d.nodes)).toHaveLength(27);
  const expanded = reconcileComponents(d);
  validateDocument(expanded);
  expect(Object.keys(expanded.nodes).length).toBeGreaterThan(1500);
});
it("review rejects imported node maps claiming unrelated scene nodes", () => {
  const d = newDocument();
  const main = createNode("frame", d.rootId, {
    id: "main",
    children: ["rect"],
    component: { kind: "main" },
  });
  d.nodes.main = main;
  d.nodes.rect = createNode("rectangle", "main", { id: "rect" });
  d.nodes[d.rootId].children.push("main");
  const a = createInstance(d, "main");
  const foreign = createNode("rectangle", d.rootId, { id: "foreign" });
  a.document.nodes.foreign = foreign;
  a.document.nodes[d.rootId].children.push("foreign");
  (a.document.nodes[a.id].component as Instance).nodeMap.rect = "foreign";
  validateDocument(a.document);
  expect(() => new DocumentHistory(a.document)).toThrow(/ownership/);
});
it("review can remove and restore a locally added instance stroke", () => {
  const d = newDocument();
  const main = createNode("frame", d.rootId, {
    id: "main",
    component: { kind: "main" },
  });
  d.nodes.main = main;
  d.nodes[d.rootId].children.push("main");
  const a = createInstance(d, "main");
  const h = new DocumentHistory(a.document);
  h.execute(
    updateNodes(h.document, {
      [a.id]: { stroke: { width: 2, color: "#f00" } },
    }),
  );
  h.execute(updateNodes(h.document, { [a.id]: { stroke: undefined } }));
  h.execute(
    updateNodes(h.document, {
      [a.id]: { stroke: { width: 3, color: "#0f0" } },
    }),
  );
  expect(h.document.nodes[a.id].stroke).toEqual({ width: 3, color: "#0f0" });
  h.execute(
    updateNodes(h.document, {
      main: { stroke: { width: 5, color: "#00f", position: "outside" } },
    }),
  );
  expect(h.document.nodes[a.id].stroke).toEqual({
    width: 3,
    color: "#0f0",
    position: "outside",
  });
});
it("review partial stroke fallback survives JSON reload before source restoration", () => {
  const d = newDocument();
  const main = createNode("frame", d.rootId, {
    id: "main",
    component: { kind: "main" },
    stroke: { width: 2, color: "#00f" },
  });
  d.nodes.main = main;
  d.nodes[d.rootId].children.push("main");
  const a = createInstance(d, "main");
  const h = new DocumentHistory(a.document);
  h.execute(
    updateNodes(h.document, {
      [a.id]: { stroke: { width: 4, color: "#00f" } },
    }),
  );
  h.execute(updateNodes(h.document, { main: { stroke: undefined } }));
  const loaded = new DocumentHistory(JSON.parse(JSON.stringify(h.document)));
  expect(loaded.document.nodes[a.id].stroke).toEqual({
    width: 4,
    color: "#00f",
  });
  loaded.execute(
    updateNodes(loaded.document, {
      main: { stroke: { width: 8, color: "#0f0" } },
    }),
  );
  expect(loaded.document.nodes[a.id].stroke).toEqual({
    width: 4,
    color: "#0f0",
  });
});
it("review rejects imported overlapping whole-object and leaf overrides in either order", () => {
  const d = newDocument();
  const main = createNode("frame", d.rootId, {
    id: "main",
    component: { kind: "main" },
  });
  d.nodes.main = main;
  d.nodes[d.rootId].children.push("main");
  const a = createInstance(d, "main");
  for (const paths of [
    { stroke: null, "stroke.width": 3 },
    { "stroke.width": 3, stroke: null },
  ]) {
    const imported = structuredClone(a.document);
    (imported.nodes[a.id].component as Instance).overrides.main = paths;
    expect(() => validateDocument(imported)).toThrow();
    expect(() => new DocumentHistory(imported)).toThrow();
  }
});
