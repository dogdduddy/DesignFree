import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { authenticatedTestSession } from "./auth-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

// X01: author click links in the inspector, play them in preview, and keep
// them through Undo, autosave reload and JSON round trip. PROTOTYPE_SERVER=1
// runs the same flow against a disposable server installation.
const url = process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/";
const server = process.env.PROTOTYPE_SERVER === "1";
const auth = server ? await authenticatedTestSession(url) : null;
const label = server ? "server" : "browser";

const node = (type, id, parentId, props = {}) => ({
  id, type, name: props.name ?? id, parentId, children: [], transform: [1, 0, 0, 1, 0, 0],
  width: 100, height: 100, fill: { type: "solid", color: "#cfd6ee" }, opacity: 1, radius: 0,
  clipContent: false, visible: true, locked: false, layout: { mode: "absolute" }, ...props,
});
// Three phone-sized screens; Home's button sits inside a group so clicks on
// its label bubble to the linked group.
const nodes = {
  page: node("page", "page", null, { name: "Page", width: 1400, height: 900, fill: { type: "solid", color: "#eeeeee" }, children: ["home", "detail", "settings", "note"] }),
  home: node("frame", "home", "page", { name: "Home", width: 300, height: 500, transform: [1, 0, 0, 1, 40, 40], fill: { type: "solid", color: "#ffffff" }, clipContent: true, children: ["cta", "lockedLink"] }),
  cta: node("group", "cta", "home", { name: "Open button", transform: [1, 0, 0, 1, 50, 380], width: 200, height: 60, fill: { type: "none" }, children: ["ctaBg", "ctaLabel"] }),
  ctaBg: node("rectangle", "ctaBg", "cta", { name: "Button fill", width: 200, height: 60, radius: 12, fill: { type: "solid", color: "#5b4bdb" } }),
  ctaLabel: node("text", "ctaLabel", "cta", { name: "Button label", transform: [1, 0, 0, 1, 60, 18], width: 80, height: 24, fill: { type: "solid", color: "#ffffff" }, text: { content: "Open", fontFamily: "Noto Sans KR", fontSize: 16, fontWeight: 600, lineHeight: 24 } }),
  lockedLink: node("rectangle", "lockedLink", "home", { name: "Settings icon", transform: [1, 0, 0, 1, 250, 20], width: 30, height: 30, locked: true, fill: { type: "solid", color: "#999999" } }),
  detail: node("frame", "detail", "page", { name: "Detail", width: 300, height: 500, transform: [1, 0, 0, 1, 400, 40], fill: { type: "solid", color: "#f3efe6" }, clipContent: true, children: ["back"] }),
  back: node("ellipse", "back", "detail", { name: "Back", transform: [1, 0, 0, 1, 20, 20], width: 40, height: 40, fill: { type: "solid", color: "#333333" } }),
  settings: node("frame", "settings", "page", { name: "Settings", width: 300, height: 500, transform: [1, 0, 0, 1, 760, 40], fill: { type: "solid", color: "#e6f3ee" }, clipContent: true }),
  note: node("rectangle", "note", "page", { name: "Loose note", transform: [1, 0, 0, 1, 1100, 40], width: 120, height: 60 }),
};
nodes.page.children = ["home", "detail", "settings", "note"];
const fixture = { schemaVersion: 1, id: `x01-${label}`, name: "Prototype", rootId: "page", nodes, assets: {} };

const browser = await chromium.launch(browserLaunchOptions());
const report = { label, url, checks: [] };
try {
  const page = await browser.newPage({
    ...(auth ? { storageState: auth.storageState } : {}),
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const check = (name) => {
    report.checks.push(name);
    console.log(`PASS ${label}: ${name}`);
  };
  const status = () => page.evaluate(() => document.querySelector('[data-testid="save-status"]').dataset.state);
  const settled = () =>
    page.waitForFunction(() => ["saved", "idle"].includes(document.querySelector('[data-testid="save-status"]')?.dataset.state));
  const exported = async () => {
    await settled();
    const d = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
    const chunks = [];
    for await (const c of await (await d).createReadStream()) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  const select = (id) => page.getByTestId(`layer-${id}`).locator(".layer-name").click();
  // Count committed saves through the save-status transitions.
  const saves = () => page.evaluate(() => window.__x01Saves ?? 0);

  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector('[data-testid="save-status"]').dataset.state !== "loading");
  await page.locator('input[type=file][accept="application/json,.json"]').setInputFiles({
    name: "prototype.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await settled();
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="save-status"]');
    window.__x01Saves = 0;
    new MutationObserver(() => {
      if (el.dataset.state === "saved") window.__x01Saves++;
    }).observe(el, { attributes: true, attributeFilter: ["data-state"] });
  });

  // A layer outside any screen cannot link.
  await select("note");
  await page.getByText("페이지 최상위 프레임(화면) 안의 레이어만").waitFor();
  assert.equal(await page.getByLabel("클릭 시 이동").count(), 0);

  // Author: group → Detail with dissolve, Back → Home, locked icon → Settings.
  await select("cta");
  const destination = page.getByLabel("클릭 시 이동");
  assert.deepEqual(await destination.locator("option").allTextContents(), ["없음", "Detail", "Settings"], "own screen is not offered");
  let before = await saves();
  await destination.selectOption("detail");
  await settled();
  await page.getByLabel("전환").selectOption("300");
  await settled();
  await select("back");
  await page.getByLabel("클릭 시 이동").selectOption("home");
  await settled();
  await select("detail");
  await page.getByLabel("시작 화면").check();
  await settled();
  await page.getByLabel("시작 화면").uncheck();
  await settled();
  await select("home");
  await page.getByLabel("시작 화면").check();
  await settled();
  assert.equal((await saves()) - before, 6, "each effective change saves once");
  let doc = await exported();
  assert.deepEqual(doc.nodes.cta.interactions, [{ trigger: "click", action: { type: "navigate", destinationId: "detail", transition: { type: "dissolve", duration: 300 } } }]);
  assert.deepEqual(doc.nodes.back.interactions[0].action, { type: "navigate", destinationId: "home", transition: { type: "instant" } });
  assert.equal(doc.nodes.page.prototypeStartId, "home");
  check("inspector authors links, transition and start screen; one save each");

  // Undo/Redo: each authoring change is one step.
  await page.keyboard.press("Meta+z");
  await settled();
  assert.equal((await exported()).nodes.page.prototypeStartId, undefined);
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+z");
  await settled();
  doc = await exported();
  assert.equal(doc.nodes.back.interactions, undefined, "back link undone");
  assert.equal(doc.nodes.cta.interactions[0].action.transition.type, "dissolve");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Meta+Shift+z");
  await settled();
  doc = await exported();
  assert.equal(doc.nodes.page.prototypeStartId, "home");
  assert.ok(doc.nodes.back.interactions);
  check("Undo/Redo step through each authoring change");

  // The locked icon links through the inspector of a locked layer? Locked
  // layers are not editable, so author it by unlocking, linking, relocking.
  await select("lockedLink");
  assert.ok(await page.getByLabel("클릭 시 이동").isDisabled(), "locked layer link is read-only");
  await page.getByTestId("layer-lockedLink").getByRole("button", { name: /잠금/ }).click();
  await page.getByLabel("클릭 시 이동").selectOption("settings");
  await page.getByTestId("layer-lockedLink").getByRole("button", { name: /잠금/ }).click();
  await settled();
  assert.equal((await exported()).nodes.lockedLink.locked, true);

  // Preview: starts at the start screen, plays links, never changes the document.
  const committed = await exported();
  const savesBefore = await saves();
  const undoDisabled = await page.getByRole("button", { name: "실행 취소" }).isDisabled();
  await select("detail");
  await page.getByRole("button", { name: "프로토타입 미리보기" }).click();
  const dialog = page.getByRole("dialog", { name: "프로토타입 미리보기" });
  await dialog.waitFor();
  const title = page.getByTestId("prototype-title");
  assert.equal(await title.textContent(), "Home", "page start screen wins over selection");
  const clickAt = async (x, y) => {
    const box = await page.getByTestId("prototype-screen").boundingBox();
    const id = await page.getByTestId("prototype-screen").getAttribute("data-screen");
    const w = committed.nodes[id].width, h = committed.nodes[id].height;
    await page.mouse.click(box.x + (x / w) * box.width, box.y + (y / h) * box.height);
  };
  await clickAt(150, 200); // empty area: hotspots flash
  assert.equal(await page.getByTestId("prototype-hotspot").count(), 2);
  assert.equal(await title.textContent(), "Home");
  await clickAt(50 + 60 + 10, 380 + 18 + 10); // on the label inside the linked group
  assert.equal(await title.textContent(), "Detail");
  assert.equal(await page.getByTestId("prototype-leaving").count(), 1, "dissolve keeps the previous screen while fading");
  await page.waitForTimeout(450);
  assert.equal(await page.getByTestId("prototype-leaving").count(), 0);
  await clickAt(40, 40); // ellipse Back, instant
  assert.equal(await title.textContent(), "Home");
  assert.equal(await page.getByTestId("prototype-leaving").count(), 0, "instant has no fade");
  await clickAt(265, 35); // locked layer still plays in preview
  assert.equal(await title.textContent(), "Settings");
  await page.getByRole("button", { name: "이전 화면" }).click();
  assert.equal(await title.textContent(), "Home");
  // The editor behind the player is inert: neither shortcuts nor Tab-focus
  // reach it (Shift+Tab, Enter would otherwise activate a header button).
  assert.equal(await page.evaluate(() => document.querySelector(".editor-app").inert), true);
  assert.ok(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), "focus inside the player");
  await page.keyboard.press("Delete");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Shift+Tab");
    assert.ok(
      await page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest('[role="dialog"]')),
      "Tab focus never reaches the editor",
    );
  }
  assert.equal(await title.textContent(), "Home", "editor shortcuts did nothing");
  // Rendering: screen background and the button fill at known points.
  const shot = await page.getByTestId("prototype-screen").screenshot();
  const colours = await page.evaluate(async ({ png, points, w, h }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return points.map(([x, y]) => [...ctx.getImageData(Math.round((x / w) * img.width), Math.round((y / h) * img.height), 1, 1).data].slice(0, 3));
  }, { png: shot.toString("base64"), points: [[150, 200], [220, 410], [40, 15]], w: 300, h: 500 });
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 3);
  assert.ok(near(colours[0], [255, 255, 255]), `screen background ${colours[0]}`);
  assert.ok(near(colours[1], [0x5b, 0x4b, 0xdb]), `button fill ${colours[1]}`);
  assert.ok(near(colours[2], [255, 255, 255]), `outside the button ${colours[2]}`);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(await exported(), committed, "preview changes nothing");
  assert.equal(await saves(), savesBefore, "preview saves nothing");
  assert.equal(await page.getByRole("button", { name: "실행 취소" }).isDisabled(), undoDisabled);
  check("preview: start screen, group bubbling, dissolve/instant, locked hotspot, back, hotspot hint, no document change");

  // Deleting a destination drops links to it in the same Undo step.
  await select("detail");
  await page.keyboard.press("Delete");
  await settled();
  doc = await exported();
  assert.equal(doc.nodes.detail, undefined);
  assert.equal(doc.nodes.cta.interactions, undefined, "link to deleted screen pruned");
  await page.keyboard.press("Meta+z");
  await settled();
  doc = await exported();
  assert.equal(doc.nodes.cta.interactions[0].action.destinationId, "detail", "Undo restores screen and link");
  check("deleting a destination prunes links; one Undo restores both");

  // Persistence: reload from autosave (IndexedDB or server) and JSON round trip.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector('[data-testid="save-status"]').dataset.state === "saved");
  const reloaded = await exported();
  assert.deepEqual(reloaded.nodes, committed.nodes, "reload keeps links and start screen");
  if (server) {
    const library = await (await auth.fetch("/api/library/current")).json();
    const stored = [library.document, ...(library.documents ?? [])].find((d) => d.id === reloaded.id);
    assert.deepEqual(stored.nodes.cta.interactions, committed.nodes.cta.interactions, "server copy has links");
  }
  await page.locator('input[type=file][accept="application/json,.json"]').setInputFiles({
    name: "round-trip.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(reloaded)),
  });
  await settled();
  assert.deepEqual((await exported()).nodes, reloaded.nodes, "JSON export/import keeps links");
  check(server ? "server reload, stored library and JSON round trip keep links" : "IndexedDB reload and JSON round trip keep links");

  // Invalid link data is rejected at the document boundary.
  const bad = structuredClone(fixture);
  bad.id = `x01-bad-${label}`;
  bad.nodes.cta.interactions = [{ trigger: "hover", action: { type: "navigate", destinationId: "detail", transition: { type: "instant" } } }];
  await page.locator('input[type=file][accept="application/json,.json"]').setInputFiles({
    name: "bad.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bad)),
  });
  await page.getByText("불러오기 실패").waitFor();
  check("unsupported trigger rejected on import");

  assert.deepEqual(errors, []);
  await page.screenshot({ path: artifactPath(`x01-${label}.png`) });
  await fs.writeFile(artifactPath(`x01-${label}.json`), JSON.stringify(report, null, 2) + "\n");
} finally {
  await browser.close();
}
