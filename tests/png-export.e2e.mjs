import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

// Run against an existing Vite server; uses only bundled font and browser APIs.
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage();
  await page.goto(process.env.EDITOR_URL || "http://127.0.0.1:5173/", {
    waitUntil: "networkidle",
  });
  const results = await page.evaluate(async () => {
    const { exportPng } = await import("/src/renderers/svg.ts");
    const { createNode } = await import("/src/core/index.ts");
    const root = createNode("page", null, {
      id: "root",
      width: 64,
      height: 64,
      fill: { type: "solid", color: "#ffffff" },
      children: ["line", "text"],
    });
    const line = createNode("rectangle", "root", {
      id: "line",
      width: 0.5,
      height: 10,
      transform: [1, 0, 0, 1, 10.25, 0],
      fill: { type: "solid", color: "#000000" },
    });
    const text = createNode("text", "root", {
      id: "text",
      width: 64,
      height: 48,
      transform: [1, 0, 0, 1, 0, 12],
      fill: { type: "solid", color: "#000000" },
      text: {
        content: "한글\n벡터",
        fontSize: 12,
        fontWeight: 900,
        lineHeight: 18,
        fontFamily: "Noto Sans KR",
      },
    });
    const doc = {
      schemaVersion: 1,
      rootId: "root",
      nodes: { root, line, text },
      assets: {},
    };
    const results = [];
    for (const scale of [1, 2, 3, 4]) {
      const blob = await exportPng(doc, scale);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const header = new DataView(bytes.buffer);
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const pixel = [
        ...ctx.getImageData(Math.floor(10.5 * scale), scale, 1, 1).data,
      ];
      const ink = (y1, y2) => {
        const data = ctx.getImageData(
          0,
          y1 * scale,
          40 * scale,
          (y2 - y1) * scale,
        ).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] < 200) count++;
        return count;
      };
      results.push({
        scale,
        signature: [...bytes.slice(0, 8)],
        width: header.getUint32(16),
        height: header.getUint32(20),
        pixel,
        textInk: [ink(14, 26), ink(32, 44)],
      });
      bitmap.close();
    }
    return results;
  });
  for (const result of results) {
    assert.deepEqual(result.signature, [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(result.width, 64 * result.scale);
    assert.equal(result.height, 64 * result.scale);
    assert(
      result.textInk.every((ink) => ink > 15),
      "Both Korean text lines must have visible glyphs",
    );
  }
  // Half-pixel geometry is grey at 1x but resolves into solid black pixels at
  // 4x. Upscaling the 1x bitmap cannot pass this vector-density regression.
  assert(results[0].pixel[0] > 60 && results[0].pixel[0] < 200);
  assert.deepEqual(results[3].pixel, [0, 0, 0, 255]);
  console.log(JSON.stringify({ status: "passed", results }, null, 2));
} finally {
  await browser.close();
}
