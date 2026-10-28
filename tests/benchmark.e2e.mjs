import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { sourceFingerprint } from "./renderer-evidence.mjs";
import { rendererGate } from "../src/renderer-gate.ts";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const b = await chromium.launch(browserLaunchOptions());
try {
  const p = await b.newPage({
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => {
    if (m.text().startsWith("[bench]")) console.log(m.text());
  });
  await p.goto(
    (process.env.EDITOR_URL || "http://127.0.0.1:5173") + "/bench.html",
    { waitUntil: "networkidle" },
  );
  await p.locator(".references svg text").first().waitFor();
  await p.locator(".references canvas").waitFor({ timeout: 30000 });
  await p.waitForTimeout(500);
  const gl = await p.evaluate(() => {
    const c = document.createElement("canvas"),
      g = c.getContext("webgl2") || c.getContext("webgl");
    if (!g) return { available: false };
    const d = g.getExtension("WEBGL_debug_renderer_info");
    const out = {
      available: true,
      vendor: g.getParameter(g.VENDOR),
      renderer: g.getParameter(g.RENDERER),
      unmaskedRenderer: d
        ? g.getParameter(d.UNMASKED_RENDERER_WEBGL)
        : "unavailable",
    };
    g.getExtension("WEBGL_lose_context")?.loseContext();
    return out;
  });
  const sections = p.locator(".references section");
  await sections.nth(0).screenshot({ path: artifactPath("08-reference-svg.png") });
  await sections.nth(1).screenshot({ path: artifactPath("09-reference-canvaskit.png") });
  const result = await p.evaluate(() =>
    window.runRendererBenchmarks((message) =>
      console.log("[bench] " + message),
    ),
  );
  result.browserVersion = b.version();
  result.webglProbe = gl;
  result.browserErrors = errors;
  result.backgroundLoadCaveat =
    "Local desktop background activity not controlled; headless single-browser engineering measurement, not production performance guarantee";
  if (process.env.TEXT_PIXEL_REPORT && process.env.PAINT_PIXEL_REPORT) {
    const text = JSON.parse(
      await fs.readFile(process.env.TEXT_PIXEL_REPORT, "utf8"),
    );
    const shapes = JSON.parse(
      await fs.readFile(process.env.PAINT_PIXEL_REPORT, "utf8"),
    );
    result.rendererGate = {
      ...rendererGate(
        text,
        shapes,
        await sourceFingerprint(),
        b.version(),
        result.cases.filter((c) => c.status === "measured").length,
      ),
      evidence: {
        text: process.env.TEXT_PIXEL_REPORT,
        shapes: process.env.PAINT_PIXEL_REPORT,
      },
    };

  }
  await fs.writeFile(
    artifactPath("07-renderer-benchmark.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        cases: result.cases.map((c) => ({
          renderer: c.renderer,
          count: c.nodeCount,
          status: c.status,
          error: c.error,
          backend: c.backend?.backend,
          ops: Object.fromEntries(
            Object.entries(c.operations || {}).map(([k, v]) => [
              k,
              {
                p50: v.synchronousUpdateWallMs.p50,
                p95: v.synchronousUpdateWallMs.p95,
              },
            ]),
          ),
        })),
        rendererGate: result.rendererGate,
        webglProbe: gl,
        errors,
      },
      null,
      2,
    ),
  );
  assert.equal(result.cases.filter((c) => c.status === "measured").length, 6);
  assert.deepEqual(errors, []);
  if(process.env.TEXT_PIXEL_REPORT && process.env.PAINT_PIXEL_REPORT) assert(result.rendererGate.passed,"Current renderer fixture gate");
} finally {
  await b.close();
}
