export interface RendererEvidence {
  sourceFingerprint: string;
  browser: string;
  errors?: unknown[];
  cases?: {
    meanAbsoluteChannelError: number;
    pngMaxChannelError: number;
    samples: { svg: number[]; ck: number[] }[];
  }[];
  reports?: {
    dpr: number;
    geometryPassed: boolean;
    errors: unknown[];
    cases: { kind: string; canvasKit: InkComparison; png: InkComparison }[];
  }[];
}
interface InkComparison {
  inkMean: number;
  reference: { count: number; bounds: number[] | null };
  candidate: { count: number; bounds: number[] | null };
}
export function textPixelsPass(p: InkComparison, empty = false) {
  if (empty) return p.reference.count === 0 && p.candidate.count === 0;
  return (
    p.reference.count > 20 &&
    p.candidate.count / p.reference.count > 0.9 &&
    p.candidate.count / p.reference.count < 1.1 &&
    p.inkMean < 8 &&
    p.reference.bounds !== null &&
    p.candidate.bounds !== null &&
    p.reference.bounds.every(
      (v, i) => Math.abs(v - p.candidate.bounds![i]) <= 2,
    )
  );
}
/** Evidence is fixture-scoped; timing completion never substitutes for pixels. */
export function rendererGate(
  text: RendererEvidence,
  shapes: RendererEvidence,
  fingerprint: string,
  browser: string,
  measured: number,
) {
  const sameBuild = [text, shapes].every(
    (e) => e.sourceFingerprint === fingerprint && e.browser === browser,
  );
  const required = [
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
  const textPassed =
    text.reports?.length === 2 &&
    [1, 2].every((dpr) =>
      text.reports?.some(
        (r) =>
          r.dpr === dpr &&
          r.errors.length === 0 &&
          r.geometryPassed &&
          required.every((kind) => r.cases.some((c) => c.kind === kind)) &&
          r.cases.every(
            (c) =>
              textPixelsPass(c.canvasKit, c.kind === "empty") &&
              textPixelsPass(c.png, c.kind === "empty"),
          ),
      ),
    );
  const shapePassed =
    shapes.errors?.length === 0 &&
    shapes.cases?.length === 15 &&
    shapes.cases.every(
      (c) =>
        c.meanAbsoluteChannelError < 1.5 &&
        c.pngMaxChannelError === 0 &&
        c.samples.every((s) =>
          s.svg.every((v, i) => Math.abs(v - s.ck[i]) <= 5),
        ),
    );
  return {
    passed: Boolean(sameBuild && textPassed && shapePassed && measured === 6),
    sameBuild,
    textPassed: Boolean(textPassed),
    shapePassed: Boolean(shapePassed),
    measuredCases: measured,
    scope:
      "Current source, browser, DPR1/2 text and DPR1 common shape fixtures only; browser-raster text bridge, not native Skia shaping or cross-platform certification",
  };
}
