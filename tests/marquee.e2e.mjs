import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch(browserLaunchOptions());
let page, view;
const errors = [],
  checks = [];
const button = (name) => page.getByRole("button", { name, exact: true });
const selected = () =>
  page
    .locator(".layer.selected")
    .evaluateAll((rows) => rows.map((el) => el.dataset.testid.slice(6)).sort());
const expectSelection = async (ids) =>
  assert.deepEqual(await selected(), [...ids].sort());
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
function fixture() {
  return {
    schemaVersion: 1,
    id: "marquee",
    name: "Marquee",
    rootId: "page",
    assets: {},
    nodes: {
      page: make("page", "page", null, 0, 0, 800, 700, {
        children: ["f", "c", "lock", "hidden"],
        fill: { type: "none" },
      }),
      f: make("f", "frame", "page", 100, 100, 300, 300, {
        children: ["a", "b", "lockedChild", "hiddenChild", "nested", "clipped"],
        clipContent: true,
        fill: { type: "solid", color: "#FFFFFF" },
      }),
      a: make("a", "rectangle", "f", 30, 30, 40, 30),
      b: make("b", "ellipse", "f", 100, 100, 40, 40),
      lockedChild: make("lockedChild", "rectangle", "f", 170, 30, 30, 30, {
        locked: true,
      }),
      hiddenChild: make("hiddenChild", "rectangle", "f", 220, 30, 30, 30, {
        visible: false,
      }),
      nested: make("nested", "frame", "f", 170, 170, 100, 100, {
        children: ["n"],
        fill: { type: "solid", color: "#E7E4F8" },
      }),
      n: make("n", "rectangle", "nested", 20, 20, 20, 20),
      clipped: make("clipped", "rectangle", "f", 330, 30, 30, 30),
      c: make("c", "rectangle", "page", 500, 150, 40, 40),
      lock: make("lock", "frame", "page", 500, 250, 80, 80, {
        locked: true,
        children: ["lc"],
        fill: { type: "solid", color: "#D4D7DE" },
      }),
      lc: make("lc", "rectangle", "lock", 10, 10, 20, 20),
      hidden: make("hidden", "frame", "page", 500, 370, 80, 80, {
        visible: false,
        children: ["hc"],
      }),
      hc: make("hc", "rectangle", "hidden", 10, 10, 20, 20),
    },
  };
}
async function exportDoc() {
  const pending = page.waitForEvent("download");
  await button("JSON 저장").click();
  const stream = await (await pending).createReadStream(),
    chunks = [];
  for await (const c of stream) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function calibrate() {
  await page.getByTestId("layer-c").locator(".layer-name").click();
  const attrs = await page
    .locator(".selection-overlay > g > rect")
    .first()
    .evaluate((el) => ({
      x: +el.getAttribute("x"),
      y: +el.getAttribute("y"),
      width: +el.getAttribute("width"),
    }));
  const r = await page.getByTestId("canvas-stage").boundingBox(),
    zoom = attrs.width / 40;
  view = { x: r.x + attrs.x - 500 * zoom, y: r.y + attrs.y - 150 * zoom, zoom };
}
async function move(x, y) {
  await page.mouse.move(view.x + x * view.zoom, view.y + y * view.zoom);
}
async function drag(x, y, xx, yy, finish = true) {
  await move(x, y);
  await page.mouse.down();
  await move(xx, yy);
  if (finish) await page.mouse.up();
}
async function fresh() {
  if (page) await page.context().close();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/", {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="save-status"]')
        .getAttribute("data-state") !== "loading",
  );
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles({
      name: "marquee.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture())),
    });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="save-status"]')
        .getAttribute("data-state") === "saved",
  );
  await page.waitForTimeout(100);
  await calibrate();
  await move(80, 80);
  await page.mouse.click(view.x + 80 * view.zoom, view.y + 80 * view.zoom);
}
async function check(name, fn) {
  await fresh();
  await fn();
  checks.push(name);
  console.log("PASS " + name);
}
try {
  await check(
    "blank canvas full containment selects frame once and excludes inherited locks/hidden",
    async () => {
      await drag(80, 80, 600, 470, false);
      await expectSelection(["f", "c"]);
      assert.equal(await page.getByTestId("marquee").count(), 1);
      if (process.env.MARQUEE_SCREENSHOT)
        await page.screenshot({
          path: process.env.MARQUEE_SCREENSHOT,
          fullPage: true,
        });
      await page.mouse.up();
      assert.equal(await page.getByTestId("marquee").count(), 0);
      assert(await button("실행 취소").isDisabled());
      assert.deepEqual(await exportDoc(), fixture());
    },
  );
  await check(
    "partial frame selects children and reverse direction is identical",
    async () => {
      await drag(80, 80, 250, 250);
      await expectSelection(["a", "b"]);
      await drag(250, 250, 80, 80);
      await expectSelection(["a", "b"]);
    },
  );
  await check(
    "frame background scopes selection to children; locks/hidden and clipped children excluded",
    async () => {
      await drag(110, 110, 480, 430);
      await expectSelection(["a", "b", "nested"]);
    },
  );
  await check(
    "nested frame background scopes to descendant and partial overlap is insufficient",
    async () => {
      await drag(275, 275, 320, 320);
      await expectSelection(["n"]);
      await drag(110, 110, 150, 150);
      await expectSelection([]);
    },
  );
  await check(
    "Shift adds to initial selection, preserves baseline while shrinking and deduplicates",
    async () => {
      await page.getByTestId("layer-c").locator(".layer-name").click();
      await page.keyboard.down("Shift");
      await drag(110, 110, 250, 250, false);
      await expectSelection(["a", "b", "c"]);
      await move(180, 170);
      await expectSelection(["a", "c"]);
      await page.mouse.up();
      await page.keyboard.up("Shift");
      await page
        .getByTestId("layer-a")
        .locator(".layer-name")
        .click({ modifiers: ["Shift"] });
      await expectSelection(["c"]);
      await page.getByTestId("layer-a").locator(".layer-name").click();
      await page.keyboard.down("Shift");
      await drag(110, 110, 250, 250);
      await page.keyboard.up("Shift");
      await expectSelection(["a", "b"]);
    },
  );
  for (const action of ["Escape", "pointercancel", "blur"])
    await check(
      action +
        " restores original selection and clears overlay without history",
      async () => {
        await page.getByTestId("layer-c").locator(".layer-name").click();
        await drag(110, 110, 250, 250, false);
        await expectSelection(["a", "b"]);
        if (action === "Escape") await page.keyboard.press("Escape");
        else if (action === "pointercancel")
          await page.getByTestId("canvas-stage").dispatchEvent("pointercancel");
        else await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        await page.mouse.up();
        await expectSelection(["c"]);
        assert.equal(await page.getByTestId("marquee").count(), 0);
        assert(await button("실행 취소").isDisabled());
      },
    );
  await check(
    "blank click clears; Shift blank click preserves; frame click and selected-frame drag retain existing behavior",
    async () => {
      await page.getByTestId("layer-c").locator(".layer-name").click();
      await page.keyboard.down("Shift");
      await drag(80, 80, 80, 80);
      await page.keyboard.up("Shift");
      await expectSelection(["c"]);
      await drag(80, 80, 80, 80);
      await expectSelection([]);
      await drag(110, 110, 110, 110);
      await expectSelection(["f"]);
      const before = await exportDoc();
      await drag(110, 110, 120, 120);
      const after = await exportDoc();
      assert.notDeepEqual(after, before);
      await button("실행 취소").click();
      assert.deepEqual(await exportDoc(), before);
    },
  );
  await check("zoom and pan preserve marquee document selection", async () => {
    await move(80, 80);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 60);
    await page.keyboard.up("Control");
    await page.waitForTimeout(80);
    await page.mouse.wheel(35, 20);
    await page.waitForTimeout(80);
    await calibrate();
    await drag(80, 80, 250, 250);
    await expectSelection(["a", "b"]);
  });
  await check(
    "CanvasKit uses the same overlay and selection policy",
    async () => {
      await page
        .getByRole("combobox", { name: "렌더러 선택" })
        .selectOption("canvaskit");
      await page.waitForTimeout(300);
      await drag(110, 110, 250, 250);
      await expectSelection(["a", "b"]);
      assert.deepEqual(await exportDoc(), fixture());
    },
  );
  await check(
    "3 CSS px threshold avoids accidental marquee and reload restores document without selection",
    async () => {
      await move(80, 80);
      await page.mouse.down();
      await page.mouse.move(
        view.x + 80 * view.zoom + 2,
        view.y + 80 * view.zoom,
      );
      assert.equal(await page.getByTestId("marquee").count(), 0);
      await page.mouse.up();
      await drag(110, 110, 250, 250);
      assert(await button("실행 취소").isDisabled());
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="save-status"]')
            .getAttribute("data-state") === "saved",
      );
      await expectSelection([]);
      assert.deepEqual(await exportDoc(), fixture());
    },
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: checks.length, checks, pageErrors: errors }),
  );
} finally {
  await page?.context().close();
  await browser.close();
}
