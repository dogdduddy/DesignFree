import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const browser = await chromium.launch(browserLaunchOptions());
const report = {
  browser: browser.version(),
  url: process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/",
  checks: [],
  errors: [],
  timings: [],
  protocol:
    "Native pointer/wheel capture to two RAF callbacks (18 samples after 3 warmups); includes React/model/history/render scheduling, not proof of presentation. SVG default; no FPS claim.",
};
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (e) => report.errors.push(e.message));
  // Generate fixture in Vite, then import using the same file boundary on dev/production.
  await page.goto(new URL("bench.html", process.env.EDITOR_URL || process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/").href, {
    waitUntil: "networkidle",
  });
  const fixtures = await page.evaluate(async () => {
    const { createBenchmarkDocument } = await import("/src/core/index.ts");
    return [1000, 10000].map(createBenchmarkDocument);
  });
  await page.goto(report.url, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="save-status"]').dataset.state !==
      "loading",
  );
  const exported = async () => {
    const d = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
    const chunks = [];
    for await (const c of await (await d).createReadStream()) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  for (const doc of fixtures) {
    const count = Object.keys(doc.nodes).length;
    // A separate, topmost visible target avoids overlapping fixture frames in native drag tests.
    const target = doc.nodes["bench-4"];
    doc.nodes[target.parentId].children = doc.nodes[
      target.parentId
    ].children.filter((id) => id !== target.id);
    target.parentId = doc.rootId;
    target.transform = [1, 0, 0, 1, 40, 40];
    target.width = 80;
    target.height = 60;
    doc.nodes[doc.rootId].children.push(target.id);
    await page
      .locator('input[type=file][accept="application/json,.json"]')
      .setInputFiles({
        name: "large.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(doc)),
      });
    await page.waitForTimeout(800);
    assert.equal(Object.keys((await exported()).nodes).length, count);
    assert((await page.locator(".layer").count()) < 70);
    report.checks.push(`${count}: import with bounded layer DOM`);
    const tree = page.locator(".layer-tree");
    await tree.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(100);
    await page.getByTestId("layer-bench-4").locator(".layer-name").click();
    assert(
      await page
        .getByTestId("layer-bench-4")
        .evaluate((el) => el.classList.contains("selected")),
    );
    await tree.evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(100);
    const first = page.getByTestId("layer-bench-1");
    await first.locator(".tree-chevron").click();
    assert.equal(await page.getByTestId("layer-bench-2").count(), 0);
    await first.locator(".tree-chevron").click();
    assert.equal(await page.getByTestId("layer-bench-2").count(), 1);
    report.checks.push(`${count}: scroll to last, select, collapse/expand`);
    // Capture real stage event work through two RAF. Drive one event at a time.
    await page.evaluate(() => {
      window.samples = [];
      const el = document.querySelector('[data-testid="canvas-stage"]');
      window.capture = (e) => {
        if (!window.measuring) return;
        const t = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            window.samples.push(performance.now() - t),
          ),
        );
      };
      el.addEventListener("pointermove", window.capture, { capture: true });
      el.addEventListener("wheel", window.capture, { capture: true });
    });
    const box = await page.getByTestId("canvas-stage").boundingBox();
    const settle = () =>
      page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
    const measure = async (op, action) => {
      await page.evaluate(() => {
        window.samples = [];
        window.measuring = true;
      });
      for (let i = 0; i < 21; i++) {
        await action(i);
        await settle();
      }
      await page.evaluate(() => (window.measuring = false));
      const values = await page.evaluate(() => window.samples.slice(3));
      assert.equal(values.length, 18);
      const sorted = [...values].sort((a, b) => a - b);
      report.timings.push({
        count,
        operation: op,
        viewport: await page
          .locator(".renderer-surface svg > g")
          .getAttribute("transform"),
        p50: sorted[8],
        p95: sorted[17],
        samples: values,
      });
    };
    await page.mouse.move(box.x + 400, box.y + 300);
    await page.keyboard.down("Space");
    await page.mouse.down();
    await measure("pan", (i) => page.mouse.move(box.x + 400 + i, box.y + 300));
    await page.mouse.up();
    await page.keyboard.up("Space");
    await page.keyboard.down("Control");
    await measure("zoom", () => page.mouse.wheel(0, -1));
    await page.keyboard.up("Control");
    // Reimport resets viewport and isolates the drag transaction.
    await page
      .locator('input[type=file][accept="application/json,.json"]')
      .setInputFiles({
        name: "large.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(doc)),
      });
    await page.waitForTimeout(600);
    assert.deepEqual((await exported()).nodes, doc.nodes);
    await page.waitForTimeout(200);
    const view = await page
      .locator(".renderer-surface svg > g")
      .getAttribute("transform");
    const [vx, vy, z] = view.match(/-?[\d.]+/g).map(Number);
    const x = box.x + vx + 60 * z,
      y = box.y + vy + 60 * z;
    await page.mouse.move(x, y);
    await page.keyboard.down("Meta");
    await page.mouse.down();
    await measure("drag", (i) => page.mouse.move(x + i + 1, y));
    await page.mouse.up();
    await page.keyboard.up("Meta");
    const moved = await exported();
    assert.notDeepEqual(
      moved.nodes["bench-4"].transform,
      doc.nodes["bench-4"].transform,
    );
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(150);
    assert.deepEqual((await exported()).nodes, doc.nodes);
    await page.keyboard.press("Meta+Shift+z");
    await page.waitForTimeout(150);
    assert.deepEqual((await exported()).nodes, moved.nodes);
    report.checks.push(`${count}: native pan/zoom/drag, one-step Undo/Redo`);
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="save-status"]').dataset.state ===
        "saved",
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="save-status"]').dataset.state !==
        "loading",
    );
    assert.deepEqual((await exported()).nodes, moved.nodes);
    report.checks.push(`${count}: autosave reload preserves final document`);
  }
  assert.deepEqual(report.errors, []);
  await fs.writeFile(
    process.env.LARGE_UI_REPORT || artifactPath("67-large-document-ui-validation.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      { ...report, timings: report.timings.map(({ samples, ...t }) => t) },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
