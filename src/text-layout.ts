import type { SceneDocument, SceneNode } from "./core";
export const FONT_FAMILIES = ["Noto Sans KR", "serif", "monospace"] as const;
export function missingFont(family: string) {
  return !(FONT_FAMILIES as readonly string[]).includes(family);
}
export function resolvedFont(family: string) {
  return missingFont(family) ? "Noto Sans KR" : family;
}
export function cssFont(family: string) {
  const resolved = resolvedFont(family);
  return resolved === "Noto Sans KR"
    ? '"Noto Sans KR", sans-serif'
    : resolved === "serif"
      ? '"Times New Roman", serif'
      : resolved;
}
type Text = NonNullable<SceneNode["text"]>;
export type MeasureText = (value: string, text: Text) => number;
let context: CanvasRenderingContext2D | null | undefined;
export const measureText: MeasureText = (value, text) => {
  if (typeof document !== "undefined") {
    if (!context) {
      const canvas = document.createElement("canvas");
      canvas.lang = document.documentElement.lang;
      context = canvas.getContext("2d");
    }
    if (context) {
      context.fontKerning = "normal";
      context.textRendering = "geometricPrecision";
      context.font = `${text.fontWeight} ${text.fontSize}px ${cssFont(text.fontFamily)}`;
      // Tracking can disable ligatures/change kerning in the browser shaper.
      // Measure that shaped run, then remove tracking; textLayout adds its
      // authored inter-grapheme spacing without a trailing space.
      const spacing = text.letterSpacing ?? 0;
      context.letterSpacing = `${spacing}px`;
      return (
        context.measureText(value).width -
        [...graphemes.segment(value)].length * spacing
      );
    }
  }
  // Headless model consumers can inject a metric function; this is not a font parity claim.
  return Array.from(value).length * text.fontSize * 0.6;
};
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function textLayout(
  node: SceneNode,
  measure: MeasureText = measureText,
) {
  const text = node.text!;
  const spacing = text.letterSpacing ?? 0;
  const widthOf = (value: string) =>
    Math.max(
      0,
      measure(value, text) +
        Math.max(0, [...graphemes.segment(value)].length - 1) * spacing,
    );
  const lines: string[] = [];
  for (const paragraph of text.content.split("\n")) {
    // Legacy files retain explicit-newline behavior until a sizing mode is authored.
    if (!text.sizing || text.sizing === "auto-width") {
      lines.push(paragraph);
      continue;
    }
    let line = "";
    for (const { segment } of graphemes.segment(paragraph)) {
      if (line && widthOf(line + segment) > node.width) {
        lines.push(line);
        line = "";
      }
      line += segment;
    }
    lines.push(line);
  }
  const widths =
    text.sizing === "auto-width" || (text.align && text.align !== "left")
      ? lines.map(widthOf)
      : lines.map(() => 0);
  const width =
    text.sizing === "auto-width" ? Math.max(1, ...widths) : node.width;
  const height =
    text.sizing === "auto-height" || text.sizing === "auto-width"
      ? Math.max(1, lines.length * text.lineHeight)
      : node.height;
  return {
    width,
    height,
    lines: lines.map((content, i) => ({
      content,
      x:
        text.align === "center"
          ? (width - widths[i]) / 2
          : text.align === "right"
            ? width - widths[i]
            : 0,
      y: text.fontSize + i * text.lineHeight,
    })),
  };
}
export function normalizeTextBounds(
  doc: SceneDocument,
  measure: MeasureText = measureText,
): SceneDocument {
  let next = doc;
  for (const node of Object.values(doc.nodes)) {
    if (!node.text?.sizing || node.text.sizing === "fixed") continue;
    // Flex/intrinsic geometry is derived without overwriting authored box values.
    const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
    if (
      ["flex", "grid"].includes(parent?.layout.mode ?? "") ||
      [node.layout.width, node.layout.height].some((x) => x && x !== "fixed")
    )
      continue;
    const { width, height } = textLayout(node, measure);
    if (width !== node.width || height !== node.height) {
      if (next === doc) next = { ...doc, nodes: { ...doc.nodes } };
      next.nodes[node.id] = { ...node, width, height };
    }
  }
  return next;
}
