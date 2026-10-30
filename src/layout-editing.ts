import { selectionRoots, type SceneDocument, type SceneNode } from "./core";

export const flowContainer = (node?: SceneNode) =>
  !!node && ["flex", "grid"].includes(node.layout.mode);

const derivedSize = (node: SceneNode) =>
  !!node.styleRefs?.width ||
  !!node.styleRefs?.height ||
  (flowContainer(node) &&
    ((node.layout.padding?.[1] ?? 0) + (node.layout.padding?.[3] ?? 0) >
      node.width ||
      (node.layout.padding?.[0] ?? 0) + (node.layout.padding?.[2] ?? 0) >
        node.height)) ||
  (node.layout.width ?? "fixed") !== "fixed" ||
  (node.layout.height ?? "fixed") !== "fixed" ||
  [
    node.layout.minWidth,
    node.layout.maxWidth,
    node.layout.minHeight,
    node.layout.maxHeight,
  ].some((value) => value !== undefined);

/** Free transforms only operate where source and computed selection axes agree.
 * A fixed container may reflow its descendants without rewriting their rules.
 * Group bounds, in contrast, depend on immediate children's computed dimensions.
 */
export function layoutTransformBlocked(doc: SceneDocument, ids: string[]) {
  const groupDerived = (id: string): boolean => {
    const node = doc.nodes[id];
    return (
      derivedSize(node) ||
      (node.type === "group" && node.children.some(groupDerived))
    );
  };
  return selectionRoots(doc, ids).some((id) => {
    let node = doc.nodes[id];
    if (groupDerived(id)) return true;
    while (node.parentId) {
      const parent = doc.nodes[node.parentId];
      if (
        derivedSize(parent) ||
        (flowContainer(parent) && node.layout.position !== "absolute")
      )
        return true;
      node = parent;
    }
    return false;
  });
}

/** Grouping changes flow participation; only absolute, fixed boxes can be wrapped.
 * Layout frames with fixed outer boxes retain their complete inner layout rules.
 */
export function layoutGroupBlocked(doc: SceneDocument, ids: string[]) {
  if (layoutTransformBlocked(doc, ids)) return true;
  return selectionRoots(doc, ids).some((id) =>
    flowContainer(doc.nodes[doc.nodes[id].parentId ?? ""]),
  );
}

export class LayoutEditError extends Error {}

/** A group relies on authored tight bounds. Flow must not discard the group's
 * compensating translation when insert/remove normalizes those bounds. */
export function layoutInsertionReason(
  doc: SceneDocument,
  nodes: SceneNode[],
  parentId: string,
): string | undefined {
  if (
    flowContainer(doc.nodes[parentId]) &&
    nodes.some((n) => n.type === "group")
  )
    return "그룹을 Flex/Grid 흐름 안에 넣으면 원본 경계 보정이 배치와 충돌합니다. absolute 부모를 사용하세요.";
  for (let id: string | null = parentId; id; id = doc.nodes[id].parentId) {
    if (doc.nodes[id].type !== "group") continue;
    if (layoutTransformBlocked(doc, [id]))
      return "계산된 흐름·크기 안의 그룹은 경계 보정으로 다른 자식이 이동할 수 있어 구조 변경을 지원하지 않습니다. 그룹을 absolute 부모로 옮기세요.";
    if (nodes.some(derivedSize))
      return "그룹은 원본 크기로 경계를 계산하므로 hug/fill·최소/최대 크기 레이어를 넣을 수 없습니다. fixed 크기 또는 프레임 부모를 사용하세요.";
  }
}

export function layoutReparentReason(
  doc: SceneDocument,
  ids: string[],
  parentId: string,
) {
  const roots = selectionRoots(doc, ids);
  const moving = roots.filter((id) => doc.nodes[id].parentId !== parentId);
  if (!moving.length) return undefined;
  const reason = layoutInsertionReason(
    doc,
    moving.map((id) => doc.nodes[id]),
    parentId,
  );
  if (reason) return reason;
  for (const id of moving) {
    for (let p = doc.nodes[id].parentId; p; p = doc.nodes[p].parentId)
      if (doc.nodes[p].type === "group" && layoutTransformBlocked(doc, [p]))
        return "계산된 흐름·크기 안의 그룹은 경계 보정으로 다른 자식이 이동할 수 있어 구조 변경을 지원하지 않습니다. 그룹 전체를 absolute 부모로 옮기세요.";
  }
}
