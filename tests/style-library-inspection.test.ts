import { describe, expect, it } from "vitest";
import { createNode } from "../src/core";
import { newDocument } from "../src/documents";
import { validateStyleLibrary, type StyleLibrary } from "../src/style-library";
import {
  diagnoseStyleLibrary,
  inspectStyleRelationships,
} from "../src/style-library-inspection";

function library(): StyleLibrary {
  return {
    tokens: {
      primary: { name: "Primary", kind: "color", value: "#123456" },
      alias: { name: "Alias", kind: "color", value: { ref: "primary" } },
      alternate: { name: "Alternate", kind: "color", value: "#abcdef" },
    },
    styles: { ink: { name: "Ink", kind: "color", value: { ref: "alias" } } },
    themes: {
      dark: { name: "Dark", values: { primary: { ref: "alternate" } } },
    },
  };
}

function document() {
  const doc = newDocument();
  doc.styleLibrary = library();
  doc.nodes.box = createNode("rectangle", doc.rootId, {
    id: "box",
    name: "Box",
    styleRefs: { color: "ink" },
  });
  doc.nodes.instance = createNode("frame", doc.rootId, {
    id: "instance",
    name: "Instance",
    component: {
      kind: "instance",
      sourceId: "source",
      nodeMap: { source: "instance", child: "box" },
      overrides: { child: { "styleRefs.color": "ink" } },
      variantOverrides: { dormant: { paths: { styleRefs: { color: "ink" } } } },
    },
  });
  doc.nodes[doc.rootId].children = ["box", "instance"];
  return doc;
}

describe("style library diagnostics and relationships", () => {
  it("locates individual typography and shadow fields with authoritative field probes", () => {
    const draft = {
      tokens: {
        body: {
          kind: "text",
          name: "Body",
          value: {
            fontFamily: "sans-serif",
            fontSize: -1,
            fontWeight: 400,
            lineHeight: 20,
            align: "diagonal",
            extra: true,
          },
        },
        shadow: {
          kind: "effect",
          name: "Shadow",
          value: [
            { type: "drop-shadow", x: 0, y: 0, blur: -2, color: "red" },
            null,
          ],
        },
      },
      styles: {},
      themes: {
        dark: {
          name: "Dark",
          values: {
            body: { fontFamily: "sans-serif", fontSize: 16, fontWeight: 400 },
          },
        },
      },
    };
    expect(diagnoseStyleLibrary(draft).map((d) => d.path)).toEqual([
      "tokens.body.value.fontSize",
      "tokens.body.value.align",
      "tokens.body.value.extra",
      "tokens.shadow.value[0].blur",
      "tokens.shadow.value[0].color",
      "tokens.shadow.value[1]",
      "themes.dark.values.body.lineHeight",
    ]);
    expect(() => validateStyleLibrary(draft)).toThrow();
  });

  it("reports exact reference/value and inactive theme paths without accepting invalid drafts", () => {
    const draft = library();
    draft.tokens.alias.value = { ref: "missing" };
    draft.themes.dark.values.primary = "red";
    expect(() => validateStyleLibrary(draft)).toThrow();
    expect(diagnoseStyleLibrary(draft).map((d) => d.path)).toEqual([
      "tokens.alias.value.ref",
      "themes.dark.values.primary",
    ]);
    draft.tokens.alias.value = { ref: "primary" };
    draft.themes.dark.values.primary = "#fff";
    expect(diagnoseStyleLibrary(draft)).toEqual([]);
  });

  it("attributes default and theme-only cycles to authored reference edges", () => {
    const draft = library();
    draft.themes.dark.values.primary = { ref: "alias" };
    const diagnostics = diagnoseStyleLibrary(draft);
    expect(diagnostics.map((d) => d.path)).toEqual(
      expect.arrayContaining([
        "themes.dark.values.primary.ref",
        "tokens.alias.value.ref",
      ]),
    );
    expect(diagnostics.every((d) => d.message.startsWith("theme dark:"))).toBe(
      true,
    );
    draft.tokens.primary.value = { ref: "alias" };
    expect(
      diagnoseStyleLibrary(draft).some(
        (d) =>
          d.path === "tokens.primary.value.ref" &&
          d.message.startsWith("기본 값:"),
      ),
    ).toBe(true);
  });

  it("reports wrong-kind refs and malformed structure with safe paths", () => {
    const draft = library();
    draft.tokens.alternate = { kind: "effect", name: "Effect", value: [] };
    draft.themes.dark.values.primary = { ref: "alternate" };
    expect(diagnoseStyleLibrary(draft).map((d) => d.path)).toEqual([
      "themes.dark.values.primary.ref",
    ]);
    expect(diagnoseStyleLibrary(null)[0].path).toBe("$");
    expect(
      diagnoseStyleLibrary({
        tokens: {},
        styles: {},
        themes: {},
        activeTheme: "absent",
      })[0].path,
    ).toBe("activeTheme");
    expect(
      diagnoseStyleLibrary({ tokens: { a: null }, styles: [], themes: {} }).map(
        (d) => d.path,
      ),
    ).toEqual(["tokens.a", "styles"]);
  });

  it("follows aliases and theme overrides and lists all direct/dormant links without mutation", () => {
    const doc = document();
    const before = structuredClone(doc);
    const result = inspectStyleRelationships(doc);
    expect(result.styles[0].chains).toEqual([
      {
        theme: undefined,
        paths: [
          "styles.ink.value",
          "tokens.alias.value",
          "tokens.primary.value",
        ],
        tokenIds: ["alias", "primary"],
        value: "#123456",
      },
      {
        theme: "dark",
        paths: [
          "styles.ink.value",
          "tokens.alias.value",
          "themes.dark.values.primary",
          "tokens.alternate.value",
        ],
        tokenIds: ["alias", "primary", "alternate"],
        value: "#abcdef",
      },
    ]);
    expect(result.styles[0].linkedLayers.map((link) => link.source)).toEqual([
      "layer",
      "override",
      "variantOverride",
    ]);
    expect(
      result.tokens.find((token) => token.id === "alternate")?.linkedLayers,
    ).toHaveLength(3);
    expect(result.styles[0].linkedLayers[1].nodeId).toBe("box");
    expect(result.styles[0].linkedLayers[2].variantId).toBe("dormant");
    expect(doc).toEqual(before);
  });

  it("preflights deletions against current layers and dormant component bindings", () => {
    const doc = document();
    const draft = library();
    delete draft.styles.ink;
    expect(diagnoseStyleLibrary(draft, doc).map((d) => d.path)).toEqual([
      "nodes.box.styleRefs.color",
      "nodes.instance.component.overrides.child.styleRefs.color",
      "nodes.instance.component.variantOverrides.dormant.paths.styleRefs.color",
    ]);
    expect(diagnoseStyleLibrary(library(), doc)).toEqual([]);
    expect(inspectStyleRelationships(doc, draft).styles).toEqual([]);
  });

  it("returns partial inspection for incomplete drafts and stops cyclic walks", () => {
    const doc = document();
    const draft = library();
    draft.tokens.primary.value = { ref: "alias" };
    expect(
      inspectStyleRelationships(doc, draft).styles[0].chains[0].error,
    ).toContain("순환");
    expect(
      inspectStyleRelationships(doc, {
        tokens: null,
        styles: { incomplete: null },
      }).styles[0].chains[0].value,
    ).toBeUndefined();
    expect(inspectStyleRelationships(doc, null)).toEqual({
      tokens: [],
      styles: [],
    });
    const malformed = JSON.parse(
      '{"tokens":{"a":null},"styles":{"broken":{"name":{"toString":null},"kind":"color","value":{"ref":{"toString":null}}},"badValue":{"kind":"effect","value":[null]}},"themes":{"dark":null}}',
    );
    expect(() => diagnoseStyleLibrary(malformed)).not.toThrow();
    const partial = inspectStyleRelationships(doc, malformed);
    expect(
      partial.styles.every((style) =>
        style.chains.every((chain) => !!chain.error),
      ),
    ).toBe(true);
    expect(partial.styles[0].name).toBe("broken");
  });
});
