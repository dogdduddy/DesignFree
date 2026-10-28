import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch(browserLaunchOptions());
let page;
const errors = [];
let passed = 0;
const state = () => page.evaluate(() => window.__draftroom.getState());
const close = (a, b, tolerance = 1e-3) =>
  assert(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const button = (name) => page.getByRole("button", { name, exact: true });
async function fresh(rotated = false, customize) {
  if (page) await page.context().close();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/", {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(
    () =>
      window.__draftroom &&
      document
        .querySelector('[data-testid="save-status"]')
        .getAttribute("data-state") !== "loading",
  );
  const d = (await state()).document,
    root = d.nodes[d.rootId];
  const sample = Object.values(d.nodes).find((n) => n.type === "rectangle");
  const make = (id, parentId, x, y, w, h, props = {}) => ({
    ...structuredClone(sample),
    id,
    name: id,
    parentId,
    children: [],
    transform: [1, 0, 0, 1, x, y],
    width: w,
    height: h,
    radius: 0,
    visible: true,
    locked: false,
    ...props,
  });
  root.transform = [1, 0, 0, 1, 0, 0];
  root.children = ["p"];
  root.width = 1000;
  root.height = 800;
  const p = make("p", root.id, 180, 100, 500, 400, {
    type: "frame",
    children: ["a", "b"],
    clipContent: false,
    fill: { type: "none" },
    ...(rotated
      ? { transform: [Math.sqrt(3) / 2, 0.5, -0.5, Math.sqrt(3) / 2, 350, 100] }
      : {}),
  });
  d.nodes = {
    [root.id]: root,
    p,
    a: make("a", "p", 50, 70, 40, 30),
    b: make("b", "p", 200, 200, 100, 80),
  };
  customize?.(d);
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles({
      name: "snap.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(d)),
    });
  await page.waitForFunction(
    () => window.__draftroom.getState().document.nodes.a,
  );
  await saved();
  await page.waitForTimeout(80);
  await page.getByTestId("layer-a").locator(".layer-name").click();
  return (await state()).document;
}
async function saved() {
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="save-status"]')
        .getAttribute("data-state") === "saved",
  );
}
async function screen(x, y) {
  const s = await state(),
    m = s.document.nodes.p.transform,
    r = await page.getByTestId("canvas-stage").boundingBox();
  return {
    x: r.x + s.viewport.x + (m[0] * x + m[2] * y + m[4]) * s.viewport.zoom,
    y: r.y + s.viewport.y + (m[1] * x + m[3] * y + m[5]) * s.viewport.zoom,
  };
}
async function move(x, y) {
  const p = await screen(x, y);
  await page.mouse.move(p.x, p.y);
}
async function start() {
  await move(70, 85);
  await page.mouse.down();
}
async function check(name, fn) {
  await fn();
  passed++;
  console.log("PASS " + name);
}
try {
  await check(
    "sibling edge, live guide, single Undo/Redo and committed autosave",
    async () => {
      const before = await fresh();
      await start();
      await move(218, 115);
      close((await state()).document.nodes.a.transform[4], 200);
      assert((await page.getByTestId("snap-guide").count()) > 0);
      await page.mouse.up();
      assert.equal(await page.getByTestId("snap-guide").count(), 0);
      const after = (await state()).document;
      await button("실행 취소").click();
      assert.deepEqual((await state()).document, before);
      assert(await button("실행 취소").isDisabled());
      await button("다시 실행").click();
      assert.deepEqual((await state()).document, after);
      await saved();
      await page.reload({ waitUntil: "networkidle" });
      await saved();
      assert.deepEqual((await state()).document, after);
    },
  );
  for (const [label, dx, expected] of [
    ["sibling center", 178, 230],
    ["parent leading edge", -47, 0],
    ["parent trailing edge", 407, 460],
  ]) {
    await check(label, async () => {
      await fresh();
      await start();
      await move(70 + dx, 115);
      close((await state()).document.nodes.a.transform[4], expected);
      await page.mouse.up();
    });
  }
  await check(
    "multi-selection snaps union and moves each root once",
    async () => {
      const before = await fresh();
      await page
        .getByTestId("layer-b")
        .locator(".layer-name")
        .click({ modifiers: ["Shift"] });
      await start();
      await move(267, 115);
      const d = (await state()).document;
      close(d.nodes.a.transform[4], 250);
      close(d.nodes.b.transform[4], 400);
      await page.mouse.up();
      await button("실행 취소").click();
      assert.deepEqual((await state()).document, before);
    },
  );
  await check(
    "locked mixed selection stays fixed and does not enter moving union",
    async () => {
      const before = await fresh(false, (d) => {
        d.nodes.b.locked = true;
      });
      await page
        .getByTestId("layer-b")
        .locator(".layer-name")
        .click({ modifiers: ["Shift"] });
      await start();
      await move(218, 115);
      const d = (await state()).document;
      close(d.nodes.a.transform[4], 200);
      assert.deepEqual(d.nodes.b, before.nodes.b);
      await page.mouse.up();
    },
  );
  await check(
    "vertical centers and pointer cancellation restore document and guides",
    async () => {
      const before = await fresh();
      await start();
      await move(100, 238);
      close((await state()).document.nodes.a.transform[5], 225);
      await page.getByTestId("canvas-stage").dispatchEvent("pointercancel");
      await page.mouse.up();
      assert.deepEqual((await state()).document, before);
      assert.equal(await page.getByTestId("snap-guide").count(), 0);
    },
  );
  for (const key of ["Alt", "Meta"]) {
    await check(
      `${key} toggles snapping without moving pointer or changing transaction`,
      async () => {
        const before = await fresh();
        await start();
        await move(218, 115);
        close((await state()).document.nodes.a.transform[4], 200);
        await page.keyboard.down(key);
        close((await state()).document.nodes.a.transform[4], 198);
        assert.equal(await page.getByTestId("snap-guide").count(), 0);
        await page.keyboard.up(key);
        close((await state()).document.nodes.a.transform[4], 200);
        await page.mouse.up();
        await button("실행 취소").click();
        assert.deepEqual((await state()).document, before);
      },
    );
  }
  await check(
    "Option duplication retains one Undo and disables snap while held",
    async () => {
      const before = await fresh();
      await page.keyboard.down("Alt");
      await start();
      await move(218, 115);
      const s = await state(),
        n = s.document.nodes[s.selection[0]];
      close(n.transform[4], 198);
      assert.notEqual(n.id, "a");
      assert.deepEqual(s.document.nodes.a, before.nodes.a);
      assert.equal(await page.getByTestId("snap-guide").count(), 0);
      await page.mouse.up();
      await page.keyboard.up("Alt");
      await button("실행 취소").click();
      assert.deepEqual((await state()).document, before);
    },
  );
  await check("Escape restores preview and clears guides/history", async () => {
    const before = await fresh();
    await start();
    await move(218, 115);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.deepEqual((await state()).document, before);
    assert.equal(await page.getByTestId("snap-guide").count(), 0);
    assert(await button("실행 취소").isDisabled());
  });
  for (const rotated of [false, true]) {
    await check(
      `${rotated ? "rotated" : "normal"} parent move and resize follow local axes`,
      async () => {
        const before = await fresh(rotated);
        await start();
        await move(218, 115);
        close((await state()).document.nodes.a.transform[4], 200);
        close((await state()).document.nodes.a.transform[5], 100);
        await page.mouse.up();
        await button("실행 취소").click();
        const h = await page
          .getByRole("button", { name: "오른쪽 아래 크기 조절", exact: true })
          .boundingBox();
        await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
        await page.mouse.down();
        await move(197, 170);
        close((await state()).document.nodes.a.width, 150);
        // Resize keeps the pointer grab offset; Chrome quantizes the initial CSS point.
        close((await state()).document.nodes.a.height, 100, 0.03);
        assert((await page.getByTestId("snap-guide").count()) > 0);
        await page.mouse.up();
        await button("실행 취소").click();
        assert.deepEqual((await state()).document, before);
      },
    );
  }
  await check(
    "resize modifier toggles live preview and minimum size is enforced",
    async () => {
      await fresh();
      const h = await page
        .getByRole("button", { name: "오른쪽 아래 크기 조절", exact: true })
        .boundingBox();
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await move(197, 170);
      close((await state()).document.nodes.a.width, 150);
      await page.keyboard.down("Meta");
      close((await state()).document.nodes.a.width, 147);
      assert.equal(await page.getByTestId("snap-guide").count(), 0);
      await page.keyboard.up("Meta");
      close((await state()).document.nodes.a.width, 150);
      await move(45, 65);
      assert((await state()).document.nodes.a.width >= 8);
      assert((await state()).document.nodes.a.height >= 8);
      await page.mouse.up();
    },
  );
  for (const zoom of [0.25, 4]) {
    await check(`6 CSS px threshold at zoom ${zoom}`, async () => {
      await fresh();
      const p = await screen(150, 100);
      await page.mouse.move(p.x, p.y);
      const z = (await state()).viewport.zoom;
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -Math.log(zoom / z) / 0.008);
      await page.keyboard.up("Control");
      await page.waitForTimeout(100);
      close((await state()).viewport.zoom, zoom);
      const origin = await screen(51, 71),
        r = await page.getByTestId("canvas-stage").boundingBox();
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.wheel(origin.x - r.x - 100, origin.y - r.y - 150);
      await page.waitForTimeout(100);
      // Eight-way handles now occupy the corners; drag the unobstructed center.
      await move(70, 85);
      await page.mouse.down();
      // Right edge approaches sibling left: 5px inside then 8px outside.
      await move(70 + 110 - 5 / zoom, 115);
      close((await state()).document.nodes.a.transform[4], 160);
      // At low zoom source center is also nearby; move away in a region without targets.
      await move(70 + 90 - 8 / zoom, 115);
      const raw = 50 + 90 - 8 / zoom;
      close((await state()).document.nodes.a.transform[4], raw);
      await page.mouse.up();
    });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed, pageErrors: errors }));
} finally {
  await page?.context().close();
  await browser.close();
}
