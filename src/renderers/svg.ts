import { effectBounds } from "./effect-bounds";
import { resolveDocumentStyles } from "../style-library";
import { culledClips } from "./visibility";
import {
  nodeFills,
  strokePathData,
  sortedStops,
  gradientRadius,
  strokePosition,
  dashIntervals,
} from "../paints";
import { cssFont, textLayout } from "../text-layout";
import type { SceneDocument, SceneNode, Viewport } from "../core";
export const FONT_URL = "/fonts/NotoSansKR.ttf";
export const escapeXml = (v: unknown) =>
  String(v).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const n = (x: number) => (Number.isFinite(x) ? x : 0);
export function sceneMarkup(
  doc: SceneDocument,
  excluded?: ReadonlySet<string>,
): string {
  doc = resolveDocumentStyles(doc);
  const defs: string[] = [];
  const keys = new Map(Object.keys(doc.nodes).map((id, i) => [id, `n-${i}`]));
  function visit(id: string): string {
    const node = doc.nodes[id];
    if (!node || !node.visible || excluded?.has(id)) return "";
    const key = keys.get(id)!;
    function fillStyle(p: import("../core").Paint, index: number) {
      let fill = "none";
      if (p.type === "solid") fill = escapeXml(p.color);
      if (p.type === "linear" || p.type === "radial") {
        const id = `${key}-gradient-${index}`;
        const stops = sortedStops(p.stops)
          .map(
            (s) =>
              `<stop offset="${n(s.offset)}" stop-color="${escapeXml(s.color)}" stop-opacity="${s.opacity ?? 1}"/>`,
          )
          .join("");
        if (p.type === "linear")
          defs.push(
            `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(p.from[0] * node.width)}" y1="${n(p.from[1] * node.height)}" x2="${n(p.to[0] * node.width)}" y2="${n(p.to[1] * node.height)}">${stops}</linearGradient>`,
          );
        else
          defs.push(
            `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(p.from[0] * node.width)}" cy="${n(p.from[1] * node.height)}" r="${gradientRadius(node, p)}">${stops}</radialGradient>`,
          );
        fill = `url(#${id})`;
      }
      return `fill="${fill}" fill-opacity="${p.opacity ?? 1}"`;
    }
    const w = n(node.width),
      h = n(node.height);
    const rect = `x="0" y="0" width="${w}" height="${h}" rx="${n(Math.min(node.radius, w / 2, h / 2))}"`;
    const geometry = (style: string) => {
      if (node.type === "ellipse")
        return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" ${style}/>`;
      if (node.type === "text" && node.text) {
        const t = node.text;
        return `<text ${style} text-rendering="geometricPrecision" font-kerning="normal" xml:space="preserve" font-family="${escapeXml(cssFont(t.fontFamily))}" font-size="${n(t.fontSize)}" font-weight="${n(t.fontWeight)}" letter-spacing="${n(t.letterSpacing ?? 0)}">${textLayout(
          node,
        )
          .lines.map(
            (line) =>
              `<tspan x="${n(line.x)}" y="${n(line.y)}">${escapeXml(line.content)}</tspan>`,
          )
          .join("")}</text>`;
      }
      return `<rect ${rect} ${style}/>`;
    };
    let shape =
      node.type === "group"
        ? ""
        : nodeFills(node)
            .map((p, i) => geometry(fillStyle(p, i)))
            .join("");
    if (node.type === "image") {
      const asset = node.assetId && doc.assets[node.assetId];
      if (
        asset &&
        /^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/.test(asset.dataUrl)
      )
        shape += `<image x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" href="${escapeXml(asset.dataUrl)}"/>`;
      else
        throw new Error(`Missing or invalid owned PNG asset: ${node.assetId}`);
    }
    if (node.stroke && node.type !== "group" && node.stroke.width > 0) {
      const s = node.stroke,
        position = strokePosition(node);
      const style = `fill="none" stroke="${escapeXml(s.color)}" stroke-opacity="${s.opacity ?? 1}" stroke-width="${n(s.width * (position === "center" ? 1 : 2))}" stroke-dasharray="${dashIntervals(s.dash).join(" ") || "none"}"`;
      let stroke =
        node.stroke.dash?.length && node.type !== "text"
          ? `<path d="${strokePathData(node)}" ${style}/>`
          : geometry(style);
      if (position === "inside") {
        defs.push(
          `<clipPath id="${key}-stroke-clip">${geometry('fill="white"')}</clipPath>`,
        );
        stroke = `<g clip-path="url(#${key}-stroke-clip)">${stroke}</g>`;
      } else if (position === "outside") {
        const pad = s.width * 2 + 1;
        defs.push(
          `<mask id="${key}-stroke-mask" maskUnits="userSpaceOnUse" x="${-pad}" y="${-pad}" width="${w + pad * 2}" height="${h + pad * 2}"><rect x="${-pad}" y="${-pad}" width="${w + pad * 2}" height="${h + pad * 2}" fill="white"/>${geometry('fill="black"')}</mask>`,
        );
        stroke = `<g mask="url(#${key}-stroke-mask)">${stroke}</g>`;
      }
      shape += stroke;
    }
    let children = node.children.map(visit).join("");
    if (node.clipContent) {
      defs.push(`<clipPath id="${key}-clip"><rect ${rect}/></clipPath>`);
      children = `<g clip-path="url(#${key}-clip)">${children}</g>`;
    }
    let filter = "";
    if (node.effects?.length) {
      // A sequential stack: each shadow filters the previous image plus shadow.
      const region = effectBounds(doc, id);
      defs.push(
        `<filter id="${key}-effect" filterUnits="userSpaceOnUse" x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" color-interpolation-filters="sRGB">${node.effects.map((e) => `<feDropShadow dx="${e.x}" dy="${e.y}" stdDeviation="${e.blur}" flood-color="${escapeXml(e.color)}"/>`).join("")}</filter>`,
      );
      filter = ` filter="url(#${key}-effect)"`;
    }
    return `<g transform="matrix(${node.transform.map(n).join(" ")})" opacity="${n(node.opacity)}"${filter}>${shape}${children}</g>`;
  }
  const content = visit(doc.rootId);
  return `<defs>${defs.join("")}</defs>${content}`;
}
export function exportSvg(doc: SceneDocument): string {
  const root = doc.nodes[doc.rootId];
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${root.width}" height="${root.height}" viewBox="0 0 ${root.width} ${root.height}">${sceneMarkup(doc)}</svg>`;
}
let fontsReady: Promise<void> | undefined;
export function ensureFonts(): Promise<void> {
  return (fontsReady ??= (async () => {
    const font = new FontFace("Noto Sans KR", `url(${FONT_URL})`, {
      weight: "100 900",
    });
    await font.load();
    document.fonts.add(font);
    await document.fonts.ready;
  })());
}
const decodedAssets = new Map<string, Promise<void>>();
/** Decode owned PNG data before reporting renderer readiness or sampling frames. */
export async function ensureDocumentAssets(doc: SceneDocument): Promise<void> {
  await Promise.all(
    Object.values(doc.assets).map((asset) => {
      let pending = decodedAssets.get(asset.dataUrl);
      if (!pending) {
        const image = new Image();
        image.src = asset.dataUrl;
        pending = image.decode();
        decodedAssets.set(asset.dataUrl, pending);
        if (decodedAssets.size > 32)
          decodedAssets.delete(decodedAssets.keys().next().value!);
      }
      return pending;
    }),
  );
}
/** PNG pixel dimensions; validate before fonts, image decoding, or canvas allocation. */
export function pngExportDimensions(width: number, height: number, scale = 2) {
  if (![1, 2, 3, 4].includes(scale))
    throw new Error("PNG scale must be 1, 2, 3, or 4.");
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error(
      "PNG document width and height must be finite positive numbers.",
    );
  // Round up fractional design dimensions so the final edge is not clipped.
  const outputWidth = Math.ceil(width * scale);
  const outputHeight = Math.ceil(height * scale);
  if (
    !Number.isFinite(outputWidth) ||
    !Number.isFinite(outputHeight) ||
    outputWidth > 16384 ||
    outputHeight > 16384 ||
    outputWidth * outputHeight > 64_000_000
  )
    throw new Error(
      "PNG export exceeds 16,384 pixels per side or 64 million pixels. Choose a lower scale or a smaller page.",
    );
  return { width: outputWidth, height: outputHeight };
}
export async function exportPng(doc: SceneDocument, scale = 2): Promise<Blob> {
  const root = doc.nodes[doc.rootId];
  if (!root) throw new Error("PNG document root is missing.");
  const size = pngExportDimensions(root.width, root.height, scale);
  await ensureFonts();
  const response = await fetch(FONT_URL);
  if (!response.ok) throw new Error("Export font unavailable");
  const buffer = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (const b of buffer) binary += String.fromCharCode(b);
  // Give the SVG its final intrinsic pixel dimensions before decoding. Its
  // unchanged viewBox keeps geometry in design units and rasterizes vectors,
  // embedded fonts, gradients and clips at the requested density.
  const svg = exportSvg(doc)
    .replace(
      `width="${root.width}" height="${root.height}"`,
      `width="${size.width}" height="${size.height}"`,
    )
    .replace(
      "<defs>",
      `<defs><style>@font-face{font-family:'Noto Sans KR';font-style:normal;font-weight:100 900;src:url(data:font/ttf;base64,${btoa(binary)}) format('truetype')}</style>`,
    );
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error("PNG export could not decode the rendered SVG image.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("PNG canvas unavailable");
    ctx.drawImage(img, 0, 0, size.width, size.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("PNG encoding failed")),
        "image/png",
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
export interface RendererEngine {
  update(doc: SceneDocument, viewport: Viewport): void;
  destroy(): void;
  info: Record<string, unknown>;
}
export async function createSvgEngine(
  host: HTMLElement,
  width: number,
  height: number,
): Promise<RendererEngine> {
  await ensureFonts();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.style.pointerEvents = "none";
  host.append(svg);
  const group = document.createElementNS(svg.namespaceURI, "g");
  svg.append(group);
  let previous: SceneDocument | undefined;
  let previousExcluded = new Set<string>();
  return {
    info: {
      backend: "SVG DOM",
      font: "local Noto Sans KR",
      text: "shared grapheme wrapping, alignment, and pixel spacing",
      limitations: [
        "Bundled Noto Sans KR and platform serif/monospace; unknown families explicitly substitute Noto Sans KR",
        "SVG file export references font family; installed font or fallback determines external viewer text",
      ],
    },
    update(doc, v) {
      const excluded = culledClips(doc, v, width, height);
      if (
        previous !== doc ||
        excluded.size !== previousExcluded.size ||
        [...excluded].some((id) => !previousExcluded.has(id))
      ) {
        group.innerHTML = sceneMarkup(doc, excluded);
        previousExcluded = excluded;
        previous = doc;
      }
      group.setAttribute(
        "transform",
        `translate(${v.x} ${v.y}) scale(${v.zoom})`,
      );
    },
    destroy() {
      svg.remove();
    },
  };
}
