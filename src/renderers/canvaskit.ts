import { resolveDocumentStyles } from "../style-library";
import { clippedOutside } from "./visibility";
import { rasterText } from "./text-mask";
import CanvasKitInit, {
  type CanvasKit,
  type Paint,
  type Image as SkImage,
  type Surface,
  type GrDirectContext,
  type WebGLContextHandle,
} from "canvaskit-wasm";
import wasmUrl from "canvaskit-wasm/bin/canvaskit.wasm?url";
import {
  multiplyMatrices,
  type Matrix,
  type SceneDocument,
  type SceneNode,
} from "../core";
import { ensureFonts, type RendererEngine } from "./svg";
import {
  nodeFills,
  strokePosition,
  dashIntervals,
  strokePathData,
} from "../paints";
import { configureFill } from "./paint";
import { nodePathData } from "../vector-path";
let kitPromise: Promise<CanvasKit> | undefined;
export const loadCanvasKit = () =>
  (kitPromise ??= CanvasKitInit({ locateFile: () => wasmUrl }));
type Resource = {
  signature: string;
  fills: { paint: Paint; shader?: { delete(): void } }[];
  dash?: { delete(): void };
  stroke?: Paint;
  strokePath?: import("canvaskit-wasm").Path;
  /** Outline of a path node, shared by fills, stroke and stroke clipping. */
  path?: import("canvaskit-wasm").Path;
  mask?: {
    image: SkImage;
    left: number;
    top: number;
    width: number;
    height: number;
  };
  image?: SkImage;
  layer: Paint;
  filters?: import("canvaskit-wasm").ImageFilter[];
  shader?: {
    delete(): void;
  };
};
export async function createCanvasKitEngine(
  host: HTMLElement,
  width: number,
  height: number,
): Promise<RendererEngine> {
  const [ck] = await Promise.all([loadCanvasKit(), ensureFonts()]);
  let element = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  element.width = Math.round(width * dpr);
  element.height = Math.round(height * dpr);
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  element.style.pointerEvents = "none";
  host.append(element);
  let surface: Surface | null = null;
  let gl: GrDirectContext | null = null;
  let context: WebGLContextHandle | undefined;
  let fallbackReason: string | null = null;
  try {
    context = ck.GetWebGLContext(element);
    if (Number(context) <= 0) throw new Error("WebGL context unavailable");
    gl = ck.MakeWebGLContext(context);
    if (!gl) throw new Error("Skia WebGL context unavailable");
    surface = ck.MakeOnScreenGLSurface(
      gl,
      element.width,
      element.height,
      ck.ColorSpace.SRGB,
    );
    if (!surface) throw new Error("Skia WebGL surface unavailable");
  } catch (error) {
    fallbackReason = String(error);
    gl?.delete();
    gl = null;
    if (context && Number(context) > 0) ck.deleteContext(context);
    context = undefined;
    const fresh = document.createElement("canvas");
    fresh.width = element.width;
    fresh.height = element.height;
    fresh.style.cssText = element.style.cssText;
    element.replaceWith(fresh);
    element = fresh;
    surface = ck.MakeSWCanvasSurface(element);
  }
  if (!surface) {
    element.remove();
    throw new Error("CanvasKit software surface unavailable");
  }
  const canvas = surface.getCanvas();
  const resources = new Map<string, Resource>();
  const imagePaint = new ck.Paint();
  imagePaint.setAntiAlias(true);
  const free = (r: Resource) => {
    for (const f of r.fills) {
      f.paint.delete();
      f.shader?.delete();
    }
    r.dash?.delete();
    r.stroke?.delete();
    r.strokePath?.delete();
    r.path?.delete();
    r.mask?.image.delete();
    r.image?.delete();
    r.layer.delete();
    r.filters?.forEach((filter) => filter.delete());
    r.shader?.delete();
  };
  function resource(
    node: SceneNode,
    doc: SceneDocument,
    matrix: Matrix,
  ): Resource {
    const asset = node.assetId ? doc.assets[node.assetId] : undefined;
    const signature = JSON.stringify([
      node.text ? matrix : null,
      nodeFills(node),
      node.type,
      node.radius,
      node.stroke,
      node.text,
      node.opacity,
      node.effects,
      node.width,
      node.height,
      node.path,
      asset?.dataUrl,
    ]);
    const old = resources.get(node.id);
    if (old?.signature === signature) return old;
    if (old) {
      free(old);
      resources.delete(node.id);
    }
    const layer = new ck.Paint();
    layer.setAlphaf(node.opacity);
    const r: Resource = { signature, fills: [], layer };
    try {
      if (node.effects?.length) {
        r.filters = [];
        for (const e of node.effects) {
          const filter = ck.ImageFilter.MakeDropShadow(
            e.x,
            e.y,
            e.blur,
            e.blur,
            ck.parseColorString(e.color),
            r.filters.at(-1) ?? null,
          );
          r.filters.push(filter);
        }
        layer.setImageFilter(r.filters.at(-1)!);
      }
      if (node.type === "path") {
        r.path = ck.Path.MakeFromSVGString(nodePathData(node)) ?? undefined;
        if (node.path?.fillRule === "evenodd")
          r.path?.setFillType(ck.FillType.EvenOdd);
      }
      for (const fill of node.type === "text" ? [] : nodeFills(node)) {
        const paint = new ck.Paint();
        const f: Resource["fills"][number] = { paint };
        r.fills.push(f);
        f.shader = configureFill(ck, paint, node, fill);
      }
      if (node.stroke && node.type !== "text") {
        r.stroke = new ck.Paint();
        r.stroke.setAntiAlias(true);
        r.stroke.setColor(ck.parseColorString(node.stroke.color));
        r.stroke.setAlphaf(r.stroke.getColor()[3] * (node.stroke.opacity ?? 1));
        if (node.stroke.dash?.length) {
          r.strokePath =
            ck.Path.MakeFromSVGString(strokePathData(node)) ?? undefined;
          r.dash = ck.PathEffect.MakeDash(dashIntervals(node.stroke.dash), 0);
          r.stroke.setPathEffect(
            r.dash as ReturnType<typeof ck.PathEffect.MakeDash>,
          );
        }
        r.stroke.setStyle(ck.PaintStyle.Stroke);
        r.stroke.setStrokeWidth(
          node.stroke.width * (strokePosition(node) === "center" ? 1 : 2),
        );
      }
      if (node.text) {
        const { canvas, ...bounds } = rasterText(node, matrix);
        r.mask = {
          ...bounds,
          image: ck.MakeImageFromCanvasImageSource(canvas),
        };
      }
      if (node.type === "image") {
        if (!asset) throw new Error(`Missing asset: ${node.assetId}`);
        const data = atob(asset.dataUrl.split(",")[1]);
        const bytes = Uint8Array.from(data, (c) => c.charCodeAt(0));
        r.image = ck.MakeImageFromEncoded(bytes) ?? undefined;
        if (!r.image)
          throw new Error(`CanvasKit PNG decoding failed: ${node.assetId}`);
      }
      resources.set(node.id, r);
      return r;
    } catch (e) {
      free(r);
      throw e;
    }
  }
  const touched = new Set<string>();
  let hasEffects = false;
  function visit(id: string, doc: SceneDocument, parentMatrix: Matrix) {
    const node = doc.nodes[id];
    if (!node || !node.visible) return;
    const [a, b, c, d, e, f] = node.transform;
    const world = multiplyMatrices(parentMatrix, node.transform);
    if (!hasEffects && clippedOutside(node, world, width * dpr, height * dpr))
      return;
    touched.add(id);
    // Integer pan/drag offsets reuse device tiles; subpixel phase affects glyph AA.
    const matrix = [...world] as Matrix;
    matrix[4] -= Math.floor(matrix[4]);
    matrix[5] -= Math.floor(matrix[5]);
    const r = resource(node, doc, matrix);
    canvas.save();
    try {
      canvas.concat([a, c, e, b, d, f, 0, 0, 1]);
      if (node.opacity !== 1 || node.effects?.length) canvas.saveLayer(r.layer);
      try {
        const rect = ck.XYWHRect(0, 0, node.width, node.height);
        const rr = ck.RRectXY(rect, node.radius, node.radius);
        const draw = (paint: Paint) => {
          if (paint === r.stroke && r.strokePath)
            canvas.drawPath(r.strokePath, paint);
          else if (node.type === "ellipse") canvas.drawOval(rect, paint);
          else if (node.type === "path") {
            if (r.path) canvas.drawPath(r.path, paint);
          } else if (node.type !== "group") canvas.drawRRect(rr, paint);
        };
        if (r.mask) {
          const m = r.mask;
          canvas.save();
          try {
            const inverse = ck.Matrix.invert(canvas.getTotalMatrix());
            if (inverse) {
              canvas.concat(inverse);
              canvas.drawImageRect(
                m.image,
                ck.XYWHRect(0, 0, m.image.width(), m.image.height()),
                ck.XYWHRect(
                  m.left + Math.floor(world[4]),
                  m.top + Math.floor(world[5]),
                  m.width,
                  m.height,
                ),
                imagePaint,
              );
            }
          } finally {
            canvas.restore();
          }
        }
        for (const f of r.fills) draw(f.paint);
        if (r.image)
          canvas.drawImageRect(
            r.image,
            ck.XYWHRect(0, 0, r.image.width(), r.image.height()),
            rect,
            imagePaint,
          );
        if (r.stroke && node.type !== "group" && node.stroke!.width > 0) {
          canvas.save();
          try {
            const position = strokePosition(node);
            if (position !== "center" && node.type === "path") {
              if (r.path)
                canvas.clipPath(
                  r.path,
                  position === "inside"
                    ? ck.ClipOp.Intersect
                    : ck.ClipOp.Difference,
                  true,
                );
            } else if (position !== "center") {
              const builder = new ck.PathBuilder();
              if (node.type === "ellipse") builder.addOval(rect);
              else builder.addRRect(rr);
              const path = builder.detachAndDelete();
              canvas.clipPath(
                path,
                position === "inside"
                  ? ck.ClipOp.Intersect
                  : ck.ClipOp.Difference,
                true,
              );
              path.delete();
            }
            draw(r.stroke);
          } finally {
            canvas.restore();
          }
        }
        if (node.clipContent) canvas.clipRRect(rr, ck.ClipOp.Intersect, true);
        for (const child of node.children) visit(child, doc, world);
      } finally {
        if (node.opacity !== 1 || node.effects?.length) canvas.restore();
      }
    } finally {
      canvas.restore();
    }
  }
  return {
    info: {
      backend: surface.reportBackendTypeIsGPU()
        ? "CanvasKit WebGL GPU surface"
        : "CanvasKit software CPU surface",
      fallbackReason,
      dpr,
      font: "Browser-shaped RGBA text tiles: local variable Noto Sans KR and platform generic families",
      limitations: [
        "Browser Canvas2D shapes text; this is not native Skia paragraph shaping",
        "Text tiles are capped at 4096 per side / 4 million pixels; extreme zoom is sampled",
        "Platform serif/monospace and missing glyph fallback depend on the browser/OS",
        "Clipped subtrees outside the viewport are culled; unclipped overflow stays conservative",
      ],
    },
    update(doc, viewport) {
      doc = resolveDocumentStyles(doc);
      hasEffects = Object.values(doc.nodes).some((n) => n.effects?.length);
      for (const [id, r] of resources)
        if (!doc.nodes[id]) {
          free(r);
          resources.delete(id);
        }
      touched.clear();
      canvas.clear(ck.TRANSPARENT);
      canvas.save();
      try {
        canvas.scale(dpr, dpr);
        canvas.translate(viewport.x, viewport.y);
        canvas.scale(viewport.zoom, viewport.zoom);
        visit(doc.rootId, doc, [
          dpr * viewport.zoom,
          0,
          0,
          dpr * viewport.zoom,
          dpr * viewport.x,
          dpr * viewport.y,
        ]);
      } finally {
        canvas.restore();
      }
      for (const [id, r] of resources)
        if (!touched.has(id)) {
          free(r);
          resources.delete(id);
        }
      surface.flush();
    },
    destroy() {
      for (const r of resources.values()) free(r);
      resources.clear();
      imagePaint.delete();
      surface.dispose();
      gl?.delete();
      if (context && Number(context) > 0) ck.deleteContext(context);
      element.remove();
    },
  };
}
