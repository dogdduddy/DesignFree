import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";

// P02: input and save latency plus memory for large and instance-heavy documents,
// through the real editor UI. Run the same fixtures against two builds to compare.
// EDITOR_URL is a Vite dev server used only to generate fixtures from source;
// DRAFTROOM_URL is the editor under test (dev or production preview).
const fixtureUrl = process.env.EDITOR_URL || "http://127.0.0.1:5173/";
const appUrl = process.env.DRAFTROOM_URL || fixtureUrl;
const label = process.env.P02_LABEL || "current";
const only = process.env.P02_FIXTURES?.split(",");
const SAMPLES = 18,
  WARMUP = 3;

const browser = await chromium.launch(browserLaunchOptions());
const report = {
  label,
  date: new Date().toISOString(),
  browser: browser.version(),
  appUrl,
  build: crypto
    .createHash("sha256")
    .update(await (await fetch(appUrl)).text())
    .digest("hex"),
  protocol:
    `${WARMUP} warmups + ${SAMPLES} samples per input. Latency is native pointer/keyboard capture to two RAF callbacks ` +
    "(React, model, history, autosave scheduling and SVG update; not presentation or FPS). CPU is the CDP " +
    "Performance ScriptDuration/LayoutDuration/RecalcStyleDuration delta over the whole scenario. Save is input " +
    "end to save-status 'saved' and includes the 200 ms autosave debounce and IndexedDB transaction. Memory is " +
    "CDP Runtime.getHeapUsage after HeapProfiler.collectGarbage (usedSize is JS heap, backingStorageSize is " +
    "ArrayBuffer backing stores) plus the byte length of every WebAssembly.Memory after switching the same " +
    "document to CanvasKit (linear memory capacity, not GPU or live native usage). Each fixture uses a fresh browser context and " +
    "IndexedDB. Desktop background load is uncontrolled.",
  fixtures: [],
  errors: [],
};

async function makeFixtures() {
  const page = await browser.newPage();
  await page.goto(new URL("bench.html", fixtureUrl).href, {
    waitUntil: "networkidle",
  });
  const docs = await page.evaluate(async () => {
    const core = await import("/src/core/index.ts");
    // Same front-most drag target as the S04 large-document UI script.
    const front = (doc) => {
      const t = doc.nodes["bench-4"];
      doc.nodes[t.parentId].children = doc.nodes[t.parentId].children.filter(
        (id) => id !== t.id,
      );
      t.parentId = doc.rootId;
      t.transform = [1, 0, 0, 1, 40, 40];
      t.width = 80;
      t.height = 60;
      doc.nodes[doc.rootId].children.push(t.id);
      return doc;
    };
    const mixed = (count) => front(core.createBenchmarkDocument(count));
    const groups = () => {
      // Every container becomes a group, so group bounds normalize on each edit.
      const doc = core.createBenchmarkDocument(10000);
      for (const id of doc.nodes[doc.rootId].children) {
        const f = doc.nodes[id];
        doc.nodes[id] = core.createNode("group", f.parentId, {
          id,
          name: `group ${id}`,
          transform: f.transform,
          width: f.width,
          height: f.height,
          children: f.children,
        });
      }
      return front(doc);
    };
    const instances = () => {
      // One 41-node main component and 100 expanded instances (4,100 nodes).
      const doc = core.createBenchmarkDocument(2000);
      const root = doc.nodes[doc.rootId];
      const source = core.createNode("frame", root.id, {
        id: "p02-source",
        name: "Card",
        width: 220,
        height: 120,
        transform: [1, 0, 0, 1, 0, 2000],
        component: { kind: "main" },
      });
      doc.nodes[source.id] = source;
      root.children.push(source.id);
      for (let i = 0; i < 40; i++) {
        const n = core.createNode("rectangle", source.id, {
          id: `p02-leaf-${i}`,
          width: 20,
          height: 20,
          transform: [1, 0, 0, 1, (i % 10) * 22, Math.floor(i / 10) * 22],
        });
        source.children.push(n.id);
        doc.nodes[n.id] = n;
      }
      const sourceIds = [source.id, ...source.children];
      for (let i = 0; i < 100; i++) {
        const id = `p02-instance-${i}`;
        const nodeMap = Object.fromEntries(
          sourceIds.map((sid) => [sid, sid === source.id ? id : `${id}-${sid}`]),
        );
        for (const sid of sourceIds) {
          const n = structuredClone(doc.nodes[sid]);
          n.id = nodeMap[sid];
          n.parentId = sid === source.id ? root.id : id;
          n.children = n.children.map((c) => nodeMap[c]);
          delete n.component;
          doc.nodes[n.id] = n;
        }
        const r = doc.nodes[id];
        r.transform = [1, 0, 0, 1, 240 + (i % 10) * 230, 2000 + Math.floor(i / 10) * 130];
        r.component = {
          kind: "instance",
          sourceId: source.id,
          nodeMap,
          overrides: { [source.id]: { transform: r.transform, name: r.name } },
        };
        root.children.push(id);
      }
      core.validateDocument(doc);
      return front(doc);
    };
    return {
      "mixed-1k": mixed(1000),
      "mixed-10k": mixed(10000),
      "groups-10k": groups(),
      "instances-6k": instances(),
    };
  });
  await page.close();
  return Object.entries(docs).filter(([name]) => !only || only.includes(name));
}

const summary = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return {
    p50: s[Math.ceil(s.length * 0.5) - 1],
    p95: s[Math.ceil(s.length * 0.95) - 1],
    samples: values,
  };
};

try {
  for (const [name, doc] of await makeFixtures()) {
    const json = JSON.stringify(doc);
    const fixture = {
      name,
      nodes: Object.keys(doc.nodes).length,
      fixtureBytes: Buffer.byteLength(json),
      fixtureFingerprint: crypto.createHash("sha256").update(json).digest("hex"),
      scenarios: {},
      memory: {},
    };
    console.log(`${label} ${name} (${fixture.nodes} nodes)`);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
    });
    // CDP heap usage does not include WebAssembly linear memory; record every
    // Memory the page creates or exports so CanvasKit can be measured.
    await context.addInitScript(() => {
      const Memory = WebAssembly.Memory;
      const memories = new Set();
      window.p02WasmBytes = () =>
        [...memories].reduce((sum, m) => sum + m.buffer.byteLength, 0);
      WebAssembly.Memory = function (descriptor) {
        const memory = new Memory(descriptor);
        memories.add(memory);
        return memory;
      };
      WebAssembly.Memory.prototype = Memory.prototype;
      for (const key of ["instantiate", "instantiateStreaming"]) {
        const original = WebAssembly[key];
        WebAssembly[key] = (...args) =>
          original.apply(WebAssembly, args).then((result) => {
            for (const value of Object.values(result.instance?.exports ?? {}))
              if (value instanceof Memory) memories.add(value);
            return result;
          });
      }
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${name}: ${e.message}`));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const heap = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      const { usedSize, backingStorageSize } = await cdp.send("Runtime.getHeapUsage");
      return { jsHeapBytes: usedSize, backingStoreBytes: backingStorageSize };
    };
    const cpu = async () => {
      const { metrics } = await cdp.send("Performance.getMetrics");
      const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
      return {
        script: m.ScriptDuration * 1000,
        layout: (m.LayoutDuration + m.RecalcStyleDuration) * 1000,
      };
    };
    const status = () =>
      page.evaluate(() => document.querySelector('[data-testid="save-status"]').dataset.state);
    const saved = () =>
      page.waitForFunction(
        () => document.querySelector('[data-testid="save-status"]').dataset.state === "saved",
        null,
        { timeout: 120000 },
      );
    const exported = async () => {
      const d = page.waitForEvent("download");
      await page.getByRole("button", { name: "JSON 저장", exact: true }).click();
      const chunks = [];
      for await (const c of await (await d).createReadStream()) chunks.push(c);
      return JSON.parse(Buffer.concat(chunks).toString());
    };
    await page.goto(appUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector('[data-testid="save-status"]').dataset.state !== "loading");
    fixture.memory.empty = await heap();
    const importStart = Date.now();
    await page.locator('input[type=file][accept="application/json,.json"]').setInputFiles({
      name: `${name}.json`,
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });
    await saved();
    fixture.importToSavedMs = Date.now() - importStart;
    const imported = await exported();
    assert.equal(Object.keys(imported.nodes).length, fixture.nodes);
    fixture.memory.imported = await heap();

    await page.evaluate(() => {
      const stage = document.querySelector('[data-testid="canvas-stage"]');
      window.p02 = { samples: [], measuring: false, saved: [] };
      const capture = () => {
        if (!window.p02.measuring) return;
        const t = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => window.p02.samples.push(performance.now() - t)),
        );
      };
      stage.addEventListener("pointermove", capture, { capture: true });
      window.addEventListener("keydown", capture, { capture: true });
      const el = document.querySelector('[data-testid="save-status"]');
      new MutationObserver(() => {
        if (el.dataset.state === "saved") window.p02.saved.push(performance.now());
      }).observe(el, { attributes: true, attributeFilter: ["data-state"] });
    });
    const settle = () =>
      page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const measure = async (scenario, action, after) => {
      await page.evaluate(() => {
        window.p02.samples = [];
        window.p02.measuring = true;
      });
      const before = await cpu();
      const start = Date.now();
      for (let i = 0; i < WARMUP + SAMPLES; i++) {
        await action(i);
        await settle();
      }
      await page.evaluate(() => (window.p02.measuring = false));
      const inputEnd = await page.evaluate(() => performance.now());
      const savedMs = after ? await after(inputEnd) : undefined;
      const end = await cpu();
      const values = await page.evaluate(() => window.p02.samples.slice(3));
      assert.equal(values.length, SAMPLES);
      fixture.scenarios[scenario] = {
        latencyMs: summary(values),
        wallMs: Date.now() - start,
        scriptMs: end.script - before.script,
        layoutAndStyleMs: end.layout - before.layout,
        ...(savedMs !== undefined ? { inputEndToSavedMs: savedMs } : {}),
      };
    };
    const waitSaved = async (inputEnd) => {
      await page.waitForFunction(
        (t) => window.p02.saved.some((s) => s > t),
        inputEnd,
        { timeout: 120000 },
      );
      return page.evaluate((t) => window.p02.saved.find((s) => s > t) - t, inputEnd);
    };

    const box = await page.getByTestId("canvas-stage").boundingBox();
    const view = await page.locator(".renderer-surface svg > g").getAttribute("transform");
    const [vx, vy, z] = view.match(/-?[\d.]+/g).map(Number);
    const x = box.x + vx + 60 * z,
      y = box.y + vy + 60 * z;

    // Hover: pointer moves without a gesture must not touch the document.
    await page.mouse.move(box.x + box.width - 80, box.y + box.height - 80);
    await measure("hover", (i) =>
      page.mouse.move(box.x + box.width - 80 - i, box.y + box.height - 80),
    );
    assert.deepEqual((await exported()).nodes, imported.nodes);

    // Drag: one gesture of 21 previews, committed once on release.
    await page.mouse.move(x, y);
    await page.keyboard.down("Meta");
    await page.mouse.down();
    await measure(
      "drag",
      (i) => page.mouse.move(x + i + 1, y),
      async () => {
        const t = await page.evaluate(() => performance.now());
        await page.mouse.up();
        await page.keyboard.up("Meta");
        return waitSaved(t);
      },
    );
    const dragged = await exported();
    assert.notDeepEqual(dragged.nodes["bench-4"].transform, imported.nodes["bench-4"].transform);
    await page.keyboard.press("Meta+z");
    await saved();
    assert.deepEqual((await exported()).nodes, imported.nodes, "drag is one Undo step");
    await page.keyboard.press("Meta+Shift+z");
    await saved();
    assert.deepEqual((await exported()).nodes, dragged.nodes);

    // Nudge: every key press is its own history step and autosave.
    assert.equal(await status(), "saved");
    await measure(
      "nudge",
      () => page.keyboard.press("ArrowRight"),
      (inputEnd) => waitSaved(inputEnd),
    );
    const nudged = await exported();
    assert.equal(
      nudged.nodes["bench-4"].transform[4],
      dragged.nodes["bench-4"].transform[4] + WARMUP + SAMPLES,
    );
    fixture.memory.afterEdits = await heap();

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector('[data-testid="save-status"]').dataset.state === "saved");
    assert.deepEqual((await exported()).nodes, nudged.nodes, "autosave reload");

    // CanvasKit loads WebAssembly; record its backing store for the same document.
    await page.getByLabel("렌더러 선택").selectOption("canvaskit");
    await page.waitForFunction(() => document.querySelector(".renderer-surface canvas"), null, { timeout: 60000 });
    await page.waitForTimeout(1000);
    fixture.memory.canvaskit = {
      ...(await heap()),
      wasmLinearMemoryBytes: await page.evaluate(() => window.p02WasmBytes()),
    };
    assert(fixture.memory.canvaskit.wasmLinearMemoryBytes > 0, "CanvasKit memory recorded");
    await context.close();
    report.fixtures.push(fixture);
  }
  assert.deepEqual(report.errors, []);
  await fs.writeFile(
    process.env.P02_REPORT || artifactPath(`p02-${label}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
  for (const f of report.fixtures)
    console.log(
      JSON.stringify({
        fixture: f.name,
        nodes: f.nodes,
        fingerprint: f.fixtureFingerprint.slice(0, 12),
        ...Object.fromEntries(
          Object.entries(f.scenarios).map(([k, v]) => [
            k,
            {
              p50: +v.latencyMs.p50.toFixed(1),
              p95: +v.latencyMs.p95.toFixed(1),
              script: Math.round(v.scriptMs),
              ...(v.inputEndToSavedMs ? { saved: Math.round(v.inputEndToSavedMs) } : {}),
            },
          ]),
        ),
        heapMB: +(f.memory.afterEdits.jsHeapBytes / 2 ** 20).toFixed(1),
      }),
    );
} finally {
  await browser.close();
}
