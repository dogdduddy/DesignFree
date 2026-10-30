import { createNode, type SceneDocument } from "../src/core";
import {
  makeComponent,
  createInstance,
  reconcileComponents,
} from "../src/components";

export function designSystemFixture(): SceneDocument {
  let doc: SceneDocument = {
    schemaVersion: 1,
    id: "web-system",
    name: "Web system",
    rootId: "page",
    assets: {},
    nodes: {
      page: createNode("page", null, {
        id: "page",
        width: 360,
        height: 260,
        children: ["frame"],
      }),
      frame: createNode("frame", "page", {
        id: "frame",
        width: 360,
        height: 260,
        children: ["card"],
        fill: { type: "solid", color: "#ffffff" },
      }),
      card: createNode("frame", "frame", {
        id: "card",
        width: 140,
        height: 110,
        children: ["label"],
        transform: [1, 0, 0, 1, 10, 10],
        styleRefs: { color: "surface", effect: "shadow" },
        layout: {
          mode: "flex",
          direction: "column",
          height: "hug",
          padding: [8, 8, 8, 8],
        },
      }),
      label: createNode("text", "card", {
        id: "label",
        width: 100,
        height: 60,
        transform: [1, 0, 0, 1, 8, 8],
        text: {
          content: "Theme wrapping example",
          sizing: "auto-height",
          fontFamily: "sans-serif",
          fontSize: 12,
          fontWeight: 400,
          lineHeight: 16,
        },
        styleRefs: { color: "ink", text: "body" },
      }),
    },
    styleLibrary: {
      tokens: {
        primary: { name: "Primary", kind: "color", value: "#bbddff" },
        alias: { name: "Alias", kind: "color", value: { ref: "primary" } },
        type: {
          name: "Type",
          kind: "text",
          value: {
            fontFamily: "sans-serif",
            fontSize: 12,
            fontWeight: 400,
            lineHeight: 16,
          },
        },
        fx: { name: "FX", kind: "effect", value: [] },
      },
      styles: {
        surface: { name: "Surface", kind: "color", value: { ref: "alias" } },
        ink: { name: "Ink", kind: "color", value: "#123456" },
        body: { name: "Body", kind: "text", value: { ref: "type" } },
        shadow: { name: "Shadow", kind: "effect", value: { ref: "fx" } },
      },
      themes: {
        dark: {
          name: "Dark",
          values: {
            primary: "#332244",
            type: {
              fontFamily: "sans-serif",
              fontSize: 20,
              fontWeight: 700,
              lineHeight: 26,
              letterSpacing: 1,
              align: "right",
            },
            fx: [{ type: "drop-shadow", x: 3, y: 4, blur: 0, color: "#0008" }],
          },
        },
        alternate: { name: "Alternate", values: { alias: "#88ccaa" } },
      },
      activeTheme: "dark",
    },
  };
  doc = makeComponent(doc, "card");
  const instance = createInstance(doc, "card");
  doc = instance.document;
  // Instance placement is an authored override; the expanded inherited content stays shared.
  doc.nodes[instance.id].transform = [1, 0, 0, 1, 180, 10];
  const link = doc.nodes[instance.id].component;
  if (link?.kind === "instance")
    link.overrides.card.transform = [1, 0, 0, 1, 180, 10];
  if (link?.kind === "instance")
    link.overrides.label = { "text.content": "Instance custom" };
  return reconcileComponents(doc);
}
