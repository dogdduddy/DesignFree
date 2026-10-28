import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { authenticatedTestSession } from "./auth-helpers.mjs";
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const auth =
  process.env.VARIANT_SERVER === "1"
    ? await authenticatedTestSession(url)
    : null;
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
  await page.getByTestId("layer-main").waitFor();
}
try {
  await page.goto(url, { waitUntil: "networkidle" });
  const demo = await snapshot(),
    root = structuredClone(demo.nodes[demo.rootId]);
  const node = (id, parentId, type, extra = {}) => ({
    ...root,
    id,
    parentId,
    type,
    name: id,
    children: [],
    transform: [1, 0, 0, 1, 0, 0],
    width: 200,
    height: 100,
    layout: { mode: "absolute" },
    fill: { type: "solid", color: "#ffffff" },
    fills: undefined,
    visible: true,
    locked: false,
    opacity: 1,
    ...extra,
  });
  root.children = ["main"];
  root.visible = true;
  root.locked = false;
  await load({
    ...demo,
    id: "variant-fixture",
    name: "C02 Variants",
    schemaVersion: 1,
    pageIds: undefined,
    assets: {},
    nodes: {
      [root.id]: root,
      main: node("main", root.id, "frame", {
        children: ["label", "badge"],
        transform: [1, 0, 0, 1, 50, 50],
      }),
      label: node("label", "main", "text", {
        height: 40,
        fill: { type: "solid", color: "#20243a" },
        text: {
          content: "기본",
          fontFamily: "Noto Sans KR",
          fontSize: 16,
          fontWeight: 400,
          lineHeight: 24,
        },
      }),
      badge: node("badge", "main", "rectangle", { width: 20, height: 20 }),
    },
  });
  let other, id, cid, targetLabel;
  await check(
    "create variants and edit multidimensional property schema through inspector",
    async () => {
      await select("main");
      await button("컴포넌트 생성").click();
      await button("Variant 추가").click();
      let d = await snapshot();
      other = Object.values(d.nodes).find(
        (n) => n.component?.variant && n.id !== "main",
      ).id;
      const input = page.getByLabel("Variant 속성", { exact: true });
      await input.fill(JSON.stringify({ State: "Hover", Size: "Small" }));
      await input.press("Enter");
      d = await snapshot();
      assert.deepEqual(d.nodes.main.component.variant.properties, {
        State: "Default",
        Size: "Small",
      });
      assert.deepEqual(d.nodes[other].component.variant.properties, {
        State: "Hover",
        Size: "Small",
      });
      targetLabel = d.nodes[other].children[0];
    },
  );
  await check(
    "reject duplicate property tuple without history changes",
    async () => {
      const before = await snapshot(),
        input = page.getByLabel("Variant 속성", { exact: true });
      await input.fill(JSON.stringify({ State: "Default", Size: "Small" }));
      await input.press("Enter");
      assert.deepEqual(await snapshot(), before);
    },
  );
  await check(
    "switch inherits target style and preserves descendant override and stable identity",
    async () => {
      await select("main");
      await button("인스턴스 생성").click();
      let d = await snapshot();
      id = Object.values(d.nodes).find(
        (n) => n.component?.kind === "instance",
      ).id;
      cid = d.nodes[id].component.nodeMap.label;
      await select(cid);
      await page
        .getByLabel("텍스트 내용", { exact: true })
        .fill("사용자 override");
      await select(targetLabel);
      const size = page.getByLabel("크기", { exact: true });
      await size.fill("28");
      await size.press("Enter");
      await select(id);
      const before = await snapshot();
      await page
        .getByLabel("Variant 전환", { exact: true })
        .selectOption(other);
      d = await snapshot();
      assert.equal(d.nodes[id].component.nodeMap[targetLabel], cid);
      assert.equal(d.nodes[cid].text.content, "사용자 override");
      assert.equal(d.nodes[cid].text.fontSize, 28);
      assert.deepEqual(d.nodes[id].transform, before.nodes[id].transform);
      const after = d;
      await button("실행 취소").click();
      assert.deepEqual(await snapshot(), before);
      await button("다시 실행").click();
      assert.deepEqual(await snapshot(), after);
    },
  );
  await check(
    "target edits transfer on return and JSON/autosave reload retains variant connection",
    async () => {
      await select(cid);
      await page
        .getByLabel("텍스트 내용", { exact: true })
        .fill("전환 후 수정");
      await select(id);
      await page
        .getByLabel("Variant 전환", { exact: true })
        .selectOption("main");
      let d = await snapshot();
      assert.equal(d.nodes[cid].text.content, "전환 후 수정");
      assert.equal(d.nodes[cid].text.fontSize, 16);
      await load(d);
      assert.deepEqual(await snapshot(), d);
      await page.waitForTimeout(1800);
      await page.reload({ waitUntil: "networkidle" });
      assert.deepEqual(await snapshot(), d);
      await page
        .getByLabel("렌더러 선택", { exact: true })
        .selectOption("canvaskit");
      await page.waitForTimeout(800);
      await page.getByLabel("렌더러 선택", { exact: true }).selectOption("svg");
      assert.deepEqual(await snapshot(), d);
    },
  );
  await check(
    "missing layer override survives switch/reload and restores on return",
    async () => {
      await select(id);
      let d = await snapshot();
      const bid = d.nodes[id].component.nodeMap.badge;
      await select(bid);
      const width = page.getByLabel("W", { exact: true });
      await width.fill("77");
      await width.press("Enter");
      d = await snapshot();
      const removed = d.nodes[other].children[1];
      d.nodes[other].children = d.nodes[other].children.filter(
        (n) => n !== removed,
      );
      delete d.nodes[removed];
      await load(d);
      await select(id);
      await page
        .getByLabel("Variant 전환", { exact: true })
        .selectOption(other);
      d = await snapshot();
      assert.equal(d.nodes[bid], undefined);
      await page.waitForTimeout(1800);
      await page.reload({ waitUntil: "networkidle" });
      await select(id);
      await page
        .getByLabel("Variant 전환", { exact: true })
        .selectOption("main");
      d = await snapshot();
      assert.equal(d.nodes[d.nodes[id].component.nodeMap.badge].width, 77);
    },
  );
  await check(
    "reset clears preserved overrides and detach keeps current variant snapshot",
    async () => {
      await select(id);
      await button("override 초기화").click();
      await page
        .getByLabel("Variant 전환", { exact: true })
        .selectOption(other);
      let d = await snapshot();
      assert.equal(
        d.nodes[d.nodes[id].component.nodeMap[targetLabel]].text.content,
        "기본",
      );
      await button("인스턴스 분리").click();
      d = await snapshot();
      assert.equal(d.nodes[id].component, undefined);
    },
  );
  assert.deepEqual(errors, []);
  if (process.env.VARIANT_SCREENSHOT)
    await page.screenshot({ path: process.env.VARIANT_SCREENSHOT });
  await fs.writeFile(
    process.env.VARIANT_REPORT || artifactPath("220-c02-browser.json"),
    JSON.stringify(
      {
        url,
        checks,
        passed: checks.length,
        failed: 0,
        pageErrors: errors,
        browser: browser.version(),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
