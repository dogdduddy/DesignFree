import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { authenticatedTestSession } from "./auth-helpers.mjs";
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const auth =
  process.env.STYLE_SERVER === "1" ? await authenticatedTestSession(url) : null;
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({
  ...(auth ? { storageState: auth.storageState } : {}),
  viewport: { width: 1440, height: 1100 },
});
page.setDefaultTimeout(15000);
const errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const button = (name) => page.getByRole("button", { name, exact: true });
const select = (id) =>
  page
    .getByTestId("layer-" + id)
    .locator(".layer-name")
    .click();
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
};
async function snapshot() {
  // The saving label changes header width; wait for its settled state before
  // targeting the download button, especially on the authenticated build.
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
async function load(doc) {
  await page
    .locator('input[type="file"][accept="application/json,.json"]')
    .setInputFiles({
      name: "variants.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
  await page.getByTestId("layer-frame").waitFor();
}
const typography = {
  fontFamily: "Noto Sans KR",
  fontSize: 32,
  fontWeight: 700,
  lineHeight: 40,
};
let library = {
  tokens: {
    base: { kind: "color", name: "Base", value: "#123456" },
    alias: { kind: "color", name: "Alias", value: { ref: "base" } },
    body: { kind: "text", name: "Body", value: typography },
    elevation: {
      kind: "effect",
      name: "Elevation",
      value: [
        { type: "drop-shadow", x: 12, y: 10, blur: 3, color: "#00000080" },
      ],
    },
  },
  styles: {
    ink: { kind: "color", name: "Ink", value: { ref: "alias" } },
    body: { kind: "text", name: "Body", value: { ref: "body" } },
    shadow: { kind: "effect", name: "Shadow", value: { ref: "elevation" } },
  },
  themes: {
    dark: {
      name: "Dark",
      values: {
        base: "#aabbcc",
        body: { ...typography, fontSize: 48, lineHeight: 56 },
      },
    },
  },
};
const openStyles = async () => {
  const details = page.getByTestId("style-inspector");
  if (
    !(await details.getAttribute("open")) &&
    !(await details.evaluate((el) => el.open))
  )
    await details.locator(":scope > summary").click();
};
const apply = async (value) => {
  await openStyles();
  await page
    .getByLabel("스타일 라이브러리 JSON", { exact: true })
    .fill(JSON.stringify(value));
  await button("스타일 라이브러리 적용").click();
};
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
    fill: { type: "solid", color: "#fff" },
    fills: undefined,
    layout: { mode: "absolute" },
    clipContent: false,
  };
  const fixture = {
    ...demo,
    id: "c03-styles-fixture",
    name: "C03 Styles",
    schemaVersion: 1,
    pageIds: undefined,
    assets: {},
    nodes: {
      [root.id]: root,
      frame: {
        ...base,
        id: "frame",
        type: "frame",
        parentId: root.id,
        transform: [1, 0, 0, 1, 100, 100],
        width: 420,
        height: 300,
        children: ["label"],
      },
      label: {
        ...base,
        id: "label",
        type: "text",
        parentId: "frame",
        transform: [1, 0, 0, 1, 40, 60],
        width: 300,
        height: 100,
        text: {
          ...typography,
          content: "공통 스타일",
          fontSize: 16,
          sizing: "fixed",
        },
      },
    },
  };
  await load(fixture);
  await check(
    "library JSON editing and typed bindings preserve authored fallbacks",
    async () => {
      await apply(library);
      await select("label");
      await openStyles();
      await page.getByLabel("색 스타일", { exact: true }).selectOption("ink");
      await page
        .getByLabel("텍스트 스타일", { exact: true })
        .selectOption("body");
      await page
        .getByLabel("효과 스타일", { exact: true })
        .selectOption("shadow");
      const d = await snapshot();
      assert.deepEqual(d.nodes.label.styleRefs, {
        color: "ink",
        text: "body",
        effect: "shadow",
      });
      assert.equal(d.nodes.label.text.fontSize, 16);
      assert.equal(
        await page.getByLabel("크기", { exact: true }).inputValue(),
        "32",
      );
      assert(await page.getByLabel("크기", { exact: true }).isDisabled());
    },
  );
  await check(
    "theme updates SVG typography, fills, shadows, and one Undo/Redo",
    async () => {
      await page
        .getByLabel("스타일 theme", { exact: true })
        .selectOption("dark");
      assert.equal(
        await page.getByLabel("크기", { exact: true }).inputValue(),
        "48",
      );
      assert(
        (await page.locator('.renderer-host text[font-size="48"]').count()) >
          0 || (await page.locator('text[font-size="48"]').count()) > 0,
      );
      assert((await page.locator("feDropShadow").count()) > 0);
      assert((await page.locator('[fill="#aabbcc"]').count()) > 0);
      await button("실행 취소").click();
      assert.equal((await snapshot()).styleLibrary.activeTheme, undefined);
      await button("다시 실행").click();
      assert.equal((await snapshot()).styleLibrary.activeTheme, "dark");
    },
  );
  await check(
    "local content stays editable and JSON/autosave reload preserve theme references",
    async () => {
      await page
        .getByLabel("텍스트 내용", { exact: true })
        .fill("테마 안의 로컬 텍스트");
      const d = await snapshot();
      assert.equal(d.nodes.label.text.content, "테마 안의 로컬 텍스트");
      assert.equal(d.nodes.label.text.fontSize, 16);
      await load(d);
      assert.deepEqual(await snapshot(), d);
      await page.waitForTimeout(1500);
      await page.reload({ waitUntil: "networkidle" });
      assert.deepEqual(await snapshot(), d);
      await select("label");
      await openStyles();
      await page
        .getByLabel("렌더러 선택", { exact: true })
        .selectOption("canvaskit");
      await page.waitForTimeout(700);
      await page.getByLabel("렌더러 선택", { exact: true }).selectOption("svg");
      assert.deepEqual(await snapshot(), d);
    },
  );
  await check(
    "cyclic/missing/wrong-kind library and referenced deletion reject atomically",
    async () => {
      const before = await snapshot();
      for (const mutate of [
        (l) => (l.tokens.base.value = { ref: "alias" }),
        (l) => (l.tokens.alias.value = { ref: "missing" }),
        (l) => (l.styles.ink.value = { ref: "body" }),
        (l) => delete l.styles.ink,
        (l) => (l.themes.dark.values.base = { ref: "alias" }),
      ]) {
        const invalid = structuredClone(before.styleLibrary);
        mutate(invalid);
        await apply(invalid);
        assert((await page.getByRole("alert").count()) > 0);
        assert.deepEqual(await snapshot(), before);
      }
      await apply(before.styleLibrary);
    },
  );
  await check(
    "detach freezes themed color/text/effect and new shared style can be created",
    async () => {
      await page.getByLabel("텍스트 스타일", { exact: true }).selectOption("");
      await page.getByLabel("색 스타일", { exact: true }).selectOption("");
      await page.getByLabel("효과 스타일", { exact: true }).selectOption("");
      let d = await snapshot();
      assert.equal(d.nodes.label.text.fontSize, 48);
      assert.equal(d.nodes.label.fill.color, "#aabbcc");
      assert.equal(d.nodes.label.effects[0].blur, 3);
      assert.equal(d.nodes.label.styleRefs, undefined);
      await button("선택 색 스타일 저장").click();
      d = await snapshot();
      assert(d.styleLibrary.styles[d.nodes.label.styleRefs.color]);
      if (process.env.STYLE_SCREENSHOT)
        await page.screenshot({ path: process.env.STYLE_SCREENSHOT });
    },
  );
  assert.deepEqual(errors, []);
  if (process.env.STYLE_REPORT)
    await fs.writeFile(
      process.env.STYLE_REPORT,
      JSON.stringify(
        {
          browser: browser.version(),
          checks,
          passed: checks.length,
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
