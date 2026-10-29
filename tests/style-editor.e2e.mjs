import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { authenticatedTestSession } from "./auth-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

// Only the initial scene is imported. All library authoring below uses the UI;
// JSON downloads and storage reads observe committed state, never mutate it.
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const auth =
  process.env.STYLE_SERVER === "1" ? await authenticatedTestSession(url) : null;
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({
  ...(auth ? { storageState: auth.storageState } : {}),
  viewport: { width: 1440, height: 1100 },
});
page.setDefaultTimeout(15000);
const checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const button = (name) => page.getByRole("button", { name, exact: true });
const editor = page.getByTestId("style-visual-editor");
const entry = (id) => editor.getByTestId(`style-entry-${id}`);
const theme = (id) => editor.getByTestId(`style-theme-${id}`);
const field = (scope, label) => scope.getByLabel(label, { exact: true });
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
};
async function open(details) {
  if (!(await details.evaluate((el) => el.open)))
    await details.locator(":scope > summary").click();
}
async function edit() {
  await open(page.getByTestId("style-inspector"));
  await button("스타일·토큰·테마 편집").click();
}
async function select(id) {
  await page.getByTestId(`layer-${id}`).locator(".layer-name").click();
}
async function snapshot() {
  await page.waitForFunction(() =>
    ["idle", "saved"].includes(
      document.querySelector('[data-testid="save-status"]')?.dataset.state,
    ),
  );
  const wait = page.waitForEvent("download");
  await button("JSON 저장").click();
  const chunks = [];
  for await (const c of await (await wait).createReadStream()) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function revision() {
  await snapshot();
  if (auth) {
    const response = await page.request.get(
      new URL("/api/library/current", url).href,
    );
    assert.equal(response.status(), 200);
    return (await response.json())?.version ?? 0;
  }
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("draftroom-local-drafts", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("drafts", "readonly");
          const get = tx.objectStore("drafts").get("current");
          get.onerror = () => reject(get.error);
          get.onsuccess = () => resolve(get.result?.revision ?? 0);
          tx.oncomplete = () => db.close();
        };
      }),
  );
}
async function load(doc) {
  await page
    .locator('input[type="file"][accept="application/json,.json"]')
    .setInputFiles({
      name: "d02-styles.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
  await page.getByTestId("layer-frame").waitFor();
}
async function newEntry(group, kind, name) {
  await field(editor, "새 항목 타입").selectOption(kind);
  const old = new Set(
    await editor
      .locator('[data-testid^="style-entry-"]')
      .evaluateAll((els) => els.map((el) => el.dataset.testid)),
  );
  await button(group === "tokens" ? "토큰 추가" : "스타일 추가").click();
  const all = await editor
    .locator('[data-testid^="style-entry-"]')
    .evaluateAll((els) => els.map((el) => el.dataset.testid));
  const id = all.find((v) => !old.has(v)).slice("style-entry-".length);
  await open(entry(id));
  await field(entry(id), `${group}.${id} 이름`).fill(name);
  return id;
}
async function reference(id, token) {
  await open(entry(id));
  await field(entry(id), "값 출처").selectOption("token");
  await field(entry(id), "참조 토큰").selectOption(token);
}
async function themeToken(tid, token) {
  const scope = theme(tid)
    .locator("details")
    .filter({
      has: page.getByLabel(`${tid}.${token} 재정의`, { exact: true }),
    });
  await open(scope);
  return scope;
}
const typography = {
  fontFamily: "Noto Sans KR",
  fontSize: 24,
  fontWeight: 500,
  lineHeight: 32,
};
let color, text, effect, colorStyle, textStyle, effectStyle, alias, dark;
try {
  await page.goto(url, { waitUntil: "networkidle" });
  await check(
    "untouched empty visual/JSON library applications do not create history or saves",
    async () => {
      const before = await snapshot(),
        rev = await revision();
      const undo = await button("실행 취소").isEnabled();
      await edit();
      await button("시각 편집 적용").click();
      await button("스타일 라이브러리 적용").click();
      assert.deepEqual(await snapshot(), before);
      assert.equal(await revision(), rev);
      assert.equal(await button("실행 취소").isEnabled(), undo);
    },
  );
  const demo = await snapshot(),
    root = structuredClone(demo.nodes[demo.rootId]);
  root.children = ["frame"];
  const base = {
    ...root,
    children: [],
    visible: true,
    locked: false,
    opacity: 1,
    fill: { type: "solid", color: "#ffffff" },
    fills: undefined,
    layout: { mode: "absolute" },
    clipContent: false,
  };
  await load({
    ...demo,
    id: "d02-style-editor-fixture",
    name: "D02 Visual styles",
    schemaVersion: 1,
    pageIds: undefined,
    assets: {},
    styleLibrary: {
      tokens: {
        seed: { kind: "color", name: "Seed", value: "#123456" },
        alias: { kind: "color", name: "Seed alias", value: { ref: "seed" } },
      },
      styles: {
        ink: { kind: "color", name: "Seed ink", value: { ref: "alias" } },
      },
      themes: {},
    },
    nodes: {
      [root.id]: root,
      frame: {
        ...base,
        id: "frame",
        name: "D02 frame",
        type: "frame",
        parentId: root.id,
        transform: [1, 0, 0, 1, 100, 100],
        width: 500,
        height: 350,
        children: ["label"],
      },
      label: {
        ...base,
        id: "label",
        name: "D02 linked label",
        type: "text",
        parentId: "frame",
        transform: [1, 0, 0, 1, 40, 60],
        width: 350,
        height: 100,
        styleRefs: { color: "ink" },
        text: {
          ...typography,
          content: "시각 스타일 편집",
          fontSize: 16,
          sizing: "fixed",
        },
      },
    },
  });
  await select("label");

  await check(
    "visual color/text/effect tokens, styles and theme commit atomically",
    async () => {
      const before = await snapshot(),
        rev = await revision();
      await edit();
      color = await newEntry("tokens", "color", "Brand color");
      await field(entry(color), "색 값").fill("#2255aa");
      text = await newEntry("tokens", "text", "Body type");
      for (const [label, value] of [
        ["글자 크기", "30"],
        ["굵기", "700"],
        ["행간", "42"],
        ["자간", "1.5"],
      ])
        await field(entry(text), label).fill(value);
      await field(entry(text), "정렬").selectOption("center");
      effect = await newEntry("tokens", "effect", "Card shadow");
      await field(entry(effect), "그림자 1 x").fill("8");
      await field(entry(effect), "그림자 1 y").fill("12");
      await field(entry(effect), "그림자 1 blur").fill("6");
      await field(entry(effect), "그림자 1 색").fill("#00000080");
      await entry(effect)
        .getByRole("button", { name: "그림자 추가", exact: true })
        .click();
      await field(entry(effect), "그림자 2 blur").fill("2");
      await entry(effect)
        .getByRole("button", { name: "그림자 2 삭제", exact: true })
        .click();
      alias = await newEntry("tokens", "color", "Brand alias");
      await reference(alias, color);
      colorStyle = await newEntry("styles", "color", "Brand ink");
      await reference(colorStyle, alias);
      textStyle = await newEntry("styles", "text", "Body text");
      await reference(textStyle, text);
      effectStyle = await newEntry("styles", "effect", "Card effect");
      await reference(effectStyle, effect);
      await button("테마 추가").click();
      dark = (
        await editor
          .locator('[data-testid^="style-theme-"]')
          .getAttribute("data-testid")
      ).slice("style-theme-".length);
      await open(theme(dark));
      await field(theme(dark), `themes.${dark} 이름`).fill("Night");
      const colorOverride = await themeToken(dark, color);
      await field(colorOverride, `${dark}.${color} 재정의`).check();
      await field(colorOverride, "색 값").fill("#aabbcc");
      const typeOverride = await themeToken(dark, text);
      await field(typeOverride, `${dark}.${text} 재정의`).check();
      await field(typeOverride, "글자 크기").fill("48");
      await field(typeOverride, "행간").fill("60");
      const shadowOverride = await themeToken(dark, effect);
      await field(shadowOverride, `${dark}.${effect} 재정의`).check();
      await field(shadowOverride, "그림자 1 blur").fill("20");
      await field(shadowOverride, `${dark}.${effect} 재정의`).uncheck();
      assert.match(
        await shadowOverride.locator(":scope > summary").innerText(),
        /기본 상속/,
      );
      assert.deepEqual(await snapshot(), before);
      assert.equal(await revision(), rev);
      await page.screenshot({ path: artifactPath("d02-visual-draft.png") });
      await button("시각 편집 적용").click();
      const after = await snapshot(),
        lib = after.styleLibrary;
      assert.equal(await revision(), rev + 1);
      assert.equal(lib.tokens[color].value, "#2255aa");
      assert.equal(lib.tokens[text].value.fontSize, 30);
      assert.equal(lib.tokens[text].value.align, "center");
      assert.equal(lib.tokens[effect].value.length, 1);
      assert.equal(lib.tokens[effect].value[0].blur, 6);
      assert.deepEqual(lib.tokens[alias].value, { ref: color });
      assert.deepEqual(lib.styles[colorStyle].value, { ref: alias });
      assert.deepEqual(lib.styles[textStyle].value, { ref: text });
      assert.deepEqual(lib.styles[effectStyle].value, { ref: effect });
      assert.equal(lib.themes[dark].values[color], "#aabbcc");
      assert.equal(lib.themes[dark].values[text].fontSize, 48);
      assert.equal(lib.themes[dark].values[effect], undefined);
      await button("실행 취소").click();
      assert.deepEqual(await snapshot(), before);
      await button("다시 실행").click();
      assert.deepEqual(await snapshot(), after);
    },
  );

  await check(
    "cancel, Escape and no-op preserve document, revision and the redo branch",
    async () => {
      const after = await snapshot();
      await button("실행 취소").click();
      const before = await snapshot(),
        rev = await revision();
      assert(await button("다시 실행").isEnabled());
      await edit();
      await open(entry("seed"));
      await field(entry("seed"), "색 값").fill("#abcdef");
      await button("시각 편집 취소").click();
      await edit();
      await open(entry("seed"));
      await field(entry("seed"), "tokens.seed 이름").fill("Escape draft");
      await field(entry("seed"), "tokens.seed 이름").press("Escape");
      await edit();
      await button("시각 편집 적용").click();
      await edit();
      const temporary = await newEntry("styles", "color", "Discarded addition");
      await button(`styles.${temporary} 삭제`).click();
      await button("시각 편집 적용").click();
      const reverseKeys = (value) =>
        Array.isArray(value)
          ? value.map(reverseKeys)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value)
                  .reverse()
                  .map(([k, v]) => [k, reverseKeys(v)]),
              )
            : value;
      await page
        .getByLabel("스타일 라이브러리 JSON", { exact: true })
        .fill(JSON.stringify(reverseKeys(before.styleLibrary)));
      await button("스타일 라이브러리 적용").click();
      assert.deepEqual(await snapshot(), before);
      assert.equal(await revision(), rev);
      assert(await button("다시 실행").isEnabled());
      await button("다시 실행").click();
      assert.deepEqual(await snapshot(), after);
    },
  );

  await check(
    "visual invalid colors, alias cycles and referenced deletion reject without writes",
    async () => {
      const before = await snapshot(),
        rev = await revision();
      for (const [path, stage] of [
        [
          `tokens.${color}.value`,
          async () => {
            await open(entry(color));
            await field(entry(color), "색 값").fill("invalid");
          },
        ],
        [
          "tokens.seed.value.ref",
          async () => {
            await reference("seed", "alias");
          },
        ],
        [
          "nodes.label.styleRefs.color",
          async () => {
            await open(entry("ink"));
            await button("styles.ink 삭제").click();
          },
        ],
      ]) {
        await edit();
        await stage();
        assert(
          (await page.getByTestId("style-diagnostics").innerText()).includes(
            path,
          ),
        );
        await button("시각 편집 적용").click();
        assert((await editor.getByRole("alert").count()) > 0);
        assert.deepEqual(await snapshot(), before);
        assert.equal(await revision(), rev);
        await button("시각 편집 취소").click();
      }
    },
  );

  await check(
    "linked styles resolve alias/theme overrides while authored fallbacks stay local",
    async () => {
      await field(page, "색 스타일").selectOption(colorStyle);
      await field(page, "텍스트 스타일").selectOption(textStyle);
      await field(page, "효과 스타일").selectOption(effectStyle);
      let doc = await snapshot();
      assert.deepEqual(doc.nodes.label.styleRefs, {
        color: colorStyle,
        text: textStyle,
        effect: effectStyle,
      });
      assert.equal(doc.nodes.label.text.fontSize, 16);
      assert.equal(await field(page, "크기").inputValue(), "30");
      assert(await field(page, "크기").isDisabled());
      const rev = await revision();
      await field(page, "스타일 theme").selectOption(dark);
      doc = await snapshot();
      assert.equal(await revision(), rev + 1);
      assert.equal(doc.styleLibrary.activeTheme, dark);
      assert.equal(await field(page, "크기").inputValue(), "48");
      assert((await page.locator('[fill="#aabbcc"]').count()) > 0);
      assert((await page.locator('text[font-size="48"]').count()) > 0);
      assert(
        (await page.locator('feDropShadow[stdDeviation="6"]').count()) > 0,
      );
      assert.equal(doc.nodes.label.fill.color, "#ffffff");
    },
  );

  await check(
    "relationship paths expose aliases, theme overrides and component source impact",
    async () => {
      await select("frame");
      await button("컴포넌트 생성").click();
      await button("인스턴스 생성").click();
      const doc = await snapshot();
      const instance = Object.values(doc.nodes).find(
        (n) => n.component?.kind === "instance",
      );
      const inheritedLabel = instance.component.nodeMap.label;
      await select("label");
      await open(page.getByTestId("style-inspector"));
      const relations = page.getByTestId("style-relationships");
      await open(relations);
      const relation = relations.getByTestId(`style-relation-${colorStyle}`);
      await open(relation);
      const contents = await relation.innerText();
      for (const path of [
        `styles.${colorStyle}.value`,
        `tokens.${alias}.value`,
        `tokens.${color}.value`,
        `themes.${dark}.values.${color}`,
        "nodes.label.styleRefs.color",
        `nodes.${inheritedLabel}.styleRefs.color`,
      ])
        assert(contents.includes(path), `Missing relationship path ${path}`);
      assert(contents.includes("원본 D02 linked label (label)"));
      assert(contents.includes("스타일 상속"));
      await select(inheritedLabel);
      await field(page, "색 스타일").selectOption("ink");
      await snapshot();
      const inheritedText = relations.getByTestId(
        `style-relation-${textStyle}`,
      );
      await open(inheritedText);
      assert(
        !(await inheritedText.innerText()).includes("스타일 override"),
        "a color override must not label inherited typography as overridden",
      );
      const overriddenColor = relations.getByTestId("style-relation-ink");
      await open(overriddenColor);
      assert((await overriddenColor.innerText()).includes("스타일 override"));
      await button("실행 취소").click();
      assert.deepEqual(await snapshot(), doc);
      await select("label");
      const tokenRelation = relations.getByTestId(`style-relation-${color}`);
      await open(tokenRelation);
      assert(
        (await tokenRelation.innerText()).includes(
          "nodes.label.styleRefs.color",
        ),
      );
    },
  );

  await check(
    "edit all shared kinds and clear a theme override to inherit base tokens",
    async () => {
      const before = await snapshot(),
        rev = await revision();
      await edit();
      await open(entry(color));
      await field(entry(color), `tokens.${color} 이름`).fill("Edited brand");
      await field(entry(color), "색 값").fill("#117744");
      await open(entry(text));
      await field(entry(text), "글꼴").fill("sans-serif");
      await field(entry(text), "글자 크기").fill("36");
      await field(entry(text), "행간").fill("48");
      await open(entry(effect));
      await field(entry(effect), "그림자 1 blur").fill("9");
      await open(entry(colorStyle));
      await field(entry(colorStyle), `styles.${colorStyle} 이름`).fill(
        "Edited ink",
      );
      await open(entry(textStyle));
      await field(entry(textStyle), `styles.${textStyle} 이름`).fill(
        "Edited text",
      );
      await open(entry(effectStyle));
      await field(entry(effectStyle), `styles.${effectStyle} 이름`).fill(
        "Edited effect",
      );
      await open(theme(dark));
      await field(theme(dark), `themes.${dark} 이름`).fill("Edited Night");
      for (const token of [color, text]) {
        const scope = await themeToken(dark, token);
        await field(scope, `${dark}.${token} 재정의`).uncheck();
        assert.match(
          await scope.locator(":scope > summary").innerText(),
          /기본 상속/,
        );
      }
      await button("시각 편집 적용").click();
      const after = await snapshot();
      assert.equal(await revision(), rev + 1);
      assert.deepEqual(after.styleLibrary.themes[dark].values, {});
      assert.equal(await field(page, "크기").inputValue(), "36");
      assert((await page.locator('[fill="#117744"]').count()) > 0);
      assert(
        (await page.locator('feDropShadow[stdDeviation="9"]').count()) > 0,
      );
      await button("실행 취소").click();
      assert.deepEqual(await snapshot(), before);
      await button("다시 실행").click();
      assert.deepEqual(await snapshot(), after);
    },
  );

  await check(
    "alias detachment uses the documented literal default and layer detach freezes values",
    async () => {
      await edit();
      await open(entry(alias));
      await field(entry(alias), "값 출처").selectOption("literal");
      assert.equal(await field(entry(alias), "색 값").inputValue(), "#3366ff");
      await field(entry(alias), "색 값").fill("#dd6600");
      await button("시각 편집 적용").click();
      assert.equal(
        (await snapshot()).styleLibrary.tokens[alias].value,
        "#dd6600",
      );
      assert((await page.locator('[fill="#dd6600"]').count()) > 0);
      for (const label of ["색 스타일", "텍스트 스타일", "효과 스타일"])
        await field(page, label).selectOption("");
      const doc = await snapshot();
      assert.equal(doc.nodes.label.styleRefs, undefined);
      assert.equal(doc.nodes.label.fill.color, "#dd6600");
      assert.equal(doc.nodes.label.text.fontSize, 36);
      assert.equal(doc.nodes.label.effects[0].blur, 9);
      assert(await field(page, "크기").isEnabled());
    },
  );

  await check(
    "JSON roundtrip and durable reload preserve the complete authored library",
    async () => {
      const before = await snapshot();
      await load(before);
      assert.deepEqual(await snapshot(), before);
      await revision();
      await page.reload({ waitUntil: "networkidle" });
      assert.deepEqual(await snapshot(), before);
      await select("label");
      await open(page.getByTestId("style-inspector"));
      await field(page, "색 스타일").selectOption(colorStyle);
      assert((await page.locator('[fill="#dd6600"]').count()) > 0);
      await page.screenshot({
        path:
          process.env.STYLE_EDITOR_SCREENSHOT ||
          artifactPath("d02-visual-editor.png"),
      });
    },
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    process.env.STYLE_EDITOR_REPORT || artifactPath("d02-browser.json"),
    JSON.stringify(
      {
        browser: browser.version(),
        checks,
        passed: checks.length,
        failed: 0,
        pageErrors: errors,
        server: !!auth,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
