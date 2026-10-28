import { describe, it, expect } from "vitest";
import {
  createDemoDocument,
  serializeDocument,
  parseDocument,
  DocumentHistory,
} from "../src/core";
import {
  nodeFills,
  sortedStops,
  dashIntervals,
  gradientRadius,
} from "../src/paints";
import { exportSvg } from "../src/renderers/svg";
const fixture = () => {
  const doc = createDemoDocument();
  const node = Object.values(doc.nodes).find((n) => n.type === "rectangle")!;
  node.fills = [
    { type: "solid", color: "#f008", opacity: 0.7 },
    {
      type: "radial",
      from: [0.5, 0.5],
      to: [1, 0.5],
      opacity: 0.6,
      stops: [
        { offset: 0, color: "#ff0000", opacity: 0.5 },
        { offset: 1, color: "#0000ff00" },
      ],
    },
  ];
  node.stroke = {
    color: "#0008",
    width: 7,
    position: "outside",
    dash: [8, 4, 2],
    opacity: 0.8,
  };
  return { doc, node };
};
describe("editable fill stacks and stroke authoring", () => {
  it("round trips additive fields and preserves legacy single fills", () => {
    const { doc, node } = fixture();
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
    delete node.fills;
    expect(nodeFills(node)).toEqual([node.fill]);
    node.fills = [];
    expect(nodeFills(node)).toEqual([]);
  });
  it("keeps all paint properties through undo/redo", () => {
    const { doc, node } = fixture();
    const h = new DocumentHistory(doc);
    const next = structuredClone(doc);
    next.nodes[node.id].fills!.reverse();
    h.execute(next);
    h.undo();
    expect(h.document).toEqual(doc);
    h.redo();
    expect(h.document).toEqual(next);
  });
  it.each([
    (n: any) => (n.fills[1].stops[0].offset = 2),
    (n: any) => (n.fills[1].stops[0].opacity = 2),
    (n: any) => (n.fills[0].opacity = -1),
    (n: any) => (n.fills[1].from = [NaN, 0]),
    (n: any) => (n.stroke.dash = [0, 4]),
    (n: any) => (n.stroke.position = "inset"),
    (n: any) => (n.stroke.opacity = Infinity),
    (n: any) => (n.fills[0].color = "url(https://example.com)"),
  ])("rejects invalid paint data before replacement (%#)", (mutate) => {
    const { doc, node } = fixture();
    mutate(node);
    expect(() => parseDocument(JSON.stringify(doc))).toThrow();
  });
  it("sorts duplicate stops stably and repeats odd dash sequences", () => {
    expect(
      sortedStops([
        { offset: 1, color: "#fff" },
        { offset: 0.5, color: "#f00" },
        { offset: 0.5, color: "#00f" },
      ]).map((s) => s.color),
    ).toEqual(["#f00", "#00f", "#fff"]);
    expect(dashIntervals([1, 2, 3])).toEqual([1, 2, 3, 1, 2, 3]);
  });
  it("defines radial circles in local pixels on non-square boxes", () => {
    const { node } = fixture();
    node.width = 200;
    node.height = 80;
    expect(gradientRadius(node, node.fills![1] as any)).toBe(100);
  });
  it("exports separate opacity, radial stops and outside dash masks", () => {
    const { doc } = fixture();
    const svg = exportSvg(doc);
    expect(svg).toContain("<radialGradient");
    expect(svg).toContain('fill-opacity="0.6"');
    expect(svg).toContain('stop-opacity="0.5"');
    expect(svg).toContain('stroke-width="14"');
    expect(svg).toContain('stroke-dasharray="8 4 2 8 4 2"');
    expect(svg).toContain('maskUnits="userSpaceOnUse"');
  });
  it("clips an inside stroke and keeps text glyph strokes centered", () => {
    const { doc, node } = fixture();
    node.stroke!.position = "inside";
    expect(exportSvg(doc)).toContain("stroke-clip");
    const text = Object.values(doc.nodes).find((n) => n.type === "text")!;
    text.stroke = { width: 5, color: "#000", position: "outside" };
    expect(exportSvg(doc)).toContain('stroke-width="5"');
  });
});
