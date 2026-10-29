import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { authenticatedTestSession } from "./auth-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const server = process.env.FLOW_SERVER === "1";
const auth = server ? await authenticatedTestSession(url) : null;
const browser = await chromium.launch(browserLaunchOptions());
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  ...(auth ? { storageState: auth.storageState } : {}),
});
const page = await context.newPage(),
  checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const btn = (name) => page.getByRole("button", { name, exact: true });
const select = (id) =>
  page.getByTestId(`layer-${id}`).locator(".layer-name").click();
const selected = () =>
  page
    .locator(".layer.selected")
    .evaluateAll((rows) => rows.map((el) => el.dataset.testid.slice(6)));
async function exported() {
  const pending = page.waitForEvent("download");
  await btn("JSON 저장").click();
  const chunks = [];
  for await (const chunk of await (await pending).createReadStream())
    chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function settled() {
  await page.waitForTimeout(850);
}
async function revision() {
  if (server) {
    const r = await context.request.get(
      new URL("/api/library/current", url).href,
    );
    assert.equal(r.status(), 200);
    return (await r.json()).version;
  }
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("draftroom-local-drafts", 1);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("drafts", "readonly"),
            get = tx.objectStore("drafts").get("current");
          get.onsuccess = () => resolve(get.result.revision);
          tx.oncomplete = () => db.close();
        };
      }),
  );
}
const colors = Object.fromEntries(
  ["f", "g", "a", "b", "c", "d", "e", "h", "x"].map((id, i) => [
    id,
    `#${(0xaa3300 + i * 157).toString(16).toUpperCase()}`,
  ]),
);
let fixtureRoot;
async function at(id, x, y) {
  const selector =
    id === fixtureRoot
      ? ".renderer-surface svg > g"
      : `.renderer-surface svg rect[fill="${colors[id]}"]`;
  return page.locator(selector).evaluate(
    (el, [x, y, root]) => {
      const p = new DOMPoint(x, y).matrixTransform(
        (root ? el : el.parentElement).getScreenCTM(),
      );
      return { x: p.x, y: p.y };
    },
    [x, y, id === fixtureRoot],
  );
}
async function move(from, to, finish = true) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  if (finish) await page.mouse.up();
}
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
}
try {
  await page.goto(url, { waitUntil: "networkidle" });
  const demo = await exported(),
    root = structuredClone(demo.nodes[demo.rootId]);
  const sample = Object.values(demo.nodes).find((n) => n.type === "rectangle");
  const node = (id, parentId, props = {}) => ({
    ...structuredClone(sample),
    id,
    name: id,
    parentId,
    children: [],
    type: "rectangle",
    width: 60,
    height: 40,
    transform: [1, 0, 0, 1, 300, 200],
    layout: { mode: "absolute" },
    fills: undefined,
    stroke: undefined,
    fill: { type: "solid", color: colors[id] },
    ...props,
  });
  fixtureRoot = root.id;
  root.children = ["f", "g", "x"];
  root.width = 900;
  root.height = 600;
  const fixture = {
    ...demo,
    schemaVersion: 1,
    pageIds: undefined,
    id: "flow-ui",
    name: "Flow UI",
    assets: {},
    nodes: {
      [root.id]: root,
      f: node("f", root.id, {
        type: "frame",
        width: 320,
        height: 180,
        transform: [1, 0, 0, 1, 40, 50],
        children: ["a", "b", "c"],
        layout: { mode: "flex", gap: 20, padding: [20, 20, 20, 20] },
      }),
      g: node("g", root.id, {
        type: "frame",
        width: 320,
        height: 200,
        transform: [1, 0, 0, 1, 430, 50],
        children: ["d", "e", "h"],
        layout: {
          mode: "grid",
          gap: 20,
          padding: [20, 20, 20, 20],
          grid: { columns: [100, 100], rows: [60, 60] },
        },
      }),
      a: node("a", "f", { type: "frame" }),
      b: node("b", "f", { type: "frame" }),
      c: node("c", "f"),
      d: node("d", "g"),
      e: node("e", "g"),
      h: node("h", "g"),
      x: node("x", root.id, {
        transform: [1, 0, 0, 1, 380, 400],
        layout: { mode: "absolute", width: "fixed", minWidth: 30 },
      }),
    },
  };
  for (const node of Object.values(fixture.nodes)) {
    delete node.fills;
    delete node.stroke;
  }
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles({
      name: "flow.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
  await settled();
  await check(
    "Flex frame children reorder over sibling surfaces; live indicator and one durable commit",
    async () => {
      await select("a");
      const rev = await revision();
      await move(await at("a", 30, 20), await at("b", 55, 20), false);
      assert.equal(
        await page.getByTestId("flow-insertion").getAttribute("data-parent-id"),
        "f",
      );
      await settled();
      assert.equal(await revision(), rev);
      await page.mouse.up();
      await settled();
      const d = await exported();
      assert.deepEqual(d.nodes.f.children, ["b", "a", "c"]);
      for (const id of ["a", "b", "c"])
        assert.deepEqual(d.nodes[id], fixture.nodes[id]);
      assert.equal(await revision(), rev + 1);
      await btn("실행 취소").click();
      await settled();
      assert.deepEqual((await exported()).nodes.f.children, ["a", "b", "c"]);
      await btn("다시 실행").click();
      await settled();
      assert.deepEqual((await exported()).nodes.f.children, ["b", "a", "c"]);
    },
  );
  await check("same-slot flow drag makes no history or save", async () => {
    const before = await exported(),
      rev = await revision();
    await move(await at("a", 30, 20), await at("a", 35, 22));
    await settled();
    assert.deepEqual(await exported(), before);
    assert.equal(await revision(), rev);
    // The prior reorder is still the next Undo.
    await btn("실행 취소").click();
    await settled();
    assert.deepEqual((await exported()).nodes.f.children, ["a", "b", "c"]);
    await btn("다시 실행").click();
    await settled();
  });
  await check(
    "external layer insertion preserves authored rules and commits once",
    async () => {
      await select("x");
      const rev = await revision();
      await move(await at("x", 30, 20), await at("b", 5, 20));
      await settled();
      const d = await exported();
      assert.deepEqual(d.nodes.f.children, ["x", "b", "a", "c"]);
      assert.deepEqual(d.nodes.x, { ...fixture.nodes.x, parentId: "f" });
      assert.equal(await revision(), rev + 1);
      await btn("실행 취소").click();
      await settled();
      assert.equal((await exported()).nodes.x.parentId, root.id);
      await btn("다시 실행").click();
      await settled();
    },
  );
  await check(
    "Escape restores scene and original selection without writes",
    async () => {
      await select("e");
      const before = await exported(),
        rev = await revision();
      await move(await at("x", 30, 20), await at("c", 55, 20), false);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await settled();
      assert.deepEqual(await exported(), before);
      assert.deepEqual(await selected(), ["e"]);
      assert.equal(await revision(), rev);
      assert.equal(await page.getByTestId("flow-insertion").count(), 0);
    },
  );
  await check(
    "Grid automatic children reorder across rows in one Undo/save",
    async () => {
      await select("d");
      const before = await exported(),
        rev = await revision();
      await move(await at("d", 30, 20), await at("h", 55, 20));
      await settled();
      const d = await exported();
      assert.deepEqual(d.nodes.g.children, ["e", "h", "d"]);
      assert.deepEqual(d.nodes.d, before.nodes.d);
      assert.equal(await revision(), rev + 1);
      await btn("실행 취소").click();
      await settled();
      assert.deepEqual((await exported()).nodes.g.children, ["d", "e", "h"]);
      await btn("다시 실행").click();
      await settled();
    },
  );
  await check(
    "cross-container insertion preserves both layout containers",
    async () => {
      await select("x");
      const before = await exported(),
        rev = await revision();
      await move(await at("x", 30, 20), await at("e", 5, 20));
      await settled();
      const d = await exported();
      assert.equal(d.nodes.x.parentId, "g");
      assert.deepEqual(d.nodes.g.children, ["x", "e", "h", "d"]);
      assert.deepEqual(d.nodes.f.layout, before.nodes.f.layout);
      assert.deepEqual(d.nodes.g.layout, before.nodes.g.layout);
      assert.equal(await revision(), rev + 1);
    },
  );
  await check(
    "pointercancel restores scene and selection; leaving target is a no-op for managed source",
    async () => {
      const before = await exported(),
        rev = await revision();
      await select("h");
      await move(await at("x", 30, 20), await at("d", 55, 20), false);
      await page
        .getByTestId("canvas-stage")
        .dispatchEvent("pointercancel", { pointerId: 1 });
      await page.mouse.up();
      await settled();
      assert.deepEqual(await exported(), before);
      assert.deepEqual(await selected(), ["h"]);
      assert.equal(await revision(), rev);
      await select("x");
      await move(await at("x", 30, 20), await at(root.id, 850, 500));
      await settled();
      assert.deepEqual(await exported(), before);
      assert.equal(await revision(), rev);
    },
  );
  await check("reload retains authored order and rule values", async () => {
    const before = await exported();
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(await exported(), before);
  });
  async function loadVariant(change) {
    const d = structuredClone(fixture);
    change(d);
    await page
      .locator('input[type=file][accept="application/json,.json"]')
      .setInputFiles({
        name: "flow-variant.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(d)),
      });
    await settled();
    return d;
  }
  await check("column Flex flow reorders vertically", async () => {
    await loadVariant((d) => {
      d.nodes.f.layout.direction = "column";
      d.nodes.f.height = 260;
    });
    await select("a");
    await move(await at("a", 30, 20), await at("c", 30, 35));
    await settled();
    assert.deepEqual((await exported()).nodes.f.children, ["b", "c", "a"]);
  });
  await check("wrapped Flex flow reorders across lines", async () => {
    await loadVariant((d) => {
      d.nodes.f.layout.wrap = true;
      d.nodes.f.width = 200;
    });
    await select("a");
    await move(await at("a", 30, 20), await at("c", 55, 20));
    await settled();
    assert.deepEqual((await exported()).nodes.f.children, ["b", "c", "a"]);
  });
  await check(
    "explicit Grid positions stay pinned; indicator marks computed destination",
    async () => {
      const source = await loadVariant((d) => {
        d.nodes.g.height = 300;
        d.nodes.d.layout.grid = { column: 1, row: 3 };
      });
      await select("h");
      await move(await at("h", 30, 20), await at("d", 5, 20), false);
      const marker = await page.getByTestId("flow-insertion").boundingBox();
      const destination = await at("h", 0, 0);
      assert.ok(
        Math.abs(marker.x - destination.x) < 3 &&
          Math.abs(marker.y - destination.y) < 3,
      );
      await page.mouse.up();
      await settled();
      const d = await exported();
      assert.deepEqual(d.nodes.g.children, ["h", "d", "e"]);
      assert.deepEqual(d.nodes.d.layout, source.nodes.d.layout);
    },
  );
  await check(
    "multiple Grid roots preserve paint order and mark first moved root",
    async () => {
      await loadVariant(() => {});
      await select("h");
      await page
        .getByTestId("layer-e")
        .locator(".layer-name")
        .click({ modifiers: ["Shift"] });
      assert.deepEqual(await selected(), ["e", "h"]); // panel renders in paint order
      await move(await at("h", 30, 20), await at("d", 5, 20), false);
      const marker = await page.getByTestId("flow-insertion").boundingBox(),
        destination = await at("e", 0, 0);
      assert.ok(
        Math.abs(marker.x - destination.x) < 3 &&
          Math.abs(marker.y - destination.y) < 3,
      );
      await page.mouse.up();
      await settled();
      assert.deepEqual((await exported()).nodes.g.children, ["e", "h", "d"]);
    },
  );
  await check(
    "Alt at flow gesture start produces no duplicate, history or save",
    async () => {
      await select("e");
      const before = await exported(),
        rev = await revision();
      await page.keyboard.down("Alt");
      await move(await at("e", 30, 20), await at("d", 55, 20), false);
      await page.keyboard.up("Alt");
      await page.mouse.up();
      await settled();
      assert.deepEqual(await exported(), before);
      assert.equal(await revision(), rev);
    },
  );
  await check(
    "empty flow insertion converts only absolute placement and Undo restores it",
    async () => {
      const source = await loadVariant((d) => {
        d.nodes.f.children = [];
        for (const id of ["a", "b", "c"]) delete d.nodes[id];
        d.nodes.x.layout.position = "absolute";
      });
      await select("x");
      await move(await at("x", 30, 20), await at("f", 40, 40));
      await settled();
      const d = await exported();
      assert.deepEqual(d.nodes.f.children, ["x"]);
      assert.deepEqual(d.nodes.x, {
        ...source.nodes.x,
        parentId: "f",
        layout: { ...source.nodes.x.layout, position: "flow" },
      });
      await btn("실행 취소").click();
      await settled();
      assert.deepEqual((await exported()).nodes.x, source.nodes.x);
    },
  );
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: process.env.FLOW_SCREENSHOT || artifactPath("flow-drop.png"),
  });
  const report = process.env.FLOW_REPORT || artifactPath("flow-drop.json");
  await fs.mkdir(new URL("../test-results/", import.meta.url), {
    recursive: true,
  });
  await fs.writeFile(
    report,
    JSON.stringify(
      {
        mode: server ? "server" : "browser",
        browser: browser.version(),
        checks,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
