import type { SceneDocument, SceneNode } from "./core";
import { ownedJSON } from "./owned-json";

/** Expanded scene snapshots keep renderers/layout independent of component semantics. */
export type Variant = {
  setId: string;
  properties: Record<string, string>;
  /** Shared semantic layer keys, assigned when cloning a variant. */
  keys: Record<string, string>;
};
export type VariantOverride = {
  paths: Record<string, unknown>;
  stroke?: SceneNode["stroke"];
};
export type Instance = {
  kind: "instance";
  sourceId: string;
  /** Stable source node -> materialized node identity, including nested source instances. */
  nodeMap: Record<string, string>;
  /** Leaf paths (text.content, layout.gap); arrays and paints are atomic values. */
  overrides: Record<string, Record<string, unknown>>;
  /** Dormant layer overrides, keyed by shared semantic layer identity. */
  variantOverrides?: Record<string, VariantOverride>;
};
export type Component = { kind: "main"; variant?: Variant } | Instance;
const excluded = new Set(["id", "parentId", "children", "component", "type"]);
const plain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const own = (v: object, k: string) => Object.hasOwn(v, k);
const clone = <T>(v: T): T => structuredClone(v);
const error = (message: string): never => {
  throw new Error(message);
};

export function instanceOwner(
  doc: SceneDocument,
  id: string,
): SceneNode | undefined {
  let n = doc.nodes[id];
  while (n) {
    if (n.component?.kind === "instance") return n;
    n = doc.nodes[n.parentId!];
  }
}
function subtree(doc: SceneDocument, id: string): string[] {
  const result: string[] = [];
  const visit = (nodeId: string) => {
    result.push(nodeId);
    for (const child of doc.nodes[nodeId].children) visit(child);
  };
  visit(id);
  return result;
}
function leafDiff(
  before: unknown,
  after: unknown,
  prefix = "",
): Record<string, unknown> {
  if (equal(before, after)) return {};
  if (plain(after) && (plain(before) || before === undefined)) {
    const prior = plain(before) ? before : {};
    return Object.fromEntries(
      [...new Set([...Object.keys(prior), ...Object.keys(after)])].flatMap(
        (k) =>
          Object.entries(
            leafDiff(prior[k], after[k], prefix ? `${prefix}.${k}` : k),
          ),
      ),
    );
  }
  // null is an explicit deletion marker; authoring fields never use null.
  return { [prefix]: after === undefined ? null : clone(after) };
}
function applyPaths(node: SceneNode, paths: Record<string, unknown>) {
  for (const [path, value] of Object.entries(paths)) {
    const keys = path.split(".");
    let target = node as unknown as Record<string, unknown>;
    keys.slice(0, -1).forEach((k) => {
      if (!plain(target[k])) target[k] = {};
      target = target[k] as Record<string, unknown>;
    });
    if (value === null) delete target[keys.at(-1)!];
    else target[keys.at(-1)!] = clone(value);
  }
}
/** Syntax validation also bounds property paths to known authoring fields. */
export function validComponent(value: unknown, node: SceneNode): boolean {
  if (value === undefined) return true;
  if (!plain(value) || !["frame", "group"].includes(node.type)) return false;
  if (value.kind === "main") {
    const v = value.variant;
    return (
      Object.keys(value).every((k) => ["kind", "variant"].includes(k)) &&
      (v === undefined ||
        (plain(v) &&
          typeof v.setId === "string" &&
          v.setId.length > 0 &&
          validVariantProperties(v.properties) &&
          plain(v.keys) &&
          Object.values(v.keys).every(
            (k) => typeof k === "string" && k.length > 0,
          ) &&
          new Set(Object.values(v.keys)).size === Object.keys(v.keys).length))
    );
  }
  if (
    value.kind !== "instance" ||
    typeof value.sourceId !== "string" ||
    !plain(value.nodeMap) ||
    !plain(value.overrides)
  )
    return false;
  const fields = new Set([
    "name",
    "transform",
    "width",
    "height",
    "fill",
    "fills",
    "stroke",
    "opacity",
    "radius",
    "clipContent",
    "visible",
    "locked",
    "text",
    "assetId",
    "layout",
    "styleRefs",
    "effects",
  ]);
  const unsafe = new Set(["__proto__", "constructor", "prototype"]);
  if (value.variantOverrides !== undefined) {
    if (
      !plain(value.variantOverrides) ||
      !Object.entries(value.variantOverrides).every(([key, entry]) => {
        if (!key || !plain(entry) || !plain(entry.paths)) return false;
        // Reuse the same safe path grammar for dormant overrides as for active ones.
        return (
          validComponent(
            {
              kind: "instance",
              sourceId: "root",
              nodeMap: { root: node.id },
              overrides: { root: entry.paths },
            },
            node,
          ) &&
          (entry.stroke === undefined ||
            (plain(entry.stroke) &&
              typeof entry.stroke.color === "string" &&
              typeof entry.stroke.width === "number" &&
              Number.isFinite(entry.stroke.width) &&
              entry.stroke.width >= 0))
        );
      })
    )
      return false;
  }
  return (
    Object.values(value.nodeMap).every((v) => typeof v === "string") &&
    new Set(Object.values(value.nodeMap)).size ===
      Object.keys(value.nodeMap).length &&
    value.nodeMap[value.sourceId] === node.id &&
    Object.entries(value.overrides).every(([id, paths]) => {
      if (!own(value.nodeMap as object, id) || !plain(paths)) return false;
      const pathSet = new Set(Object.keys(paths));
      return [...pathSet].every((path) => {
        const keys = path.split(".");
        return (
          keys.length <= 3 &&
          fields.has(keys[0]) &&
          !keys
            .slice(0, -1)
            .some((_, i) => pathSet.has(keys.slice(0, i + 1).join("."))) &&
          keys.every((k) => /^[A-Za-z][A-Za-z0-9]*$/.test(k) && !unsafe.has(k))
        );
      });
    })
  );
}

/** Run once at the history boundary: direct changes become overrides, then sources propagate.
 * No renderer or computed-layout result ever writes overrides. `previous` must be
 * a history-owned document that is never edited afterwards. */
export function reconcileComponents(
  input: SceneDocument,
  previous?: SceneDocument,
  onlyInstanceId?: string,
): SceneDocument {
  if (
    !Object.values(input.nodes).some((n) => n.component) &&
    !Object.values(previous?.nodes ?? {}).some((n) => n.component)
  )
    return input;
  const doc = clone(input);
  // Maps may be stale during a source edit, but can never own another subtree.
  for (const root of Object.values(doc.nodes)) {
    const c = root.component;
    if (c?.kind !== "instance") continue;
    const owned = new Set(subtree(doc, root.id));
    for (const id of Object.values(c.nodeMap))
      if (own(doc.nodes, id) && !owned.has(id))
        error("Invalid component node ownership");
  }
  if (previous) {
    // Newly duplicated/Option-drag instances have no previous root to diff against.
    // Their authored placement/name are independent of the copied override metadata.
    for (const root of Object.values(doc.nodes)) {
      const c = root.component;
      if (c?.kind === "instance" && !own(previous.nodes, root.id)) {
        c.overrides[c.sourceId] = {
          ...c.overrides[c.sourceId],
          transform: clone(root.transform),
          name: root.name,
        };
      }
    }
    for (const oldRoot of Object.values(previous.nodes)) {
      const old = oldRoot.component;
      if (old?.kind !== "instance") continue;
      const root = doc.nodes[oldRoot.id];
      // Deleting the entire instance or explicitly detaching it is permitted.
      if (!root || !root.component) continue;
      if (root.component.kind !== "instance")
        error("인스턴스를 먼저 분리해 주세요.");
      const current = root.component as Instance;
      // A variant operation has already materialized its target. Its source
      // differences must not be captured as direct edits or structural overrides.
      if (current.sourceId !== old.sourceId) continue;
      for (const [sourceId, id] of Object.entries(old.nodeMap)) {
        const before = previous.nodes[id],
          after = doc.nodes[id];
        // An identical node has no structural change and no direct edit to capture.
        if (before && after && ownedJSON(before) === JSON.stringify(after))
          continue;
        if (
          !before ||
          !after ||
          !equal(before.children, after.children) ||
          before.type !== after.type ||
          (id !== root.id && before.parentId !== after.parentId)
        )
          error("인스턴스 내부 구조를 바꾸려면 먼저 분리해 주세요.");
        // Override reset is explicit metadata removal, so do not recapture it.
        if (!equal(old.overrides[sourceId], current.overrides[sourceId]))
          continue;
        const a = Object.fromEntries(
          Object.entries(before).filter(([k]) => !excluded.has(k)),
        );
        const b = Object.fromEntries(
          Object.entries(after).filter(([k]) => !excluded.has(k)),
        );
        const diff = leafDiff(a, b);
        if (Object.keys(diff).length) {
          const paths = { ...current.overrides[sourceId] };
          for (const [path, value] of Object.entries(diff)) {
            // Replacing/deleting an object supersedes its leaf overrides;
            // adding leaves likewise supersedes an earlier whole-object deletion.
            for (const prior of Object.keys(paths))
              if (prior.startsWith(path + ".") || path.startsWith(prior + "."))
                delete paths[prior];
            paths[path] = value;
          }
          current.overrides[sourceId] = paths;
        }
      }
    }
  }
  // Missing masters detach the last rendered snapshot, including cross-page deletion.
  for (const n of Object.values(doc.nodes)) {
    if (
      n.component?.kind === "instance" &&
      doc.nodes[n.component.sourceId]?.component?.kind !== "main"
    )
      delete n.component;
  }
  let nodeCount = Object.keys(doc.nodes).length;
  // A source is stable after resolve(sourceId). Reuse its preorder and node JSON
  // within this reconciliation only; never retain them across source edits or
  // variant switches. Each materialized node parses its own deep copy.
  const sourceSubtrees = new Map<string, string[]>();
  const sourceJSON = new Map<string, string>();
  const resolving = new Set<string>(),
    resolved = new Set<string>();
  const resolve = (id: string, depth = 0) => {
    if (depth > 128 || resolving.has(id))
      error("컴포넌트 순환 참조는 지원하지 않습니다.");
    if (resolved.has(id)) return;
    resolving.add(id);
    const root = doc.nodes[id];
    if (!root) return;
    const link = root.component;
    // Explicit source switches materialize just their own subtree before history.
    // Dependent instances must propagate once, after direct-edit capture.
    if (link?.kind === "instance" && onlyInstanceId && id !== onlyInstanceId) {
      resolving.delete(id);
      resolved.add(id);
      return;
    }
    if (link?.kind === "instance") {
      resolve(link.sourceId, depth + 1);
      let sourceIds = sourceSubtrees.get(link.sourceId);
      if (!sourceIds) {
        sourceIds = subtree(doc, link.sourceId);
        sourceSubtrees.set(link.sourceId, sourceIds);
      }
      const oldIds = new Set(Object.values(link.nodeMap));
      const nextMap: Record<string, string> = Object.create(null);
      for (const sid of sourceIds)
        nextMap[sid] =
          sid === link.sourceId
            ? id
            : own(link.nodeMap, sid)
              ? link.nodeMap[sid]
              : crypto.randomUUID();
      const keep = new Set(Object.values(nextMap));
      nodeCount +=
        [...keep].filter((nodeId) => !own(doc.nodes, nodeId)).length -
        [...oldIds].filter(
          (nodeId) => !keep.has(nodeId) && own(doc.nodes, nodeId),
        ).length;
      if (nodeCount > 100000)
        error("컴포넌트 확장으로 문서 레이어 제한을 초과합니다.");
      for (const oldId of oldIds) if (!keep.has(oldId)) delete doc.nodes[oldId];
      for (const sid of sourceIds) {
        let text = sourceJSON.get(sid);
        if (text === undefined)
          sourceJSON.set(sid, (text = JSON.stringify(doc.nodes[sid])));
        const n: SceneNode = JSON.parse(text);
        n.id = nextMap[sid];
        n.parentId =
          sid === link.sourceId ? root.parentId : nextMap[n.parentId!];
        n.children = n.children.map((c) => nextMap[c]);
        delete n.component;
        const paths = link.overrides[sid] ?? {};
        // A partial stroke override still needs a valid stroke when the source
        // removes that optional object. Keep its last inherited fields locally;
        // they resume inheritance if the source reintroduces the stroke.
        const prior = doc.nodes[nextMap[sid]];
        if (
          !n.stroke &&
          prior?.stroke &&
          Object.keys(paths).some((path) => path.startsWith("stroke."))
        )
          n.stroke = clone(prior.stroke);
        applyPaths(n, paths);
        if (sid === link.sourceId) n.component = link;
        doc.nodes[n.id] = n;
      }
      link.nodeMap = nextMap;
      for (const sid of Object.keys(link.overrides))
        if (!own(nextMap, sid)) delete link.overrides[sid];
    } else {
      // Resolve nested source instances before copying a containing master.
      for (const child of root.children) resolve(child, depth + 1);
      if (link?.kind === "main" && link.variant) {
        const ids = subtree(doc, id);
        link.variant.keys = Object.fromEntries(
          ids.map((sid) => [
            sid,
            link.variant!.keys[sid] ??
              `${doc.nodes[sid].type}:${crypto.randomUUID()}`,
          ]),
        );
      }
    }
    resolving.delete(id);
    resolved.add(id);
  };
  for (const id of input.pageIds ?? [input.rootId]) resolve(id);
  return doc;
}

export function makeComponent(doc: SceneDocument, id: string): SceneDocument {
  const n = doc.nodes[id];
  if (
    !n ||
    !["frame", "group"].includes(n.type) ||
    n.component ||
    instanceOwner(doc, id)
  )
    error("일반 frame 또는 group 하나를 선택해 주세요.");
  const next = clone(doc);
  next.nodes[id].component = { kind: "main" };
  return next;
}
export function createInstance(
  doc: SceneDocument,
  sourceId: string,
  parentId?: string,
) {
  const source = doc.nodes[sourceId];
  if (source?.component?.kind !== "main")
    error("컴포넌트 원본을 선택해 주세요.");
  parentId ??= source.parentId!;
  const parent = doc.nodes[parentId];
  if (
    !parent ||
    !["page", "frame", "group"].includes(parent.type) ||
    instanceOwner(doc, parentId)
  )
    error("유효한 상위 레이어가 필요합니다.");
  const next = clone(doc),
    id = crypto.randomUUID();
  const root = clone(source);
  root.id = id;
  root.parentId = parentId;
  root.children = [];
  root.transform[4] += 24;
  root.transform[5] += 24;
  root.component = {
    kind: "instance",
    sourceId,
    nodeMap: { [sourceId]: id },
    overrides: {
      [sourceId]: {
        transform: root.transform,
        name: source.name + " instance",
      },
    },
  };
  next.nodes[id] = root;
  next.nodes[parentId].children.push(id);
  return { document: reconcileComponents(next), id };
}
export function detachInstance(doc: SceneDocument, id: string): SceneDocument {
  const next = clone(doc);
  if (next.nodes[id]?.component?.kind !== "instance")
    error("인스턴스 하나를 선택해 주세요.");
  delete next.nodes[id].component;
  return next;
}
export function resetInstanceOverrides(
  doc: SceneDocument,
  id: string,
): SceneDocument {
  const next = clone(doc),
    n = next.nodes[id];
  if (n?.component?.kind !== "instance")
    error("인스턴스 하나를 선택해 주세요.");
  const c = n.component as Instance;
  // Placement belongs to the instance, even when its style/content is reset.
  delete c.variantOverrides;
  c.overrides = { [c.sourceId]: { transform: clone(n.transform) } };
  return reconcileComponents(next);
}

/** Remap duplicate identities after the whole subtree has been cloned. */
export function remapComponents(
  doc: SceneDocument,
  map: Record<string, string>,
) {
  for (const id of Object.values(map)) {
    const c = doc.nodes[id].component;
    if (c?.kind === "main" && c.variant) {
      c.variant.keys = Object.fromEntries(
        Object.entries(c.variant.keys).map(([sid, key]) => [
          own(map, sid) ? map[sid] : sid,
          key,
        ]),
      );
      // Ordinary duplicate is a new independent main, not an ambiguous member.
      delete c.variant;
    }
    if (c?.kind !== "instance") continue;
    const sourceCopied = own(map, c.sourceId);
    const sourceKey = (s: string) => (sourceCopied && own(map, s) ? map[s] : s);
    c.sourceId = sourceKey(c.sourceId);
    c.nodeMap = Object.fromEntries(
      Object.entries(c.nodeMap).map(([s, n]) => [
        sourceKey(s),
        own(map, n) ? map[n] : n,
      ]),
    );
    c.overrides = Object.fromEntries(
      Object.entries(c.overrides).map(([s, v]) => [sourceKey(s), v]),
    );
  }
}

export function validVariantProperties(
  value: unknown,
): value is Record<string, string> {
  return (
    plain(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).length <= 32 &&
    Object.entries(value).every(
      ([k, v]) =>
        k.trim() === k &&
        k.length > 0 &&
        k.length <= 80 &&
        !["__proto__", "constructor", "prototype"].includes(k) &&
        typeof v === "string" &&
        v.trim().length > 0 &&
        v.length <= 160,
    )
  );
}
export function variantMembers(
  doc: SceneDocument,
  sourceId: string,
): SceneNode[] {
  const source = doc.nodes[sourceId]?.component;
  if (source?.kind !== "main" || !source.variant) return [];
  const setId = source.variant.setId;
  return Object.values(doc.nodes).filter(
    (n) => n.component?.kind === "main" && n.component.variant?.setId === setId,
  );
}
export function setVariantProperties(
  doc: SceneDocument,
  id: string,
  properties: Record<string, string>,
): SceneDocument {
  const c = doc.nodes[id]?.component;
  if (c?.kind !== "main" || !c.variant || !validVariantProperties(properties))
    error("유효한 variant 속성 이름과 값이 필요합니다.");
  const members = variantMembers(doc, id),
    next = clone(doc);
  // Adding/removing a property changes the set schema atomically. New axes
  // start at the supplied value on other members; existing values stay intact.
  for (const member of members) {
    const variant = (next.nodes[member.id].component as { variant: Variant })
      .variant;
    variant.properties = Object.fromEntries(
      Object.keys(properties).map((k) => [
        k,
        member.id === id
          ? properties[k]
          : (variant.properties[k] ?? properties[k]),
      ]),
    );
  }
  validateVariantSets(next);
  return next;
}
/** Target members are matched only by explicit shared keys, never layer names/order. */
export function switchVariant(
  doc: SceneDocument,
  id: string,
  targetId: string,
): SceneDocument {
  const root = doc.nodes[id],
    c = root?.component;
  if (c?.kind !== "instance") error("인스턴스 하나를 선택해 주세요.");
  const link = c as Instance;
  if (link.sourceId === targetId) return doc;
  const source = doc.nodes[link.sourceId],
    target = doc.nodes[targetId];
  if (
    !variantMembers(doc, link.sourceId).some((n) => n.id === targetId) ||
    target.type !== source.type
  )
    error("같은 variant 세트의 원본이 필요합니다.");
  const from = (source.component as { variant: Variant }).variant;
  const to = (target.component as { variant: Variant }).variant;
  const next = clone(doc),
    n = next.nodes[id],
    nextLink = n.component as Instance;
  const bank = nextLink.variantOverrides ?? {};
  const byKey = new Map<string, string>();
  for (const [sid, nid] of Object.entries(link.nodeMap)) {
    const role = from.keys[sid];
    if (!role) continue;
    const key = `${role}/${doc.nodes[sid].type}`;
    byKey.set(key, sid);
    bank[key] = {
      paths: clone(link.overrides[sid] ?? {}),
      ...(doc.nodes[nid]?.stroke
        ? { stroke: clone(doc.nodes[nid].stroke) }
        : {}),
    };
  }
  const map: Record<string, string> = Object.create(null),
    overrides: Instance["overrides"] = Object.create(null);
  for (const sid of subtree(doc, targetId)) {
    const key = `${to.keys[sid]}/${doc.nodes[sid].type}`,
      priorSid = byKey.get(key);
    // Each role keeps separate banks for incompatible layer types.
    const entry = bank[key];
    map[sid] =
      sid === targetId
        ? id
        : priorSid && doc.nodes[priorSid].type === doc.nodes[sid].type
          ? link.nodeMap[priorSid]
          : crypto.randomUUID();
    if (entry) overrides[sid] = clone(entry.paths);
    if (
      entry?.stroke &&
      !doc.nodes[sid].stroke &&
      Object.keys(entry.paths).some((p) => p.startsWith("stroke."))
    ) {
      // Seed optional-style fallback for a layer reappearing after an absence.
      next.nodes[map[sid]] = {
        ...clone(doc.nodes[sid]),
        id: map[sid],
        parentId: id,
        children: [],
        stroke: clone(entry.stroke),
      };
    }
  }
  overrides[targetId] = {
    ...overrides[targetId],
    transform: clone(root.transform),
  };
  nextLink.sourceId = targetId;
  nextLink.nodeMap = map;
  nextLink.overrides = overrides;
  nextLink.variantOverrides = bank;
  // Remove old materializations that have no target counterpart.
  const keep = new Set(Object.values(map));
  for (const nid of Object.values(link.nodeMap))
    if (!keep.has(nid)) delete next.nodes[nid];
  // Resolve without previous snapshot: this is an authored switch, not a child edit.
  // Ownership is checked against current children before installing the new map.
  n.children = [];
  for (const nid of keep)
    if (nid !== id) {
      const child = next.nodes[nid];
      if (child) {
        child.parentId = id;
        child.children = [];
        n.children.push(nid);
      }
    }
  return reconcileComponents(next, undefined, id);
}

/** Validate cross-member relationships without requiring keys for newly added children. */
export function validateVariantSets(doc: SceneDocument) {
  const sets = new Map<
    string,
    { type: string; names: string; tuples: Set<string> }
  >();
  for (const n of Object.values(doc.nodes)) {
    const c = n.component;
    if (c?.kind !== "main" || !c.variant) continue;
    const v = c.variant,
      names = Object.keys(v.properties).sort();
    const tuple = JSON.stringify(names.map((k) => v.properties[k]));
    const set = sets.get(v.setId);
    if (
      set &&
      (set.type !== n.type ||
        set.names !== JSON.stringify(names) ||
        set.tuples.has(tuple))
    )
      error("Variant 세트의 속성 이름/조합이 유효하지 않습니다.");
    if (set) set.tuples.add(tuple);
    else
      sets.set(v.setId, {
        type: n.type,
        names: JSON.stringify(names),
        tuples: new Set([tuple]),
      });
  }
}
