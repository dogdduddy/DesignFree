import { createRoot } from "react-dom/client";
import { useState } from "react";
import { runRendererBenchmarks } from "./benchmark";
import { SceneRenderer } from "./renderers";
import { createDemoDocument } from "./core";
const reference = createDemoDocument();
function Lab() {
  const [status, setStatus] = useState("Ready"),
    [running, setRunning] = useState(false),
    [report, setReport] = useState<unknown>();
  return (
    <main>
      <h1>Renderer engineering lab</h1>
      <p>
        Local SVG DOM and CanvasKit WebGL candidate (explicit CPU fallback).
        Same 1024 × 768 CSS viewport, current DPR, deterministic scenes, 3
        warmups and 18 samples per operation. Keep this tab visible.
      </p>
      <p>
        Timing means synchronous update wall time and RAF intervals. It does not
        measure total GPU time or guarantee FPS. SVG PNG export uses browser SVG
        rasterization. Text shares browser shaping and real font weights; CanvasKit composites
        bounded browser-raster text tiles.
      </p>
      <button
        disabled={running}
        onClick={async () => {
          setRunning(true);
          try {
            setReport(await runRendererBenchmarks(setStatus));
          } catch (e) {
            setStatus(String(e));
          } finally {
            setRunning(false);
          }
        }}
      >
        Run benchmarks
      </button>{" "}
      <button
        disabled={!report}
        onClick={() => {
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(report, null, 2)], {
              type: "application/json",
            }),
          );
          const a = document.createElement("a");
          a.href = url;
          a.download = "renderer-benchmark.json";
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        Download JSON
      </button>
      <p role="status">{status}</p>
      <p>
        <strong>T0 renderer gate: fixture evidence required.</strong> Review both scenes for
        text, nested transforms, clipping, strokes, image, gradient and opacity.
        Record discrepancies; timing completion is separate from visual parity.
      </p>
      <div className="references">
        {(["svg", "canvaskit"] as const).map((renderer) => (
          <section key={renderer}>
            <h2>{renderer}</h2>
            <div className="scene">
              <SceneRenderer
                renderer={renderer}
                document={reference}
                viewport={{ x: 10, y: 10, zoom: 0.7 }}
                width={1024}
                height={768}
                onError={(message) => setStatus(`${renderer}: ${message}`)}
              />
            </div>
          </section>
        ))}
      </div>
      <pre>
        {report ? JSON.stringify(report, null, 2) : "No measured report yet."}
      </pre>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Lab />);
