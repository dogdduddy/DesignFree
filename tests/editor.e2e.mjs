import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
const base = new URL(process.env.EDITOR_URL || "http://127.0.0.1:5173/");
const out = artifactPath();
const artifacts = artifactPath("editor-qa/");
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
let page;
const errors = [],
  requests = [],
  checks = [];

function worldMatrix(doc, id) {
  const n = doc.nodes[id],
    b = n.transform;
  if (!n.parentId) return b;
  const a = worldMatrix(doc, n.parentId);
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
const state = () => page.evaluate(() => window.__draftroom.getState());
async function fresh() {
  if (page) await page.context().close();
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (
      !r.url().startsWith(base.origin) &&
      !r.url().startsWith("data:") &&
      !r.url().startsWith("blob:" + base.origin + "/")
    )
      requests.push(r.url());
  });
  await page.goto(base.href, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      window.__draftroom &&
      document.querySelector(".renderer-surface svg text"),
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-testid="save-status"]');
    return s && s.getAttribute("data-state") !== "loading";
  });
}
async function check(name, fn) {
  const start = Date.now();
  try {
    await fn();
    checks.push({ name, status: "passed", durationMs: Date.now() - start });
    console.log("PASS " + name);
  } catch (e) {
    checks.push({
      name,
      status: "failed",
      error: String(e),
      durationMs: Date.now() - start,
    });
    console.log("FAIL " + name + " " + e);
    await page.screenshot({
      path: path.join(artifacts, "failed-" + checks.length + ".png"),
    });
  }
}
async function draw(kind = "사각형 도구") {
  await page.getByRole("button", { name: kind, exact: true }).click();
  const r = await page.getByTestId("canvas-stage").boundingBox();
  await page.mouse.move(r.x + 400, r.y + 320);
  await page.mouse.down();
  await page.mouse.move(r.x + 520, r.y + 400, { steps: 6 });
  await page.mouse.up();
  const s = await state();
  assert.equal(s.selection.length, 1);
  return s.selection[0];
}
async function saveJson() {
  const d = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
  const download = await d;
  const target = path.join(artifacts, "document.json");
  await download.saveAs(target);
  return JSON.parse(await fs.readFile(target, "utf8"));
}
try {
  await check(
    "load original demo with local font and zero initial errors",
    async () => {
      await fresh();
      const s = await state();
      assert.equal(s.document.schemaVersion, 1);
      assert.equal(s.document.nodes[s.document.rootId].children.length, 2);
      assert(
        await page.evaluate(() => document.fonts.check('16px "Noto Sans KR"')),
      );
      await page.screenshot({
        path: path.join(out, "04-editor-preview.png"),
        fullPage: true,
      });
    },
  );
  await check(
    "create rectangle, drag one undo, redo, Escape cancellation",
    async () => {
      await fresh();
      const id = await draw();
      let s = await state(),
        n = s.document.nodes[id],
        t = [...n.transform],
        v = s.viewport;
      const r = await page.getByTestId("canvas-stage").boundingBox();
      let x = r.x + (t[4] + n.width / 2) * v.zoom + v.x,
        y = r.y + (t[5] + n.height / 2) * v.zoom + v.y;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 60, y + 30, { steps: 8 });
      await page.mouse.up();
      const movedState = await state();
      let moved = movedState.document.nodes[id].transform;
      // A drop can reparent; movement is measured in world coordinates.
      const movedWorld = worldMatrix(movedState.document, id);
      assert(Math.abs(movedWorld[4] - t[4] - 60 / v.zoom) < 0.01);
      await page
        .getByRole("button", { name: "실행 취소", exact: true })
        .click();
      assert.deepEqual((await state()).document.nodes[id].transform, t);
      await page
        .getByRole("button", { name: "다시 실행", exact: true })
        .click();
      assert.deepEqual((await state()).document.nodes[id].transform, moved);
      s = await state();
      n = s.document.nodes[id];
      x += 60;
      y += 30;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 35, y + 25, { steps: 4 });
      await page.keyboard.press("Escape");
      await page.mouse.up();
      assert.deepEqual((await state()).document.nodes[id].transform, moved);
    },
  );
  await check(
    "Undo removal clears stale selection before delete/arrows/duplicate",
    async () => {
      await fresh();
      const id = await draw();
      await page
        .getByRole("button", { name: "실행 취소", exact: true })
        .click();
      assert.equal((await state()).document.nodes[id], undefined);
      assert.deepEqual((await state()).selection, []);
      await page.keyboard.press("Delete");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Meta+d");
      assert.equal(Object.keys((await state()).document.nodes).length, 32);
    },
  );
  await check("resize by handle and inspector geometry", async () => {
    await fresh();
    const id = await draw();
    const before = (await state()).document.nodes[id];
    const handle = page.getByRole("button", {
      name: "오른쪽 아래 크기 조절",
      exact: true,
    });
    const h = await handle.boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + 40, h.y + h.height / 2 + 20, {
      steps: 4,
    });
    await page.mouse.up();
    const after = (await state()).document.nodes[id];
    assert(after.width > before.width + 20);
    await page.getByRole("spinbutton", { name: "W", exact: true }).fill("215");
    await page.getByRole("spinbutton", { name: "W", exact: true }).press("Tab");
    assert.equal((await state()).document.nodes[id].width, 215);
  });
  await check("layer multi-select moves sibling frames once", async () => {
    await fresh();
    let s = await state();
    const ids = s.document.nodes[s.document.rootId].children;
    await page.getByTestId("layer-" + ids[0]).click();
    await page.getByTestId("layer-" + ids[1]).click({ modifiers: ["Shift"] });
    assert.equal((await state()).selection.length, 2);
    await page.keyboard.press("Shift+ArrowRight");
    s = await state();
    for (const id of ids)
      assert.equal(
        s.document.nodes[id].transform[4],
        id === ids[0] ? 130 : 560,
      );
  });
  await check(
    "locked parent prevents descendant keyboard and inspector changes",
    async () => {
      await fresh();
      let s = await state();
      const parent =
          s.document.nodes[s.document.nodes[s.document.rootId].children[0]],
        child = s.document.nodes[parent.children[0]];
      await page.getByTestId("layer-" + parent.id).hover();
      await page
        .getByRole("button", { name: parent.name + " 잠금", exact: true })
        .click();
      await page.getByTestId("layer-" + child.id).click();
      assert(
        await page
          .getByRole("spinbutton", { name: "X", exact: true })
          .isDisabled(),
      );
      await page.keyboard.press("Delete");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Meta+d");
      s = await state();
      assert.deepEqual(s.document.nodes[child.id], child);
    },
  );
  await check(
    "buffered HEX rejects intermediate invalid input without changing document",
    async () => {
      await fresh();
      const id = await draw();
      const original = (await state()).document.nodes[id].fill;
      const hex = page.getByRole("textbox", {
        name: "채우기 HEX",
        exact: true,
      });
      await hex.fill("#NOPE");
      await hex.press("Tab");
      assert.deepEqual((await state()).document.nodes[id].fill, original);
      await hex.fill("#112233");
      await hex.press("Enter");
      assert.deepEqual((await state()).document.nodes[id].fill, {
        type: "solid",
        color: "#112233",
      });
      await hex.fill("#445566");
      await hex.press("Escape");
      assert.deepEqual((await state()).document.nodes[id].fill, {
        type: "solid",
        color: "#112233",
      });
      await page
        .getByRole("button", { name: "실행 취소", exact: true })
        .click();
      assert.deepEqual((await state()).document.nodes[id].fill, original);
    },
  );
  await check(
    "multiline Korean text edit, composition guards, commit and cancel",
    async () => {
      await fresh();
      let s = await state();
      const text = Object.values(s.document.nodes).find(
        (n) => n.type === "text" && n.name === "Welcome back.",
      );
      assert(text);
      await page.getByTestId("layer-" + text.id).dblclick();
      const area = page.getByRole("textbox", {
        name: "텍스트 직접 편집",
        exact: true,
      });
      await area.waitFor();
      assert.equal(
        await area.evaluate((el) => getComputedStyle(el).lineHeight),
        text.text.lineHeight + "px",
      );
      await area.dispatchEvent("compositionstart");
      await area.fill("로그인하고 계속하기\n다음 줄");
      await area.dispatchEvent("keydown", {
        key: "Backspace",
        code: "Backspace",
        isComposing: true,
      });
      assert((await state()).document.nodes[text.id]);
      await area.dispatchEvent("compositionend");
      await area.press("Meta+Enter");
      assert.equal(
        (await state()).document.nodes[text.id].text.content,
        "로그인하고 계속하기\n다음 줄",
      );
      await page.getByTestId("layer-" + text.id).dblclick();
      await area.fill("취소할 변경");
      await area.press("Escape");
      assert.equal(
        (await state()).document.nodes[text.id].text.content,
        "로그인하고 계속하기\n다음 줄",
      );
    },
  );
  await check(
    "JSON download/import roundtrip and invalid import keeps current work",
    async () => {
      await fresh();
      await draw();
      const saved = await saveJson();
      const input = page.locator(
        'input[type=file][accept*="application/json"]',
      );
      const broken = structuredClone(saved);
      broken.schemaVersion = 2;
      await input.setInputFiles({
        name: "bad.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(broken)),
      });
      await page
        .getByRole("status")
        .filter({ hasText: "불러오기 실패" })
        .waitFor();
      assert.deepEqual((await state()).document, saved);
      await input.setInputFiles({
        name: "saved.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(saved)),
      });
      await page
        .getByRole("status")
        .filter({ hasText: "문서를 불러왔습니다" })
        .waitFor();
      assert.deepEqual((await state()).document, saved);
    },
  );
  await check(
    "PNG upload survives both renderers and exports SVG/PNG",
    async () => {
      await fresh();
      let s = await state();
      const tile = Object.values(s.document.assets)[0];
      await page.locator('input[type=file][accept="image/png"]').setInputFiles({
        name: "own-tile.png",
        mimeType: "image/png",
        buffer: Buffer.from(tile.dataUrl.split(",")[1], "base64"),
      });
      await page
        .getByRole("status")
        .filter({ hasText: "PNG 이미지를 추가" })
        .waitFor();
      s = await state();
      const id = s.selection[0];
      assert.equal(s.document.nodes[id].type, "image");
      assert.equal(s.document.nodes[id].fill.type, "none");
      await page
        .getByRole("combobox", { name: "렌더러 선택", exact: true })
        .selectOption("canvaskit");
      await page
        .locator(".renderer-surface canvas")
        .waitFor({ timeout: 30000 });
      await page.waitForTimeout(1200);
      assert.equal(await page.getByRole("alert").count(), 0);
      await page.screenshot({
        path: path.join(out, "06-editor-canvaskit.png"),
        fullPage: true,
      });
      await page
        .getByRole("combobox", { name: "렌더러 선택", exact: true })
        .selectOption("svg");
      await page.locator(".renderer-surface svg text").first().waitFor();
      for (const kind of ["SVG 벡터 파일", "PNG 이미지 (2x)"]) {
        await page
          .getByRole("button", { name: "내보내기", exact: true })
          .click();
        const waiting = page.waitForEvent("download");
        await page.getByRole("button", { name: kind, exact: true }).click();
        const d = await waiting;
        const file = path.join(artifacts, d.suggestedFilename());
        await d.saveAs(file);
        const data = await fs.readFile(file);
        if (kind.startsWith("PNG")) {
          assert.equal(data.subarray(1, 4).toString(), "PNG");
          assert(data.length > 10000);
        } else {
          assert(data.toString().includes("<svg"));
          assert(data.toString().includes("data:image/png;base64"));
          assert(!data.toString().includes("<script"));
        }
      }
    },
  );
  await check("pan, pointer anchored zoom, responsive workspace", async () => {
    await fresh();
    const before = (await state()).viewport;
    const box = await page.getByTestId("canvas-stage").boundingBox();
    await page.keyboard.down("Space");
    await page.mouse.move(box.x + 400, box.y + 400);
    await page.mouse.down();
    await page.mouse.move(box.x + 450, box.y + 430, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    const after = (await state()).viewport;
    assert(Math.abs(after.x - before.x - 50) < 0.01);
    assert(Math.abs(after.y - before.y - 30) < 0.01);
    await page.getByRole("button", { name: "확대", exact: true }).click();
    assert((await state()).viewport.zoom > after.zoom);
    await page.setViewportSize({ width: 980, height: 760 });
    await page.screenshot({
      path: path.join(artifacts, "narrow.png"),
      fullPage: true,
    });
    assert((await page.getByTestId("canvas-stage").boundingBox()).width > 300);
  });
  await check(
    "no browser runtime errors or external runtime requests",
    async () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(requests, []);
    },
  );
} finally {
  const report = {
    date: new Date().toISOString(),
    scope: "T0 browser prototype; no backend persistence",
    browser: browser.version(),
    viewport: { width: 1440, height: 1000, dpr: 1 },
    checks,
    errors,
    externalRuntimeRequests: requests,
    nativeIme:
      "Synthetic composition events only; physical Korean IME not exercised",
    notVerified: [
      "server save/recovery/PostgreSQL",
      "real Figma behavior equivalence",
      "automatic wrapping and font weight parity",
      "multiplayer",
    ],
  };
  await fs.writeFile(
    path.join(out, "05-editor-validation.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
  const failed = checks.filter((c) => c.status === "failed");
  console.log(
    JSON.stringify({
      passed: checks.length - failed.length,
      failed: failed.length,
      report: path.join(out, "05-editor-validation.json"),
    }),
  );
  if (failed.length) process.exitCode = 1;
}
