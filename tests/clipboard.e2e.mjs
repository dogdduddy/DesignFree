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
  errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const btn = (name) => page.getByRole("button", { name, exact: true });
const select = async (id) => {
  await page.getByTestId(`layer-${id}`).locator(".layer-name").click();
};
const selected = () =>
  page
    .locator(".layer.selected")
    .evaluateAll((rows) => rows.map((el) => el.dataset.testid.slice(6)));
const key = async (k) => {
  await page.keyboard.press(`Meta+${k}`);
  await page.waitForTimeout(120);
};
async function exportDoc() {
  const download = page.waitForEvent("download");
  await btn("JSON 저장").click();
  const stream = await (await download).createReadStream(),
    chunks = [];
  for await (const c of stream) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function importDoc(doc) {
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles({
      name: "clipboard.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
  await page.waitForTimeout(600);
}
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
}
try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="save-status"]')
        .getAttribute("data-state") !== "loading",
  );
  const original = await exportDoc(),
    frame = original.nodes[original.rootId].children[0];
  const image = Object.values(original.nodes).find((n) => n.type === "image");
  const frame2 = original.nodes[original.rootId].children[1];
  let json, copied;
  await check(
    "Cmd+C writes JSON and SVG to system clipboard without history",
    async () => {
      await select(image.id);
      await key("c");
      json = await page.evaluate(() => navigator.clipboard.readText());
      const p = JSON.parse(json);
      assert.equal(p.format, "draftroom/clipboard");
      assert.equal(p.document.nodes[p.document.rootId].children.length, 1);
      const items = await page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        return Promise.all(
          items.map(async (item) => ({
            types: item.types,
            html: item.types.includes("text/html")
              ? await (await item.getType("text/html")).text()
              : "",
          })),
        );
      });
      assert(
        items.some(
          (item) =>
            item.types.includes("text/plain") &&
            item.html.includes("<svg") &&
            item.html.includes("data:image/png"),
        ),
      );
      assert(await btn("실행 취소").isDisabled());
      assert.deepEqual(await exportDoc(), original);
    },
  );
  await check(
    "Cmd+V keeps position, creates new IDs and shares image reference",
    async () => {
      await key("v");
      const ids = await selected();
      assert.equal(ids.length, 1);
      copied = ids[0];
      assert.notEqual(copied, image.id);
      const doc = await exportDoc(),
        n = doc.nodes[copied];
      assert.equal(n.parentId, image.parentId);
      assert.equal(n.assetId, image.assetId);
      n.transform.forEach((v, i) =>
        assert(Math.abs(v - image.transform[i]) < 1e-8),
      );
      assert.deepEqual(doc.assets, original.assets);
      await key("z");
      assert.deepEqual(await exportDoc(), original);
      await key("Shift+z");
      assert((await exportDoc()).nodes[copied]);
    },
  );
  await check(
    "Cmd+X removes only after copying and cut/paste have separate Undo steps",
    async () => {
      await select(copied);
      await key("x");
      const cutData = JSON.parse(
        await page.evaluate(() => navigator.clipboard.readText()),
      );
      assert.deepEqual(
        cutData.document.nodes[cutData.document.rootId].children,
        [copied],
      );
      assert(!(await exportDoc()).nodes[copied]);
      assert.equal((await selected()).length, 0);
      await key("v");
      const pasted = (await selected())[0];
      assert.notEqual(pasted, copied);
      assert.equal((await exportDoc()).nodes[pasted].assetId, image.assetId);
      await key("z");
      assert(!(await exportDoc()).nodes[pasted]);
      await key("z");
      assert((await exportDoc()).nodes[copied]);
      await key("Shift+z");
      assert(!(await exportDoc()).nodes[copied]);
    },
  );
  await check(
    "selected frame receives paste at copied local coordinates",
    async () => {
      await select(image.id);
      await key("c");
      await select(frame2);
      await key("v");
      const id = (await selected())[0],
        doc = await exportDoc();
      assert.equal(doc.nodes[id].parentId, frame2);
      assert.deepEqual(doc.nodes[id].transform, image.transform);
    },
  );
  await check(
    "Cmd+D and paste use consistent subtree remapping, with D offset 24",
    async () => {
      await select(frame);
      await key("c");
      await page.keyboard.press("Escape");
      await key("v");
      const pasted = (await selected())[0],
        p = (await exportDoc()).nodes[pasted];
      await select(frame);
      await key("d");
      const duplicated = (await selected())[0],
        doc = await exportDoc(),
        d = doc.nodes[duplicated];
      assert.equal(d.children.length, p.children.length);
      assert.equal(d.transform[4] - p.transform[4], 24);
      assert.equal(d.transform[5] - p.transform[5], 24);
      assert.notDeepEqual(d.children, p.children);
      assert(d.children.every((id) => doc.nodes[id].parentId === duplicated));
      if (process.env.CLIPBOARD_SCREENSHOT)
        await page.screenshot({
          path: process.env.CLIPBOARD_SCREENSHOT,
          fullPage: true,
        });
    },
  );
  await check(
    "native text input Cmd+C/X/V edits text without cutting design layers",
    async () => {
      const before = await exportDoc();
      const input = page.getByLabel("레이어 이름", { exact: true });
      const name = await input.inputValue();
      await input.focus();
      await input.selectText();
      await key("c");
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        name,
      );
      await key("x");
      assert.equal(await input.inputValue(), "");
      await key("v");
      assert.equal(await input.inputValue(), name);
      await page.evaluate(() => document.activeElement?.blur());
      assert.deepEqual(await exportDoc(), before);
    },
  );
  await check(
    "clipboard serialization failure preserves cut source and Undo history",
    async () => {
      const before = await exportDoc(),
        canUndo = await btn("실행 취소").isEnabled();
      await page.evaluate(() => {
        const e = new Event("cut", { bubbles: true, cancelable: true });
        Object.defineProperty(e, "clipboardData", {
          value: {
            setData() {
              throw new Error("simulated clipboard write failure");
            },
          },
        });
        window.dispatchEvent(e);
      });
      await page
        .getByText("클립보드에 복사하지 못했습니다. 원본은 유지됩니다.", {
          exact: true,
        })
        .waitFor();
      assert.deepEqual(await exportDoc(), before);
      assert.equal(await btn("실행 취소").isEnabled(), canUndo);
    },
  );
  await check(
    "invalid system clipboard leaves document and history unchanged",
    async () => {
      const before = await exportDoc();
      await page.evaluate(() =>
        navigator.clipboard.writeText(
          '{"format":"draftroom/clipboard","version":9}',
        ),
      );
      await key("v");
      await page
        .getByText(
          "붙여넣을 수 없는 클립보드입니다. Draftroom에서 복사해 주세요.",
          { exact: true },
        )
        .waitFor();
      assert.deepEqual(await exportDoc(), before);
    },
  );
  await check(
    "cross-document paste carries PNG data with no existing asset table",
    async () => {
      const target = structuredClone(original);
      target.id = "other-document";
      const pageNode = target.nodes[target.rootId];
      pageNode.children = [];
      target.nodes = { [pageNode.id]: pageNode };
      target.assets = {};
      await importDoc(target);
      await page.evaluate((json) => navigator.clipboard.writeText(json), json);
      await key("v");
      const doc = await exportDoc(),
        id = (await selected())[0];
      assert.equal(doc.nodes[id].parentId, target.rootId);
      assert.equal(doc.nodes[id].assetId, image.assetId);
      assert.deepEqual(doc.assets, original.assets);
    },
  );
  await check(
    "locked selected target rejects paste without document changes",
    async () => {
      const target = structuredClone(original);
      target.nodes[frame2].locked = true;
      await importDoc(target);
      await select(frame2);
      const before = await exportDoc();
      await page.evaluate((json) => navigator.clipboard.writeText(json), json);
      await key("v");
      assert.deepEqual(await exportDoc(), before);
    },
  );
  await check("pasted design survives autosave reload", async () => {
    await importDoc(original);
    await page.evaluate((json) => navigator.clipboard.writeText(json), json);
    await page.keyboard.press("Escape");
    await key("v");
    const before = await exportDoc();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="save-status"]')
          .getAttribute("data-state") === "saved",
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="save-status"]')
          .getAttribute("data-state") !== "loading",
    );
    assert.deepEqual(await exportDoc(), before);
    assert(await btn("실행 취소").isDisabled());
  });
  assert.deepEqual(errors, []);
  const result = {
    url,
    checks,
    passed: checks.length,
    failed: 0,
    pageErrors: errors,
    browser: browser.version(),
  };
  if (process.env.CLIPBOARD_REPORT)
    await fs.writeFile(
      process.env.CLIPBOARD_REPORT,
      JSON.stringify(result, null, 2) + "\n",
    );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
