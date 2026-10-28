import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { sourceFingerprint } from "./renderer-evidence.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const browser = await chromium.launch(browserLaunchOptions());
const reports = [];
const startFingerprint = await sourceFingerprint();
try {
  for (const dpr of [1, 2]) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
      deviceScaleFactor: dpr,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(process.env.EDITOR_URL || "http://127.0.0.1:5173/", {
      waitUntil: "networkidle",
    });
    const count = await page.evaluate(async () => {
      const { createNode } = await import("/src/core/index.ts");
      const { createSvgEngine, exportPng } =
        await import("/src/renderers/svg.ts");
      const { createCanvasKitEngine } =
        await import("/src/renderers/canvaskit.ts");
      const { textLayout } = await import("/src/text-layout.ts");
      document.body.replaceChildren();
      const svgHost = document.createElement("div"),
        ckHost = document.createElement("div");
      svgHost.id = "text-svg";
      svgHost.style.cssText =
        "width:400px;height:180px;background:white;line-height:0";
      document.body.append(svgHost, ckHost);
      const svg = await createSvgEngine(svgHost, 400, 180),
        ck = await createCanvasKitEngine(ckHost, 400, 180);
      const specs = [
        ...[100, 200, 300, 400, 500, 600, 700, 800, 900].map((weight) => ({
          kind: `weight-${weight}`,
          weight,
        })),
        { kind: "kerning", content: "AV To ffi office" },
        { kind: "korean", content: "로그인하고 계속하기" },
        { kind: "combining", content: "a\u0301 e\u0308 👨‍👩‍👧‍👦" },
        { kind: "arabic", content: "مرحبا بالعالم" },
        { kind: "serif", family: "serif", content: "AV ffi 가나" },
        { kind: "monospace", family: "monospace", content: "AV ffi 가나" },
        { kind: "missing", family: "Missing Font" },
        { kind: "positive-spacing", spacing: 2 },
        { kind: "negative-spacing", spacing: -1 },
        { kind: "wrap-center", sizing: "fixed", align: "center", width: 80 },
        {
          kind: "wrap-right",
          sizing: "auto-height",
          align: "right",
          width: 80,
        },
        { kind: "overflow", content: "fÁg\n\n한글\n", size: 36 },
        { kind: "gradient-stroke" },
        { kind: "affine", transform: [0.9, 0.2, -0.1, 1.2, 40, 20] },
        { kind: "nested-clip" },
        { kind: "radial" },
        { kind: "empty", content: "\n" },
      ];
      const blobURL = (blob) =>
        new Promise((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.readAsDataURL(blob);
        });
      window.textFixture = async (index) => {
        const spec = specs[index];
        const root = createNode("page", null, {
          id: "root",
          width: 400,
          height: 180,
          children: ["text"],
          fill: { type: "solid", color: "#ffffff" },
        });
        const node = createNode("text", "root", {
          id: "text",
          width: spec.width ?? 250,
          height: 10,
          transform: spec.transform ?? [1, 0, 0, 1, 20, 10],
          fill: { type: "solid", color: "#111111" },
          text: {
            content: spec.content ?? "AV한글 ffi",
            fontFamily: spec.family ?? "Noto Sans KR",
            fontWeight: spec.weight ?? 400,
            fontSize: spec.size ?? 22,
            lineHeight: 35,
            sizing: spec.sizing ?? "auto-width",
            align: spec.align ?? "left",
            letterSpacing: spec.spacing ?? 0,
          },
        });
        if (spec.kind === "gradient-stroke") {
          node.fills = [
            {
              type: "linear",
              from: [0, 0],
              to: [1, 1],
              stops: [
                { offset: 0, color: "#ff000080", opacity: 0.7 },
                { offset: 1, color: "#0000ff" },
              ],
            },
            { type: "solid", color: "#00ff0030", opacity: 0.5 },
          ];
          node.stroke = {
            width: 1.5,
            color: "#00aa0080",
            dash: [3, 2],
            opacity: 0.6,
          };
          node.opacity = 0.7;
        }
        const doc = {
          schemaVersion: 1,
          id: "text-fixtures",
          name: "text",
          rootId: "root",
          nodes: { root, text: node },
          assets: {},
        };
        if (spec.kind === "nested-clip") {
          root.children = ["frame"];
          node.parentId = "frame";
          doc.nodes.frame = createNode("frame", "root", {
            id: "frame",
            width: 75,
            height: 55,
            children: ["text"],
            clipContent: true,
            transform: [0.95, 0.2, -0.1, 1.1, 40.25, 20.5],
            opacity: 0.6,
            fill: { type: "none" },
          });
        }
        if (spec.kind === "radial")
          node.fill = {
            type: "radial",
            from: [0.3, 0.5],
            to: [0.9, 0.5],
            stops: [
              { offset: 0, color: "#f008", opacity: 0.7 },
              { offset: 1, color: "#00f" },
            ],
          };
        svg.update(doc, { x: 0, y: 0, zoom: 1 });
        ck.update(doc, { x: 0, y: 0, zoom: 1 });
        const ckURL = ckHost.querySelector("canvas").toDataURL();
        const pngURL = await blobURL(await exportPng(doc, devicePixelRatio));
        const tspans = [
          ...(svgHost.querySelector("text")?.querySelectorAll("tspan") ?? []),
        ].map((t) => ({
          content: t.textContent,
          x: Number(t.getAttribute("x")),
          y: Number(t.getAttribute("y")),
        }));
        return {
          svgAdvance: [
            ...svgHost.querySelector("text").querySelectorAll("tspan"),
          ].map((t) => t.getComputedTextLength()),
          geometryTolerance: Math.abs(spec.spacing ?? 0) + 0.15,
          kind: spec.kind,
          layout: textLayout(node),
          tspans,
          ckURL,
          pngURL,
          backend: ck.info,
        };
      };
      window.textPixels = async (urls) => {
        const arrays = [];
        for (const src of urls) {
          const img = new Image();
          img.src = src;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          arrays.push(ctx.getImageData(0, 0, c.width, c.height).data);
        }
        const ink = (p) => {
          let x0 = Infinity,
            y0 = Infinity,
            x1 = -1,
            y1 = -1,
            count = 0;
          for (let i = 0; i < p.length; i += 4)
            if (Math.min(...p.slice(i, i + 3)) < 245) {
              const k = i / 4,
                x = k % (400 * devicePixelRatio),
                y = Math.floor(k / (400 * devicePixelRatio));
              x0 = Math.min(x0, x);
              x1 = Math.max(x1, x);
              y0 = Math.min(y0, y);
              y1 = Math.max(y1, y);
              count++;
            }
          return { bounds: count ? [x0, y0, x1, y1] : null, count };
        };
        const compare = (a, b) => {
          let sum = 0,
            max = 0,
            union = 0;
          for (let i = 0; i < a.length; i += 4) {
            const active =
              Math.min(...a.slice(i, i + 3), ...b.slice(i, i + 3)) < 245;
            if (active) union++;
            for (let j = 0; j < 3; j++) {
              const d = Math.abs(a[i + j] - b[i + j]);
              if (active) sum += d;
              max = Math.max(max, d);
            }
          }
          return {
            inkMean: union ? sum / (union * 3) : 0,
            max,
            reference: ink(a),
            candidate: ink(b),
          };
        };
        return {
          canvasKit: compare(arrays[0], arrays[1]),
          png: compare(arrays[0], arrays[2]),
        };
      };
      return specs.length;
    });
    const cases = [];
    for (let i = 0; i < count; i++) {
      const { ckURL, pngURL, ...fixture } = await page.evaluate(
        (i) => window.textFixture(i),
        i,
      );
      assert.deepEqual(
        fixture.tspans,
        fixture.layout.lines,
        `${fixture.kind} line geometry`,
      );
      if (
        fixture.layout.width !== 250 &&
        fixture.kind !== "wrap-center" &&
        fixture.kind !== "wrap-right"
      ) {
        assert(
          Math.abs(Math.max(1, ...fixture.svgAdvance) - fixture.layout.width) <=
            fixture.geometryTolerance,
          `${fixture.kind} SVG measured advance`,
        );
      }
      const dom = await page.locator("#text-svg").screenshot();
      const pixels = await page.evaluate(
        (urls) => window.textPixels(urls),
        [`data:image/png;base64,${dom.toString("base64")}`, ckURL, pngURL],
      );
      cases.push({ ...fixture, ...pixels });
      console.log(dpr, fixture.kind, JSON.stringify(pixels));
    }
    await page.screenshot({
      path: process.env.TEXT_SCREENSHOT || artifactPath(`text-dpr${dpr}.png`),
    });
    reports.push({ dpr, cases, errors, geometryPassed: true });
    await page.close();
  }
  assert.equal(
    await sourceFingerprint(),
    startFingerprint,
    "Sources changed during pixel run",
  );
  if (process.env.TEXT_PIXEL_REPORT)
    await fs.writeFile(
      process.env.TEXT_PIXEL_REPORT,
      JSON.stringify(
        {
          sourceFingerprint: await sourceFingerprint(),
          browser: browser.version(),
          reports,
        },
        null,
        2,
      ),
    );
  for (const report of reports) {
    assert.deepEqual(report.errors, []);
    for (const c of report.cases) {
      for (const [name, p] of [
        ["CanvasKit", c.canvasKit],
        ["PNG", c.png],
      ]) {
        if (c.kind === "empty") {
          assert.equal(p.candidate.count, 0);
          continue;
        }
        assert(p.reference.count > 20, `${c.kind} nonempty reference`);
        assert(
          p.candidate.count / p.reference.count > 0.9 &&
            p.candidate.count / p.reference.count < 1.1,
          `${c.kind} ${name} ink coverage`,
        );
        assert(
          Math.max(
            ...p.reference.bounds.map((v, i) =>
              Math.abs(v - p.candidate.bounds[i]),
            ),
          ) <= 2,
          `${c.kind} ${name} ink bounds`,
        );
        assert(p.inkMean < 8, `${c.kind} ${name} ink mean ${p.inkMean}`);
      }
    }
  }
} finally {
  await browser.close();
}
