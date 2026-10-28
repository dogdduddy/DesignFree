import { resolveDocumentStyles } from "./style-library";
import { gridPlan, type GridSettings } from "./grid-layout";
import {
  normalizeGroupBounds,
  type SceneDocument,
  type SceneNode,
} from "./core";
import { textLayout, type MeasureText, measureText } from "./text-layout";

export type Layout = {
  mode: "absolute" | "flex" | "grid";
  grid?: GridSettings;
  direction?: "row" | "column";
  gap?: number;
  padding?: [number, number, number, number];
  align?: "start" | "center" | "end" | "stretch";
  justify?:
    | "start"
    | "center"
    | "end"
    | "space-between"
    | "space-around"
    | "space-evenly";
  wrap?: boolean;
  width?: "fixed" | "hug" | "fill";
  height?: "fixed" | "hug" | "fill";
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  position?: "flow" | "absolute";
};
type Size = { width: number; height: number };
type Axis = "width" | "height";
const clamp = (n: SceneNode, axis: Axis, value: number) => {
  const min = axis === "width" ? n.layout.minWidth : n.layout.minHeight;
  const max = axis === "width" ? n.layout.maxWidth : n.layout.maxHeight;
  const padding =
    n.layout.mode === "flex" || n.layout.mode === "grid"
      ? (n.layout.padding ?? [0, 0, 0, 0])
      : [0, 0, 0, 0];
  const paddingFloor =
    axis === "width" ? padding[1] + padding[3] : padding[0] + padding[2];
  return Math.max(paddingFloor, min ?? 0, Math.min(max ?? Infinity, value));
};

/** Border-box flex subset, independent of DOM and authored geometry.
 * Fixed items never shrink. Fill has a zero main basis and equal growth, subject
 * to min/max; overflow is retained. Hug/fill cycles use the child's intrinsic
 * (authored leaf) size, rather than iterating an underdetermined CSS percentage.
 * Transforms affect painting, not flex allocation, as with CSS transforms.
 */
export function computeLayout(
  source: SceneDocument,
  measure: MeasureText = measureText,
): SceneDocument {
  if (source.styleLibrary)
    source = normalizeGroupBounds(resolveDocumentStyles(source), measure);
  const result = structuredClone(source);
  const intrinsic = new Map<string, Size>();
  const flow = (n: SceneNode) =>
    n.children
      .map((id) => source.nodes[id])
      .filter((c) => c.visible && c.layout.position !== "absolute");
  function natural(id: string): Size {
    const cached = intrinsic.get(id);
    if (cached) return cached;
    const n = source.nodes[id],
      l = n.layout;
    let size: Size = { width: n.width, height: n.height };
    if (n.text) {
      const text = textLayout(
        {
          ...n,
          text: {
            ...n.text,
            sizing:
              l.width === "hug"
                ? "auto-width"
                : l.height === "hug"
                  ? "auto-height"
                  : n.text.sizing,
          },
        },
        measure,
      );
      size = {
        width: l.width === "hug" ? text.width : n.width,
        height: l.height === "hug" ? text.height : n.height,
      };
    }
    if (l.mode === "flex") {
      const children = flow(n),
        row = l.direction !== "column",
        gap = l.gap ?? 0;
      const [top, right, bottom, left] = l.padding ?? [0, 0, 0, 0];
      const sizes = children.map((c) => natural(c.id));
      const main: Axis = row ? "width" : "height",
        cross: Axis = row ? "height" : "width";
      const content = { width: left + right, height: top + bottom };
      content[main] +=
        sizes.reduce((sum, s) => sum + s[main], 0) +
        Math.max(0, children.length - 1) * gap;
      content[cross] += Math.max(0, ...sizes.map((s) => s[cross]));
      if (l.width === "hug") size.width = content.width;
      if (l.height === "hug") size.height = content.height;
    }
    if (l.mode === "grid") {
      const children = flow(n);
      const plan = gridPlan(
        n,
        children,
        new Map(children.map((c) => [c.id, natural(c.id)])),
        size,
        l.width === "hug",
        l.height === "hug",
      );
      if (l.width === "hug") size.width = plan.width;
      if (l.height === "hug") size.height = plan.height;
    }
    size = {
      width: clamp(n, "width", size.width),
      height: clamp(n, "height", size.height),
    };
    intrinsic.set(id, size);
    return size;
  }
  function visit(id: string, forced: Partial<Size> = {}) {
    const original = source.nodes[id],
      n = result.nodes[id],
      l = original.layout;
    const base = natural(id);
    n.width = clamp(original, "width", forced.width ?? base.width);
    n.height = clamp(original, "height", forced.height ?? base.height);
    if (
      n.text &&
      (l.width ||
        l.height ||
        forced.width !== undefined ||
        forced.height !== undefined)
    ) {
      // Dimensions are already resolved; never let renderer auto-width undo max/fill.
      n.text.sizing = l.height === "hug" ? "auto-height" : "fixed";
    }
    if (original.text && l.height === "hug") {
      n.height = clamp(
        original,
        "height",
        forced.height ??
          textLayout(
            { ...n, text: { ...n.text!, sizing: "auto-height" } },
            measure,
          ).height,
      );
    }
    if (l.mode === "grid") {
      const children = flow(original);
      const sizes = new Map(children.map((c) => [c.id, natural(c.id)]));
      const hugWidth = l.width === "hug" && forced.width === undefined;
      const hugHeight = l.height === "hug" && forced.height === undefined;
      let plan = gridPlan(original, children, sizes, n, hugWidth, hugHeight);
      if (hugWidth) n.width = clamp(original, "width", plan.width);
      const intrinsicWidth = hugWidth && n.width === plan.width;
      plan = gridPlan(original, children, sizes, n, intrinsicWidth, hugHeight);
      // Measure wrapping at final constrained column widths. Allocated fill width
      // is never an intrinsic contribution to auto columns on the second pass.
      for (const box of plan.boxes) {
        const child = source.nodes[box.id];
        visit(
          box.id,
          child.layout.width === "fill" ? { width: box.width } : {},
        );
        const actual = result.nodes[box.id],
          base = natural(box.id);
        sizes.set(box.id, {
          width: child.layout.width === "fill" ? base.width : actual.width,
          height: child.layout.height === "fill" ? base.height : actual.height,
        });
      }
      plan = gridPlan(original, children, sizes, n, intrinsicWidth, hugHeight);
      if (hugHeight) n.height = clamp(original, "height", plan.height);
      plan = gridPlan(
        original,
        children,
        sizes,
        n,
        intrinsicWidth,
        hugHeight && n.height === plan.height,
      );
      for (const box of plan.boxes) {
        const child = source.nodes[box.id];
        visit(box.id, {
          ...(child.layout.width === "fill" ? { width: box.width } : {}),
          ...(child.layout.height === "fill" ? { height: box.height } : {}),
        });
        const c = result.nodes[box.id];
        c.transform[4] = box.x;
        c.transform[5] =
          box.y +
          (l.align === "center"
            ? (box.height - c.height) / 2
            : l.align === "end"
              ? box.height - c.height
              : 0);
      }
      const ids = new Set(children.map((c) => c.id));
      for (const child of original.children) if (!ids.has(child)) visit(child);
      return;
    }
    if (l.mode !== "flex") {
      original.children.forEach((child) => visit(child));
      return;
    }
    const row = l.direction !== "column",
      main: Axis = row ? "width" : "height",
      cross: Axis = row ? "height" : "width";
    const [top, right, bottom, left] = l.padding ?? [0, 0, 0, 0];
    const mainStart = row ? left : top,
      crossStart = row ? top : left;
    const mainPad = row ? left + right : top + bottom,
      crossPad = row ? top + bottom : left + right;
    let available = Math.max(0, n[main] - mainPad);
    const gap = l.gap ?? 0;
    const mainHug = l[main] === "hug" && forced[main] === undefined;
    const children = flow(original);
    // Hug main sizes need the child's completed layout, including internal wrap.
    // A fixed cross width can affect height just as a definite cross fill does.
    const bases = new Map<string, number>();
    const measured = new Set<string>();
    for (const child of children) {
      const definiteCross = l[cross] !== "hug" || forced[cross] !== undefined;
      if (child.layout[main] === "hug") {
        visit(
          child.id,
          child.layout[cross] === "fill" && definiteCross && !l.wrap
            ? { [cross]: Math.max(0, n[cross] - crossPad) }
            : {},
        );
        bases.set(child.id, result.nodes[child.id][main]);
        measured.add(child.id);
      } else bases.set(child.id, natural(child.id)[main]);
    }
    if (mainHug) {
      n[main] = clamp(
        original,
        main,
        mainPad +
          children.reduce((sum, c) => sum + bases.get(c.id)!, 0) +
          Math.max(0, children.length - 1) * gap,
      );
      available = Math.max(0, n[main] - mainPad);
    }
    const basis = (c: SceneNode) =>
      c.layout[main] === "fill" && !mainHug
        ? clamp(c, main, 0)
        : bases.get(c.id)!;
    const lines: SceneNode[][] = [];
    let line: SceneNode[] = [],
      used = 0;
    for (const child of children) {
      const size = basis(child);
      if (l.wrap && line.length && used + gap + size > available + 1e-9) {
        lines.push(line);
        line = [];
        used = 0;
      }
      used += (line.length ? gap : 0) + size;
      line.push(child);
    }
    if (line.length) lines.push(line);
    const lineData = lines.map((items) => {
      const allocations = new Map(items.map((c) => [c.id, basis(c)]));
      // Freeze only the constraint sign of the total violation, as CSS flex does.
      // Simultaneously freezing opposing min/max violations can create false overflow.
      let pending = mainHug
        ? []
        : items.filter((c) => c.layout[main] === "fill");
      while (pending.length) {
        const ids = new Set(pending.map((c) => c.id));
        const occupied = items.reduce(
          (sum, c) => sum + (ids.has(c.id) ? 0 : allocations.get(c.id)!),
          0,
        );
        const share = Math.max(
          0,
          (available - occupied - Math.max(0, items.length - 1) * gap) /
            pending.length,
        );
        const violation = pending.reduce(
          (sum, c) => sum + clamp(c, main, share) - share,
          0,
        );
        const frozen = pending.filter((c) => {
          const delta = clamp(c, main, share) - share;
          return violation > 1e-9
            ? delta > 1e-9
            : violation < -1e-9
              ? delta < -1e-9
              : Math.abs(delta) > 1e-9;
        });
        if (!frozen.length) {
          pending.forEach((c) => allocations.set(c.id, share));
          break;
        }
        frozen.forEach((c) => allocations.set(c.id, clamp(c, main, share)));
        pending = pending.filter((c) => !frozen.includes(c));
      }
      for (const c of items) {
        const targetCross =
          !l.wrap &&
          c.layout[cross] === "fill" &&
          (l[cross] !== "hug" || forced[cross] !== undefined)
            ? Math.max(0, n[cross] - crossPad)
            : undefined;
        const computed = result.nodes[c.id];
        if (
          !measured.has(c.id) ||
          computed[main] !== allocations.get(c.id)! ||
          (targetCross !== undefined &&
            computed[cross] !== clamp(c, cross, targetCross))
        ) {
          visit(c.id, {
            [main]: allocations.get(c.id)!,
            ...(targetCross === undefined ? {} : { [cross]: targetCross }),
          });
        }
      }
      return {
        items,
        allocations,
        crossSize: Math.max(0, ...items.map((c) => result.nodes[c.id][cross])),
      };
    });
    if (l[cross] === "hug" && forced[cross] === undefined) {
      n[cross] = clamp(
        original,
        cross,
        crossPad +
          lineData.reduce((sum, d) => sum + d.crossSize, 0) +
          Math.max(0, lines.length - 1) * gap,
      );
    }
    // No align-content property in this subset: wrapped lines pack at cross-start.
    let crossCursor = crossStart;
    for (const data of lineData) {
      const lineCross = !l.wrap
        ? Math.max(0, n[cross] - crossPad)
        : data.crossSize;
      const occupied =
        data.items.reduce((sum, c) => sum + data.allocations.get(c.id)!, 0) +
        Math.max(0, data.items.length - 1) * gap;
      const free = available - occupied,
        count = data.items.length;
      let start = 0,
        extraGap = 0;
      switch (l.justify) {
        case "center":
          start = free / 2;
          break;
        case "end":
          start = free;
          break;
        case "space-between":
          extraGap = count > 1 ? Math.max(0, free) / (count - 1) : 0;
          break;
        case "space-around":
          extraGap = Math.max(0, free) / count;
          start = extraGap / 2;
          break;
        case "space-evenly":
          extraGap = Math.max(0, free) / (count + 1);
          start = extraGap;
          break;
      }
      let cursor = mainStart + start;
      for (const child of data.items) {
        const c = result.nodes[child.id];
        // Explicit fixed and hug cross dimensions are retained, even for stretch.
        if (
          child.layout[cross] === "fill" &&
          Math.abs(c[cross] - clamp(child, cross, lineCross)) > 1e-9
        )
          visit(child.id, {
            [main]: data.allocations.get(child.id)!,
            [cross]: lineCross,
          });
        const remaining = lineCross - c[cross];
        const offset =
          l.align === "center"
            ? remaining / 2
            : l.align === "end"
              ? remaining
              : 0;
        c.transform[4] = row ? cursor : crossCursor + offset;
        c.transform[5] = row ? crossCursor + offset : cursor;
        cursor += c[main] + gap + extraGap;
      }
      crossCursor += lineCross + gap;
    }
    const flowIds = new Set(children.map((c) => c.id));
    for (const child of original.children)
      if (!flowIds.has(child)) visit(child);
  }
  (source.pageIds ?? [source.rootId]).forEach((id) => visit(id));
  return result;
}
