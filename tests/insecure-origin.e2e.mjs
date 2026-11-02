import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { authenticatedTestSession } from "./auth-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

// Plain http on a LAN address is not a secure context, so crypto.randomUUID is
// missing there. The browser maps a non-localhost name to the loopback server,
// which reproduces that condition without opening the server to the network.
// INSECURE_SERVER=1 also signs in through the real login form.
const base = new URL(process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/");
const host = process.env.INSECURE_HOST || "designfree-lan.test";
const server = process.env.INSECURE_SERVER === "1";
if (server) await authenticatedTestSession(base.href); // ensures the disposable owner exists
const url = new URL(base);
url.hostname = host;
const browser = await chromium.launch({
  ...browserLaunchOptions(),
  args: [`--host-resolver-rules=MAP ${host} ${base.hostname}`],
});
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log(`PASS ${server ? "server" : "browser"}: ${name}`);
};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url.href, { waitUntil: "networkidle" });
  const context = await page.evaluate(() => ({ secure: window.isSecureContext, uuid: typeof crypto.randomUUID }));
  assert.deepEqual(context, { secure: false, uuid: "undefined" }, "insecure origin reproduced");
  if (server) {
    await page.getByLabel("사용자 이름").fill(process.env.DRAFTROOM_TEST_USERNAME);
    await page.getByLabel("비밀번호").fill(process.env.DRAFTROOM_TEST_PASSWORD);
    await page.getByRole("button", { name: "로그인" }).click();
  }
  const settled = () =>
    page.waitForFunction(() => ["saved", "idle"].includes(document.querySelector('[data-testid="save-status"]')?.dataset.state));
  await settled();
  check("loads (and signs in) on a non-secure origin");
  const exported = async () => {
    await settled();
    const d = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
    const chunks = [];
    for await (const c of await (await d).createReadStream()) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  const before = await exported();
  // Every path below creates new IDs.
  const box = await page.getByTestId("canvas-stage").boundingBox();
  await page.keyboard.press("r");
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 320, box.y + 280, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-testid="save-status"]').dataset.state === "saved");
  await page.keyboard.press("Meta+d");
  await page.waitForFunction(() => document.querySelector('[data-testid="save-status"]').dataset.state === "saved");
  const after = await exported();
  const added = Object.keys(after.nodes).filter((id) => !before.nodes[id]);
  assert.equal(added.length, 2, "rectangle and duplicate created");
  for (const id of added) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  check("draws and duplicates with v4 IDs, autosave succeeds");
  await page.getByText("문서 목록").click();
  await page.getByRole("button", { name: "새 문서", exact: true }).click();
  await settled();
  const fresh = await exported();
  assert.notEqual(fresh.id, after.id, "new document has its own ID");
  check("creates a new document");
  await page.reload({ waitUntil: "networkidle" });
  await settled();
  await page.getByText("문서 목록").click();
  await page.getByRole("combobox").first().selectOption(after.id).catch(() => {});
  await settled();
  const reopened = await exported();
  if (reopened.id === after.id) assert.deepEqual(Object.keys(reopened.nodes).sort(), Object.keys(after.nodes).sort());
  else assert.equal(reopened.id, fresh.id);
  check(server ? "server library reload keeps both documents" : "IndexedDB reload keeps the library");
  assert.deepEqual(errors, []);
  await fs.writeFile(artifactPath(`insecure-origin-${server ? "server" : "browser"}.json`), JSON.stringify({ host, checks }, null, 2) + "\n");
} finally {
  await browser.close();
}
