import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { authenticatedTestSession } from "./auth-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const server = process.env.L05_SERVER === "1";
const auth = server ? await authenticatedTestSession(url) : null;
const browser = await chromium.launch(browserLaunchOptions());
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ["clipboard-read", "clipboard-write"],
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
const key = async (k) => {
  await page.keyboard.press(`Meta+${k}`);
  await settled();
};
async function imported(doc) {
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles({
      name: "layout-edit.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
  await settled();
}
async function oneUndo(before, action, verify) {
  const rev = await revision();
  await action();
  await settled();
  const after = await exported();
  await verify(after);
  assert.equal(await revision(), rev + 1);
  await btn("실행 취소").click();
  await settled();
  assert.deepEqual(await exported(), before);
  await btn("다시 실행").click();
  await settled();
  assert.deepEqual(await exported(), after);
  return after;
}
try {
  await page.goto(url, { waitUntil: "networkidle" });
  const demo = await exported();
  const template = Object.values(demo.nodes).find(
    (n) => n.type === "rectangle",
  );
  for (const mode of ["flex", "grid"]) {
    const root = structuredClone(demo.nodes[demo.rootId]);
    fixtureRoot = root.id;
    root.children = ["f", "g"];
    root.width = 900;
    root.height = 600;
    const node = (id, parentId, props = {}) => ({
      ...structuredClone(template),
      id,
      name: id,
      parentId,
      children: [],
      type: "rectangle",
      width: 60,
      height: 40,
      transform: [1, 0, 0, 1, 100, 90],
      layout: { mode: "absolute" },
      fills: undefined,
      stroke: undefined,
      fill: { type: "solid", color: colors[id] },
      ...props,
    });
    const fixture = {
      ...demo,
      schemaVersion: 1,
      pageIds: undefined,
      id: `l05-${mode}`,
      name: "Layout editing",
      assets: {},
      nodes: {
        [root.id]: root,
        f: node("f", root.id, {
          type: "frame",
          width: 320,
          height: 180,
          transform: [1, 0, 0, 1, 40, 50],
          children: ["a", "b", "c"],
          layout: {
            mode,
            gap: 10,
            padding: [10, 10, 10, 10],
            grid: { columns: [80, { fr: 1 }], rows: [50, 50] },
          },
        }),
        g: node("g", root.id, {
          type: "frame",
          width: 320,
          height: 220,
          transform: [1, 0.1, 0.2, 1, 430, 50],
          children: ["d"],
          layout: {
            mode: mode === "flex" ? "grid" : "flex",
            grid: { columns: [100, 100] },
          },
        }),
        a: node("a", "f"),
        b: node("b", "f"),
        c: node("c", "f", {
          layout: {
            mode: "absolute",
            width: "fill",
            minWidth: 20,
            grid: { column: 2, columnSpan: 2 },
          },
        }),
        d: node("d", "g"),
      },
    };
    await imported(fixture);
    await check(
      `${mode}: copy preserves source and emits computed SVG without save; same-parent paste is one action`,
      async () => {
        await select("c");
        const before = await exported(),
          rev = await revision();
        const width = await page
          .locator(`.renderer-surface svg rect[fill="${colors.c}"]`)
          .getAttribute("width");
        await key("c");
        const copied = JSON.parse(
          await page.evaluate(() => navigator.clipboard.readText()),
        );
        assert.equal(copied.document.nodes.c.width, before.nodes.c.width);
        assert.deepEqual(
          copied.placements.c.sourceLocal,
          before.nodes.c.transform,
        );
        const html = await page.evaluate(async () => {
          const items = await navigator.clipboard.read();
          return await (
            await items
              .find((i) => i.types.includes("text/html"))
              .getType("text/html")
          ).text();
        });
        assert(html.includes(`width="${width}"`));
        assert.deepEqual(await exported(), before);
        assert.equal(await revision(), rev);
        await oneUndo(
          before,
          () => key("v"),
          async (after) => {
            const [id] = await selected();
            assert.deepEqual(after.nodes[id], {
              ...before.nodes.c,
              id,
              name: "c copy",
            });
            assert.equal(after.nodes.f.children.length, 4);
          },
        );
      },
    );
    await imported(fixture);
    await check(
      `${mode}: nested layout container paste retains subtree rules into another layout`,
      async () => {
        await select("f");
        await key("c");
        await select("g");
        const before = await exported();
        await oneUndo(
          before,
          () => key("v"),
          async (after) => {
            const [id] = await selected(),
              frame = after.nodes[id];
            assert.equal(frame.parentId, "g");
            assert.deepEqual(frame.layout, before.nodes.f.layout);
            assert.deepEqual(frame.transform, before.nodes.f.transform);
            frame.children.forEach((child, i) => {
              const old = before.nodes[before.nodes.f.children[i]];
              assert.deepEqual(after.nodes[child].layout, old.layout);
              assert.deepEqual(after.nodes[child].transform, old.transform);
            });
          },
        );
      },
    );
    await imported(fixture);
    await check(
      `${mode}: native cut and cross-container paste each commit once and preserve rules`,
      async () => {
        await select("c");
        const before = await exported();
        await oneUndo(
          before,
          () => key("x"),
          async (after) => assert(!after.nodes.c),
        );
        await select("g");
        const cut = await exported();
        await oneUndo(
          cut,
          () => key("v"),
          async (after) => {
            const [id] = await selected();
            assert.equal(after.nodes[id].parentId, "g");
            assert.deepEqual(after.nodes[id].layout, before.nodes.c.layout);
            assert.deepEqual(
              after.nodes[id].transform,
              before.nodes.c.transform,
            );
          },
        );
      },
    );
    await imported(fixture);
    await check(
      `${mode}: native panel reparent into other layout and out to absolute preserves authored fallbacks`,
      async () => {
        await select("a");
        const before = await exported();
        const drag = (target) =>
          page
            .getByTestId("layer-a")
            .dragTo(page.getByTestId(`layer-${target}`), {
              targetPosition: { x: 130, y: 16 },
            });
        let after = await oneUndo(
          before,
          () => drag("g"),
          async (after) => {
            assert.deepEqual(after.nodes.a, {
              ...before.nodes.a,
              parentId: "g",
            });
          },
        );
        // Turn g into an absolute container through the existing inspector; then move a back out of flow.
        await select("g");
        await page
          .getByLabel("레이아웃 모드", { exact: true })
          .selectOption("absolute");
        await settled();
        await select("b");
        after = await exported();
        await oneUndo(
          after,
          () =>
            page.getByTestId("layer-b").dragTo(page.getByTestId("layer-g"), {
              targetPosition: { x: 130, y: 16 },
            }),
          async (moved) => {
            assert.deepEqual(moved.nodes.b, {
              ...after.nodes.b,
              parentId: "g",
            });
          },
        );
      },
    );
    await imported(fixture);
    await check(
      `${mode}: fixed container resize, rotation, group and ungroup retain descendant authoring`,
      async () => {
        await select("f");
        let before = await exported();
        const number = async (label, value) => {
          await page
            .getByRole("spinbutton", { name: label, exact: true })
            .fill(String(value));
          await page
            .getByRole("spinbutton", { name: label, exact: true })
            .press("Enter");
        };
        await oneUndo(
          before,
          () => number("W", 360),
          async (after) => {
            assert.equal(after.nodes.f.width, 360);
            for (const id of ["a", "b", "c"])
              assert.deepEqual(after.nodes[id], before.nodes[id]);
            assert.deepEqual(after.nodes.f.layout, before.nodes.f.layout);
          },
        );
        before = await exported();
        await oneUndo(
          before,
          () => number("회전 °", 15),
          async (after) => {
            assert.notDeepEqual(
              after.nodes.f.transform,
              before.nodes.f.transform,
            );
            for (const id of ["a", "b", "c"])
              assert.deepEqual(after.nodes[id], before.nodes[id]);
          },
        );
        await page
          .getByTestId("canvas-stage")
          .click({ position: { x: 800, y: 500 } });
        await select("f");
        before = await exported();
        const grouped = await oneUndo(
          before,
          () => key("g"),
          async (after) => {
            const [id] = await selected();
            assert.equal(after.nodes[id].type, "group");
            assert.deepEqual(after.nodes.f.layout, before.nodes.f.layout);
            for (const id of ["a", "b", "c"])
              assert.deepEqual(after.nodes[id], before.nodes[id]);
          },
        );
        await select(grouped.nodes.f.parentId);
        await oneUndo(
          grouped,
          () => key("Shift+g"),
          async (after) => {
            assert.deepEqual(after.nodes.f.layout, before.nodes.f.layout);
            assert.equal(after.nodes.f.parentId, root.id);
          },
        );
      },
    );
    await imported(fixture);
    await check(
      `${mode}: flow restrictions explain why; absolute toggle unlocks movement; cancel and no-op do not save`,
      async () => {
        await select("b");
        const before = await exported(),
          rev = await revision();
        assert(
          await page
            .locator(".layout-managed-hint")
            .filter({ hasText: "flow 부모" })
            .isVisible(),
        );
        await key("g");
        assert.deepEqual(await exported(), before);
        assert.equal(await revision(), rev);
        const label = mode === "flex" ? "Flex 자식 배치" : "Grid 자식 배치";
        await oneUndo(
          before,
          () =>
            page.getByLabel(label, { exact: true }).selectOption("absolute"),
          async (after) => {
            assert.deepEqual(after.nodes.b, {
              ...before.nodes.b,
              layout: { ...before.nodes.b.layout, position: "absolute" },
            });
          },
        );
        const absolute = await exported();
        await select("b");
        await oneUndo(
          absolute,
          () => page.keyboard.press("ArrowRight"),
          async (after) => {
            assert.equal(
              after.nodes.b.transform[4],
              absolute.nodes.b.transform[4] + 1,
            );
            assert.equal(after.nodes.b.layout.position, "absolute");
          },
        );
        const source = await exported(),
          r = await revision();
        await select("b");
        await move(await at("b", 20, 20), await at("b", 35, 25), false);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await settled();
        assert.deepEqual(await exported(), source);
        assert.deepEqual(await selected(), ["b"]);
        assert.equal(await revision(), r);
        await move(await at("b", 20, 20), await at("b", 35, 25));
        await settled();
        const moved = await exported();
        assert.equal(moved.nodes.b.layout.position, "absolute");
        assert.notDeepEqual(moved.nodes.b.transform, source.nodes.b.transform);
        assert.equal(await revision(), r + 1);
        await oneUndo(
          moved,
          () => page.getByLabel(label, { exact: true }).selectOption("flow"),
          async (after) => {
            assert.deepEqual(after.nodes.b.transform, moved.nodes.b.transform);
            assert.equal(after.nodes.b.layout.position, "flow");
          },
        );
        const flow = await exported(),
          finalRev = await revision();
        await page.getByLabel(label, { exact: true }).selectOption("flow");
        await settled();
        assert.deepEqual(await exported(), flow);
        assert.equal(await revision(), finalRev);
        await page.reload({ waitUntil: "networkidle" });
        await settled();
        assert.deepEqual(await exported(), flow);
      },
    );
  }
  await check(
    "clipboard SVG keeps computed text wrapping while JSON retains authored auto-width",
    async () => {
      const root = structuredClone(demo.nodes[demo.rootId]);
      root.children = ["f"];
      const text = structuredClone(
        Object.values(demo.nodes).find((n) => n.type === "text"),
      );
      Object.assign(text, {
        id: "a",
        name: "a",
        parentId: "f",
        children: [],
        width: 400,
        height: 80,
        transform: [1, 0, 0, 1, 100, 100],
        layout: { mode: "absolute", width: "fill" },
        text: {
          ...text.text,
          content: "abcdefghijabcdefghij",
          fontSize: 16,
          sizing: "auto-width",
        },
      });
      const frame = {
        ...structuredClone(template),
        id: "f",
        name: "f",
        type: "frame",
        parentId: root.id,
        children: ["a"],
        width: 60,
        height: 200,
        transform: [1, 0, 0, 1, 50, 50],
        layout: { mode: "flex" },
      };
      const fixture = {
        ...demo,
        schemaVersion: 1,
        pageIds: undefined,
        id: "l05-text",
        assets: {},
        nodes: { [root.id]: root, f: frame, a: text },
      };
      await imported(fixture);
      await select("a");
      const spans = await page
        .locator(".renderer-surface svg text tspan")
        .allTextContents();
      assert(spans.length > 1);
      const before = await exported(),
        rev = await revision();
      await key("c");
      const payload = JSON.parse(
        await page.evaluate(() => navigator.clipboard.readText()),
      );
      assert.equal(payload.document.nodes.a.text.sizing, "auto-width");
      const copied = await page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const html = await (
          await items
            .find((i) => i.types.includes("text/html"))
            .getType("text/html")
        ).text();
        return Array.from(
          new DOMParser()
            .parseFromString(html, "text/html")
            .querySelectorAll("tspan"),
          (n) => n.textContent,
        );
      });
      assert.deepEqual(copied, spans);
      assert.deepEqual(await exported(), before);
      assert.equal(await revision(), rev);
    },
  );
  await check(
    "nested flow absolute reparent uses computed world axes without baking sizes",
    async () => {
      const root = structuredClone(demo.nodes[demo.rootId]);
      root.children = ["x", "g"];
      const frame = (id, parentId, children, transform, layout) => ({
        ...structuredClone(template),
        id,
        name: id,
        type: "frame",
        parentId,
        children,
        width: 300,
        height: 200,
        transform,
        layout,
        fill: { type: "solid", color: colors[id] },
      });
      const b = {
        ...structuredClone(template),
        id: "b",
        name: "b",
        parentId: "f",
        children: [],
        width: 40,
        height: 30,
        transform: [1, 0, 0, 1, 20, 20],
        layout: { mode: "absolute", position: "absolute" },
        fill: { type: "solid", color: colors.b },
      };
      const fixture = {
        ...demo,
        schemaVersion: 1,
        pageIds: undefined,
        id: "l05-nested",
        assets: {},
        nodes: {
          [root.id]: root,
          x: frame("x", root.id, ["f"], [1, 0, 0, 1, 50, 50], { mode: "flex" }),
          f: frame("f", "x", ["b"], [1, 0, 0, 1, 140, 120], { mode: "flex" }),
          g: frame("g", root.id, [], [1, 0.1, 0.2, 1, 450, 50], {
            mode: "absolute",
          }),
          b,
        },
      };
      await imported(fixture);
      await select("b");
      const before = await exported(),
        position = await at("b", 0, 0);
      await oneUndo(
        before,
        () =>
          page.getByTestId("layer-b").dragTo(page.getByTestId("layer-g"), {
            targetPosition: { x: 130, y: 16 },
          }),
        async (after) => {
          assert.equal(after.nodes.b.parentId, "g");
          assert.equal(after.nodes.b.width, b.width);
          assert.deepEqual(after.nodes.b.layout, b.layout);
          const moved = await at("b", 0, 0);
          assert(
            Math.abs(moved.x - position.x) < 1 &&
              Math.abs(moved.y - position.y) < 1,
          );
        },
      );
    },
  );
  await check(
    "group insertion into flow is rejected through panel and clipboard with a reason and no writes",
    async () => {
      // The previous fixture has an ordinary absolute g frame and a flow x frame.
      await select("g");
      await key("g");
      const [group] = await selected(),
        before = await exported(),
        rev = await revision();
      await page
        .getByTestId(`layer-${group}`)
        .dragTo(page.getByTestId("layer-x"), {
          targetPosition: { x: 130, y: 16 },
        });
      await settled();
      assert(
        await page
          .getByText("그룹을 Flex/Grid 흐름 안에 넣으면", { exact: false })
          .isVisible(),
      );
      assert.deepEqual(await exported(), before);
      assert.equal(await revision(), rev);
      await select(group);
      await key("c");
      await select("x");
      await key("v");
      assert(
        await page
          .getByText("그룹을 Flex/Grid 흐름 안에 넣으면", { exact: false })
          .isVisible(),
      );
      assert.deepEqual(await exported(), before);
      assert.equal(await revision(), rev);
      // A rejected operation must not consume the previous group Undo.
      await btn("실행 취소").click();
      await settled();
      assert(!(await exported()).nodes[group]);
    },
  );
  assert.deepEqual(errors, []);
  await fs.mkdir(new URL("../test-results/", import.meta.url), {
    recursive: true,
  });
  await page.screenshot({
    path: process.env.L05_SCREENSHOT || artifactPath("layout-editing.png"),
  });
  await fs.writeFile(
    process.env.L05_REPORT || artifactPath("layout-editing.json"),
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
