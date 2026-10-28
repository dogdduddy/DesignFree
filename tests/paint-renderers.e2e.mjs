import { browserLaunchOptions } from "./browser-helpers.mjs";
import { sourceFingerprint } from "./renderer-evidence.mjs";
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
  const results = await page.evaluate(async () => {
    const { createNode } = await import("/src/core/index.ts");
    const { exportSvg, exportPng, createSvgEngine } =
      await import("/src/renderers/svg.ts");
    const { createCanvasKitEngine } =
      await import("/src/renderers/canvaskit.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const ck = await createCanvasKitEngine(host, 160, 120);
    async function raster(blob) {
      const bmp = new Image();
      const url = URL.createObjectURL(blob);
      bmp.src = url;
      await bmp.decode();
      const c = document.createElement("canvas");
      c.width = 160;
      c.height = 120;
      const ctx = c.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      URL.revokeObjectURL(url);
      return ctx.getImageData(0, 0, 160, 120).data;
    }
    const cases = [];
    for (const kind of [
      "linear",
      "radial",
      "transparent-stops",
      "stack",
      "inside",
      "outside",
      "center",
      "ellipse",
      "dashes",
      "rounded",
      "image",
      "ellipse-dashes",
      "rounded-dashes",
      "oversized-radius",
      "oversized-radius-dashes",
    ]) {
      const root = createNode("page", null, {
        id: "root",
        width: 160,
        height: 120,
        fill: { type: "solid", color: "#ffffff" },
        children: ["shape"],
      });
      const node = createNode(
        kind.startsWith("ellipse") ? "ellipse" : "rectangle",
        "root",
        {
          id: "shape",
          width: 90,
          height: 60,
          transform: [1, 0, 0, 1, 30, 30],
          radius: kind.startsWith("oversized")
            ? 80
            : kind.startsWith("rounded")
              ? 16
              : 0,
          fill: { type: "none" },
        },
      );
      const gradient = {
        type: kind === "radial" ? "radial" : "linear",
        from: kind === "radial" ? [0.5, 0.5] : [0, 0],
        to: kind === "radial" ? [1, 0.5] : [1, 1],
        stops: [
          { offset: 0, color: "#ff0000" },
          { offset: 1, color: "#0000ff" },
        ],
      };
      if (["linear", "radial", "transparent-stops"].includes(kind)) {
        node.fills = [gradient];
        if (kind === "transparent-stops") {
          gradient.stops[0].opacity = 0;
          gradient.stops[1].opacity = 1;
          node.fills[0].opacity = 0.65;
        }
      } else if (kind === "stack") {
        node.fills = [
          { type: "solid", color: "#ff000080" },
          { ...gradient, opacity: 0.4 },
        ];
        node.opacity = 0.7;
      } else {
        node.fills = [{ type: "solid", color: "#ff000040" }];
        node.stroke = {
          color: "#0000ff80",
          width: 8,
          position: ["inside", "outside", "center"].includes(kind)
            ? kind
            : "outside",
          opacity: 0.7,
        };
        if (kind.includes("dashes")) node.stroke.dash = [9, 4, 2];
      }
      const doc = {
        schemaVersion: 1,
        id: "paints",
        name: "paints",
        rootId: "root",
        nodes: { root, shape: node },
        assets: {},
      };
      if (kind === "image") {
        node.type = "image";
        const c = document.createElement("canvas");
        c.width = 2;
        c.height = 2;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#22aa44";
        ctx.fillRect(0, 0, 2, 2);
        node.assetId = "img";
        doc.assets.img = {
          id: "img",
          mimeType: "image/png",
          width: 2,
          height: 2,
          dataUrl: c.toDataURL(),
        };
      }
      const svg = await raster(
        new Blob([exportSvg(doc)], { type: "image/svg+xml" }),
      );
      const png = await raster(await exportPng(doc, 1));
      ck.update(doc, { x: 0, y: 0, zoom: 1 });
      const canvas = host.querySelector("canvas");
      const ckPixels = await raster(
        await new Promise((resolve) => canvas.toBlob(resolve)),
      );
      let total = 0,
        max = 0,
        pngMax = 0,
        count = 0;
      // Full-frame mean plus interior sample maximum records AA and masks separately.
      for (let i = 0; i < svg.length; i++) {
        const diff = Math.abs(svg[i] - ckPixels[i]);
        total += diff;
        max = Math.max(max, diff);
        pngMax = Math.max(pngMax, Math.abs(svg[i] - png[i]));
        count++;
      }
      const samples = [
        [75, 60],
        [50, 45],
        [100, 70],
        [26, 60],
        [32, 60],
        [120, 60],
      ].map(([x, y]) => {
        const i = (y * 160 + x) * 4;
        return {
          x,
          y,
          svg: Array.from(svg.slice(i, i + 4)),
          ck: Array.from(ckPixels.slice(i, i + 4)),
        };
      });
      cases.push({
        kind,
        meanAbsoluteChannelError: total / count,
        maxChannelError: max,
        pngMaxChannelError: pngMax,
        samples,
      });
    }
    const backend = ck.info;
    ck.destroy();
    host.remove();
    return { cases, backend };
  });
  for (const c of results.cases) {
    console.log(c.kind, c.meanAbsoluteChannelError, c.maxChannelError);
    assert.equal(c.pngMaxChannelError, 0, `${c.kind} PNG/SVG`);
    assert(
      c.meanAbsoluteChannelError < 1.5,
      `${c.kind} full-frame mean ${c.meanAbsoluteChannelError}`,
    );
    for (const s of c.samples)
      assert(
        Math.max(...s.svg.map((v, i) => Math.abs(v - s.ck[i]))) <= 5,
        `${c.kind} interior ${JSON.stringify(s)}`,
      );
  }
  assert.deepEqual(errors, []);
  if (process.env.PAINT_PIXEL_REPORT)
    await fs.writeFile(
      process.env.PAINT_PIXEL_REPORT,
      JSON.stringify(
        {
          sourceFingerprint: await sourceFingerprint(),
          browser: browser.version(),
          ...results,
          errors,
        },
        null,
        2,
      ),
    );
} finally {
  await browser.close();
}
