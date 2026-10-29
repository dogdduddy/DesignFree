import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  browserLaunchOptions,
  artifactPath,
  serverTestUrl,
} from "./browser-helpers.mjs";

// Author every layer through public UI. JSON downloads and storage reads are
// observations only; this suite works against the production server bundle too.
const server = process.env.A01_SERVER === "1";
if (server) {
  assert.equal(process.env.COMPOSE_PROJECT, "designfree-test-a01");
  assert.ok(
    process.env.DRAFTROOM_TEST_USERNAME && process.env.DRAFTROOM_TEST_PASSWORD,
  );
}
const url = server
  ? serverTestUrl()
  : process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const target = new URL(url);
assert.ok(
  ["127.0.0.1", "localhost"].includes(target.hostname),
  "Use loopback only",
);
const mode = server ? "server" : "indexeddb";
const run = process.env.A01_RUN || "1";
assert.match(run, /^[1-9][0-9]*$/);
const out = artifactPath(`a01-${mode}-${run}/`);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch(browserLaunchOptions());
const context = await browser.newContext({
  viewport: { width: 1680, height: 1100 },
  acceptDownloads: true,
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const button = (name) => page.getByRole("button", { name, exact: true });
const label = (name) => page.getByLabel(name, { exact: true });
const ready = () =>
  page.waitForFunction(() =>
    ["idle", "saved"].includes(
      document.querySelector('[data-testid="save-status"]')?.dataset.state,
    ),
  );
const saved = () =>
  page.waitForFunction(
    () =>
      document.querySelector('[data-testid="save-status"]')?.dataset.state ===
      "saved",
  );
async function check(name, run) {
  await run();
  checks.push(name);
  console.log(`PASS ${mode}: ${name}`);
}
async function library(open = true) {
  if (
    (await page.locator(".document-library").evaluate((el) => el.open)) !== open
  )
    await page.locator(".document-library summary").click();
}
async function download(name, file) {
  const [item] = await Promise.all([
    page.waitForEvent("download"),
    button(name).click(),
  ]);
  assert.equal(await item.failure(), null);
  const dest = `${out}/${file}`;
  await item.saveAs(dest);
  return fs.readFile(dest);
}
let serial = 0;
const snapshot = async () =>
  JSON.parse(await download("JSON 저장", `snapshot-${serial++}.json`));
const select = (id) =>
  page.getByTestId(`layer-${id}`).locator(".layer-name").click();
async function number(name, value) {
  await label(name).fill(String(value));
  await label(name).press("Tab");
}
async function hex(value) {
  await label("채우기 HEX").fill(value);
  await label("채우기 HEX").press("Enter");
}
async function draw(tool, name, x, y, w, h, parent) {
  await button(`${tool} 도구`).click();
  const box = await page.getByTestId("canvas-stage").boundingBox();
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + w, box.y + y + h, { steps: 4 });
  await page.mouse.up();
  const id = (
    await page.locator(".layer.selected").getAttribute("data-testid")
  ).slice(6);
  await label("레이어 이름").fill(name);
  await button("선택 도구").click();
  if (parent) {
    await page
      .getByTestId(`layer-${id}`)
      .dragTo(page.getByTestId(`layer-${parent}`));
  }
  return id;
}
async function text(name, content, y, parent) {
  const id = await draw("텍스트", name, 150, y, 260, 30, parent);
  await label("텍스트 내용").fill(content);
  await number("크기", 18);
  return id;
}
// Read the durable revision instead of assuming a green status means a write.
async function revision() {
  if (server) {
    const response = await context.request.get(
      new URL("/api/library/current", url).href,
    );
    assert.equal(response.status(), 200);
    return (await response.json()).version;
  }
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("draftroom-local-drafts", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("drafts", "readonly");
          const read = transaction.objectStore("drafts").get("current");
          read.onsuccess = () => resolve(read.result.revision);
          transaction.oncomplete = () => db.close();
        };
      }),
  );
}
try {
  await page.goto(url, { waitUntil: "networkidle" });
  if (server) {
    await label("사용자 이름").fill(process.env.DRAFTROOM_TEST_USERNAME);
    await label("비밀번호").fill(process.env.DRAFTROOM_TEST_PASSWORD);
    const setup = button("소유자 만들기");
    await ((await setup.count()) ? setup : button("로그인")).click();
  }
  await ready();
  assert.match(
    await page.getByTestId("save-status").getAttribute("title"),
    server ? /서버/ : /브라우저/,
  );
  await check("new blank document", async () => {
    await library();
    await button("새 문서").click();
    await saved();
    assert.equal(Object.keys((await snapshot()).nodes).length, 1);
    await library();
    await label("문서 이름").fill("Everyday screens A01");
    await button("이름 변경").click();
    await library(false);
  });
  const screens = [];
  for (const [index, name] of ["Login", "List", "Settings"].entries()) {
    await check(`author ${name} screen from blank page`, async () => {
      if (index) await button("페이지 추가").click();
      await label("페이지 이름").fill(name);
      await button("변경").click();
      const frame = await draw("프레임", `${name} screen`, 100, 80, 380, 520);
      await text(
        `${name} heading`,
        ["로그인", "내 작업 목록", "설정"][index],
        110,
        frame,
      );
      const rows =
        index === 0
          ? ["이메일", "비밀번호", "로그인하기"]
          : index === 1
            ? ["디자인 검토", "개발 문서", "주간 회고"]
            : ["프로필", "알림 켜짐", "테마 밝게"];
      let editable;
      for (const [i, content] of rows.entries()) {
        const row = await draw(
          "사각형",
          `${name} row ${i + 1}`,
          130,
          180 + i * 100,
          320,
          64,
          frame,
        );
        await hex(i === 2 && index === 0 ? "#DDE5FF" : "#EEF2F7");
        editable = await text(
          `${name} label ${i + 1}`,
          content,
          196 + i * 100,
          frame,
        );
        assert.ok(row);
      }
      await saved();
      const doc = await snapshot();
      const f = doc.nodes[frame];
      assert.equal(f.type, "frame");
      assert.equal(f.children.length, 7);
      for (const child of f.children)
        assert.equal(doc.nodes[child].parentId, frame);
      const contents = f.children
        .map((id) => doc.nodes[id].text?.content)
        .filter(Boolean);
      assert.deepEqual(contents, [
        ["로그인", "내 작업 목록", "설정"][index],
        ...rows,
      ]);
      screens.push({ name, frame, editable, page: doc.rootId });
      await page.screenshot({ path: `${out}/${name}.png` });
    });
    const screen = screens[index];
    await check(`edit, undo/redo, no-op and cancel ${name}`, async () => {
      await select(screen.editable);
      const before = await snapshot();
      await saved();
      const rev = await revision();
      const changed = `${before.nodes[screen.editable].text.content} · 수정`;
      await label("텍스트 내용").fill(changed);
      await button("선택 도구").click();
      await saved();
      assert.equal(await revision(), rev + 1);
      const after = await snapshot();
      assert.equal(after.nodes[screen.editable].text.content, changed);
      await button("실행 취소").click();
      await saved();
      assert.deepEqual(await snapshot(), before);
      await button("다시 실행").click();
      await saved();
      assert.deepEqual(await snapshot(), after);
      const steady = await revision();
      await number("W", after.nodes[screen.editable].width);
      await hex(after.nodes[screen.editable].fill.color);
      // A pending creation must restore the previously selected label.
      await button("사각형 도구").click();
      const box = await page.getByTestId("canvas-stage").boundingBox();
      await page.mouse.move(box.x + 550, box.y + 160);
      await page.mouse.down();
      await page.mouse.move(box.x + 630, box.y + 200);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await button("선택 도구").click();
      await page.waitForTimeout(800); // exceed autosave debounce for absent writes
      assert.deepEqual(await snapshot(), after);
      assert.equal(
        await page.locator(".layer.selected").getAttribute("data-testid"),
        `layer-${screen.editable}`,
      );
      assert.equal(await revision(), steady);
      // No-op/cancel must not insert an extra undo entry.
      await button("실행 취소").click();
      await saved();
      assert.deepEqual(await snapshot(), before);
      await button("다시 실행").click();
      await saved();
    });
    await check(`SVG, PNG and frame HTML/CSS export ${name}`, async () => {
      await select(screen.frame);
      const before = await snapshot();
      await saved();
      const rev = await revision();
      await button("내보내기").click();
      const svg = (await download("SVG 벡터 파일", `${name}.svg`)).toString();
      assert.ok(svg.includes("<svg"));
      assert.ok(svg.includes("수정"));
      await button("내보내기").click();
      await label("PNG 배율").selectOption("1");
      const png = await download("PNG 이미지 (1x)", `${name}-export.png`);
      assert.deepEqual(
        [...png.subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
      assert.equal(png.readUInt32BE(16), before.nodes[before.rootId].width);
      assert.equal(png.readUInt32BE(20), before.nodes[before.rootId].height);
      await button("내보내기").click();
      await button("선택 frame 웹 미리보기").click();
      const html = (await download("HTML 다운로드", `${name}.html`)).toString();
      const css = (await download("CSS 다운로드", `${name}.css`)).toString();
      assert.ok(html.includes(`<style>${css}</style>`));
      assert.ok(html.includes("수정"));
      const preview = page.frameLocator('iframe[title="Frame HTML 미리보기"]');
      assert.ok((await preview.locator("body").innerText()).includes("수정"));
      await button("미리보기 닫기").click();
      const exported = await context.newPage();
      try {
        const requests = [];
        exported.on("request", (r) => requests.push(r.url()));
        await exported.goto(new URL(`file://${out}/${name}.html`).href);
        assert.ok(
          (await exported.locator("body").innerText()).includes("수정"),
        );
        assert.equal(requests.filter((r) => /^https?:/.test(r)).length, 0);
      } finally {
        await exported.close();
      }
      assert.deepEqual(await snapshot(), before);
      assert.equal(await revision(), rev);
    });
  }
  await check(
    "duplicate document, edit copy, reload and reopen original pages",
    async () => {
      await saved();
      const original = await snapshot();
      await library();
      await button("문서 복제").click();
      await saved();
      const copy = await snapshot();
      assert.notEqual(copy.id, original.id);
      assert.deepEqual(copy.nodes, original.nodes);
      await library(false);
      await select(screens[2].editable);
      await label("텍스트 내용").fill("복제본만 수정");
      await button("선택 도구").click();
      await saved();
      const edited = await snapshot();
      await page.reload({ waitUntil: "networkidle" });
      await ready();
      assert.deepEqual(await snapshot(), edited);
      await library();
      await label("로컬 문서").selectOption(original.id);
      await ready();
      assert.deepEqual(await snapshot(), original);
      await library(false);
      for (const screen of screens) {
        await page.getByRole("tab", { name: screen.name, exact: true }).click();
        await select(screen.frame);
        assert.equal(
          await label("레이어 이름").inputValue(),
          `${screen.name} screen`,
        );
      }
      await saved();
      const reopened = await snapshot();
      await page.reload({ waitUntil: "networkidle" });
      await ready();
      assert.deepEqual(await snapshot(), reopened);
    },
  );
  assert.deepEqual(errors, []);
} catch (e) {
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  throw e;
} finally {
  await fs.writeFile(
    `${out}/report.json`,
    JSON.stringify(
      {
        mode,
        browser: browser.version(),
        checks,
        errors,
        passed: checks.length === 11 && errors.length === 0,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
