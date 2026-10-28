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
    const fixtures = [];
    // Oracle styles are authored independently, not generated from computeLayout.
    const add = (
      name,
      layout,
      css,
      children,
      dimensions = { width: 300, height: 200 },
    ) => fixtures.push({ name, layout, css, children, dimensions });
    const item = (
      width = 50,
      height = 20,
      layout = { mode: "absolute" },
      css = "",
    ) => ({
      width,
      height,
      layout,
      css: `width:${width}px;height:${height}px;${css}`,
    });
    for (const direction of ["row", "column"])
      for (const justify of [
        "start",
        "center",
        "end",
        "space-between",
        "space-around",
        "space-evenly",
      ]) {
        add(
          `${direction}-${justify}`,
          {
            mode: "flex",
            direction,
            gap: 7,
            padding: [11, 13, 17, 19],
            align: "center",
            justify,
          },
          `flex-direction:${direction};gap:7px;padding:11px 13px 17px 19px;align-items:center;justify-content:${["start", "end"].includes(justify) ? "flex-" + justify : justify};`,
          [item(50, 20), item(60, 30)],
        );
      }
    add("fill-min-max-freeze", { mode: "flex", gap: 10 }, "gap:10px;", [
      item(
        50,
        20,
        { mode: "absolute", width: "fill", minWidth: 150 },
        "width:0;flex:1 0 0px;min-width:150px;",
      ),
      item(
        50,
        20,
        { mode: "absolute", width: "fill", maxWidth: 40 },
        "width:0;flex:1 0 0px;max-width:40px;",
      ),
      item(
        50,
        20,
        { mode: "absolute", width: "fill" },
        "width:0;flex:1 0 0px;",
      ),
    ]);
    add(
      "opposing-min-max-violations",
      { mode: "flex" },
      "",
      [
        item(
          50,
          20,
          { mode: "absolute", width: "fill", minWidth: 200 },
          "width:0;flex:1 0 0px;min-width:200px;",
        ),
        item(
          50,
          20,
          { mode: "absolute", width: "fill", maxWidth: 80 },
          "width:0;flex:1 0 0px;max-width:80px;",
        ),
        item(
          50,
          20,
          { mode: "absolute", width: "fill" },
          "width:0;flex:1 0 0px;",
        ),
      ],
      { width: 250, height: 100 },
    );
    add("fixed-plus-fill-overflow", { mode: "flex" }, "", [
      item(320, 20),
      item(
        50,
        20,
        { mode: "absolute", width: "fill", minWidth: 20 },
        "width:0;flex:1 0 0px;min-width:20px;",
      ),
    ]);
    add(
      "cross-fill-max",
      { mode: "flex", align: "end", padding: [10, 10, 10, 10] },
      "padding:10px;align-items:flex-end;",
      [
        item(50, 20),
        item(
          50,
          20,
          { mode: "absolute", height: "fill", maxHeight: 100 },
          "height:100%;max-height:100px;",
        ),
      ],
    );
    add(
      "wrap-hug-height",
      {
        mode: "flex",
        wrap: true,
        height: "hug",
        gap: 10,
        padding: [5, 5, 5, 5],
      },
      "height:auto;flex-wrap:wrap;gap:10px;padding:5px;align-content:flex-start;",
      [item(150, 20), item(150, 30), item(100, 20)],
    );
    add(
      "hug-both",
      {
        mode: "flex",
        width: "hug",
        height: "hug",
        gap: 7,
        padding: [2, 3, 4, 5],
      },
      "width:max-content;height:max-content;gap:7px;padding:2px 3px 4px 5px;",
      [item(50, 20), item(60, 30)],
    );
    add(
      "column-wrap",
      { mode: "flex", direction: "column", wrap: true, gap: 10 },
      "flex-direction:column;flex-wrap:wrap;gap:10px;align-content:flex-start;",
      [item(30, 100), item(40, 100), item(50, 50)],
    );
    add(
      "absolute-and-hidden",
      { mode: "flex", width: "hug", height: "hug", padding: [10, 10, 10, 10] },
      "width:max-content;height:max-content;padding:10px;",
      [
        item(50, 20),
        {
          ...item(900, 50),
          visible: false,
          css: "display:none;width:900px;height:50px;",
        },
        {
          ...item(
            70,
            30,
            { mode: "absolute", position: "absolute" },
            "position:absolute;left:13px;top:17px;",
          ),
          transform: [1, 0, 0, 1, 13, 17],
        },
      ],
    );
    add(
      "korean-fill-text",
      {
        mode: "flex",
        direction: "column",
        height: "hug",
        padding: [5, 5, 5, 5],
        gap: 8,
      },
      "height:auto;flex-direction:column;padding:5px;gap:8px;",
      [
        {
          ...item(
            50,
            20,
            { mode: "absolute", width: "fill", height: "hug" },
            "width:auto;height:auto;align-self:stretch;",
          ),
          type: "text",
          text: {
            content: "긴한글텍스트를여러줄로배치하고높이를계산합니다".repeat(3),
            fontFamily: "Noto Sans KR",
            fontSize: 16,
            fontWeight: 400,
            lineHeight: 24,
            sizing: "auto-height",
          },
        },
        item(50, 20),
      ],
      { width: 180, height: 200 },
    );
    add(
      "korean-hug-text",
      { mode: "flex", width: "hug", height: "hug", gap: 5 },
      "width:max-content;height:max-content;gap:5px;",
      [
        {
          ...item(
            50,
            20,
            { mode: "absolute", width: "hug", height: "hug" },
            "width:max-content;height:auto;white-space:pre;",
          ),
          type: "text",
          text: {
            content: "로그인하고계속하기",
            fontFamily: "Noto Sans KR",
            fontSize: 16,
            fontWeight: 400,
            lineHeight: 24,
          },
        },
        item(30, 20),
      ],
    );
    add(
      "nested-fill",
      { mode: "flex", direction: "column", gap: 10, padding: [10, 10, 10, 10] },
      "flex-direction:column;gap:10px;padding:10px;",
      [
        {
          ...item(
            50,
            80,
            { mode: "flex", width: "fill", padding: [5, 5, 5, 5] },
            "width:auto;align-self:stretch;display:flex;padding:5px;",
          ),
          children: [
            item(
              20,
              20,
              { mode: "absolute", width: "fill", height: "fill" },
              "width:0;flex:1 0 0px;height:auto;align-self:stretch;",
            ),
          ],
        },
        item(50, 20),
      ],
    );
    for (const justify of [
      "center",
      "end",
      "space-around",
      "space-evenly",
      "space-between",
    ])
      add(
        "overflow-" + justify,
        { mode: "flex", justify, align: "center" },
        `justify-content:${justify === "end" ? "flex-end" : justify};align-items:center;`,
        [item(400, 300)],
      );
    add(
      "nested-wrap-hug",
      { mode: "flex", direction: "column", height: "hug" },
      "flex-direction:column;height:max-content;",
      [
        {
          ...item(
            100,
            20,
            { mode: "flex", height: "hug", wrap: true },
            "display:flex;flex-wrap:wrap;height:auto;align-content:flex-start;",
          ),
          children: [item(80, 20), item(80, 20)],
        },
        item(20, 10),
      ],
    );
    add(
      "padding-floor",
      {
        mode: "flex",
        width: "hug",
        height: "hug",
        maxWidth: 10,
        padding: [10, 30, 10, 30],
      },
      "width:max-content;height:max-content;max-width:10px;padding:10px 30px;",
      [],
    );
    add(
      "fixed-fill-korean-minmax-wrap",
      {
        mode: "flex",
        height: "hug",
        wrap: true,
        gap: 10,
        padding: [10, 10, 10, 10],
      },
      "height:auto;flex-wrap:wrap;align-content:flex-start;gap:10px;padding:10px;",
      [
        item(60, 30),
        {
          ...item(
            50,
            20,
            {
              mode: "absolute",
              width: "fill",
              height: "hug",
              minWidth: 80,
              maxWidth: 140,
            },
            "width:0;flex:1 0 0px;min-width:80px;max-width:140px;height:auto;",
          ),
          type: "text",
          text: {
            content: "고정폭형제와남은공간을나누는긴한글텍스트".repeat(3),
            fontFamily: "Noto Sans KR",
            fontSize: 16,
            fontWeight: 400,
            lineHeight: 24,
            sizing: "auto-height",
          },
        },
        item(150, 25),
      ],
    );
    const results = [];
    for (const f of fixtures) {
      const pageNode = createNode("page", null, {
          id: "page",
          children: ["frame"],
        }),
        frame = createNode("frame", "page", {
          id: "frame",
          ...f.dimensions,
          layout: f.layout,
        });
      const doc = {
        schemaVersion: 1,
        id: "css-fixture",
        name: f.name,
        rootId: "page",
        assets: {},
        nodes: { page: pageNode, frame },
      };
      const host = document.createElement("div");
      host.style.cssText = `position:relative;display:flex;box-sizing:border-box;align-items:flex-start;width:${frame.width}px;height:${frame.height}px;${f.css}`;
      document.body.append(host);
      const elements = { frame: host };
      let count = 0;
      function append(spec, parent, element) {
        const id = "item" + count++,
          node = createNode(
            spec.type || (spec.children ? "frame" : "rectangle"),
            parent.id,
            {
              id,
              width: spec.width,
              height: spec.height,
              layout: spec.layout,
              visible: spec.visible ?? true,
              transform: spec.transform || [1, 0, 0, 1, 90, 80],
              ...(spec.text ? { text: spec.text } : {}),
            },
          );
        doc.nodes[id] = node;
        parent.children.push(id);
        const el = document.createElement("div");
        el.style.cssText = `box-sizing:border-box;position:relative;flex:0 0 auto;min-width:0;min-height:0;align-items:flex-start;${spec.css}`;
        if (spec.text) {
          el.textContent = spec.text.content;
          el.style.font = '400 16px "Noto Sans KR"';
          el.style.lineHeight = "24px";
          el.style.wordBreak = "break-all";
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
        const rect = el.getBoundingClientRect(),
          parent =
            id === "frame" ? null : el.parentElement.getBoundingClientRect();
        const n = computed.nodes[id],
          actual =
            id === "frame"
              ? [0, 0, n.width, n.height]
              : [n.transform[4], n.transform[5], n.width, n.height];
        const expected = [
          parent ? rect.x - parent.x : 0,
          parent ? rect.y - parent.y : 0,
          rect.width,
          rect.height,
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
    process.env.FLEX_CSS_REPORT || artifactPath("142-l01-css-geometry.json"),
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
