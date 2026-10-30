import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { authenticatedTestSession } from "./auth-helpers.mjs";
const browser = await chromium.launch(browserLaunchOptions());
const auth =
  process.env.WEB_SERVER === "1"
    ? await authenticatedTestSession(process.env.DRAFTROOM_URL)
    : null;
const page = await browser.newPage({
    ...(auth ? { storageState: auth.storageState } : {}),
    viewport: { width: 1440, height: 1100 },
  }),
  errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const button = (name) => page.getByRole("button", { name, exact: true });
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
};
async function download(name) {
  const pending = page.waitForEvent("download");
  await button(name).click();
  const chunks = [];
  for await (const chunk of await (await pending).createReadStream())
    chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}
try {
  await page.goto(process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/", {
    waitUntil: "networkidle",
  });
  const demo = JSON.parse(await download("JSON 저장")),
    root = structuredClone(demo.nodes[demo.rootId]);
  const sample = structuredClone(
    Object.values(demo.nodes).find((n) => n.type === "rectangle") || {
      ...root,
      type: "rectangle",
    },
  );
  const node = (id, parentId, type, width, height, extra = {}) => ({
    ...sample,
    id,
    name: id,
    parentId,
    type,
    width,
    height,
    children: [],
    transform: [1, 0, 0, 1, 0, 0],
    fill: { type: "solid", color: "#f00" },
    fills: undefined,
    stroke: undefined,
    layout: { mode: "absolute" },
    visible: true,
    opacity: 1,
    ...extra,
  });
  root.children = ["frame"];
  const fixture = {
    ...demo,
    // This geometry regression owns an unbound fixture, independent of prior server documents.
    styleLibrary: undefined,
    schemaVersion: 1,
    pageIds: undefined,
    id: "web-fixture",
    nodes: {
      [root.id]: root,
      frame: node("frame", root.id, "frame", 300, 160, {
        name: "Frame <safe>",
        children: ["nested", "hidden", "overlay"],
        transform: [1, 0, 0, 1, 50, 60],
        layout: {
          mode: "grid",
          grid: { columns: [100, { fr: 1 }], rows: [80] },
          gap: 10,
        },
      }),
      nested: node("nested", "frame", "frame", 100, 80, {
        children: ["text"],
        layout: {
          mode: "flex",
          width: "fill",
          height: "fill",
          padding: [5, 5, 5, 5],
        },
      }),
      text: node("text", "nested", "text", 80, 30, {
        text: {
          content: "<script>한글 & 안전</script>",
          fontFamily: "Noto Sans KR",
          fontSize: 14,
          fontWeight: 400,
          lineHeight: 20,
          sizing: "auto-height",
        },
        layout: { mode: "absolute", width: "fill", height: "hug" },
      }),
      hidden: node("hidden", "frame", "rectangle", 50, 30, { visible: false }),
      overlay: node("overlay", "frame", "ellipse", 40, 30, {
        transform: [1, 0.2, 0.1, 1, 230, 110],
        layout: { mode: "absolute", position: "absolute" },
        stroke: { width: 2, color: "#000" },
      }),
    },
    assets: {},
  };
  await page
    .locator('input[type="file"][accept="application/json,.json"]')
    .setInputFiles({
      name: "web.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
  await page.getByTestId("layer-frame").locator(".layer-name").click();
  const before = await download("JSON 저장");
  await check(
    "selected frame opens isolated HTML preview with subset warnings",
    async () => {
      await button("내보내기").click();
      await button("선택 frame 웹 미리보기").click();
      await page.getByRole("dialog").waitFor();
      assert.ok(
        (await page.getByRole("dialog").innerText()).includes(
          "반응형 Flex/Grid",
        ),
      );
      assert.ok(
        (await page.getByRole("dialog").innerText()).includes("stroke"),
      );
      assert.equal(
        await page
          .locator('iframe[title="Frame HTML 미리보기"]')
          .getAttribute("sandbox"),
        "",
      );
    },
  );
  await check(
    "native clipboard actions cannot mutate editor behind modal",
    async () => {
      await page.getByRole("dialog").evaluate((el) => {
        for (const type of ["copy", "cut", "paste"])
          el.dispatchEvent(
            new ClipboardEvent(type, {
              bubbles: true,
              cancelable: true,
              clipboardData: new DataTransfer(),
            }),
          );
      });
      assert.equal(await page.getByRole("dialog").count(), 1);
    },
  );
  let exportedHTML;
  await check(
    "downloads standalone HTML and matching CSS with embedded font and safe content",
    async () => {
      exportedHTML = await download("HTML 다운로드");
      const css = await download("CSS 다운로드");
      assert.ok(exportedHTML.includes(`<style>${css}</style>`));
      assert.ok(css.includes("data:font/ttf;base64,"));
      assert.ok(css.includes("SIL OPEN FONT LICENSE"));
      assert.ok(!exportedHTML.includes("<script>"));
      assert.ok(!exportedHTML.includes('data-node-id="hidden"'));
      assert.ok(!exportedHTML.includes("<svg"));
    },
  );
  await check(
    "browser renders nested Grid/Flex snapshot and affine child in local frame coordinates",
    async () => {
      const frame = page.frameLocator('iframe[title="Frame HTML 미리보기"]');
      const box = await frame.locator('[data-node-id="frame"]').boundingBox();
      const nested = await frame
        .locator('[data-node-id="nested"]')
        .boundingBox();
      assert.equal(box.width, 300);
      assert.equal(box.height, 160);
      assert.equal(nested.width, 100);
      assert.equal(nested.height, 80);
      assert.equal(nested.x, box.x);
      assert.equal(nested.y, box.y);
      assert.equal(
        await frame
          .locator('[data-node-id="overlay"]')
          .evaluate((el) => getComputedStyle(el).transform),
        "matrix(1, 0.2, 0.1, 1, 230, 110)",
      );
      assert.ok(
        (await frame.locator('[data-node-id="text"]').innerText()).includes(
          "한글",
        ),
      );
      assert.equal(await frame.locator("script").count(), 0);
    },
  );
  await check(
    "closing preview preserves JSON and history; non-frame selection disables action",
    async () => {
      await button("미리보기 닫기").click();
      assert.equal(await download("JSON 저장"), before);
      await page.getByTestId("layer-overlay").locator(".layer-name").click();
      await button("내보내기").click();
      assert.ok(await button("선택 frame 웹 미리보기").isDisabled());
      await button("내보내기").click();
    },
  );
  await check(
    "downloaded HTML opens independently without network requests",
    async () => {
      const standalone = await browser.newPage(),
        requests = [];
      standalone.on("request", (r) => {
        if (/^https?:/.test(r.url())) requests.push(r.url());
      });
      await standalone.setContent(exportedHTML);
      await standalone.evaluate(() => document.fonts.ready);
      assert.equal(
        await standalone.locator('[data-node-id="frame"]').count(),
        1,
      );
      assert.deepEqual(requests, []);
      for (const width of [320, 480, 768, 1100]) {
        await standalone.setViewportSize({ width, height: 900 });
        const geometry = await standalone
          .locator('[data-node-id="frame"]')
          .evaluate((el) => ({
            width: el.getBoundingClientRect().width,
            display: getComputedStyle(el).display,
          }));
        assert.equal(geometry.width, width);
        assert.equal(geometry.display, "grid");
        assert.equal(
          await standalone
            .locator('[data-node-id="nested"]')
            .evaluate((el) => el.getBoundingClientRect().width),
          100,
        );
      }
      await standalone.close();
    },
  );
  await check(
    "absolute frame clipboard actions preserve document independently of layout guards",
    async () => {
      const plain = structuredClone(fixture);
      for (const node of Object.values(plain.nodes))
        node.layout = { mode: "absolute" };
      await page
        .locator('input[type="file"][accept="application/json,.json"]')
        .setInputFiles({
          name: "plain.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(plain)),
        });
      await page.getByTestId("layer-frame").locator(".layer-name").click();
      const original = await download("JSON 저장");
      await button("내보내기").click();
      await button("선택 frame 웹 미리보기").click();
      await page.getByRole("dialog").waitFor();
      await page.getByRole("dialog").evaluate((el) => {
        for (const type of ["cut", "paste"])
          el.dispatchEvent(
            new ClipboardEvent(type, {
              bubbles: true,
              cancelable: true,
              clipboardData: new DataTransfer(),
            }),
          );
      });
      await button("미리보기 닫기").click();
      assert.equal(await download("JSON 저장"), original);
    },
  );
  await check(
    "PNG decode rejects corrupt bytes and embeds valid owned bytes",
    async () => {
      const broken = structuredClone(fixture);
      broken.nodes.frame.children = ["image"];
      broken.nodes = {
        [root.id]: root,
        frame: broken.nodes.frame,
        image: node("image", "frame", "image", 40, 30, { assetId: "png" }),
      };
      broken.assets = {
        png: {
          id: "png",
          mimeType: "image/png",
          width: 1,
          height: 1,
          dataUrl: "data:image/png;base64,iVBORw0KGgoAAAA",
        },
      };
      await page
        .locator('input[type="file"][accept="application/json,.json"]')
        .setInputFiles({
          name: "broken.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(broken)),
        });
      await page.getByTestId("layer-frame").locator(".layer-name").click();
      await button("내보내기").click();
      await button("선택 frame 웹 미리보기").click();
      await page
        .getByRole("status")
        .filter({ hasText: "PNG 이미지를 디코딩" })
        .waitFor();
      assert.equal(await page.getByRole("dialog").count(), 0);
      broken.assets.png.dataUrl =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALElEQVR4nGP4euf1f2R8R2MaCiYkzzAMDCBVA7r8cDBg4GNh4A0Y+FgYcAMAc3MqLpLLUS4AAAAASUVORK5CYII=";
      await page
        .locator('input[type="file"][accept="application/json,.json"]')
        .setInputFiles({
          name: "valid.png.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(broken)),
        });
      await page.getByTestId("layer-frame").locator(".layer-name").click();
      await button("내보내기").click();
      await button("선택 frame 웹 미리보기").click();
      await page.getByRole("dialog").waitFor();
      const image = page
        .frameLocator('iframe[title="Frame HTML 미리보기"]')
        .locator("img");
      assert.ok(
        await image.evaluate(async (el) => {
          await el.decode();
          return el.naturalWidth === 16;
        }),
      );
      assert.ok(
        (await download("HTML 다운로드")).includes(broken.assets.png.dataUrl),
      );
      await button("미리보기 닫기").click();
    },
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    process.env.WEB_REPORT || artifactPath("188-l03-web-browser.json"),
    JSON.stringify(
      { browser: browser.version(), passed: checks.length, checks, errors },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
