import { describe, expect, it } from "vitest";
import { textRasterBounds } from "../src/renderers/text-raster";

describe("text bitmap scale and overflow regression", () => {
  it("retains negative overhang and descenders while aligning the sample grid", () => {
    const b = textRasterBounds(-3.2, -5.3, 125.1, 80.8, 2);
    expect(b.left).toBe(-3.5);
    expect(b.top).toBe(-5.5);
    expect(b.left + b.pixelWidth / b.scale).toBeGreaterThanOrEqual(125.1);
    expect(b.top + b.pixelHeight / b.scale).toBeGreaterThanOrEqual(80.8);
  });
  it.each([
    [1e6, 1e6],
    [1e9, 1],
    [1, 1e9],
    [100, 100],
  ])("bounds temporary allocations for %s x %s", (w, h) => {
    const b = textRasterBounds(-1.3, -2.1, w, h, 200);
    expect(b.pixelWidth).toBeLessThanOrEqual(4096);
    expect(b.pixelHeight).toBeLessThanOrEqual(4096);
    expect(b.pixelWidth * b.pixelHeight).toBeLessThanOrEqual(4_000_000);
  });
});
