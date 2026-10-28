import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { authenticatedTestSession } from "./auth-helpers.mjs";
const browser = await chromium.launch(browserLaunchOptions());
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const auth =
  process.env.FLEX_SERVER === "1" ? await authenticatedTestSession(url) : null;
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  ...(auth ? { storageState: auth.storageState } : {}),
});
const errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const btn = (name) => page.getByRole("button", { name, exact: true });
const label = (name) => page.getByLabel(name, { exact: true });
const choose = async (id) =>
  page
    .getByTestId("layer-" + id)
    .locator(".layer-name")
    .click();
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
};
async function download(name) {
  const pending = page.waitForEvent("download");
  await btn(name).click();
  const chunks = [];
  for await (const c of await (await pending).createReadStream())
    chunks.push(c);
  await page.waitForTimeout(100);
  return Buffer.concat(chunks);
}
const exported = async () =>
  JSON.parse((await download("JSON 저장")).toString());
const enter = async (name, value) => {
  await label(name).fill(String(value));
  await label(name).press("Tab");
  await page.waitForTimeout(100);
};
const shape = async (color) =>
  page.locator(`.renderer-surface svg rect[fill="${color}"]`).evaluate((el) => {
    const g = el.parentElement;
    return {
      width: Number(el.getAttribute("width")),
      height: Number(el.getAttribute("height")),
      transform: g.getAttribute("transform"),
    };
  });
try {
  await page.goto(url, { waitUntil: "networkidle" });
  const demo = await exported();
  const root = structuredClone(demo.nodes[demo.rootId]);
  root.children = ["flex-frame"];
  root.width = 900;
  root.height = 600;
  const sample = structuredClone(
    Object.values(demo.nodes).find((n) => n.type === "rectangle"),
  );
  const node = (id, parent, width, height, color) => ({
    ...sample,
    id,
    name: id,
    parentId: parent,
    children: [],
    width,
    height,
    transform: [1, 0, 0, 1, 90, 80],
    layout: { mode: "absolute" },
    fill: { type: "solid", color },
    fills: undefined,
    stroke: undefined,
  });
  const frame = {
    ...node("flex-frame", root.id, 300, 160, "#EEEEEE"),
    type: "frame",
    transform: [1, 0, 0, 1, 50, 50],
    children: ["fixed", "fill", "overlay"],
  };
  const fixture = {
    ...demo,
    schemaVersion: 1,
    pageIds: undefined,
    id: "flex-ui-fixture",
    name: "Flex UI fixture",
    nodes: {
      [root.id]: root,
      "flex-frame": frame,
      fixed: node("fixed", "flex-frame", 60, 30, "#AA3300"),
      fill: node("fill", "flex-frame", 50, 40, "#0055AA"),
      overlay: {
        ...node("overlay", "flex-frame", 15, 15, "#00AA55"),
        transform: [1, 0, 0, 1, 230, 110],
        layout: { mode: "absolute", position: "absolute" },
      },
    },
    assets: {},
  };
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles({
      name: "flex.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
  await page.waitForTimeout(400);
  await check(
    "configure frame flex direction, padding, gap and computed renderer boxes",
    async () => {
      await choose("flex-frame");
      await label("레이아웃 모드").selectOption("flex");
      await enter("Flex 간격", 10);
      for (const side of ["위", "오른쪽", "아래", "왼쪽"])
        await enter("안쪽 여백 " + side, 10);
      await choose("fill");
      await label("너비 방식").selectOption("fill");
      await page.waitForTimeout(150);
      assert.deepEqual(await shape("#AA3300"), {
        width: 60,
        height: 30,
        transform: "matrix(1 0 0 1 10 10)",
      });
      assert.deepEqual(await shape("#0055AA"), {
        width: 210,
        height: 40,
        transform: "matrix(1 0 0 1 80 10)",
      });
      const source = await exported();
      assert.equal(source.nodes.fill.width, 50);
      assert.deepEqual(source.nodes.fill.transform, [1, 0, 0, 1, 90, 80]);
    },
  );
  await check(
    "source settings undo/redo and fill min/max constraints",
    async () => {
      await enter("최대 너비", 140);
      assert.equal((await shape("#0055AA")).width, 140);
      await btn("실행 취소").click();
      assert.equal((await shape("#0055AA")).width, 210);
      await btn("다시 실행").click();
      assert.equal((await shape("#0055AA")).width, 140);
      await enter("최소 너비", 180);
      assert.match(await page.getByRole("alert").last().textContent(), /최소/);
      assert.equal((await exported()).nodes.fill.layout.minWidth, undefined);
      await enter("최대 너비", "");
      assert.equal((await shape("#0055AA")).width, 210);
    },
  );
  await check(
    "computed hit testing selects flow box; manual transforms preserve source",
    async () => {
      const rect = await page
        .locator('.renderer-surface svg rect[fill="#0055AA"]')
        .boundingBox();
      assert.ok(rect);
      await page.mouse.click(rect.x + 20, rect.y + 20);
      assert.equal(await label("레이어 이름").inputValue(), "fill");
      assert.equal(await label("X").isDisabled(), true);
      assert.equal(await label("W").isDisabled(), true);
      const before = await exported();
      await page
        .getByTestId("canvas-stage")
        .click({ position: { x: 5, y: 5 } });
      await choose("fill");
      await page.keyboard.press("ArrowRight");
      assert.deepEqual((await exported()).nodes.fill, before.nodes.fill);
    },
  );
  await check(
    "absolute child keeps offsets and excludes flow; changing to flow reflows",
    async () => {
      await choose("overlay");
      assert.equal(
        (await shape("#00AA55")).transform,
        "matrix(1 0 0 1 230 110)",
      );
      assert.equal(await label("X").isDisabled(), false);
      await label("Flex 자식 배치").selectOption("flow");
      assert.equal((await shape("#0055AA")).width, 185);
      await label("Flex 자식 배치").selectOption("absolute");
      assert.equal((await shape("#0055AA")).width, 210);
    },
  );
  await check(
    "wrap, column direction, hug height and fixed source width edits",
    async () => {
      await choose("flex-frame");
      await label("Flex 방향").selectOption("column");
      await label("높이 방식").selectOption("hug");
      assert.equal((await shape("#EEEEEE")).height, 100);
      await label("Flex 방향").selectOption("row");
      await label("Flex 줄바꿈").check();
      await enter("W", 100);
      assert.equal((await shape("#EEEEEE")).width, 100);
      await label("Flex 줄바꿈").uncheck();
      await enter("W", 300);
      await label("높이 방식").selectOption("fixed");
    },
  );
  await check(
    "SVG/PNG export uses computed geometry without changing JSON rules",
    async () => {
      await btn("내보내기").click();
      const svg = (await download("SVG 벡터 파일")).toString();
      assert.match(svg, /width="210" height="40"/);
      assert.match(svg, /matrix\(1 0 0 1 80 10\)/);
      await btn("내보내기").click();
      const png = await download("PNG 이미지 (2x)");
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      assert.equal((await exported()).nodes.fill.width, 50);
    },
  );
  await check(
    "CanvasKit shares geometry, then autosave/reload retains source layout",
    async () => {
      await label("렌더러 선택").selectOption("canvaskit");
      await page.locator(".renderer-surface canvas").waitFor();
      await page.waitForTimeout(600);
      assert.deepEqual(errors, []);
      await label("렌더러 선택").selectOption("svg");
      await page.waitForTimeout(200);
      const before = await exported();
      await page.waitForTimeout(1300);
      await page.reload({ waitUntil: "networkidle" });
      await choose("fill");
      assert.deepEqual((await exported()).nodes.fill, before.nodes.fill);
      assert.equal((await shape("#0055AA")).width, 210);
    },
  );
  assert.deepEqual(errors, []);
  await choose("flex-frame");
  await page.getByTestId("layout-inspector").scrollIntoViewIfNeeded();
  if (process.env.FLEX_SCREENSHOT)
    await page.screenshot({ path: process.env.FLEX_SCREENSHOT });
  const report = {
    url,
    browser: browser.version(),
    passed: checks.length,
    checks,
    errors,
  };
  await fs.writeFile(
    process.env.FLEX_UI_REPORT || artifactPath("143-l01-flex-browser.json"),
    JSON.stringify(report, null, 2),
  );
} catch (error) {
  console.error({ checks, errors, failure: String(error) });
  throw error;
} finally {
  await browser.close();
}
