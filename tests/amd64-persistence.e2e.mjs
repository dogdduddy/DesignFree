import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import {
  browserLaunchOptions,
  serverTestUrl,
  artifactPath,
} from "./browser-helpers.mjs";

assert.equal(process.env.COMPOSE_PROJECT, "designfree-test-p01");
assert.ok(["save", "load"].includes(process.env.P01_PHASE));
const url = serverTestUrl();
assert.equal(url, "http://127.0.0.1:43172/");
const browser = await chromium.launch(browserLaunchOptions());
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "networkidle" });
  await page
    .getByLabel("사용자 이름", { exact: true })
    .fill(process.env.DRAFTROOM_TEST_USERNAME);
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill(process.env.DRAFTROOM_TEST_PASSWORD);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  const ready = () =>
    page.waitForFunction(() =>
      ["saved", "idle"].includes(
        document.querySelector('[data-testid="save-status"]')?.dataset.state,
      ),
    );
  await ready();
  const endpoint = new URL("/api/library/current", url).href;
  const read = async () => {
    const response = await page.context().request.get(endpoint);
    assert.equal(response.status(), 200);
    return response.json();
  };
  if (process.env.P01_PHASE === "save") {
    const before = await read();
    if ((await page.locator(".document-library").getAttribute("open")) === null)
      await page.locator(".document-library summary").click();
    await page
      .getByRole("textbox", { name: "문서 이름", exact: true })
      .fill("P01 AMD64 durable document");
    const committed = page.waitForResponse(
      (r) => r.url() === endpoint && r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "이름 변경", exact: true }).click();
    assert.equal((await committed).status(), 200);
    await ready();
    const saved = await read();
    assert.equal(saved.version, before.version + 1);
    assert.equal(saved.document.name, "P01 AMD64 durable document");
    await writeFile(artifactPath("p01-library.json"), JSON.stringify(saved));
  } else {
    const expected = JSON.parse(
      await readFile(artifactPath("p01-library.json"), "utf8"),
    );
    assert.deepEqual(await read(), expected);
    assert.match(
      await page.locator(".document-title").innerText(),
      /P01 AMD64 durable document/,
    );
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
    const chunks = [];
    for await (const chunk of await (await pending).createReadStream())
      chunks.push(chunk);
    assert.deepEqual(
      JSON.parse(Buffer.concat(chunks).toString()),
      expected.document,
    );
  }
  assert.deepEqual(errors, []);
  console.log(`PASS P01 browser ${process.env.P01_PHASE}`);
} finally {
  await browser.close();
}
