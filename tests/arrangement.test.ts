import { describe, expect, it } from "vitest";
import {
  alignNodes,
  arrangeableRoots,
  canDistribute,
  distributeNodes,
  type Alignment,
} from "../src/arrangement";
import {
  createNode,
  getWorldBounds,
  getWorldTransform,
  validateDocument,
  type Matrix,
  type SceneDocument,
  type SceneNode,
} from "../src/core";

function fixture(): SceneDocument {
  const page = createNode("page", null, {
    id: "page",
    children: ["a", "b", "c"],
  });
  const node = (
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ) =>
    createNode("rectangle", page.id, {
      id,
      width,
      height,
      transform: [1, 0, 0, 1, x, y],
    });
  return {
    schemaVersion: 1,
    id: "doc",
    name: "Arrangement",
    rootId: page.id,
    assets: {},
    nodes: {
      page,
      a: node("a", 10, 20, 20, 30),
      b: node("b", 70, 90, 40, 10),
      c: node("c", 200, 170, 60, 50),
    },
  };
}

function add(doc: SceneDocument, node: SceneNode) {
  doc.nodes[node.id] = node;
  doc.nodes[node.parentId!].children.push(node.id);
}

function expectOnlyTranslations(before: SceneDocument, after: SceneDocument) {
  const restored = structuredClone(after);
  for (const id of Object.keys(before.nodes)) {
    expect(after.nodes[id].transform.slice(0, 4)).toEqual(
      before.nodes[id].transform.slice(0, 4),
    );
    restored.nodes[id].transform = [...before.nodes[id].transform];
  }
  expect(restored).toEqual(before);
  validateDocument(after);
}

describe("world-space alignment", () => {
  it.each<Alignment>([
    "left",
    "center-x",
    "right",
    "top",
    "center-y",
    "bottom",
  ])(
    "aligns %s against the selection union, preserving all other document data",
    (alignment) => {
      const doc = fixture(),
        original = structuredClone(doc);
      const next = alignNodes(doc, ["a", "b", "c"], alignment);
      const horizontal = ["left", "center-x", "right"].includes(alignment);
      const expected = {
        left: 10,
        "center-x": 135,
        right: 260,
        top: 20,
        "center-y": 120,
        bottom: 220,
      }[alignment];
      for (const id of ["a", "b", "c"]) {
        const b = getWorldBounds(next, id);
        const value =
          alignment === "left"
            ? b.x
            : alignment === "center-x"
              ? b.x + b.width / 2
              : alignment === "right"
                ? b.x + b.width
                : alignment === "top"
                  ? b.y
                  : alignment === "center-y"
                    ? b.y + b.height / 2
                    : b.y + b.height;
        expect(value).toBeCloseTo(expected, 10);
        expect(b[horizontal ? "y" : "x"]).toBe(
          getWorldBounds(doc, id)[horizontal ? "y" : "x"],
        );
      }
      expectOnlyTranslations(doc, next);
      expect(doc).toEqual(original);
      expect(alignNodes(next, ["a", "b", "c"], alignment)).toBe(next);
    },
  );

  it("converts a world displacement through different rotated, scaled and sheared parents", () => {
    const doc = fixture();
    doc.nodes.page.children = [];
    const matrices: Matrix[] = [
      [0, 2, -3, 0, 50, 70],
      [2, 0.5, 0.4, 1.5, 130, -20],
      [1, -0.3, 0.8, 2, -30, 100],
    ];
    ["a", "b", "c"].forEach((id, i) => {
      const parentId = `parent-${id}`;
      add(
        doc,
        createNode("frame", "page", {
          id: parentId,
          transform: matrices[i],
          children: [id],
        }),
      );
      doc.nodes[id].parentId = parentId;
      doc.nodes[id].transform = [0.9, 0.1, -0.2, 1.1, 20 + i * 30, 15 + i * 20];
    });
    const next = alignNodes(doc, ["a", "b", "c"], "right");
    const right = Math.max(
      ...["a", "b", "c"].map((id) => {
        const b = getWorldBounds(doc, id);
        return b.x + b.width;
      }),
    );
    for (const id of ["a", "b", "c"]) {
      const before = getWorldTransform(doc, id),
        after = getWorldTransform(next, id),
        bounds = getWorldBounds(next, id);
      expect(bounds.x + bounds.width).toBeCloseTo(right, 10);
      expect(after.slice(0, 4)).toEqual(before.slice(0, 4));
      expect(after[5]).toBeCloseTo(before[5], 10);
      expect(next.nodes[`parent-${id}`]).toEqual(doc.nodes[`parent-${id}`]);
    }
    expectOnlyTranslations(doc, next);
  });

  it("moves a selected parent once and leaves child local geometry unchanged", () => {
    const doc = fixture();
    doc.nodes.a.type = "frame";
    add(
      doc,
      createNode("rectangle", "a", {
        id: "child",
        transform: [1, 0, 0, 1, 3, 5],
      }),
    );
    const next = alignNodes(doc, ["child", "a", "b", "a"], "right");
    expect(arrangeableRoots(doc, ["child", "a", "b", "a"])).toEqual(["a", "b"]);
    expect(next.nodes.child).toEqual(doc.nodes.child);
    expect(
      getWorldTransform(next, "child")[4] - getWorldTransform(doc, "child")[4],
    ).toBe(80);
    expect(next.nodes.c).toEqual(doc.nodes.c);
  });
});

describe("equal edge gaps", () => {
  it.each(["x", "y"] as const)(
    "distributes unequal extents on %s with both endpoints exact",
    (axis) => {
      const doc = fixture(),
        original = structuredClone(doc);
      const next = distributeNodes(doc, ["c", "a", "b"], axis);
      const bounds = ["a", "b", "c"].map((id) => getWorldBounds(next, id));
      const extent = axis === "x" ? "width" : "height";
      expect(bounds[1][axis] - bounds[0][axis] - bounds[0][extent]).toBeCloseTo(
        bounds[2][axis] - bounds[1][axis] - bounds[1][extent],
        10,
      );
      expect(next.nodes.a.transform).toEqual(doc.nodes.a.transform);
      expect(next.nodes.c.transform).toEqual(doc.nodes.c.transform);
      expectOnlyTranslations(doc, next);
      expect(doc).toEqual(original);
      expect(distributeNodes(next, ["c", "b", "a"], axis)).toBe(next);
    },
  );

  it("allows equal negative gaps for overlapping objects", () => {
    const doc = fixture();
    doc.nodes.a.width = 100;
    doc.nodes.b.width = 80;
    doc.nodes.c.width = 60;
    doc.nodes.b.transform[4] = 20;
    doc.nodes.c.transform[4] = 40;
    const next = distributeNodes(doc, ["a", "b", "c"], "x");
    expect(next.nodes.b.transform[4]).toBe(35);
    const a = getWorldBounds(next, "a"),
      b = getWorldBounds(next, "b"),
      c = getWorldBounds(next, "c");
    expect(b.x - a.x - a.width).toBe(-75);
    expect(c.x - b.x - b.width).toBe(-75);
    expect(canDistribute(doc, ["a", "b", "c"], "x")).toBe(true);
    expect(distributeNodes(next, ["c", "a", "b"], "x")).toBe(next);
  });

  it.each(["x", "y"] as const)(
    "rejects severe overlap that would reorder anchored endpoints on %s",
    (axis) => {
      const doc = fixture(),
        extent = axis === "x" ? "width" : "height",
        coordinate = axis === "x" ? 4 : 5;
      ["a", "b", "c"].forEach((id, i) => {
        doc.nodes[id][extent] = i === 0 ? 200 : 1;
        doc.nodes[id].transform[coordinate] = i * 10;
      });
      const original = structuredClone(doc);
      expect(canDistribute(doc, ["a", "b", "c"], axis)).toBe(false);
      expect(distributeNodes(doc, ["a", "b", "c"], axis)).toBe(doc);
      expect(doc).toEqual(original);
    },
  );

  it("rejects target ties that would change the deterministic id order on the next invocation", () => {
    const doc = fixture();
    doc.nodes.page.children = [];
    doc.nodes = { page: doc.nodes.page };
    [
      ["z", 0, 20],
      ["y", 5, 10],
      ["a", 8, 20],
      ["q", 20, 10],
    ].forEach(([id, x, width]) =>
      add(
        doc,
        createNode("rectangle", "page", {
          id: String(id),
          width: Number(width),
          transform: [1, 0, 0, 1, Number(x), 0],
        }),
      ),
    );
    expect(canDistribute(doc, ["z", "y", "a", "q"], "x")).toBe(false);
    expect(distributeNodes(doc, ["z", "y", "a", "q"], "x")).toBe(doc);
  });

  it("rejects overflowing gap arithmetic without throwing or mutating", () => {
    const doc = fixture();
    for (const id of ["a", "b", "c"]) {
      doc.nodes[id].width = 1e308;
      doc.nodes[id].transform[4] = 0;
    }
    expect(canDistribute(doc, ["a", "b", "c"], "x")).toBe(false);
    expect(distributeNodes(doc, ["a", "b", "c"], "x")).toBe(doc);
  });

  it("breaks leading-edge ties by id independently of selection order", () => {
    const doc = fixture();
    doc.nodes.b.transform[4] = doc.nodes.a.transform[4];
    const first = distributeNodes(doc, ["c", "b", "a"], "x");
    const second = distributeNodes(doc, ["a", "c", "b"], "x");
    expect(first).toEqual(second);
    expect(first.nodes.a.transform).toEqual(doc.nodes.a.transform);
    expect(first.nodes.b.transform).not.toEqual(doc.nodes.b.transform);
  });

  it.each(["x", "y"] as const)(
    "preserves world linear geometry while distributing across affine parents on %s",
    (axis) => {
      const doc = fixture();
      doc.nodes.page.children = [];
      ["a", "b", "c"].forEach((id, i) => {
        const parentId = `parent-${id}`;
        add(
          doc,
          createNode("frame", "page", {
            id: parentId,
            children: [id],
            transform:
              i === 1
                ? [0.2, 1.5, -2, 0.3, 170, 80]
                : [1.1, 0.4, 0.3, 1.2, i * 240, i * 220],
          }),
        );
        doc.nodes[id].parentId = parentId;
      });
      const extent = axis === "x" ? "width" : "height";
      const ordered = ["a", "b", "c"].sort(
        (a, b) => getWorldBounds(doc, a)[axis] - getWorldBounds(doc, b)[axis],
      );
      const next = distributeNodes(doc, ["c", "a", "b"], axis);
      const bounds = ordered.map((id) => getWorldBounds(next, id));
      expect(bounds[1][axis] - bounds[0][axis] - bounds[0][extent]).toBeCloseTo(
        bounds[2][axis] - bounds[1][axis] - bounds[1][extent],
        10,
      );
      for (const id of ordered) {
        expect(getWorldTransform(next, id).slice(0, 4)).toEqual(
          getWorldTransform(doc, id).slice(0, 4),
        );
        expect(getWorldBounds(next, id)[axis === "x" ? "y" : "x"]).toBeCloseTo(
          getWorldBounds(doc, id)[axis === "x" ? "y" : "x"],
          10,
        );
      }
      expect(next.nodes[ordered[0]].transform).toEqual(
        doc.nodes[ordered[0]].transform,
      );
      expect(next.nodes[ordered[2]].transform).toEqual(
        doc.nodes[ordered[2]].transform,
      );
      expectOnlyTranslations(doc, next);
    },
  );
});

describe("eligibility and no-op identity", () => {
  it("excludes unknown ids, page, own hidden/locked nodes and hidden/locked ancestors from references", () => {
    const doc = fixture();
    for (const [id, properties] of [
      ["hidden", { visible: false }],
      ["locked", { locked: true }],
    ] as const) {
      add(doc, createNode("frame", "page", { id, ...properties }));
      add(
        doc,
        createNode("rectangle", id, {
          id: `${id}-child`,
          transform: [1, 0, 0, 1, -9000, -9000],
        }),
      );
    }
    const ids = [
      "a",
      "b",
      "page",
      "unknown",
      "hidden",
      "hidden-child",
      "locked",
      "locked-child",
    ];
    expect(arrangeableRoots(doc, ids)).toEqual(["a", "b"]);
    expect(alignNodes(doc, ids, "left").nodes.b.transform[4]).toBe(10);
    expect(distributeNodes(doc, ids, "x")).toBe(doc);
    doc.nodes.page.visible = false;
    expect(arrangeableRoots(doc, ["a", "b", "c"])).toEqual([]);
  });

  it("ignores singular-parent nodes and preserves the original for insufficient roots and sub-epsilon changes", () => {
    const doc = fixture();
    expect(alignNodes(doc, ["a", "missing"], "left")).toBe(doc);
    expect(distributeNodes(doc, ["a", "b"], "x")).toBe(doc);
    doc.nodes.b.transform[4] = doc.nodes.a.transform[4] + 1e-9;
    expect(alignNodes(doc, ["a", "b"], "left")).toBe(doc);
    doc.nodes.a.type = "frame";
    doc.nodes.a.transform = [0, 0, 0, 1, 0, 0];
    add(doc, createNode("rectangle", "a", { id: "singular-child" }));
    expect(arrangeableRoots(doc, ["singular-child", "b"])).toEqual(["b"]);
  });
});
