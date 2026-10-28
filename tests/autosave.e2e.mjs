import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

const browser = await chromium.launch(browserLaunchOptions());
const url = "http://127.0.0.1:5173/";
const state = (p) => p.evaluate(() => window.__draftroom.getState());
const status = (p, value) =>
  p.waitForFunction(
    (value) =>
      document.querySelector('[data-testid="save-status"]')?.dataset.state ===
      value,
    value,
  );
const ready = (p) =>
  p.waitForFunction(
    () =>
      window.__draftroom &&
      document.querySelector('[data-testid="save-status"]')?.dataset.state !==
        "loading",
  );
const stored = (p) =>
  p.evaluate(async () =>
    (await import("/src/local-draft-storage.ts")).loadLocalDraft(),
  );
async function open(context) {
  const p = await context.newPage();
  p.on("dialog", (d) => d.accept());
  await p.goto(url);
  await ready(p);
  return p;
}
async function draw(p) {
  await p.getByRole("button", { name: "사각형 도구", exact: true }).click();
  const b = await p.getByTestId("canvas-stage").boundingBox();
  await p.mouse.move(b.x + 400, b.y + 300);
  await p.mouse.down();
  await p.mouse.move(b.x + 500, b.y + 360);
  await p.mouse.up();
  return (await state(p)).selection[0];
}
async function test(name, run) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  try {
    await run(context);
    console.log("PASS " + name);
  } finally {
    await context.close();
  }
}
try {
  await test("demo is unwritten; committed edit recovers on reload and new page with empty history", async (c) => {
    const p = await open(c);
    assert.equal(await stored(p), null);
    await p.waitForTimeout(400);
    assert.equal(await stored(p), null);
    const id = await draw(p);
    await status(p, "saved");
    const document = (await state(p)).document;
    assert.deepEqual((await stored(p)).document, document);
    await p.reload();
    await ready(p);
    assert.deepEqual((await state(p)).document, document);
    assert.deepEqual((await state(p)).selection, []);
    assert(
      await p
        .getByRole("button", { name: "실행 취소", exact: true })
        .isDisabled(),
    );
    const second = await open(c);
    assert.deepEqual((await state(second)).document, document);
    assert((await state(second)).document.nodes[id]);
  });
  await test("undo/redo and rapid latest edits persist; canceled preview does not", async (c) => {
    const p = await open(c);
    const id = await draw(p);
    await status(p, "saved");
    const revision = (await stored(p)).revision;
    await p.getByRole("button", { name: "실행 취소", exact: true }).click();
    await status(p, "saved");
    assert(!(await stored(p)).document.nodes[id]);
    await p.getByRole("button", { name: "다시 실행", exact: true }).click();
    await status(p, "saved");
    assert((await stored(p)).document.nodes[id]);
    await p.getByTestId("layer-" + id).click();
    await p
      .getByRole("textbox", { name: "레이어 이름", exact: true })
      .fill("latest committed name");
    await status(p, "saved");
    assert.equal(
      (await stored(p)).document.nodes[id].name,
      "latest committed name",
    );
    const before = await stored(p);
    await p.getByRole("button", { name: "사각형 도구", exact: true }).click();
    const b = await p.getByTestId("canvas-stage").boundingBox();
    await p.mouse.move(b.x + 600, b.y + 300);
    await p.mouse.down();
    await p.mouse.move(b.x + 680, b.y + 380);
    await p.waitForTimeout(450);
    assert.deepEqual(await stored(p), before);
    await p.keyboard.press("Escape");
    await p.mouse.up();
    await p.waitForTimeout(350);
    assert.deepEqual(await stored(p), before);
    assert(before.revision > revision);
  });
  await test("import and embedded PNG survive latest save order and recovery", async (c) => {
    const p = await open(c);
    await draw(p);
    await status(p, "saved");
    const document = (await state(p)).document;
    document.name = "Imported persisted document";
    await p
      .locator('input[accept*="application/json"]')
      .setInputFiles({
        name: "import.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(document)),
      });
    await p
      .getByRole("status")
      .filter({ hasText: "문서를 불러왔습니다" })
      .waitFor();
    const asset = Object.values(document.assets)[0];
    await p
      .locator('input[accept="image/png"]')
      .setInputFiles({
        name: "retained.png",
        mimeType: "image/png",
        buffer: Buffer.from(asset.dataUrl.split(",")[1], "base64"),
      });
    await p
      .getByRole("status")
      .filter({ hasText: "PNG 이미지를 추가" })
      .waitFor();
    await status(p, "saved");
    const latest = (await state(p)).document;
    assert.equal(latest.name, document.name);
    assert.equal(
      Object.keys(latest.assets).length,
      Object.keys(document.assets).length + 1,
    );
    assert.deepEqual((await stored(p)).document, latest);
    await p.reload();
    await ready(p);
    assert.deepEqual((await state(p)).document, latest);
  });
  await test("stale tab detects conflict and retains unsaved work without overwriting winner", async (c) => {
    const p = await open(c);
    const q = await open(c);
    await draw(p);
    await status(p, "saved");
    const winner = await stored(p);
    const id = await draw(q);
    await status(q, "conflict");
    assert((await state(q)).document.nodes[id]);
    assert.deepEqual(await stored(p), winner);
    await q.keyboard.press("ArrowRight");
    await q.waitForTimeout(350);
    assert.deepEqual(await stored(p), winner);
    assert(
      await q
        .getByRole("button", { name: "JSON 저장", exact: true })
        .isEnabled(),
    );
  });
  await test("quota failure preserves prior record and memory; explicit retry saves latest", async (c) => {
    const p = await open(c);
    await draw(p);
    await status(p, "saved");
    const before = await stored(p);
    await p.evaluate(() => {
      window.__originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () {
        throw new DOMException("Test quota", "QuotaExceededError");
      };
    });
    const id = await draw(p);
    await status(p, "error");
    assert((await state(p)).document.nodes[id]);
    assert.deepEqual(await stored(p), before);
    await p.evaluate(() => {
      IDBObjectStore.prototype.put = window.__originalPut;
    });
    await p.getByRole("button", { name: "저장 재시도", exact: true }).click();
    await status(p, "saved");
    assert.deepEqual((await stored(p)).document, (await state(p)).document);
  });
  await test("corrupt record is preserved after read error and later local edit", async (c) => {
    const p = await open(c);
    await p.evaluate(async () => {
      const d = await new Promise((resolve, reject) => {
        const r = indexedDB.open("draftroom-local-drafts", 1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      await new Promise((resolve, reject) => {
        const t = d.transaction("drafts", "readwrite");
        t.objectStore("drafts").put(
          { invalid: "keep original bytes" },
          "current",
        );
        t.oncomplete = resolve;
        t.onabort = reject;
      });
      d.close();
    });
    await p.reload();
    await ready(p);
    await status(p, "error");
    await draw(p);
    await p.waitForTimeout(350);
    const raw = await p.evaluate(async () => {
      const d = await new Promise((resolve) => {
        const r = indexedDB.open("draftroom-local-drafts", 1);
        r.onsuccess = () => resolve(r.result);
      });
      const value = await new Promise((resolve) => {
        const r = d.transaction("drafts").objectStore("drafts").get("current");
        r.onsuccess = () => resolve(r.result);
      });
      d.close();
      return value;
    });
    assert.deepEqual(raw, { invalid: "keep original bytes" });
    assert(
      await p
        .getByRole("button", { name: "JSON 저장", exact: true })
        .isEnabled(),
    );
  });
  await test("unavailable storage unlocks memory editing with error, no automatic retry", async (c) => {
    await c.addInitScript(() => {
      indexedDB.open = () => {
        throw new DOMException("Blocked in test", "SecurityError");
      };
    });
    const p = await open(c);
    await status(p, "error");
    const id = await draw(p);
    assert((await state(p)).document.nodes[id]);
    assert.equal(
      await p.getByRole("button", { name: "저장 재시도", exact: true }).count(),
      0,
    );
  });
  await test("delayed bootstrap gates input and StrictMode does not replace restored work or write defaults", async (c) => {
    const p = await open(c);
    await draw(p);
    await status(p, "saved");
    const before = await stored(p);
    await c.addInitScript(() => {
      const original = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => {
        const request = original(...args);
        Object.defineProperty(request, "onsuccess", {
          set(handler) {
            request.addEventListener("success", (event) =>
              setTimeout(() => handler.call(request, event), 500),
            );
          },
        });
        return request;
      };
    });
    const q = await c.newPage();
    await q.goto(url);
    await status(q, "loading");
    assert(await q.locator(".workspace").evaluate((el) => el.inert));
    await q.keyboard.press("r");
    await q.keyboard.press("ArrowRight");
    await ready(q);
    assert.deepEqual((await state(q)).document, before.document);
    await q.waitForTimeout(400);
    assert.deepEqual(await stored(p), before);
    const id = await draw(q);
    await status(q, "saved");
    assert((await stored(p)).document.nodes[id]);
  });
  await test("edits during an in-flight write remain pending and newest snapshot wins", async (c) => {
    const p = await open(c);
    await p.evaluate(() => {
      const original = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => {
        const request = original(...args);
        Object.defineProperty(request, "onsuccess", {
          set(handler) {
            request.addEventListener("success", (event) =>
              setTimeout(() => handler.call(request, event), 500),
            );
          },
        });
        return request;
      };
    });
    const id = await draw(p);
    await p.waitForTimeout(300);
    await p
      .getByRole("textbox", { name: "레이어 이름", exact: true })
      .fill("queued latest snapshot");
    await status(p, "saved");
    const record = await stored(p);
    assert.equal(record.document.nodes[id].name, "queued latest snapshot");
    assert.deepEqual(record.document, (await state(p)).document);
    assert.equal(record.revision, 2);
  });
  await test("uncommitted text warns on unload, does not autosave; cancel and saved commit clear warning", async (c) => {
    const p = await open(c);
    await draw(p);
    await status(p, "saved");
    const before = await stored(p);
    const text = Object.values(before.document.nodes).find(
      (n) => n.type === "text" && n.name === "Welcome back.",
    );
    const warned = () =>
      p.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
    await p.getByTestId("layer-" + text.id).dblclick();
    const field = p.getByRole("textbox", {
      name: "텍스트 직접 편집",
      exact: true,
    });
    await field.fill("uncommitted Korean 한글");
    await status(p, "editing");
    assert.equal(await warned(), true);
    await p.waitForTimeout(350);
    assert.deepEqual(await stored(p), before);
    await field.press("Escape");
    await status(p, "saved");
    assert.equal(await warned(), false);
    await p.getByTestId("layer-" + text.id).dblclick();
    await field.fill("committed Korean 한글");
    await field.press("Meta+Enter");
    await status(p, "saved");
    assert.equal(await warned(), false);
    assert.equal(
      (await stored(p)).document.nodes[text.id].text.content,
      "committed Korean 한글",
    );
  });
  await test("async import cancels a newly started pointer preview before replacing history", async (c) => {
    const p = await open(c),
      errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    const document = (await state(p)).document;
    document.name = "Async imported scene";
    await p.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = function () {
        return original
          .call(this)
          .then(
            (value) =>
              new Promise((resolve) => setTimeout(() => resolve(value), 500)),
          );
      };
    });
    await p
      .locator('input[accept*="application/json"]')
      .setInputFiles({
        name: "async.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(document)),
      });
    await p.getByRole("button", { name: "사각형 도구", exact: true }).click();
    const b = await p.getByTestId("canvas-stage").boundingBox();
    await p.mouse.move(b.x + 400, b.y + 300);
    await p.mouse.down();
    await p.mouse.move(b.x + 470, b.y + 340);
    await p
      .getByRole("status")
      .filter({ hasText: "문서를 불러왔습니다" })
      .waitFor();
    await p.mouse.move(b.x + 490, b.y + 350);
    await p.mouse.up();
    await status(p, "saved");
    assert.deepEqual((await state(p)).document, document);
    assert.deepEqual((await stored(p)).document, document);
    assert.deepEqual(errors, []);
  });
} finally {
  await browser.close();
}
