import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch(browserLaunchOptions());
let page;
const errors = [];

const state = () => page.evaluate(() => window.__draftroom.getState());
const overlay = {
  count: () => page.getByTestId("measurement-overlay").count(),
  getAttribute: (name) =>
    page.getByTestId("measurement-overlay").getAttribute(name),
};
async function at(x, y) {
  const s = await state(),
    r = await page.getByTestId("canvas-stage").boundingBox();
  return {
    x: r.x + s.viewport.x + x * s.viewport.zoom,
    y: r.y + s.viewport.y + y * s.viewport.zoom,
  };
}
async function hover(x, y) {
  const p = await at(x, y);
  await page.mouse.move(p.x, p.y);
}
async function show(x, y, target) {
  await hover(x, y);
  await page.keyboard.down("Alt");
  await page.waitForFunction(
    (t) =>
      document
        .querySelector('[data-testid="measurement-overlay"]')
        ?.getAttribute("data-target-id") === t,
    target,
  );
}
async function fresh() {
  if (page) await page.context().close();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/", {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="save-status"]');
    return status && status.getAttribute("data-state") !== "loading";
  });
  const d = (await state()).document;
  const sample = Object.values(d.nodes).find((n) => n.type === "rectangle");
  const root = d.nodes[d.rootId];
  root.transform = [1, 0, 0, 1, 0, 0];
  root.width = 900;
  root.height = 700;
  const make = (id, x, y, properties = {}) => ({
    ...structuredClone(sample),
    id,
    name: id,
    parentId: root.id,
    children: [],
    transform: [1, 0, 0, 1, x, y],
    width: 100,
    height: 80,
    radius: 0,
    visible: true,
    locked: false,
    ...properties,
  });
  const source = make("source", 100, 100);
  const target = make("target", 260, 100);
  const frame = make("parent", 450, 100, {
    type: "frame",
    width: 300,
    height: 300,
    clipContent: true,
    children: ["child"],
    fill: { type: "none" },
  });
  const child = make("child", 30, 40, {
    parentId: "parent",
    transform: [1, 0.25, 0.3, 1.2, 30, 40],
  });
  const hidden = make("hidden", 100, 300, { visible: false });
  const locked = make("locked", 260, 300, { locked: true });
  root.children = ["source", "target", "parent", "hidden", "locked"];
  d.nodes = {
    [root.id]: root,
    source,
    target,
    parent: frame,
    child,
    hidden,
    locked,
  };
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles({
      name: "measurement.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(d)),
    });
  await page.waitForFunction(
    () => window.__draftroom.getState().document.nodes.source,
  );
  await page.waitForTimeout(100);
  await page.getByTestId("layer-source").click();
  return (await state()).document;
}
async function absent() {
  assert.equal(await overlay.count(), 0);
}
async function check(name, fn) {
  await fn();
  console.log("PASS " + name);
}
try {
  await check(
    "stationary Option hover measures 60 document pixels without document/selection/history changes",
    async () => {
      const before = await fresh();
      const selection = (await state()).selection;
      await show(310, 140, "target");
      assert.equal(
        await page.getByTestId("measurement-label").textContent(),
        "60 px",
      );
      assert.deepEqual((await state()).document, before);
      assert.deepEqual((await state()).selection, selection);
      assert(
        await page
          .getByRole("button", { name: "실행 취소", exact: true })
          .isDisabled(),
      );
      await page.keyboard.up("Alt");
      await absent();
    },
  );
  await check(
    "zoom and pan preserve document distances and screen label dimensions",
    async () => {
      await fresh();
      await show(310, 140, "target");
      const label = page.getByTestId("measurement-label");
      const first = await label.boundingBox();
      await page.keyboard.up("Alt");
      await page.getByRole("button", { name: "확대", exact: true }).click();
      await show(310, 140, "target");
      const next = await label.boundingBox();
      assert.equal(await label.textContent(), "60 px");
      assert(Math.abs(first.height - next.height) < 0.01);
      await page.keyboard.up("Alt");
      await hover(310, 140);
      await page.mouse.wheel(15, 20);
      await page.waitForTimeout(50);
      await show(310, 140, "target");
      assert.equal(await label.textContent(), "60 px");
    },
  );
  await check(
    "selected subtree is skipped and transformed child can measure its parent frame",
    async () => {
      await fresh();
      await page.getByTestId("layer-child").click();
      await show(530, 190, "parent");
      const values = await page
        .getByTestId("measurement-guide")
        .evaluateAll((xs) => xs.map((x) => Number(x.dataset.value)));
      assert.deepEqual(values, [30, 146, 40, 139]);
      await page.keyboard.up("Alt");
      await page.getByTestId("layer-parent").click();
      await hover(530, 190);
      await page.keyboard.down("Alt");
      await absent();
    },
  );
  await check(
    "selection union and target changes recalculate while hidden/locked targets are ignored",
    async () => {
      await fresh();
      await page.getByTestId("layer-target").click({ modifiers: ["Shift"] });
      await show(700, 250, "parent");
      assert.equal(
        await page
          .getByTestId("measurement-guide")
          .filter({ has: page.locator("text") })
          .first()
          .getAttribute("data-value"),
        "90",
      );
      await hover(150, 340);
      await absent();
      await hover(310, 340);
      await absent();
      await hover(530, 190);
      assert.equal(await overlay.getAttribute("data-target-id"), "child");
    },
  );
  await check(
    "pointer exit, blur, tool changes, menu and input focus clear guides",
    async () => {
      await fresh();
      await show(310, 140, "target");
      await page.mouse.move(20, 20);
      await absent();
      await show(310, 140, "target");
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await absent();
      await page.keyboard.up("Alt");
      await show(310, 140, "target");
      await page
        .getByRole("button", { name: "사각형 도구", exact: true })
        .click();
      await absent();
      await page.keyboard.up("Alt");
      await page
        .getByRole("button", { name: "선택 도구", exact: true })
        .click();
      await show(310, 140, "target");
      await page.getByLabel("레이어 이름", { exact: true }).focus();
      await absent();
      await page.keyboard.up("Alt");
      await page.getByLabel("레이어 이름", { exact: true }).blur();
      await show(310, 140, "target");
      await page.getByRole("button", { name: "내보내기", exact: true }).click();
      await absent();
    },
  );
  await check(
    "held Option recovers after Space, blur/reentry and input focus",
    async () => {
      await fresh();
      await show(310, 140, "target");
      await page.keyboard.down("Space");
      await absent();
      await page.keyboard.up("Space");
      assert.equal(await overlay.count(), 1);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await absent();
      await hover(311, 140);
      assert.equal(await overlay.count(), 1);
      await page.getByLabel("레이어 이름", { exact: true }).focus();
      await absent();
      await hover(310, 140);
      await absent();
      await page.keyboard.up("Alt");
      await page.keyboard.down("Alt");
      await absent();
      await page.getByLabel("레이어 이름", { exact: true }).blur();
      await hover(311, 140);
      assert.equal(await overlay.count(), 1);
      await page.keyboard.up("Alt");
    },
  );
  await check(
    "Option drag keeps duplication and hides guides throughout gesture",
    async () => {
      const before = await fresh();
      await show(310, 140, "target");
      await hover(150, 140);
      const p = await at(150, 140);
      await page.mouse.down();
      await absent();
      await page.mouse.move(p.x + 40, p.y + 20);
      await absent();
      await page.mouse.up();
      await page.keyboard.up("Alt");
      const after = await state();
      assert.equal(
        Object.keys(after.document.nodes).length,
        Object.keys(before.nodes).length + 1,
      );
      assert.deepEqual(after.document.nodes.source, before.nodes.source);
      await page
        .getByRole("button", { name: "실행 취소", exact: true })
        .click();
      assert.deepEqual((await state()).document, before);
    },
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
