import type { Matrix, SceneNode } from "./core";

/** Vector outline stored as absolute M/L/C/Q/Z commands in an authored box
 * (0..width × 0..height). Node width/height scale it, so resizing never
 * rewrites the data and both renderers draw the same normalized commands. */
export type VectorPath = {
  d: string;
  width: number;
  height: number;
  fillRule?: "nonzero" | "evenodd";
};
export type Segment =
  | { c: "M" | "L"; p: [number, number] }
  | { c: "Q"; p: [number, number, number, number] }
  | { c: "C"; p: [number, number, number, number, number, number] }
  | { c: "Z" };

export const MAX_PATH_DATA = 2_000_000;
const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
const ARITY: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};

/** Parse SVG path syntax into absolute M/L/C/Q/Z segments. Like browsers, it
 * keeps everything before the first error; `error` reports where it stopped. */
export function parsePathData(d: string): { segments: Segment[]; error?: string } {
  const segments: Segment[] = [];
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i])) i++;
  };
  const number = (flag: boolean): number | undefined => {
    skip();
    if (flag) {
      // Arc flags may be written without separators ("a1 1 0 00 1 1").
      if (d[i] === "0" || d[i] === "1") return Number(d[i++]);
      return undefined;
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(d);
    if (!m) return undefined;
    i += m[0].length;
    return Number(m[0]);
  };
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastC: [number, number] | null = null, lastQ: [number, number] | null = null;
  let command = "";
  skip();
  while (i < d.length) {
    skip();
    if (i >= d.length) break;
    if (/[a-zA-Z]/.test(d[i])) {
      command = d[i++];
      if (!(command.toUpperCase() in ARITY))
        return { segments, error: `알 수 없는 명령 ${command}` };
    } else if (!command) return { segments, error: "명령 없이 시작하는 좌표" };
    if (!segments.length && command.toUpperCase() !== "M")
      return { segments, error: "M으로 시작하지 않는 path" };
    const upper = command.toUpperCase();
    const relative = command !== upper;
    const values: number[] = [];
    for (let k = 0; k < ARITY[upper]; k++) {
      const v = number(upper === "A" && (k === 3 || k === 4));
      if (v === undefined || !Number.isFinite(v))
        return { segments, error: `${command} 명령의 숫자가 잘못됨` };
      values.push(v);
    }
    const ox = relative ? x : 0, oy = relative ? y : 0;
    let nextC: [number, number] | null = null, nextQ: [number, number] | null = null;
    switch (upper) {
      case "M":
        x = values[0] + ox; y = values[1] + oy; sx = x; sy = y;
        segments.push({ c: "M", p: [x, y] });
        // Further pairs after a moveto are implicit linetos.
        command = relative ? "l" : "L";
        break;
      case "L":
        x = values[0] + ox; y = values[1] + oy;
        segments.push({ c: "L", p: [x, y] });
        break;
      case "H":
        x = values[0] + ox;
        segments.push({ c: "L", p: [x, y] });
        break;
      case "V":
        y = values[0] + (relative ? y : 0);
        segments.push({ c: "L", p: [x, y] });
        break;
      case "C": {
        const p: [number, number, number, number, number, number] = [
          values[0] + ox, values[1] + oy, values[2] + ox, values[3] + oy, values[4] + ox, values[5] + oy,
        ];
        segments.push({ c: "C", p });
        nextC = [p[2], p[3]]; x = p[4]; y = p[5];
        break;
      }
      case "S": {
        const c1: [number, number] = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
        const p: [number, number, number, number, number, number] = [
          c1[0], c1[1], values[0] + ox, values[1] + oy, values[2] + ox, values[3] + oy,
        ];
        segments.push({ c: "C", p });
        nextC = [p[2], p[3]]; x = p[4]; y = p[5];
        break;
      }
      case "Q": {
        const p: [number, number, number, number] = [values[0] + ox, values[1] + oy, values[2] + ox, values[3] + oy];
        segments.push({ c: "Q", p });
        nextQ = [p[0], p[1]]; x = p[2]; y = p[3];
        break;
      }
      case "T": {
        const c: [number, number] = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
        const p: [number, number, number, number] = [c[0], c[1], values[0] + ox, values[1] + oy];
        segments.push({ c: "Q", p });
        nextQ = c; x = p[2]; y = p[3];
        break;
      }
      case "A": {
        const ex = values[5] + ox, ey = values[6] + oy;
        for (const p of arcToCubics(x, y, values[0], values[1], values[2], values[3], values[4], ex, ey))
          segments.push({ c: "C", p });
        x = ex; y = ey;
        break;
      }
      case "Z":
        segments.push({ c: "Z" });
        x = sx; y = sy;
        break;
    }
    lastC = nextC; lastQ = nextQ;
    if (upper === "Z") {
      skip();
      // A command letter must follow closepath.
      if (i < d.length && !/[a-zA-Z]/.test(d[i]))
        return { segments, error: "Z 뒤의 좌표" };
    }
  }
  return { segments };
}

/** SVG arc (endpoint parameterization) as cubic Béziers, per SVG 1.1 F.6. */
function arcToCubics(
  x1: number, y1: number, rx: number, ry: number, angle: number,
  large: number, sweep: number, x2: number, y2: number,
): [number, number, number, number, number, number][] {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (angle * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const vector = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta = vector(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = vector((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const parts = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / parts, k = (4 / 3) * Math.tan(step / 4);
  const point = (t: number): [number, number] => [
    cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
  ];
  const derivative = (t: number): [number, number] => [
    -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
  ];
  const out: [number, number, number, number, number, number][] = [];
  for (let n = 0; n < parts; n++) {
    const t1 = theta + n * step, t2 = t1 + step;
    const p1 = point(t1), p2 = n === parts - 1 ? ([x2, y2] as [number, number]) : point(t2);
    const d1 = derivative(t1), d2 = derivative(t2);
    out.push([p1[0] + k * d1[0], p1[1] + k * d1[1], p2[0] - k * d2[0], p2[1] - k * d2[1], p2[0], p2[1]]);
  }
  return out;
}

/** Exact bounds including Bézier extrema; null for a path without points. */
export function pathBounds(segments: Segment[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (px: number, py: number) => {
    minX = Math.min(minX, px); minY = Math.min(minY, py);
    maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
  };
  let x = 0, y = 0, sx = 0, sy = 0;
  for (const s of segments) {
    if (s.c === "Z") { x = sx; y = sy; continue; }
    if (s.c === "M" || s.c === "L") {
      [x, y] = s.p;
      if (s.c === "M") { sx = x; sy = y; }
      add(x, y);
      continue;
    }
    const q = s.p;
    const pts: [number, number][] = [[x, y]];
    for (let k = 0; k < q.length; k += 2) pts.push([q[k]!, q[k + 1]!]);
    for (const axis of [0, 1] as const) {
      for (const t of extrema(pts.map((p) => p[axis]))) {
        const point = bezier(pts, t);
        add(point[0], point[1]);
      }
    }
    const [ex, ey] = pts[pts.length - 1]!;
    add(ex, ey);
    x = ex; y = ey;
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}
function extrema(v: number[]): number[] {
  const roots: number[] = [];
  if (v.length === 3) {
    const den = v[0] - 2 * v[1] + v[2];
    if (den) roots.push((v[0] - v[1]) / den);
  } else {
    // Derivative of a cubic: a t² + b t + c.
    const a = -v[0] + 3 * v[1] - 3 * v[2] + v[3], b = 2 * (v[0] - 2 * v[1] + v[2]), c = v[1] - v[0];
    if (Math.abs(a) < 1e-12) {
      if (b) roots.push(-c / b);
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const r = Math.sqrt(disc);
        roots.push((-b + r) / (2 * a), (-b - r) / (2 * a));
      }
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}
function bezier(p: [number, number][], t: number): [number, number] {
  let pts = p;
  while (pts.length > 1) {
    const prev = pts;
    pts = prev.slice(1).map((q, i): [number, number] => {
      const a = prev[i]!;
      return [a[0] + (q[0] - a[0]) * t, a[1] + (q[1] - a[1]) * t];
    });
  }
  return pts[0]!;
}

export function transformSegments(segments: Segment[], m: Matrix): Segment[] {
  const map = (p: number[]) =>
    p.map((v, i) =>
      i % 2 === 0 ? m[0] * v + m[2] * p[i + 1] + m[4] : m[1] * p[i - 1] + m[3] * v + m[5],
    );
  return segments.map((s) => (s.c === "Z" ? s : ({ c: s.c, p: map(s.p) } as Segment)));
}

// Nine significant digits keep tiny viewBox units precise once scaled up.
const fmt = (v: number) => {
  if (!Number.isFinite(v)) return "0";
  const r = Number(v.toPrecision(9));
  return Object.is(r, -0) ? "0" : String(r);
};
export function serializeSegments(segments: Segment[]): string {
  return segments.map((s) => (s.c === "Z" ? "Z" : `${s.c} ${s.p.map(fmt).join(" ")}`)).join(" ");
}

/** Normalized command grammar; anything else is rejected at validation. */
export function validVectorPath(v: unknown): v is VectorPath {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return (
    Object.keys(p).every((k) => ["d", "width", "height", "fillRule"].includes(k)) &&
    typeof p.d === "string" &&
    p.d.length <= MAX_PATH_DATA &&
    /^(?:M[-+0-9.eE\s]*(?:[MLCQZ][-+0-9.eE\s]*)*)?$/.test(p.d) &&
    [p.width, p.height].every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1e7) &&
    (p.fillRule === undefined || p.fillRule === "nonzero" || p.fillRule === "evenodd")
  );
}

const cache = new Map<string, string>();
/** Path data scaled to the node's current box, re-serialized from parsed
 * numbers so stored text never reaches markup verbatim. */
export function nodePathData(node: SceneNode): string {
  const path = node.path;
  if (!path) return "";
  const sx = path.width ? node.width / path.width : 1,
    sy = path.height ? node.height / path.height : 1;
  const key = `${sx} ${sy} ${path.d}`;
  let text = cache.get(key);
  if (text !== undefined) {
    // Least recently used order: a hit moves to the end.
    cache.delete(key);
    cache.set(key, text);
  } else {
    const { segments } = parsePathData(path.d);
    text = serializeSegments(sx === 1 && sy === 1 ? segments : transformSegments(segments, [sx, 0, 0, sy, 0, 0]));
    if (cache.size > 4096) cache.delete(cache.keys().next().value!);
    cache.set(key, text);
  }
  return text;
}
