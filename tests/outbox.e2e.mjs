import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  serverTestUrl,
  browserLaunchOptions,
  artifactPath,
} from "./browser-helpers.mjs";
import { authenticatedTestSession } from "./auth-helpers.mjs";
const url = serverTestUrl();
const auth = await authenticatedTestSession(url);
const browser = await chromium.launch(browserLaunchOptions());
const context = await browser.newContext({
  storageState: auth.storageState,
  viewport: { width: 1440, height: 1000 },
});
context.setDefaultTimeout(15000);
let page = await context.newPage();
const errors = [],
  checks = [];
const attach = () => {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
};
attach();
const endpoint = new URL("/api/library/current", url).href;
const load = async () => (await auth.fetch(endpoint)).json();
const button = (name) => page.getByRole("button", { name, exact: true });
const state = async (name) =>
  page.waitForFunction(
    (name) =>
      document.querySelector('[data-testid="save-status"]')?.dataset.state ===
      name,
    name,
  );
const ready = () =>
  page.waitForFunction(() =>
    ["saved", "idle"].includes(
      document.querySelector('[data-testid="save-status"]')?.dataset.state,
    ),
  );
const journal = () =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("draftroom-server-outbox", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("requests"),
            read = tx.objectStore("requests").get("current");
          read.onsuccess = () =>
            resolve(read.result ? JSON.parse(read.result) : null);
          tx.oncomplete = () => db.close();
        };
      }),
  );
async function rename(name) {
  if ((await page.locator(".document-library").getAttribute("open")) === null)
    await page.locator(".document-library summary").click();
  await page
    .getByRole("textbox", { name: "문서 이름", exact: true })
    .fill(name);
  await button("이름 변경").click();
}
async function backup() {
  const waiting = page.waitForEvent("download");
  await button("로컬 복구본 JSON 백업").click();
  const chunks = [];
  for await (const chunk of await (await waiting).createReadStream())
    chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function check(name, run) {
  await run();
  checks.push(name);
  console.log(`PASS ${name}`);
}
try {
  await page.goto(url, { waitUntil: "networkidle" });
  await ready();
  await rename("S05 baseline");
  await state("saved");
  await button("새 문서").click();
  await state("saved");
  await check(
    "commit then lost response survives tab close, byte-identical replay does not duplicate commit",
    async () => {
      const before = await load();
      let body;
      await context.route("**/api/library/current", async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        body = route.request().postData();
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort("connectionreset");
      });
      await rename("S05 committed lost ACK");
      await state("error");
      assert.equal((await journal()).body, body);
      assert.equal((await load()).version, before.version + 1);
      await page.close();
      await context.unroute("**/api/library/current");
      let replay;
      await context.route("**/api/library/current", (route) => {
        if (route.request().method() === "PUT")
          replay = route.request().postData();
        return route.continue();
      });
      page = await context.newPage();
      attach();
      await page.goto(url, { waitUntil: "networkidle" });
      await ready();
      assert.equal(replay, body);
      assert.equal((await load()).version, before.version + 1);
      assert.equal(await journal(), null);
      await context.unroute("**/api/library/current");
    },
  );
  await check(
    "offline request and latest later edit survive reload and explicit retry",
    async () => {
      const before = await load();
      await context.route("**/api/library/current", (route) =>
        route.abort("internetdisconnected"),
      );
      await rename("S05 offline");
      await state("error");
      const first = (await journal()).body;
      await page.reload({ waitUntil: "networkidle" });
      await state("error");
      assert.match(
        await page.locator(".document-title").innerText(),
        /S05 offline/,
      );
      // A real canvas edit while recovery is paused must also reach the journal.
      await button("사각형 도구").click();
      const box = await page.getByTestId("canvas-stage").boundingBox();
      await page.mouse.move(box.x + 250, box.y + 180);
      await page.mouse.down();
      await page.mouse.move(box.x + 350, box.y + 250);
      await page.mouse.up();
      await page.waitForTimeout(350);
      const local = await backup();
      assert.ok(local.documents.length > 0);
      assert.deepEqual((await journal()).latest, local);
      assert.equal((await journal()).body, first);
      await page.reload({ waitUntil: "networkidle" });
      await state("error");
      assert.deepEqual(await backup(), local);
      await context.unroute("**/api/library/current");
      await button("저장 재시도").click();
      await page.waitForFunction(() =>
        document
          .querySelector(".document-title")
          ?.textContent?.includes("S05 offline"),
      );
      await state("saved");
      assert.deepEqual((await load()).document, local.document);
      assert.equal((await load()).version, before.version + 2);
      assert.equal(await journal(), null);
    },
  );
  await check(
    "stale conflict reload preserves local library, cancel keeps it, failed server read cannot discard it",
    async () => {
      const before = await load();
      const response = await auth.fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedVersion: before.version,
          document: { ...before.document, name: "S05 external" },
          documents: before.documents,
        }),
      });
      assert.equal(response.status, 200);
      await rename("S05 conflict local");
      await state("conflict");
      const local = await backup();
      await page.reload({ waitUntil: "networkidle" });
      await state("conflict");
      assert.deepEqual(await backup(), local);
      page.removeAllListeners("dialog");
      page.once("dialog", (d) => d.dismiss());
      await button("서버 버전 사용").click();
      await state("conflict");
      assert.ok(await journal());
      page.on("dialog", (d) => d.accept());
      await context.route("**/api/library/current", (route) =>
        route.request().method() === "GET"
          ? route.abort("internetdisconnected")
          : route.continue(),
      );
      await button("서버 버전 사용").click();
      await state("error");
      assert.deepEqual((await journal()).latest, local);
      await context.unroute("**/api/library/current");
      await button("서버 버전 사용").click();
      await state("saved");
      assert.match(
        await page.locator(".document-title").innerText(),
        /S05 external/,
      );
      assert.equal((await load()).version, before.version + 1);
      assert.equal(await journal(), null);
      // Recovery library is accepted by the normal import control.
      await page
        .locator('input[accept="application/json,.json"]')
        .setInputFiles({
          name: "recovery.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(local)),
        });
      await page.waitForFunction(() =>
        document
          .querySelector(".document-title")
          ?.textContent?.includes("S05 conflict local"),
      );
      await state("saved");
      assert.deepEqual((await load()).document, local.document);
    },
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: artifactPath("s05-outbox.png") });
  await fs.writeFile(
    artifactPath("s05-outbox.json"),
    JSON.stringify({ browser: browser.version(), checks, errors }, null, 2),
  );
} finally {
  await browser.close();
}
