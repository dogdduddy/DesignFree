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
    const { designSystemFixture } =
      await import("/tests/web-design-system-fixture.ts");
    const { exportFrameWeb } = await import("/src/web-export.ts");
    const { computeLayout } = await import("/src/flex-layout.ts");
    const { textLayout } = await import("/src/text-layout.ts");
    const { exportSvg } = await import("/src/renderers/svg.ts");
    const doc = designSystemFixture(),
      before = JSON.stringify(doc);
    const exported = exportFrameWeb(doc, "frame");
    const expected = {};
    for (const theme of ["", "dark", "alternate"]) {
      const scene = structuredClone(doc);
      if (theme) scene.styleLibrary.activeTheme = theme;
      else delete scene.styleLibrary.activeTheme;
      const computed = computeLayout(scene);
      expected[theme] = {
        svg: exportSvg(computed),
        nodes: Object.values(computed.nodes)
          .filter((n) => n.type !== "page")
          .map((n) => ({
            id: n.id,
            width: n.width,
            height: n.height,
            x: n.transform[4],
            y: n.transform[5],
            parent: n.parentId,
            color: n.fill.color,
            text: n.text,
            lines: n.text ? textLayout(n).lines : undefined,
          })),
      };
    }
    if (before !== JSON.stringify(doc))
      throw new Error("Authored scene changed");
    return { exported, expected };
  });
  const output = await browser.newPage({
    viewport: { width: 360, height: 260 },
  });
  let requests = 0;
  output.on("request", () => requests++);
  await output.setContent(fixture.exported.html);
  for (const theme of ["dark", "", "alternate", "dark"]) {
    await output.evaluate(
      (theme) => document.documentElement.setAttribute("data-dr-theme", theme),
      theme,
    );
    const actual = await output.evaluate(() => {
      const scope = [...document.querySelectorAll("[data-dr-theme-set]")].find(
        (n) => getComputedStyle(n).display !== "none",
      );
      return [...scope.querySelectorAll("[data-node-id]")].map((n) => {
        const s = getComputedStyle(n),
          box = n.getBoundingClientRect(),
          parent = n.parentElement.getBoundingClientRect();
        return {
          id: n.dataset.nodeId,
          width: box.width,
          height: box.height,
          x: box.x - parent.x,
          y: box.y - parent.y,
          background: s.backgroundImage,
          fontSize: parseFloat(s.fontSize),
          weight: s.fontWeight,
          filter: s.filter,
          color: s.color,
          tracking: parseFloat(s.letterSpacing) || 0,
          lines: [...n.querySelectorAll(":scope > .dr-line")].map((l) => ({
            content: l.textContent,
            x: parseFloat(getComputedStyle(l).left),
            y: parseFloat(getComputedStyle(l).top),
          })),
        };
      });
    });
    for (const node of fixture.expected[theme].nodes) {
      const a = actual.find((n) => n.id === node.id);
      assert.ok(a, node.id);
      for (const key of ["width", "height", "x", "y"])
        assert.ok(
          Math.abs(
            a[key] -
              (node.id === "frame" && ["x", "y"].includes(key) ? 0 : node[key]),
          ) < 0.1,
          `${theme}/${node.id}/${key}`,
        );
      if (node.id === "card") {
        assert.equal(
          a.filter,
          theme === "dark"
            ? "drop-shadow(rgba(0, 0, 0, 0.533) 3px 4px 0px)"
            : "none",
        );
      }
      if (node.text) {
        assert.equal(a.color, "rgb(18, 52, 86)");
        assert.equal(a.tracking, node.text.letterSpacing ?? 0);
        assert.equal(a.fontSize, node.text.fontSize);
        assert.equal(a.weight, String(node.text.fontWeight));
        assert.equal(a.lines.length, node.lines.length);
        a.lines.forEach((line, i) => {
          assert.equal(line.content, node.lines[i].content);
          assert.ok(Math.abs(line.x - node.lines[i].x) < 0.01);
          assert.ok(Math.abs(line.y - i * node.text.lineHeight) < 0.01);
        });
      }
    }
    // Compare actual standalone pixels with the editor SVG at an interior solid point.
    const shot = await output.screenshot();
    const pixel = await source.evaluate(
      async ({ svg, shot }) => {
        const sample = async (src) => {
          const image = new Image();
          image.src = src;
          await image.decode();
          const c = document.createElement("canvas");
          c.width = 360;
          c.height = 260;
          const ctx = c.getContext("2d");
          ctx.drawImage(image, 0, 0);
          return [...ctx.getImageData(140, 30, 1, 1).data];
        };
        return {
          editor: await sample(
            `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`,
          ),
          web: await sample(`data:image/png;base64,${shot}`),
        };
      },
      { svg: fixture.expected[theme].svg, shot: shot.toString("base64") },
    );
    assert.deepEqual(pixel.web, pixel.editor);
    const component = await output.evaluate(() => {
      const scope = [...document.querySelectorAll("[data-dr-theme-set]")].find(
        (n) => getComputedStyle(n).display !== "none",
      );
      const roots = [...scope.querySelectorAll("div[data-dr-component]")];
      const shared = roots[0].className
        .split(" ")
        .filter((c) => c.includes("appearance"));
      const template = scope.querySelector("template");
      const clone = template.content.cloneNode(true);
      const root = clone.firstElementChild;
      scope.append(clone);
      const box = root.getBoundingClientRect();
      root.remove();
      return {
        shared: roots[1].classList.contains(shared[0]),
        width: box.width,
        templates: scope.querySelectorAll("template").length,
      };
    });
    assert.equal(component.shared, true);
    assert.equal(component.width, 140);
    assert.equal(component.templates, 2);
    checks.push(
      `theme=${theme || "base"}: geometry, typography lines, SVG solid pixel, component clone`,
    );
  }
  assert.equal(requests, 0);
  const report = artifactPath("w02-web-design-system.json");
  await fs.mkdir(new URL("../test-results/", import.meta.url), {
    recursive: true,
  });
  await fs.writeFile(report, JSON.stringify({ checks, requests }, null, 2));
  console.log(JSON.stringify({ checks, requests }, null, 2));
} finally {
  await browser.close();
}
