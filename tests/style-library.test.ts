import { describe, it, expect } from "vitest";
import {
  createNode,
  validateDocument,
  serializeDocument,
  parseDocument,
  DocumentHistory,
  type SceneDocument,
} from "../src/core";
import {
  bindStyle,
  setStyleLibrary,
  switchTheme,
  resolveDocumentStyles,
  type StyleLibrary,
} from "../src/style-library";
import { computeLayout } from "../src/flex-layout";
import { copySelection } from "../src/clipboard";
import { makeComponent, createInstance } from "../src/components";
import { exportSvg } from "../src/renderers/svg";
import { exportFrameWeb } from "../src/web-export";
const typography = {
  fontFamily: "Noto Sans KR",
  fontSize: 24,
  fontWeight: 600,
  lineHeight: 32,
};
export function fixture(): SceneDocument {
  const page = createNode("page", null, { id: "page", children: ["frame"] });
  const frame = createNode("frame", "page", {
    id: "frame",
    children: ["label"],
  });
  const text = createNode("text", "frame", {
    id: "label",
    text: {
      ...typography,
      content: "공통 스타일",
      sizing: "auto-width",
      fontSize: 12,
      letterSpacing: 5,
    },
  });
  return {
    schemaVersion: 1,
    id: "styles",
    name: "styles",
    rootId: "page",
    nodes: { page, frame, label: text },
    assets: {},
  };
}
export function library(): StyleLibrary {
  return {
    tokens: {
      primary: { kind: "color", name: "Primary", value: "#112233" },
      alias: { kind: "color", name: "Alias", value: { ref: "primary" } },
      body: { kind: "text", name: "Body", value: typography },
      shadow: {
        kind: "effect",
        name: "Shadow",
        value: [
          { type: "drop-shadow", x: 3, y: 4, blur: 2, color: "#00000080" },
        ],
      },
    },
    styles: {
      ink: { kind: "color", name: "Ink", value: { ref: "alias" } },
      body: { kind: "text", name: "Body", value: { ref: "body" } },
      raised: { kind: "effect", name: "Raised", value: { ref: "shadow" } },
    },
    themes: {
      dark: {
        name: "Dark",
        values: { primary: "#eeeeee", body: { ...typography, fontSize: 36 } },
      },
    },
  };
}
function bound() {
  let doc = setStyleLibrary(fixture(), library());
  for (const [kind, id] of [
    ["color", "ink"],
    ["text", "body"],
    ["effect", "raised"],
  ] as const)
    doc = bindStyle(doc, "label", kind, id);
  return doc;
}
describe("document-local shared styles and themes", () => {
  it("resolves aliases, composite typography/effects and themes without mutating authored nodes", () => {
    const doc = bound(),
      before = serializeDocument(doc),
      resolved = resolveDocumentStyles(doc);
    expect(resolved.nodes.label.fill).toEqual({
      type: "solid",
      color: "#112233",
    });
    expect(resolved.nodes.label.text).toEqual({
      ...typography,
      content: "공통 스타일",
      sizing: "auto-width",
    });
    expect(resolved.nodes.label.effects?.[0].blur).toBe(2);
    expect(
      resolveDocumentStyles(switchTheme(doc, "dark")).nodes.label.text
        ?.fontSize,
    ).toBe(36);
    expect(
      resolveDocumentStyles(switchTheme(doc, "dark")).nodes.label.fill,
    ).toEqual({ type: "solid", color: "#eeeeee" });
    expect(serializeDocument(doc)).toBe(before);
    resolved.nodes.label.effects![0].x = 99;
    expect(resolveDocumentStyles(doc).nodes.label.effects![0].x).toBe(3);
  });
  it("preserves authoring references through JSON, atomic theme Undo/Redo, and page metadata patches", () => {
    const doc = bound(),
      history = new DocumentHistory(parseDocument(serializeDocument(doc)));
    const before = history.document;
    history.execute(switchTheme(before, "dark"));
    expect(history.statistics.undoEntries).toBe(1);
    expect(history.document.nodes.label.text?.fontSize).toBe(12);
    history.undo();
    expect(history.document).toEqual(before);
    history.redo();
    expect(history.document.styleLibrary?.activeTheme).toBe("dark");
    history.execute(switchTheme(history.document));
    expect(history.document.styleLibrary?.activeTheme).toBeUndefined();
  });
  it("detaches to the current themed values, preserving text content and clearing optional local typography", () => {
    const doc = switchTheme(bound(), "dark");
    const next = bindStyle(
      bindStyle(bindStyle(doc, "label", "text"), "label", "color"),
      "label",
      "effect",
    );
    expect(next.nodes.label.styleRefs).toBeUndefined();
    expect(next.nodes.label.text?.fontSize).toBe(36);
    expect(next.nodes.label.text?.letterSpacing).toBeUndefined();
    expect(next.nodes.label.fill).toEqual({ type: "solid", color: "#eeeeee" });
    expect(next.nodes.label.effects?.length).toBe(1);
  });
  it("exports resolved SVG/CSS while JSON keeps authoring values", () => {
    const doc = switchTheme(bound(), "dark");
    expect(exportSvg(doc)).toContain("#eeeeee");
    expect(exportSvg(doc)).toContain("feDropShadow");
    const web = exportFrameWeb(doc, "frame");
    expect(web.css).toContain("font-size:36px");
    expect(web.css).toContain("drop-shadow(3px 4px 2px");
    expect(doc.nodes.label.effects).toBeUndefined();
  });
  it("portable clipboard freezes theme and removes style refs", () => {
    const doc = switchTheme(bound(), "dark");
    const copied = copySelection(doc, ["frame"]);
    expect(copied).not.toBeNull();
    const payload = JSON.parse(copied!.json);
    expect(payload.document.nodes.label.styleRefs).toBeUndefined();
    expect(payload.document.nodes.label.text.fontSize).toBe(36);
    expect(payload.document.styleLibrary).toBeUndefined();
    validateDocument(payload.document);
  });
  it("propagates style bindings through components and retains explicit instance binding overrides", () => {
    let doc = makeComponent(bound(), "frame");
    const instance = createInstance(doc, "frame");
    const history = new DocumentHistory(instance.document);
    const root = history.document.nodes[instance.id].component;
    if (root?.kind !== "instance") throw new Error("Missing instance");
    const label = root.nodeMap.label;
    const local = bindStyle(history.document, label, "color");
    history.execute(local);
    const nextLibrary = library();
    nextLibrary.tokens.primary.value = "#abcdef";
    history.execute(setStyleLibrary(history.document, nextLibrary));
    const resolved = resolveDocumentStyles(history.document);
    expect(resolved.nodes.label.fill).toEqual({
      type: "solid",
      color: "#abcdef",
    });
    expect(resolved.nodes[label].fill).toEqual({
      type: "solid",
      color: "#112233",
    });
  });
  it("uses resolved typography for computed intrinsic text geometry", () => {
    const doc = bound(),
      measure = (s: string, font: { fontSize: number }) =>
        s.length * font.fontSize;
    const light = computeLayout(doc, measure),
      dark = computeLayout(switchTheme(doc, "dark"), measure);
    expect(dark.nodes.label.width).toBeGreaterThan(light.nodes.label.width);
    expect(doc.nodes.label.width).toBe(fixture().nodes.label.width);
  });
  it.each([
    "missing",
    "cycle",
    "type",
    "theme-cycle",
    "unused-type",
    "dangerous-key",
    "invalid-theme",
    "invalid-effect",
    "unknown-field",
    "long-chain",
  ])("rejects malformed %s without accepting a partial library", (kind) => {
    const l = library();
    if (kind === "missing") l.tokens.alias.value = { ref: "gone" };
    if (kind === "cycle") l.tokens.primary.value = { ref: "alias" };
    if (kind === "type") l.styles.ink.value = { ref: "body" };
    if (kind === "theme-cycle") l.themes.dark.values.primary = { ref: "alias" };
    if (kind === "unused-type")
      l.tokens.bad = {
        kind: "color",
        name: "bad",
        value: "url(https://example.com)",
      };
    if (kind === "dangerous-key")
      l.tokens = JSON.parse(
        '{"__proto__":{"kind":"color","name":"x","value":"#fff"}}',
      );
    if (kind === "invalid-theme") l.activeTheme = "gone";
    if (kind === "invalid-effect")
      l.styles.raised.value = [
        { type: "drop-shadow", x: 0, y: 0, blur: -1, color: "#fff" },
      ];
    if (kind === "unknown-field") (l.styles.body as any).unexpected = 1;
    if (kind === "long-chain") {
      for (let i = 0; i < 513; i++)
        l.tokens[`chain-${i}`] = {
          kind: "color",
          name: "chain",
          value: i === 512 ? "#fff" : { ref: `chain-${i + 1}` },
        };
    }
    const doc = bound(),
      before = serializeDocument(doc);
    expect(() => setStyleLibrary(doc, l)).toThrow();
    expect(serializeDocument(doc)).toBe(before);
  });
  it("rejects dangling/wrong-kind/non-text style bindings and malformed local effects", () => {
    const doc = bound();
    expect(() => bindStyle(doc, "label", "text", "ink")).toThrow();
    expect(() => bindStyle(doc, "frame", "text", "body")).toThrow();
    const next = structuredClone(doc);
    delete next.styleLibrary!.styles.ink;
    expect(() => validateDocument(next)).toThrow();
    next.styleLibrary = undefined;
    expect(() => validateDocument(next)).toThrow();
    const malformed = fixture();
    (malformed.nodes.frame as any).effects = [{ type: "blur", blur: 4 }];
    expect(() => validateDocument(malformed)).toThrow();
  });
});
