import { expect, it } from "vitest";
import {
  createDemoDocument,
  createNode,
  DocumentHistory,
  parseDocument,
  serializeDocument,
  updateNodes,
  validateDocument,
} from "../src/core";
import { computeLayout } from "../src/flex-layout";
it("rejects malformed or contradictory layout settings at import/storage boundary", () => {
  const d = createDemoDocument(),
    frame = Object.values(d.nodes).find((n) => n.type === "frame")!;
  for (const layout of [
    { mode: "unsupported" },
    { mode: "flex", gap: -1 },
    { mode: "flex", gap: Infinity },
    { mode: "flex", padding: [0, 1, 2] },
    { mode: "flex", padding: [0, -1, 0, 0] },
    { mode: "flex", align: "baseline" },
    { mode: "flex", width: "auto" },
    { mode: "flex", wrap: 1 },
    { mode: "flex", minWidth: 20, maxWidth: 10 },
  ]) {
    const copy = structuredClone(d);
    copy.nodes[frame.id].layout = layout as never;
    expect(() => validateDocument(copy)).toThrow();
  }
  const leaf = Object.values(d.nodes).find((n) => n.type === "rectangle")!;
  expect(() =>
    updateNodes(d, { [leaf.id]: { layout: { mode: "flex" } } }),
  ).toThrow();
});
it("keeps layout source through history, JSON roundtrip and computed geometry", () => {
  const d = createDemoDocument(),
    frame = Object.values(d.nodes).find((n) => n.type === "frame")!;
  const h = new DocumentHistory(d),
    before = h.document;
  h.execute(
    updateNodes(before, {
      [frame.id]: {
        layout: {
          mode: "flex",
          direction: "column",
          gap: 13,
          padding: [10, 11, 12, 13],
          height: "hug",
        },
      },
    }),
  );
  const source = h.document,
    computed = computeLayout(source);
  expect(computed.nodes[frame.children[0]].transform).not.toEqual(
    source.nodes[frame.children[0]].transform,
  );
  expect(parseDocument(serializeDocument(source))).toEqual(source);
  expect(h.committedDocument).toEqual(source);
  h.undo();
  expect(h.document).toEqual(before);
  h.redo();
  expect(h.document).toEqual(source);
});
it("does not normalize flex text computed bounds back into the authoring model", () => {
  const d = createDemoDocument(),
    frame = Object.values(d.nodes).find((n) => n.type === "frame")!;
  const child = createNode("text", frame.id, {
    id: "flex-text",
    width: 120,
    height: 8,
    layout: { mode: "absolute", width: "fill", height: "hug" },
    text: {
      content: "long text ".repeat(10),
      fontFamily: "monospace",
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 24,
      sizing: "auto-height",
    },
  });
  d.nodes[child.id] = child;
  frame.children.push(child.id);
  frame.layout = { mode: "flex", direction: "column" };
  const h = new DocumentHistory(d);
  expect(h.document.nodes[child.id].height).toBe(8);
  expect(computeLayout(h.document).nodes[child.id].height).toBeGreaterThan(8);
});
