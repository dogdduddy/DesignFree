import type { Point, SceneDocument, SceneNode } from "./core";

/** Prototype links: a click on a layer inside a screen (a top-level frame of a
 * page) navigates to another screen of the same page. Editor-only behaviour:
 * renderers and exports ignore it. */
export type Transition = { type: "instant" } | { type: "dissolve"; duration: number };
export type Interaction = {
  trigger: "click";
  action: { type: "navigate"; destinationId: string; transition: Transition };
};
export const DISSOLVE_DURATIONS = [150, 300, 500, 800] as const;
export const MAX_TRANSITION_MS = 10000;

const plain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));

export function validInteractions(value: unknown): value is Interaction[] {
  if (!Array.isArray(value) || value.length > 8) return false;
  return value.every((i) => {
    if (!plain(i) || !keys(i, ["trigger", "action"]) || i.trigger !== "click") return false;
    const a = i.action;
    if (!plain(a) || !keys(a, ["type", "destinationId", "transition"]) || a.type !== "navigate") return false;
    if (typeof a.destinationId !== "string" || !a.destinationId || a.destinationId.length > 200) return false;
    const t = a.transition;
    if (!plain(t)) return false;
    if (t.type === "instant") return keys(t, ["type"]);
    return (
      t.type === "dissolve" &&
      keys(t, ["type", "duration"]) &&
      typeof t.duration === "number" &&
      Number.isFinite(t.duration) &&
      t.duration >= 0 &&
      t.duration <= MAX_TRANSITION_MS
    );
  });
}

/** Page that contains a node. */
export function pageOf(doc: SceneDocument, id: string): string | null {
  let n: SceneNode | undefined = doc.nodes[id];
  while (n?.parentId) n = doc.nodes[n.parentId];
  return n?.type === "page" ? n.id : null;
}
export const isScreen = (doc: SceneDocument, id: string) => {
  const n = doc.nodes[id];
  return n?.type === "frame" && doc.nodes[n.parentId ?? ""]?.type === "page";
};
/** Top-level frames of a page in layer order. */
export function screens(doc: SceneDocument, pageId = doc.rootId): SceneNode[] {
  return (doc.nodes[pageId]?.children ?? []).filter((id) => isScreen(doc, id)).map((id) => doc.nodes[id]);
}
/** The screen a layer belongs to (itself when it is a screen). */
export function screenOf(doc: SceneDocument, id: string): string | null {
  for (let n: SceneNode | undefined = doc.nodes[id]; n; n = doc.nodes[n.parentId ?? ""])
    if (isScreen(doc, n.id)) return n.id;
  return null;
}
const validDestination = (doc: SceneDocument, sourceId: string, destinationId: string) =>
  isScreen(doc, destinationId) && pageOf(doc, destinationId) === pageOf(doc, sourceId);

/** Drops links whose source is no longer inside a screen or whose destination
 * is no longer a screen on the source's page (deleted, moved, other document),
 * and start screens that stopped being one. Copy-on-write; returns the input
 * when nothing changes. */
export function pruneInteractions(doc: SceneDocument): SceneDocument {
  let next = doc;
  const write = (id: string, node: SceneNode) => {
    if (next === doc) next = { ...doc, nodes: { ...doc.nodes } };
    next.nodes[id] = node;
  };
  for (const original of Object.values(doc.nodes)) {
    if (original.interactions) {
      const inScreen = screenOf(doc, original.id) !== null;
      const kept = inScreen
        ? original.interactions.filter((i) => validDestination(doc, original.id, i.action.destinationId))
        : [];
      if (kept.length !== original.interactions.length) {
        const { interactions: _, ...rest } = next.nodes[original.id];
        write(original.id, kept.length ? { ...rest, interactions: kept } : rest);
      }
    }
    const start = original.prototypeStartId;
    if (start !== undefined && !(isScreen(doc, start) && doc.nodes[start].parentId === original.id)) {
      const { prototypeStartId: _, ...rest } = next.nodes[original.id];
      write(original.id, rest);
    }
  }
  return next;
}

/** Screen shown first: the page's start screen, else the screen containing
 * the selection, else the first screen. */
export function startScreen(doc: SceneDocument, selected: string[] = []): string | null {
  const page = doc.nodes[doc.rootId];
  if (page?.prototypeStartId && isScreen(doc, page.prototypeStartId)) return page.prototypeStartId;
  for (const id of selected) {
    const s = screenOf(doc, id);
    if (s && pageOf(doc, s) === doc.rootId) return s;
  }
  return screens(doc)[0]?.id ?? null;
}

/** The click target in preview: the deepest visible layer under the point
 * (locks do not apply in preview), then the nearest ancestor up to the screen
 * that has a click link. `local` is in the screen's coordinates. */
export function previewTarget(
  doc: SceneDocument,
  screenId: string,
  local: Point,
): { id: string; interaction: Interaction } | null {
  function hit(id: string, p: Point): string | null {
    const n = doc.nodes[id];
    if (!n?.visible) return null;
    const inside = p.x >= 0 && p.y >= 0 && p.x <= n.width && p.y <= n.height && (n.type !== "ellipse" || ellipse(n, p));
    // The screen is the preview viewport: nothing outside it is visible.
    if ((n.clipContent || id === screenId) && !inside) return null;
    for (let i = n.children.length - 1; i >= 0; i--) {
      const c = doc.nodes[n.children[i]];
      if (!c) continue;
      const q = toLocal(c.transform, p);
      if (!q) continue;
      const found = hit(c.id, q);
      if (found) return found;
    }
    return inside ? id : null;
  }
  const deepest = hit(screenId, local);
  for (let n: SceneNode | undefined = deepest ? doc.nodes[deepest] : undefined; n; n = doc.nodes[n.parentId ?? ""]) {
    const interaction = n.interactions?.find((i) => playable(doc, screenId, i));
    if (interaction) return { id: n.id, interaction };
    if (n.id === screenId) break;
  }
  return null;
}
/** A link the player can follow from this screen (not to the screen itself). */
const playable = (doc: SceneDocument, screenId: string, i: Interaction) =>
  i.trigger === "click" && i.action.destinationId !== screenId && isScreen(doc, i.action.destinationId);
function ellipse(n: SceneNode, p: Point) {
  return n.width > 0 && n.height > 0 && ((p.x - n.width / 2) / (n.width / 2)) ** 2 + ((p.y - n.height / 2) / (n.height / 2)) ** 2 <= 1;
}
function toLocal(m: SceneNode["transform"], p: Point): Point | null {
  const d = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
  const x = p.x - m[4], y = p.y - m[5];
  return { x: (m[3] * x - m[2] * y) / d, y: (-m[1] * x + m[0] * y) / d };
}

/** Layers with click links inside a screen, as boxes in screen coordinates
 * (for the preview's hotspot hint). */
export function hotspots(doc: SceneDocument, screenId: string) {
  const out: { id: string; x: number; y: number; width: number; height: number }[] = [];
  const visit = (id: string, m: SceneNode["transform"]) => {
    const n = doc.nodes[id];
    if (!n?.visible) return;
    if (n.interactions?.some((i) => playable(doc, screenId, i))) {
      const pts = [[0, 0], [n.width, 0], [0, n.height], [n.width, n.height]].map(([x, y]) => [
        m[0] * x + m[2] * y + m[4],
        m[1] * x + m[3] * y + m[5],
      ]);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      out.push({ id, x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
    }
    for (const c of n.children) {
      const t = doc.nodes[c]?.transform;
      if (!t) continue;
      visit(c, [
        m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1],
        m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3],
        m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5],
      ]);
    }
  };
  visit(screenId, [1, 0, 0, 1, 0, 0]);
  return out;
}
