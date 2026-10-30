import { describe, it, expect } from "vitest";
import {
  createNode,
  parseDocument,
  serializeDocument,
  validateDocument,
} from "../src/core";
import { newDocument, duplicateDocument } from "../src/documents";
import {
  bindStyle,
  resolveDocumentStyles,
  setStyleLibrary,
} from "../src/style-library";
import {
  detachSharedStyleLibrary,
  importSharedStyleLibrary,
  inspectSharedStyleLibraries,
} from "../src/shared-style-library";
function fixture() {
  const source = newDocument(),
    target = newDocument();
  source.name = "System";
  source.styleLibrary = {
    tokens: {
      space: { kind: "spacing", name: "Space", value: 8 },
      alias: { kind: "spacing", name: "Alias", value: { ref: "space" } },
    },
    styles: { gap: { kind: "spacing", name: "Gap", value: { ref: "alias" } } },
    themes: { wide: { name: "Wide", values: { space: 24 } } },
    activeTheme: "wide",
  };
  const frame = createNode("frame", target.rootId, {
    width: 200,
    height: 200,
    layout: { mode: "flex", gap: 2 },
  });
  target.nodes[frame.id] = frame;
  target.nodes[target.rootId].children.push(frame.id);
  return { source, target, frame };
}
describe("pinned cross-document style libraries", () => {
  it("namespaces aliases, pins selected theme and updates bound layers atomically", () => {
    const { source, target, frame } = fixture(),
      original = structuredClone(source);
    let doc = importSharedStyleLibrary(target, source);
    const link = doc.sharedStyleLibraries![0];
    doc = bindStyle(doc, frame.id, "gap", link.styles.gap);
    expect(resolveDocumentStyles(doc).nodes[frame.id].layout.gap).toBe(24);
    expect(doc.nodes[frame.id].layout.gap).toBe(2);
    expect(source).toEqual(original);
    expect(inspectSharedStyleLibraries(doc, [source])[0].status).toBe(
      "current",
    );
    expect(importSharedStyleLibrary(doc, source)).toBe(doc);
    source.styleLibrary!.themes.wide.values.space = 40;
    expect(inspectSharedStyleLibraries(doc, [source])[0].status).toBe("update");
    expect(resolveDocumentStyles(doc).nodes[frame.id].layout.gap).toBe(24);
    const updated = importSharedStyleLibrary(doc, source);
    expect(updated.sharedStyleLibraries![0]).toEqual(link);
    expect(resolveDocumentStyles(updated).nodes[frame.id].layout.gap).toBe(40);
    expect(parseDocument(serializeDocument(updated))).toEqual(updated);
    expect(
      resolveDocumentStyles(duplicateDocument(updated)).nodes[frame.id].layout
        .gap,
    ).toBe(40);
  });
  it("retains snapshots and reports missing documents, entries and local snapshots", () => {
    const { source, target } = fixture();
    const doc = importSharedStyleLibrary(target, source),
      link = doc.sharedStyleLibraries![0];
    expect(inspectSharedStyleLibraries(doc, [])[0].status).toBe("missing");
    delete source.styleLibrary!.styles.gap;
    expect(
      inspectSharedStyleLibraries(doc, [source])[0].issues.join(),
    ).toContain("원본 항목 없음");
    const updated = importSharedStyleLibrary(doc, source);
    expect(updated.styleLibrary!.styles[link.styles.gap]).toEqual(
      doc.styleLibrary!.styles[link.styles.gap],
    );
    expect(inspectSharedStyleLibraries(updated, [source])[0].status).toBe(
      "missing",
    );
    const local = structuredClone(doc);
    delete local.styleLibrary!.styles[link.styles.gap];
    source.styleLibrary!.styles.gap = {
      kind: "spacing",
      name: "Gap",
      value: 12,
    };
    expect(
      inspectSharedStyleLibraries(local, [source])[0].issues.join(),
    ).toContain("로컬 스냅샷 없음");
    expect(
      inspectSharedStyleLibraries(importSharedStyleLibrary(local, source), [
        source,
      ])[0].status,
    ).toBe("current");
  });
  it("detects local divergence, refreshes imported theme values, detaches without visual change", () => {
    const { source, target } = fixture();
    const doc = importSharedStyleLibrary(target, source),
      link = doc.sharedStyleLibraries![0];
    doc.styleLibrary!.tokens[link.tokens.space].value = 99;
    expect(inspectSharedStyleLibraries(doc, [source])[0].status).toBe("update");
    doc.styleLibrary!.tokens[link.tokens.space].value = 24;
    doc.styleLibrary!.themes.local = {
      name: "Local",
      values: { [link.tokens.space]: 70 },
    };
    expect(inspectSharedStyleLibraries(doc, [source])[0].status).toBe("update");
    const refreshed = importSharedStyleLibrary(doc, source);
    expect(refreshed.styleLibrary!.themes.local.values).toEqual({});
    const detached = detachSharedStyleLibrary(refreshed, source.id);
    expect(detached.sharedStyleLibraries).toBeUndefined();
    expect(detached.styleLibrary).toEqual(refreshed.styleLibrary);
    expect(detachSharedStyleLibrary(detached, source.id)).toBe(detached);
  });
  it("freezes a missing style when surviving token dependencies are refreshed", () => {
    const { source, target, frame } = fixture();
    let doc = importSharedStyleLibrary(target, source);
    const link = doc.sharedStyleLibraries![0];
    doc = bindStyle(doc, frame.id, "gap", link.styles.gap);
    delete source.styleLibrary!.styles.gap;
    source.styleLibrary!.themes.wide.values.space = 40;
    const refreshed = importSharedStyleLibrary(doc, source);
    expect(resolveDocumentStyles(refreshed).nodes[frame.id].layout.gap).toBe(
      24,
    );
    expect(refreshed.styleLibrary!.tokens[link.tokens.space].value).toBe(40);
    expect(inspectSharedStyleLibraries(refreshed, [source])[0].status).toBe(
      "missing",
    );
    expect(importSharedStyleLibrary(refreshed, source)).toBe(refreshed);
  });
  it("rejects malformed provenance and incompatible source changes without partial writes", () => {
    const { source, target, frame } = fixture();
    expect(() => importSharedStyleLibrary(source, source)).toThrow();
    let doc = importSharedStyleLibrary(target, source);
    doc = bindStyle(
      doc,
      frame.id,
      "gap",
      doc.sharedStyleLibraries![0].styles.gap,
    );
    const before = structuredClone(doc);
    source.styleLibrary = {
      tokens: {},
      styles: { gap: { kind: "color", name: "Gap", value: "#ff0000" } },
      themes: {},
    };
    expect(() => importSharedStyleLibrary(doc, source)).toThrow();
    expect(doc).toEqual(before);
    const bad = structuredClone(doc);
    bad.sharedStyleLibraries!.push(
      structuredClone(bad.sharedStyleLibraries![0]),
    );
    expect(() => validateDocument(bad)).toThrow();
    bad.sharedStyleLibraries = [
      {
        sourceId: "s",
        sourceName: "S",
        tokens: JSON.parse('{"__proto__":"x"}'),
        styles: {},
      },
    ];
    expect(() => validateDocument(bad)).toThrow();
    // Existing library edits still use their existing atomic validator.
    expect(() =>
      setStyleLibrary(doc, { tokens: {}, styles: {}, themes: {} }),
    ).toThrow();
  });
});
