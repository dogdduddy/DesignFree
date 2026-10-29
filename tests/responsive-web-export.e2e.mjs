import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage();
const output = await browser.newPage();
const checks = [];
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
output.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(process.env.EDITOR_URL || "http://127.0.0.1:5173/");
  const fixtures = await page.evaluate(async () => {
    const { createNode } = await import("/src/core/index.ts");
    const { computeLayout } = await import("/src/flex-layout.ts");
    const { exportFrameWeb } = await import("/src/web-export.ts");
    const fixtures = [];
    const add = (name, layout, specs, rootExtra = {}, fallback = false) => {
      const page = createNode("page", null, {
        id: "page",
        children: ["frame"],
      });
      const frame = createNode("frame", "page", {
        id: "frame",
        width: 500,
        height: 260,
        children: specs.map((_, i) => `item${i}`),
        layout,
        ...rootExtra,
      });
      const nodes = { page, frame };
      specs.forEach((spec, i) => {
        const id = `item${i}`;
        nodes[id] = createNode(
          spec.layout?.mode === "flex" || spec.layout?.mode === "grid"
            ? "frame"
            : "rectangle",
          "frame",
          {
            id,
            width: 75,
            height: 35,
            ...spec,
          },
        );
        if (spec.children) {
          nodes[id].type = "frame";
          nodes.inner = createNode("rectangle", id, {
            id: "inner",
            width: 30,
            height: 20,
            layout: { mode: "absolute", width: "fill", height: "fill" },
          });
        }
      });
      const doc = {
        schemaVersion: 1,
        id: "responsive",
        name,
        rootId: "page",
        nodes,
        assets: {},
      };
      const before = JSON.stringify(doc);
      const exported = exportFrameWeb(doc, "frame");
      if (JSON.stringify(doc) !== before)
        throw new Error("Export changed authored scene");
      const expected = [320, 480, 768, 1100].map((width) => {
        const resized = structuredClone(doc);
        if (!fallback) resized.nodes.frame.width = width;
        const computed = computeLayout(resized);
        return {
          width,
          boxes: Object.values(computed.nodes)
            .filter((n) => n.id !== "page" && n.visible)
            .map((n) => ({
              id: n.id,
              parentId: n.parentId,
              x: n.id === "frame" ? 0 : n.transform[4],
              y: n.id === "frame" ? 0 : n.transform[5],
              width: n.width,
              height: n.height,
            })),
        };
      });
      fixtures.push({ name, ...exported, expected, fallback });
    };
    const fixed = { layout: { mode: "absolute" } };
    const fill = {
      layout: { mode: "absolute", width: "fill", height: "fill" },
    };
    for (const direction of ["row", "column"])
      for (const justify of [
        "start",
        "center",
        "end",
        "space-between",
        "space-around",
        "space-evenly",
      ])
        add(
          `flex-${direction}-${justify}`,
          {
            mode: "flex",
            direction,
            justify,
            align: "center",
            gap: 9,
            padding: [11, 13, 17, 19],
          },
          [fixed, { width: 90, height: 50 }, fixed],
        );
    for (const direction of ["row", "column"]) {
      add(
        `flex-${direction}-fill-min-max`,
        {
          mode: "flex",
          direction,
          gap: 10,
          align: "end",
          padding: [7, 9, 11, 13],
        },
        [
          {
            layout: {
              ...fill.layout,
              minWidth: 60,
              maxWidth: 130,
              minHeight: 40,
              maxHeight: 90,
            },
          },
          fill,
          fill,
        ],
      );
      add(
        `flex-${direction}-wrap`,
        {
          mode: "flex",
          direction,
          wrap: true,
          gap: 12,
          align: "end",
          justify: "space-between",
          padding: [8, 10, 12, 14],
        },
        Array.from({ length: 9 }, (_, i) => ({
          width: 80 + i * 3,
          height: 40 + i * 2,
        })),
      );
    }
    add(
      "nested-flex-grid",
      { mode: "flex", gap: 11, padding: [13, 13, 13, 13] },
      [
        {
          children: ["inner"],
          layout: {
            mode: "grid",
            width: "fill",
            height: "fill",
            grid: { columns: [{ fr: 1 }], rows: [{ fr: 1 }] },
            padding: [6, 6, 6, 6],
          },
        },
        { width: 100, height: 100 },
        {
          width: 30,
          height: 20,
          transform: [1, 0, 0, 1, 55, 66],
          layout: { mode: "absolute", position: "absolute" },
        },
        { visible: false },
      ],
    );
    const grid = (name, settings, specs, extra = {}) =>
      add(
        name,
        {
          mode: "grid",
          gap: 7,
          padding: [11, 13, 17, 19],
          grid: settings,
          ...extra,
        },
        specs,
      );
    grid(
      "grid-fr",
      { columns: [60, { fr: 1 }, { fr: 2 }], rows: [{ fr: 1 }, { fr: 2 }] },
      Array.from({ length: 6 }, () => fill),
    );
    grid(
      "grid-partial-fr",
      { columns: [{ fr: 0.25 }, { fr: 0.25 }], rows: [80] },
      [fill, fill],
    );
    grid("grid-auto-fixed", { columns: ["auto", "auto"], rows: [50] }, [
      fixed,
      { width: 100, height: 30 },
    ]);
    grid("grid-auto-plus-fr", { columns: ["auto", { fr: 1 }], rows: [50] }, [
      fixed,
      fixed,
    ]);
    grid(
      "grid-auto-partial-fr",
      { columns: ["auto", { fr: 0.25 }], rows: ["auto", { fr: 0.3 }] },
      [fixed, fixed, fixed, fixed],
    );
    grid(
      "grid-areas-span",
      {
        columns: [60, { fr: 1 }, { fr: 2 }],
        rows: [50, { fr: 1 }],
        areas: ["header header side", "main main side"],
      },
      [
        { layout: { ...fill.layout, grid: { area: "header" } } },
        { layout: { ...fill.layout, grid: { area: "side" } } },
        { layout: { ...fill.layout, grid: { area: "main" } } },
      ],
    );
    grid(
      "grid-sparse-implicit",
      { columns: [80, { fr: 1 }], rows: [60], autoRows: 70, autoColumns: 55 },
      [
        { layout: { ...fill.layout, grid: { row: 2 } } },
        { layout: { ...fill.layout, grid: { column: 2, columnSpan: 2 } } },
        fill,
        fill,
      ],
    );
    for (const align of ["start", "center", "end", "stretch"])
      grid(
        `grid-clamped-fill-${align}`,
        { columns: [{ fr: 1 }, { fr: 2 }], rows: [{ fr: 1 }] },
        [
          {
            layout: {
              ...fill.layout,
              minWidth: 80,
              maxWidth: 130,
              maxHeight: 70,
            },
          },
          fill,
        ],
        { align },
      );
    add(
      "root-constraints",
      { mode: "flex", minWidth: 400, maxWidth: 800, gap: 10 },
      [fill, fill],
    );
    add("padding-floor", { mode: "flex", gap: 10 }, [
      {
        children: ["inner"],
        layout: {
          mode: "flex",
          width: "fill",
          height: "fill",
          padding: [9, 60, 10, 70],
          maxWidth: 100,
        },
      },
      fixed,
    ]);
    for (const direction of ["row", "column"])
      add(
        `fallback-unequal-fill-padding-${direction}`,
        { mode: "flex", direction },
        [
          {
            layout: {
              mode: "flex",
              width: "fill",
              height: "fill",
              padding: [20, 50, 20, 50],
            },
          },
          fill,
        ],
        {},
        true,
      );
    add(
      "fallback-hug-container",
      { mode: "flex", width: "hug", gap: 10 },
      [fixed, fixed],
      {},
      true,
    );
    add(
      "fallback-wrap-cross-fill",
      { mode: "flex", wrap: true },
      [fill, fill],
      {},
      true,
    );
    add(
      "fallback-grid-auto-fill",
      { mode: "grid", grid: { columns: ["auto"], rows: [40] } },
      [fill],
      {},
      true,
    );
    add(
      "fallback-grid-spanning-auto",
      { mode: "grid", grid: { columns: ["auto", "auto"], rows: [40] } },
      [{ layout: { mode: "absolute", grid: { columnSpan: 2 } } }],
      {},
      true,
    );
    for (const justify of ["center", "end", "space-around", "space-evenly"])
      add(
        `flex-overflow-${justify}`,
        { mode: "flex", justify, gap: 10 },
        Array.from({ length: 3 }, () => ({ width: 180, height: 30 })),
      );
    return fixtures;
  });
  for (const fixture of fixtures) {
    assert.equal(
      fixture.warnings.some((w) => w.includes("대응 불가")),
      fixture.fallback,
      `${fixture.name}: ${fixture.warnings}`,
    );
    if (!fixture.fallback)
      assert.ok(/display:(flex|grid)/.test(fixture.css), fixture.name);
    await output.setContent(fixture.html);
    for (const sample of fixture.expected) {
      await output.setViewportSize({ width: sample.width, height: 900 });
      const actual = await output.evaluate(() =>
        [...document.querySelectorAll("[data-node-id]")].map((el) => {
          const r = el.getBoundingClientRect();
          const p = el.parentElement
            .closest("[data-node-id]")
            ?.getBoundingClientRect() ?? { x: 0, y: 0 };
          return {
            id: el.dataset.nodeId,
            x: r.x - p.x,
            y: r.y - p.y,
            width: r.width,
            height: r.height,
          };
        }),
      );
      for (const expected of sample.boxes) {
        const box = actual.find((a) => a.id === expected.id);
        assert.ok(box, expected.id);
        for (const axis of ["x", "y", "width", "height"])
          assert.ok(
            Math.abs(box[axis] - expected[axis]) < 0.1,
            `${fixture.name} viewport=${sample.width} ${box.id}.${axis}: ${box[axis]} != ${expected[axis]}`,
          );
      }
      checks.push({
        name: fixture.name,
        viewport: sample.width,
        boxes: actual.length,
      });
    }
    console.log(`PASS ${fixture.name} at 4 viewport widths`);
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(
    artifactPath("w01-responsive-web.json"),
    JSON.stringify({ browser: browser.version(), checks, errors }, null, 2),
  );
} finally {
  await browser.close();
}
