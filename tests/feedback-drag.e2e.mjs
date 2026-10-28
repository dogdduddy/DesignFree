import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch(browserLaunchOptions());
let page;
const errors = [];

const state = () => page.evaluate(() => window.__draftroom.getState());
async function fresh(mode = "simple") {
  if (page) await page.context().close();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/", {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => window.__draftroom);
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="save-status"]');
    return status && status.getAttribute("data-state") !== "loading";
  });
  const d = (await state()).document;
  const sample = Object.values(d.nodes).find((n) => n.type === "rectangle");
  const make = (id, parentId, transform, properties = {}) => ({
    ...structuredClone(sample),
    id,
    parentId,
    name: id,
    children: [],
    transform,
    width: 100,
    height: 80,
    locked: false,
    visible: true,
    ...properties,
  });
  const root = d.nodes[d.rootId];
  root.transform = [1, 0, 0, 1, 0, 0];
  root.width = 1000;
  root.height = 800;
  root.children = ["parent", "sibling"];
  const parent = make(
    "parent",
    root.id,
    mode === "affine" ? [1, 0.25, 0.3, 1.2, 180, 100] : [1, 0, 0, 1, 180, 100],
    {
      type: "frame",
      width: 250,
      height: 200,
      fill: { type: "none" },
      clipContent: false,
      children: ["child"],
    },
  );
  const child = make("child", "parent", [1, 0, 0, 1, 30, 40]);
  const sibling = make("sibling", root.id, [1, 0, 0, 1, 600, 100]);
  d.nodes = { [root.id]: root, parent, child, sibling };
  if (mode === "locked") parent.locked = true;
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles({
      name: "modifier-fixture.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(d)),
    });
  await page.waitForFunction(
    () => window.__draftroom.getState().document.nodes.child,
  );
  // Import schedules a fit after its state update; settle before pointer geometry.
  await page.waitForTimeout(100);
  return (await state()).document;
}
async function at(x, y) {
  const s = await state(),
    r = await page.getByTestId("canvas-stage").boundingBox();
  return {
    x: r.x + s.viewport.x + x * s.viewport.zoom,
    y: r.y + s.viewport.y + y * s.viewport.zoom,
  };
}
async function start(x, y, alt = true) {
  const p = await at(x, y);
  await page.mouse.move(p.x, p.y);
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.down();
  return p;
}
async function finish() {
  await page.mouse.up();
  await page.keyboard.up("Alt");
}
const equalOriginal = (after, before) => {
  for (const [id, node] of Object.entries(before.nodes)) {
    const { children, ...properties } = node;
    const { children: nextChildren, ...nextProperties } = after.nodes[id];
    assert.deepEqual(nextProperties, properties, "source changed: " + id);
    assert.deepEqual(
      nextChildren.filter((child) => before.nodes[child]),
      children,
    );
  }
};
async function check(name, fn) {
  await fn();
  console.log("PASS " + name);
}
try {
  await check(
    "Option drag duplicates in place then moves; one undo and redo",
    async () => {
      const before = await fresh();
      await page.getByTestId("layer-child").click();
      const p = await start(245, 170);
      await page.mouse.move(p.x + 60, p.y + 30, { steps: 5 });
      await finish();
      const s = await state(),
        id = s.selection[0],
        clone = s.document.nodes[id];
      assert.notEqual(id, "child");
      equalOriginal(s.document, before);
      assert.equal(clone.parentId, "parent");
      assert(Math.abs(clone.transform[4] - 30 - 60 / s.viewport.zoom) < 0.01);
      assert(Math.abs(clone.transform[5] - 40 - 30 / s.viewport.zoom) < 0.01);
      await page
        .getByRole("button", { name: "실행 취소", exact: true })
        .click();
      assert.deepEqual((await state()).document, before);
      await page
        .getByRole("button", { name: "다시 실행", exact: true })
        .click();
      assert.deepEqual((await state()).document, s.document);
    },
  );
  await check(
    "Option click and subthreshold movement create no nodes or undo",
    async () => {
      const before = await fresh();
      const undo = page.getByRole("button", { name: "실행 취소", exact: true });
      assert(await undo.isDisabled());
      const p = await start(245, 170);
      await page.mouse.move(p.x + 0.1, p.y + 0.1);
      await finish();
      assert.deepEqual((await state()).document, before);
      assert(await undo.isDisabled());
    },
  );
  await check(
    "Option pressed before first movement latches after release",
    async () => {
      const before = await fresh();
      const p = await start(245, 170, false);
      await page.keyboard.down("Alt");
      await page.mouse.move(p.x + 25, p.y + 10);
      await page.keyboard.up("Alt");
      await page.mouse.move(p.x + 60, p.y + 30);
      await finish();
      const s = await state();
      equalOriginal(s.document, before);
      assert.equal(
        Object.keys(s.document.nodes).length,
        Object.keys(before.nodes).length + 1,
      );
    },
  );
  await check(
    "Escape and pointercancel remove tentative copies and restore selection",
    async () => {
      for (const cancellation of ["escape", "pointercancel"]) {
        const before = await fresh();
        await page.getByTestId("layer-child").click();
        const originalSelection = (await state()).selection;
        const p = await start(245, 170);
        await page.mouse.move(p.x + 40, p.y + 20);
        assert.notEqual((await state()).selection[0], "child");
        if (cancellation === "escape") await page.keyboard.press("Escape");
        else
          await page
            .getByTestId("canvas-stage")
            .dispatchEvent("pointercancel", {
              pointerId: 1,
              pointerType: "mouse",
            });
        await finish();
        const s = await state();
        assert.deepEqual(s.document, before);
        assert.deepEqual(s.selection, originalSelection);
      }
    },
  );
  await check(
    "selected parent plus child duplicates one full subtree and sibling root",
    async () => {
      const before = await fresh();
      await page.getByTestId("layer-parent").click();
      await page.getByTestId("layer-child").click({ modifiers: ["Shift"] });
      await page.getByTestId("layer-sibling").click({ modifiers: ["Shift"] });
      const p = await start(380, 240);
      await page.mouse.move(p.x + 40, p.y + 25);
      await finish();
      const s = await state();
      equalOriginal(s.document, before);
      assert.equal(s.selection.length, 2);
      assert.equal(
        Object.keys(s.document.nodes).length,
        Object.keys(before.nodes).length + 3,
      );
      const parent = s.selection
        .map((id) => s.document.nodes[id])
        .find((n) => n.type === "frame");
      assert.equal(parent.children.length, 1);
      const child = s.document.nodes[parent.children[0]];
      assert.notEqual(child.id, "child");
      assert.equal(child.parentId, parent.id);
      assert.deepEqual(child.transform, before.nodes.child.transform);
    },
  );
  await check(
    "duplicate under affine parent follows world pointer delta",
    async () => {
      const before = await fresh("affine");
      await page.getByTestId("layer-child").click();
      const p = await start(267, 196.25);
      await page.mouse.move(p.x + 60, p.y + 30);
      await finish();
      const s = await state();
      equalOriginal(s.document, before);
      const c = s.document.nodes[s.selection[0]],
        dx = c.transform[4] - 30,
        dy = c.transform[5] - 40;
      assert(Math.abs(dx + 0.3 * dy - 60 / s.viewport.zoom) < 0.01);
      assert(Math.abs(0.25 * dx + 1.2 * dy - 30 / s.viewport.zoom) < 0.01);
    },
  );
  await check(
    "inherited locked descendants never duplicate on Option drag",
    async () => {
      const before = await fresh("locked");
      await page.getByTestId("layer-child").click();
      const p = await start(245, 170);
      await page.mouse.move(p.x + 60, p.y + 30);
      await finish();
      assert.deepEqual((await state()).document, before);
    },
  );
  await check(
    "Alt at pointerdown still duplicates when released before movement",
    async () => {
      const before = await fresh();
      const p = await start(245, 170);
      await page.keyboard.up("Alt");
      await page.mouse.move(p.x + 45, p.y + 20, { steps: 4 });
      await finish();
      const s = await state();
      equalOriginal(s.document, before);
      assert.equal(
        Object.keys(s.document.nodes).length,
        Object.keys(before.nodes).length + 1,
      );
    },
  );
  await check(
    "Alt leaves pan, resize, and drawing behavior intact",
    async () => {
      let before = await fresh();
      const originalView = (await state()).viewport;
      await page.keyboard.down("Space");
      const p = await start(245, 170);
      await page.mouse.move(p.x + 40, p.y + 20);
      await finish();
      await page.keyboard.up("Space");
      let s = await state();
      assert.deepEqual(s.document, before);
      assert(Math.abs(s.viewport.x - originalView.x - 40) < 0.01);
      before = await fresh();
      await page.getByTestId("layer-child").click();
      const handle = await page
        .getByRole("button", { name: "오른쪽 아래 크기 조절", exact: true })
        .boundingBox();
      await page.keyboard.down("Alt");
      await page.mouse.move(
        handle.x + handle.width / 2,
        handle.y + handle.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        handle.x + handle.width / 2 + 35,
        handle.y + handle.height / 2 + 20,
      );
      await finish();
      s = await state();
      assert.equal(
        Object.keys(s.document.nodes).length,
        Object.keys(before.nodes).length,
      );
      assert(s.document.nodes.child.width > before.nodes.child.width);
      before = await fresh();
      await page
        .getByRole("button", { name: "사각형 도구", exact: true })
        .click();
      const q = await start(500, 400);
      await page.mouse.move(q.x + 60, q.y + 40, { steps: 3 });
      await finish();
      s = await state();
      assert.equal(
        Object.keys(s.document.nodes).length,
        Object.keys(before.nodes).length + 1,
      );
      assert.equal(s.document.nodes[s.selection[0]].type, "rectangle");
    },
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
