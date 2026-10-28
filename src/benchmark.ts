import {
  createBenchmarkDocument,
  getWorldBounds,
  type SceneDocument,
  type Viewport,
} from "./core";
import { ensureDocumentAssets } from "./renderers/svg";
import { createRenderer, type RendererKind } from "./renderers";
const WIDTH = 1024,
  HEIGHT = 768,
  SAMPLES = 18,
  WARMUP = 3;
const frame = () =>
  new Promise<number>((resolve) => requestAnimationFrame(resolve));
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples: values,
  };
};
function counts(doc: SceneDocument, v: Viewport) {
  let visible = 0,
    intersects = 0;
  const byType: Record<string, number> = {};
  for (const node of Object.values(doc.nodes)) {
    byType[node.type] = (byType[node.type] || 0) + 1;
    let parent: typeof node | undefined = node;
    let shown = true;
    while (parent) {
      if (!parent.visible) {
        shown = false;
        break;
      }
      parent = parent.parentId ? doc.nodes[parent.parentId] : undefined;
    }
    if (!shown) continue;
    visible++;
    const b = getWorldBounds(doc, node.id);
    if (
      (b.x + b.width) * v.zoom + v.x >= 0 &&
      b.x * v.zoom + v.x <= WIDTH &&
      (b.y + b.height) * v.zoom + v.y >= 0 &&
      b.y * v.zoom + v.y <= HEIGHT
    )
      intersects++;
  }
  return {
    nodeCount: Object.keys(doc.nodes).length,
    visibleAncestorNodeCount: visible,
    viewportAabbIntersectionCount: intersects,
    viewportCountCaveat:
      "Conservative transformed AABBs; ignores ancestor clip occlusion",
    byType,
  };
}
export async function runRendererBenchmarks(
  progress: (message: string) => void = () => {},
) {
  if (document.visibilityState !== "visible")
    throw new Error(
      "Keep benchmark tab visible: RAF is throttled in hidden tabs",
    );
  const memory = () => {
    const m = (
      performance as Performance & {
        memory?: {
          usedJSHeapSize: number;
          totalJSHeapSize: number;
          jsHeapSizeLimit: number;
        };
      }
    ).memory;
    return m
      ? {
          ...{
            usedJSHeapSize: m.usedJSHeapSize,
            totalJSHeapSize: m.totalJSHeapSize,
            jsHeapSizeLimit: m.jsHeapSizeLimit,
          },
          scope:
            "Chromium JS heap only; excludes native Skia/WASM/GPU allocations",
        }
      : "unavailable";
  };
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    environment: {
      userAgent: navigator.userAgent,
      dpr: devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB:
        (
          navigator as Navigator & {
            deviceMemory?: number;
          }
        ).deviceMemory ?? "unavailable",
      viewport: { width: WIDTH, height: HEIGHT },
      visibility: document.visibilityState,
    },
    protocol: {
      samplesPerOperation: SAMPLES,
      warmupPerOperation: WARMUP,
      order: "SVG then CanvasKit; each 100,1000,10000 nodes",
      cpuMetric:
        "performance.now around synchronous renderer update (DOM mutation vs CPU Skia draw+flush); not GPU time",
      frameMetric:
        "RAF timestamp before update to next RAF timestamp; scheduling interval, not FPS or proof of presentation",
      loadMetric:
        "engine/font/WASM initialization + first scene update + two RAF; warm caches shared across cases",
      memoryMetric:
        "JS heap snapshots only if browser exposes performance.memory",
      operations:
        "pan and zoom viewport; drag one non-root node via immutable nodes-map copy; document copy outside measured update",
    },
    rendererGate: {
      passed: false,
      reason:
        "Timing-only run: attach current text and common-shape pixel/geometry fixture reports with tests/benchmark.e2e.mjs to evaluate the renderer gate.",
    },
    cases: [] as Array<Record<string, unknown>>,
    memoryBefore: memory(),
    memoryAfter: memory(),
  };
  const host = document.createElement("div");
  host.id = "benchmark-measurement-surface";
  Object.assign(host.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${WIDTH}px`,
    height: `${HEIGHT}px`,
    background: "#fff",
    zIndex: "9999",
    pointerEvents: "none",
  });
  document.body.append(host);
  try {
    for (const renderer of ["svg", "canvaskit"] as RendererKind[])
      for (const size of [100, 1000, 10000]) {
        progress(`${renderer} · ${size.toLocaleString()} nodes`);
        const doc = createBenchmarkDocument(size);
        const viewport = { x: 0, y: 0, zoom: 1 };
        let engine: Awaited<ReturnType<typeof createRenderer>> | undefined;
        try {
          const started = performance.now();
          await ensureDocumentAssets(doc);
          engine = await createRenderer(renderer, host, WIDTH, HEIGHT);
          engine.update(doc, viewport);
          await frame();
          await frame();
          const loadToTwoRafMs = performance.now() - started;
          const entry: Record<string, unknown> = {
            renderer,
            ...counts(doc, viewport),
            loadToTwoRafMs,
            backend: engine.info,
            operations: {},
            status: "running",
          };
          for (const operation of ["pan", "zoom", "drag"] as const) {
            const cpu: number[] = [],
              interval: number[] = [];
            const id = doc.nodes[doc.rootId].children[0];
            for (let i = -WARMUP; i < SAMPLES; i++) {
              const k = i + WARMUP + 1;
              let scene = doc;
              let v = viewport;
              if (operation === "pan") v = { x: -k * 3, y: -k * 2, zoom: 1 };
              if (operation === "zoom")
                v = { x: -k, y: -k, zoom: 1 + k * 0.01 };
              if (operation === "drag") {
                const node = doc.nodes[id];
                scene = {
                  ...doc,
                  nodes: {
                    ...doc.nodes,
                    [id]: {
                      ...node,
                      transform: [
                        ...node.transform.slice(0, 4),
                        node.transform[4] + k * 2,
                        node.transform[5] + k,
                      ] as typeof node.transform,
                    },
                  },
                };
              }
              const before = await frame();
              const begin = performance.now();
              engine.update(scene, v);
              const end = performance.now();
              const after = await frame();
              if (document.visibilityState !== "visible")
                throw new Error(
                  "Tab became hidden; discard this case and rerun",
                );
              if (i >= 0) {
                cpu.push(end - begin);
                interval.push(after - before);
              }
            }
            (entry.operations as Record<string, unknown>)[operation] = {
              synchronousUpdateWallMs: summary(cpu),
              rafIntervalMs: summary(interval),
            };
          }
          entry.status = "measured";
          entry.memoryAfterCase = memory();
          report.cases.push(entry);
        } catch (error) {
          report.cases.push({
            renderer,
            requestedNodeCount: size,
            status: "failed",
            error: String(error),
          });
        } finally {
          engine?.destroy();
          host.replaceChildren();
        }
      }
  } finally {
    host.remove();
  }
  report.memoryAfter = memory();
  progress("Finished; inspect failures and renderer gate in report.");
  return report;
}
declare global {
  interface Window {
    runRendererBenchmarks: typeof runRendererBenchmarks;
  }
}
window.runRendererBenchmarks = runRendererBenchmarks;
