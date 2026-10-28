import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const browser = await chromium.launch(browserLaunchOptions());
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
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
    root = structuredClone(source.nodes[source.rootId]);
  const sample = Object.values(source.nodes).find(
    (n) => n.type === "rectangle",
  );
  const node = (id, parentId, x, y, w = 120, h = 80, props = {}) => ({
    ...structuredClone(sample),
    id,
    name: id,
    parentId,
    children: [],
    type: "rectangle",
    transform: [1, 0, 0, 1, x, y],
    width: w,
    height: h,
    radius: 0,
    clipContent: false,
    visible: true,
    locked: false,
    ...props,
  });
  root.children = ["f", "c"];
  root.width = 900;
  root.height = 700;
  root.transform = [1, 0, 0, 1, 0, 0];
  const base = {
    ...source,
    nodes: {
      [root.id]: root,
      f: node("f", root.id, 80, 60, 500, 400, {
        type: "frame",
        children: ["a", "b"],
        fill: { type: "none" },
      }),
      a: node("a", "f", 60, 80),
      b: node("b", "f", 300, 220, 80, 60),
      c: node("c", root.id, 700, 400, 80, 60),
    },
  };
  async function fresh(d = base) {
    await importDoc(d);
    await select("a");
  }
  const num = (label) =>
    page.getByRole("spinbutton", { name: label, exact: true });
  const scalar = (a, b, t = 0.03) =>
    assert(Math.abs(a - b) < t, `${a} != ${b}`);
  const getHandle = (k) => page.getByTestId(`resize-${k}`);
  async function startHandle(k) {
    const h = await getHandle(k).boundingBox();
    const p = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    return p;
  }
  async function finish() {
    await page.mouse.up();
  }
  async function zoom() {
    const v = await page
      .locator(".renderer-surface svg > g")
      .getAttribute("transform");
    return v.match(/-?[\d.]+/g).map(Number)[2];
  }
  for (const [k, dx, dy, ew, eh, ex, ey] of [
    ["nw", -20, -10, 140, 90, 40, 70],
    ["n", 0, -10, 120, 90, 60, 70],
    ["ne", 20, -10, 140, 90, 60, 70],
    ["e", 20, 0, 140, 80, 60, 80],
    ["se", 20, 10, 140, 90, 60, 80],
    ["s", 0, 10, 120, 90, 60, 80],
    ["sw", -20, 10, 140, 90, 40, 80],
    ["w", -20, 0, 140, 80, 40, 80],
  ]) {
    await check(
      `eight-direction ${k}: dimensions, origin, one Undo/Redo`,
      async () => {
        await fresh();
        const before = await exportDoc(),
          z = await zoom(),
          p = await startHandle(k);
        await page.keyboard.down("Meta");
        await page.mouse.move(p.x + dx * z, p.y + dy * z);
        await finish();
        await page.keyboard.up("Meta");
        const after = await exportDoc(),
          n = after.nodes.a;
        scalar(n.width, ew);
        scalar(n.height, eh);
        scalar(n.transform[4], ex);
        scalar(n.transform[5], ey);
        scalar(Number(await num("W").inputValue()), n.width);
        scalar(Number(await num("H").inputValue()), n.height);
        await btn("실행 취소").click();
        assert.deepEqual(await exportDoc(), before);
        await btn("다시 실행").click();
        assert.deepEqual(await exportDoc(), after);
      },
    );
  }
  await check(
    "Shift and Alt toggle live with stationary pointer; centered ratio resize",
    async () => {
      await fresh();
      const z = await zoom(),
        p = await startHandle("se");
      await page.keyboard.down("Meta");
      await page.mouse.move(p.x + 40 * z, p.y + 10 * z);
      await page.keyboard.down("Shift");
      const preview = async () => ({
        width: Number(await num("W").inputValue()),
        height: Number(await num("H").inputValue()),
        transform: [
          1,
          0,
          0,
          1,
          Number(await num("X").inputValue()),
          Number(await num("Y").inputValue()),
        ],
      });
      let n = await preview();
      scalar(n.width / n.height, 1.5, 0.001);
      await page.keyboard.down("Alt");
      n = await preview();
      scalar(n.transform[4] + n.width / 2, 120);
      scalar(n.transform[5] + n.height / 2, 120);
      scalar(n.width / n.height, 1.5, 0.001);
      await page.keyboard.up("Shift");
      n = await preview();
      scalar(n.width, 200);
      scalar(n.height, 100);
      await finish();
      await page.keyboard.up("Alt");
      await page.keyboard.up("Meta");
    },
  );
  await check(
    "rotation Shift 15 degrees and numeric absolute rotation preserve center",
    async () => {
      await fresh();
      const d = await exportDoc(),
        c = await at(d, "a", 60, 40),
        h = await page.getByTestId("rotate-handle").boundingBox(),
        p = { x: h.x + 6, y: h.y + 6 };
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      const a = (23 * Math.PI) / 180,
        dx = p.x - c.x,
        dy = p.y - c.y;
      await page.mouse.move(
        c.x + dx * Math.cos(a) - dy * Math.sin(a),
        c.y + dx * Math.sin(a) + dy * Math.cos(a),
      );
      await page.keyboard.down("Shift");
      scalar(Number(await num("회전 °").inputValue()), 30, 0.1);
      await finish();
      await page.keyboard.up("Shift");
      await num("회전 °").fill("45");
      await num("회전 °").press("Tab");
      const r = await exportDoc(),
        m = world(r, "a");
      scalar((Math.atan2(m[1], m[0]) * 180) / Math.PI, 45, 0.01);
      scalar(m[0] * 60 + m[2] * 40 + m[4], 200);
      scalar(m[1] * 60 + m[3] * 40 + m[5], 180);
      if (process.env.TRANSFORMS_SCREENSHOT)
        await page.screenshot({ path: process.env.TRANSFORMS_SCREENSHOT });
      await btn("실행 취소").click();
      scalar(Number(await num("회전 °").inputValue()), 30, 0.1);
    },
  );
  await check(
    "affine parent NW resize and numeric width share local dimensions",
    async () => {
      const d = structuredClone(base);
      d.nodes.f.transform = [0.8, 0.6, 0.3, 1.2, 180, 60];
      await fresh(d);
      const before = await exportDoc(),
        old = world(before, "a"),
        z = await zoom(),
        p = await startHandle("nw");
      await page.keyboard.down("Meta");
      await page.mouse.move(
        p.x + (0.8 * -20 + 0.3 * -10) * z,
        p.y + (0.6 * -20 + 1.2 * -10) * z,
      );
      await finish();
      await page.keyboard.up("Meta");
      let r = await exportDoc();
      scalar(r.nodes.a.width, 140);
      scalar(r.nodes.a.height, 90);
      let m = world(r, "a");
      close(
        [m[0] * 140 + m[2] * 90 + m[4], m[1] * 140 + m[3] * 90 + m[5]],
        [
          old[0] * 120 + old[2] * 80 + old[4],
          old[1] * 120 + old[3] * 80 + old[5],
        ],
        0.05,
      );
      await num("W").fill("180");
      await num("W").press("Tab");
      r = await exportDoc();
      scalar(r.nodes.a.width, 180);
      scalar(Number(await num("W").inputValue()), 180);
    },
  );
  await check(
    "multi mixed-parent resize and rotation preserve relative world geometry; one Undo",
    async () => {
      await fresh();
      await page
        .getByTestId("layer-c")
        .locator(".layer-name")
        .click({ modifiers: ["Shift"] });
      const before = await exportDoc(),
        w = Number(await num("W").inputValue()),
        h = Number(await num("H").inputValue());
      const z = await zoom(),
        p = await startHandle("se");
      await page.keyboard.down("Shift");
      await page.keyboard.down("Meta");
      await page.mouse.move(p.x + w * z * 0.25, p.y + h * z * 0.25);
      await finish();
      await page.keyboard.up("Meta");
      await page.keyboard.up("Shift");
      scalar(Number(await num("W").inputValue()), w * 1.25, 0.1);
      scalar(Number(await num("H").inputValue()), h * 1.25, 0.1);
      const r = await exportDoc();
      close(r.nodes.b.transform, before.nodes.b.transform);
      await btn("실행 취소").click();
      assert.deepEqual(await exportDoc(), before);
      await num("회전 Δ°").fill("90");
      await num("회전 Δ°").press("Tab");
      const rotated = await exportDoc();
      const a = world(before, "a"),
        c = world(before, "c"),
        aa = world(rotated, "a"),
        cc = world(rotated, "c");
      close(
        [cc[4] - aa[4], cc[5] - aa[5]],
        [-(c[5] - a[5]), c[4] - a[4]],
        1e-6,
      );
      await btn("실행 취소").click();
      assert.deepEqual(await exportDoc(), before);
    },
  );
  await check(
    "group handle and numeric dimensions resize subtree and Undo",
    async () => {
      await fresh();
      await page
        .getByTestId("layer-b")
        .locator(".layer-name")
        .click({ modifiers: ["Shift"] });
      await key("g");
      const d = await exportDoc(),
        g = Object.values(d.nodes).find((n) => n.type === "group");
      assert(g);
      const w = g.width,
        h = g.height;
      await num("W").fill(String(w * 1.5));
      await num("W").press("Tab");
      let r = await exportDoc();
      scalar(r.nodes[g.id].width, w * 1.5);
      scalar(r.nodes[g.id].height, h);
      await btn("실행 취소").click();
      assert.deepEqual(await exportDoc(), d);
      const z = await zoom(),
        p = await startHandle("se");
      await page.keyboard.down("Meta");
      await page.mouse.move(p.x + 30 * z, p.y + 20 * z);
      await finish();
      await page.keyboard.up("Meta");
      r = await exportDoc();
      scalar(r.nodes[g.id].width, w + 30);
      scalar(r.nodes[g.id].height, h + 20);
    },
  );
  for (const cancel of ["Escape", "pointercancel", "blur"])
    await check(`${cancel} cancels resize and rotation previews`, async () => {
      for (const mode of ["resize", "rotate"]) {
        await fresh();
        const before = await exportDoc();
        let p;
        if (mode === "resize") p = await startHandle("se");
        else {
          const h = await page.getByTestId("rotate-handle").boundingBox();
          p = { x: h.x + 6, y: h.y + 6 };
          await page.mouse.move(p.x, p.y);
          await page.mouse.down();
        }
        await page.mouse.move(p.x + 40, p.y + 30);
        if (cancel === "Escape") await page.keyboard.press("Escape");
        else if (cancel === "blur")
          await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        else
          await page.getByTestId("canvas-stage").dispatchEvent("pointercancel");
        await finish();
        assert.deepEqual(await exportDoc(), before);
      }
    });
  await check(
    "relative rotation accepts typed digits with one editable rotated root and cancels draft",
    async () => {
      const d = structuredClone(base);
      d.nodes.c.locked = true;
      d.nodes.a.transform = [
        Math.SQRT1_2,
        Math.SQRT1_2,
        -Math.SQRT1_2,
        Math.SQRT1_2,
        60,
        80,
      ];
      await fresh(d);
      await page
        .getByTestId("layer-c")
        .locator(".layer-name")
        .click({ modifiers: ["Shift"] });
      const before = await exportDoc(),
        input = num("회전 Δ°");
      await input.fill("");
      await input.pressSequentially("30");
      assert.equal(await input.inputValue(), "30");
      await input.press("Enter");
      let r = await exportDoc(),
        m = world(r, "a");
      scalar((Math.atan2(m[1], m[0]) * 180) / Math.PI, 75, 0.01);
      assert.deepEqual(r.nodes.c, before.nodes.c);
      assert.equal(await input.inputValue(), "0");
      await input.fill("20");
      await input.press("Escape");
      assert.deepEqual(await exportDoc(), r);
      await btn("실행 취소").click();
      assert.deepEqual(await exportDoc(), before);
    },
  );
  await check(
    "locked selected roots stay unchanged and committed transform survives reload",
    async () => {
      const d = structuredClone(base);
      d.nodes.c.locked = true;
      await fresh(d);
      await page
        .getByTestId("layer-c")
        .locator(".layer-name")
        .click({ modifiers: ["Shift"] });
      await num("W").fill("160");
      await num("W").press("Tab");
      const after = await exportDoc();
      assert.deepEqual(after.nodes.c, d.nodes.c);
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-status"]').dataset
            .state === "saved",
      );
      await page.reload({ waitUntil: "networkidle" });
      assert.deepEqual(await exportDoc(), after);
    },
  );
  assert.deepEqual(errors, []);
  const report = {
    url,
    passed: checks.length,
    checks,
    pageErrors: errors,
    browser: browser.version(),
  };
  console.log(JSON.stringify(report));
  if (process.env.TRANSFORMS_REPORT)
    await fs.writeFile(
      process.env.TRANSFORMS_REPORT,
      JSON.stringify(report, null, 2),
    );
} finally {
  await browser.close();
}
