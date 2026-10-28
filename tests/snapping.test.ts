import { describe, it, expect } from "vitest";
import { createNode, type SceneDocument, type Matrix } from "../src/core";
import { snapMove, snapResize } from "../src/snapping";
function fixture(matrix: Matrix = [1, 0, 0, 1, 0, 0]): SceneDocument {
  const page = createNode("page", null, { id: "page", children: ["p"] });
  const p = createNode("frame", "page", {
    id: "p",
    children: ["a", "b"],
    width: 500,
    height: 400,
    transform: matrix,
  });
  const a = createNode("rectangle", "p", {
    id: "a",
    width: 40,
    height: 30,
    transform: [1, 0, 0, 1, 50, 70],
  });
  const b = createNode("rectangle", "p", {
    id: "b",
    width: 100,
    height: 80,
    transform: [1, 0, 0, 1, 200, 200],
  });
  return {
    schemaVersion: 1,
    id: "doc",
    name: "Snap",
    rootId: "page",
    assets: {},
    nodes: { page, p, a, b },
  };
}
describe("snapping", () => {
  for (const zoom of [0.25, 1, 4]) {
    it(`uses a 6 screen-pixel threshold at zoom ${zoom}`, () => {
      const d = fixture();
      d.nodes.a.width = 0;
      d.nodes.b.width = 0;
      expect(snapMove(d, ["a"], 150 - 5 / zoom, 30, zoom).dx).toBeCloseTo(150);
      // Isolate the leading edge so other source/target anchors cannot win.
      d.nodes.a.width = 0;
      d.nodes.b.width = 0;
      expect(snapMove(d, ["a"], 150 - 8 / zoom, 30, zoom).dx).toBeCloseTo(
        150 - 8 / zoom,
      );
    });
  }
  it("aligns sibling centers and parent edges/centers", () => {
    const d = fixture();
    expect(snapMove(d, ["a"], 178, 20, 1).dx).toBeCloseTo(180);
    d.nodes.b.visible = false;
    expect(snapMove(d, ["a"], -47, 20, 1).dx).toBeCloseTo(-50);
    expect(snapMove(d, ["a"], 178, 20, 1).dx).toBeCloseTo(180);
    expect(snapMove(d, ["a"], 407, 20, 1).dx).toBeCloseTo(410);
  });
  it("uses rotated parent axes and rotates guide endpoints", () => {
    const d = fixture([0, 2, -2, 0, 600, 50]);
    const r = snapMove(d, ["a"], -60, 296, 1);
    expect(r.dx).toBeCloseTo(-60);
    expect(r.dy).toBeCloseTo(300);
    const guide = r.guides.find((g) => g.axis === "x")!;
    expect(guide.start.y).toBeCloseTo(450);
    expect(guide.end.y).toBeCloseTo(450);
  });
  it("measures perpendicular threshold under shear", () => {
    const d = fixture([2, 0, 1, 1, 0, 0]);
    // Local 4 maps to 5.66px perpendicular distance, within the 6px gate.
    expect(snapMove(d, ["a"], 292 + 30, 30, 1).dx).toBeCloseTo(330);
  });
  it("does not include hidden targets or selected descendants", () => {
    const d = fixture();
    d.nodes.b.visible = false;
    expect(snapMove(d, ["a"], 148, 30, 1).dx).toBeCloseTo(148);
    expect(snapMove(d, ["p", "a"], 3, 3, 1).guides).toEqual([]);
  });
  it("excludes locked and hidden selections from the moving union", () => {
    const d = fixture();
    d.nodes.b.locked = true;
    expect(snapMove(d, ["a", "b"], 197, 20, 1)).toEqual(
      snapMove(d, ["a"], 197, 20, 1),
    );
    d.nodes.b.visible = false;
    expect(snapMove(d, ["a", "b"], 197, 20, 1)).toEqual(
      snapMove(d, ["a"], 197, 20, 1),
    );
  });
  it("uses the selection union and never mutates the document", () => {
    const d = fixture(),
      before = structuredClone(d);
    const r = snapMove(d, ["a", "b"], -47, 20, 1);
    expect(r.dx).toBeCloseTo(-50);
    expect(d).toEqual(before);
  });
  it("snaps resize edges and centers while retaining the fixed origin", () => {
    const d = fixture();
    expect(snapResize(d, "a", 147, 100, 1).width).toBeCloseTo(150);
    expect(snapResize(d, "a", 297, 100, 1).width).toBeCloseTo(300);
    expect(d.nodes.a.transform).toEqual([1, 0, 0, 1, 50, 70]);
  });
  it("resizes inside a rotated/scaled parent and removes impossible minimum-size guides", () => {
    const d = fixture([0, 2, -2, 0, 600, 50]);
    expect(snapResize(d, "a", 148, 100, 1).width).toBeCloseTo(150);
    d.nodes.b.transform[4] = 56;
    const r = snapResize(d, "a", 8, 100, 1);
    expect(r.width).toBeGreaterThanOrEqual(8);
    expect(r.guides.filter((g) => g.axis === "x")).toEqual([]);
  });
});
