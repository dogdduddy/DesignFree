import { serverTestUrl, browserLaunchOptions } from "./browser-helpers.mjs";
import { authenticatedTestSession } from "./auth-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const url = serverTestUrl();
const auth = await authenticatedTestSession(url);
const browser = await chromium.launch(browserLaunchOptions());
const context = await browser.newContext({
  storageState: auth.storageState,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage(),
  checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (dialog) => dialog.accept());
const endpoint = new URL("/api/library/current", url).href;
const load = async () => {
  const r = await auth.fetch(endpoint);
  assert.equal(r.status, 200);
  return r.json();
};
const put = (body) =>
  auth.fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const version = (record) => record?.version ?? 0;
const ready = () =>
  page.waitForFunction(() =>
    ["saved", "idle"].includes(
      document.querySelector('[data-testid="save-status"]')?.dataset.state,
    ),
  );
const saved = () =>
  page.waitForFunction(
    () =>
      document.querySelector('[data-testid="save-status"]')?.dataset.state ===
      "saved",
  );
const button = (name) => page.getByRole("button", { name, exact: true });
async function snapshot() {
  const downloading = page.waitForEvent("download");
  await button("JSON 저장").click();
  const chunks = [];
  for await (const chunk of await (await downloading).createReadStream())
    chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function rename(name) {
  if ((await page.locator(".document-library").getAttribute("open")) === null)
    await page.locator(".document-library summary").click();
  await page
    .getByRole("textbox", { name: "문서 이름", exact: true })
    .fill(name);
  await button("이름 변경").click();
}
async function check(name, run) {
  await run();
  checks.push(name);
  console.log("PASS " + name);
}
try {
  await page.goto(url, { waitUntil: "networkidle" });
  await ready();
  assert.match(
    await page.getByTestId("save-status").getAttribute("title"),
    /서버/,
  );
  const baseline = await load();
  let body, firstAck;
  await check(
    "native document save stores every page and restores in a fresh browser context",
    async () => {
      await rename("H01 PostgreSQL document");
      await button("페이지 추가").click();
      await saved();
      const doc = await snapshot();
      const record = await load();
      assert.deepEqual(record.document, doc);
      assert.ok(record.document.pageIds.length >= 2);
      assert.ok(record.version > version(baseline));
      const second = await browser.newContext({
        storageState: auth.storageState,
      });
      try {
        const p = await second.newPage();
        await p.goto(url, { waitUntil: "networkidle" });
        assert.equal(
          await p.locator(".document-title").innerText(),
          "H01 PostgreSQL document\nT0",
        );
        assert.equal(
          await p.getByTestId("save-status").getAttribute("data-state"),
          "saved",
        );
      } finally {
        await second.close();
      }
    },
  );
  await check(
    "native canvas edit, Undo and Redo persist the acknowledged document",
    async () => {
      if (
        (await page.locator(".document-library").getAttribute("open")) !== null
      )
        await page.locator(".document-library summary").click();
      const before = await snapshot();
      await button("사각형 도구").click();
      const box = await page.getByTestId("canvas-stage").boundingBox();
      await page.mouse.move(box.x + 300, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + 410, box.y + 270);
      await page.mouse.up();
      await button("선택 도구").click();
      await saved();
      const edited = await snapshot();
      assert.equal(
        Object.keys(edited.nodes).length,
        Object.keys(before.nodes).length + 1,
      );
      assert.deepEqual((await load()).document, edited);
      await button("실행 취소").click();
      await saved();
      assert.deepEqual((await load()).document, before);
      await button("다시 실행").click();
      await saved();
      assert.deepEqual((await load()).document, edited);
    },
  );
  await check(
    "document switching atomically persists active and inactive library entries",
    async () => {
      const before = await snapshot();
      if (
        (await page.locator(".document-library").getAttribute("open")) === null
      )
        await page.locator(".document-library summary").click();
      await button("새 문서").click();
      await saved();
      const blank = await snapshot();
      assert.notEqual(blank.id, before.id);
      assert.ok((await load()).documents.some((d) => d.id === before.id));
      if (
        (await page.locator(".document-library").getAttribute("open")) === null
      )
        await page.locator(".document-library summary").click();
      await page
        .getByLabel("로컬 문서", { exact: true })
        .selectOption(before.id);
      await saved();
      const restored = await load();
      assert.deepEqual(restored.document, before);
      assert.ok(restored.documents.some((d) => d.id === blank.id));
    },
  );
  await check(
    "same-operation retry returns original ACK; different payload and stale version cannot overwrite",
    async () => {
      const record = await load();
      body = {
        operationId: crypto.randomUUID(),
        expectedVersion: record.version,
        document: record.document,
        documents: record.documents,
      };
      const response = await put(body);
      assert.equal(response.status, 200);
      firstAck = await response.json();
      assert.equal(firstAck.version, record.version + 1);
      const retry = await put(body);
      assert.equal(retry.status, 200);
      assert.deepEqual(await retry.json(), firstAck);
      assert.equal(
        (
          await put({
            ...body,
            document: { ...body.document, name: "must reject" },
          })
        ).status,
        422,
      );
      assert.equal(
        (await put({ ...body, expectedVersion: firstAck.version })).status,
        422,
      );
      assert.equal(
        (await put({ ...body, operationId: crypto.randomUUID() })).status,
        409,
      );
      assert.equal((await load()).document.name, body.document.name);
      assert.equal((await load()).version, firstAck.version);
    },
  );
  await check(
    "two simultaneous writers at one expectedVersion commit exactly once",
    async () => {
      const current = await load();
      const base = { ...body, expectedVersion: current.version };
      const responses = await Promise.all([
        put({
          ...base,
          operationId: crypto.randomUUID(),
          document: { ...base.document, name: "writer A" },
        }),
        put({
          ...base,
          operationId: crypto.randomUUID(),
          document: { ...base.document, name: "writer B" },
        }),
      ]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      assert.equal((await load()).version, current.version + 1);
      // Old retry remains valid even after another operation advanced the library.
      assert.deepEqual(await (await put(body)).json(), firstAck);
    },
  );
  await check(
    "concurrent duplicate operations share one committed version",
    async () => {
      const current = await load();
      const duplicate = {
        ...body,
        operationId: crypto.randomUUID(),
        expectedVersion: current.version,
      };
      const responses = await Promise.all([
        put(duplicate),
        put(duplicate),
        put(duplicate),
        put(duplicate),
      ]);
      assert.ok(responses.every((r) => r.status === 200));
      const acks = await Promise.all(responses.map((r) => r.json()));
      for (const ack of acks) assert.deepEqual(ack, acks[0]);
      assert.equal((await load()).version, current.version + 1);
    },
  );
  await check(
    "invalid document and cross-site requests leave the committed library intact",
    async () => {
      const before = await load();
      assert.equal(
        (
          await put({
            ...body,
            operationId: crypto.randomUUID(),
            expectedVersion: before.version,
            document: {},
          })
        ).status,
        400,
      );
      const denied = await auth.fetch(endpoint, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify(body),
      });
      assert.equal(denied.status, 403);
      const wrongType = await auth.fetch(endpoint, {
        method: "PUT",
        body: "{}",
      });
      assert.equal(wrongType.status, 415);
      assert.deepEqual(await load(), before);
    },
  );
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  await check(
    "lost ACK after real PostgreSQL commit retries identical bytes without duplicate application",
    async () => {
      const before = await load();
      let lostBody, retryBody, reached;
      const lost = new Promise((resolve) => {
        reached = resolve;
      });
      let first = true;
      await page.route("**/api/library/current", async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        if (first) {
          first = false;
          lostBody = route.request().postData();
          const committed = await route.fetch();
          assert.equal(committed.status(), 200);
          // Confirm through an independent read, then cut the response path.
          assert.equal((await load()).version, before.version + 1);
          await route.abort("connectionreset");
          reached();
        } else {
          retryBody = route.request().postData();
          await route.continue();
        }
      });
      await rename("ACK lost but committed");
      await lost;
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-status"]')?.dataset
            .state === "error",
      );
      await button("저장 재시도").click();
      await saved();
      assert.equal(lostBody, retryBody);
      assert.equal((await load()).version, before.version + 1);
      assert.equal((await load()).document.name, "ACK lost but committed");
      await page.unroute("**/api/library/current");
    },
  );
  await check(
    "stale browser blocks autosave and preserves its current work for JSON backup",
    async () => {
      const current = await load();
      const external = {
        ...body,
        operationId: crypto.randomUUID(),
        expectedVersion: current.version,
        document: { ...current.document, name: "external newer" },
        documents: current.documents,
      };
      assert.equal((await put(external)).status, 200);
      await rename("local stale work");
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-status"]')?.dataset
            .state === "conflict",
      );
      assert.equal((await snapshot()).name, "local stale work");
      assert.equal((await load()).document.name, "external newer");
      assert.equal(await button("저장 재시도").count(), 0);
      await button("서버 버전 사용").click();
      await saved();
      assert.equal((await snapshot()).name, "external newer");
    },
  );
  await check(
    "GET failure blocks saving instead of overwriting an unread server record",
    async () => {
      const before = await load();
      await page.route("**/api/library/current", (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: "{}",
        }),
      );
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-status"]')?.dataset
            .state === "error",
      );
      assert.deepEqual(await load(), before);
      await page.unroute("**/api/library/current");
    },
  );
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  if (process.env.SERVER_SCREENSHOT)
    await page.screenshot({ path: process.env.SERVER_SCREENSHOT });
  assert.deepEqual(errors, []);
  if (process.env.SERVER_REPORT)
    await fs.writeFile(
      process.env.SERVER_REPORT,
      JSON.stringify(
        {
          date: new Date().toISOString(),
          url,
          browser: browser.version(),
          passed: checks.length,
          checks,
          pageErrors: errors,
          finalVersion: (await load()).version,
        },
        null,
        2,
      ) + "\n",
    );
} finally {
  await browser.close();
}
