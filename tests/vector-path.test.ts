import { describe, it, expect } from "vitest";
import {
  createDemoDocument,
  createNode,
  validateDocument,
  updateNodes,
} from "../src/core";
import {
  parsePathData,
  pathBounds,
  serializeSegments,
  nodePathData,
  validVectorPath,
} from "../src/vector-path";
import { parseColor, parseTransform } from "../src/svg-import";
import { exportSvg } from "../src/renderers/svg";
import { strokePathData } from "../src/paints";
import { exportFrameWeb } from "../src/web-export";

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe("SVG path data normalization", () => {
  it("expands relative, shorthand and implicit commands to absolute M/L/C/Q/Z", () => {
    const { segments, error } = parsePathData("m10 10 20 0v20h-20zM0 0c10 0 10 10 20 10s10-10 20-10q5 5 10 0t10 0");
    expect(error).toBeUndefined();
    expect(serializeSegments(segments)).toBe(
      "M 10 10 L 30 10 L 30 30 L 10 30 Z M 0 0 C 10 0 10 10 20 10 C 30 10 30 0 40 0 Q 45 5 50 0 Q 55 -5 60 0",
    );
  });
  it("reads compact numbers and arc flags without separators", () => {
    const { segments, error } = parsePathData("M.5.5L1e1-2a5 5 0 105 5");
    expect(error).toBeUndefined();
    expect(segments[0]).toEqual({ c: "M", p: [0.5, 0.5] });
    expect(segments[1]).toEqual({ c: "L", p: [10, -2] });
    expect(segments.slice(2).every((s) => s.c === "C")).toBe(true);
    const last = segments.at(-1)!;
    expect(last.c === "C" && last.p.slice(4)).toEqual([15, 3]);
  });
  it("reads long numbers whole and keeps small coordinates precise", () => {
    const long = "1." + "0".repeat(80) + "1";
    expect(serializeSegments(parsePathData(`M${long} 2`).segments)).toBe("M 1 2");
    expect(serializeSegments(parsePathData("M0.00001234 0.5").segments)).toBe("M 0.00001234 0.5");
  });
  it("keeps the part before a syntax error, like browsers", () => {
    const { segments, error } = parsePathData("M0 0 L10 10 L20 x30");
    expect(error).toBeTruthy();
    expect(serializeSegments(segments)).toBe("M 0 0 L 10 10");
    expect(parsePathData("L0 0").segments).toEqual([]);
  });
  it("converts a full circle of arcs into cubics with exact bounds", () => {
    const { segments } = parsePathData("M0 50 A50 50 0 1 1 100 50 A50 50 0 1 1 0 50 Z");
    const b = pathBounds(segments)!;
    expect(close(b.x, 0, 1e-3) && close(b.y, 0, 0.05) && close(b.width, 100, 1e-3) && close(b.height, 100, 0.1)).toBe(true);
  });
  it("includes curve extrema in bounds, not control points", () => {
    const b = pathBounds(parsePathData("M0 0 C0 100 100 100 100 0").segments)!;
    expect(b.x).toBe(0);
    expect(b.width).toBe(100);
    expect(close(b.height, 75)).toBe(true);
    expect(pathBounds([])).toBeNull();
  });
});

describe("path nodes", () => {
  const pathDoc = () => {
    const doc = createDemoDocument();
    const node = createNode("path", doc.rootId, {
      id: "vector",
      width: 40,
      height: 20,
      fill: { type: "solid", color: "#336699" },
      path: { d: "M 0 0 L 40 0 L 40 20 Z", width: 40, height: 20, fillRule: "evenodd" },
    });
    doc.nodes[node.id] = node;
    doc.nodes[doc.rootId].children.push(node.id);
    return doc;
  };
  it("validates the normalized grammar and requires path data on path nodes", () => {
    expect(() => validateDocument(pathDoc())).not.toThrow();
    for (const bad of [
      { d: "M 0 0 A 1 1 0 0 1 2 2", width: 1, height: 1 },
      { d: 'M 0 0"/><script>', width: 1, height: 1 },
      { d: "L 0 0", width: 1, height: 1 },
      { d: "M 0 0", width: -1, height: 1 },
      { d: "M 0 0", width: 1, height: 1, fillRule: "winding" },
      { d: "M 0 0", width: 1, height: 1, extra: true },
    ])
      expect(validVectorPath(bad)).toBe(false);
    const missing = pathDoc();
    delete missing.nodes.vector.path;
    expect(() => validateDocument(missing)).toThrow();
    const misplaced = pathDoc();
    misplaced.nodes.vector.type = "rectangle";
    expect(() => validateDocument(misplaced)).toThrow();
  });
  it("scales path data with the node box and renders it in SVG and dashes", () => {
    const doc = updateNodes(pathDoc(), { vector: { width: 80, height: 10 } });
    expect(nodePathData(doc.nodes.vector)).toBe("M 0 0 L 80 0 L 80 10 Z");
    expect(strokePathData(doc.nodes.vector)).toBe("M 0 0 L 80 0 L 80 10 Z");
    const svg = exportSvg(doc);
    expect(svg).toContain('<path d="M 0 0 L 80 0 L 80 10 Z" fill-rule="evenodd" clip-rule="evenodd" fill="#336699"');
  });
  it("exports path geometry as inline SVG in HTML/CSS without a box background", () => {
    const doc = createDemoDocument();
    const frame = createNode("frame", doc.rootId, { id: "card", width: 100, height: 50, fill: { type: "none" }, children: ["vector"] });
    const node = createNode("path", "card", {
      id: "vector",
      width: 40,
      height: 20,
      fill: { type: "solid", color: "#336699" },
      stroke: { color: "#000000", width: 2, dash: [3, 1] },
      path: { d: "M 0 0 L 40 0 L 40 20 Z", width: 40, height: 20 },
    });
    Object.assign(doc.nodes, { card: frame, vector: node });
    doc.nodes[doc.rootId].children.push("card");
    const web = exportFrameWeb(doc, "card");
    expect(web.html).toContain('<path d="M 0 0 L 40 0 L 40 20 Z" fill-rule="nonzero" fill="rgba(51,102,153,1)"/>');
    expect(web.html).toContain('stroke-dasharray="3 1"');
    expect(web.css).not.toMatch(/background-image:linear-gradient\(rgba\(51,102,153/);
    expect(web.warnings.some((w) => w.includes("stroke는 생략"))).toBe(false);
  });
  it("draws a zero-height line in HTML/CSS export", () => {
    const doc = createDemoDocument();
    const frame = createNode("frame", doc.rootId, { id: "card", width: 100, height: 50, fill: { type: "none" }, children: ["rule"] });
    const line = createNode("path", "card", {
      id: "rule",
      width: 80,
      height: 0,
      fill: { type: "none" },
      stroke: { color: "#999999", width: 1 },
      path: { d: "M 0 0 L 80 0", width: 80, height: 0 },
    });
    Object.assign(doc.nodes, { card: frame, rule: line });
    doc.nodes[doc.rootId].children.push("card");
    const html = exportFrameWeb(doc, "card").html;
    expect(html).toContain('<svg aria-hidden="true" width="80" height="1" style="display:block;overflow:visible">');
    expect(html).not.toContain("viewBox");
  });
  it("keeps a zero-height line at its authored height", () => {
    const node = createNode("path", null, {
      width: 50,
      height: 0,
      path: { d: "M 0 0 L 25 0", width: 25, height: 0 },
    });
    expect(nodePathData(node)).toBe("M 0 0 L 50 0");
  });
});

describe("SVG attribute values", () => {
  it("parses transform lists in order", () => {
    expect(parseTransform("translate(10 20) scale(2)")).toEqual([2, 0, 0, 2, 10, 20]);
    const r = parseTransform("rotate(90 10 10)")!;
    expect(r.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 1, -1, 0, 20, 0]);
    expect(parseTransform("matrix(1,0,0,1,5,6), translate(1)")).toEqual([1, 0, 0, 1, 6, 6]);
    expect(parseTransform("skewX(45)")!.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([1, 0, 1, 1, 0, 0]);
    expect(parseTransform("translate(10) bogus(1)")).toBeNull();
    expect(parseTransform(null)).toEqual([1, 0, 0, 1, 0, 0]);
  });
  it("parses CSS colours into hex and alpha", () => {
    expect(parseColor("#ABC")).toEqual({ color: "#aabbcc", alpha: 1 });
    expect(parseColor("#11223380")?.alpha).toBeCloseTo(128 / 255);
    expect(parseColor("rgb(255, 0, 0)")).toEqual({ color: "#ff0000", alpha: 1 });
    expect(parseColor("rgba(0 128 255 / 50%)")).toEqual({ color: "#0080ff", alpha: 0.5 });
    expect(parseColor("hsl(120, 100%, 50%)")).toEqual({ color: "#00ff00", alpha: 1 });
    expect(parseColor("RebeccaPurple")).toEqual({ color: "#663399", alpha: 1 });
    expect(parseColor("currentColor", "#123456")).toEqual({ color: "#123456", alpha: 1 });
    expect(parseColor("transparent")?.alpha).toBe(0);
    expect(parseColor("url(#x)")).toBeUndefined();
    expect(parseColor("#12")).toBeUndefined();
  });
});
