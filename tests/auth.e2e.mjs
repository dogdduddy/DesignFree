import { serverTestUrl, browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

const url = serverTestUrl();
const initial = await (await fetch(new URL("/api/auth/status", url))).json();
const suppliedCredentials =
  process.env.DRAFTROOM_TEST_USERNAME && process.env.DRAFTROOM_TEST_PASSWORD;
assert.ok(
  !initial.initialized || suppliedCredentials,
  "Use a fresh isolated instance or supply the existing test owner credentials",
);
const username = process.env.DRAFTROOM_TEST_USERNAME || "h03-owner";
const password =
  process.env.DRAFTROOM_TEST_PASSWORD || `H03-test-${randomUUID()}`;
const browser = await chromium.launch(browserLaunchOptions());
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const api = (path, options) => fetch(new URL(path, url), options);
const json = (body, headers = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const check = async (name, run) => {
  await run();
  checks.push(name);
  console.log("PASS " + name);
};
const form = async (target, action, suppliedPassword = password) => {
  await target.getByLabel("사용자 이름", { exact: true }).fill(username);
  await target.getByLabel("비밀번호", { exact: true }).fill(suppliedPassword);
  await target.getByRole("button", { name: action, exact: true }).click();
};
const ready = (target) =>
  target.waitForFunction(() =>
    ["saved", "idle"].includes(
      document.querySelector('[data-testid="save-status"]')?.dataset.state,
    ),
  );
let second;
try {
  await check(
    "anonymous library reads, writes, asset reads and cleanup require a session",
    async () => {
      for (const [path, options] of [
        ["/api/library/current"],
        ["/api/library/current", { ...json({}), method: "PUT" }],
        ["/api/documents/unknown/assets/unknown"],
        ["/api/assets/cleanup", { method: "POST" }],
      ])
        assert.equal((await api(path, options)).status, 401, path);
      assert.equal(initial.authenticated, false);
    },
  );
  await page.goto(url, { waitUntil: "networkidle" });
  await check(
    initial.initialized
      ? "initialized owner displays login gate"
      : "first run creates owner through the browser and opens the editor",
    async () => {
      assert.equal(await page.getByTestId("canvas-stage").count(), 0);
      if (!initial.initialized) {
        const blocked = await api(
          "/api/auth/setup",
          json(
            { username, password },
            {
              Origin: "https://foreign.invalid",
              "Sec-Fetch-Site": "cross-site",
            },
          ),
        );
        assert.equal(blocked.status, 403);
        assert.equal(
          (await (await api("/api/auth/status")).json()).initialized,
          false,
        );
      }
      await form(page, initial.initialized ? "로그인" : "소유자 만들기");
      await ready(page);
      const status = await context.request.get(
        new URL("/api/auth/status", url).href,
      );
      const data = await status.json();
      assert.equal(data.authenticated, true);
      assert.equal(data.username, username);
      const cookies = await context.cookies();
      const session = cookies.find((c) => c.httpOnly);
      assert.ok(session, "session cookie must be HttpOnly");
      assert.ok(["Strict", "Lax"].includes(session.sameSite));
    },
  );
  await check(
    "owner setup cannot be repeated with or without an existing session",
    async () => {
      assert.equal(
        (await api("/api/auth/setup", json({ username, password }))).status,
        409,
      );
      const r = await context.request.post(
        new URL("/api/auth/setup", url).href,
        { data: { username, password } },
      );
      assert.equal(r.status(), 409);
    },
  );
  await check(
    "reload restores the session without storing credentials or session tokens in browser storage",
    async () => {
      await page.reload({ waitUntil: "networkidle" });
      await ready(page);
      const stored = await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      );
      assert.ok(!stored.includes(password));
      for (const cookie of await context.cookies())
        assert.ok(!stored.includes(cookie.value));
    },
  );
  second = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const other = await second.newPage();
  other.on("pageerror", (e) => errors.push(e.message));
  await other.goto(url, { waitUntil: "networkidle" });
  await check(
    "fresh browser context rejects a wrong password and stays outside the editor",
    async () => {
      const bad = await api(
        "/api/auth/login",
        json({ username, password: `${password}-wrong` }),
      );
      assert.equal(bad.status, 401);
      const rejected = other.waitForResponse(
        (r) =>
          r.url().endsWith("/api/auth/login") &&
          r.request().method() === "POST",
      );
      await form(other, "로그인", `${password}-wrong`);
      assert.equal((await rejected).status(), 401);
      await other
        .getByRole("button", { name: "로그인", exact: true })
        .waitFor();
      assert.equal(await other.getByTestId("canvas-stage").count(), 0);
      assert.equal(
        (
          await second.request
            .get(new URL("/api/auth/status", url).href)
            .then((r) => r.json())
        ).authenticated,
        false,
      );
    },
  );
  await check(
    "independent browser login opens the same server document and receives persisted edits",
    async () => {
      if (
        (await page.locator(".document-library").getAttribute("open")) === null
      )
        await page.locator(".document-library summary").click();
      const name = `H03 shared document ${randomUUID().slice(0, 8)}`;
      await page
        .getByRole("textbox", { name: "문서 이름", exact: true })
        .fill(name);
      await page
        .getByRole("button", { name: "이름 변경", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-status"]')?.dataset
            .state === "saved",
      );
      await form(other, "로그인");
      await ready(other);
      assert.match(
        await other.locator(".document-title").innerText(),
        new RegExp(name),
      );
      const endpoint = new URL("/api/library/current", url).href;
      const a = await context.request.get(endpoint).then((r) => r.json());
      const b = await second.request.get(endpoint).then((r) => r.json());
      assert.deepEqual(a, b);
      if (process.env.AUTH_SCREENSHOT)
        await other.screenshot({ path: process.env.AUTH_SCREENSHOT });
    },
  );
  await check(
    "expired PUT locks shortcuts, retains the in-memory document, and saves after login and explicit retry",
    async () => {
      const exportDocument = async () => {
        const pending = other.waitForEvent("download");
        await other
          .getByRole("button", { name: "JSON 저장", exact: true })
          .click();
        const chunks = [];
        for await (const part of await (await pending).createReadStream())
          chunks.push(part);
        return JSON.parse(Buffer.concat(chunks).toString());
      };
      // A selected node makes Delete destructive if a global shortcut escapes the gate.
      await other.locator(".layer-name").first().click();
      const before = await exportDocument();
      const retained = randomUUID();
      await other
        .getByTestId("canvas-stage")
        .evaluate((el, value) => (el.dataset.h03Retained = value), retained);
      const logout = await second.request.post(
        new URL("/api/auth/logout", url).href,
      );
      assert.equal(logout.status(), 200);
      if (
        (await other.locator(".document-library").getAttribute("open")) === null
      )
        await other.locator(".document-library summary").click();
      const name = `H03 retained ${randomUUID().slice(0, 8)}`;
      await other
        .getByRole("textbox", { name: "문서 이름", exact: true })
        .fill(name);
      const rejected = other.waitForResponse(
        (r) =>
          r.url().endsWith("/api/library/current") &&
          r.request().method() === "PUT",
      );
      await other
        .getByRole("button", { name: "이름 변경", exact: true })
        .click();
      assert.equal((await rejected).status(), 401);
      const dialog = other.getByRole("dialog");
      await dialog.waitFor();
      const login = dialog.getByRole("button", { name: "로그인", exact: true });
      await login.focus();
      await other.keyboard.press("Delete");
      await other.keyboard.press("Meta+z");
      await other.keyboard.press("Control+z");
      assert.equal(
        await other
          .getByTestId("canvas-stage")
          .getAttribute("data-h03-retained"),
        retained,
      );
      await form(other, "로그인");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        await other
          .getByTestId("canvas-stage")
          .getAttribute("data-h03-retained"),
        retained,
      );
      assert.deepEqual(await exportDocument(), { ...before, name });
      await other
        .getByRole("button", { name: "저장 재시도", exact: true })
        .click();
      await ready(other);
      const saved = await second.request
        .get(new URL("/api/library/current", url).href)
        .then((r) => r.json());
      assert.deepEqual(saved.document, { ...before, name });
    },
  );
  await check(
    "401 on initial library GET recovers by reloading after login without overwriting the server document",
    async () => {
      const endpoint = new URL("/api/library/current", url).href;
      const before = await second.request.get(endpoint).then((r) => r.json());
      let intercepted = false;
      await other.route("**/api/library/current", async (route) => {
        if (!intercepted && route.request().method() === "GET") {
          intercepted = true;
          await route.fulfill({
            status: 401,
            contentType: "application/json",
            body: '{"error":"authentication_required"}',
          });
        } else await route.continue();
      });
      await other.reload({ waitUntil: "networkidle" });
      await other.getByRole("dialog").waitFor();
      assert.equal(intercepted, true);
      assert.deepEqual(
        await second.request.get(endpoint).then((r) => r.json()),
        before,
      );
      await form(other, "로그인");
      await other.getByRole("dialog").waitFor({ state: "hidden" });
      await ready(other);
      await other.unroute("**/api/library/current");
      assert.deepEqual(
        await second.request.get(endpoint).then((r) => r.json()),
        before,
      );
      const name = `H03 bootstrap recovered ${randomUUID().slice(0, 8)}`;
      if (
        (await other.locator(".document-library").getAttribute("open")) === null
      )
        await other.locator(".document-library summary").click();
      await other
        .getByRole("textbox", { name: "문서 이름", exact: true })
        .fill(name);
      const committed = other.waitForResponse(
        (r) =>
          r.url().endsWith("/api/library/current") &&
          r.request().method() === "PUT",
      );
      await other
        .getByRole("button", { name: "이름 변경", exact: true })
        .click();
      assert.equal((await committed).status(), 200);
      await ready(other);
      const after = await second.request.get(endpoint).then((r) => r.json());
      assert.equal(after.version, before.version + 1);
      assert.deepEqual(after.document, { ...before.document, name });
    },
  );
  await check(
    "logout revokes the captured session server-side while the other browser remains signed in",
    async () => {
      const cookie = (await context.cookies())
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      await page.getByRole("button", { name: "로그아웃", exact: true }).click();
      await page.getByRole("button", { name: "로그인", exact: true }).waitFor();
      assert.equal(await page.getByTestId("canvas-stage").count(), 0);
      assert.equal(
        (await api("/api/library/current", { headers: { Cookie: cookie } }))
          .status,
        401,
      );
      const status = await context.request
        .get(new URL("/api/auth/status", url).href)
        .then((r) => r.json());
      assert.equal(status.authenticated, false);
      assert.equal(
        (
          await second.request.get(new URL("/api/library/current", url).href)
        ).status(),
        200,
      );
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("button", { name: "로그인", exact: true }).waitFor();
    },
  );
  assert.deepEqual(errors, []);
} finally {
  if (process.env.AUTH_REPORT)
    await fs.writeFile(
      process.env.AUTH_REPORT,
      JSON.stringify(
        {
          date: new Date().toISOString(),
          url,
          browser: browser.version(),
          firstRun: !initial.initialized,
          checks,
          passed: checks.length,
          pageErrors: errors,
          physicalSecondDevice: "unverified; independent browser contexts only",
        },
        null,
        2,
      ) + "\n",
    );
  await browser.close();
}
