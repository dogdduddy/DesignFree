import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const btn = (name) => page.getByRole("button", { name, exact: true });
const input = (name) => page.getByLabel(name, { exact: true });
async function download(name) {
  const pending = page.waitForEvent("download");
  await btn(name).click();
  const chunks = [];
  for await (const c of await (await pending).createReadStream())
    chunks.push(c);
  await page.waitForTimeout(200);
  return Buffer.concat(chunks);
}
const exported = async () =>
  JSON.parse((await download("JSON 저장")).toString());
const get = async () => (await exported()).nodes["paint-test"];
async function imported(doc) {
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles({
      name: "paint.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
  await page.waitForTimeout(350);
}
async function enter(label, value) {
  if (process.env.PAINT_DEBUG)
    console.log("BEFORE", label, await input(label).inputValue());
  await input(label).fill(String(value));
  if (process.env.PAINT_DEBUG)
    console.log("FILLED", label, await input(label).inputValue());
  await input(label).press("Enter");
  if (process.env.PAINT_DEBUG)
    console.log("AFTER", label, await input(label).inputValue());
}
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
}
const undo = async () => btn("실행 취소").click();
try {
  await page.goto(process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/", {
    waitUntil: "networkidle",
  });
  const source = await exported();
  const root = structuredClone(source.nodes[source.rootId]);
  const sample = structuredClone(
    Object.values(source.nodes).find((n) => n.type === "rectangle"),
  );
  root.children = ["paint-test"];
  root.width = 700;
  root.height = 500;
  const fixture = {
    ...source,
    nodes: {
      [root.id]: root,
      "paint-test": {
        ...sample,
        id: "paint-test",
        name: "Paint test",
        parentId: root.id,
        children: [],
        transform: [1, 0, 0, 1, 80, 80],
        width: 220,
        height: 140,
        fill: { type: "solid", color: "#AA3300" },
        stroke: undefined,
      },
    },
  };
  await imported(fixture);
  await page.getByTestId("layer-paint-test").locator(".layer-name").click();
  await check("legacy fill color, HEX cancel and alpha editing", async () => {
    await input("채우기 HEX").fill("#112233");
    await input("채우기 HEX").press("Escape");
    assert.equal((await get()).fill.color, "#AA3300");
    await enter("채우기 HEX", "#FF000080");
    assert.equal((await get()).fills[0].color, "#FF000080");
    assert.equal(await input("채우기 색상").inputValue(), "#ff0000");
    await enter("채우기 1 불투명도", 150);
    assert.equal(await input("채우기 1 불투명도").inputValue(), "100");
    await enter("채우기 1 불투명도", 60);
    assert.equal((await get()).fills[0].opacity, 0.6);
  });
  await check(
    "multiple fill addition, ordering, deletion and Undo",
    async () => {
      await btn("채우기 추가").click();
      await enter("채우기 2 HEX", "#0000FF");
      await btn("채우기 2 아래로").click();
      assert.equal((await get()).fills[0].color, "#0000FF");
      await btn("채우기 2 삭제").click();
      assert.equal((await get()).fills.length, 1);
      await undo();
      assert.equal((await get()).fills.length, 2);
    },
  );
  await check("linear gradient geometry and sorted stop edits", async () => {
    await input("채우기 2 유형").selectOption("linear");
    await enter("채우기 2 to X", 80);
    await btn("채우기 2 stop 추가").click();
    await enter("Stop 2.2 위치", 75);
    await enter("채우기 2 stop 2 HEX", "#00FF00");
    await enter("Stop 2.2 불투명도", 35);
    const p = (await get()).fills[1];
    assert.equal(p.type, "linear");
    assert.equal(p.to[0], 0.8);
    assert.deepEqual(
      p.stops.map((s) => s.offset),
      [0, 0.75, 1],
    );
    assert.equal(p.stops[1].opacity, 0.35);
    await btn("Stop 2.2 삭제").click();
    assert.equal((await get()).fills[1].stops.length, 2);
  });
  await check(
    "radial center and radius points, paint and node opacity",
    async () => {
      await input("채우기 2 유형").selectOption("radial");
      await enter("채우기 2 from X", 30);
      await enter("채우기 2 to Y", 80);
      await enter("채우기 2 불투명도", 45);
      await input("불투명도").fill("70");
      await input("불투명도").press("Tab");
      const n = await get();
      assert.equal(n.fills[1].type, "radial");
      assert.deepEqual(n.fills[1].from, [0.3, 0.5]);
      assert.deepEqual(n.fills[1].to, [1, 0.8]);
      assert.equal(n.fills[1].opacity, 0.45);
      assert.equal(n.opacity, 0.7);
      assert.equal(
        await page.locator(".renderer-surface radialGradient").count(),
        1,
      );
    },
  );
  await check(
    "stroke width, alignment, alpha, odd dashes and invalid input",
    async () => {
      await btn("테두리 추가").click();
      await enter("테두리 두께", 12);
      await enter("테두리 HEX", "#2200FF80");
      await enter("테두리 불투명도", 75);
      await input("테두리 위치").selectOption("outside");
      await enter("테두리 점선", "8 4 2");
      let s = (await get()).stroke;
      assert.equal(s.width, 12);
      assert.equal(s.position, "outside");
      assert.deepEqual(s.dash, [8, 4, 2]);
      assert.equal(s.opacity, 0.75);
      await enter("테두리 점선", "0 -1");
      assert(await page.getByRole("alert").isVisible());
      assert.deepEqual((await get()).stroke.dash, [8, 4, 2]);
      await enter("테두리 점선", "6 3");
      await input("테두리 위치").selectOption("inside");
      assert.equal((await get()).stroke.position, "inside");
    },
  );
  await check("stroke edit one Undo and Redo", async () => {
    await enter("테두리 두께", 24);
    await undo();
    assert.equal((await get()).stroke.width, 12);
    await btn("다시 실행").click();
    assert.equal((await get()).stroke.width, 24);
  });
  await check(
    "JSON and SVG export include paint stack, stops and stroke",
    async () => {
      const before = await exported();
      await imported(before);
      await page.getByTestId("layer-paint-test").locator(".layer-name").click();
      assert.deepEqual(await exported(), before);
      await btn("내보내기").click();
      const svg = (await download("SVG 벡터 파일")).toString();
      assert.match(svg, /<radialGradient/);
      assert.match(svg, /stroke-dasharray="6 3"/);
      assert.match(svg, /stroke-clip/);
      assert.match(svg, /fill-opacity="0.45"/);
    },
  );
  await check("edited paint PNG download uses requested scale", async () => {
    await btn("내보내기").click();
    await input("PNG 배율").selectOption("1");
    const png = await download("PNG 이미지 (1x)");
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), 700);
    assert.equal(png.readUInt32BE(20), 500);
  });
  await check(
    "CanvasKit renders edited stack and stroke without errors",
    async () => {
      await input("렌더러 선택").selectOption("canvaskit");
      await page.locator(".renderer-surface canvas").waitFor();
      await page.waitForTimeout(500);
      assert.equal(
        await page.getByText("렌더러 오류", { exact: true }).count(),
        0,
      );
      await input("렌더러 선택").selectOption("svg");
      await page
        .locator(".renderer-surface svg radialGradient")
        .waitFor({ state: "attached" });
    },
  );
  await check("committed paints recover after cold reload", async () => {
    const before = await exported();
    await page.waitForTimeout(700);
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(await exported(), before);
    await page.getByTestId("layer-paint-test").locator(".layer-name").click();
  });
  await check("locked node disables paint and stroke editing", async () => {
    const doc = await exported();
    doc.nodes["paint-test"].locked = true;
    await imported(doc);
    await page.getByTestId("layer-paint-test").locator(".layer-name").click();
    assert(await btn("채우기 추가").isDisabled());
    assert(await input("테두리 두께").isDisabled());
    doc.nodes["paint-test"].locked = false;
    await imported(doc);
    await page.getByTestId("layer-paint-test").locator(".layer-name").click();
  });
  assert.deepEqual(errors, []);
  if (process.env.PAINT_SCREENSHOT) {
    await input("테두리 위치").scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.PAINT_SCREENSHOT });
  }
  if (process.env.PAINT_REPORT)
    await fs.writeFile(
      process.env.PAINT_REPORT,
      JSON.stringify(
        {
          url: process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/",
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
