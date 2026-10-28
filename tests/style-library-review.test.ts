import { describe, it, expect } from "vitest";
import { createNode, DocumentHistory } from "../src/core";
import { newDocument } from "../src/documents";
import {
  makeComponent,
  createInstance,
  switchVariant,
} from "../src/components";
import { createVariant } from "../src/variants";
import {
  setStyleLibrary,
  bindStyle,
  validateStyleLibrary,
  resolveDocumentStyles,
  type StyleLibrary,
} from "../src/style-library";
import { culledClips } from "../src/renderers/visibility";

describe("C03 independent review regressions", () => {
  it("keeps offscreen source descendants whose ancestor shadow enters the viewport", () => {
    const doc = newDocument();
    const group = createNode("group", doc.rootId, {
      id: "parent",
      children: ["child"],
      effects: [{ type: "drop-shadow", x: -300, y: 0, blur: 0, color: "#000" }],
    });
    const child = createNode("rectangle", group.id, {
      id: "child",
      transform: [1, 0, 0, 1, 310, 10],
      width: 20,
      height: 20,
      clipContent: true,
    });
    doc.nodes[group.id] = group;
    doc.nodes[child.id] = child;
    doc.nodes[doc.rootId].children = [group.id];
    expect(
      culledClips(doc, { x: 0, y: 0, zoom: 1 }, 100, 100).has(child.id),
    ).toBe(false);
  });
  it("rejects deleting a style retained by a dormant variant override", () => {
    const doc = newDocument();
    doc.nodes.main = createNode("frame", doc.rootId, {
      id: "main",
      children: ["badge"],
    });
    doc.nodes.badge = createNode("rectangle", "main", { id: "badge" });
    doc.nodes[doc.rootId].children = ["main"];
    const variant = createVariant(makeComponent(doc, "main"), "main");
    variant.document.nodes[
      variant.document.nodes[variant.id].children[0]
    ].type = "ellipse";
    const instance = createInstance(variant.document, "main");
    const h = new DocumentHistory(
      setStyleLibrary(instance.document, {
        tokens: {},
        styles: { ink: { kind: "color", name: "Ink", value: "#f00" } },
        themes: {},
      }),
    );
    const component = h.document.nodes[instance.id].component;
    if (component?.kind !== "instance") throw new Error("Missing instance");
    h.execute(bindStyle(h.document, component.nodeMap.badge, "color", "ink"));
    h.execute(switchVariant(h.document, instance.id, variant.id));
    expect(() =>
      setStyleLibrary(h.document, { tokens: {}, styles: {}, themes: {} }),
    ).toThrow();
    expect(() =>
      h.execute(switchVariant(h.document, instance.id, "main")),
    ).not.toThrow();
  });
  it.each([false, true])(
    "accepts bounded acyclic alias paths independently of token insertion order (reverse=%s)",
    (reverse) => {
      const ids = Array.from({ length: 70 }, (_, i) => i);
      if (reverse) ids.reverse();
      const library: StyleLibrary = {
        tokens: Object.fromEntries(
          ids.map((i) => [
            `t${i}`,
            {
              kind: "color",
              name: "token",
              value: i === 69 ? "#fff" : { ref: `t${i + 1}` },
            },
          ]),
        ),
        styles: { ink: { kind: "color", name: "Ink", value: { ref: "t0" } } },
        themes: {},
      };
      expect(() => validateStyleLibrary(library)).not.toThrow();
      const next = setStyleLibrary(newDocument(), library);
      const id = Object.keys(next.nodes)[0];
      const resolved = bindStyle(next, id, "color", "ink");
      expect(resolveDocumentStyles(resolved).nodes[id].fill).toEqual({
        type: "solid",
        color: "#fff",
      });
    },
  );
  it("rejects token dictionaries exceeding the 512-entry bound", () => {
    const tokens = Object.fromEntries(
      Array.from({ length: 513 }, (_, i) => [
        `t${i}`,
        { kind: "color", name: "token", value: "#fff" },
      ]),
    );
    expect(() =>
      validateStyleLibrary({ tokens, styles: {}, themes: {} }),
    ).toThrow();
  });
});
