import { serverTestUrl, browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { authenticatedTestSession } from "./auth-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const url = serverTestUrl();
const auth = await authenticatedTestSession(url);
const browser = await chromium.launch(browserLaunchOptions());
const errors = [];
const close = (a, b, tolerance = 1e-3) =>
  assert(Math.abs(a - b) < tolerance, `${a} != ${b}`);
let passed = 0;
try {
  for (const rotated of [false, true]) {
    const context = await browser.newContext({
        storageState: auth.storageState,
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url, {
      waitUntil: "networkidle",
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="save-status"]')
          .getAttribute("data-state") !== "loading",
    );
    assert.equal(
      await page.evaluate(() => typeof window.__draftroom),
      "undefined",
    );
    const make = (id, type, parentId, x, y, width, height, props = {}) => ({
      id,
      name: id,
      type,
      parentId,
      children: [],
      transform: [1, 0, 0, 1, x, y],
      width,
      height,
      fill: { type: "solid", color: "#A8A0F6" },
      opacity: 1,
      radius: 0,
      clipContent: false,
      visible: true,
      locked: false,
      layout: { mode: "absolute" },
      ...props,
    });
    const c = rotated ? Math.sqrt(3) / 2 : 1,
      s = rotated ? 0.5 : 0;
    const d = {
      schemaVersion: 1,
      id: "snap-production",
      name: "Snap production",
      rootId: "page",
      assets: {},
      nodes: {
        page: make("page", "page", null, 0, 0, 1000, 800, {
          children: ["p"],
          fill: { type: "none" },
        }),
        p: make("p", "frame", "page", 350, 100, 500, 400, {
          children: ["a", "b"],
          transform: [c, s, -s, c, 350, 100],
          fill: { type: "none" },
        }),
        a: make("a", "rectangle", "p", 50, 70, 40, 30),
        b: make("b", "rectangle", "p", 200, 200, 100, 80, {
          fill: { type: "solid", color: "#84C9FF" },
        }),
      },
    };
    await page
      .locator('input[type=file][accept="application/json,.json"]')
      .setInputFiles({
        name: "snap-production.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(d)),
      });
    const saved = () =>
      page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="save-status"]')
            .getAttribute("data-state") === "saved",
      );
    await saved();
    await page.waitForTimeout(100);
    const button = (name) => page.getByRole("button", { name, exact: true });
    const exportDoc = async () => {
      const event = page.waitForEvent("download");
      await button("JSON 저장").click();
      const download = await event,
        stream = await download.createReadStream();
      const chunks = [];
      for await (const part of stream) chunks.push(part);
      return JSON.parse(Buffer.concat(chunks).toString());
    };
    const before = await exportDoc();
    await page.getByTestId("layer-a").locator(".layer-name").click();
    const r = await page.getByTestId("canvas-stage").boundingBox(),
      rect = page.locator(".selection-overlay > g > rect").first();
    const attrs = await rect.evaluate((el) => ({
      x: +el.getAttribute("x"),
      y: +el.getAttribute("y"),
      width: +el.getAttribute("width"),
    }));
    const zoom = attrs.width / (40 * c + 30 * s),
      vx = attrs.x - (350 + 50 * c - 100 * s) * zoom,
      vy = attrs.y - (100 + 50 * s + 70 * c) * zoom;
    const move = async (x, y) =>
      page.mouse.move(
        r.x + vx + (350 + c * x - s * y) * zoom,
        r.y + vy + (100 + s * x + c * y) * zoom,
      );
    await move(70, 85);
    await page.mouse.down();
    await move(218, 115);
    assert((await page.getByTestId("snap-guide").count()) > 0);
    if (rotated)
      await page.screenshot({
        path: process.env.SNAP_SCREENSHOT || artifactPath("28-snapping-preview.png"),
        fullPage: true,
      });
    await page.mouse.up();
    const after = await exportDoc();
    close(after.nodes.a.transform[4], 200);
    close(after.nodes.a.transform[5], 100);
    await button("실행 취소").click();
    assert.deepEqual(await exportDoc(), before);
    assert(await button("실행 취소").isDisabled());
    await button("다시 실행").click();
    assert.deepEqual(await exportDoc(), after);
    await saved();
    await page.reload({ waitUntil: "networkidle" });
    await saved();
    assert.deepEqual(await exportDoc(), after);
    // Undo history restarts after reload; restore the fixture for resize verification.
    await page
      .locator('input[type=file][accept="application/json,.json"]')
      .setInputFiles({
        name: "snap-production.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(d)),
      });
    await saved();
    await page.waitForTimeout(100);
    await page.getByTestId("layer-a").locator(".layer-name").click();
    const h = await button("오른쪽 아래 크기 조절").boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await move(197, 170);
    assert((await page.getByTestId("snap-guide").count()) > 0);
    await page.mouse.up();
    const resized = await exportDoc();
    close(resized.nodes.a.width, 150);
    // Preserve pointer grab offset; allow the initial CSS point quantization.
    close(resized.nodes.a.height, 100, 0.03);
    assert.deepEqual(resized.nodes.a.transform, before.nodes.a.transform);
    await button("실행 취소").click();
    assert.deepEqual(await exportDoc(), before);
    passed++;
    console.log(
      `PASS production ${rotated ? "rotated" : "normal"} parent: guides, move/resize, JSON, Undo/Redo, autosave reload`,
    );
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed, pageErrors: errors, browser: browser.version() }),
  );
} finally {
  await browser.close();
}
