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
const close = (a, b) => a.forEach((v, i) => assert(Math.abs(v - b[i]) < 1e-8));
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
  await importDoc(base);
  let grouped, g;
  await check(
    "Cmd+G groups selected siblings and preserves affine worlds",
    async () => {
      await select("a");
      await page
        .getByTestId("layer-b")
        .locator(".layer-name")
        .click({ modifiers: ["Shift"] });
      await key("g");
      grouped = await exportDoc();
      [g] = await selected();
      assert.equal(grouped.nodes[g].type, "group");
      assert.deepEqual(grouped.nodes[g].children, ["a", "b"]);
      assert.equal(grouped.nodes[g].width, 190);
      assert.equal(grouped.nodes[g].height, 100);
      for (const id of ["a", "b"]) close(world(grouped, id), world(base, id));
      assert(
        (await page
          .getByRole("button", { name: "오른쪽 아래 크기 조절", exact: true })
          .count()) === 1,
      );
    },
  );
  await check("group and ungroup each create one Undo/Redo step", async () => {
    await key("z");
    assert.deepEqual(await exportDoc(), base);
    await key("Shift+z");
    assert.deepEqual(await exportDoc(), grouped);
    await select(g);
    await key("Shift+g");
    const d = await exportDoc();
    assert(!d.nodes[g]);
    assert.deepEqual(d.nodes.f.children, ["a", "b", "c"]);
    for (const id of ["a", "b"]) close(world(d, id), world(base, id));
    await key("z");
    assert.deepEqual(await exportDoc(), grouped);
    await key("Shift+z");
    assert(!(await exportDoc()).nodes[g]);
    await key("z");
  });
  await check(
    "canvas click selects group; double click enters; Escape returns to group",
    async () => {
      const p = await at(grouped, "a");
      await page.mouse.click(p.x, p.y);
      assert.deepEqual(await selected(), [g]);
      await page.mouse.dblclick(p.x, p.y);
      assert.deepEqual(await selected(), ["a"]);
      await page.keyboard.press("Escape");
      assert.deepEqual(await selected(), [g]);
    },
  );
  await check(
    "nested group double click enters one level at a time",
    async () => {
      await select(g);
      await page
        .getByTestId("layer-c")
        .locator(".layer-name")
        .click({ modifiers: ["Shift"] });
      await key("g");
      const d = await exportDoc(),
        outer = (await selected())[0];
      const p = await at(d, "a");
      await page.mouse.dblclick(p.x, p.y);
      assert.deepEqual(await selected(), [g]);
      await page.mouse.dblclick(p.x, p.y);
      assert.deepEqual(await selected(), ["a"]);
      await page.keyboard.press("Escape");
      assert.deepEqual(await selected(), [g]);
      await page.keyboard.press("Escape");
      assert.deepEqual(await selected(), [outer]);
      await key("z");
    },
  );
  await check(
    "entered group whitespace starts scoped marquee and outside click exits",
    async () => {
      const d = await exportDoc(),
        p = await at(d, "a");
      await page.mouse.dblclick(p.x, p.y);
      const blank = await at(d, g, 100, 10),
        end = await at(d, g, 210, 120);
      await page.mouse.move(blank.x, blank.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
      assert.deepEqual(await exportDoc(), d);
      assert.deepEqual(await selected(), ["b"]);
      const outside = await at(d, "c");
      await page.mouse.click(outside.x, outside.y);
      assert.deepEqual(await selected(), ["c"]);
      await page.mouse.click(p.x, p.y);
      assert.deepEqual(await selected(), [g]);
    },
  );
  await check(
    "moving child recalculates group bounds without moving sibling",
    async () => {
      await select("a");
      const before = await exportDoc();
      await page.keyboard.press("Shift+ArrowLeft");
      const after = await exportDoc();
      assert(
        Math.abs(after.nodes[g].width - before.nodes[g].width - 10 / 0.94) <
          1e-8,
      );
      close(world(before, "b"), world(after, "b"));
      await key("z");
    },
  );
  await check("group drag moves subtree and is one Undo", async () => {
    await select(g);
    const before = await exportDoc(),
      p = await at(before, "a");
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.keyboard.down("Meta");
    await page.mouse.move(p.x + 30, p.y + 20, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up("Meta");
    const after = await exportDoc();
    assert.notDeepEqual(world(before, "a"), world(after, "a"));
    close(after.nodes.a.transform, before.nodes.a.transform);
    await key("z");
    assert.deepEqual(await exportDoc(), before);
  });
  await check("native input shortcut does not group design nodes", async () => {
    await select(g);
    const before = await exportDoc();
    await page.getByLabel("레이어 이름", { exact: true }).focus();
    await key("g");
    assert.deepEqual(await exportDoc(), before);
    await page.evaluate(() => document.activeElement.blur());
  });
  await check("copy/paste retains group hierarchy and fresh IDs", async () => {
    await select(g);
    await key("c");
    await page.keyboard.press("Escape");
    await key("v");
    const d = await exportDoc(),
      copy = (await selected())[0];
    assert.notEqual(copy, g);
    assert.equal(d.nodes[copy].type, "group");
    assert.equal(d.nodes[copy].children.length, 2);
    assert(d.nodes[copy].children.every((id) => d.nodes[id].parentId === copy));
    await key("z");
  });
  await check("group survives autosave reload and JSON roundtrip", async () => {
    await select(g);
    const before = await exportDoc();
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
    assert.deepEqual(await exportDoc(), before);
    await select(g);
    if (process.env.GROUPING_SCREENSHOT)
      await page.screenshot({
        path: process.env.GROUPING_SCREENSHOT,
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
  if (process.env.GROUPING_REPORT)
    await fs.writeFile(
      process.env.GROUPING_REPORT,
      JSON.stringify(result, null, 2) + "\n",
    );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
