import { describe, it, expect } from "vitest";
import CanvasKitInit from "canvaskit-wasm";
import { createNode } from "../src/core";
import { configureFill } from "../src/renderers/paint";

describe("CanvasKit raster fill pixel regression", () => {
  it("draws opaque normalized gradients and preserves transparent fill:none", async () => {
    const ck = await CanvasKitInit({
      locateFile: (name) =>
        decodeURIComponent(
          new URL(`../node_modules/canvaskit-wasm/bin/${name}`, import.meta.url)
            .pathname,
        ),
    });
    const surface = ck.MakeSurface(20, 10);
    expect(surface).not.toBeNull();
    if (!surface) throw new Error("CPU surface unavailable");
    const paint = new ck.Paint();
    let shader: ReturnType<typeof configureFill>;
    try {
      const canvas = surface.getCanvas();
      canvas.clear(ck.TRANSPARENT);
      const node = createNode("rectangle", null, {
        width: 20,
        height: 10,
        fill: {
          type: "linear",
          from: [0, 0],
          to: [1, 1],
          stops: [
            { offset: 0, color: "#ff0000" },
            { offset: 1, color: "#0000ff" },
          ],
        },
      });
      shader = configureFill(ck, paint, node);
      canvas.drawRect(ck.XYWHRect(0, 0, 20, 10), paint);
      surface.flush();
      const pixel = canvas.readPixels(10, 5, {
        width: 1,
        height: 1,
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      });
      expect(pixel).not.toBeNull();
      expect(pixel![3]).toBe(255);
      expect(pixel![0]).toBeGreaterThan(100);
      expect(pixel![2]).toBeGreaterThan(100);
      expect(pixel![1]).toBe(0);
      // Same normalized diagonal on a resized non-square node must recompute
      // its local-pixel endpoints. At the same pixel the red/blue mix changes.
      paint.setShader(null);
      shader?.delete();
      shader = undefined;
      canvas.clear(ck.TRANSPARENT);
      shader = configureFill(ck, paint, { ...node, width: 40 });
      canvas.drawRect(ck.XYWHRect(0, 0, 20, 10), paint);
      surface.flush();
      const resized = canvas.readPixels(10, 5, {
        width: 1,
        height: 1,
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      });
      expect(resized![3]).toBe(255);
      expect(resized![0]).toBeGreaterThan(170);
      expect(resized![2]).toBeLessThan(85);
      expect(resized![0]).toBeGreaterThan(pixel![0]);
      canvas.clear(ck.TRANSPARENT);
      paint.setShader(null);
      configureFill(ck, paint, { ...node, fill: { type: "none" } });
      canvas.drawRect(ck.XYWHRect(0, 0, 20, 10), paint);
      surface.flush();
      const transparent = canvas.readPixels(10, 5, {
        width: 1,
        height: 1,
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      });
      expect(transparent![3]).toBe(0);
    } finally {
      paint.delete();
      shader?.delete();
      surface.dispose();
    }
  });
});
