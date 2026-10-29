import type { SceneDocument, SceneNode } from "./core";
import { gridPlacement, type GridTrack } from "./grid-layout";

const px = (n: number) => `${n}px`;
const alignment = (value?: string) =>
  value === "center" ? "center" : value === "end" ? "flex-end" : "flex-start";
const track = (value: GridTrack) =>
  typeof value === "number"
    ? px(value)
    : value === "auto"
      ? "auto"
      : `minmax(0,${value.fr}fr)`;

/** Conservative CSS boundary. Unsupported intrinsic algorithms retain local boxes. */
export function webLayout(doc: SceneDocument, warnings: Set<string>) {
  const containers = new Map<string, string[]>();
  const placements = new Map<string, string[]>();
  for (const node of Object.values(doc.nodes)) {
    const l = node.layout;
    if (l.mode === "absolute") continue;
    const children = node.children
      .map((id) => doc.nodes[id])
      .filter((c) => c.visible && c.layout.position !== "absolute");
    let reason = "";
    if (l.width === "hug" || l.height === "hug")
      reason = "hug 컨테이너의 intrinsic 크기·fill 순환";
    if (l.mode === "flex") {
      const main = l.direction === "column" ? "height" : "width";
      const fillPadding = children
        .filter((c) => c.layout[main] === "fill")
        .map((c) => {
          const p =
            c.layout.mode === "absolute"
              ? [0, 0, 0, 0]
              : (c.layout.padding ?? [0, 0, 0, 0]);
          return main === "width" ? p[1] + p[3] : p[0] + p[2];
        });
      if (new Set(fillPadding).size > 1)
        reason =
          "서로 다른 padding을 가진 main-axis fill의 border-box 균등 분배";
    }
    if (l.mode === "flex" && l.wrap) {
      const cross = l.direction === "column" ? "width" : "height";
      if (children.some((c) => c.layout[cross] === "fill"))
        reason = "wrap과 cross-axis fill의 intrinsic line 크기";
    }
    const css = [
      `display:${l.mode}`,
      `gap:${px(l.gap ?? 0)}`,
      `padding:${(l.padding ?? [0, 0, 0, 0]).map(px).join(" ")}`,
    ];
    if (l.mode === "flex") {
      css.push(
        `flex-direction:${l.direction ?? "row"}`,
        `flex-wrap:${l.wrap ? "wrap" : "nowrap"}`,
        "align-content:flex-start",
        `align-items:${alignment(l.align)}`,
        `justify-content:${["start", "end", undefined].includes(l.justify) ? alignment(l.justify) : l.justify}`,
      );
    } else {
      const g = l.grid ?? {};
      const p = gridPlacement(children, l);
      const defs = (axis: "columns" | "rows") =>
        Array.from(
          { length: p[axis] },
          (_, i) =>
            g[axis]?.[i] ??
            (axis === "columns" ? g.autoColumns : g.autoRows) ??
            "auto",
        );
      for (const [axis, size, start, span] of [
        ["columns", "width", "column", "columnSpan"],
        ["rows", "height", "row", "rowSpan"],
      ] as const) {
        const tracks = defs(axis);
        css.push(
          `${axis === "columns" ? "justify" : "align"}-content:${tracks.some((t) => typeof t === "object") ? "start" : "normal"}`,
        );
        for (const cell of p.cells) {
          const covered = tracks.slice(cell[start], cell[start] + cell[span]);
          if (
            covered.includes("auto") &&
            (doc.nodes[cell.id].layout[size] === "fill" || cell[span] > 1)
          )
            reason = "auto track의 fill 또는 spanning intrinsic 기여";
        }
        css.push(
          `grid-template-${axis}:${tracks.map(track).join(" ") || "none"}`,
        );
      }
      css.push("justify-items:start", `align-items:${alignment(l.align)}`);
      if (!reason)
        for (const cell of p.cells)
          placements.set(cell.id, [
            `grid-column:${cell.column + 1} / span ${cell.columnSpan}`,
            `grid-row:${cell.row + 1} / span ${cell.rowSpan}`,
          ]);
    }
    if (reason)
      warnings.add(
        `${node.name}: ${reason}은 CSS 대응 불가 — 내부 배치를 고정 좌표로 보존합니다.`,
      );
    else containers.set(node.id, css);
  }
  return {
    supported: (id: string) => containers.has(id),
    styles(node: SceneNode, root: boolean): string[] {
      const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
      const flow =
        !root &&
        parent &&
        containers.has(parent.id) &&
        node.layout.position !== "absolute";
      const css: string[] = [];
      if (containers.has(node.id)) css.push(...containers.get(node.id)!);
      if (root && containers.has(node.id)) css.push("width:100%");
      if (flow) {
        css.push(
          "position:relative",
          `transform:matrix(${[...node.transform.slice(0, 4), 0, 0].join(",")})`,
        );
        css.push(...(placements.get(node.id) ?? []));
        if (parent.layout.mode === "flex") {
          const main =
            parent.layout.direction === "column" ? "height" : "width";
          const cross = main === "width" ? "height" : "width";
          if (node.layout[main] === "fill")
            css.push(`${main}:0px`, "flex:1 0 0px");
          else css.push("flex:0 0 auto");
          if (node.layout[cross] === "fill") css.push(`${cross}:100%`);
        } else {
          if (node.layout.width === "fill") css.push("width:100%");
          if (node.layout.height === "fill") css.push("height:100%");
        }
      }
      for (const axis of ["width", "height"] as const) {
        const min =
          axis === "width" ? node.layout.minWidth : node.layout.minHeight;
        const max =
          axis === "width" ? node.layout.maxWidth : node.layout.maxHeight;
        const p =
          node.layout.mode === "absolute"
            ? [0, 0, 0, 0]
            : (node.layout.padding ?? [0, 0, 0, 0]);
        css.push(
          `min-${axis}:${px(Math.max(min ?? 0, axis === "width" ? p[1] + p[3] : p[0] + p[2]))}`,
        );
        if (max !== undefined) css.push(`max-${axis}:${px(max)}`);
      }
      return css;
    },
  };
}
