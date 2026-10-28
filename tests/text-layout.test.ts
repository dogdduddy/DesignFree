import { describe, expect, it } from "vitest";
import { transformFrame, resizeSelection } from "../src/transforms";
import {
  createNode,
  createDemoDocument,
  updateNodes,
  DocumentHistory,
  parseDocument,
  serializeDocument,
} from "../src/core";
import { textLayout, missingFont, resolvedFont } from "../src/text-layout";
import { exportSvg } from "../src/renderers/svg";
const node = (text = {}) =>
  createNode("text", null, {
    width: 25,
    height: 80,
    text: {
      content: "가나다라",
      fontFamily: "Noto Sans KR",
      fontWeight: 400,
      fontSize: 10,
      lineHeight: 14,
      sizing: "fixed",
      ...text,
    },
  });
const measure = (s: string) => Array.from(s).length * 10;
describe("text authoring layout", () => {
  it("wraps Korean graphemes at fixed width without changing authored bounds", () => {
    const result = textLayout(node(), measure);
    expect(result.lines.map((l) => l.content)).toEqual(["가나", "다라"]);
    expect([result.width, result.height]).toEqual([25, 80]);
  });
  it("preserves empty paragraphs, spaces, trailing newline and oversized glyphs", () => {
    const n = node({ content: "가\n\n나 \n" });
    n.width = 5;
    expect(textLayout(n, measure).lines.map((l) => l.content)).toEqual([
      "가",
      "",
      "나",
      " ",
      "",
    ]);
  });
  it("keeps combined graphemes intact", () => {
    const n = node({ content: "👨‍👩‍👧‍👦a" });
    n.width = 1;
    expect(textLayout(n, measure).lines.map((l) => l.content)).toEqual([
      "👨‍👩‍👧‍👦",
      "a",
    ]);
  });
  it("auto width uses longest explicit line and auto height wraps", () => {
    expect(
      textLayout(node({ sizing: "auto-width", content: "abc\nx" }), measure),
    ).toMatchObject({ width: 30, height: 28 });
    expect(textLayout(node({ sizing: "auto-height" }), measure)).toMatchObject({
      width: 25,
      height: 28,
    });
  });
  it("positions center/right lines and applies positive and negative tracking", () => {
    expect(
      textLayout(
        node({ content: "ab", align: "center", letterSpacing: 2 }),
        measure,
      ).lines[0].x,
    ).toBe(1.5);
    expect(
      textLayout(
        node({ content: "ab", align: "right", letterSpacing: -2 }),
        measure,
      ).lines[0].x,
    ).toBe(7);
    expect(textLayout(node({ letterSpacing: 8 }), measure).lines).toHaveLength(
      4,
    );
  });
  it("preserves legacy newline-only files and labels unsupported families", () => {
    expect(textLayout(node({ sizing: undefined }), measure).lines).toHaveLength(
      1,
    );
    expect(missingFont("Unknown Font")).toBe(true);
    expect(resolvedFont("Unknown Font")).toBe("Noto Sans KR");
    expect(missingFont("monospace")).toBe(false);
  });
  it("validates new optional fields without breaking old documents", () => {
    const doc = createDemoDocument();
    const n = Object.values(doc.nodes).find((n) => n.text)!;
    for (const invalid of [
      { align: "justify" },
      { sizing: "bad" },
      { letterSpacing: Infinity },
    ]) {
      expect(() =>
        updateNodes(doc, {
          [n.id]: { text: { ...n.text!, ...invalid } as any },
        }),
      ).toThrow();
    }
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
  });
  it("commits text geometry with one undo, redo and JSON roundtrip", () => {
    const doc = createDemoDocument();
    const n = Object.values(doc.nodes).find((n) => n.text)!;
    const history = new DocumentHistory(doc);
    const changed = updateNodes(doc, {
      [n.id]: {
        width: 10,
        text: {
          ...n.text!,
          content: "abcdefgh",
          sizing: "auto-height",
          lineHeight: 22,
        },
      },
    });
    history.execute(changed);
    expect(changed.nodes[n.id].height).toBeGreaterThan(n.height);
    expect(parseDocument(serializeDocument(changed))).toEqual(changed);
    history.undo();
    expect(history.document).toEqual(doc);
    history.redo();
    expect(history.document).toEqual(changed);
  });
  it.each(["auto-height", "auto-width"] as const)(
    "explicit resize freezes %s bounds and keeps opposite anchor",
    (sizing) => {
      const doc = createDemoDocument();
      const n = Object.values(doc.nodes).find((n) => n.text)!;
      const base = updateNodes(doc, {
        [n.id]: { text: { ...n.text!, sizing } },
      });
      const frame = transformFrame(base, [n.id])!;
      const result = resizeSelection(base, frame, {
        x: 0,
        y: -20,
        width: frame.width,
        height: frame.height + 20,
      });
      expect(result.nodes[n.id].height).toBe(frame.height + 20);
      expect(result.nodes[n.id].text!.sizing).toBe("fixed");
      expect(
        result.nodes[n.id].transform[5] + result.nodes[n.id].height,
      ).toBeCloseTo(base.nodes[n.id].transform[5] + frame.height);
    },
  );
  it("exports escaped fallback font and positioned wrapped lines with tracking", () => {
    const doc = createDemoDocument();
    const n = Object.values(doc.nodes).find((n) => n.text)!;
    const changed = updateNodes(doc, {
      [n.id]: {
        width: 20,
        text: {
          ...n.text!,
          content: "abcd",
          fontFamily: '<bad"font>',
          sizing: "auto-height",
          align: "right",
          letterSpacing: 2,
        },
      },
    });
    const svg = exportSvg(changed);
    expect(svg).toContain('letter-spacing="2"');
    expect(svg).not.toContain('<bad"font>');
    expect(svg).toContain('xml:space="preserve"');
    expect(svg.match(/<tspan/g)!.length).toBeGreaterThan(1);
  });
});
