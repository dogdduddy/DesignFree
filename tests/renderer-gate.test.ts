import { describe, it, expect } from "vitest";
import { rendererGate, textPixelsPass } from "../src/renderer-gate";
const ink = {
  inkMean: 0,
  reference: { count: 100, bounds: [1, 2, 10, 20] },
  candidate: { count: 100, bounds: [1, 2, 10, 20] },
};
describe("renderer gate evidence", () => {
  it("rejects invisible text even when global error would be diluted by background", () => {
    expect(
      textPixelsPass({ ...ink, candidate: { count: 0, bounds: null } }),
    ).toBe(false);
    expect(
      textPixelsPass({
        ...ink,
        candidate: { count: 100, bounds: [5, 2, 14, 20] },
      }),
    ).toBe(false);
  });
  const kinds = [
    ...[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => `weight-${w}`),
    "kerning",
    "korean",
    "combining",
    "arabic",
    "serif",
    "monospace",
    "missing",
    "positive-spacing",
    "negative-spacing",
    "wrap-center",
    "wrap-right",
    "overflow",
    "gradient-stroke",
    "affine",
    "empty",
  ];
  const empty = {
    inkMean: 0,
    reference: { count: 0, bounds: null },
    candidate: { count: 0, bounds: null },
  };
  const text = () => ({
    sourceFingerprint: "current",
    browser: "test",
    reports: [1, 2].map((dpr) => ({
      dpr,
      geometryPassed: true,
      errors: [],
      cases: kinds.map((kind) => ({
        kind,
        canvasKit: kind === "empty" ? empty : ink,
        png: kind === "empty" ? empty : ink,
      })),
    })),
  });
  const shapes = () => ({
    sourceFingerprint: "current",
    browser: "test",
    errors: [],
    cases: Array.from({ length: 15 }, () => ({
      meanAbsoluteChannelError: 0,
      pngMaxChannelError: 0,
      samples: [{ svg: [1, 2, 3, 255], ck: [1, 2, 3, 255] }],
    })),
  });
  it("requires both pixel families and all six measured cases", () => {
    expect(rendererGate(text(), shapes(), "current", "test", 6).passed).toBe(
      true,
    );
    expect(rendererGate(text(), shapes(), "current", "test", 5).passed).toBe(
      false,
    );
    expect(
      rendererGate(text(), { ...shapes(), cases: [] }, "current", "test", 6)
        .passed,
    ).toBe(false);
  });
  it("rejects stale source/browser evidence and missing named text fixtures", () => {
    expect(rendererGate(text(), shapes(), "changed", "test", 6).passed).toBe(
      false,
    );
    expect(rendererGate(text(), shapes(), "current", "other", 6).passed).toBe(
      false,
    );
    const t = text();
    t.reports[0].cases[0].kind = "duplicate";
    expect(rendererGate(t, shapes(), "current", "test", 6).passed).toBe(false);
  });
});
