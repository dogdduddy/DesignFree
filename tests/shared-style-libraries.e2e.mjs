import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { authenticatedTestSession } from "./auth-helpers.mjs";
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5183/";
const auth =
  process.env.STYLE_SERVER === "1" ? await authenticatedTestSession(url) : null;
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({
  ...(auth ? { storageState: auth.storageState } : {}),
  viewport: { width: 1440, height: 1100 },
});
page.setDefaultTimeout(15000);
const checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const button = (name) => page.getByRole("button", { name, exact: true });
async function open(scope) {
  if (!(await scope.evaluate((el) => el.open)))
    await scope.locator(":scope > summary").click();
}
async function settled() {
  await page.waitForFunction(() =>
    ["idle", "saved"].includes(
      document.querySelector('[data-testid="save-status"]')?.dataset.state,
    ),
  );
}
async function download(name) {
  const pending = page.waitForEvent("download");
  await button(name).click();
  const chunks = [];
  for await (const c of await (await pending).createReadStream())
    chunks.push(c);
  return Buffer.concat(chunks).toString();
}
async function snapshot() {
  await settled();
  return JSON.parse(await download("JSON 저장"));
}
async function revision() {
  await settled();
  if (auth) {
    const r = await page.request.get(new URL("/api/library/current", url).href);
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
            t = db.transaction("drafts", "readonly"),
            q = t.objectStore("drafts").get("current");
          q.onsuccess = () => resolve(q.result?.revision ?? 0);
          t.oncomplete = () => db.close();
        };
      }),
  );
}
async function switchDoc(id) {
  await open(page.locator(".document-library"));
  await page.getByLabel("로컬 문서", { exact: true }).selectOption(id);
  await settled();
}
async function sharedPanel() {
  const panel = page.getByTestId("shared-style-libraries");
  await open(panel);
  return panel;
}
async function editSource(library) {
  await switchDoc("shared-source");
  await open(page.getByTestId("style-inspector"));
  await page
    .getByLabel("스타일 라이브러리 JSON", { exact: true })
    .fill(JSON.stringify(library));
  await button("스타일 라이브러리 적용").click();
  await settled();
  await switchDoc("shared-consumer");
}
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}
try {
  await page.goto(url, { waitUntil: "networkidle" });
  const demo = await snapshot(),
    root = structuredClone(demo.nodes[demo.rootId]);
  const pageNode = { ...root, id: "page", parentId: null, children: [] };
  const library = {
    tokens: {
      space: { kind: "spacing", name: "Space", value: 8 },
      size: { kind: "number", name: "Size", value: 220 },
      corner: { kind: "radius", name: "Corner", value: 10 },
    },
    styles: {
      space: { kind: "spacing", name: "Shared Space", value: { ref: "space" } },
      size: { kind: "number", name: "Shared Size", value: { ref: "size" } },
      corner: {
        kind: "radius",
        name: "Shared Corner",
        value: { ref: "corner" },
      },
    },
    themes: {},
  };
  const source = {
    schemaVersion: 2,
    id: "shared-source",
    name: "Shared System",
    rootId: "page",
    pageIds: ["page"],
    nodes: { page: pageNode },
    assets: {},
    styleLibrary: library,
  };
  const frame = {
    ...root,
    id: "frame",
    type: "frame",
    name: "Consumer Frame",
    parentId: "page",
    children: ["a", "b"],
    transform: [1, 0, 0, 1, 80, 80],
    width: 220,
    height: 160,
    layout: { mode: "flex", direction: "row", gap: 1, padding: [1, 1, 1, 1] },
    radius: 0,
    fill: { type: "solid", color: "#ffffff" },
    fills: [{ type: "solid", color: "#ffffff" }],
  };
  const child = (id) => ({
    ...frame,
    id,
    type: "rectangle",
    name: id,
    parentId: "frame",
    children: [],
    transform: [1, 0, 0, 1, 0, 0],
    width: 30,
    height: 30,
    layout: { mode: "absolute" },
    fill: { type: "solid", color: "#ff8800" },
    fills: [{ type: "solid", color: "#ff8800" }],
  });
  const target = {
    schemaVersion: 2,
    id: "shared-consumer",
    name: "Consumer",
    rootId: "page",
    pageIds: ["page"],
    nodes: {
      page: { ...pageNode, children: ["frame"] },
      frame,
      a: child("a"),
      b: child("b"),
    },
    assets: {},
  };
  page.once("dialog", (d) => d.accept());
  await page
    .locator('input[type="file"][accept="application/json,.json"]')
    .setInputFiles({
      name: "shared-library.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ document: target, documents: [source] }),
      ),
    });
  await page.getByTestId("layer-frame").waitFor();
  await settled();
  await check(
    "shared connection is one save and keeps stable, isolated local IDs",
    async () => {
      await sharedPanel();
      await page
        .getByLabel("공유 라이브러리 원본", { exact: true })
        .selectOption(source.id);
      const before = await revision();
      await button("공유 라이브러리 연결").click();
      const doc = await snapshot();
      assert.equal(await revision(), before + 1);
      assert.equal(doc.sharedStyleLibraries.length, 1);
      assert.notEqual(doc.sharedStyleLibraries[0].styles.space, "space");
      assert.equal(
        await page
          .getByTestId("shared-library-shared-source")
          .getAttribute("data-state"),
        "current",
      );
      const rev = await revision();
      await button("공유 업데이트").click();
      assert.equal(await revision(), rev);
    },
  );
  await page.getByTestId("layer-frame").locator(".layer-name").click();
  await open(page.getByTestId("style-inspector"));
  const linked = await snapshot(),
    map = linked.sharedStyleLibraries[0].styles;
  for (const [label, id] of [
    ["간격 스타일", map.space],
    ["안쪽 여백 (전체) 스타일", map.space],
    ["너비 스타일", map.size],
    ["모서리 스타일", map.corner],
  ]) {
    await page.getByLabel(label, { exact: true }).selectOption(id);
    await settled();
  }
  const bound = await snapshot();
  await check(
    "source token edit is pinned until an explicit update, which supports Undo/Redo",
    async () => {
      const changed = structuredClone(library);
      changed.tokens.space.value = 20;
      changed.tokens.size.value = 280;
      changed.tokens.corner.value = 18;
      await editSource(changed);
      await sharedPanel();
      assert.equal(
        await page
          .getByTestId("shared-library-shared-source")
          .getAttribute("data-state"),
        "update",
      );
      assert.deepEqual((await snapshot()).styleLibrary, bound.styleLibrary);
      await page.getByTestId("layer-frame").locator(".layer-name").click();
      const before = await revision();
      await button("공유 업데이트").click();
      const updated = await snapshot();
      assert.equal(await revision(), before + 1);
      assert.deepEqual(
        updated.sharedStyleLibraries,
        bound.sharedStyleLibraries,
      );
      assert.equal(
        updated.styleLibrary.tokens[
          updated.sharedStyleLibraries[0].tokens.space
        ].value,
        20,
      );
      assert.equal(updated.nodes.frame.layout.gap, 1);
      await button("실행 취소").click();
      assert.deepEqual((await snapshot()).styleLibrary, bound.styleLibrary);
      await button("다시 실행").click();
      assert.deepEqual((await snapshot()).styleLibrary, updated.styleLibrary);
      assert.ok(
        (await page.getByTestId("layer-frame").getAttribute("class")).includes(
          "selected",
        ),
      );
    },
  );
  await check(
    "shared update reaches actual SVG and HTML/CSS downloads without source writes",
    async () => {
      const before = await snapshot(),
        rev = await revision();
      await button("내보내기").click();
      const svg = await download("SVG 벡터 파일");
      assert.ok(svg.includes('rx="18"'));
      assert.ok(svg.includes('width="280"'));
      await button("내보내기").click();
      await button("선택 frame 웹 미리보기").click();
      await page.getByRole("dialog").waitFor();
      const html = await download("HTML 다운로드");
      assert.ok(html.includes(":20px"));
      assert.ok(html.includes(":280px"));
      assert.ok(html.includes(":18px"));
      const output = await browser.newPage({
        viewport: { width: 280, height: 300 },
      });
      await output.setContent(html);
      const values = await output
        .locator("[data-dr-theme-set]")
        .first()
        .locator('[data-node-id="frame"]')
        .evaluate((el) => {
          const s = getComputedStyle(el);
          return {
            gap: s.gap,
            padding: s.paddingTop,
            radius: s.borderTopLeftRadius,
            width: s.width,
          };
        });
      assert.deepEqual(values, {
        gap: "20px",
        padding: "20px",
        radius: "18px",
        width: "280px",
      });
      await output.close();
      await button("미리보기 닫기").click();
      assert.deepEqual(await snapshot(), before);
      assert.equal(await revision(), rev);
    },
  );
  await check(
    "missing source entries stay explicit and retain usable export snapshots",
    async () => {
      await editSource({ tokens: {}, styles: {}, themes: {} });
      await sharedPanel();
      const state = page.getByTestId("shared-library-shared-source");
      assert.equal(await state.getAttribute("data-state"), "missing");
      assert.match(await state.innerText(), /원본 항목 없음/);
      const before = await snapshot(),
        rev = await revision();
      await button("공유 업데이트").click();
      assert.deepEqual(await snapshot(), before);
      assert.equal(await revision(), rev);
      await page.reload();
      await settled();
      await sharedPanel();
      assert.equal(
        await page
          .getByTestId("shared-library-shared-source")
          .getAttribute("data-state"),
        "missing",
      );
    },
  );
  await check(
    "deleted source is visibly missing; conversion to local is one reversible save",
    async () => {
      await switchDoc(source.id);
      page.once("dialog", (d) => d.accept());
      await button("문서 삭제").click();
      await settled();
      await sharedPanel();
      const state = page.getByTestId("shared-library-shared-source");
      assert.match(await state.innerText(), /원본 문서 없음/);
      assert.equal(
        await state
          .getByRole("button", { name: "공유 업데이트", exact: true })
          .isDisabled(),
        true,
      );
      const before = await snapshot(),
        rev = await revision();
      await button("로컬 라이브러리로 전환").click();
      const local = await snapshot();
      assert.equal(await revision(), rev + 1);
      assert.equal(local.sharedStyleLibraries, undefined);
      assert.deepEqual(local.styleLibrary, before.styleLibrary);
      assert.deepEqual(local.nodes, before.nodes);
      await button("실행 취소").click();
      assert.deepEqual(await snapshot(), before);
    },
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    process.env.SHARED_STYLE_REPORT || artifactPath("d03-shared-styles.json"),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(`PASS ${checks.length} shared library browser scenarios`);
} finally {
  await browser.close();
}
