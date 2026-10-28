import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { authenticatedTestSession } from "./auth-helpers.mjs";
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const auth =
  process.env.COMPONENT_SERVER === "1"
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
      name: "components.json",
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
    name: id,
    type,
    children: [],
    transform: [1, 0, 0, 1, 0, 0],
    width: 200,
    height: 100,
    layout: { mode: "absolute" },
    fill: { type: "solid", color: type === "text" ? "#20243a" : "#ffffff" },
    fills: undefined,
    opacity: 1,
    visible: true,
    locked: false,
    ...extra,
  });
  Object.assign(root, {
    fill: { type: "none" },
    opacity: 1,
    visible: true,
    locked: false,
    clipContent: false,
    transform: [1, 0, 0, 1, 0, 0],
    width: 900,
    height: 400,
  });
  root.children = ["main", "outer"];
  await load({
    ...demo,
    id: "component-fixture",
    name: "C01 Components",
    schemaVersion: 1,
    pageIds: undefined,
    nodes: {
      [root.id]: root,
      main: node("main", root.id, "frame", {
        children: ["label"],
        transform: [1, 0, 0, 1, 50, 50],
      }),
      label: node("label", "main", "text", {
        height: 40,
        text: {
          content: "원본",
          fontFamily: "Noto Sans KR",
          fontSize: 16,
          fontWeight: 400,
          lineHeight: 24,
        },
      }),
      outer: node("outer", root.id, "frame", {
        transform: [1, 0, 0, 1, 400, 50],
        width: 260,
        height: 180,
      }),
    },
    assets: {},
  });
  let id, cid;
  await check(
    "inspector creates main and linked instance with stable child identity",
    async () => {
      await select("main");
      await button("컴포넌트 생성").click();
      await button("인스턴스 생성").click();
      const doc = await snapshot();
      const instance = Object.values(doc.nodes).find(
        (n) => n.component?.kind === "instance",
      );
      id = instance.id;
      cid = instance.component.nodeMap.label;
      assert.equal(instance.component.sourceId, "main");
      assert.equal(doc.nodes[cid].text.content, "원본");
    },
  );
  await check(
    "original edits propagate and descendant content override preserves inherited text style",
    async () => {
      await select(cid);
      await page
        .getByLabel("텍스트 내용", { exact: true })
        .fill("인스턴스 사용자 문구");
      await select("label");
      await page.getByLabel("텍스트 내용", { exact: true }).fill("원본 변경");
      const size = page.getByLabel("크기", { exact: true });
      await size.fill("28");
      await size.press("Enter");
      const doc = await snapshot();
      assert.equal(doc.nodes[cid].text.content, "인스턴스 사용자 문구");
      assert.equal(doc.nodes[cid].text.fontSize, 28);
      assert.equal(
        doc.nodes[id].component.overrides.label["text.content"],
        "인스턴스 사용자 문구",
      );
    },
  );
  await check(
    "duplicate keeps linkage, fresh IDs and the command 24-unit offset",
    async () => {
      await select(id);
      const before = await snapshot();
      await button("선택 항목 복제").click();
      const after = await snapshot(),
        duplicate = Object.values(after.nodes).find(
          (n) => n.component?.kind === "instance" && n.id !== id,
        );
      assert.equal(duplicate.transform[4], before.nodes[id].transform[4] + 24);
      assert.notEqual(duplicate.component.nodeMap.label, cid);
      await button("실행 취소").click();
    },
  );
  await check(
    "internal delete is rejected with unchanged document and no runtime error",
    async () => {
      await select(cid);
      const before = await snapshot();
      await button("선택 항목 삭제").click();
      assert.ok((await page.locator("body").innerText()).includes("먼저 분리"));
      assert.deepEqual(await snapshot(), before);
    },
  );
  let outerInstance, outerLabel;
  await check(
    "nested instance inside a main propagates two source levels and preserves outer override",
    async () => {
      const d = await snapshot();
      d.nodes[d.rootId].children = d.nodes[d.rootId].children.filter(
        (n) => n !== id,
      );
      d.nodes[id].parentId = "outer";
      d.nodes.outer.children = [id];
      await load(d);
      await select("outer");
      await button("컴포넌트 생성").click();
      await button("인스턴스 생성").click();
      const created = await snapshot();
      outerInstance = Object.values(created.nodes).find(
        (n) => n.component?.sourceId === "outer",
      ).id;
      outerLabel = created.nodes[outerInstance].component.nodeMap[cid];
      await select(outerLabel);
      await page
        .getByLabel("텍스트 내용", { exact: true })
        .fill("중첩 외부 override");
      await select("label");
      const size = page.getByLabel("크기", { exact: true });
      await size.fill("32");
      await size.press("Enter");
      const after = await snapshot();
      assert.equal(after.nodes[outerLabel].text.content, "중첩 외부 override");
      assert.equal(after.nodes[outerLabel].text.fontSize, 32);
      await button("실행 취소").click();
      assert.equal((await snapshot()).nodes[outerLabel].text.fontSize, 28);
      await button("다시 실행").click();
      assert.equal((await snapshot()).nodes[outerLabel].text.fontSize, 32);
    },
  );
  await check(
    "override reset and detach preserve geometry; source no longer changes detached copy",
    async () => {
      await select(outerInstance);
      const before = await snapshot();
      await button("override 초기화").click();
      const reset = await snapshot();
      assert.equal(
        reset.nodes[outerLabel].text.content,
        "인스턴스 사용자 문구",
      );
      assert.deepEqual(
        reset.nodes[outerInstance].transform,
        before.nodes[outerInstance].transform,
      );
      await button("인스턴스 분리").click();
      assert.equal(
        (await snapshot()).nodes[outerInstance].component,
        undefined,
      );
      await select("label");
      const size = page.getByLabel("크기", { exact: true });
      await size.fill("36");
      await size.press("Enter");
      const after = await snapshot();
      assert.equal(after.nodes[outerLabel].text.fontSize, 32);
      assert.equal(after.nodes[cid].text.fontSize, 36);
    },
  );
  await check(
    "component identity and overrides survive autosave reload and both renderers",
    async () => {
      await select(id);
      const before = await snapshot();
      await page.waitForTimeout(1800);
      await page.reload({ waitUntil: "networkidle" });
      assert.deepEqual(await snapshot(), before);
      await page
        .getByLabel("렌더러 선택", { exact: true })
        .selectOption("canvaskit");
      await page.waitForTimeout(800);
      await page.getByLabel("렌더러 선택", { exact: true }).selectOption("svg");
      assert.deepEqual(await snapshot(), before);
    },
  );
  await check(
    "deleting original detaches surviving nested snapshots in one undoable change",
    async () => {
      await select("main");
      const before = await snapshot();
      await button("선택 항목 삭제").click();
      assert.equal((await snapshot()).nodes[id].component, undefined);
      await button("실행 취소").click();
      assert.deepEqual(await snapshot(), before);
    },
  );
  assert.deepEqual(errors, []);
  if (process.env.COMPONENT_SCREENSHOT) {
    await select(id);
    await page.screenshot({ path: process.env.COMPONENT_SCREENSHOT });
  }
  const report = {
    url,
    checks,
    passed: checks.length,
    failed: 0,
    pageErrors: errors,
    browser: browser.version(),
  };
  await fs.writeFile(
    process.env.COMPONENT_REPORT || artifactPath("202-c01-browser.json"),
    JSON.stringify(report, null, 2),
  );
} finally {
  await browser.close();
}
