import { describe, it, expect } from "vitest";
import {
  createNode,
  getWorldTransform,
  groupNodes,
  DocumentHistory,
  updateNodes,
} from "../src/core";
import type { SceneDocument } from "../src/core";
import {
  moveLayers,
  stepLayers,
  frameAtPoint,
  reparentCanvasDrop,
} from "../src/layers";
function fixture(): SceneDocument {
  return {
    schemaVersion: 1,
    id: "doc",
    name: "layers",
    rootId: "p",
    assets: {},
    nodes: {
      p: createNode("page", null, { id: "p", children: ["f", "g", "x"] }),
      f: createNode("frame", "p", {
        id: "f",
        children: ["a", "b", "c"],
        width: 200,
        height: 200,
        transform: [1, 0.2, 0.3, 1, 20, 20],
      }),
      g: createNode("frame", "p", {
        id: "g",
        width: 200,
        height: 200,
        transform: [0.8, 0.1, -0.2, 1, 400, 20],
      }),
      a: createNode("rectangle", "f", {
        id: "a",
        transform: [1, 0.1, 0.2, 1, 10, 10],
      }),
      b: createNode("rectangle", "f", {
        id: "b",
        transform: [1, 0, 0, 1, 50, 50],
      }),
      c: createNode("rectangle", "f", { id: "c" }),
      x: createNode("rectangle", "p", { id: "x" }),
    },
  };
}
const close = (a: number[], b: number[]) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 8));
describe("layer hierarchy editing", () => {
  it("moves multi selection in stable paint order preserving full affine worlds", () => {
    const d = fixture(),
      n = moveLayers(d, ["b", "a"], "g");
    expect(n.nodes.g.children).toEqual(["a", "b"]);
    for (const id of ["a", "b"])
      close(getWorldTransform(n, id), getWorldTransform(d, id));
    expect(d.nodes.f.children).toEqual(["a", "b", "c"]);
  });
  it("insertion indices use original sibling positions and no-op returns input", () => {
    const d = fixture();
    expect(moveLayers(d, ["a"], "f", 1)).toBe(d);
    expect(moveLayers(d, ["a"], "f", 3).nodes.f.children).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
  it("steps contiguous selections once, keeping internal order and boundaries", () => {
    const d = fixture();
    expect(stepLayers(d, ["a", "b"], true).nodes.f.children).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(stepLayers(d, ["b", "c"], false).nodes.f.children).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(stepLayers(d, ["c"], true)).toBe(d);
  });
  it("rejects cycle, root, invalid target, inherited lock atomically", () => {
    const d = fixture();
    expect(moveLayers(d, ["f"], "f")).toBe(d);
    expect(moveLayers(d, ["p"], "g")).toBe(d);
    expect(moveLayers(d, ["a"], "b")).toBe(d);
    d.nodes.f.locked = true;
    expect(moveLayers(d, ["a", "x"], "g")).toBe(d);
    expect(stepLayers(d, ["a", "x"], true)).toBe(d);
    expect(moveLayers(d, ["x"], "f")).toBe(d);
  });
  it("preserves group sibling worlds when child leaves or enters", () => {
    const d = groupNodes(fixture(), ["a", "b"]).document;
    const n = moveLayers(d, ["a"], "g");
    close(getWorldTransform(n, "b"), getWorldTransform(d, "b"));
    close(getWorldTransform(n, "a"), getWorldTransform(d, "a"));
  });
  it("finds innermost eligible frame and excludes dragged subtrees", () => {
    const d = fixture();
    expect(frameAtPoint(d, { x: 80, y: 80 }, ["x"])).toBe("f");
    expect(frameAtPoint(d, { x: 80, y: 80 }, ["f"])).toBe("p");
    d.nodes.f.locked = true;
    expect(frameAtPoint(d, { x: 80, y: 80 }, ["x"])).toBe("p");
  });
  it("keeps existing group parent until crossing frame boundary", () => {
    const d = groupNodes(fixture(), ["a", "b"]).document;
    expect(reparentCanvasDrop(d, ["a"], { x: 80, y: 80 })).toBe(d);
    const n = reparentCanvasDrop(d, ["a"], { x: 440, y: 80 });
    expect(n.nodes.a.parentId).toBe("g");
    close(getWorldTransform(n, "a"), getWorldTransform(d, "a"));
  });
  it("reparents outside frame to page and supports undo redo cancel as one transaction", () => {
    const d = fixture(),
      h = new DocumentHistory(d);
    h.beginTransaction();
    h.preview(updateNodes(d, { a: { transform: [1, 0.1, 0.2, 1, 700, 700] } }));
    const n = reparentCanvasDrop(h.document, ["a"], { x: 800, y: 800 });
    h.preview(n);
    h.commitTransaction();
    expect(h.document.nodes.a.parentId).toBe("p");
    h.undo();
    expect(h.document).toEqual(d);
    h.redo();
    expect(h.document).toEqual(n);
    h.beginTransaction();
    h.preview(moveLayers(n, ["a"], "g"));
    h.cancelTransaction();
    expect(h.document).toEqual(n);
  });
});

it("nested frame targets respect ancestor clipping and visibility", () => {
  const d = fixture();
  d.nodes.inner = createNode("frame", "f", {
    id: "inner",
    width: 100,
    height: 100,
    transform: [1, 0, 0, 1, 300, 300],
  });
  d.nodes.f.children.push("inner");
  const m = getWorldTransform(d, "inner"),
    p = { x: m[4] + 10, y: m[5] + 10 };
  expect(frameAtPoint(d, p, ["x"])).toBe("inner");
  d.nodes.f.clipContent = true;
  expect(frameAtPoint(d, p, ["x"])).toBe("p");
  d.nodes.f.clipContent = false;
  d.nodes.f.visible = false;
  expect(frameAtPoint(d, p, ["x"])).toBe("p");
});
it("mixed parent stepping stays in each parent and filters descendants", () => {
  const d = fixture();
  expect(stepLayers(d, ["f", "a", "x"], true).nodes.p.children).toEqual([
    "g",
    "f",
    "x",
  ]);
  expect(stepLayers(d, ["f", "a", "x"], true).nodes.f.children).toEqual(
    d.nodes.f.children,
  );
});
