import type { CanvasKit, Paint, Shader } from "canvaskit-wasm";
import { gradientRadius, sortedStops } from "../paints";
import type { Paint as ScenePaint, SceneNode } from "../core";

/** Caller owns the paint and returned shader, including their deletion. */
export function configureFill(
  ck: CanvasKit,
  paint: Paint,
  node: SceneNode,
  fill: ScenePaint = node.fill,
): Shader | undefined {
  paint.setAntiAlias(true);
  paint.setColor(ck.TRANSPARENT);
  paint.setShader(null);
  if (fill.type === "solid") {
    paint.setColor(ck.parseColorString(fill.color));
    paint.setAlphaf(paint.getColor()[3] * (fill.opacity ?? 1));
    return;
  }
  if (fill.type === "linear" || fill.type === "radial") {
    const stops = sortedStops(fill.stops);
    const colors = stops.map((stop) => {
      const color = ck.parseColorString(stop.color);
      color[3] *= stop.opacity ?? 1;
      return color;
    });
    const shader =
      fill.type === "radial"
        ? ck.Shader.MakeRadialGradient(
            [fill.from[0] * node.width, fill.from[1] * node.height],
            gradientRadius(node, fill),
            colors,
            stops.map((s) => s.offset),
            ck.TileMode.Clamp,
          )
        : ck.Shader.MakeLinearGradient(
            [fill.from[0] * node.width, fill.from[1] * node.height],
            [fill.to[0] * node.width, fill.to[1] * node.height],
            colors,
            stops.map((stop) => stop.offset),
            ck.TileMode.Clamp,
          );
    if (!shader) throw new Error(`Gradient failed: ${node.id}`);
    // Shader alpha is multiplied by paint alpha. The initial transparent color
    // represents fill:none, so a gradient must explicitly restore opaque alpha.
    paint.setAlphaf(fill.opacity ?? 1);
    paint.setShader(shader);
    return shader;
  }
}
