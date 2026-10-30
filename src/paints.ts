import type { Paint, SceneNode } from "./core";
import { nodePathData } from "./vector-path";
export const nodeFills = (node: SceneNode): Paint[] =>
  node.fills ?? [node.fill];
export const sortedStops = (
  stops: Extract<Paint, { stops: unknown }>["stops"],
) => [...stops].sort((a, b) => a.offset - b.offset);
/** Radial uses a circle in local pixels: from=center, to=point on radius. */
export function gradientRadius(
  node: SceneNode,
  paint: Extract<Paint, { stops: unknown }>,
) {
  return Math.max(
    0.001,
    Math.hypot(
      (paint.to[0] - paint.from[0]) * node.width,
      (paint.to[1] - paint.from[1]) * node.height,
    ),
  );
}
/** Open glyph outlines have no authored inside/outside; keep their stroke centered. */
export const strokePosition = (node: SceneNode) =>
  node.type === "text" ? "center" : (node.stroke?.position ?? "center");
export const dashIntervals = (dash: number[] = []) =>
  dash.length % 2 ? [...dash, ...dash] : dash;

/** Canonical clockwise path gives both engines the same dash origin and contour. */
export function strokePathData(node: SceneNode): string {
  const w = node.width,
    h = node.height;
  if (node.type === "path") return nodePathData(node);
  if (node.type === "ellipse")
    return w === 0 || h === 0
      ? ""
      : `M ${w} ${h / 2} A ${w / 2} ${h / 2} 0 1 1 0 ${h / 2} A ${w / 2} ${h / 2} 0 1 1 ${w} ${h / 2} Z`;
  const r = Math.min(node.radius, w / 2, h / 2);
  if (!r) return `M 0 0 H ${w} V ${h} H 0 Z`;
  return `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
}
