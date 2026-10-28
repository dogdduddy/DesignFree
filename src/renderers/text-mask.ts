import { gradientRadius, nodeFills, sortedStops } from "../paints";
import { transformPoint, type Matrix, type SceneNode } from "../core";
import { textRasterBounds } from "./text-raster";
import { cssFont, textLayout } from "../text-layout";

/** Browser shaping/raster bridge. Glyphs rasterize in device coordinates, including transformed ink overflow. */
export function rasterText(node: SceneNode, matrix: Matrix) {
  const text = node.text!;
  const canvas = document.createElement("canvas");
  canvas.lang = document.documentElement.lang;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${text.fontWeight} ${text.fontSize}px ${cssFont(text.fontFamily)}`;
  ctx.textRendering = "geometricPrecision";
  ctx.fontKerning = "normal";
  if (text.letterSpacing) ctx.letterSpacing = `${text.letterSpacing}px`;
  const lines = textLayout(node).lines;
  const pad = (node.stroke?.width ?? 0) * 5 + 2;
  let left = 0,
    top = 0,
    right = 1,
    bottom = 1;
  for (const line of lines) {
    const m = ctx.measureText(line.content);
    left = Math.min(left, line.x - m.actualBoundingBoxLeft - pad);
    top = Math.min(top, line.y - m.actualBoundingBoxAscent - pad);
    right = Math.max(right, line.x + m.actualBoundingBoxRight + pad);
    bottom = Math.max(bottom, line.y + m.actualBoundingBoxDescent + pad);
  }
  const corners = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ].map(([x, y]) => transformPoint(matrix, { x, y }));
  const bounds = textRasterBounds(
    Math.min(...corners.map((p) => p.x)),
    Math.min(...corners.map((p) => p.y)),
    Math.max(...corners.map((p) => p.x)),
    Math.max(...corners.map((p) => p.y)),
    1,
  );
  const { scale } = bounds;
  left = bounds.left;
  top = bounds.top;
  canvas.width = bounds.pixelWidth;
  canvas.height = bounds.pixelHeight;
  ctx.setTransform(
    matrix[0] * scale,
    matrix[1] * scale,
    matrix[2] * scale,
    matrix[3] * scale,
    (matrix[4] - left) * scale,
    (matrix[5] - top) * scale,
  );
  ctx.font = `${text.fontWeight} ${text.fontSize}px ${cssFont(text.fontFamily)}`;
  ctx.textRendering = "geometricPrecision";
  ctx.fontKerning = "normal";
  if (text.letterSpacing) ctx.letterSpacing = `${text.letterSpacing}px`;
  // Paint in the same browser that shapes the glyphs. Color emoji must keep
  // their own RGB channels; an alpha-only mask would recolor them incorrectly.
  for (const fill of nodeFills(node)) {
    if (fill.type === "none") continue;
    ctx.globalAlpha = fill.opacity ?? 1;
    if (fill.type === "solid") ctx.fillStyle = fill.color;
    else {
      const [x, y] = [fill.from[0] * node.width, fill.from[1] * node.height];
      const gradient =
        fill.type === "linear"
          ? ctx.createLinearGradient(
              x,
              y,
              fill.to[0] * node.width,
              fill.to[1] * node.height,
            )
          : ctx.createRadialGradient(x, y, 0, x, y, gradientRadius(node, fill));
      for (const stop of sortedStops(fill.stops)) {
        // Normalize accepted HEX forms before multiplying stop alpha.
        const hex = stop.color.slice(1);
        const full =
          hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
        const alpha =
          (full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1) *
          (stop.opacity ?? 1);
        gradient.addColorStop(
          stop.offset,
          `rgba(${parseInt(full.slice(0, 2), 16)},${parseInt(full.slice(2, 4), 16)},${parseInt(full.slice(4, 6), 16)},${alpha})`,
        );
      }
      ctx.fillStyle = gradient;
    }
    for (const line of lines) ctx.fillText(line.content, line.x, line.y);
  }
  if (node.stroke && node.stroke.width > 0) {
    ctx.globalAlpha = node.stroke.opacity ?? 1;
    ctx.strokeStyle = node.stroke.color;
    ctx.lineWidth = node.stroke.width;
    ctx.setLineDash(node.stroke.dash ?? []);
    for (const line of lines) ctx.strokeText(line.content, line.x, line.y);
  }
  return {
    canvas,
    left,
    top,
    width: canvas.width / scale,
    height: canvas.height / scale,
  };
}
