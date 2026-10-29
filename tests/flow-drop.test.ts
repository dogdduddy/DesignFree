import { it, expect } from "vitest";
import {
  createNode,
  DocumentHistory,
  type SceneDocument,
  type Layout,
} from "../src/core";
import { computeLayout } from "../src/flex-layout";
import { applyFlowDrop, flowDropAt } from "../src/flow-drop";
function fixture(layout: Layout = { mode: "flex", gap: 10 }): SceneDocument {
  return {
    schemaVersion: 1,
    id: "flow",
    name: "Flow",
    rootId: "p",
    assets: {},
    nodes: {
      p: createNode("page", null, { id: "p", children: ["f", "x"] }),
      f: createNode("frame", "p", {
        id: "f",
        width: 240,
        height: 200,
        children: ["a", "b", "c"],
        layout,
      }),
      ...Object.fromEntries(
        ["a", "b", "c", "x"].map((id) => [
          id,
          createNode("rectangle", id === "x" ? "p" : "f", {
            id,
            width: 60,
            height: 40,
            transform: [1, 0.1, 0.2, 1, 400, 300],
            layout: { mode: "absolute", minWidth: 20 },
          }),
        ]),
      ),
    },
  };
}
const drop = (d: SceneDocument, ids: string[], x: number, y: number) =>
  flowDropAt(d, computeLayout(d), ids, { x, y })!;
it("reorders flow without baking computed geometry or mutating source", () => {
  const d = fixture(),
    next = applyFlowDrop(d, ["a"], drop(d, ["a"], 199, 20));
  expect(next.nodes.f.children).toEqual(["b", "c", "a"]);
  for (const id of ["a", "b", "c"]) expect(next.nodes[id]).toEqual(d.nodes[id]);
  expect(d.nodes.f.children).toEqual(["a", "b", "c"]);
});
it("inserts external roots in paint order preserving sizing/grid rules and local transforms", () => {
  const d = fixture();
  d.nodes.x.layout.grid = { column: 2, columnSpan: 2 };
  const n = applyFlowDrop(d, ["x"], drop(d, ["x"], 72, 20));
  expect(n.nodes.f.children).toEqual(["a", "x", "b", "c"]);
  expect(n.nodes.x).toEqual({ ...d.nodes.x, parentId: "f" });
});
it("column and wrapped rows use local geometry to choose an insertion edge", () => {
  const column = fixture({ mode: "flex", direction: "column", gap: 10 });
  expect(drop(column, ["x"], 20, 92).index).toBe(2);
  const wrap = fixture({ mode: "flex", wrap: true, gap: 10 });
  wrap.nodes.f.width = 140;
  expect(drop(wrap, ["x"], 59, 65).index).toBe(3);
});
it("grid automatic order changes while explicit starts/areas/spans remain authored", () => {
  const d = fixture({
    mode: "grid",
    grid: { columns: [80, 80], rows: [60, 60] },
  });
  d.nodes.b.layout.grid = { column: 2, row: 1, columnSpan: 1 };
  const n = applyFlowDrop(d, ["a"], drop(d, ["a"], 58, 80));
  expect(n.nodes.f.children).toEqual(["b", "c", "a"]);
  expect(n.nodes.b.layout).toEqual(d.nodes.b.layout);
});
it("empty containers show padding edge and absolute placement becomes flow only", () => {
  const d = fixture();
  d.nodes.f.children = [];
  delete d.nodes.a;
  delete d.nodes.b;
  delete d.nodes.c;
  d.nodes.x.layout.position = "absolute";
  const target = drop(d, ["x"], 30, 30);
  expect(target.index).toBe(0);
  const n = applyFlowDrop(d, ["x"], target);
  expect(n.nodes.x).toEqual({
    ...d.nodes.x,
    parentId: "f",
    layout: { ...d.nodes.x.layout, position: "flow" },
  });
});
it("rejects locked/hidden/clipped targets, cycles and group ownership", () => {
  const d = fixture();
  d.nodes.f.locked = true;
  expect(drop(d, ["x"], 50, 50)).toBeNull();
  d.nodes.f.locked = false;
  d.nodes.f.visible = false;
  expect(drop(d, ["x"], 50, 50)).toBeNull();
  d.nodes.f.visible = true;
  expect(drop(d, ["f"], 50, 50)).toBeNull();
  d.nodes.a.locked = true;
  expect(drop(d, ["a"], 150, 20)).toBeNull();
  d.nodes.f.type = "group";
  expect(drop(d, ["x"], 50, 50)).toBeNull();
});
it("affine parent produces world-space indicator and local-space index", () => {
  const d = fixture();
  d.nodes.f.transform = [0, 2, -2, 0, 500, 30];
  const target = drop(d, ["x"], 460, 320);
  expect(target.index).toBe(2);
  expect(target.start.x).toBe(500);
  expect(target.end.x).toBe(420);
});
it("multiple previews form one undo, cancel restores source and no-op adds no history", () => {
  const d = fixture(),
    h = new DocumentHistory(d);
  h.beginTransaction();
  h.preview(applyFlowDrop(d, ["a"], drop(d, ["a"], 199, 20)));
  h.preview(applyFlowDrop(d, ["a"], drop(d, ["a"], 130, 20)));
  h.commitTransaction();
  h.undo();
  expect(h.document).toEqual(d);
  h.redo();
  expect(h.document.nodes.f.children).toEqual(["b", "a", "c"]);
  h.beginTransaction();
  h.preview(applyFlowDrop(h.document, ["x"], drop(h.document, ["x"], 10, 20)));
  h.cancelTransaction();
  expect(h.document.nodes.x.parentId).toBe("p");
  const noop = applyFlowDrop(d, ["a"], drop(d, ["a"], 72, 20));
  expect(noop).toBe(d);
});

it("Grid marker uses prospective computed placement when explicit order differs", () => {
  const d = fixture({
    mode: "grid",
    grid: { columns: [100, 100], rows: [80, 80, 80] },
  });
  d.nodes.f.height = 260;
  d.nodes.a.layout.grid = { column: 1, row: 3 };
  const target = drop(d, ["c"], 10, 190);
  const next = computeLayout(applyFlowDrop(d, ["c"], target));
  expect(target.start).toEqual({
    x: next.nodes.c.transform[4],
    y: next.nodes.c.transform[5],
  });
  expect(target.start.y).toBe(0);
  expect(next.nodes.a.layout.grid).toEqual(d.nodes.a.layout.grid);
});

it("Grid multiselect marker follows insertion paint order rather than selection click order", () => {
  const d = fixture({
    mode: "grid",
    grid: { columns: [100, 100], rows: [80, 80] },
  });
  const target = drop(d, ["c", "b"], 10, 20);
  const next = computeLayout(applyFlowDrop(d, ["c", "b"], target));
  expect(next.nodes.f.children).toEqual(["b", "c", "a"]);
  expect(target.start).toEqual({
    x: next.nodes.b.transform[4],
    y: next.nodes.b.transform[5],
  });
});
