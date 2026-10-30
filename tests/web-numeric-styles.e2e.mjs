import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";

const browser = await chromium.launch(browserLaunchOptions());
const checks = [];
try {
  const source = await browser.newPage();
  await source.goto(process.env.EDITOR_URL || "http://127.0.0.1:5173/");
  const fixture = await source.evaluate(async () => {
    const { createNode } = await import("/src/core/index.ts");
    const { computeLayout } = await import("/src/flex-layout.ts");
    const { exportFrameWeb } = await import("/src/web-export.ts");
    const doc = {
      schemaVersion: 1,
      id: "numeric-web",
      name: "Numeric web",
      rootId: "page",
      assets: {},
      nodes: {
        page: createNode("page", null, { id: "page", children: ["frame"] }),
        frame: createNode("frame", "page", {
          id: "frame",
          width: 360,
          height: 240,
          children: ["fixed", "fill", "textHost"],
          layout: { mode: "flex" },
          styleRefs: { gap: "space", padding: "space" },
        }),
        fixed: createNode("rectangle", "frame", {
          id: "fixed",
          width: 30,
          height: 20,
          styleRefs: { width: "size", height: "size", radius: "round" },
        }),
        fill: createNode("rectangle", "frame", {
          id: "fill",
          width: 30,
          height: 20,
          layout: { mode: "absolute", width: "fill" },
          styleRefs: { width: "size", radius: "round" },
        }),
        textHost: createNode("frame", "frame", {
          id: "textHost",
          width: 300,
          height: 100,
          transform: [1, 0, 0, 1, 0, 120],
          layout: { mode: "absolute", position: "absolute" },
          children: ["auto-width", "auto-height", "fixed-text"],
        }),
        ...Object.fromEntries(
          ["auto-width", "auto-height", "fixed"].map((sizing, i) => {
            const id = sizing === "fixed" ? "fixed-text" : sizing;
            return [
              id,
              createNode("text", "textHost", {
                id,
                width: 300,
                height: 300,
                transform: [1, 0, 0, 1, i * 90, 0],
                text: {
                  content: "ii",
                  sizing,
                  fontFamily: "sans-serif",
                  fontSize: 16,
                  fontWeight: 400,
                  lineHeight: 24,
                },
                styleRefs: { width: "size", height: "size" },
              }),
            ];
          }),
        ),
      },
      styleLibrary: {
        tokens: {
          size: { kind: "number", name: "Size", value: 50 },
          base: { kind: "spacing", name: "Base", value: 12 },
          alias: { kind: "spacing", name: "Alias", value: { ref: "base" } },
          round: { kind: "radius", name: "Round", value: 6 },
        },
        styles: {
          size: { kind: "number", name: "Size", value: { ref: "size" } },
          space: { kind: "spacing", name: "Space", value: { ref: "alias" } },
          round: { kind: "radius", name: "Round", value: { ref: "round" } },
        },
        themes: {
          large: { name: "Large", values: { size: 80, base: 20, round: 10 } },
          alternate: { name: "Alternate", values: { alias: 16 } },
        },
        activeTheme: "large",
      },
    };
    const before = JSON.stringify(doc),
      exported = exportFrameWeb(doc, "frame");
    const expected = {};
    for (const theme of ["", "large", "alternate"]) {
      const scene = structuredClone(doc);
      if (theme) scene.styleLibrary.activeTheme = theme;
      else delete scene.styleLibrary.activeTheme;
      expected[theme] = Object.values(computeLayout(scene).nodes)
        .filter((n) => n.type !== "page")
        .map((n) => ({
          id: n.id,
          width: n.width,
          height: n.height,
          x: n.transform[4],
          y: n.transform[5],
          radius: n.radius,
          gap: n.layout.gap,
          padding: n.layout.padding,
        }));
    }
    if (JSON.stringify(doc) !== before)
      throw new Error("Authored scene changed");
    return { exported, expected };
  });
  const output = await browser.newPage({
    viewport: { width: 360, height: 240 },
  });
  let requests = 0;
  output.on("request", () => requests++);
  await output.setContent(fixture.exported.html);
  for (const theme of ["large", "", "alternate", "large"]) {
    await output.evaluate(
      (t) => (document.documentElement.dataset.drTheme = t),
      theme,
    );
    const actual = await output.evaluate(() => {
      const scope = [...document.querySelectorAll("[data-dr-theme-set]")].find(
        (n) => getComputedStyle(n).display !== "none",
      );
      return [...scope.querySelectorAll("[data-node-id]")].map((n) => {
        const style = getComputedStyle(n),
          box = n.getBoundingClientRect(),
          parent = n.parentElement.getBoundingClientRect();
        return {
          id: n.dataset.nodeId,
          width: box.width,
          height: box.height,
          x: box.x - parent.x,
          y: box.y - parent.y,
          radius: parseFloat(style.borderTopLeftRadius),
          gap: parseFloat(style.gap),
          padding: [
            style.paddingTop,
            style.paddingRight,
            style.paddingBottom,
            style.paddingLeft,
          ].map(parseFloat),
        };
      });
    });
    for (const expected of fixture.expected[theme]) {
      const node = actual.find((n) => n.id === expected.id);
      assert.ok(node, expected.id);
      for (const key of ["width", "height", "x", "y", "radius"])
        assert.ok(
          Math.abs(node[key] - expected[key]) < 0.1,
          `${theme}/${expected.id}/${key}: ${node[key]} != ${expected[key]}`,
        );
      if (expected.id === "frame") {
        assert.equal(node.gap, expected.gap);
        assert.deepEqual(node.padding, expected.padding);
      }
    }
    checks.push(
      `${theme || "base"}: alias/theme gap, uniform padding, fixed/fill geometry, text auto sizing, radius`,
    );
  }
  assert.equal(requests, 0);
  await fs.writeFile(
    artifactPath("d03-web-numeric-styles.json"),
    JSON.stringify({ checks, requests }, null, 2),
  );
  console.log(JSON.stringify({ checks, requests }, null, 2));
} finally {
  await browser.close();
}
