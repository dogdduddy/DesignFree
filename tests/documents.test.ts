import { describe, expect, it } from "vitest";
import {
  createDemoDocument,
  DocumentHistory,
  parseDocument,
  serializeDocument,
  validateDocument,
} from "../src/core";
import {
  addPage,
  checkedName,
  duplicateDocument,
  migratePages,
  newDocument,
  pageIds,
  removePage,
  renamePage,
  switchPage,
} from "../src/documents";

describe("local documents and page schema", () => {
  it("migrates v1 losslessly without mutating the input", () => {
    const old = createDemoDocument();
    const before = structuredClone(old);
    const next = migratePages(old);
    expect(next).toEqual({
      ...before,
      schemaVersion: 2,
      pageIds: [old.rootId],
    });
    expect(old).toEqual(before);
    expect(parseDocument(serializeDocument(next))).toEqual(next);
  });
  it("adds, selects, renames and removes pages while preserving other trees/assets", () => {
    const old = createDemoDocument();
    const next = renamePage(addPage(old), "Second");
    expect(next.nodes[next.rootId].children).toEqual([]);
    expect(next.nodes[old.rootId]).toEqual(old.nodes[old.rootId]);
    expect(next.assets).toEqual(old.assets);
    expect(switchPage(next, old.rootId).rootId).toBe(old.rootId);
    expect(removePage(next)).toEqual(migratePages(old));
    expect(() => removePage(old)).toThrow();
    expect(() => switchPage(next, "missing")).toThrow();
  });
  it("stores page metadata and all inactive contents in Undo/Redo and JSON", () => {
    const history = new DocumentHistory(createDemoDocument());
    const original = history.document;
    history.execute(addPage(original));
    const next = history.document;
    history.undo();
    expect(history.document).toEqual(original);
    history.redo();
    expect(history.document).toEqual(next);
    expect(parseDocument(serializeDocument(next))).toEqual(next);
  });
  it("rejects malformed roots, duplicates, shared trees and unknown versions", () => {
    const next = addPage(createDemoDocument());
    for (const invalid of [
      { ...next, pageIds: [] },
      { ...next, pageIds: [next.rootId, next.rootId] },
      { ...next, pageIds: [next.rootId] },
      { ...next, rootId: "missing" },
      { ...next, schemaVersion: 3 },
      { ...next, schemaVersion: 1 },
      { ...next, pageIds: [...next.pageIds!, "missing"] },
    ])
      expect(() => validateDocument(invalid)).toThrow();
  });
  it("duplicates all pages/assets with a new document identity and detached data", () => {
    const original = addPage(createDemoDocument());
    const copy = duplicateDocument(original);
    expect(copy.id).not.toBe(original.id);
    expect(copy.nodes).toEqual(original.nodes);
    expect(copy.assets).toEqual(original.assets);
    copy.nodes[copy.rootId].name = "changed";
    expect(original.nodes[copy.rootId].name).not.toBe("changed");
    expect(pageIds(newDocument())).toHaveLength(1);
  });
  it("rejects empty and oversized names and trims whitespace", () => {
    expect(checkedName("  title  ")).toBe("title");
    expect(() => checkedName("  ")).toThrow();
    expect(() => checkedName("x".repeat(201))).toThrow();
  });
});
