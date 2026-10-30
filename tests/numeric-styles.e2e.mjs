import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { authenticatedTestSession } from "./auth-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

// Only the initial scene is imported. All library authoring below uses the UI;
// JSON downloads and storage reads observe committed state, never mutate it.
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
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
const editor = page.getByTestId("style-visual-editor");
const entry = (id) => editor.getByTestId(`style-entry-${id}`);
const theme = (id) => editor.getByTestId(`style-theme-${id}`);
const field = (scope, label) => scope.getByLabel(label, { exact: true });
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
};
async function open(details) {
  if (!(await details.evaluate((el) => el.open)))
    await details.locator(":scope > summary").click();
}
async function edit() {
  await open(page.getByTestId("style-inspector"));
  await button("스타일·토큰·테마 편집").click();
}
async function select(id) {
  await page.getByTestId(`layer-${id}`).locator(".layer-name").click();
}
async function snapshot() {
  await page.waitForFunction(() =>
    ["idle", "saved"].includes(
      document.querySelector('[data-testid="save-status"]')?.dataset.state,
    ),
  );
  const wait = page.waitForEvent("download");
  await button("JSON 저장").click();
  const chunks = [];
  for await (const c of await (await wait).createReadStream()) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function revision() {
  await snapshot();
  if (auth) {
    const response = await page.request.get(
      new URL("/api/library/current", url).href,
    );
    assert.equal(response.status(), 200);
    return (await response.json())?.version ?? 0;
  }
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("draftroom-local-drafts", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("drafts", "readonly");
          const get = tx.objectStore("drafts").get("current");
          get.onerror = () => reject(get.error);
          get.onsuccess = () => resolve(get.result?.revision ?? 0);
          tx.oncomplete = () => db.close();
        };
      }),
  );
}
async function load(doc) {
  await page
    .locator('input[type="file"][accept="application/json,.json"]')
    .setInputFiles({
      name: "d03-numeric-styles.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
  await page.getByTestId("layer-frame").waitFor();
}
async function newEntry(group, kind, name) {
  await field(editor, "새 항목 타입").selectOption(kind);
  const old = new Set(
    await editor
      .locator('[data-testid^="style-entry-"]')
      .evaluateAll((els) => els.map((el) => el.dataset.testid)),
  );
  await button(group === "tokens" ? "토큰 추가" : "스타일 추가").click();
  const all = await editor
    .locator('[data-testid^="style-entry-"]')
    .evaluateAll((els) => els.map((el) => el.dataset.testid));
  const id = all.find((v) => !old.has(v)).slice("style-entry-".length);
  await open(entry(id));
  await field(entry(id), `${group}.${id} 이름`).fill(name);
  return id;
}
async function reference(id, token) {
  await open(entry(id));
  await field(entry(id), "값 출처").selectOption("token");
  await field(entry(id), "참조 토큰").selectOption(token);
}
async function themeToken(tid, token) {
  const scope = theme(tid)
    .locator("details")
    .filter({
      has: page.getByLabel(`${tid}.${token} 재정의`, { exact: true }),
    });
  await open(scope);
  return scope;
}
let space, alias, size, round, spaceStyle, sizeStyle, roundStyle, roomy;
try {
  await page.goto(url, { waitUntil: "networkidle" });
  const demo = await snapshot(),
    root = structuredClone(demo.nodes[demo.rootId]);
  root.children = ["frame"];
  const base = {
    ...root,
    children: [],
    visible: true,
    locked: false,
    opacity: 1,
    fill: { type: "solid", color: "#88aaff" },
    fills: undefined,
    effects: undefined,
    component: undefined,
    styleRefs: undefined,
    text: undefined,
    layout: { mode: "absolute" },
    clipContent: false,
    radius: 2,
  };
  await load({
    ...demo,
    id: "d03-numeric-ui",
    name: "D03 Numeric tokens",
    schemaVersion: 1,
    pageIds: undefined,
    assets: {},
    styleLibrary: undefined,
    sharedStyleLibraries: undefined,
    nodes: {
      [root.id]: root,
      frame: {
        ...base,
        id: "frame",
        name: "Numeric frame",
        type: "frame",
        parentId: root.id,
        transform: [1, 0, 0, 1, 100, 100],
        width: 500,
        height: 350,
        children: ["box"],
        layout: { mode: "flex", gap: 3, padding: [2, 2, 2, 2] },
      },
      box: {
        ...base,
        id: "box",
        name: "Numeric box",
        type: "rectangle",
        parentId: "frame",
        transform: [1, 0, 0, 1, 0, 0],
        width: 44,
        height: 55,
      },
    },
  });
  await select("box");
  await check(
    "typed numeric tokens, alias, styles and theme are staged and applied as one save",
    async () => {
      const before = await snapshot(),
        rev = await revision();
      await edit();
      space = await newEntry("tokens", "spacing", "Space");
      await field(entry(space), "간격 값").fill("8");
      alias = await newEntry("tokens", "spacing", "Space alias");
      await reference(alias, space);
      size = await newEntry("tokens", "number", "Size");
      await field(entry(size), "숫자 값").fill("100");
      round = await newEntry("tokens", "radius", "Round");
      await field(entry(round), "모서리 값").fill("12");
      spaceStyle = await newEntry("styles", "spacing", "Space style");
      await reference(spaceStyle, alias);
      sizeStyle = await newEntry("styles", "number", "Size style");
      await reference(sizeStyle, size);
      roundStyle = await newEntry("styles", "radius", "Round style");
      await reference(roundStyle, round);
      await button("테마 추가").click();
      roomy = (
        await editor
          .locator('[data-testid^="style-theme-"]')
          .getAttribute("data-testid")
      ).slice("style-theme-".length);
      await open(theme(roomy));
      await field(theme(roomy), `themes.${roomy} 이름`).fill("Roomy");
      for (const [token, label, value] of [
        [space, "간격 값", "20"],
        [size, "숫자 값", "160"],
        [round, "모서리 값", "30"],
      ]) {
        const scope = await themeToken(roomy, token);
        await field(scope, `${roomy}.${token} 재정의`).check();
        await field(scope, label).fill(value);
      }
      assert.deepEqual(await snapshot(), before);
      assert.equal(await revision(), rev);
      await button("시각 편집 적용").click();
      assert.equal(await revision(), rev + 1);
      const lib = (await snapshot()).styleLibrary;
      assert.equal(lib.tokens[size].value, 100);
      assert.deepEqual(lib.tokens[alias].value, { ref: space });
      assert.equal(lib.themes[roomy].values[space], 20);
    },
  );
  await check(
    "numeric bindings preserve authored dimensions and disable bound controls",
    async () => {
      for (const label of ["너비 스타일", "높이 스타일"])
        await field(page, label).selectOption(sizeStyle);
      await field(page, "모서리 스타일").selectOption(roundStyle);
      for (const [label, expected] of [
        ["W", "100"],
        ["H", "100"],
        ["모서리", "12"],
      ]) {
        assert.equal(await field(page, label).inputValue(), expected);
        assert(await field(page, label).isDisabled());
      }
      let doc = await snapshot();
      assert.equal(doc.nodes.box.width, 44);
      assert.equal(doc.nodes.box.height, 55);
      assert.equal(doc.nodes.box.radius, 2);
      await select("frame");
      await field(page, "간격 스타일").selectOption(spaceStyle);
      await field(page, "안쪽 여백 (전체) 스타일").selectOption(spaceStyle);
      assert(await field(page, "Flex 간격").isDisabled());
      assert.equal(await field(page, "Flex 간격").inputValue(), "8");
      assert(await field(page, "안쪽 여백 위").isDisabled());
      doc = await snapshot();
      assert.equal(doc.nodes.frame.layout.gap, 3);
      assert.deepEqual(doc.nodes.frame.layout.padding, [2, 2, 2, 2]);
    },
  );
  await check(
    "theme switches update geometry with one history action and detach freezes values",
    async () => {
      const before = await snapshot(),
        rev = await revision();
      await field(page, "스타일 theme").selectOption(roomy);
      assert.equal(await revision(), rev + 1);
      assert.equal(await field(page, "Flex 간격").inputValue(), "20");
      await button("실행 취소").click();
      assert.deepEqual(await snapshot(), before);
      await button("다시 실행").click();
      assert.equal(await field(page, "Flex 간격").inputValue(), "20");
      for (const label of ["간격 스타일", "안쪽 여백 (전체) 스타일"])
        await field(page, label).selectOption("");
      let doc = await snapshot();
      assert.equal(doc.nodes.frame.layout.gap, 20);
      assert.deepEqual(doc.nodes.frame.layout.padding, [20, 20, 20, 20]);
      assert(await field(page, "Flex 간격").isEnabled());
      await select("box");
      assert.equal(await field(page, "W").inputValue(), "160");
      for (const label of ["너비 스타일", "높이 스타일", "모서리 스타일"])
        await field(page, label).selectOption("");
      doc = await snapshot();
      assert.equal(doc.nodes.box.width, 160);
      assert.equal(doc.nodes.box.height, 160);
      assert.equal(doc.nodes.box.radius, 30);
      assert(await field(page, "W").isEnabled());
    },
  );
  await check(
    "token edits update bindings; cancel, invalid apply and unchanged apply do not save",
    async () => {
      await field(page, "너비 스타일").selectOption(sizeStyle);
      let before = await snapshot(),
        rev = await revision();
      await edit();
      await open(entry(size));
      await field(entry(size), "숫자 값").fill("240");
      await button("시각 편집 취소").click();
      assert.deepEqual(await snapshot(), before);
      assert.equal(await revision(), rev);
      await edit();
      await button("시각 편집 적용").click();
      assert.equal(await revision(), rev);
      await edit();
      await open(entry(size));
      await field(entry(size), "숫자 값").fill("-1");
      await button("시각 편집 적용").click();
      assert.deepEqual(await snapshot(), before);
      assert.equal(await revision(), rev);
      await button("시각 편집 취소").click();
      await field(page, "스타일 theme").selectOption("");
      rev = await revision();
      await edit();
      await open(entry(size));
      await field(entry(size), "숫자 값").fill("240");
      await button("시각 편집 적용").click();
      assert.equal(await revision(), rev + 1);
      assert.equal(await field(page, "W").inputValue(), "240");
      assert.equal((await snapshot()).nodes.box.width, 160);
    },
  );
  await check(
    "JSON roundtrip and durable reload keep numeric values and bindings",
    async () => {
      const before = await snapshot();
      await load(before);
      assert.deepEqual(await snapshot(), before);
      await revision();
      await page.reload({ waitUntil: "networkidle" });
      assert.deepEqual(await snapshot(), before);
      await select("box");
      await open(page.getByTestId("style-inspector"));
      assert.equal(await field(page, "W").inputValue(), "240");
      await page.screenshot({
        path:
          process.env.NUMERIC_STYLE_SCREENSHOT ||
          artifactPath("d03-numeric-ui.png"),
      });
    },
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    process.env.NUMERIC_STYLE_REPORT || artifactPath("d03-numeric-ui.json"),
    JSON.stringify(
      {
        browser: browser.version(),
        checks,
        passed: checks.length,
        failed: 0,
        pageErrors: errors,
        server: !!auth,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
