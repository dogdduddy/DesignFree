import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { designSystemFixture } from "./web-design-system-fixture.ts";
import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { authenticatedTestSession } from "./auth-helpers.mjs";
const browser = await chromium.launch(browserLaunchOptions());
try {
  const auth =
    process.env.WEB_SERVER === "1"
      ? await authenticatedTestSession(process.env.DRAFTROOM_URL)
      : null;
  const page = await browser.newPage(
    auth ? { storageState: auth.storageState } : {},
  );
  await page.goto(process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/");
  const download = async (name) => {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name, exact: true }).click();
    const chunks = [];
    for await (const chunk of await (await pending).createReadStream())
      chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  };
  await download("JSON 저장"); // Wait for the storage-backed editor to be ready.
  await page
    .locator('input[type="file"][accept="application/json,.json"]')
    .setInputFiles({
      name: "design-system.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(designSystemFixture())),
    });
  await page.getByTestId("layer-frame").locator(".layer-name").click();
  const before = await download("JSON 저장");
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  await page
    .getByRole("button", { name: "선택 frame 웹 미리보기", exact: true })
    .click();
  await page.getByRole("dialog").waitFor();
  const html = await download("HTML 다운로드"),
    css = await download("CSS 다운로드");
  assert.ok(html.includes(`<style>${css}</style>`));
  assert.ok(css.includes("--dr-token-"));
  assert.equal((css.match(/@font-face/g) || []).length, 1);
  const output = await browser.newPage();
  const requests = [];
  output.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  await output.setContent(html);
  await output.evaluate(() => document.fonts.ready);
  const colors = [];
  for (const theme of ["dark", "", "alternate"]) {
    const result = await output.evaluate((theme) => {
      document.documentElement.dataset.drTheme = theme;
      const sections = [
        ...document.querySelectorAll("[data-dr-theme-set]"),
      ].filter((n) => getComputedStyle(n).display !== "none");
      const card = sections[0].querySelector('[data-node-id="card"]');
      return {
        count: sections.length,
        color: getComputedStyle(card).backgroundImage,
        templates: sections[0].querySelectorAll("template").length,
      };
    }, theme);
    assert.equal(result.count, 1);
    assert.equal(result.templates, 2);
    colors.push(result.color);
  }
  assert.equal(new Set(colors).size, 3);
  assert.deepEqual(requests, []);
  await page
    .getByRole("button", { name: "미리보기 닫기", exact: true })
    .click();
  assert.equal(await download("JSON 저장"), before);
  await fs.mkdir(new URL("../test-results/", import.meta.url), {
    recursive: true,
  });
  await fs.writeFile(
    artifactPath(`w02-${auth ? "server" : "browser"}-ui.json`),
    JSON.stringify(
      {
        themes: 3,
        matchingCss: true,
        fontFaces: 1,
        noAuthoringChange: true,
        requests,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS W02 actual UI import, preview/download, three themes, templates, unchanged JSON",
  );
} finally {
  await browser.close();
}
