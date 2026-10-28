import { browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { sourceFingerprint } from "./renderer-evidence.mjs";
const browser = await chromium.launch(browserLaunchOptions());
const report = {
  date: new Date().toISOString(),
  browser: browser.version(),
  fingerprint: await sourceFingerprint(),
  protocol: {
    samples: 18,
    warmup: 3,
    historyCommits: 30,
    viewport: [1024, 768],
    historyMemory:
      "CDP Runtime.getHeapUsage after HeapProfiler.collectGarbage, isolated page per size; JS heap only, excludes GPU/native/WASM. Includes current history/document and patches.",
    timing:
      "Renderer sync update and RAF interval; drag pipeline includes updateNodes, history.preview and defensive document getter. Not input-to-presentation latency or FPS.",
    backgroundLoad: "Desktop background load uncontrolled",
  },
  cases: [],
  history: [],
  errors: [],
};
try {
  for (const count of [1000, 10000]) {
    const p = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
      deviceScaleFactor: 1,
    });
    p.on("pageerror", (e) => report.errors.push(e.message));
    await p.goto(new URL("bench.html", process.env.EDITOR_URL || process.env.DRAFTROOM_URL || "http://127.0.0.1:5173/").href, {
      waitUntil: "networkidle",
    });
    const cdp = await p.context().newCDPSession(p);
    await p.evaluate(async (count) => {
      const core = await import("/src/core/index.ts");
      const renderers = await import("/src/renderers/index.tsx");
      await document.fonts.ready;
      document.querySelector("#root").remove();
      const fixture = core.createBenchmarkDocument(count);
      window.lab = { core, renderers, fixture };
    }, count);
    for (const renderer of ["svg", "canvaskit"]) {
      console.log(`${count} ${renderer}`);
      const result = await p.evaluate(async (renderer) => {
        const { core, renderers, fixture: doc } = window.lab;
        const host = document.createElement("div");
        document.body.append(host);
        Object.assign(host.style, {
          position: "fixed",
          inset: 0,
          width: "1024px",
          height: "768px",
          background: "white",
        });
        const engine = await renderers.createRenderer(
          renderer,
          host,
          1024,
          768,
        );
        const raf = () => new Promise((r) => requestAnimationFrame(r));
        const summary = (values) => {
          const s = [...values].sort((a, b) => a - b);
          return {
            p50: s[Math.ceil(s.length * 0.5) - 1],
            p95: s[Math.ceil(s.length * 0.95) - 1],
            samples: values,
          };
        };
        engine.update(doc, { x: 0, y: 0, zoom: 1 });
        await raf();
        await raf();
        const operations = {};
        for (const op of ["pan", "zoom", "drag"]) {
          const sync = [],
            interval = [],
            pipeline = [];
          const h = new core.DocumentHistory(doc);
          h.beginTransaction();
          for (let i = -3; i < 18; i++) {
            const k = i + 4,
              v =
                op === "zoom"
                  ? { x: -k, y: -k, zoom: 1 + k * 0.01 }
                  : op === "pan"
                    ? { x: -k * 3, y: -k * 2, zoom: 1 }
                    : { x: 0, y: 0, zoom: 1 };
            const before = await raf(),
              begin = performance.now();
            let scene = doc;
            if (op === "drag") {
              const id = doc.nodes[doc.rootId].children[0],
                n = doc.nodes[id];
              h.preview(
                core.updateNodes(doc, {
                  [id]: {
                    transform: [
                      ...n.transform.slice(0, 4),
                      n.transform[4] + k * 2,
                      n.transform[5] + k,
                    ],
                  },
                }),
              );
              scene = h.document;
            }
            const renderStart = performance.now();
            engine.update(scene, v);
            const end = performance.now(),
              after = await raf();
            if (i >= 0) {
              sync.push(end - renderStart);
              pipeline.push(end - begin);
              interval.push(after - before);
            }
          }
          h.cancelTransaction();
          operations[op] = {
            synchronousUpdateWallMs: summary(sync),
            modelHistoryAndRendererMs: summary(pipeline),
            rafIntervalMs: summary(interval),
          };
        }
        const renderedElements = host.querySelectorAll("*").length,
          info = engine.info;
        engine.destroy();
        host.remove();
        return { renderer, operations, renderedElements, info };
      }, renderer);
      report.cases.push({ count, ...result });
    }
    await cdp.send("HeapProfiler.collectGarbage");
    const before = (await cdp.send("Runtime.getHeapUsage")).usedSize;
    const metrics = await p.evaluate(() => {
      const { core, fixture } = window.lab;
      const h = new core.DocumentHistory(fixture);
      window.lab.history = h;
      const id = fixture.nodes[fixture.rootId].children[0];
      const times = [];
      for (let i = 0; i < 30; i++) {
        const t = performance.now();
        h.execute(
          core.updateNodes(h.document, { [id]: { name: `History ${i}` } }),
        );
        times.push(performance.now() - t);
      }
      const end = h.document;
      for (let i = 0; i < 30; i++) h.undo();
      if (JSON.stringify(h.document) !== JSON.stringify(fixture))
        throw Error("History Undo mismatch");
      for (let i = 0; i < 30; i++) h.redo();
      if (JSON.stringify(h.document) !== JSON.stringify(end))
        throw Error("History Redo mismatch");
      return { commitMs: times, statistics: h.statistics ?? null };
    });
    await cdp.send("HeapProfiler.collectGarbage");
    const after = (await cdp.send("Runtime.getHeapUsage")).usedSize;
    report.history.push({
      count,
      commits: 30,
      heapBeforeBytes: before,
      heapAfterBytes: after,
      retainedHeapDeltaBytes: after - before,
      ...metrics,
    });
    await p.close();
  }
  assert.deepEqual(report.errors, []);
  assert.equal(report.cases.length, 4);
  await fs.writeFile(
    process.env.LARGE_DOCUMENT_REPORT || artifactPath("65-large-document-validation.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        ...report,
        cases: report.cases.map((c) => ({
          count: c.count,
          renderer: c.renderer,
          ops: Object.fromEntries(
            Object.entries(c.operations).map(([k, v]) => [
              k,
              {
                syncP95: v.synchronousUpdateWallMs.p95,
                pipelineP95: v.modelHistoryAndRendererMs.p95,
              },
            ]),
          ),
        })),
        history: report.history.map(({ commitMs, ...h }) => h),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
