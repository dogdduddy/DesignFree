import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.EDITOR_URL || "http://127.0.0.1:5173/", {
    waitUntil: "networkidle",
  });
  const result = await page.evaluate(async () => {
    const { createNode } = await import("/src/core/index.ts");
    const { createCanvasKitEngine } =
      await import("/src/renderers/canvaskit.ts");
    const { createSvgEngine, exportSvg, exportPng } =
      await import("/src/renderers/svg.ts");
    const host = document.createElement("div"),
      svgHost = document.createElement("div");
    document.body.append(host, svgHost);
    const ck = await createCanvasKitEngine(host, 200, 160),
      svgEngine = await createSvgEngine(svgHost, 200, 160);
    const raster = async (blob) => {
      const image = new Image(),
        url = URL.createObjectURL(blob);
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 160;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      return [...ctx.getImageData(0, 0, 200, 160).data];
    };
    const cases = [];
    for (const kind of [
      "offset",
      "blur",
      "stack",
      "group",
      "ancestor-culling",
      "affine-overflow",
      "theme",
    ]) {
      const page = createNode("page", null, {
        id: "root",
        width: 200,
        height: 160,
        fill: { type: "solid", color: "#ffffff" },
        children: ["shape"],
      });
      const shape = createNode("rectangle", "root", {
        id: "shape",
        width: 70,
        height: 50,
        transform: [1, 0, 0, 1, 30, 30],
        fill: { type: "solid", color: "#123456" },
        effects: [
          {
            type: "drop-shadow",
            x: 20,
            y: 10,
            blur: kind === "blur" ? 5 : 0,
            color: "#ff000080",
          },
        ],
      });
      const doc = {
        schemaVersion: 1,
        id: "styles",
        name: "styles",
        rootId: "root",
        nodes: { root: page, shape },
        assets: {},
      };
      if (kind === "stack")
        shape.effects.push({
          type: "drop-shadow",
          x: 20,
          y: 0,
          blur: 0,
          color: "#0000ff80",
        });
      if (["group", "ancestor-culling", "affine-overflow"].includes(kind)) {
        shape.type = "group";
        shape.children = ["child"];
        const child = createNode("rectangle", "shape", {
          id: "child",
          width: 50,
          height: 40,
          transform: [1, 0, 0, 1, 0, 0],
          fill: { type: "solid", color: "#123456" },
        });
        if (kind === "ancestor-culling") {
          child.transform[4] = 300;
          child.clipContent = true;
          shape.effects[0].x = -300;
        }
        if (kind === "affine-overflow") {
          child.transform = [1.4, 0.4, -0.2, 1.1, 1000, 0];
          shape.effects[0].x = -1000;
        }
        doc.nodes.child = child;
      }
      if (kind === "theme") {
        shape.effects = undefined;
        shape.styleRefs = { color: "ink", effect: "shadow" };
        doc.styleLibrary = {
          tokens: {
            base: { kind: "color", name: "Base", value: "#000" },
            shadow: {
              kind: "effect",
              name: "Shadow",
              value: [
                {
                  type: "drop-shadow",
                  x: 20,
                  y: 10,
                  blur: 0,
                  color: "#ff000080",
                },
              ],
            },
          },
          styles: {
            ink: { kind: "color", name: "Ink", value: { ref: "base" } },
            shadow: {
              kind: "effect",
              name: "Shadow",
              value: { ref: "shadow" },
            },
          },
          themes: { dark: { name: "Dark", values: { base: "#123456" } } },
          activeTheme: "dark",
        };
      }
      const svg = await raster(
        new Blob([exportSvg(doc)], { type: "image/svg+xml" }),
      );
      const png = await raster(await exportPng(doc, 1));
      ck.update(doc, { x: 0, y: 0, zoom: 1 });
      svgEngine.update(doc, { x: 0, y: 0, zoom: 1 });
      const ckPixels = await raster(
        await new Promise((resolve) =>
          host.querySelector("canvas").toBlob(resolve),
        ),
      );
      svgHost
        .querySelector("svg")
        .setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const domSvg = svgHost.querySelector("svg").outerHTML;
      const dom = await raster(new Blob([domSvg], { type: "image/svg+xml" }));
      let total = 0,
        pngMax = 0,
        domMax = 0;
      for (let i = 0; i < svg.length; i++) {
        total += Math.abs(svg[i] - ckPixels[i]);
        pngMax = Math.max(pngMax, Math.abs(svg[i] - png[i]));
        domMax = Math.max(domMax, Math.abs(svg[i] - dom[i]));
      }
      const point = kind === "affine-overflow" ? [55, 60] : [40, 40];
      const sample = (array) =>
        array.slice(
          (point[1] * 200 + point[0]) * 4,
          (point[1] * 200 + point[0]) * 4 + 4,
        );
      cases.push({
        kind,
        meanAbsoluteChannelError: total / svg.length,
        pngMax,
        domMax,
        svgSample: sample(svg),
        ckSample: sample(ckPixels),
        backend: ck.info.backend,
      });
    }
    ck.destroy();
    svgEngine.destroy();
    host.remove();
    svgHost.remove();
    return cases;
  });
  for (const c of result) {
    console.log(c.kind, c.meanAbsoluteChannelError, c.svgSample, c.ckSample);
    assert.equal(c.pngMax, 0);
    assert.equal(c.domMax, 0);
    assert(c.meanAbsoluteChannelError < 2, `${c.kind} SVG/CK mean error`);
    assert(
      c.svgSample.slice(0, 3).some((v) => v < 250),
      `${c.kind} expected ink/shadow`,
    );
    assert(
      c.ckSample.slice(0, 3).some((v) => v < 250),
      `${c.kind} expected CK ink/shadow`,
    );
  }
  assert.deepEqual(errors, []);
  if (process.env.STYLE_PIXEL_REPORT)
    await fs.writeFile(
      process.env.STYLE_PIXEL_REPORT,
      JSON.stringify(
        { browser: browser.version(), cases: result, pageErrors: errors },
        null,
        2,
      ),
    );
} finally {
  await browser.close();
}
