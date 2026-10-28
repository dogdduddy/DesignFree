import { describe, expect, it } from "vitest";
import { createNode, type SceneDocument, type SceneNode } from "../src/core";
import { computeLayout, type Layout } from "../src/flex-layout";

function fixture(
  layout: Layout = { mode: "flex" },
  children: Partial<SceneNode>[] = [],
): SceneDocument {
  const page = createNode("page", null, { id: "page", children: ["frame"] });
  const frame = createNode("frame", "page", {
    id: "frame",
    width: 300,
    height: 200,
    children: children.map((_, i) => `c${i}`),
    layout,
  });
  return {
    schemaVersion: 1,
    id: "d",
    name: "Flex",
    rootId: "page",
    assets: {},
    nodes: {
      page,
      frame,
      ...Object.fromEntries(
        children.map((c, i) => [
          `c${i}`,
          createNode("rectangle", "frame", {
            id: `c${i}`,
            width: 50,
            height: 20,
            ...c,
          }),
        ]),
      ),
    },
  };
}
const box = (n: SceneNode) => [
  n.transform[4],
  n.transform[5],
  n.width,
  n.height,
];

describe("computed flex geometry", () => {
  it("detaches all computed state and preserves transform linear parts", () => {
    const doc = fixture({ mode: "flex", padding: [10, 20, 30, 40], gap: 5 }, [
      { transform: [0, 1, -1, 0, 90, 80] },
      {},
    ]);
    const before = structuredClone(doc),
      out = computeLayout(doc);
    expect(doc).toEqual(before);
    expect(box(out.nodes.c0)).toEqual([40, 10, 50, 20]);
    expect(box(out.nodes.c1)).toEqual([95, 10, 50, 20]);
    expect(out.nodes.c0.transform.slice(0, 4)).toEqual([0, 1, -1, 0]);
    out.nodes.frame.layout.gap = 99;
    expect(doc.nodes.frame.layout.gap).toBe(5);
  });
  it("allocates equal zero-basis fill with min/max freezing", () => {
    const out = computeLayout(
      fixture({ mode: "flex", gap: 10 }, [
        { layout: { mode: "absolute", width: "fill", minWidth: 150 } },
        { layout: { mode: "absolute", width: "fill", maxWidth: 40 } },
        { layout: { mode: "absolute", width: "fill" } },
      ]),
    );
    expect([
      out.nodes.c0.width,
      out.nodes.c1.width,
      out.nodes.c2.width,
    ]).toEqual([150, 40, 90]);
    expect(out.nodes.c2.transform[4]).toBe(210);
  });
  it("redistributes opposing min/max violations without false overflow", () => {
    const doc = fixture({ mode: "flex" }, [
      { layout: { mode: "absolute", width: "fill", minWidth: 200 } },
      { layout: { mode: "absolute", width: "fill", maxWidth: 80 } },
      { layout: { mode: "absolute", width: "fill" } },
    ]);
    doc.nodes.frame.width = 250;
    const out = computeLayout(doc);
    expect([
      out.nodes.c0.width,
      out.nodes.c1.width,
      out.nodes.c2.width,
    ]).toEqual([200, 25, 25]);
  });
  it("keeps max-constrained hug text geometry authoritative for rendering", () => {
    const doc = fixture({ mode: "flex" }, [
      {
        type: "text",
        text: {
          content: "abcdefgh",
          fontFamily: "monospace",
          fontSize: 10,
          fontWeight: 400,
          lineHeight: 12,
        },
        layout: { mode: "absolute", width: "hug", height: "hug", maxWidth: 30 },
      },
    ]);
    const out = computeLayout(doc, (value) => value.length * 10);
    expect(out.nodes.c0.width).toBe(30);
    expect(out.nodes.c0.height).toBe(36);
    expect(out.nodes.c0.text?.sizing).toBe("auto-height");
  });
  it("retains fixed overflow and fill minimum without negative geometry", () => {
    const out = computeLayout(
      fixture({ mode: "flex" }, [
        { width: 320 },
        { layout: { mode: "absolute", width: "fill", minWidth: 20 } },
      ]),
    );
    expect(box(out.nodes.c1)).toEqual([320, 0, 20, 20]);
  });
  it("packs wrap lines and resolves hug height after wrapping", () => {
    const out = computeLayout(
      fixture(
        {
          mode: "flex",
          gap: 10,
          padding: [5, 5, 5, 5],
          wrap: true,
          height: "hug",
        },
        [{ width: 150 }, { width: 150, height: 30 }, { width: 100 }],
      ),
    );
    expect(box(out.nodes.c0)).toEqual([5, 5, 150, 20]);
    expect(box(out.nodes.c1)).toEqual([5, 35, 150, 30]);
    expect(box(out.nodes.c2)).toEqual([165, 35, 100, 20]);
    expect(out.nodes.frame.height).toBe(70);
  });
  it("retains the CSS padding floor when fixed or max size is smaller", () => {
    const doc = fixture({
      mode: "flex",
      padding: [20, 30, 20, 30],
      maxWidth: 10,
    });
    doc.nodes.frame.width = 5;
    doc.nodes.frame.height = 5;
    const out = computeLayout(doc);
    expect(out.nodes.frame.width).toBe(60);
    expect(out.nodes.frame.height).toBe(40);
  });
  it("uses border-box max constrained hug wrapping", () => {
    const out = computeLayout(
      fixture(
        {
          mode: "flex",
          width: "hug",
          height: "hug",
          maxWidth: 100,
          wrap: true,
          gap: 5,
        },
        [{ width: 80 }, { width: 80 }],
      ),
    );
    expect(out.nodes.frame.width).toBe(100);
    expect(out.nodes.frame.height).toBe(45);
  });
  it("excludes hidden and absolute items from flow and hug", () => {
    const doc = fixture({ mode: "flex", width: "hug", height: "hug" }, [
      { width: 40 },
      { visible: false, width: 1000 },
      {
        width: 900,
        layout: { mode: "absolute", position: "absolute" },
        transform: [1, 0, 0, 1, 13, 17],
      },
    ]);
    const out = computeLayout(doc);
    expect(box(out.nodes.frame).slice(2)).toEqual([40, 20]);
    expect(out.nodes.c2.transform).toEqual(doc.nodes.c2.transform);
    expect(out.nodes.c1.transform).toEqual(doc.nodes.c1.transform);
  });
  it("resolves nested column fill before child row layout", () => {
    const doc = fixture(
      { mode: "flex", direction: "column", padding: [10, 10, 10, 10] },
      [
        {
          type: "frame",
          height: 80,
          children: ["nested"],
          layout: { mode: "flex", width: "fill", padding: [5, 5, 5, 5] },
        },
      ],
    );
    doc.nodes.nested = createNode("rectangle", "c0", {
      id: "nested",
      layout: { mode: "absolute", width: "fill", height: "fill" },
    });
    const out = computeLayout(doc);
    expect(box(out.nodes.c0)).toEqual([10, 10, 280, 80]);
    expect(box(out.nodes.nested)).toEqual([5, 5, 270, 70]);
  });
  it.each(["fixed", "hug"] as const)(
    "uses completed nested wrap height in %s column parents",
    (height) => {
      const doc = fixture({ mode: "flex", direction: "column", height }, [
        {
          type: "frame",
          width: 100,
          children: ["a", "b"],
          layout: { mode: "flex", wrap: true, height: "hug" },
        },
        { width: 50, height: 10 },
      ]);
      for (const id of ["a", "b"])
        doc.nodes[id] = createNode("rectangle", "c0", {
          id,
          width: 80,
          height: 20,
        });
      const out = computeLayout(doc);
      expect(out.nodes.c0.height).toBe(40);
      expect(out.nodes.c1.transform[5]).toBe(40);
      if (height === "hug") expect(out.nodes.frame.height).toBe(50);
    },
  );
  it("uses intrinsic authored fallback for fill under a hug parent", () => {
    const out = computeLayout(
      fixture({ mode: "flex", width: "hug", height: "hug", gap: 10 }, [
        { width: 80, layout: { mode: "absolute", width: "fill" } },
        { width: 20 },
      ]),
    );
    expect(out.nodes.frame.width).toBe(110);
    expect(out.nodes.c0.width).toBe(80);
  });
  it.each([
    ["center", 100],
    ["end", 200],
    ["space-between", 0],
    ["space-around", 50],
    ["space-evenly", 200 / 3],
  ] as const)("supports %s justification", (justify, x) => {
    const out = computeLayout(
      fixture({ mode: "flex", justify, align: "end" }, [{}, {}]),
    );
    expect(out.nodes.c0.transform[4]).toBeCloseTo(x);
    expect(out.nodes.c0.transform[5]).toBe(180);
  });
  it.each([
    ["center", -50],
    ["end", -100],
    ["space-between", 0],
    ["space-around", 0],
    ["space-evenly", 0],
  ] as const)(
    "uses CSS overflow fallback for %s justification",
    (justify, x) => {
      const out = computeLayout(
        fixture({ mode: "flex", justify }, [{ width: 250 }, { width: 150 }]),
      );
      expect(out.nodes.c0.transform[4]).toBe(x);
      expect(out.nodes.c1.transform[4]).toBe(x + 250);
    },
  );
  it.each([
    ["center", -50],
    ["end", -100],
  ] as const)("retains signed %s cross overflow", (align, y) => {
    const out = computeLayout(
      fixture({ mode: "flex", align }, [{ height: 300 }]),
    );
    expect(out.nodes.c0.transform[5]).toBe(y);
  });
  it("stretches explicit cross fill while fixed sizes retain alignment", () => {
    const out = computeLayout(
      fixture({ mode: "flex", align: "stretch" }, [
        {},
        { layout: { mode: "absolute", height: "fill", maxHeight: 150 } },
      ]),
    );
    expect(out.nodes.c0.height).toBe(20);
    expect(out.nodes.c1.height).toBe(150);
  });
  it("measures hug text with injected metrics and wraps fill-width text", () => {
    const doc = fixture({ mode: "flex", direction: "column" }, [
      {
        type: "text",
        text: {
          content: "abcdefgh",
          fontFamily: "monospace",
          fontSize: 10,
          fontWeight: 400,
          lineHeight: 12,
        },
        layout: { mode: "absolute", width: "fill", height: "hug" },
      },
      {},
    ]);
    doc.nodes.frame.width = 30;
    const out = computeLayout(doc, (value) => value.length * 10);
    expect(out.nodes.c0.height).toBe(36);
    expect(out.nodes.c1.transform[5]).toBe(36);
    expect(doc.nodes.c0.text?.sizing).toBeUndefined();
    expect(out.nodes.c0.text?.sizing).toBe("auto-height");
  });
});
