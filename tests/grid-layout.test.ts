import { expect, it } from "vitest";
import {
  createNode,
  DocumentHistory,
  parseDocument,
  serializeDocument,
  updateNodes,
  validateDocument,
  type SceneNode,
  type SceneDocument,
} from "../src/core";
import { computeLayout, type Layout } from "../src/flex-layout";
import { gridAreas, parseGridTracks, validGrid } from "../src/grid-layout";
const fill: Layout = { mode: "absolute", width: "fill", height: "fill" };
function fixture(
  grid: Layout["grid"],
  children: Partial<SceneNode>[] = [{}, {}, {}],
  layout: Partial<Layout> = {},
): SceneDocument {
  return {
    schemaVersion: 1,
    id: "grid",
    name: "Grid",
    rootId: "page",
    assets: {},
    nodes: {
      page: createNode("page", null, { id: "page", children: ["frame"] }),
      frame: createNode("frame", "page", {
        id: "frame",
        width: 300,
        height: 200,
        children: children.map((_, i) => `c${i}`),
        layout: { mode: "grid", grid, ...layout },
      }),
      ...Object.fromEntries(
        children.map((c, i) => [
          `c${i}`,
          createNode("rectangle", "frame", {
            id: `c${i}`,
            width: 50,
            height: 20,
            transform: [0, 1, -1, 0, 91, 82],
            layout: fill,
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
it("allocates px, weighted zero-min fr tracks and gaps inside padding", () => {
  const d = fixture(
    { columns: [60, { fr: 1 }, { fr: 2 }], rows: [50] },
    undefined,
    { gap: 10, padding: [10, 10, 10, 10] },
  );
  const before = structuredClone(d),
    r = computeLayout(d);
  expect(box(r.nodes.c0)).toEqual([10, 10, 60, 50]);
  expect(r.nodes.c1.width).toBeCloseTo(200 / 3);
  expect(r.nodes.c2.width).toBeCloseTo(400 / 3);
  expect(r.nodes.c0.transform.slice(0, 4)).toEqual([0, 1, -1, 0]);
  expect(d).toEqual(before);
});
it("fr sums below one retain partial free space", () => {
  const r = computeLayout(
    fixture({ columns: [{ fr: 0.25 }, { fr: 0.25 }], rows: [20] }, [{}, {}]),
  );
  expect(box(r.nodes.c1)).toEqual([75, 0, 75, 20]);
});
it("sizes auto from intrinsic contribution then stretches remaining space", () => {
  const r = computeLayout(
    fixture({ columns: ["auto", "auto"], rows: [20] }, [
      { width: 80 },
      { width: 40 },
    ]),
  );
  expect(box(r.nodes.c0)).toEqual([0, 0, 170, 20]);
  expect(box(r.nodes.c1)).toEqual([170, 0, 130, 20]);
});
it("auto alongside fr keeps intrinsic size", () => {
  const r = computeLayout(
    fixture({ columns: ["auto", { fr: 1 }], rows: [20] }, [{ width: 80 }, {}]),
  );
  expect(r.nodes.c0.width).toBe(80);
  expect(r.nodes.c1.width).toBe(220);
});
it("spans include internal gutters and explicit overlapping areas remain overlapped", () => {
  const r = computeLayout(
    fixture(
      { columns: [70, 80], rows: [40, 50], areas: ["hero hero", "nav main"] },
      [
        { layout: { ...fill, grid: { area: "hero" } } },
        {
          layout: {
            ...fill,
            grid: { column: 1, row: 1, columnSpan: 2, rowSpan: 2 },
          },
        },
        { layout: { ...fill, grid: { area: "main" } } },
      ],
      { gap: 10 },
    ),
  );
  expect(box(r.nodes.c0)).toEqual([0, 0, 160, 40]);
  expect(box(r.nodes.c1)).toEqual([0, 0, 160, 100]);
  expect(box(r.nodes.c2)).toEqual([80, 50, 80, 50]);
});
it("explicit cells reserve space before row-major sparse auto placement", () => {
  const r = computeLayout(
    fixture({ columns: [60, 60], autoRows: 30 }, [
      {},
      { layout: { ...fill, grid: { row: 1, column: 1 } } },
      {},
    ]),
  );
  expect(box(r.nodes.c0)).toEqual([60, 0, 60, 30]);
  expect(box(r.nodes.c2)).toEqual([0, 30, 60, 30]);
});
it("handles row-locked and column-locked placement and implicit tracks", () => {
  const r = computeLayout(
    fixture({ columns: [60, 60], autoRows: 30, autoColumns: 40 }, [
      { layout: { ...fill, grid: { row: 1, column: 2 } } },
      { layout: { ...fill, grid: { row: 1, columnSpan: 2 } } },
      { layout: { ...fill, grid: { column: 1 } } },
    ]),
  );
  expect(box(r.nodes.c1)).toEqual([120, 0, 80, 30]);
  expect(box(r.nodes.c2)).toEqual([0, 0, 60, 30]);
});
it("hidden and absolute items do not consume cells; locked items do", () => {
  const r = computeLayout(
    fixture({ columns: [100], autoRows: 30 }, [
      { visible: false },
      { layout: { ...fill, position: "absolute" } },
      { locked: true },
    ]),
  );
  expect(box(r.nodes.c2)).toEqual([0, 0, 100, 30]);
  expect(r.nodes.c1.transform.slice(4)).toEqual([91, 82]);
});
it("retains fixed sizes, constrains fill and allows signed end alignment", () => {
  const r = computeLayout(
    fixture(
      { columns: [100], rows: [20] },
      [{ layout: { ...fill, minWidth: 120, minHeight: 30 } }],
      { align: "end" },
    ),
  );
  expect(box(r.nodes.c0)).toEqual([0, -10, 120, 30]);
});
it("hug containers retain intrinsic tracks and child spanning contributions", () => {
  const r = computeLayout(
    fixture(
      { columns: ["auto", "auto"], autoRows: "auto" },
      [{ width: 120, layout: { ...fill, grid: { columnSpan: 2 } } }],
      { width: "hug", height: "hug", gap: 10, padding: [5, 5, 5, 5] },
    ),
  );
  expect([r.nodes.frame.width, r.nodes.frame.height]).toEqual([130, 30]);
  expect(box(r.nodes.c0)).toEqual([5, 5, 120, 20]);
});
it("measures wrapped text after column allocation before hug row sizing", () => {
  const d = fixture(
    { columns: [100], autoRows: "auto" },
    [
      {
        type: "text",
        layout: { mode: "absolute", width: "fill", height: "hug" },
        text: {
          content: "abcdefghijabcdefghij",
          fontFamily: "monospace",
          fontSize: 10,
          fontWeight: 400,
          lineHeight: 15,
          sizing: "auto-height",
        },
      },
      {},
    ],
    { height: "hug" },
  );
  const r = computeLayout(d, (text) => text.length * 10);
  expect(r.nodes.c0.height).toBe(30);
  expect(r.nodes.c1.transform[5]).toBe(30);
  expect(r.nodes.frame.height).toBe(50);
  expect(new DocumentHistory(d).document.nodes.c0.height).toBe(20);
});
it("supports nested Flex in Grid and Grid in Flex", () => {
  const d = fixture({ columns: [{ fr: 1 }], rows: [100] }, [
    {
      type: "frame",
      layout: {
        mode: "flex",
        width: "fill",
        height: "fill",
        direction: "column",
      },
      children: ["inner"],
    },
  ]);
  d.nodes.inner = createNode("frame", "c0", {
    id: "inner",
    width: 20,
    height: 20,
    layout: {
      mode: "grid",
      width: "fill",
      height: "fill",
      grid: { columns: [{ fr: 1 }], rows: [{ fr: 1 }] },
    },
    children: ["leaf"],
  });
  d.nodes.leaf = createNode("rectangle", "inner", { id: "leaf", layout: fill });
  const r = computeLayout(d);
  expect([r.nodes.leaf.width, r.nodes.leaf.height]).toEqual([300, 100]);
});
it("preserves source rules through validation, history and JSON", () => {
  const d = fixture({ columns: [50, { fr: 1 }], areas: ["a b"] });
  validateDocument(d);
  const h = new DocumentHistory(d);
  h.execute(
    updateNodes(d, { frame: { layout: { ...d.nodes.frame.layout, gap: 14 } } }),
  );
  const after = h.document;
  computeLayout(after);
  expect(parseDocument(serializeDocument(after))).toEqual(after);
  h.undo();
  expect(h.document).toEqual(d);
  h.redo();
  expect(h.document).toEqual(after);
});
it("rejects invalid Grid settings and non-frame containers at document boundary", () => {
  for (const grid of [
    null,
    { columns: [] },
    { columns: [-1] },
    { rows: [Infinity] },
    { columns: [{ fr: 0 }] },
    { columns: [{ fr: NaN }] },
    { column: 1.2 },
    { row: 0 },
    { columnSpan: 129 },
    { area: "bad name" },
    { areas: ["x x", "x ."] },
    { areas: ["a b", "a"] },
    { autoRows: "1fr" },
  ]) {
    expect(validGrid(grid)).toBe(false);
    const d = fixture(undefined);
    d.nodes.frame.layout.grid = grid as never;
    expect(() => validateDocument(d)).toThrow();
  }
  const d = fixture(undefined);
  d.nodes.c0.layout.mode = "grid";
  expect(() => validateDocument(d)).toThrow();
});
it("parses tracks without accepting unsupported CSS syntax", () => {
  expect(parseGridTracks("60px 1.5fr auto .5fr 0")).toEqual([
    60,
    { fr: 1.5 },
    "auto",
    { fr: 0.5 },
    0,
  ]);
  for (const s of ["repeat(2, 1fr)", "-1px", "0fr", "100%", "NaN", "1e3px"])
    expect(() => parseGridTracks(s)).toThrow();
  expect(parseGridTracks(" ")).toBeUndefined();
  expect(() => gridAreas(["a .", "a a"])).toThrow();
  expect(() => gridAreas([". a", "a a"])).toThrow();
  expect(validGrid({ areas: [". a", "a a"] })).toBe(false);
});
it("does not feed allocated span width back into auto intrinsic columns", () => {
  const d = fixture({ columns: ["auto", { fr: 1 }], rows: [20, 20] }, [
    { layout: { ...fill, grid: { row: 1, column: 1, columnSpan: 2 } } },
    { layout: { ...fill, grid: { row: 2, column: 2 } } },
  ]);
  const r = computeLayout(d);
  expect(box(r.nodes.c1)).toEqual([50, 20, 250, 20]);
});
it("measures hug rows after max-width constrains fractional columns", () => {
  const d = fixture(
    { columns: [{ fr: 1 }], autoRows: "auto" },
    [
      {
        type: "text",
        width: 200,
        layout: { mode: "absolute", width: "fill", height: "hug" },
        text: {
          content: "abcdefghijabcdefghij",
          fontFamily: "monospace",
          fontSize: 10,
          fontWeight: 400,
          lineHeight: 15,
          sizing: "auto-height",
        },
      },
      {},
    ],
    { width: "hug", height: "hug", maxWidth: 100 },
  );
  const r = computeLayout(d, (s) => s.length * 10);
  expect(r.nodes.frame.height).toBe(50);
  expect(r.nodes.c1.transform[5]).toBe(30);
});
it("keeps weighted fractional ratios in hug containers", () => {
  const r = computeLayout(
    fixture({ columns: [{ fr: 1 }, { fr: 2 }], rows: [20] }, [{}, {}], {
      width: "hug",
    }),
  );
  expect(r.nodes.frame.width).toBe(150);
  expect(r.nodes.c0.width).toBe(50);
  expect(r.nodes.c1.width).toBe(100);
});
it("does not backfill holes for successive row-locked sparse items", () => {
  const r = computeLayout(
    fixture({ columns: [60, 60, 60], autoColumns: 60, autoRows: 30 }, [
      { layout: { ...fill, grid: { row: 1, column: 2 } } },
      { layout: { ...fill, grid: { row: 1, columnSpan: 2 } } },
      { layout: { ...fill, grid: { row: 1 } } },
    ]),
  );
  expect([
    r.nodes.c0.transform[4],
    r.nodes.c1.transform[4],
    r.nodes.c2.transform[4],
  ]).toEqual([60, 120, 240]);
});
