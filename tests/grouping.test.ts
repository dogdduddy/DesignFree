import { describe, it, expect } from "vitest";
import {
  createNode,
  groupNodes,
  ungroupNodes,
  getWorldTransform,
  updateNodes,
  DocumentHistory,
  parseDocument,
  serializeDocument,
  groupHitTarget,
  reparentNode,
  type SceneDocument,
} from "../src/core";
function fixture(): SceneDocument {
  return {
    schemaVersion: 1,
    id: "doc",
    name: "groups",
    rootId: "p",
    assets: {},
    nodes: {
      p: createNode("page", null, { id: "p", children: ["f"] }),
      f: createNode("frame", "p", {
        id: "f",
        children: ["a", "b", "c"],
        transform: [0.8, 0.6, -0.3, 1.2, 70, 20],
      }),
      a: createNode("rectangle", "f", {
        id: "a",
        width: 20,
        height: 30,
        transform: [1, 0.2, 0.4, 1, -20, 10],
      }),
      b: createNode("ellipse", "f", {
        id: "b",
        transform: [0, 1, -1, 0, 100, 20],
      }),
      c: createNode("text", "f", { id: "c" }),
    },
  };
}
const close = (a: number[], b: number[]) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 8));
describe("grouping", () => {
  it("preserves full affine worlds and paint order through group/ungroup", () => {
    const d = fixture(),
      r = groupNodes(d, ["b", "a"]),
      g = r.ids[0];
    expect(r.document.nodes[g].children).toEqual(["a", "b"]);
    expect(r.document.nodes.f.children).toEqual([g, "c"]);
    for (const id of ["a", "b"])
      close(getWorldTransform(r.document, id), getWorldTransform(d, id));
    const u = ungroupNodes(r.document, [g]);
    expect(u.document.nodes.f.children).toEqual(["a", "b", "c"]);
    for (const id of ["a", "b"])
      close(getWorldTransform(u.document, id), getWorldTransform(d, id));
    expect(d.nodes.a.parentId).toBe("f");
  });
  it("computes exact transformed child boxes including negative coordinates", () => {
    const r = groupNodes(fixture(), ["a", "b"]),
      n = r.document.nodes[r.ids[0]];
    expect(n.transform).toEqual([1, 0, 0, 1, -20, 10]);
    expect(n.width).toBe(120);
    expect(n.height).toBe(110);
  });
  it("recomputes bounds on child edits while keeping siblings stationary", () => {
    const r = groupNodes(fixture(), ["a", "b"]),
      g = r.ids[0],
      d = r.document;
    const t = [...d.nodes.a.transform] as typeof d.nodes.a.transform;
    t[4] -= 50;
    const next = updateNodes(d, { a: { transform: t } });
    close(getWorldTransform(next, "b"), getWorldTransform(d, "b"));
    expect(next.nodes[g].width).toBe(170);
  });
  it("normalizes deletes and restores groups with one history step", () => {
    const d = fixture(),
      r = groupNodes(d, ["a", "b"]),
      h = new DocumentHistory(d);
    h.execute(r.document);
    h.undo();
    expect(h.document).toEqual(d);
    h.redo();
    expect(h.document).toEqual(r.document);
    const next = h.document;
    delete next.nodes.a;
    next.nodes[r.ids[0]].children = ["b"];
    h.execute(next);
    expect(h.document.nodes[r.ids[0]].width).toBe(100);
    h.undo();
    expect(h.document).toEqual(r.document);
  });
  it("supports nested groups and serializes them", () => {
    const r = groupNodes(fixture(), ["a", "b"]),
      s = groupNodes(r.document, [r.ids[0], "c"]);
    expect(parseDocument(serializeDocument(s.document))).toEqual(s.document);
    expect(groupHitTarget(s.document, "a", null)).toBe(s.ids[0]);
    expect(groupHitTarget(s.document, "a", s.ids[0])).toBe(r.ids[0]);
    expect(groupHitTarget(s.document, "a", r.ids[0])).toBe("a");
  });
  it("rejects mixed parents and inherited locks atomically", () => {
    const d = fixture();
    expect(groupNodes(d, ["a", "f"]).ids).toHaveLength(1);
    d.nodes.other = createNode("rectangle", "p", { id: "other" });
    d.nodes.p.children.push("other");
    expect(groupNodes(d, ["a", "other"]).document).toBe(d);
    d.nodes.f.locked = true;
    expect(groupNodes(d, ["a", "b"]).document).toBe(d);
  });
  it("ungroups multiple groups and keeps children order", () => {
    const d = fixture(),
      a = groupNodes(d, ["a"]),
      b = groupNodes(a.document, ["b"]);
    const r = ungroupNodes(b.document, [a.ids[0], b.ids[0]]);
    expect(r.document.nodes.f.children).toEqual(["a", "b", "c"]);
  });
  it("reparent accepts group and preserves world matrix", () => {
    const d = fixture(),
      r = groupNodes(d, ["a"]);
    const next = reparentNode(r.document, "b", r.ids[0]);
    close(getWorldTransform(next, "b"), getWorldTransform(d, "b"));
  });
  it("does not silently discard group opacity on ungroup", () => {
    const r = groupNodes(fixture(), ["a"]);
    r.document.nodes[r.ids[0]].opacity = 0.5;
    expect(ungroupNodes(r.document, r.ids).document).toBe(r.document);
  });
});

it("handles many children without argument-spread overflow", () => {
  const d = fixture();
  d.nodes.f.children = [];
  delete d.nodes.a;
  delete d.nodes.b;
  delete d.nodes.c;
  for (let i = 0; i < 33000; i++) {
    const id = `n${i}`;
    d.nodes[id] = createNode("rectangle", "f", {
      id,
      transform: [1, 0, 0, 1, i, 0],
    });
    d.nodes.f.children.push(id);
  }
  const r = groupNodes(d, d.nodes.f.children);
  expect(r.document.nodes[r.ids[0]].width).toBe(33099);
});
it("treats groups as atomic marquee targets outside their entry scope", async () => {
  const { marqueeSelection } = await import("../src/marquee");
  const r = groupNodes(fixture(), ["a", "b"]);
  const b = getWorldTransform(r.document, "a");
  const hits = marqueeSelection(
    r.document,
    { x: b[4] - 1, y: b[5] - 1 },
    { x: b[4] + 40, y: b[5] + 50 },
  );
  expect(hits).not.toContain("a");
});
