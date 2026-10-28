import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const browser = await chromium.launch(browserLaunchOptions());
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage(),
  checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const btn = (name) => page.getByRole("button", { name, exact: true });
async function exported() {
  const pending = page.waitForEvent("download");
  await btn("JSON 저장").click();
  const chunks = [];
  for await (const c of await (await pending).createReadStream())
    chunks.push(c);
  // Pace repeated native downloads to avoid Chromium rapid-download throttling.
  await page.waitForTimeout(150);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function imported(doc) {
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles({
      name: "text.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
  await page.waitForTimeout(400);
}
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
};
const select = async () =>
  page.getByTestId("layer-text-test").locator(".layer-name").click();
const get = async () => (await exported()).nodes["text-test"];
try {
  await page.goto(process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/", {
    waitUntil: "networkidle",
  });
  const source = await exported(),
    root = structuredClone(source.nodes[source.rootId]);
  const sample = structuredClone(
    Object.values(source.nodes).find((n) => n.text),
  );
  root.children = ["text-test"];
  root.width = 800;
  root.height = 600;
  const fixture = {
    ...source,
    nodes: {
      [root.id]: root,
      "text-test": {
        ...sample,
        id: "text-test",
        name: "text-test",
        parentId: root.id,
        transform: [1, 0, 0, 1, 80, 80],
        width: 100,
        height: 100,
        text: {
          content: "hello world 가나다라\n다음 줄",
          fontFamily: "Missing Test Font",
          fontWeight: 400,
          fontSize: 20,
          lineHeight: 30,
        },
      },
    },
  };
  await imported(fixture);
  await select();
  await check(
    "missing family preserves identity and displays explicit fallback",
    async () => {
      assert.match(
        await page
          .getByRole("status")
          .allTextContents()
          .then((v) => v.join(" ")),
        /누락 글꼴.*Missing Test Font/,
      );
      assert.equal((await get()).text.fontFamily, "Missing Test Font");
      assert.match(
        await page
          .locator(".renderer-surface svg text")
          .getAttribute("font-family"),
        /Noto Sans KR/,
      );
    },
  );
  await check(
    "family and weight selection update rendered SVG and undo",
    async () => {
      await page
        .getByLabel("글꼴 패밀리", { exact: true })
        .selectOption("monospace");
      await page.getByLabel("굵기", { exact: true }).selectOption("700");
      assert.equal((await get()).text.fontWeight, 700);
      assert.equal(
        await page
          .locator(".renderer-surface svg text")
          .getAttribute("font-family"),
        "monospace",
      );
      await btn("실행 취소").click();
      assert.equal((await get()).text.fontWeight, 400);
      await btn("다시 실행").click();
      assert.equal((await get()).text.fontWeight, 700);
    },
  );
  await check("fixed box wraps and preserves dimensions", async () => {
    await page.getByLabel("텍스트 크기 방식").selectOption("fixed");
    const n = await get();
    assert.equal(n.width, 100);
    assert.equal(n.height, 100);
    assert(
      (await page.locator(".renderer-surface svg text tspan").count()) > 2,
    );
  });
  await check(
    "automatic height and width derive geometry with one undo",
    async () => {
      await page.getByLabel("텍스트 크기 방식").selectOption("auto-height");
      const height = await get();
      assert.equal(height.width, 100);
      assert.equal(
        height.height,
        (await page.locator(".renderer-surface svg text tspan").count()) * 30,
      );
      await page.getByLabel("텍스트 크기 방식").selectOption("auto-width");
      const width = await get();
      assert(width.width > 100);
      assert.equal(width.height, 60);
      assert.equal(
        await page.locator(".renderer-surface svg text tspan").count(),
        2,
      );
      await btn("실행 취소").click();
      assert.deepEqual(await get(), height);
      await btn("다시 실행").click();
      assert.deepEqual(await get(), width);
    },
  );
  await check(
    "alignment, line spacing and signed tracking persist and affect positions",
    async () => {
      await page.getByLabel("텍스트 크기 방식").selectOption("auto-height");
      await page.getByLabel("텍스트 정렬").selectOption("right");
      await page.getByLabel("행간 px", { exact: true }).fill("42");
      await page.getByLabel("자간 px", { exact: true }).fill("-1");
      const n = await get();
      assert.equal(n.text.lineHeight, 42);
      assert.equal(n.text.letterSpacing, -1);
      assert.equal(n.text.align, "right");
      const spans = page.locator(".renderer-surface svg text tspan");
      assert.equal(
        Number(await spans.nth(1).getAttribute("y")) -
          Number(await spans.nth(0).getAttribute("y")),
        42,
      );
      assert.equal(
        await page
          .locator(".renderer-surface svg text")
          .getAttribute("letter-spacing"),
        "-1",
      );
      await page.getByLabel("텍스트 정렬").selectOption("center");
      assert.equal((await get()).text.align, "center");
    },
  );
  await check(
    "direct editor uses selected text styles and commits automatic height",
    async () => {
      await page
        .getByTestId("layer-text-test")
        .locator(".layer-name")
        .dblclick();
      const editor = page.getByLabel("텍스트 직접 편집");
      assert.equal(
        await editor.evaluate((e) => getComputedStyle(e).textAlign),
        "center",
      );
      assert.equal(
        await editor.evaluate((e) => getComputedStyle(e).wordBreak),
        "break-all",
      );
      await editor.fill("한글 테스트\n둘째 줄\n셋째 줄");
      await editor.press("Meta+Enter");
      assert.equal((await get()).text.content, "한글 테스트\n둘째 줄\n셋째 줄");
      assert.equal(
        (await get()).height,
        (await page.locator(".renderer-surface svg text tspan").count()) * 42,
      );
    },
  );
  await check(
    "autosave cold reload retains exact text geometry and properties",
    async () => {
      const before = await get();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-status"]').dataset
            .state === "saved",
      );
      await page.reload({ waitUntil: "networkidle" });
      await select();
      assert.deepEqual(await get(), before);
    },
  );
  await check(
    "JSON roundtrip and SVG export include authored properties",
    async () => {
      const before = await exported();
      await imported(before);
      await select();
      assert.deepEqual(await get(), before.nodes["text-test"]);
      const pending = page.waitForEvent("download");
      await btn("내보내기").click();
      await btn("SVG 벡터 파일").click();
      const chunks = [];
      for await (const c of await (await pending).createReadStream())
        chunks.push(c);
      const svg = Buffer.concat(chunks).toString();
      assert.match(svg, /letter-spacing="-1"/);
      assert.match(svg, /font-family="monospace"/);
    },
  );
  await check(
    "manual numeric resize freezes automatic text dimensions and undo restores mode",
    async () => {
      await page.getByLabel("텍스트 크기 방식").selectOption("auto-width");
      const before = await get();
      await page
        .getByRole("spinbutton", { name: "W", exact: true })
        .fill("160");
      assert.equal((await get()).width, 160);
      assert.equal((await get()).text.sizing, "fixed");
      await btn("실행 취소").click();
      assert.deepEqual(await get(), before);
    },
  );
  await check(
    "north handle resize freezes auto-height and preserves opposite edge",
    async () => {
      await page.getByLabel("텍스트 크기 방식").selectOption("auto-height");
      const before = await get();
      const h = await page.getByTestId("resize-n").boundingBox();
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 - 30, {
        steps: 5,
      });
      await page.mouse.up();
      const after = await get();
      assert.equal(after.text.sizing, "fixed");
      assert(after.height > before.height);
      assert(
        Math.abs(
          after.transform[5] +
            after.height -
            before.transform[5] -
            before.height,
        ) < 0.1,
      );
      await btn("실행 취소").click();
      assert.deepEqual(await get(), before);
    },
  );
  await check(
    "experimental CanvasKit renders styled wrapped text and declares font limitations",
    async () => {
      await page.getByLabel("렌더러 선택").selectOption("canvaskit");
      await page.locator(".renderer-surface canvas").waitFor();
      await page.waitForTimeout(500);
      assert.match(
        (await page.getByRole("status").allTextContents()).join(" "),
        /CanvasKit 실험/,
      );
      assert.equal(
        await page.getByText("렌더러 오류", { exact: true }).count(),
        0,
      );
      await page.getByLabel("렌더러 선택").selectOption("svg");
      await page.locator(".renderer-surface svg text").waitFor();
    },
  );
  assert.deepEqual(errors, []);
  if (process.env.TEXT_SCREENSHOT) {
    await page.getByLabel("자간 px", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.TEXT_SCREENSHOT });
  }
  if (process.env.TEXT_REPORT)
    await fs.writeFile(
      process.env.TEXT_REPORT,
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
  console.error(JSON.stringify({ checks, errors, failure: String(error) }));
  if (process.env.TEXT_REPORT)
    await fs.writeFile(
      process.env.TEXT_REPORT + ".failure.json",
      JSON.stringify({ checks, errors, failure: String(error) }, null, 2),
    );
  throw error;
} finally {
  await browser.close();
}
