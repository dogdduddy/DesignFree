import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { authenticatedTestSession } from "./auth-helpers.mjs";
const browser = await chromium.launch(browserLaunchOptions());
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const auth =
  process.env.GRID_SERVER === "1" ? await authenticatedTestSession(url) : null;
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
  root.children = ["grid-frame"];
  root.width = 900;
  root.height = 600;
  const sample = structuredClone(
    Object.values(demo.nodes).find((n) => n.type === "rectangle") ?? {
      ...root,
      type: "rectangle",
    },
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
    ...node("grid-frame", root.id, 300, 160, "#EEEEEE"),
    type: "frame",
    transform: [1, 0, 0, 1, 50, 50],
    children: ["fixed", "fill", "overlay"],
  };
  const fixture = {
    ...demo,
    schemaVersion: 1,
    pageIds: undefined,
    id: "grid-ui-fixture",
    name: "Grid UI fixture",
    nodes: {
      [root.id]: root,
      "grid-frame": frame,
      fixed: node("fixed", "grid-frame", 60, 30, "#AA3300"),
      fill: node("fill", "grid-frame", 50, 40, "#0055AA"),
      overlay: {
        ...node("overlay", "grid-frame", 15, 15, "#00AA55"),
        transform: [1, 0, 0, 1, 230, 110],
        layout: { mode: "absolute", position: "absolute" },
      },
    },
    assets: {},
  };
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles({
      name: "grid.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
  await page.waitForTimeout(400);
  await check(
    "configure Grid tracks, fractions and separate source geometry",
    async () => {
      await choose("grid-frame");
      await label("레이아웃 모드").selectOption("grid");
      await enter("Grid 열 트랙", "60px 1fr");
      await enter("Grid 행 트랙", "40px 50px");
      await enter("Grid 간격", 10);
      await choose("fill");
      await label("너비 방식").selectOption("fill");
      await label("높이 방식").selectOption("fill");
      assert.deepEqual(await shape("#0055AA"), {
        width: 230,
        height: 40,
        transform: "matrix(1 0 0 1 70 0)",
      });
      const source = await exported();
      assert.equal(source.nodes.fill.width, 50);
      assert.deepEqual(source.nodes.fill.transform, [1, 0, 0, 1, 90, 80]);
      assert.deepEqual(source.nodes["grid-frame"].layout.grid.columns, [
        60,
        { fr: 1 },
      ]);
    },
  );
  await check("named area and span edits have one-step Undo/Redo", async () => {
    await choose("grid-frame");
    await enter("Grid 영역 행 (; 구분)", "head head; nav main");
    await choose("fill");
    await enter("Grid 영역 이름", "head");
    assert.deepEqual(await shape("#0055AA"), {
      width: 300,
      height: 40,
      transform: "matrix(1 0 0 1 0 0)",
    });
    await btn("실행 취소").click();
    assert.equal((await shape("#0055AA")).width, 230);
    await btn("다시 실행").click();
    assert.equal((await shape("#0055AA")).width, 300);
    await enter("Grid 영역 이름", "");
    await enter("Grid 열 시작선", 1);
    await enter("Grid 행 시작선", 2);
    await enter("Grid 열 span", 2);
    assert.deepEqual(await shape("#0055AA"), {
      width: 300,
      height: 50,
      transform: "matrix(1 0 0 1 0 50)",
    });
  });
  await check(
    "rejects invalid tracks, nonrectangular areas and invalid spans",
    async () => {
      const before = await exported();
      await enter("Grid 열 span", 0);
      assert.ok(await page.getByRole("alert").last().isVisible());
      assert.deepEqual((await exported()).nodes.fill, before.nodes.fill);
      await choose("grid-frame");
      await enter("Grid 열 트랙", "0fr");
      assert.ok(await page.getByRole("alert").last().isVisible());
      assert.deepEqual(
        (await exported()).nodes["grid-frame"],
        before.nodes["grid-frame"],
      );
      await enter("Grid 영역 행 (; 구분)", "head head; head .");
      assert.deepEqual(
        (await exported()).nodes["grid-frame"],
        before.nodes["grid-frame"],
      );
      await enter("Grid 열 트랙", "60px 1fr");
    },
  );
  await check(
    "computed hit testing, manual transform guard and absolute child",
    async () => {
      const rect = await page
        .locator('.renderer-surface svg rect[fill="#0055AA"]')
        .boundingBox();
      await page.mouse.click(rect.x + 20, rect.y + 20);
      assert.equal(await label("레이어 이름").inputValue(), "fill");
      assert.equal(await label("X").isDisabled(), true);
      assert.equal(await label("W").isDisabled(), true);
      const before = await exported();
      await page.keyboard.press("ArrowRight");
      assert.deepEqual((await exported()).nodes.fill, before.nodes.fill);
      await choose("overlay");
      assert.equal(
        (await shape("#00AA55")).transform,
        "matrix(1 0 0 1 230 110)",
      );
      assert.equal(await label("X").isDisabled(), false);
      await label("Grid 자식 배치").selectOption("flow");
      assert.equal((await shape("#00AA55")).transform, "matrix(1 0 0 1 70 0)");
      await label("Grid 자식 배치").selectOption("absolute");
    },
  );
  await check(
    "auto tracks, implicit rows and padding reflow through inspector",
    async () => {
      await choose("grid-frame");
      await enter("Grid 열 트랙", "auto 1fr");
      await enter("Grid 자동 행", "30px");
      await enter("Grid 안쪽 여백 왼쪽", 10);
      await enter("Grid 안쪽 여백 위", 5);
      assert.equal((await shape("#0055AA")).transform, "matrix(1 0 0 1 10 55)");
      await enter("Grid 열 트랙", "60px 1fr");
      await enter("Grid 안쪽 여백 왼쪽", 0);
      await enter("Grid 안쪽 여백 위", 0);
    },
  );
  await check(
    "SVG/PNG export and renderer switch use computed Grid geometry",
    async () => {
      await btn("내보내기").click();
      const svg = (await download("SVG 벡터 파일")).toString();
      assert.match(svg, /width="300" height="50"/);
      assert.match(svg, /matrix\(1 0 0 1 0 50\)/);
      await btn("내보내기").click();
      const png = await download("PNG 이미지 (2x)");
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      await label("렌더러 선택").selectOption("canvaskit");
      await page.locator(".renderer-surface canvas").waitFor();
      await page.waitForTimeout(600);
      await label("렌더러 선택").selectOption("svg");
      assert.equal((await shape("#0055AA")).width, 300);
    },
  );
  await check(
    "autosave/reload retains authored rules and deterministic geometry",
    async () => {
      const before = await exported();
      await page.waitForTimeout(1300);
      await page.reload({ waitUntil: "networkidle" });
      await choose("fill");
      assert.deepEqual((await exported()).nodes.fill, before.nodes.fill);
      assert.deepEqual(await shape("#0055AA"), {
        width: 300,
        height: 50,
        transform: "matrix(1 0 0 1 0 50)",
      });
    },
  );
  assert.deepEqual(errors, []);
  await choose("grid-frame");
  await page.getByTestId("layout-inspector").scrollIntoViewIfNeeded();
  if (process.env.GRID_SCREENSHOT)
    await page.screenshot({ path: process.env.GRID_SCREENSHOT });
  await fs.writeFile(
    process.env.GRID_UI_REPORT || artifactPath("165-l02-grid-browser.json"),
    JSON.stringify(
      {
        url,
        browser: browser.version(),
        passed: checks.length,
        checks,
        errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error({ checks, errors, failure: String(error) });
  throw error;
} finally {
  await browser.close();
}
