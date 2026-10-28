import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const browser = await chromium.launch(browserLaunchOptions());
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage(),
  errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const btn = (name) => page.getByRole("button", { name, exact: true });
const select = async (id) => {
  await page.getByTestId(`layer-${id}`).locator(".layer-name").click();
};
const selected = () =>
  page
    .locator(".layer.selected")
    .evaluateAll((rows) => rows.map((el) => el.dataset.testid.slice(6)));
const key = async (k) => {
  await page.keyboard.press(`Meta+${k}`);
  await page.waitForTimeout(120);
};
async function exportDoc() {
  const download = page.waitForEvent("download");
  await btn("JSON 저장").click();
  const stream = await (await download).createReadStream(),
    chunks = [];
  for await (const c of stream) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function importDoc(doc) {
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles({
      name: "clipboard.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
  await page.waitForTimeout(600);
}
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
}

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const world = (d, id) =>
  d.nodes[id].parentId
    ? mul(world(d, d.nodes[id].parentId), d.nodes[id].transform)
    : d.nodes[id].transform;
const close = (a, b, tolerance = 1e-8) =>
  a.forEach((v, i) =>
    assert(Math.abs(v - b[i]) < tolerance, JSON.stringify({ a, b })),
  );
async function at(doc, id, x = 10, y = 10) {
  const m = world(doc, id),
    wx = m[0] * x + m[2] * y + m[4],
    wy = m[1] * x + m[3] * y + m[5];
  const v = await page
    .locator(".renderer-surface svg > g")
    .getAttribute("transform");
  const [vx, vy, z] = v.match(/-?[\d.]+/g).map(Number),
    box = await page.getByTestId("canvas-stage").boundingBox();
  return { x: box.x + vx + wx * z, y: box.y + vy + wy * z };
}
try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="save-status"]').dataset.state !==
      "loading",
  );
  const source = await exportDoc(),
    base = structuredClone(source),
    root = base.nodes[base.rootId];
  const template = Object.values(source.nodes).find(
    (n) => n.type === "rectangle",
  );
  const node = (id, parentId, props = {}) => ({
    ...structuredClone(template),
    id,
    parentId,
    name: id,
    children: [],
    type: "rectangle",
    width: 60,
    height: 40,
    transform: [1, 0, 0, 1, 0, 0],
    clipContent: false,
    locked: false,
    visible: true,
    ...props,
  });
  root.width = 800;
  root.height = 600;
  root.children = ["f"];
  base.nodes = {
    [root.id]: root,
    f: node("f", root.id, {
      type: "frame",
      width: 500,
      height: 400,
      children: ["a", "b", "c"],
      transform: [1, 0.2, 0.3, 1, 100, 80],
    }),
    a: node("a", "f", { transform: [1, 0, 0, 1, 20, 20] }),
    b: node("b", "f", { transform: [1, 0, 0, 1, 150, 80] }),
    c: node("c", "f", { transform: [1, 0, 0, 1, 250, 180] }),
  };
  root.children.push("target");
  base.nodes.target = node("target", root.id, {
    type: "frame",
    width: 180,
    height: 260,
    transform: [0.9, 0.1, -0.1, 1, 720, 80],
  });
  await importDoc(base);
  async function panelDrag(id, target, ratio) {
    const from = await page.getByTestId(`layer-${id}`).boundingBox(),
      to = await page.getByTestId(`layer-${target}`).boundingBox();
    await page.mouse.move(from.x + 80, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 90, to.y + to.height * ratio, { steps: 12 });
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(150);
  }
  await check("Cmd brackets step paint order with one Undo/Redo", async () => {
    await select("a");
    await key("]");
    const d = await exportDoc();
    assert.deepEqual(d.nodes.f.children, ["b", "a", "c"]);
    close(world(d, "a"), world(base, "a"));
    await key("z");
    assert.deepEqual(await exportDoc(), base);
    await key("Shift+z");
    assert.deepEqual(await exportDoc(), d);
    await key("[");
    assert.deepEqual(await exportDoc(), base);
  });
  await check("panel drag after sibling preserves local matrix", async () => {
    await panelDrag("a", "c", 0.9);
    const d = await exportDoc();
    assert.deepEqual(d.nodes.f.children, ["b", "c", "a"]);
    assert.deepEqual(d.nodes.a.transform, base.nodes.a.transform);
    await key("z");
    assert.deepEqual(await exportDoc(), base);
  });
  await check(
    "panel container center reparents preserving affine world",
    async () => {
      await panelDrag("a", "target", 0.5);
      const d = await exportDoc();
      assert.equal(d.nodes.a.parentId, "target");
      close(world(d, "a"), world(base, "a"));
      await key("z");
      assert.deepEqual(await exportDoc(), base);
    },
  );
  await check("multi panel drag preserves source paint order", async () => {
    await select("b");
    await page
      .getByTestId("layer-a")
      .locator(".layer-name")
      .click({ modifiers: ["Shift"] });
    await panelDrag("a", "target", 0.5);
    const d = await exportDoc();
    assert.deepEqual(d.nodes.target.children, ["a", "b"]);
    for (const id of ["a", "b"]) close(world(d, id), world(base, id));
    await key("z");
  });
  await check(
    "cycle drop and inherited locked destination leave document intact",
    async () => {
      await panelDrag("f", "f", 0.5);
      assert.deepEqual(await exportDoc(), base);
      const locked = structuredClone(base);
      locked.nodes.target.locked = true;
      await importDoc(locked);
      await panelDrag("a", "target", 0.5);
      assert.deepEqual(await exportDoc(), locked);
      await importDoc(base);
    },
  );
  async function canvasDrag(dest, cancel = false) {
    await select("a");
    const p = await at(base, "a", 20, 20),
      q = await at(base, ...dest);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.keyboard.down("Meta");
    await page.mouse.move(q.x, q.y, { steps: 12 });
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.keyboard.up("Meta");
    return { p, q };
  }
  await check(
    "canvas crossing into affine frame keeps moved world matrix and one Undo",
    async () => {
      const { p, q } = await canvasDrag(["target", 70, 90]);
      const d = await exportDoc();
      assert.equal(d.nodes.a.parentId, "target");
      const w = world(d, "a"),
        before = world(base, "a");
      close(w.slice(0, 4), before.slice(0, 4));
      const v = await page
          .locator(".renderer-surface svg > g")
          .getAttribute("transform"),
        z = v.match(/-?[\d.]+/g).map(Number)[2];
      close(
        w.slice(4),
        [before[4] + (q.x - p.x) / z, before[5] + (q.y - p.y) / z],
        1e-4,
      );
      await key("z");
      assert.deepEqual(await exportDoc(), base);
      await key("Shift+z");
      assert.equal((await exportDoc()).nodes.a.parentId, "target");
      await key("z");
    },
  );
  await check("canvas crossing out of frame reparents to page", async () => {
    await canvasDrag([root.id, 650, 70]);
    assert.equal((await exportDoc()).nodes.a.parentId, root.id);
    await key("z");
    assert.deepEqual(await exportDoc(), base);
  });
  await check(
    "Escape cancels crossing without hierarchy/history change",
    async () => {
      await canvasDrag(["target", 70, 90], true);
      assert.deepEqual(await exportDoc(), base);
    },
  );
  await check("bracket shortcut leaves native input alone", async () => {
    await select("a");
    await page.getByLabel("레이어 이름", { exact: true }).focus();
    await key("]");
    assert.deepEqual(await exportDoc(), base);
    await page.evaluate(() => document.activeElement.blur());
  });
  await check("hierarchy edit survives committed autosave reload", async () => {
    await panelDrag("a", "target", 0.5);
    const d = await exportDoc();
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
    assert.deepEqual(await exportDoc(), d);
    await select("a");
    if (process.env.LAYERS_SCREENSHOT)
      await page.screenshot({
        path: process.env.LAYERS_SCREENSHOT,
        fullPage: true,
      });
  });
  assert.deepEqual(errors, []);
  const result = {
    url,
    checks,
    passed: checks.length,
    failed: 0,
    pageErrors: errors,
    browser: browser.version(),
  };
  if (process.env.LAYERS_REPORT)
    await fs.writeFile(
      process.env.LAYERS_REPORT,
      JSON.stringify(result, null, 2) + "\n",
    );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
