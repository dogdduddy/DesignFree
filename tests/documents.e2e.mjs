import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const browser = await chromium.launch(browserLaunchOptions());
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage(),
  checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
const button = (name) => page.getByRole("button", { name, exact: true });
const ready = () =>
  page.waitForFunction(
    () =>
      document.querySelector('[data-testid="save-status"]')?.dataset.state !==
      "loading",
  );
const saved = () =>
  page.waitForFunction(
    () =>
      document.querySelector('[data-testid="save-status"]')?.dataset.state ===
      "saved",
  );
const library = async () => {
  if ((await page.locator(".document-library").getAttribute("open")) === null)
    await page.locator(".document-library summary").click();
};
async function snapshot() {
  const pending = page.waitForEvent("download");
  await button("JSON 저장").click();
  const chunks = [];
  for await (const chunk of await (await pending).createReadStream())
    chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function draw() {
  await button("사각형 도구").click();
  const box = await page.getByTestId("canvas-stage").boundingBox();
  await page.mouse.move(box.x + 300, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + 260);
  await page.mouse.up();
  await button("선택 도구").click();
}
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
}
try {
  await page.goto(url, { waitUntil: "networkidle" });
  await ready();
  const demo = await snapshot();
  let a, b, copy, firstPage, secondPage, layer;
  await check("create blank local document and rename", async () => {
    await library();
    await button("새 문서").click();
    await page
      .getByRole("textbox", { name: "문서 이름", exact: true })
      .fill("Document A");
    await button("이름 변경").click();
    await saved();
    a = await snapshot();
    firstPage = a.rootId;
    assert.equal(a.name, "Document A");
    assert.equal(Object.keys(a.nodes).length, 1);
    assert.equal(
      await page
        .getByLabel("로컬 문서", { exact: true })
        .locator("option")
        .count(),
      2,
    );
  });
  await check(
    "multiple page tabs isolate layers, preserve Undo and clipboard",
    async () => {
      await page.locator(".document-library summary").click();
      await draw();
      a = await snapshot();
      layer = a.nodes[a.rootId].children[0];
      await page.getByTestId("layer-" + layer).click();
      await page.keyboard.press("Meta+c");
      await button("페이지 추가").click();
      b = await snapshot();
      secondPage = b.rootId;
      assert.equal(b.schemaVersion, 2);
      assert.equal(b.pageIds.length, 2);
      assert.equal(await page.locator(".layer.selected").count(), 0);
      assert.equal(await page.getByTestId("layer-" + layer).count(), 0);
      await page.keyboard.press("Meta+v");
      await page.waitForTimeout(250);
      b = await snapshot();
      assert.equal(b.nodes[secondPage].children.length, 1);
      assert.deepEqual(b.nodes[firstPage].children, [layer]);
      await button("실행 취소").click();
      assert.equal((await snapshot()).nodes[secondPage].children.length, 0);
      await button("다시 실행").click();
      await page.getByLabel("페이지 이름", { exact: true }).fill("Details");
      await button("변경").click();
      await page
        .getByRole("tab", { name: a.nodes[firstPage].name, exact: true })
        .click();
      assert.equal((await snapshot()).rootId, firstPage);
      assert.equal(await page.getByTestId("layer-" + layer).count(), 1);
      await page.getByRole("tab", { name: "Details", exact: true }).click();
      await saved();
      b = await snapshot();
    },
  );
  await check(
    "duplicate preserves every page with detached document identity",
    async () => {
      await library();
      await button("문서 복제").click();
      await saved();
      copy = await snapshot();
      assert.notEqual(copy.id, b.id);
      assert.deepEqual(copy.nodes, b.nodes);
      assert.deepEqual(copy.assets, b.assets);
      await page
        .getByLabel("페이지 이름", { exact: true })
        .fill("Copy details");
      await button("변경").click();
      await library();
      await page.getByLabel("로컬 문서", { exact: true }).selectOption(b.id);
      assert.deepEqual((await snapshot()).nodes, b.nodes);
    },
  );
  await check(
    "rapid document switches before debounce retain newest edits and reload",
    async () => {
      await library();
      await page.getByLabel("문서 이름", { exact: true }).fill("Newest A");
      await button("이름 변경").click();
      await page.getByLabel("로컬 문서", { exact: true }).selectOption(copy.id);
      await page.getByLabel("로컬 문서", { exact: true }).selectOption(b.id);
      await saved();
      assert.equal((await snapshot()).name, "Newest A");
      await page.reload();
      await ready();
      const restored = await snapshot();
      assert.equal(restored.name, "Newest A");
      assert.equal(restored.rootId, secondPage);
      assert.deepEqual(restored.nodes, b.nodes);
      await library();
      assert.equal(
        await page
          .getByLabel("로컬 문서", { exact: true })
          .locator("option")
          .count(),
        3,
      );
      b = restored;
    },
  );
  await check(
    "library changes during an in-flight save retain all documents",
    async () => {
      await library();
      await page.evaluate(() => {
        const original = indexedDB.open.bind(indexedDB);
        indexedDB.open = (...args) => {
          const request = original(...args);
          Object.defineProperty(request, "onsuccess", {
            set(handler) {
              request.addEventListener("success", (event) =>
                setTimeout(() => handler.call(request, event), 700),
              );
            },
          });
          return request;
        };
      });
      await page
        .getByLabel("문서 이름", { exact: true })
        .fill("Delayed writer A");
      await button("이름 변경").click();
      await page.waitForTimeout(300);
      await page.getByLabel("로컬 문서", { exact: true }).selectOption(copy.id);
      await page
        .getByLabel("문서 이름", { exact: true })
        .fill("Queued writer copy");
      await button("이름 변경").click();
      await page.getByLabel("로컬 문서", { exact: true }).selectOption(b.id);
      await saved();
      await page.reload();
      await ready();
      await library();
      assert.equal(
        await page
          .getByLabel("로컬 문서", { exact: true })
          .locator("option")
          .count(),
        3,
      );
      assert.equal(
        await page.getByLabel("문서 이름", { exact: true }).inputValue(),
        "Delayed writer A",
      );
      await page.getByLabel("로컬 문서", { exact: true }).selectOption(copy.id);
      assert.equal(
        await page.getByLabel("문서 이름", { exact: true }).inputValue(),
        "Queued writer copy",
      );
      await page.getByLabel("로컬 문서", { exact: true }).selectOption(b.id);
      await saved();
    },
  );
  await check(
    "delete page supports Undo, deletion clears foreign-page selection",
    async () => {
      if (
        (await page.locator(".document-library").getAttribute("open")) !== null
      )
        await page.locator(".document-library summary").click();
      await button("페이지 삭제").click();
      assert.equal((await snapshot()).rootId, firstPage);
      await page.getByTestId("layer-" + layer).click();
      await button("실행 취소").click();
      assert.equal((await snapshot()).rootId, secondPage);
      assert.equal(await page.locator(".layer.selected").count(), 0);
      await button("다시 실행").click();
      assert.equal((await snapshot()).pageIds.length, 1);
      assert(await button("페이지 삭제").isDisabled());
    },
  );
  await check(
    "delete active and final documents persists without resurrection",
    async () => {
      await library();
      await button("문서 삭제").click();
      assert.equal(
        await page
          .getByLabel("로컬 문서", { exact: true })
          .locator("option")
          .count(),
        2,
      );
      await button("문서 삭제").click();
      await button("문서 삭제").click();
      await saved();
      const blank = await snapshot();
      assert.equal(blank.name, "Untitled");
      assert.equal(Object.keys(blank.nodes).length, 1);
      await page.reload();
      await ready();
      await library();
      assert.equal(
        await page
          .getByLabel("로컬 문서", { exact: true })
          .locator("option")
          .count(),
        1,
      );
      assert.equal((await snapshot()).id, blank.id);
    },
  );
  await check(
    "late PNG decode is discarded after adding a different page",
    async () => {
      await page.locator(".document-library summary").click();
      await page.evaluate(() => {
        const decode = HTMLImageElement.prototype.decode;
        HTMLImageElement.prototype.decode = async function () {
          await decode.call(this);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        };
      });
      const asset = Object.values(demo.assets)[0];
      await page.locator('input[accept="image/png"]').setInputFiles({
        name: "late.png",
        mimeType: "image/png",
        buffer: Buffer.from(asset.dataUrl.split(",")[1], "base64"),
      });
      await button("페이지 추가").click();
      await page.waitForTimeout(1300);
      await saved();
      const result = await snapshot();
      assert.equal(result.pageIds.length, 2);
      assert.deepEqual(result.assets, {});
      assert.equal(Object.keys(result.nodes).length, 2);
    },
  );
  await check(
    "legacy v1 IndexedDB recovery migrates on next write without losing nodes/assets",
    async () => {
      const legacyContext = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      const p = await legacyContext.newPage();
      await p.route("**/seed-f01", (r) =>
        r.fulfill({ contentType: "text/html", body: "seed" }),
      );
      await p.goto(new URL("seed-f01", url).href);
      await p.evaluate(async (document) => {
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open("draftroom-local-drafts", 1);
          r.onupgradeneeded = () => r.result.createObjectStore("drafts");
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction("drafts", "readwrite");
          tx.objectStore("drafts").put(
            {
              version: 1,
              revision: 7,
              updatedAt: new Date().toISOString(),
              document,
            },
            "current",
          );
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
        });
        db.close();
      }, demo);
      await p.goto(url);
      await p.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-status"]')?.dataset
            .state === "saved",
      );
      assert.equal(await p.getByRole("tab").count(), 1);
      await p.getByRole("button", { name: "페이지 추가", exact: true }).click();
      await p.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-status"]')?.dataset
            .state === "saved",
      );
      await p.reload();
      await p.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-status"]')?.dataset
            .state === "saved",
      );
      assert.equal(await p.getByRole("tab").count(), 2);
      const record = await p.evaluate(async () => {
        const db = await new Promise((resolve) => {
          const r = indexedDB.open("draftroom-local-drafts", 1);
          r.onsuccess = () => resolve(r.result);
        });
        return await new Promise((resolve) => {
          const tx = db.transaction("drafts");
          const r = tx.objectStore("drafts").get("current");
          tx.oncomplete = () => {
            db.close();
            resolve(r.result);
          };
        });
      });
      assert.equal(record.version, 2);
      assert.equal(record.revision, 8);
      for (const [id, node] of Object.entries(demo.nodes))
        assert.deepEqual(record.document.nodes[id], node);
      assert.deepEqual(record.document.assets, demo.assets);
      assert.deepEqual(record.documents, []);
      await legacyContext.close();
    },
  );
  assert.deepEqual(errors, []);
  if (process.env.DOCUMENTS_SCREENSHOT)
    await page.screenshot({ path: process.env.DOCUMENTS_SCREENSHOT });
} finally {
  const report = {
    date: new Date().toISOString(),
    url,
    passed: checks.length,
    checks,
    errors,
  };
  if (process.env.DOCUMENTS_REPORT)
    await fs.writeFile(
      process.env.DOCUMENTS_REPORT,
      JSON.stringify(report, null, 2) + "\n",
    );
  await browser.close();
}
