import type { SceneNode } from "./core";
import type { Layout } from "./flex-layout";

export type GridTrack = number | "auto" | { fr: number };
export type GridSettings = {
  columns?: GridTrack[];
  rows?: GridTrack[];
  areas?: string[];
  autoColumns?: GridTrack;
  autoRows?: GridTrack;
  column?: number;
  row?: number;
  columnSpan?: number;
  rowSpan?: number;
  area?: string;
};
type Size = { width: number; height: number };
type Cell = {
  id: string;
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
};
const trackValid = (v: unknown): v is GridTrack =>
  v === "auto" ||
  (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e7) ||
  (!!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v).length === 1 &&
    "fr" in v &&
    typeof v.fr === "number" &&
    Number.isFinite(v.fr) &&
    v.fr > 0 &&
    v.fr <= 1e7);
const areaName = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
export function gridAreas(rows: string[] = []) {
  const cells = rows.map((row) => row.trim().split(/\s+/));
  const areas = new Map<string, Omit<Cell, "id">>();
  for (let r = 0; r < cells.length; r++) {
    if (cells[r].length !== cells[0].length)
      throw new Error("Grid area rows must have equal widths");
    for (let c = 0; c < cells[r].length; c++) {
      const name = cells[r][c];
      if (name === ".") continue;
      if (!areaName.test(name)) throw new Error("Invalid Grid area name");
      const old = areas.get(name);
      if (!old)
        areas.set(name, { column: c, row: r, columnSpan: 1, rowSpan: 1 });
      else {
        const endColumn = Math.max(old.column + old.columnSpan, c + 1);
        const endRow = Math.max(old.row + old.rowSpan, r + 1);
        old.column = Math.min(old.column, c);
        old.row = Math.min(old.row, r);
        old.columnSpan = endColumn - old.column;
        old.rowSpan = endRow - old.row;
      }
    }
  }
  for (const [name, a] of areas)
    for (let r = a.row; r < a.row + a.rowSpan; r++)
      for (let c = a.column; c < a.column + a.columnSpan; c++)
        if (cells[r][c] !== name)
          throw new Error("Grid areas must be rectangles");
  return { areas, columns: cells[0]?.length ?? 0, rows: cells.length };
}
export function validGrid(v: unknown): boolean {
  if (v === undefined) return true;
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const g = v as GridSettings;
  for (const key of ["columns", "rows"] as const)
    if (
      g[key] !== undefined &&
      (!Array.isArray(g[key]) ||
        !g[key]!.length ||
        g[key]!.length > 128 ||
        !g[key]!.every(trackValid))
    )
      return false;
  for (const key of ["autoColumns", "autoRows"] as const)
    if (g[key] !== undefined && !trackValid(g[key])) return false;
  for (const key of ["column", "row", "columnSpan", "rowSpan"] as const)
    if (
      g[key] !== undefined &&
      (!Number.isInteger(g[key]) || g[key]! < 1 || g[key]! > 128)
    )
      return false;
  if (
    g.area !== undefined &&
    (typeof g.area !== "string" || !areaName.test(g.area))
  )
    return false;
  if (g.areas !== undefined) {
    if (
      !Array.isArray(g.areas) ||
      g.areas.length > 128 ||
      !g.areas.every(
        (s) =>
          typeof s === "string" &&
          s.length <= 8192 &&
          s.trim().split(/\s+/).length <= 128,
      )
    )
      return false;
    try {
      gridAreas(g.areas);
    } catch {
      return false;
    }
  }
  return true;
}

/** Row-major sparse auto placement; explicit overlap is intentional. Positive
 * one-based lines only. Explicit rows are placed before fully automatic items. */
export function gridPlacement(children: SceneNode[], layout: Layout) {
  const g = layout.grid ?? {},
    template = gridAreas(g.areas);
  const cells: Cell[] = children.map((n) => {
    const p = n.layout.grid ?? {},
      area = p.area ? template.areas.get(p.area) : undefined;
    return {
      id: n.id,
      column: p.column === undefined ? -1 : p.column - 1,
      row: p.row === undefined ? -1 : p.row - 1,
      columnSpan: p.columnSpan ?? 1,
      rowSpan: p.rowSpan ?? 1,
      ...area,
    };
  });
  let columns = Math.max(
    1,
    g.columns?.length ?? 0,
    template.columns,
    ...cells.map((c) => Math.max(0, c.column) + c.columnSpan),
  );
  const occupied: Cell[] = [];
  const free = (c: Cell) =>
    !occupied.some(
      (o) =>
        c.column < o.column + o.columnSpan &&
        o.column < c.column + c.columnSpan &&
        c.row < o.row + o.rowSpan &&
        o.row < c.row + c.rowSpan,
    );
  const place = (c: Cell) => {
    occupied.push(c);
  };
  cells.filter((c) => c.row >= 0 && c.column >= 0).forEach(place);
  // Row-locked items keep a per-row sparse cursor and may extend implicit columns.
  const rowCursors = new Map<number, number>();
  for (const c of cells.filter((c) => c.row >= 0 && c.column < 0)) {
    c.column = rowCursors.get(c.row) ?? 0;
    while (!free(c)) c.column++;
    rowCursors.set(c.row, c.column + c.columnSpan);
    columns = Math.max(columns, c.column + c.columnSpan);
    place(c);
  }
  let cursorRow = 0,
    cursorColumn = 0;
  for (const c of cells.filter((c) => c.row < 0)) {
    c.row = cursorRow;
    if (c.column >= 0) {
      if (c.column < cursorColumn) c.row++;
      while (!free(c)) c.row++;
    } else {
      c.column = cursorColumn;
      while (c.column + c.columnSpan > columns || !free(c)) {
        c.column++;
        if (c.column + c.columnSpan > columns) {
          c.column = 0;
          c.row++;
        }
      }
    }
    cursorRow = c.row;
    cursorColumn = c.column;
    place(c);
  }
  return {
    cells,
    columns,
    rows: Math.max(
      g.rows?.length ?? 0,
      template.rows,
      ...cells.map((c) => c.row + c.rowSpan),
      0,
    ),
  };
}
function tracks(
  count: number,
  explicit: GridTrack[] | undefined,
  implicit: GridTrack = "auto",
  cells: Cell[],
  axis: "column" | "row",
  sizes: Map<string, Size>,
  available: number,
  gap: number,
  hug: boolean,
) {
  const defs = Array.from(
    { length: count },
    (_, i) => explicit?.[i] ?? implicit,
  );
  const values = defs.map((d) => (typeof d === "number" ? d : 0));
  const spanKey = axis === "column" ? "columnSpan" : "rowSpan";
  const sizeKey = axis === "column" ? "width" : "height";
  // Increasing span order preserves single-track intrinsic contributions first.
  for (const c of [...cells].sort((a, b) => a[spanKey] - b[spanKey])) {
    const indices = Array.from({ length: c[spanKey] }, (_, i) => c[axis] + i);
    const auto = indices.filter((i) => defs[i] === "auto");
    const deficit =
      (sizes.get(c.id)?.[sizeKey] ?? 0) -
      indices.reduce((sum, i) => sum + values[i], 0) -
      (indices.length - 1) * gap;
    if (deficit > 0 && auto.length)
      auto.forEach((i) => (values[i] += deficit / auto.length));
  }
  if (hug) {
    // Indefinite fractional tracks preserve their ratios, sized to the largest
    // per-item fraction needed after fixed/auto tracks and gutters are removed.
    let fraction = 0;
    for (const c of cells) {
      const indices = Array.from({ length: c[spanKey] }, (_, i) => c[axis] + i);
      const weight = indices.reduce(
        (sum, i) =>
          sum +
          (typeof defs[i] === "object" ? (defs[i] as { fr: number }).fr : 0),
        0,
      );
      if (!weight) continue;
      const fixed =
        indices.reduce((sum, i) => sum + values[i], 0) +
        (indices.length - 1) * gap;
      fraction = Math.max(
        fraction,
        ((sizes.get(c.id)?.[sizeKey] ?? 0) - fixed) / weight,
      );
    }
    defs.forEach((d, i) => {
      if (typeof d === "object") values[i] = fraction * d.fr;
    });
  } else {
    const fractions = defs.reduce<number>(
      (sum, d) => sum + (typeof d === "object" ? d.fr : 0),
      0,
    );
    const remaining = Math.max(
      0,
      available -
        values.reduce((sum, v) => sum + v, 0) -
        Math.max(0, count - 1) * gap,
    );
    if (fractions)
      defs.forEach((d, i) => {
        if (typeof d === "object")
          values[i] = (remaining * d.fr) / Math.max(1, fractions);
      });
    else {
      const autos = defs.flatMap((d, i) => (d === "auto" ? [i] : []));
      autos.forEach((i) => (values[i] += remaining / autos.length));
    }
  }
  return values;
}
export function gridPlan(
  n: SceneNode,
  children: SceneNode[],
  sizes: Map<string, Size>,
  size: Size,
  hugWidth = false,
  hugHeight = false,
) {
  const g = n.layout.grid ?? {},
    p = gridPlacement(children, n.layout),
    gap = n.layout.gap ?? 0;
  const [top, right, bottom, left] = n.layout.padding ?? [0, 0, 0, 0];
  const columns = tracks(
    p.columns,
    g.columns,
    g.autoColumns,
    p.cells,
    "column",
    sizes,
    Math.max(0, size.width - left - right),
    gap,
    hugWidth,
  );
  const rows = tracks(
    p.rows,
    g.rows,
    g.autoRows,
    p.cells,
    "row",
    sizes,
    Math.max(0, size.height - top - bottom),
    gap,
    hugHeight,
  );
  const sum = (v: number[]) => v.reduce((s, x) => s + x, 0);
  const extent = (v: number[], start: number, span: number) =>
    sum(v.slice(start, start + span)) + Math.max(0, span - 1) * gap;
  return {
    width: left + right + extent(columns, 0, columns.length),
    height: top + bottom + extent(rows, 0, rows.length),
    boxes: p.cells.map((c) => ({
      id: c.id,
      x: left + sum(columns.slice(0, c.column)) + c.column * gap,
      y: top + sum(rows.slice(0, c.row)) + c.row * gap,
      width: extent(columns, c.column, c.columnSpan),
      height: extent(rows, c.row, c.rowSpan),
    })),
  };
}

/** Inspector grammar deliberately excludes arbitrary CSS functions and eval. */
export function parseGridTracks(text: string): GridTrack[] | undefined {
  if (!text.trim()) return undefined;
  const result = text
    .trim()
    .split(/\s+/)
    .map((token): GridTrack => {
      if (token === "auto") return token;
      if (/^(?:\d+(?:\.\d+)?|\.\d+)fr$/.test(token))
        return { fr: Number(token.slice(0, -2)) };
      if (/^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(token))
        return Number(token.replace(/px$/, ""));
      throw new Error("Use px, fr or auto tracks");
    });
  if (!validGrid({ columns: result })) throw new Error("Invalid Grid tracks");
  return result;
}
export const formatGridTracks = (tracks?: GridTrack[]) =>
  tracks
    ?.map((t) =>
      typeof t === "number"
        ? `${t}px`
        : typeof t === "object"
          ? `${t.fr}fr`
          : t,
    )
    .join(" ") ?? "";
