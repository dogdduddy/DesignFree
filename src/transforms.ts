import {
  getWorldTransform,
  invertMatrix,
  multiplyMatrices as mul,
  transformPoint,
  updateNodes,
  type Matrix,
  type Point,
  type SceneDocument,
  type SceneNode,
} from "./core";
import { arrangeableRoots } from "./arrangement";
export const handles = [
  { key: "nw", x: 0, y: 0, label: "왼쪽 위", cursor: "nwse-resize" },
  { key: "n", x: 0.5, y: 0, label: "위", cursor: "ns-resize" },
  { key: "ne", x: 1, y: 0, label: "오른쪽 위", cursor: "nesw-resize" },
  { key: "e", x: 1, y: 0.5, label: "오른쪽", cursor: "ew-resize" },
  { key: "se", x: 1, y: 1, label: "오른쪽 아래", cursor: "nwse-resize" },
  { key: "s", x: 0.5, y: 1, label: "아래", cursor: "ns-resize" },
  { key: "sw", x: 0, y: 1, label: "왼쪽 아래", cursor: "nesw-resize" },
  { key: "w", x: 0, y: 0.5, label: "왼쪽", cursor: "ew-resize" },
] as const;
export type Handle = (typeof handles)[number];
export interface TransformFrame {
  ids: string[];
  basis: Matrix;
  width: number;
  height: number;
}
const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export function transformFrame(
  doc: SceneDocument,
  selection: string[],
): TransformFrame | null {
  const ids = arrangeableRoots(doc, selection);
  if (!ids.length) return null;
  if (ids.length === 1) {
    const n = doc.nodes[ids[0]],
      basis = getWorldTransform(doc, n.id);
    if (Math.abs(basis[0] * basis[3] - basis[1] * basis[2]) < 1e-10)
      return null;
    return { ids, basis, width: n.width, height: n.height };
  }
  const ps = ids.flatMap((id) => {
    const n = doc.nodes[id],
      m = getWorldTransform(doc, id);
    return [
      [0, 0],
      [n.width, 0],
      [0, n.height],
      [n.width, n.height],
    ].map(([x, y]) => transformPoint(m, { x, y }));
  });
  const x = Math.min(...ps.map((p) => p.x)),
    y = Math.min(...ps.map((p) => p.y));
  return {
    ids,
    basis: translation(x, y),
    width: Math.max(...ps.map((p) => p.x)) - x,
    height: Math.max(...ps.map((p) => p.y)) - y,
  };
}
export function resizeBox(
  frame: TransformFrame,
  handle: Handle,
  q: Point,
  shift = false,
  alt = false,
) {
  const { width: w, height: h } = frame;
  const ax = alt ? w / 2 : (1 - handle.x) * w,
    ay = alt ? h / 2 : (1 - handle.y) * h;
  let sx = handle.x === 0.5 ? 1 : (q.x - ax) / (handle.x * w - ax);
  let sy = handle.y === 0.5 ? 1 : (q.y - ay) / (handle.y * h - ay);
  if (shift) {
    const s =
      handle.x === 0.5
        ? sy
        : handle.y === 0.5
          ? sx
          : Math.abs(sx - 1) >= Math.abs(sy - 1)
            ? sx
            : sy;
    sx = sy = Math.max(s, 8 / w, 8 / h);
  } else {
    sx = handle.x === 0.5 ? 1 : Math.max(8 / w, sx);
    sy = handle.y === 0.5 ? 1 : Math.max(8 / h, sy);
  }
  // Shift side handles expand the perpendicular axis symmetrically.
  const anchorX = handle.x === 0.5 ? w / 2 : ax,
    anchorY = handle.y === 0.5 ? h / 2 : ay;
  return {
    x: anchorX * (1 - sx),
    y: anchorY * (1 - sy),
    width: w * sx,
    height: h * sy,
  };
}
export function resizeSelection(
  doc: SceneDocument,
  frame: TransformFrame,
  box: { x: number; y: number; width: number; height: number },
): SceneDocument {
  if (
    ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
    box.width <= 0 ||
    box.height <= 0
  )
    return doc;
  const sx = box.width / frame.width,
    sy = box.height / frame.height;
  if (
    Math.abs(sx - 1) + Math.abs(sy - 1) + Math.abs(box.x) + Math.abs(box.y) <
    1e-10
  )
    return doc;
  const changes: Record<string, Partial<SceneNode>> = {};
  if (frame.ids.length === 1 && doc.nodes[frame.ids[0]].type !== "group") {
    const n = doc.nodes[frame.ids[0]];
    changes[n.id] = {
      width: box.width,
      height: box.height,
      ...(n.text?.sizing && n.text.sizing !== "fixed"
        ? { text: { ...n.text, sizing: "fixed" as const } }
        : {}),
      transform: mul(n.transform, translation(box.x, box.y)),
    };
  } else if (frame.ids.length === 1) {
    const n = doc.nodes[frame.ids[0]];
    changes[n.id] = { transform: mul(n.transform, translation(box.x, box.y)) };
    for (const child of n.children)
      changes[child] = {
        transform: mul([sx, 0, 0, sy, 0, 0], doc.nodes[child].transform),
      };
  } else {
    const operation = mul(
      mul(frame.basis, [sx, 0, 0, sy, box.x, box.y]),
      invertMatrix(frame.basis),
    );
    for (const id of frame.ids) {
      const n = doc.nodes[id];
      const parent = n.parentId
        ? getWorldTransform(doc, n.parentId)
        : translation(0, 0);
      changes[id] = {
        transform: mul(
          mul(invertMatrix(parent), operation),
          getWorldTransform(doc, id),
        ),
      };
    }
  }
  return updateNodes(doc, changes);
}
/** World rotation around the selection center; preserve the entire affine linear part. */
export function rotateSelection(
  doc: SceneDocument,
  frame: TransformFrame,
  degrees: number,
): SceneDocument {
  if (!Number.isFinite(degrees) || Math.abs(degrees) < 1e-10) return doc;
  const center = transformPoint(frame.basis, {
      x: frame.width / 2,
      y: frame.height / 2,
    }),
    a = (degrees * Math.PI) / 180;
  const operation = mul(
    mul(translation(center.x, center.y), [
      Math.cos(a),
      Math.sin(a),
      -Math.sin(a),
      Math.cos(a),
      0,
      0,
    ]),
    translation(-center.x, -center.y),
  );
  const changes: Record<string, Partial<SceneNode>> = {};
  for (const id of frame.ids) {
    const n = doc.nodes[id],
      parent = n.parentId
        ? getWorldTransform(doc, n.parentId)
        : translation(0, 0);
    changes[id] = {
      transform: mul(
        mul(invertMatrix(parent), operation),
        getWorldTransform(doc, id),
      ),
    };
  }
  return updateNodes(doc, changes);
}
export const frameRotation = (f: TransformFrame) =>
  (Math.atan2(f.basis[1], f.basis[0]) * 180) / Math.PI;
export function rotationDelta(
  frame: TransformFrame,
  start: Point,
  end: Point,
  shift: boolean,
) {
  const c = transformPoint(frame.basis, {
    x: frame.width / 2,
    y: frame.height / 2,
  });
  let d =
    ((Math.atan2(end.y - c.y, end.x - c.x) -
      Math.atan2(start.y - c.y, start.x - c.x)) *
      180) /
    Math.PI;
  d = ((d + 540) % 360) - 180;
  return shift
    ? Math.round((frameRotation(frame) + d) / 15) * 15 - frameRotation(frame)
    : d;
}
