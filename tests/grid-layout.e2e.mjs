import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(process.env.EDITOR_URL || "http://127.0.0.1:5173/", {
    waitUntil: "networkidle",
  });
  const cases = await page.evaluate(async () => {
    const { createNode, validateDocument } = await import("/src/core/index.ts");
    const { computeLayout } = await import("/src/flex-layout.ts");
    const { ensureFonts } = await import("/src/renderers/svg.ts");
    await ensureFonts();
    const fill = { mode: "absolute", width: "fill", height: "fill" };
    const item = (grid = {}, css = "", extra = {}) => ({
      width: 50,
      height: 20,
      layout: { ...fill, grid },
      css: `width:auto;height:auto;${css}`,
      ...extra,
    });
    const fixtures = [];
    const add = (name, grid, css, children, layout = {}, hostCSS = "") =>
      fixtures.push({
        name,
        layout: { mode: "grid", grid, ...layout },
        css: `display:grid;${css}${hostCSS}`,
        children,
      });
    add(
      "fixed-tracks-gaps-padding",
      { columns: [60, 90], rows: [40, 50] },
      "grid-template-columns:60px 90px;grid-template-rows:40px 50px;gap:10px;padding:11px 13px 17px 19px",
      [item(), item(), item()],
      { gap: 10, padding: [11, 13, 17, 19] },
    );
    add(
      "weighted-fractional-tracks",
      { columns: [60, { fr: 1 }, { fr: 2 }], rows: [{ fr: 1 }, { fr: 2 }] },
      "grid-template-columns:60px minmax(0,1fr) minmax(0,2fr);grid-template-rows:minmax(0,1fr) minmax(0,2fr);gap:7px",
      Array.from({ length: 6 }, () => item()),
      { gap: 7 },
    );
    add(
      "partial-fr-sum",
      { columns: [{ fr: 0.25 }, { fr: 0.25 }], rows: [30] },
      "grid-template-columns:minmax(0,.25fr) minmax(0,.25fr);grid-template-rows:30px",
      [item(), item()],
    );
    add(
      "auto-intrinsic-and-fraction",
      { columns: ["auto", { fr: 1 }], rows: [30] },
      "grid-template-columns:auto minmax(0,1fr);grid-template-rows:30px",
      [
        item({}, "width:80px", {
          width: 80,
          layout: { mode: "absolute", height: "fill" },
        }),
        item(),
      ],
    );
    add(
      "auto-tracks-stretch",
      { columns: ["auto", "auto"], rows: [30] },
      "grid-template-columns:auto auto;grid-template-rows:30px",
      [
        item({}, "width:80px", {
          width: 80,
          layout: { mode: "absolute", height: "fill" },
        }),
        item({}, "width:40px", {
          width: 40,
          layout: { mode: "absolute", height: "fill" },
        }),
      ],
    );
    add(
      "named-areas",
      {
        columns: [70, { fr: 1 }],
        rows: [40, { fr: 1 }],
        areas: ["head head", "nav main"],
      },
      'grid-template-columns:70px minmax(0,1fr);grid-template-rows:40px minmax(0,1fr);grid-template-areas:"head head" "nav main";gap:10px',
      [
        item({ area: "main" }, "grid-area:main"),
        item({ area: "head" }, "grid-area:head"),
        item({ area: "nav" }, "grid-area:nav"),
      ],
      { gap: 10 },
    );
    add(
      "explicit-span-overlap",
      { columns: [70, 80], rows: [40, 50] },
      "grid-template-columns:70px 80px;grid-template-rows:40px 50px;gap:10px",
      [
        item(
          { column: 1, row: 1, columnSpan: 2, rowSpan: 2 },
          "grid-column:1 / span 2;grid-row:1 / span 2",
        ),
        item({ column: 2, row: 2 }, "grid-column:2;grid-row:2"),
      ],
      { gap: 10 },
    );
    add(
      "explicit-reservation-before-auto",
      { columns: [80, 90], autoRows: 30 },
      "grid-template-columns:80px 90px;grid-auto-rows:30px",
      [item(), item({ column: 1, row: 1 }, "grid-column:1;grid-row:1"), item()],
    );
    add(
      "sparse-span-hole",
      { columns: [60, 60, 60], autoRows: 30 },
      "grid-template-columns:60px 60px 60px;grid-auto-rows:30px",
      [
        item({ columnSpan: 2 }, "grid-column:span 2"),
        item({ columnSpan: 2 }, "grid-column:span 2"),
        item(),
      ],
    );
    add(
      "row-column-locked-implicit",
      { columns: [60, 60], autoRows: 30, autoColumns: 40 },
      "grid-template-columns:60px 60px;grid-auto-rows:30px;grid-auto-columns:40px",
      [
        item({ row: 1, column: 2 }, "grid-row:1;grid-column:2"),
        item({ row: 1, columnSpan: 2 }, "grid-row:1;grid-column:span 2"),
        item({ column: 1 }, "grid-column:1"),
      ],
    );
    add(
      "span-expands-implicit-columns",
      { columns: [60], autoColumns: 40, autoRows: 30 },
      "grid-template-columns:60px;grid-auto-columns:40px;grid-auto-rows:30px",
      [item({ columnSpan: 3 }, "grid-column:span 3"), item()],
    );
    add(
      "areas-establish-implicit-template",
      { areas: ["a a", "b c"], autoColumns: 60, autoRows: 40 },
      'grid-template-areas:"a a" "b c";grid-auto-columns:60px;grid-auto-rows:40px',
      [item({ area: "a" }, "grid-area:a"), item({ area: "c" }, "grid-area:c")],
    );
    add(
      "hidden-absolute-and-locked",
      { columns: [100], autoRows: 30 },
      "grid-template-columns:100px;grid-auto-rows:30px",
      [
        item({}, "display:none", { visible: false }),
        item(
          {},
          "position:absolute;left:90px;top:80px;width:50px;height:20px",
          { layout: { ...fill, position: "absolute" } },
        ),
        item({}, "", { locked: true }),
      ],
    );
    add(
      "fill-min-max",
      { columns: [80, 90], rows: [40] },
      "grid-template-columns:80px 90px;grid-template-rows:40px",
      [
        item({}, "min-width:100px;max-height:30px", {
          layout: { ...fill, minWidth: 100, maxHeight: 30 },
        }),
        item({}, "width:50px;height:20px", { layout: { mode: "absolute" } }),
      ],
    );
    for (const align of ["start", "center", "end"])
      add(
        `vertical-${align}-overflow`,
        { columns: [100], rows: [20] },
        `grid-template-columns:100px;grid-template-rows:20px;align-items:${align}`,
        [
          item({}, "width:50px;height:40px", {
            height: 40,
            layout: { mode: "absolute" },
          }),
        ],
        { align },
      );
    add(
      "hug-auto-span",
      { columns: ["auto", "auto"], autoRows: "auto" },
      "grid-template-columns:auto auto;gap:10px;padding:5px",
      [
        item({ columnSpan: 2 }, "grid-column:span 2;width:120px;height:20px", {
          width: 120,
          layout: { mode: "absolute", grid: { columnSpan: 2 } },
        }),
      ],
      { width: "hug", height: "hug", gap: 10, padding: [5, 5, 5, 5] },
      ";width:max-content;height:max-content",
    );
    add(
      "Korean-text-width-before-hug-row",
      { columns: [100], autoRows: "auto" },
      "grid-template-columns:100px",
      [
        {
          ...item(),
          type: "text",
          layout: { mode: "absolute", width: "fill", height: "hug" },
          css: "height:auto;width:auto;word-break:break-all",
          text: {
            content: "그리드레이아웃의긴한글문장을줄바꿈합니다".repeat(2),
            fontFamily: "Noto Sans KR",
            fontSize: 16,
            fontWeight: 400,
            lineHeight: 24,
            sizing: "auto-height",
          },
        },
        item({}, "height:20px", {
          layout: { mode: "absolute", width: "fill" },
        }),
      ],
      { height: "hug" },
      ";height:max-content",
    );
    add(
      "nested-flex-in-grid",
      { columns: [120, { fr: 1 }], rows: [60] },
      "grid-template-columns:120px minmax(0,1fr);grid-template-rows:60px",
      [
        {
          ...item(),
          layout: { mode: "flex", width: "fill", height: "fill", gap: 10 },
          css: "display:flex;gap:10px",
          children: [
            item({}, "width:30px;height:20px;flex:0 0 auto", {
              width: 30,
              layout: { mode: "absolute" },
            }),
            item({}, "height:20px;flex:1 0 0px", {
              layout: { mode: "absolute", width: "fill" },
            }),
          ],
        },
        item(),
      ],
    );
    add(
      "hug-weighted-fr",
      { columns: [{ fr: 1 }, { fr: 2 }], rows: [20] },
      "grid-template-columns:minmax(0,1fr) minmax(0,2fr);grid-template-rows:20px",
      [
        item({}, "width:50px;height:20px", { layout: { mode: "absolute" } }),
        item({}, "width:50px;height:20px", { layout: { mode: "absolute" } }),
      ],
      { width: "hug" },
      ";width:max-content",
    );
    add(
      "constrained-hug-text-fraction",
      { columns: [{ fr: 1 }], autoRows: "auto" },
      "grid-template-columns:minmax(0,1fr)",
      [
        {
          ...item(),
          type: "text",
          width: 200,
          layout: { mode: "absolute", width: "fill", height: "hug" },
          css: "height:auto;width:auto;word-break:break-all",
          text: {
            content: "그리드너비제한뒤줄바꿈높이측정",
            fontFamily: "Noto Sans KR",
            fontSize: 16,
            fontWeight: 400,
            lineHeight: 24,
            sizing: "auto-height",
          },
        },
        item({}, "height:20px", {
          layout: { mode: "absolute", width: "fill" },
        }),
      ],
      { width: "hug", height: "hug", maxWidth: 100 },
      ";width:max-content;max-width:100px;height:max-content",
    );
    add(
      "row-locked-sparse-cursor",
      { columns: [60, 60, 60], autoColumns: 60, autoRows: 30 },
      "grid-template-columns:60px 60px 60px;grid-auto-columns:60px;grid-auto-rows:30px",
      [
        item({ row: 1, column: 2 }, "grid-row:1;grid-column:2"),
        item({ row: 1, columnSpan: 2 }, "grid-row:1;grid-column:span 2"),
        item({ row: 1 }, "grid-row:1"),
      ],
    );
    const results = [];
    for (const f of fixtures) {
      const pageNode = createNode("page", null, {
        id: "page",
        children: ["frame"],
      });
      const frame = createNode("frame", "page", {
        id: "frame",
        width: 300,
        height: 200,
        layout: f.layout,
      });
      const doc = {
        schemaVersion: 1,
        id: "css-grid-fixture",
        name: f.name,
        rootId: "page",
        assets: {},
        nodes: { page: pageNode, frame },
      };
      const host = document.createElement("div");
      host.style.cssText = `position:relative;box-sizing:border-box;width:300px;height:200px;justify-items:start;align-items:start;${f.css}`;
      // Fill uses explicit stretch; the default for authored fixed/hug items is start.
      document.body.append(host);
      const elements = { frame: host };
      let count = 0;
      function append(spec, parent, element) {
        const id = "item" + count++;
        const node = createNode(
          spec.type || (spec.children ? "frame" : "rectangle"),
          parent.id,
          {
            id,
            width: spec.width,
            height: spec.height,
            layout: spec.layout,
            visible: spec.visible ?? true,
            locked: spec.locked ?? false,
            transform: [1, 0, 0, 1, 90, 80],
            ...(spec.text ? { text: spec.text } : {}),
          },
        );
        doc.nodes[id] = node;
        parent.children.push(id);
        const el = document.createElement("div");
        el.style.cssText = `box-sizing:border-box;position:relative;min-width:0;min-height:0;justify-self:${spec.layout.width === "fill" ? "stretch" : "start"};align-self:${spec.layout.height === "fill" ? "stretch" : "auto"};${spec.css}`;
        if (spec.text) {
          el.textContent = spec.text.content;
          el.style.font = '400 16px "Noto Sans KR"';
          el.style.lineHeight = "24px";
        }
        element.append(el);
        elements[id] = el;
        for (const child of spec.children || []) append(child, node, el);
      }
      f.children.forEach((s) => append(s, frame, host));
      validateDocument(doc);
      const before = JSON.stringify(doc),
        computed = computeLayout(doc),
        boxes = [];
      for (const [id, el] of Object.entries(elements)) {
        if (!doc.nodes[id].visible) continue;
        const r = el.getBoundingClientRect(),
          parent =
            id === "frame" ? null : el.parentElement.getBoundingClientRect(),
          n = computed.nodes[id];
        const actual =
          id === "frame"
            ? [0, 0, n.width, n.height]
            : [n.transform[4], n.transform[5], n.width, n.height];
        const expected = [
          parent ? r.x - parent.x : 0,
          parent ? r.y - parent.y : 0,
          r.width,
          r.height,
        ];
        boxes.push({
          id,
          computed: actual,
          css: expected,
          maxError: Math.max(
            ...actual.map((v, i) => Math.abs(v - expected[i])),
          ),
        });
      }
      results.push({
        name: f.name,
        unchanged: before === JSON.stringify(doc),
        boxes,
        maxError: Math.max(...boxes.map((b) => b.maxError)),
      });
      host.remove();
    }
    return results;
  });
  const report = {
    browser: browser.version(),
    fixtureCount: cases.length,
    boxCount: cases.reduce((sum, c) => sum + c.boxes.length, 0),
    toleranceCSSPixels: 0.1,
    cases,
    errors,
  };
  await fs.writeFile(
    process.env.GRID_CSS_REPORT || artifactPath("163-l02-css-geometry.json"),
    JSON.stringify(report, null, 2),
  );
  for (const c of cases) {
    assert.ok(c.unchanged, c.name + " changed source");
    assert.ok(
      c.maxError <= 0.1,
      c.name + " error " + c.maxError + " " + JSON.stringify(c.boxes),
    );
    console.log("PASS CSS geometry " + c.name);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
