import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
const base = process.env.EDITOR_URL || "http://127.0.0.1:5173";
const work = artifactPath("feedback-qa/");
await fs.mkdir(work, { recursive: true });
const b = await chromium.launch(browserLaunchOptions());
try {
  const p = await b.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(base, { waitUntil: "networkidle" });
  await p.locator(".renderer-surface svg text").first().waitFor();
  await p.waitForFunction(() => {
    const s = document.querySelector('[data-testid="save-status"]');
    return s && s.getAttribute("data-state") !== "loading";
  });
  const downloaded = [];
  await p.getByRole("button", { name: "내보내기", exact: true }).click();
  assert.equal(
    await p
      .getByRole("combobox", { name: "PNG 배율", exact: true })
      .inputValue(),
    "2",
  );
  await p.screenshot({ path: artifactPath("16-png-export-controls.png"), fullPage: true });
  const root = await p.evaluate(() => {
    const s = window.__draftroom.getState();
    return s.document.nodes[s.document.rootId];
  });
  for (const scale of [1, 2, 4]) {
    if (scale !== 1)
      await p.getByRole("button", { name: "내보내기", exact: true }).click();
    await p
      .getByRole("combobox", { name: "PNG 배율", exact: true })
      .selectOption(String(scale));
    const dimensions =
      Math.ceil(root.width * scale) +
      " × " +
      Math.ceil(root.height * scale) +
      " px";
    assert(await p.getByText(dimensions, { exact: true }).isVisible());
    const next = p.waitForEvent("download");
    await p
      .getByRole("button", { name: "PNG 이미지 (" + scale + "x)", exact: true })
      .click();
    const d = await next;
    assert.equal(d.suggestedFilename(), "draftroom-design@" + scale + "x.png");
    const dest =
      scale === 2
        ? path.resolve(artifactPath("15-export-sample@2x.png"))
        : path.join(work, "export@" + scale + "x.png");
    await d.saveAs(dest);
    const data = await fs.readFile(dest);
    assert.equal(data.subarray(1, 4).toString(), "PNG");
    assert.equal(data.readUInt32BE(16), Math.ceil(root.width * scale));
    assert.equal(data.readUInt32BE(20), Math.ceil(root.height * scale));
    downloaded.push({
      scale,
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
      bytes: data.length,
      filename: d.suggestedFilename(),
    });
    await p
      .getByRole("button", { name: "내보내기", exact: true })
      .waitFor({ state: "visible" });
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(
    artifactPath("13-feedback-validation.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        browser: b.version(),
        pngUi: { defaultScale: 2, downloaded, errors },
        scope: "Option duplication and PNG export quality feedback iteration",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({ passed: true, pngUi: downloaded, errors }, null, 2),
  );
} finally {
  await b.close();
}
