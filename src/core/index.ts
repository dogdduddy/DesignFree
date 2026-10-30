import {
  validateSharedStyleLibraries,
  type SharedStyleLibrary,
} from "../shared-style-library";
import {
  validateDocumentStyles,
  type StyleLibrary,
  type StyleRefs,
  type Shadow,
} from "../style-library";
import {
  reconcileComponents,
  validComponent,
  validateVariantSets,
  remapComponents,
  type Component,
} from "../components";
import { validGrid } from "../grid-layout";
import { normalizeTextBounds, type MeasureText } from "../text-layout";
import { ownedJSON } from "../owned-json";
import { validVectorPath, type VectorPath } from "../vector-path";
import {
  pruneInteractions,
  validInteractions,
  type Interaction,
} from "../prototype";
import type { Layout } from "../flex-layout";
export type { Layout } from "../flex-layout";
/** Serializable authoring model. Layout meaning stays separate from render geometry. */
export type Matrix = [number, number, number, number, number, number];
export type Point = { x: number; y: number };
export type Viewport = { x: number; y: number; zoom: number };
/** Linear gradient endpoints are normalized to node width/height (object bounding box). */
export type Paint = (
  | { type: "solid"; color: string }
  | {
      type: "linear" | "radial";
      from: [number, number];
      to: [number, number];
      stops: { offset: number; color: string; opacity?: number }[];
    }
  | { type: "none" }
) & { opacity?: number };
export type NodeType =
  | "page"
  | "frame"
  | "group"
  | "rectangle"
  | "ellipse"
  | "path"
  | "text"
  | "image";
export type SceneNode = {
  id: string;
  component?: Component;
  styleRefs?: StyleRefs;
  effects?: Shadow[];
  type: NodeType;
  name: string;
  parentId: string | null;
  children: string[];
  transform: Matrix;
  width: number;
  height: number;
  fill: Paint;
  /** Bottom-to-top paints; absent means legacy single fill. */
  fills?: Paint[];
  stroke?: {
    color: string;
    width: number;
    position?: "center" | "inside" | "outside";
    dash?: number[];
    opacity?: number;
  };
  opacity: number;
  radius: number;
  clipContent: boolean;
  visible: boolean;
  locked: boolean;
  text?: {
    content: string;
    fontFamily: string;
    fontSize: number;
    fontWeight: number;
    lineHeight: number;
    letterSpacing?: number;
    align?: "left" | "center" | "right";
    sizing?: "fixed" | "auto-width" | "auto-height";
  };
  assetId?: string;
  /** Vector outline of a path node, scaled from its authored box to width/height. */
  path?: VectorPath;
  /** Prototype click links to other screens (top-level frames) of the page. */
  interactions?: Interaction[];
  /** Pages only: the screen a prototype preview starts from. */
  prototypeStartId?: string;
  layout: Layout;
};
export type ImageAsset = {
  id: string;
  mimeType: "image/png";
  /** Original server digest when bytes are missing; never replaced by placeholder bytes. */
  missing?: string;
  dataUrl: string;
  width: number;
  height: number;
};
export type SceneDocument = {
  schemaVersion: 1 | 2;
  styleLibrary?: StyleLibrary;
  sharedStyleLibraries?: SharedStyleLibrary[];
  /** v2: ordered page roots; rootId is the active page. */
  pageIds?: string[];
  id: string;
  name: string;
  rootId: string;
  nodes: Record<string, SceneNode>;
  assets: Record<string, ImageAsset>;
};
const clone = <T>(v: T): T => structuredClone(v);
export function multiplyMatrices(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function invertMatrix(m: Matrix): Matrix {
  const d = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12)
    throw new Error("Singular transform");
  return [
    m[3] / d,
    -m[1] / d,
    -m[2] / d,
    m[0] / d,
    (m[2] * m[5] - m[3] * m[4]) / d,
    (m[1] * m[4] - m[0] * m[5]) / d,
  ];
}
export function transformPoint(m: Matrix, p: Point): Point {
  return {
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  };
}
export function getWorldTransform(doc: SceneDocument, id: string): Matrix {
  const n = doc.nodes[id];
  if (!Object.hasOwn(doc.nodes, id)) throw new Error("Unknown node");
  return n.parentId
    ? multiplyMatrices(getWorldTransform(doc, n.parentId), n.transform)
    : [...n.transform];
}
export function worldToScreen(p: Point, v: Viewport): Point {
  return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
}
export function screenToWorld(p: Point, v: Viewport): Point {
  if (!Number.isFinite(v.zoom) || v.zoom <= 0) throw new Error("Invalid zoom");
  return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
}
export function getWorldBounds(doc: SceneDocument, id: string) {
  const n = doc.nodes[id],
    m = getWorldTransform(doc, id);
  const ps = [
    { x: 0, y: 0 },
    { x: n.width, y: 0 },
    { x: 0, y: n.height },
    { x: n.width, y: n.height },
  ].map((p) => transformPoint(m, p));
  const x = Math.min(...ps.map((p) => p.x)),
    y = Math.min(...ps.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(...ps.map((p) => p.x)) - x,
    height: Math.max(...ps.map((p) => p.y)) - y,
  };
}
function contains(n: SceneNode, p: Point): boolean {
  if (n.type === "ellipse")
    return (
      n.width > 0 &&
      n.height > 0 &&
      ((p.x - n.width / 2) / (n.width / 2)) ** 2 +
        ((p.y - n.height / 2) / (n.height / 2)) ** 2 <=
        1
    );
  if (p.x < 0 || p.y < 0 || p.x > n.width || p.y > n.height) return false;
  const r = Math.min(n.radius, n.width / 2, n.height / 2);
  if (r <= 0) return true;
  const dx = Math.max(r - p.x, 0, p.x - (n.width - r)),
    dy = Math.max(r - p.y, 0, p.y - (n.height - r));
  return dx * dx + dy * dy <= r * r;
}
export function hitTest(
  doc: SceneDocument,
  worldPoint: Point,
  ignored: ReadonlySet<string> = new Set(),
): string | null {
  function visit(id: string): string | null {
    const n = doc.nodes[id];
    if (!n.visible || n.locked || ignored.has(id)) return null;
    let p: Point;
    try {
      p = transformPoint(invertMatrix(getWorldTransform(doc, id)), worldPoint);
    } catch {
      return null;
    }
    const inside = contains(n, p);
    if (n.clipContent && !inside) return null;
    for (let i = n.children.length - 1; i >= 0; i--) {
      const hit = visit(n.children[i]);
      if (hit) return hit;
    }
    return inside && n.type !== "page" ? id : null;
  }
  return visit(doc.rootId);
}
/** Changed nodes are fresh copies; unchanged nodes and document metadata are
 * shared with the input. Treat both documents as read-only afterwards. */
export function updateNodes(
  doc: SceneDocument,
  changes: Record<string, Partial<SceneNode>>,
): SceneDocument {
  const next: SceneDocument = { ...doc, nodes: { ...doc.nodes } };
  for (const [id, change] of Object.entries(changes)) {
    if (!Object.hasOwn(next.nodes, id)) throw new Error("Unknown node");
    next.nodes[id] = { ...clone(doc.nodes[id]), ...clone(change) };
  }
  const normalized = normalizeGroupBounds(next);
  // normalizeGroupBounds validated its input; only a changed result needs a check.
  if (normalized !== next) validateDocument(normalized);
  return normalized;
}
export function reparentNode(
  doc: SceneDocument,
  id: string,
  newParentId: string,
  index?: number,
): SceneDocument {
  if (id === doc.rootId) throw new Error("Cannot reparent root");
  const n = doc.nodes[id],
    parent = doc.nodes[newParentId];
  if (
    !Object.hasOwn(doc.nodes, id) ||
    !Object.hasOwn(doc.nodes, newParentId) ||
    !["frame", "page", "group"].includes(parent.type)
  )
    throw new Error("Invalid parent");
  for (
    let p: SceneNode | undefined = parent;
    p;
    p = p.parentId ? doc.nodes[p.parentId] : undefined
  )
    if (p.id === id) throw new Error("Reparent cycle");
  const local = multiplyMatrices(
    invertMatrix(getWorldTransform(doc, newParentId)),
    getWorldTransform(doc, id),
  );
  const next = clone(doc);
  const old = next.nodes[n.parentId!];
  old.children = old.children.filter((x) => x !== id);
  const children = next.nodes[newParentId].children;
  children.splice(
    index === undefined
      ? children.length
      : Math.max(0, Math.min(index, children.length)),
    0,
    id,
  );
  next.nodes[id].parentId = newParentId;
  next.nodes[id].transform = local;
  const normalized = normalizeGroupBounds(next);
  validateDocument(normalized);
  return normalized;
}
function fail(): never {
  throw new Error("Invalid scene document");
}
function record(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function str(v: unknown): v is string {
  return typeof v === "string";
}
// Hex-only paints prevent SVG url(...) network paint references in imported documents.
function color(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)
  );
}
function paint(v: unknown): boolean {
  if (
    !record(v) ||
    (v.opacity !== undefined &&
      (!finite(v.opacity) || v.opacity < 0 || v.opacity > 1))
  )
    return false;
  if (v.type === "none") return true;
  if (v.type === "solid") return color(v.color);
  return (
    ["linear", "radial"].includes(v.type) &&
    [v.from, v.to].every(
      (a) => Array.isArray(a) && a.length === 2 && a.every(finite),
    ) &&
    Array.isArray(v.stops) &&
    v.stops.length >= 2 &&
    v.stops.length <= 64 &&
    v.stops.every(
      (s: any) =>
        record(s) &&
        finite(s.offset) &&
        s.offset >= 0 &&
        s.offset <= 1 &&
        color(s.color) &&
        (s.opacity === undefined ||
          (finite(s.opacity) && s.opacity >= 0 && s.opacity <= 1)),
    )
  );
}
/** Persist only authoring rules; computed positions never enter history/storage. */
function validLayout(v: unknown, type: string): boolean {
  if (!record(v) || !["absolute", "flex", "grid"].includes(v.mode))
    return false;
  if (["flex", "grid"].includes(v.mode) && type !== "frame") return false;
  if (!validGrid(v.grid)) return false;
  const enums: Record<string, string[]> = {
    direction: ["row", "column"],
    align: ["start", "center", "end", "stretch"],
    justify: [
      "start",
      "center",
      "end",
      "space-between",
      "space-around",
      "space-evenly",
    ],
    width: ["fixed", "hug", "fill"],
    height: ["fixed", "hug", "fill"],
    position: ["flow", "absolute"],
  };
  for (const [key, values] of Object.entries(enums))
    if (v[key] !== undefined && !values.includes(v[key])) return false;
  if (
    ["page", "group"].includes(type) &&
    [v.width, v.height].some((x) => x !== undefined && x !== "fixed")
  )
    return false;
  for (const key of ["gap", "minWidth", "maxWidth", "minHeight", "maxHeight"])
    if (v[key] !== undefined && (!finite(v[key]) || v[key] < 0 || v[key] > 1e7))
      return false;
  if (v.wrap !== undefined && typeof v.wrap !== "boolean") return false;
  if (
    v.padding !== undefined &&
    (!Array.isArray(v.padding) ||
      v.padding.length !== 4 ||
      !v.padding.every((x: unknown) => finite(x) && x >= 0 && x <= 1e7))
  )
    return false;
  // Contradictory constraints are rejected instead of silently changing source intent.
  for (const axis of ["Width", "Height"])
    if (
      v["min" + axis] !== undefined &&
      v["max" + axis] !== undefined &&
      v["min" + axis] > v["max" + axis]
    )
      return false;
  return true;
}
export function validateDocument(
  value: unknown,
): asserts value is SceneDocument {
  const d = value;
  if (
    !record(d) ||
    ![1, 2].includes(d.schemaVersion) ||
    !str(d.id) ||
    !str(d.name) ||
    !str(d.rootId) ||
    !record(d.nodes) ||
    !record(d.assets)
  )
    fail();
  if (d.schemaVersion === 2) {
    if (
      !Array.isArray(d.pageIds) ||
      !d.pageIds.length ||
      !d.pageIds.every(str) ||
      new Set(d.pageIds).size !== d.pageIds.length ||
      !d.pageIds.includes(d.rootId)
    )
      fail();
  } else if (d.pageIds !== undefined) fail();
  const ids = Object.keys(d.nodes);
  if (
    ids.length === 0 ||
    ids.length > 100000 ||
    !Object.hasOwn(d.nodes, d.rootId)
  )
    fail();
  for (const [id, n] of Object.entries(d.nodes)) {
    if (
      !record(n) ||
      n.id !== id ||
      !str(n.name) ||
      ![
        "page",
        "frame",
        "group",
        "rectangle",
        "ellipse",
        "path",
        "text",
        "image",
      ].includes(n.type) ||
      !(n.parentId === null || str(n.parentId)) ||
      !Array.isArray(n.children) ||
      !n.children.every(str) ||
      new Set(n.children).size !== n.children.length ||
      !Array.isArray(n.transform) ||
      n.transform.length !== 6 ||
      !n.transform.every(finite) ||
      !["width", "height", "opacity", "radius"].every((k) => finite(n[k])) ||
      n.width < 0 ||
      n.height < 0 ||
      n.opacity < 0 ||
      n.opacity > 1 ||
      n.radius < 0 ||
      !paint(n.fill) ||
      (n.fills !== undefined &&
        (!Array.isArray(n.fills) ||
          n.fills.length > 32 ||
          !n.fills.every(paint))) ||
      !["clipContent", "visible", "locked"].every(
        (k) => typeof n[k] === "boolean",
      ) ||
      !validLayout(n.layout, n.type) ||
      !validComponent(n.component, n as SceneNode)
    )
      fail();
    if (n.children.length && !["page", "frame", "group"].includes(n.type))
      fail();
    const strokes = [
      n.stroke,
      ...(n.component?.kind === "instance"
        ? Object.values(
            (n.component as Extract<Component, { kind: "instance" }>)
              .variantOverrides ?? {},
          ).map((entry) => entry.stroke)
        : []),
    ];
    for (const stroke of strokes) {
      if (
        stroke &&
        (!record(stroke) ||
          !color(stroke.color) ||
          !finite(stroke.width) ||
          stroke.width < 0 ||
          (stroke.position !== undefined &&
            !["center", "inside", "outside"].includes(stroke.position)) ||
          (stroke.opacity !== undefined &&
            (!finite(stroke.opacity) ||
              stroke.opacity < 0 ||
              stroke.opacity > 1)) ||
          (stroke.dash !== undefined &&
            (!Array.isArray(stroke.dash) ||
              stroke.dash.length > 16 ||
              !stroke.dash.every((x: unknown) => finite(x) && x > 0))))
      )
        fail();
    }
    if (
      n.text &&
      (!record(n.text) ||
        !str(n.text.content) ||
        !str(n.text.fontFamily) ||
        !["fontSize", "fontWeight", "lineHeight"].every(
          (k) => finite(n.text[k]) && n.text[k] > 0,
        ) ||
        (n.text.letterSpacing !== undefined && !finite(n.text.letterSpacing)) ||
        (n.text.align !== undefined &&
          !["left", "center", "right"].includes(n.text.align)) ||
        (n.text.sizing !== undefined &&
          !["fixed", "auto-width", "auto-height"].includes(n.text.sizing)))
    )
      fail();
    if (n.type === "text" && !n.text) fail();
    if (
      n.interactions !== undefined &&
      (n.type === "page" || !validInteractions(n.interactions))
    )
      fail();
    if (
      n.prototypeStartId !== undefined &&
      (n.type !== "page" || !str(n.prototypeStartId))
    )
      fail();
    if (
      (n.path !== undefined || n.type === "path") &&
      (n.type !== "path" || !validVectorPath(n.path))
    )
      fail();
    if (
      n.assetId !== undefined &&
      (!str(n.assetId) || !Object.hasOwn(d.assets, n.assetId))
    )
      fail();
    if (n.type === "image" && !n.assetId) fail();
  }
  for (const [id, a] of Object.entries(d.assets)) {
    if (
      !record(a) ||
      a.id !== id ||
      a.mimeType !== "image/png" ||
      !str(a.dataUrl) ||
      !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]*$/.test(a.dataUrl) ||
      (a.missing !== undefined &&
        (typeof a.missing !== "string" || !/^[a-f0-9]{64}$/.test(a.missing))) ||
      !finite(a.width) ||
      !finite(a.height) ||
      a.width <= 0 ||
      a.height <= 0
    )
      fail();
  }
  const nodes = d.nodes;
  const rootId = d.rootId;
  const seen = new Set<string>();
  function walk(id: string, parent: string | null, depth: number) {
    if (depth > 128 || seen.has(id) || !Object.hasOwn(nodes, id)) fail();
    const n = nodes[id];
    if (n.parentId !== parent) fail();
    seen.add(id);
    for (const c of n.children) walk(c, id, depth + 1);
  }
  for (const page of d.pageIds ?? [rootId]) {
    walk(page, null, 0);
    if (nodes[page].type !== "page") fail();
  }
  if (seen.size !== ids.length) fail();
  validateVariantSets(value as SceneDocument);
  validateSharedStyleLibraries((value as SceneDocument).sharedStyleLibraries);
  validateDocumentStyles(value as SceneDocument);
}
export function serializeDocument(doc: SceneDocument): string {
  validateDocument(doc);
  return JSON.stringify(doc);
}
const MAX_DOCUMENT_JSON = 50_000_000;
/** Detached copy of a valid document. A JSON round trip of a validated document
 * stays valid, so the copy is not validated a second time. */
export function snapshotDocument(doc: SceneDocument): SceneDocument {
  const json = serializeDocument(doc);
  if (json.length > MAX_DOCUMENT_JSON) throw new Error("Document too large");
  return JSON.parse(json);
}
export function parseDocument(json: string): SceneDocument {
  if (json.length > MAX_DOCUMENT_JSON) throw new Error("Document too large");
  const doc: unknown = JSON.parse(json);
  validateDocument(doc);
  // JSON.parse already owns a new object graph; validation does not mutate it.
  return doc;
}
/** Node/asset reversible patches. Documents returned at the boundary stay detached. */
type HistoryPatch = {
  before: Omit<SceneDocument, "nodes" | "assets">;
  after: Omit<SceneDocument, "nodes" | "assets">;
  nodes: Record<string, [SceneNode | null, SceneNode | null]>;
  assets: Record<string, [ImageAsset | null, ImageAsset | null]>;
  bytes: number;
};
export class DocumentHistory {
  private current: SceneDocument;
  private past: HistoryPatch[] = [];
  private future: HistoryPatch[] = [];
  private start: SceneDocument | null = null;
  private revision = 0;
  /** Serialized UTF-8 patch budget, not an estimate of browser heap bytes. */
  constructor(
    doc: SceneDocument,
    private readonly byteLimit = 32 * 1024 * 1024,
  ) {
    if (!Number.isFinite(byteLimit) || byteLimit < 0)
      throw new Error("Invalid history budget");
    validateDocument(doc);
    this.current = clone(normalizeGroupBounds(reconcileComponents(doc)));
    validateDocument(this.current);
  }
  get document() {
    return clone(this.current);
  }
  /** Recovery snapshots exclude tentative gesture previews. */
  get committedDocument() {
    return clone(this.start ?? this.current);
  }
  /** Changes whenever the committed document may have changed; previews do not. */
  get committedRevision() {
    return this.revision;
  }
  get transactionActive() {
    return this.start !== null;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  get statistics() {
    return {
      undoEntries: this.past.length,
      redoEntries: this.future.length,
      retainedPatchBytes: [...this.past, ...this.future].reduce(
        (s, p) => s + p.bytes,
        0,
      ),
      byteLimit: this.byteLimit,
      entryLimit: 100,
      scope:
        "Serialized UTF-8 patch payloads only; excludes byte counters, current/transaction documents and JS object overhead",
    };
  }
  beginTransaction() {
    if (this.start) throw new Error("Transaction already active");
    this.start = this.current;
  }
  preview(next: SceneDocument, fromCurrent = false) {
    if (!this.start) throw new Error("No active transaction");
    validateDocument(next);
    this.current = this.own(
      next,
      reconcileComponents(next, fromCurrent ? this.current : this.start),
    );
  }
  /** Normalize and keep a copy the caller cannot reach. A reconciled document is
   * already a fresh deep copy, so it is not copied a second time. */
  private own(input: SceneDocument, reconciled: SceneDocument) {
    // The input was validated by the caller; a reconciled copy is checked here.
    const unchanged = reconciled === input;
    const next = unchanged
      ? normalizeValidated(reconciled)
      : normalizeGroupBounds(reconciled);
    if (next !== reconciled) validateDocument(next);
    return unchanged ? clone(next) : next;
  }
  private push(previous: SceneDocument) {
    const { nodes: oldNodes, assets: oldAssets, ...before } = previous;
    const { nodes: newNodes, assets: newAssets, ...after } = this.current;
    function diff<T extends object>(a: Record<string, T>, b: Record<string, T>) {
      const result: Record<string, [T | null, T | null]> = Object.create(null);
      for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
        // Both sides are history-owned, so each commit serializes only new nodes.
        if (a[id] !== b[id] && ownedJSON(a[id]) !== ownedJSON(b[id]))
          result[id] = clone([a[id] ?? null, b[id] ?? null]);
      }
      return result;
    }
    const nodes = diff(oldNodes, newNodes),
      assets = diff(oldAssets, newAssets);
    if (
      !Object.keys(nodes).length &&
      !Object.keys(assets).length &&
      JSON.stringify(before) === JSON.stringify(after)
    )
      return;
    this.revision++;
    const patch = { before, after, nodes, assets, bytes: 0 };
    patch.bytes = new TextEncoder().encode(
      JSON.stringify({ before, after, nodes, assets }),
    ).byteLength;
    this.past.push(patch);
    this.future = [];
    let bytes = this.statistics.retainedPatchBytes;
    while (this.past.length > 100 || bytes > this.byteLimit) {
      bytes -= this.past.shift()!.bytes;
    }
  }
  private apply(patch: HistoryPatch, direction: 0 | 1) {
    const nodes = { ...this.current.nodes },
      assets = { ...this.current.assets };
    for (const [id, pair] of Object.entries(patch.nodes)) {
      if (pair[direction] === null) delete nodes[id];
      else nodes[id] = clone(pair[direction]!);
    }
    for (const [id, pair] of Object.entries(patch.assets)) {
      if (pair[direction] === null) delete assets[id];
      else assets[id] = clone(pair[direction]!);
    }
    this.current = {
      ...(direction === 0 ? patch.before : patch.after),
      nodes,
      assets,
    };
    this.revision++;
  }
  commitTransaction() {
    if (!this.start) throw new Error("No active transaction");
    const previous = this.start;
    this.start = null;
    this.push(previous);
  }
  cancelTransaction() {
    if (!this.start) return;
    this.current = this.start;
    this.start = null;
  }
  execute(next: SceneDocument) {
    if (this.start) throw new Error("Transaction active");
    validateDocument(next);
    const old = this.current;
    this.current = this.own(next, reconcileComponents(next, old));
    this.push(old);
  }
  undo() {
    if (this.start) this.cancelTransaction();
    const patch = this.past.pop();
    if (patch) {
      this.apply(patch, 0);
      this.future.push(patch);
    }
  }
  redo() {
    if (this.start) this.cancelTransaction();
    const patch = this.future.pop();
    if (patch) {
      this.apply(patch, 1);
      this.past.push(patch);
    }
  }
}
export function createNode(
  type: NodeType,
  parentId: string | null,
  properties: Partial<SceneNode> = {},
): SceneNode {
  return {
    id: crypto.randomUUID(),
    type,
    name: type,
    parentId,
    children: [],
    transform: [1, 0, 0, 1, 0, 0],
    width: 100,
    height: 100,
    fill:
      type === "group" ? { type: "none" } : { type: "solid", color: "#CFD6EE" },
    opacity: 1,
    radius: 0,
    clipContent: false,
    visible: true,
    locked: false,
    layout: { mode: "absolute" },
    ...(type === "text"
      ? {
          text: {
            content: "Text",
            fontFamily: "Noto Sans KR",
            fontSize: 16,
            fontWeight: 400,
            lineHeight: 24,
          },
        }
      : {}),
    ...properties,
  };
}
export { createDemoDocument, createBenchmarkDocument } from "./fixtures";

/** Selection roots prevent descendants moving or duplicating twice with their parent. */
export function selectionRoots(doc: SceneDocument, ids: string[]): string[] {
  const selected = new Set(ids);
  return [...selected].filter((id) => {
    if (!doc.nodes[id] || id === doc.rootId) return false;
    let parent = doc.nodes[id].parentId;
    while (parent) {
      if (selected.has(parent)) return false;
      parent = doc.nodes[parent]?.parentId;
    }
    return true;
  });
}
export function isNodeLocked(doc: SceneDocument, id: string): boolean {
  let node: SceneNode | undefined = doc.nodes[id];
  while (node) {
    if (node.locked) return true;
    node = node.parentId ? doc.nodes[node.parentId] : undefined;
  }
  return false;
}
/** Deep-copy selected subtrees, sharing owned assets and preserving local geometry.
 * Offset applies only to roots, in parent coordinates (Cmd+D's existing behavior).
 */
export function duplicateNodes(
  doc: SceneDocument,
  ids: string[],
  offset: Point = { x: 0, y: 0 },
): { document: SceneDocument; ids: string[] } {
  const next = clone(doc);
  const created: string[] = [];
  const identityMap: Record<string, string> = Object.create(null);
  const copy = (id: string, parentId: string): string => {
    const source = doc.nodes[id];
    const newId = crypto.randomUUID();
    identityMap[id] = newId;
    next.nodes[newId] = { ...clone(source), id: newId, parentId, children: [] };
    next.nodes[newId].children = source.children.map((child) =>
      copy(child, newId),
    );
    return newId;
  };
  for (const id of selectionRoots(doc, ids)) {
    if (isNodeLocked(doc, id)) continue;
    const source = doc.nodes[id];
    const newId = copy(id, source.parentId!);
    const node = next.nodes[newId];
    node.name += " copy";
    node.transform[4] += offset.x;
    node.transform[5] += offset.y;
    next.nodes[source.parentId!].children.push(newId);
    created.push(newId);
  }
  remapComponents(next, identityMap);
  // Links between copied screens follow the copies, as in Figma.
  for (const id of Object.values(identityMap)) {
    const n = next.nodes[id];
    if (n.interactions)
      n.interactions = n.interactions.map((i) =>
        identityMap[i.action.destinationId]
          ? { ...i, action: { ...i.action, destinationId: identityMap[i.action.destinationId] } }
          : i,
      );
  }
  validateDocument(next);
  return { document: next, ids: created };
}

/** Tight authored child boxes in group axes, including hidden children. Never scales content.
 * Only groups and children whose boxes change are copied; everything else is
 * shared with the input, which stays unmodified. */
export function normalizeGroupBounds(
  doc: SceneDocument,
  measure?: MeasureText,
): SceneDocument {
  validateDocument(doc);
  return normalizeValidated(doc, measure);
}
function normalizeValidated(
  doc: SceneDocument,
  measure?: MeasureText,
): SceneDocument {
  // Links to deleted or moved screens are dropped in the same commit.
  doc = pruneInteractions(doc);
  doc = normalizeTextBounds(doc, measure);
  if (!Object.values(doc.nodes).some((n) => n.type === "group")) return doc;
  let next = doc;
  const copied = new Set<string>();
  const writable = (id: string) => {
    if (next === doc) next = { ...doc, nodes: { ...doc.nodes } };
    if (!copied.has(id)) {
      copied.add(id);
      const n = next.nodes[id];
      next.nodes[id] = { ...n, transform: [...n.transform] as Matrix };
    }
    return next.nodes[id];
  };
  function visit(id: string) {
    const n = next.nodes[id];
    n.children.forEach(visit);
    if (n.type !== "group") return;
    const points = n.children.flatMap((id) => {
      const c = next.nodes[id];
      return [
        { x: 0, y: 0 },
        { x: c.width, y: 0 },
        { x: 0, y: c.height },
        { x: c.width, y: c.height },
      ].map((p) => transformPoint(c.transform, p));
    });
    const box = points.reduce<{
      x: number;
      y: number;
      right: number;
      bottom: number;
    }>(
      (b, p) => ({
        x: Math.min(b.x, p.x),
        y: Math.min(b.y, p.y),
        right: Math.max(b.right, p.x),
        bottom: Math.max(b.bottom, p.y),
      }),
      { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity },
    );
    const x = points.length ? box.x : 0,
      y = points.length ? box.y : 0;
    const width = points.length ? box.right - x : 0,
      height = points.length ? box.bottom - y : 0;
    const moved = Math.abs(x) >= 1e-10 || Math.abs(y) >= 1e-10;
    if (!moved && width === n.width && height === n.height) return;
    const group = writable(id);
    group.width = width;
    group.height = height;
    if (!moved) return;
    group.transform = multiplyMatrices(group.transform, [1, 0, 0, 1, x, y]);
    for (const child of n.children) {
      const c = writable(child);
      c.transform[4] -= x;
      c.transform[5] -= y;
    }
  }
  (next.pageIds ?? [next.rootId]).forEach(visit);
  return next;
}

/** Same-parent roots retain their sibling order; group occupies the topmost selected slot. */
export function groupNodes(doc: SceneDocument, ids: string[]) {
  const roots = selectionRoots(doc, ids);
  if (!roots.length || roots.some((id) => isNodeLocked(doc, id)))
    return { document: doc, ids };
  const parentId = doc.nodes[roots[0]].parentId!;
  if (roots.some((id) => doc.nodes[id].parentId !== parentId))
    return { document: doc, ids };
  const parent = doc.nodes[parentId];
  const rootSet = new Set(roots);
  const ordered = parent.children.filter((id) => rootSet.has(id));
  const next = clone(doc);
  const group = createNode("group", parentId, {
    name: "Group",
    children: ordered,
  });
  next.nodes[group.id] = group;
  const last = parent.children.reduce(
    (last, id, index) => (rootSet.has(id) ? index : last),
    -1,
  );
  next.nodes[parentId].children = parent.children.flatMap((id, i) =>
    i === last ? [group.id] : rootSet.has(id) ? [] : [id],
  );
  for (const id of ordered) next.nodes[id].parentId = group.id;
  const normalized = normalizeGroupBounds(next);
  validateDocument(normalized);
  return { document: normalized, ids: [group.id] };
}

export function ungroupNodes(doc: SceneDocument, ids: string[]) {
  const groups = selectionRoots(doc, ids).filter(
    (id) => doc.nodes[id].type === "group",
  );
  if (
    !groups.length ||
    groups.some(
      (id) =>
        isNodeLocked(doc, id) ||
        doc.nodes[id].opacity !== 1 ||
        doc.nodes[id].clipContent ||
        !doc.nodes[id].visible,
    )
  )
    return { document: doc, ids };
  const next = clone(doc),
    selected = ids.filter((id) => !groups.includes(id));
  for (const id of groups) {
    const n = next.nodes[id],
      parent = next.nodes[n.parentId!];
    parent.children.splice(parent.children.indexOf(id), 1, ...n.children);
    for (const child of n.children) {
      next.nodes[child].transform = multiplyMatrices(
        n.transform,
        next.nodes[child].transform,
      );
      next.nodes[child].parentId = parent.id;
      selected.push(child);
    }
    delete next.nodes[id];
  }
  const normalized = normalizeGroupBounds(next);
  validateDocument(normalized);
  return { document: normalized, ids: selected };
}

/** Collapse deep hits to the outermost group outside the current entry scope. */
export function groupHitTarget(
  doc: SceneDocument,
  hit: string | null,
  scope: string | null,
) {
  if (!hit) return null;
  let result = hit;
  for (
    let id: string | null = hit;
    id && id !== scope;
    id = doc.nodes[id].parentId
  ) {
    if (doc.nodes[id].type === "group") result = id;
  }
  return result;
}
