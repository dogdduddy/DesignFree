import { browserLaunchOptions } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

// Every case uses its own temporary context and browser storage, never a user profile.
const browser = await chromium.launch(browserLaunchOptions());
let page, context;
const errors = [];
const state = () => page.evaluate(() => window.__draftroom.getState());
const button = (name) => page.getByRole("button", { name, exact: true });
const alignments = [
  ["left", "왼쪽 정렬"],
  ["center-x", "가로 중앙 정렬"],
  ["right", "오른쪽 정렬"],
  ["top", "위쪽 정렬"],
  ["center-y", "세로 중앙 정렬"],
  ["bottom", "아래쪽 정렬"],
];
async function select(ids) {
  for (let i = 0; i < ids.length; i++) {
    await page
      .getByTestId("layer-" + ids[i])
      .locator(".layer-name")
      .click({ modifiers: i ? ["Shift"] : [] });
  }
}
async function saved() {
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="save-status"]')
        ?.getAttribute("data-state") === "saved",
  );
}
async function revision() {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("draftroom-local-drafts", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const read = db
            .transaction("drafts")
            .objectStore("drafts")
            .get("current");
          read.onsuccess = () => {
            resolve(read.result?.revision);
            db.close();
          };
          read.onerror = () => {
            reject(read.error);
            db.close();
          };
        };
      }),
  );
}
async function fresh(customize) {
  if (context) await context.close();
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/", {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="save-status"]')
        ?.getAttribute("data-state") !== "loading" && window.__draftroom,
  );
  const d = (await state()).document;
  const sample = Object.values(d.nodes).find((n) => n.type === "rectangle");
  const root = d.nodes[d.rootId];
  root.transform = [1, 0, 0, 1, 0, 0];
  root.width = 1000;
  root.height = 800;
  const make = (id, x, y, width, height, props = {}) => ({
    ...structuredClone(sample),
    id,
    name: id,
    parentId: root.id,
    children: [],
    transform: [1, 0, 0, 1, x, y],
    width,
    height,
    radius: 0,
    visible: true,
    locked: false,
    ...props,
  });
  const a = make("a", 100, 80, 70, 40),
    b = make("b", 250, 180, 120, 60),
    c = make("c", 470, 350, 50, 90);
  root.children = ["a", "b", "c"];
  d.nodes = { [root.id]: root, a, b, c };
  customize?.(d, make);
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles({
      name: "arrangement.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(d)),
    });
  await page.waitForFunction(
    () => window.__draftroom.getState().document.nodes.a,
  );
  await saved();
  // Import fits asynchronously, so wait for the stable view before pointer tests.
  await page.waitForTimeout(80);
  return (await state()).document;
}
function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
function world(d, id) {
  const n = d.nodes[id];
  return n.parentId ? multiply(world(d, n.parentId), n.transform) : n.transform;
}
function box(d, id) {
  const n = d.nodes[id],
    m = world(d, id);
  const corners = [
    [0, 0],
    [n.width, 0],
    [0, n.height],
    [n.width, n.height],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const x = Math.min(...corners.map((p) => p[0])),
    y = Math.min(...corners.map((p) => p[1]));
  return {
    x,
    y,
    width: Math.max(...corners.map((p) => p[0])) - x,
    height: Math.max(...corners.map((p) => p[1])) - y,
  };
}
const close = (actual, expected) =>
  assert(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
function alignmentValue(b, mode) {
  return mode === "left"
    ? b.x
    : mode === "right"
      ? b.x + b.width
      : mode === "center-x"
        ? b.x + b.width / 2
        : mode === "top"
          ? b.y
          : mode === "bottom"
            ? b.y + b.height
            : b.y + b.height / 2;
}
function assertAlignment(before, after, ids, mode) {
  const boxes = ids.map((id) => box(before, id));
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  const union = {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
  const expected = alignmentValue(union, mode);
  for (const id of ids) {
    close(alignmentValue(box(after, id), mode), expected);
    const n = after.nodes[id],
      original = before.nodes[id];
    assert.deepEqual(n.transform.slice(0, 4), original.transform.slice(0, 4));
    assert.equal(n.width, original.width);
    assert.equal(n.height, original.height);
  }
}
async function check(name, fn) {
  await fn();
  console.log("PASS " + name);
}
try {
  for (const [mode, name] of alignments) {
    await check(
      `${mode}: align selected unequal boxes to their union`,
      async () => {
        const before = await fresh();
        await select(["a", "b", "c"]);
        assert.equal(await page.getByTestId("arrange-controls").count(), 1);
        assert.deepEqual((await state()).document, before);
        await button(name).click();
        const after = await state();
        assertAlignment(before, after.document, ["a", "b", "c"], mode);
        assert.deepEqual(after.selection, ["a", "b", "c"]);
        await button("실행 취소").click();
        assert.deepEqual((await state()).document, before);
        assert(await button("실행 취소").isDisabled());
        await button("다시 실행").click();
        assert.deepEqual((await state()).document, after.document);
      },
    );
  }
  for (const axis of ["x", "y"]) {
    await check(
      `${axis}: equal edge gaps, fixed endpoints and unchanged other axis`,
      async () => {
        const before = await fresh();
        await select(["c", "a", "b"]);
        await button(
          axis === "x" ? "가로 간격 균등" : "세로 간격 균등",
        ).click();
        const after = (await state()).document,
          extent = axis === "x" ? "width" : "height";
        assert.deepEqual(after.nodes.a, before.nodes.a);
        assert.deepEqual(after.nodes.c, before.nodes.c);
        const [a, b, c] = ["a", "b", "c"].map((id) => box(after, id));
        close(b[axis] - a[axis] - a[extent], c[axis] - b[axis] - b[extent]);
        close(
          b[axis === "x" ? "y" : "x"],
          box(before, "b")[axis === "x" ? "y" : "x"],
        );
        assert.notDeepEqual(after.nodes.b, before.nodes.b);
      },
    );
  }
  await check(
    "one undo/redo and autosave restore after reload; no-op preserves revision/history/selection/focus",
    async () => {
      const before = await fresh();
      await select(["a", "b", "c"]);
      const focus = page.getByLabel("렌더러 선택", { exact: true });
      await focus.focus();
      await button("왼쪽 정렬").click();
      assert(await focus.evaluate((el) => el === document.activeElement));
      const after = await state();
      await saved();
      const firstRevision = await revision();
      await button("왼쪽 정렬").click();
      await page.waitForTimeout(450);
      assert.equal(await revision(), firstRevision);
      assert.deepEqual((await state()).selection, after.selection);
      await button("실행 취소").click();
      assert.deepEqual((await state()).document, before);
      assert(await button("실행 취소").isDisabled());
      await button("다시 실행").click();
      assert.deepEqual((await state()).document, after.document);
      await saved();
      await page.reload({ waitUntil: "networkidle" });
      await saved();
      assert.deepEqual((await state()).document, after.document);
      assert(await button("실행 취소").isDisabled());
    },
  );
  await check(
    "parent-child selection moves subtree once; distinct affine parents retain world alignment",
    async () => {
      const before = await fresh((d, make) => {
        const root = d.nodes[d.rootId];
        d.nodes.p = make("p", 50, 100, 180, 170, {
          type: "frame",
          transform: [1.2, 0.3, -0.2, 0.9, 50, 100],
          children: ["a"],
          clipContent: false,
        });
        d.nodes.q = make("q", 500, 180, 220, 240, {
          type: "frame",
          transform: [0.8, -0.4, 0.3, 1.1, 500, 180],
          children: ["b"],
          clipContent: false,
        });
        d.nodes.a.parentId = "p";
        d.nodes.b.parentId = "q";
        root.children = ["p", "q", "c"];
      });
      await select(["p", "a", "b"]);
      assert.match(
        await page.getByTestId("arrange-controls").textContent(),
        /2개 대상/,
      );
      assert(await button("가로 간격 균등").isDisabled());
      await button("오른쪽 정렬").click();
      const after = (await state()).document;
      assertAlignment(before, after, ["p", "b"], "right");
      assert.deepEqual(after.nodes.a, before.nodes.a);
      assert.deepEqual(after.nodes.q, before.nodes.q);
      assert.deepEqual((await state()).selection, ["p", "a", "b"]);
    },
  );
  await check(
    "hidden and locked ancestors are excluded from count, union and movement",
    async () => {
      const before = await fresh((d, make) => {
        const root = d.nodes[d.rootId];
        d.nodes.hidden = make("hidden", -500, -300, 80, 60, {
          visible: false,
          type: "frame",
          children: ["hidden-child"],
        });
        d.nodes["hidden-child"] = make("hidden-child", 10, 10, 30, 20, {
          parentId: "hidden",
        });
        d.nodes.locked = make("locked", 900, 700, 80, 60, {
          locked: true,
          type: "frame",
          children: ["locked-child"],
        });
        d.nodes["locked-child"] = make("locked-child", 10, 10, 30, 20, {
          parentId: "locked",
        });
        root.children.push("hidden", "locked");
      });
      await select(["a", "hidden-child", "locked-child"]);
      assert(await button("왼쪽 정렬").isDisabled());
      assert(await button("가로 간격 균등").isDisabled());
      assert.match(
        await page.getByTestId("arrange-controls").textContent(),
        /1개 대상/,
      );
      await page
        .getByTestId("layer-b")
        .locator(".layer-name")
        .click({ modifiers: ["Shift"] });
      assert(!(await button("왼쪽 정렬").isDisabled()));
      assert(await button("가로 간격 균등").isDisabled());
      await button("왼쪽 정렬").click();
      const after = (await state()).document;
      assertAlignment(before, after, ["a", "b"], "left");
      for (const id of [
        "hidden",
        "hidden-child",
        "locked",
        "locked-child",
        "c",
      ])
        assert.deepEqual(after.nodes[id], before.nodes[id]);
    },
  );
  await check(
    "single selection disables all actions; pointer transaction disables arrangement without extra edits",
    async () => {
      const before = await fresh();
      await select(["a"]);
      for (const [, name] of alignments)
        assert(await button(name).isDisabled());
      assert(await button("가로 간격 균등").isDisabled());
      assert(await button("세로 간격 균등").isDisabled());
      await select(["a", "b", "c"]);
      const current = await state(),
        r = await page.getByTestId("canvas-stage").boundingBox();
      await page.mouse.move(
        r.x + current.viewport.x + 130 * current.viewport.zoom,
        r.y + current.viewport.y + 100 * current.viewport.zoom,
      );
      await page.mouse.down();
      assert(await button("왼쪽 정렬").isDisabled());
      assert(await button("가로 간격 균등").isDisabled());
      await button("왼쪽 정렬").evaluate((el) => el.click());
      assert.deepEqual((await state()).document, before);
      await page.mouse.up();
      assert(!(await button("왼쪽 정렬").isDisabled()));
      assert(await button("실행 취소").isDisabled());
      await button("왼쪽 정렬").click();
      assertAlignment(
        before,
        (await state()).document,
        ["a", "b", "c"],
        "left",
      );
    },
  );
  for (const axis of ["x", "y"]) {
    await check(
      `${axis}: impossible overlap disables distribution with explanation and no history/save`,
      async () => {
        const before = await fresh((d) => {
          const extent = axis === "x" ? "width" : "height";
          ["a", "b", "c"].forEach((id, index) => {
            d.nodes[id][extent] = index ? 1 : 200;
            d.nodes[id].transform[axis === "x" ? 4 : 5] = index * 10;
          });
        });
        await select(["a", "b", "c"]);
        const control = button(
          axis === "x" ? "가로 간격 균등" : "세로 간격 균등",
        );
        assert(await control.isDisabled());
        assert.match(
          await control.getAttribute("title"),
          /양 끝과 순서를 유지할 공간이 부족/,
        );
        assert.match(
          await page.getByTestId("arrange-controls").textContent(),
          /양 끝과 순서를 유지할 공간이 부족/,
        );
        assert(
          !(await button(
            axis === "x" ? "세로 간격 균등" : "가로 간격 균등",
          ).isDisabled()),
        );
        const initialRevision = await revision();
        await control.evaluate((el) => el.click());
        await page.waitForTimeout(450);
        assert.deepEqual((await state()).document, before);
        assert.deepEqual((await state()).selection, ["a", "b", "c"]);
        assert(await button("실행 취소").isDisabled());
        assert.equal(await revision(), initialRevision);
      },
    );
  }
  await check(
    "ordinary negative gap remains available, stable and undoable",
    async () => {
      const before = await fresh((d) => {
        d.nodes.a.width = d.nodes.b.width = d.nodes.c.width = 100;
        d.nodes.a.transform[4] = 0;
        d.nodes.b.transform[4] = 25;
        d.nodes.c.transform[4] = 80;
      });
      await select(["a", "b", "c"]);
      assert(!(await button("가로 간격 균등").isDisabled()));
      await button("가로 간격 균등").click();
      const after = (await state()).document;
      close(after.nodes.b.transform[4], 40);
      assert.deepEqual(after.nodes.a, before.nodes.a);
      assert.deepEqual(after.nodes.c, before.nodes.c);
      await saved();
      const initialRevision = await revision();
      await button("가로 간격 균등").click();
      await page.waitForTimeout(450);
      assert.deepEqual((await state()).document, after);
      assert.equal(await revision(), initialRevision);
      await button("실행 취소").click();
      assert.deepEqual((await state()).document, before);
      assert(await button("실행 취소").isDisabled());
    },
  );
  await check(
    "active text editing blocks arrangement despite three eligible selections",
    async () => {
      const before = await fresh((d) => {
        d.nodes.a.type = "text";
        d.nodes.a.text = {
          content: "편집",
          fontFamily: "Noto Sans KR",
          fontSize: 18,
          fontWeight: 400,
          lineHeight: 24,
        };
      });
      await page.getByTestId("layer-a").locator(".layer-name").dblclick();
      const editor = page.getByLabel("텍스트 직접 편집", { exact: true });
      await editor.fill("아직 편집 중");
      // Dispatch selection clicks without blurring the active text editor, so the
      // editing guard is exercised independently of the single-selection threshold.
      for (const id of ["b", "c"])
        await page
          .getByTestId("layer-" + id)
          .evaluate((el) =>
            el.dispatchEvent(
              new MouseEvent("click", { bubbles: true, shiftKey: true }),
            ),
          );
      assert.equal(await editor.count(), 1);
      assert.match(
        await page.getByTestId("arrange-controls").textContent(),
        /3개 대상/,
      );
      for (const [, name] of alignments)
        assert(await button(name).isDisabled());
      assert(await button("가로 간격 균등").isDisabled());
      await button("왼쪽 정렬").evaluate((el) => el.click());
      assert.deepEqual((await state()).document, before);
      assert(await button("실행 취소").isDisabled());
      await editor.press("Escape");
      assert(!(await button("왼쪽 정렬").isDisabled()));
      await button("왼쪽 정렬").click();
      assertAlignment(
        before,
        (await state()).document,
        ["a", "b", "c"],
        "left",
      );
    },
  );
  assert.deepEqual(errors, []);
} finally {
  await context?.close();
  await browser.close();
}
