import {
  createNode,
  multiplyMatrices,
  validateDocument,
  type ImageAsset,
  type Matrix,
  type Paint,
  type Point,
  type SceneDocument,
  type SceneNode,
} from "./core";
import { textLayout } from "./text-layout";
import {
  MAX_PATH_DATA,
  parsePathData,
  pathBounds,
  serializeSegments,
  transformSegments,
  type Segment,
} from "./vector-path";

/** SVG file → editable nodes. Supported: svg/g/a/use/symbol, rect, circle,
 * ellipse, line, polyline, polygon, path, text/tspan, embedded raster images,
 * solid colours and linear/radial gradients. Everything else is left out with
 * a warning; nothing is fetched and no script or style sheet is executed. */
export const MAX_SVG_BYTES = 10 * 1024 * 1024;
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export type PngImage = { dataUrl: string; width: number; height: number };
export type SvgImportOptions = {
  /** Name of the frame that holds the imported drawing. */
  name: string;
  /** Centre of the frame in parent coordinates. */
  center: Point;
  /** Converts a data: image to PNG and reports its pixel size. */
  toPng?: (dataUrl: string) => Promise<PngImage>;
};
/** Converted drawing, not yet part of any document. */
export type SvgFragment = {
  frame: SceneNode;
  nodes: SceneNode[];
  assets: Record<string, ImageAsset>;
  warnings: string[];
};

type Style = Record<string, string>;
const INHERITED = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
  "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "font-family", "font-size",
  "font-weight", "letter-spacing", "text-anchor", "visibility", "color",
]);
const PROPERTIES = new Set([
  ...INHERITED, "opacity", "display", "clip-path", "mask", "filter", "stop-color",
  "stop-opacity", "marker-start", "marker-mid", "marker-end", "paint-order",
  "mix-blend-mode", "vector-effect", "transform", "dominant-baseline",
  "alignment-baseline", "writing-mode",
]);
const ROOT_STYLE: Style = {
  fill: "black", "fill-opacity": "1", "fill-rule": "nonzero", stroke: "none",
  "stroke-width": "1", "stroke-opacity": "1", "font-family": "sans-serif",
  "font-size": "16", "font-weight": "400", "letter-spacing": "0",
  "text-anchor": "start", visibility: "visible", color: "black",
};
const SKIPPED = new Set([
  "title", "desc", "metadata", "defs", "style", "linearGradient", "radialGradient",
  "stop", "symbol", "clipPath", "mask", "marker", "pattern", "filter",
]);

class Warnings {
  counts = new Map<string, number>();
  add(message: string) {
    this.counts.set(message, (this.counts.get(message) ?? 0) + 1);
  }
  list() {
    return [...this.counts].map(([m, n]) => (n > 1 ? `${m} (${n}개)` : m));
  }
}

// ---------- values ----------

function splitDeclarations(text: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0, start = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if ((c === ";" && !depth) || i === text.length) {
      const part = text.slice(start, i);
      start = i + 1;
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      const name = part.slice(0, colon).trim().toLowerCase();
      const value = part.slice(colon + 1).replace(/!important/i, "").trim();
      if (name && value) out.push([name, value]);
    }
  }
  return out;
}

export function parseTransform(value: string | null): Matrix | null {
  if (!value || !value.trim()) return IDENTITY;
  let m: Matrix = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gy;
  const rest = value.trim().replace(/\s*,\s*(?=[a-zA-Z])/g, " ");
  let index = 0;
  while (index < rest.length) {
    while (rest[index] === " " || rest[index] === ",") index++;
    if (index >= rest.length) break;
    re.lastIndex = index;
    const f = re.exec(rest);
    if (!f) return null;
    index = re.lastIndex;
    const a = (f[2].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    let t: Matrix;
    const rad = (deg: number) => (deg * Math.PI) / 180;
    switch (f[1]) {
      case "matrix":
        if (a.length !== 6) return null;
        t = a as Matrix;
        break;
      case "translate":
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case "scale":
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const r = rad(a[0] ?? 0), c = Math.cos(r), s = Math.sin(r);
        t = [c, s, -s, c, 0, 0];
        if (a.length >= 3)
          t = multiplyMatrices(multiplyMatrices([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case "skewX":
        t = [1, 0, Math.tan(rad(a[0] ?? 0)), 1, 0, 0];
        break;
      default:
        t = [1, Math.tan(rad(a[0] ?? 0)), 0, 1, 0, 0];
    }
    if (!t.every(Number.isFinite)) return null;
    m = multiplyMatrices(m, t);
  }
  return m;
}

const UNITS: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6 };
function length(value: string | null | undefined, reference: number, fontSize = 16): number | undefined {
  if (value == null) return undefined;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(%|px|pt|pc|mm|cm|in|q|em|ex|rem)?\s*$/i.exec(value);
  if (!m) return undefined;
  const v = Number(m[1]), unit = (m[2] ?? "px").toLowerCase();
  if (unit === "%") return (v / 100) * reference;
  if (unit === "em" || unit === "rem") return v * fontSize;
  if (unit === "ex") return v * fontSize * 0.5;
  return v * UNITS[unit];
}
function fraction(value: string | null, fallback: number): number {
  if (value == null) return fallback;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(%)?\s*$/.exec(value);
  if (!m) return fallback;
  return m[2] ? Number(m[1]) / 100 : Number(m[1]);
}
const numbers = (value: string | null) =>
  (value?.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);

const NAMED =
  "aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32";
const NAMED_COLORS = new Map(NAMED.split(",").map((e) => e.split(":") as [string, string]));

/** CSS colour → lowercase #rrggbb and alpha; undefined when unsupported. */
export function parseColor(value: string, current = "#000000"): { color: string; alpha: number } | undefined {
  const v = value.trim().toLowerCase();
  if (v === "currentcolor") return parseColor(current);
  if (v === "transparent") return { color: "#000000", alpha: 0 };
  const named = NAMED_COLORS.get(v);
  if (named) return { color: `#${named}`, alpha: 1 };
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m && [3, 4, 6, 8].includes(m[1].length)) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    return { color: `#${h.slice(0, 6)}`, alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  m = /^(rgba?|hsla?)\((.*)\)$/.exec(v);
  if (!m) return undefined;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return undefined;
  const channel = (p: string, max: number) => (p.endsWith("%") ? (parseFloat(p) / 100) * max : parseFloat(p));
  const alpha = parts[3] === undefined ? 1 : channel(parts[3], 1);
  let rgb: number[];
  if (m[1].startsWith("rgb")) rgb = parts.slice(0, 3).map((p) => channel(p, 255));
  else {
    const h = (((parseFloat(parts[0]) % 360) + 360) % 360) / 360, s = channel(parts[1], 1), l = channel(parts[2], 1);
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const hue = (t: number) => {
      t = (t + 1) % 1;
      return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    };
    rgb = [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((x) => x * 255);
  }
  if (![...rgb, alpha].every(Number.isFinite)) return undefined;
  const hex = rgb.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("");
  return { color: `#${hex}`, alpha: Math.min(1, Math.max(0, alpha)) };
}

// ---------- style sheets ----------

type Rule = { tag?: string; ids: string[]; classes: string[]; specificity: number; order: number; declarations: [string, string][] };
function parseStyleSheets(root: Element, warnings: Warnings): Rule[] {
  const rules: Rule[] = [];
  let order = 0;
  for (const style of Array.from(root.getElementsByTagNameNS(SVG_NS, "style"))) {
    let css = (style.textContent ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (/@import/i.test(css)) warnings.add("CSS @import는 불러오지 않습니다");
    // Drop at-rules (media queries, font faces) including nested blocks.
    let out = "";
    for (let i = 0; i < css.length; i++) {
      if (css[i] === "@") {
        warnings.add("CSS @규칙(@media 등)은 적용하지 않습니다");
        let depth = 0;
        for (; i < css.length; i++) {
          if (css[i] === ";" && depth === 0) break;
          if (css[i] === "{") depth++;
          if (css[i] === "}" && --depth <= 0) break;
        }
        continue;
      }
      out += css[i];
    }
    css = out;
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = splitDeclarations(m[2]);
      for (const selector of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        const s = /^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)$/.exec(selector);
        if (!s) {
          warnings.add(`지원하지 않는 CSS 선택자: ${selector.slice(0, 40)}`);
          continue;
        }
        const ids = [...s[2].matchAll(/#([\w-]+)/g)].map((x) => x[1]);
        const classes = [...s[2].matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
        const tag = s[1] && s[1] !== "*" ? s[1] : undefined;
        rules.push({ tag, ids, classes, specificity: ids.length * 100 + classes.length * 10 + (tag ? 1 : 0), order: order++, declarations });
      }
    }
  }
  return rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
}

// ---------- conversion ----------

type Box = { x: number; y: number; width: number; height: number };
type Context = {
  nodes: SceneNode[];
  assets: Record<string, ImageAsset>;
  assetByUrl: Map<string, string>;
  ids: Map<string, Element>;
  rules: Rule[];
  warnings: Warnings;
  viewport: { width: number; height: number };
  useStack: Set<Element>;
  toPng?: (dataUrl: string) => Promise<PngImage>;
  limit: number;
};

function localName(el: Element) {
  return el.namespaceURI === SVG_NS ? el.localName : `${el.prefix ?? ""}:${el.localName}`;
}
function computeStyle(el: Element, parent: Style, ctx: Context): Style {
  const own: Style = {};
  for (const name of PROPERTIES) {
    const v = el.getAttribute(name);
    if (v != null && !(name === "transform")) own[name] = v.trim();
  }
  const classes = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  const id = el.getAttribute("id");
  for (const r of ctx.rules) {
    if (r.tag && r.tag !== el.localName) continue;
    if (r.ids.some((x) => x !== id) || r.classes.some((c) => !classes.includes(c))) continue;
    for (const [k, v] of r.declarations) own[k] = v;
  }
  for (const [k, v] of splitDeclarations(el.getAttribute("style") ?? "")) own[k] = v;
  if (own.transform) {
    ctx.warnings.add("CSS transform 속성은 적용하지 않습니다 (transform 속성만 지원)");
    delete own.transform;
  }
  const style: Style = {};
  for (const k of INHERITED) style[k] = parent[k];
  for (const [k, v] of Object.entries(own)) style[k] = v === "inherit" ? parent[k] ?? "" : v;
  return style;
}
const opacityOf = (v: string | undefined) => {
  const n = fraction(v ?? null, 1);
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 1));
};
const clean = (n: number) => (Math.abs(n) < 1e-9 ? 0 : n);

function noteUnsupported(style: Style, ctx: Context) {
  const w = ctx.warnings;
  if (style["clip-path"] && style["clip-path"] !== "none") w.add("clip-path 잘라내기는 적용하지 않습니다");
  if (style.mask && style.mask !== "none") w.add("mask는 적용하지 않습니다");
  if (style.filter && style.filter !== "none") w.add("filter 효과는 적용하지 않습니다");
  if (["marker-start", "marker-mid", "marker-end"].some((k) => style[k] && style[k] !== "none")) w.add("marker(화살촉 등)는 적용하지 않습니다");
  if (style["mix-blend-mode"] && style["mix-blend-mode"] !== "normal") w.add("혼합 모드는 적용하지 않습니다");
  if (style["vector-effect"] === "non-scaling-stroke") w.add("non-scaling-stroke는 일반 stroke로 그립니다");
  if (style["paint-order"] && style["paint-order"] !== "normal") w.add("paint-order는 기본 순서(채우기 → stroke)로 그립니다");
}

function gradientElement(id: string, ctx: Context) {
  const el = ctx.ids.get(id);
  const name = el && localName(el);
  return name === "linearGradient" || name === "radialGradient" ? el : undefined;
}
/** Attribute lookup that follows gradient href templates. */
function gradientAttr(el: Element, name: string, ctx: Context): string | null {
  const seen = new Set<Element>();
  for (let e: Element | undefined = el; e && !seen.has(e); ) {
    seen.add(e);
    const v = e.getAttribute(name);
    if (v != null) return v;
    const href = (e.getAttribute("href") ?? e.getAttributeNS(XLINK_NS, "href") ?? "").trim();
    e = href.startsWith("#") ? gradientElement(href.slice(1), ctx) : undefined;
  }
  return null;
}
function gradientStops(el: Element, ctx: Context) {
  const seen = new Set<Element>();
  for (let e: Element | undefined = el; e && !seen.has(e); ) {
    seen.add(e);
    const stops = Array.from(e.children).filter((c) => localName(c) === "stop");
    if (stops.length) return stops;
    const href = (e.getAttribute("href") ?? e.getAttributeNS(XLINK_NS, "href") ?? "").trim();
    e = href.startsWith("#") ? gradientElement(href.slice(1), ctx) : undefined;
  }
  return [];
}
function isSimilarity(m: Matrix) {
  return Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-6 && Math.abs(Math.hypot(m[0], m[1]) - Math.hypot(m[2], m[3])) < 1e-6;
}

/** Paint for a fill/stroke value in an element's local box (gradients are
 * normalized to that box, matching the node it becomes). */
function paintFor(value: string | undefined, opacity: number, box: Box, style: Style, ctx: Context): Paint | undefined {
  const v = (value ?? "").trim();
  if (!v || v === "none") return undefined;
  const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/.exec(v);
  if (url) {
    const el = gradientElement(url[1], ctx);
    if (!el) {
      ctx.warnings.add("pattern 등 gradient가 아닌 채우기는 대체 색으로 그립니다");
      return url[2] && url[2] !== "none" ? paintFor(url[2], opacity, box, style, ctx) : undefined;
    }
    return gradientPaint(el, opacity, box, ctx);
  }
  if (/^url\(/.test(v)) {
    ctx.warnings.add("외부 문서를 가리키는 채우기는 가져오지 않습니다");
    return undefined;
  }
  const c = parseColor(v, style.color);
  if (!c) {
    ctx.warnings.add(`알 수 없는 색: ${v.slice(0, 30)}`);
    return undefined;
  }
  const alpha = c.alpha * opacity;
  return alpha === 1 ? { type: "solid", color: c.color } : { type: "solid", color: c.color, opacity: alpha };
}
function gradientPaint(el: Element, opacity: number, box: Box, ctx: Context): Paint | undefined {
  const linear = localName(el) === "linearGradient";
  const stops: { offset: number; color: string; opacity?: number }[] = [];
  let last = 0;
  for (const stop of gradientStops(el, ctx).slice(0, 64)) {
    const s = computeStyle(stop, ROOT_STYLE, ctx);
    const c = parseColor(s["stop-color"] ?? "black", s.color) ?? { color: "#000000", alpha: 1 };
    last = Math.max(last, Math.min(1, Math.max(0, fraction(stop.getAttribute("offset"), 0))));
    const a = c.alpha * opacityOf(s["stop-opacity"]);
    stops.push(a === 1 ? { offset: last, color: c.color } : { offset: last, color: c.color, opacity: a });
  }
  if (!stops.length) return undefined;
  if (stops.length === 1) {
    const s = stops[0], a = (s.opacity ?? 1) * opacity;
    return a === 1 ? { type: "solid", color: s.color } : { type: "solid", color: s.color, opacity: a };
  }
  if ((gradientAttr(el, "spreadMethod", ctx) ?? "pad") !== "pad") ctx.warnings.add("gradient 반복(spreadMethod)은 pad로 그립니다");
  const user = gradientAttr(el, "gradientUnits", ctx) === "userSpaceOnUse";
  const t = parseTransform(gradientAttr(el, "gradientTransform", ctx)) ?? IDENTITY;
  if (!isSimilarity(t)) ctx.warnings.add("기울이거나 비균등 확대한 gradientTransform은 근사해서 그립니다");
  const vw = ctx.viewport.width, vh = ctx.viewport.height, diag = Math.hypot(vw, vh) / Math.SQRT2;
  const coord = (name: string, fallback: string, axis: "x" | "y" | "r") => {
    const raw = gradientAttr(el, name, ctx) ?? fallback;
    if (!user) return fraction(raw, fraction(fallback, 0));
    return length(raw, axis === "x" ? vw : axis === "y" ? vh : diag) ?? 0;
  };
  const apply = (x: number, y: number): [number, number] => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
  // Points in the gradient's space → fractions of the node box.
  const norm = ([x, y]: [number, number]): [number, number] =>
    user ? [box.width ? (x - box.x) / box.width : 0, box.height ? (y - box.y) / box.height : 0] : [x, y];
  const common = { stops, ...(opacity === 1 ? {} : { opacity }) };
  if (linear) {
    const from = norm(apply(coord("x1", "0%", "x"), coord("y1", "0%", "y")));
    let to = norm(apply(coord("x2", "100%", "x"), coord("y2", "0%", "y")));
    if (!user && box.width > 0 && box.height > 0) {
      // Bounding-box gradients have isolines perpendicular in box space; the
      // model's are perpendicular in pixels. Pick the pixel-space vector D
      // that yields the same ramp: D = g / |g|², g = (dx / w, dy / h) / L².
      const dx = to[0] - from[0], dy = to[1] - from[1], w = box.width, h = box.height;
      const gx = dx / w, gy = dy / h, g2 = gx * gx + gy * gy;
      if (g2 > 0) {
        const L2 = dx * dx + dy * dy;
        to = [from[0] + (gx * L2) / g2 / w, from[1] + (gy * L2) / g2 / h];
      }
    }
    return { type: "linear", from, to, ...common };
  }
  const cx = coord("cx", "50%", "x"), cy = coord("cy", "50%", "y"), r = coord("r", "50%", "r");
  const fx = gradientAttr(el, "fx", ctx), fy = gradientAttr(el, "fy", ctx);
  if ((fx != null && coord("fx", "50%", "x") !== cx) || (fy != null && coord("fy", "50%", "y") !== cy))
    ctx.warnings.add("radial gradient 초점(fx, fy)은 중심으로 그립니다");
  if (!user && Math.abs(box.width - box.height) > 1e-6) ctx.warnings.add("상자 비율을 따르는 타원형 radial gradient는 원형으로 근사합니다");
  const center = apply(cx, cy), edge = apply(cx + r, cy);
  const radius = Math.hypot(edge[0] - center[0], edge[1] - center[1]);
  const from = norm(center);
  // The model's radial radius is a circle in node pixels along the box axes.
  const to: [number, number] = user
    ? [from[0] + (box.width ? radius / box.width : 0), from[1]]
    : [from[0] + radius, from[1]];
  return { type: "radial", from, to, ...common };
}

function strokeFor(style: Style, box: Box, ctx: Context): SceneNode["stroke"] | undefined {
  const width = length(style["stroke-width"], Math.hypot(ctx.viewport.width, ctx.viewport.height) / Math.SQRT2) ?? 1;
  if (!(width > 0)) return undefined;
  const paint = paintFor(style.stroke, 1, box, style, ctx);
  if (!paint) return undefined;
  let color: string, opacity: number;
  if (paint.type === "solid") {
    color = paint.color;
    opacity = (paint.opacity ?? 1) * opacityOf(style["stroke-opacity"]);
  } else if (paint.type === "linear" || paint.type === "radial") {
    ctx.warnings.add("gradient stroke는 첫 번째 색의 단색으로 그립니다");
    color = paint.stops[0].color;
    opacity = (paint.stops[0].opacity ?? 1) * opacityOf(style["stroke-opacity"]);
  } else return undefined;
  if ((style["stroke-linecap"] ?? "butt") !== "butt" || (style["stroke-linejoin"] ?? "miter") !== "miter")
    ctx.warnings.add("선 끝·모서리 모양(linecap, linejoin)은 기본값으로 그립니다");
  let dash: number[] | undefined;
  const rawDash = style["stroke-dasharray"];
  if (rawDash && rawDash !== "none") {
    const values = rawDash.split(/[\s,]+/).filter(Boolean).map((v) => length(v, Math.hypot(ctx.viewport.width, ctx.viewport.height) / Math.SQRT2) ?? NaN);
    if (values.every((v) => v > 0) && values.length <= 16) dash = values;
    else if (values.some((v) => v !== 0)) ctx.warnings.add("0 또는 잘못된 값이 있는 점선 패턴은 실선으로 그립니다");
  }
  return { color, width, ...(opacity === 1 ? {} : { opacity }), ...(dash ? { dash } : {}) };
}

function nameOf(el: Element, fallback: string) {
  return (
    el.getAttribute("inkscape:label") ??
    el.getAttribute("data-name") ??
    el.getAttribute("id") ??
    fallback
  ).slice(0, 200);
}

/** Adds a node that passes document validation on its own; anything else
 * (non-finite numbers, zero font size, oversized paths) is left out with a
 * warning instead of failing the whole import. */
function add(ctx: Context, node: SceneNode): SceneNode | undefined {
  if (ctx.nodes.length >= ctx.limit) throw new Error("SVG 요소가 너무 많아 문서 레이어 제한을 넘습니다.");
  const page = createNode("page", null, { id: "svg-import-check", children: [node.id] });
  try {
    validateDocument({
      schemaVersion: 1,
      id: "svg-import-check",
      name: "check",
      rootId: page.id,
      nodes: { [page.id]: page, [node.id]: { ...node, parentId: page.id, children: [] } },
      assets: node.assetId && ctx.assets[node.assetId] ? { [node.assetId]: ctx.assets[node.assetId] } : {},
    });
  } catch {
    ctx.warnings.add("범위를 벗어나거나 잘못된 값이 있는 요소는 제외했습니다");
    return undefined;
  }
  ctx.nodes.push(node);
  return node;
}
const one = (node: SceneNode | undefined) => (node ? [node.id] : []);

function shapeNode(
  type: "rectangle" | "ellipse" | "path",
  el: Element,
  style: Style,
  parentId: string,
  transform: Matrix,
  box: Box,
  ctx: Context,
  extra: Partial<SceneNode> = {},
) {
  const fill = paintFor(style.fill, opacityOf(style["fill-opacity"]), box, style, ctx);
  const stroke = strokeFor(style, box, ctx);
  noteUnsupported(style, ctx);
  return add(
    ctx,
    createNode(type, parentId, {
      name: nameOf(el, type),
      transform: multiplyMatrices(transform, [1, 0, 0, 1, box.x, box.y]).map(clean) as Matrix,
      width: box.width,
      height: box.height,
      fill: fill ?? { type: "none" },
      ...(stroke ? { stroke } : {}),
      opacity: opacityOf(style.opacity),
      visible: style.visibility !== "hidden" && style.visibility !== "collapse",
      radius: 0,
      ...extra,
    }),
  );
}

function pathNode(el: Element, style: Style, parentId: string, transform: Matrix, segments: Segment[], ctx: Context) {
  const b = pathBounds(segments);
  if (!b) return [];
  const local = serializeSegments(transformSegments(segments, [1, 0, 0, 1, -b.x, -b.y]));
  if (local.length > MAX_PATH_DATA) {
    ctx.warnings.add("너무 긴 path는 가져오지 않습니다");
    return [];
  }
  const fillRule = style["fill-rule"] === "evenodd" ? "evenodd" : undefined;
  return one(
    shapeNode("path", el, style, parentId, transform, b, ctx, {
      path: { d: local, width: b.width, height: b.height, ...(fillRule ? { fillRule } : {}) },
    }),
  );
}

function viewBoxMatrix(el: Element, width: number, height: number): Matrix {
  const vb = numbers(el.getAttribute("viewBox"));
  if (vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0)) return IDENTITY;
  const [minX, minY, vw, vh] = vb;
  const par = (el.getAttribute("preserveAspectRatio") ?? "xMidYMid meet").trim().split(/\s+/);
  let sx = width / vw, sy = height / vh;
  if (par[0] !== "none") {
    const s = par[1] === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = sy = s;
  }
  const align = par[0] === "none" ? "xMinYMin" : par[0];
  const ax = /xMid/.test(align) ? 0.5 : /xMax/.test(align) ? 1 : 0;
  const ay = /YMid/.test(align) ? 0.5 : /YMax/.test(align) ? 1 : 0;
  return [sx, 0, 0, sy, (width - vw * sx) * ax - minX * sx, (height - vh * sy) * ay - minY * sy];
}

async function convertChildren(el: Element, parentId: string, style: Style, prefix: Matrix, ctx: Context) {
  const ids: string[] = [];
  for (const child of Array.from(el.children)) ids.push(...(await convert(child, parentId, style, prefix, ctx)));
  return ids;
}

function groupNode(el: Element, style: Style, parentId: string, transform: Matrix, ctx: Context, name = "group") {
  noteUnsupported(style, ctx);
  return add(
    ctx,
    createNode("group", parentId, {
      name: nameOf(el, name),
      transform: transform.map(clean) as Matrix,
      opacity: opacityOf(style.opacity),
      visible: style.visibility !== "hidden" && style.visibility !== "collapse",
    }),
  );
}
async function asGroup(
  el: Element, content: Element, style: Style, parentId: string, transform: Matrix, inner: Matrix, ctx: Context,
  contentStyle = style,
) {
  const group = groupNode(el, style, parentId, transform, ctx, localName(el));
  if (!group) return [];
  const children = await convertChildren(content, group.id, contentStyle, inner, ctx);
  if (!children.length) {
    ctx.nodes.splice(ctx.nodes.indexOf(group), 1);
    return [];
  }
  group.children = children;
  return [group.id];
}

async function convert(el: Element, parentId: string, parentStyle: Style, prefix: Matrix, ctx: Context): Promise<string[]> {
  const name = localName(el);
  if (el.namespaceURI !== SVG_NS) return [];
  if (SKIPPED.has(name)) return [];
  const style = computeStyle(el, parentStyle, ctx);
  if (style.display === "none") return [];
  const own = parseTransform(el.getAttribute("transform"));
  if (!own) {
    ctx.warnings.add("해석할 수 없는 transform이 있는 요소는 제외했습니다");
    return [];
  }
  const transform = multiplyMatrices(prefix, own);
  // Containers report animations among their children when they convert them.
  if (!["g", "a", "svg", "switch"].includes(name) && Array.from(el.children).some((c) => /^(animate|animateMotion|animateTransform|set)$/.test(c.localName)))
    ctx.warnings.add("애니메이션은 가져오지 않습니다");
  const vw = ctx.viewport.width, vh = ctx.viewport.height;
  const fs = length(style["font-size"], 16) ?? 16;
  const len = (attr: string, ref: number) => length(el.getAttribute(attr), ref, fs);
  switch (name) {
    case "g":
    case "a":
      return asGroup(el, el, style, parentId, transform, IDENTITY, ctx);
    case "switch": {
      ctx.warnings.add("switch는 첫 번째 하위 요소만 가져옵니다");
      const first = Array.from(el.children).find((c) => c.namespaceURI === SVG_NS);
      return first ? convert(first, parentId, style, transform, ctx) : [];
    }
    case "svg": {
      const width = len("width", vw) ?? vw, height = len("height", vh) ?? vh;
      ctx.warnings.add("중첩 svg의 영역 잘라내기는 적용하지 않습니다");
      const inner = multiplyMatrices([1, 0, 0, 1, len("x", vw) ?? 0, len("y", vh) ?? 0], viewBoxMatrix(el, width, height));
      return asGroup(el, el, style, parentId, transform, inner, ctx);
    }
    case "use": {
      const href = (el.getAttribute("href") ?? el.getAttributeNS(XLINK_NS, "href") ?? "").trim();
      const target = href.startsWith("#") ? ctx.ids.get(href.slice(1)) : undefined;
      if (!target) {
        ctx.warnings.add(href.startsWith("#") ? "대상이 없는 use는 제외했습니다" : "외부 파일을 가리키는 use는 가져오지 않습니다");
        return [];
      }
      if (ctx.useStack.has(target) || ctx.useStack.size > 32) {
        ctx.warnings.add("순환 참조하는 use는 제외했습니다");
        return [];
      }
      const offset = multiplyMatrices(transform, [1, 0, 0, 1, len("x", vw) ?? 0, len("y", vh) ?? 0]);
      ctx.useStack.add(target);
      try {
        if (localName(target) === "symbol" || localName(target) === "svg") {
          const width = len("width", vw) ?? length(target.getAttribute("width"), vw) ?? vw;
          const height = len("height", vh) ?? length(target.getAttribute("height"), vh) ?? vh;
          // A referenced svg keeps its own x/y; a symbol's styles cascade from the use.
          const place: Matrix = localName(target) === "svg"
            ? [1, 0, 0, 1, length(target.getAttribute("x"), vw) ?? 0, length(target.getAttribute("y"), vh) ?? 0]
            : IDENTITY;
          return await asGroup(
            el, target, style, parentId, offset,
            multiplyMatrices(place, viewBoxMatrix(target, width, height)), ctx,
            computeStyle(target, style, ctx),
          );
        }
        if (localName(target) === "g" || localName(target) === "a") {
          // One group for the use and its referenced group, with both transforms.
          const own = parseTransform(target.getAttribute("transform")) ?? IDENTITY;
          return await asGroup(el, target, computeStyle(target, style, ctx), parentId, multiplyMatrices(offset, own), IDENTITY, ctx);
        }
        // Referenced content inherits from the use element, not its original parent.
        const group = groupNode(el, style, parentId, offset, ctx, "use");
        if (!group) return [];
        const children = await convert(target, group.id, style, IDENTITY, ctx);
        if (!children.length) {
          ctx.nodes.splice(ctx.nodes.indexOf(group), 1);
          return [];
        }
        group.children = children;
        return [group.id];
      } finally {
        ctx.useStack.delete(target);
      }
    }
    case "rect": {
      const width = len("width", vw) ?? 0, height = len("height", vh) ?? 0;
      if (!(width > 0 && height > 0)) return [];
      let rx = len("rx", vw), ry = len("ry", vh);
      rx ??= ry; ry ??= rx;
      rx = Math.min(Math.max(0, rx ?? 0), width / 2);
      ry = Math.min(Math.max(0, ry ?? 0), height / 2);
      if (Math.abs(rx - ry) > 1e-6) ctx.warnings.add("가로·세로가 다른 모서리 반경은 작은 값으로 그립니다");
      const box = { x: len("x", vw) ?? 0, y: len("y", vh) ?? 0, width, height };
      return one(shapeNode("rectangle", el, style, parentId, transform, box, ctx, { radius: Math.min(rx, ry) }));
    }
    case "circle":
    case "ellipse": {
      const diag = Math.hypot(vw, vh) / Math.SQRT2;
      let rx = name === "circle" ? len("r", diag) : len("rx", vw);
      let ry = name === "circle" ? rx : len("ry", vh);
      rx ??= ry; ry ??= rx;
      if (!(rx! > 0 && ry! > 0)) return [];
      const cx = len("cx", vw) ?? 0, cy = len("cy", vh) ?? 0;
      return one(shapeNode("ellipse", el, style, parentId, transform, { x: cx - rx!, y: cy - ry!, width: 2 * rx!, height: 2 * ry! }, ctx));
    }
    case "line": {
      const p = ["x1", "y1", "x2", "y2"].map((a, i) => len(a, i % 2 ? vh : vw) ?? 0);
      return pathNode(el, style, parentId, transform, [{ c: "M", p: [p[0], p[1]] }, { c: "L", p: [p[2], p[3]] }], ctx);
    }
    case "polyline":
    case "polygon": {
      const v = numbers(el.getAttribute("points"));
      if (v.length < 4) return [];
      const segments: Segment[] = [];
      for (let i = 0; i + 1 < v.length; i += 2) segments.push({ c: i ? "L" : "M", p: [v[i], v[i + 1]] });
      if (name === "polygon") segments.push({ c: "Z" });
      return pathNode(el, style, parentId, transform, segments, ctx);
    }
    case "path": {
      const d = el.getAttribute("d") ?? "";
      if (d.length > MAX_PATH_DATA) {
        ctx.warnings.add("너무 긴 path는 가져오지 않습니다");
        return [];
      }
      const { segments, error } = parsePathData(d);
      if (error) ctx.warnings.add("path 데이터 오류: 오류 앞부분까지만 가져왔습니다");
      return pathNode(el, style, parentId, transform, segments, ctx);
    }
    case "text":
      return textNode(el, style, parentId, transform, ctx);
    case "image":
      return imageNode(el, style, parentId, transform, ctx);
    case "script":
      ctx.warnings.add("script는 실행하지 않고 제외했습니다");
      return [];
    case "foreignObject":
      ctx.warnings.add("foreignObject(HTML 내용)는 가져오지 않습니다");
      return [];
    case "animate":
    case "animateMotion":
    case "animateTransform":
    case "set":
      ctx.warnings.add("애니메이션은 가져오지 않습니다");
      return [];
    default:
      ctx.warnings.add(`지원하지 않는 요소 <${name}>는 제외했습니다`);
      return [];
  }
}

function textNode(el: Element, style: Style, parentId: string, transform: Matrix, ctx: Context): string[] {
  const lines: string[] = [];
  let current = "", lineHeight: number | undefined, firstY: number | undefined, x: number | undefined, y: number | undefined;
  const fontSize = length(style["font-size"], 16) ?? 16;
  if (!(fontSize > 0)) {
    ctx.warnings.add("글자 크기가 0 이하인 텍스트는 제외했습니다");
    return [];
  }
  const vw = ctx.viewport.width, vh = ctx.viewport.height;
  const preserve = el.getAttribute("xml:space") === "preserve";
  // First value of a coordinate list, with units (%, em) resolved.
  const first = (attr: string, e: Element) => {
    const raw = e.getAttribute(attr)?.trim().split(/[\s,]+/)[0];
    return raw ? length(raw, attr === "x" || attr === "dx" ? vw : vh, fontSize) : undefined;
  };
  x = first("x", el);
  y = first("y", el);
  if (numbers(el.getAttribute("x")).length > 1 || numbers(el.getAttribute("y")).length > 1 || el.hasAttribute("rotate"))
    ctx.warnings.add("글자별 위치·회전은 텍스트 시작 위치 하나로 그립니다");
  let mixed = false;
  const walk = (node: Element) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) current += child.textContent ?? "";
      else if (child.nodeType === 1) {
        const e = child as Element, n = localName(e);
        if (n === "textPath") {
          ctx.warnings.add("textPath는 일반 텍스트로 가져옵니다");
          walk(e);
        } else if (n === "tspan") {
          const ty = first("y", e), dy = first("dy", e);
          if ((ty !== undefined || (dy !== undefined && dy !== 0)) && (current.trim() || lines.length)) {
            lines.push(current);
            current = "";
            const nextY = ty ?? (firstY ?? y ?? 0) + (dy ?? 0);
            if (lineHeight === undefined && firstY !== undefined && nextY > firstY) lineHeight = nextY - firstY;
            firstY = nextY;
          } else if (!lines.length && !current.trim()) {
            // A leading tspan's own position wins over the text element's.
            x = first("x", e) ?? x;
            if (ty !== undefined) y = ty;
            else if (dy !== undefined) y = (y ?? 0) + dy;
            firstY = y;
          }
          const s = computeStyle(e, style, ctx);
          if (s.fill !== style.fill || s["font-size"] !== style["font-size"] || s["font-weight"] !== style["font-weight"]) mixed = true;
          walk(e);
        }
      }
    }
  };
  firstY = y;
  walk(el);
  lines.push(current);
  const content = lines
    .map((l) => (preserve ? l.replace(/[\r\n\t]/g, " ") : l.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim()))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  if (!content) return [];
  if (mixed) ctx.warnings.add("tspan별로 다른 글꼴·색은 텍스트 전체의 첫 스타일로 통일합니다");
  if (style["writing-mode"] && !/^(horizontal-tb|lr|lr-tb)$/.test(style["writing-mode"])) ctx.warnings.add("세로쓰기는 가로쓰기로 가져옵니다");
  if (el.hasAttribute("textLength")) ctx.warnings.add("textLength(글자 폭 맞춤)는 적용하지 않습니다");
  const family = (style["font-family"] ?? "sans-serif").split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  const fontFamily = family === "sans-serif" || !family ? "Noto Sans KR" : family;
  const weightRaw = (style["font-weight"] ?? "400").trim();
  const fontWeight = weightRaw === "bold" || weightRaw === "bolder" ? 700 : weightRaw === "lighter" ? 300 : Number(weightRaw) || 400;
  const anchor = style["text-anchor"] ?? "start";
  const box = { x: 0, y: 0, width: 1, height: 1 };
  const fill = paintFor(style.fill, opacityOf(style["fill-opacity"]), box, style, ctx);
  if (fill && fill.type !== "solid" && fill.type !== "none") {
    ctx.warnings.add("텍스트 gradient 채우기는 첫 번째 색으로 그립니다");
  }
  const solid: Paint =
    !fill || fill.type === "none"
      ? { type: "none" }
      : fill.type === "solid"
        ? fill
        : { type: "solid", color: fill.stops[0].color };
  if (style.stroke && style.stroke !== "none") ctx.warnings.add("텍스트 stroke는 가져오지 않습니다");
  noteUnsupported(style, ctx);
  const letterSpacing = length(style["letter-spacing"] === "normal" ? "0" : style["letter-spacing"], 0, fontSize) ?? 0;
  const node = createNode("text", parentId, {
    name: nameOf(el, content.split("\n")[0].slice(0, 40) || "text"),
    fill: solid,
    opacity: opacityOf(style.opacity),
    visible: style.visibility !== "hidden" && style.visibility !== "collapse",
    text: {
      content,
      fontFamily,
      fontSize,
      fontWeight: Math.min(900, Math.max(1, fontWeight)),
      lineHeight: Math.round((lineHeight ?? fontSize * 1.2) * 100) / 100,
      ...(letterSpacing ? { letterSpacing } : {}),
      align: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left",
      sizing: "auto-width",
    },
  });
  const layout = textLayout(node);
  node.width = layout.width;
  node.height = layout.height;
  const shift = anchor === "middle" ? layout.width / 2 : anchor === "end" ? layout.width : 0;
  // SVG positions the first baseline; the model places the box top-left.
  node.transform = multiplyMatrices(transform, [1, 0, 0, 1, (x ?? 0) - shift, (y ?? 0) - layout.lines[0].y]).map(clean) as Matrix;
  return one(add(ctx, node));
}

async function imageNode(el: Element, style: Style, parentId: string, transform: Matrix, ctx: Context): Promise<string[]> {
  const href = (el.getAttribute("href") ?? el.getAttributeNS(XLINK_NS, "href") ?? "").trim();
  if (!/^data:image\//i.test(href)) {
    ctx.warnings.add("외부 이미지(파일·URL 참조)는 가져오지 않습니다");
    return [];
  }
  if (!ctx.toPng) {
    ctx.warnings.add("이 환경에서는 이미지를 변환할 수 없어 제외했습니다");
    return [];
  }
  let png: PngImage;
  try {
    png = await ctx.toPng(href);
  } catch {
    ctx.warnings.add("읽을 수 없는 이미지는 제외했습니다");
    return [];
  }
  const vw = ctx.viewport.width, vh = ctx.viewport.height;
  const x = length(el.getAttribute("x"), vw) ?? 0, y = length(el.getAttribute("y"), vh) ?? 0;
  let width = length(el.getAttribute("width"), vw), height = length(el.getAttribute("height"), vh);
  if (width === undefined && height === undefined) [width, height] = [png.width, png.height];
  width ??= (height! * png.width) / png.height;
  height ??= (width * png.height) / png.width;
  if (!(width > 0 && height > 0)) return [];
  const par = (el.getAttribute("preserveAspectRatio") ?? "xMidYMid meet").trim().split(/\s+/);
  let box = { x, y, width, height };
  if (par[0] !== "none") {
    if (par[1] === "slice") ctx.warnings.add("잘라 채우는 이미지(slice)는 전체가 보이도록 맞춥니다");
    const s = Math.min(width / png.width, height / png.height);
    const w = png.width * s, h = png.height * s;
    const ax = /xMid/.test(par[0]) ? 0.5 : /xMax/.test(par[0]) ? 1 : 0;
    const ay = /YMid/.test(par[0]) ? 0.5 : /YMax/.test(par[0]) ? 1 : 0;
    box = { x: x + (width - w) * ax, y: y + (height - h) * ay, width: w, height: h };
  }
  let assetId = ctx.assetByUrl.get(png.dataUrl);
  if (!assetId) {
    assetId = crypto.randomUUID();
    ctx.assets[assetId] = { id: assetId, mimeType: "image/png", dataUrl: png.dataUrl, width: png.width, height: png.height };
    ctx.assetByUrl.set(png.dataUrl, assetId);
  }
  noteUnsupported(style, ctx);
  const node = createNode("image", parentId, {
    name: nameOf(el, "image"),
    assetId,
    fill: { type: "none" },
    opacity: opacityOf(style.opacity),
    visible: style.visibility !== "hidden" && style.visibility !== "collapse",
    transform: multiplyMatrices(transform, [1, 0, 0, 1, box.x, box.y]).map(clean) as Matrix,
    width: box.width,
    height: box.height,
  });
  return one(add(ctx, node));
}

/** Browser conversion of any decodable data: image to a PNG data URL. */
export async function browserToPng(dataUrl: string): Promise<PngImage> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  if (!img.naturalWidth || !img.naturalHeight) throw new Error("Empty image");
  if (img.naturalWidth > 16384 || img.naturalHeight > 16384 || img.naturalWidth * img.naturalHeight > 40e6)
    throw new Error("Image too large");
  if (/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]*$/.test(dataUrl))
    return { dataUrl, width: img.naturalWidth, height: img.naturalHeight };
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.drawImage(img, 0, 0);
  const png = canvas.toDataURL("image/png");
  if (!png.startsWith("data:image/png;base64,iVBORw0KGgo")) throw new Error("PNG encoding failed");
  return { dataUrl: png, width: img.naturalWidth, height: img.naturalHeight };
}

/** Parse SVG text into one frame of editable nodes. Asynchronous only for
 * embedded image decoding; insert the result with insertSvg. */
export async function parseSvg(source: string, options: SvgImportOptions): Promise<SvgFragment> {
  if (source.length > MAX_SVG_BYTES) throw new Error("SVG 파일이 너무 큽니다 (최대 10 MB).");
  // An inert XML document: nothing is rendered, fetched or executed.
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (parsed.getElementsByTagName("parsererror").length || root.namespaceURI !== SVG_NS || root.localName !== "svg")
    throw new Error("올바른 SVG 파일이 아닙니다.");
  const warnings = new Warnings();
  const ids = new Map<string, Element>();
  for (const el of Array.from(root.getElementsByTagName("*"))) {
    const id = el.getAttribute("id");
    if (id && !ids.has(id)) ids.set(id, el);
  }
  const vb = numbers(root.getAttribute("viewBox"));
  const hasViewBox = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
  const lengthOrBox = (attr: string, index: number, fallback: number) => {
    const raw = root.getAttribute(attr);
    const v = raw && !raw.trim().endsWith("%") ? length(raw, 0) : undefined;
    return v && v > 0 ? v : hasViewBox ? vb[index] : fallback;
  };
  const width = lengthOrBox("width", 2, 300), height = lengthOrBox("height", 3, 150);
  const ctx: Context = {
    nodes: [],
    assets: {},
    assetByUrl: new Map(),
    ids,
    rules: parseStyleSheets(root, warnings),
    warnings,
    viewport: { width: hasViewBox ? vb[2] : width, height: hasViewBox ? vb[3] : height },
    useStack: new Set(),
    toPng: options.toPng,
    limit: 100000,
  };
  const frame = createNode("frame", null, {
    name: options.name.slice(0, 200) || "SVG",
    width,
    height,
    fill: { type: "none" },
    clipContent: true,
    transform: [1, 0, 0, 1, options.center.x - width / 2, options.center.y - height / 2],
  });
  const rootStyle = computeStyle(root, ROOT_STYLE, ctx);
  noteUnsupported(rootStyle, ctx);
  frame.opacity = opacityOf(rootStyle.opacity);
  frame.children = await convertChildren(root, frame.id, rootStyle, viewBoxMatrix(root, width, height), ctx);
  if (!ctx.nodes.length) warnings.add("가져올 수 있는 도형이 없습니다");
  return { frame, nodes: ctx.nodes, assets: ctx.assets, warnings: warnings.list() };
}

/** A copy of `doc` with the fragment's frame appended to `parentId`. */
export function insertSvg(doc: SceneDocument, fragment: SvgFragment, parentId: string): SceneDocument {
  const parent = doc.nodes[parentId];
  if (!parent || !["page", "frame", "group"].includes(parent.type)) throw new Error("SVG를 넣을 위치가 올바르지 않습니다.");
  if (Object.keys(doc.nodes).length + fragment.nodes.length + 1 > 100000)
    throw new Error("SVG 요소가 너무 많아 문서 레이어 제한을 넘습니다.");
  // Only the parent changes; other nodes stay shared with the input.
  const frame = { ...structuredClone(fragment.frame), parentId };
  const next: SceneDocument = {
    ...doc,
    nodes: { ...doc.nodes, [parentId]: { ...parent, children: [...parent.children, frame.id] }, [frame.id]: frame },
    assets: { ...doc.assets, ...structuredClone(fragment.assets) },
  };
  for (const n of fragment.nodes) next.nodes[n.id] = structuredClone(n);
  try {
    validateDocument(next);
  } catch {
    throw new Error("SVG를 문서 노드로 바꾸지 못했습니다.");
  }
  return next;
}
