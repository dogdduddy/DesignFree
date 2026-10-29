import {
  duplicateNodes,
  isNodeLocked,
  validateDocument,
  type SceneDocument,
} from "./core";
import {
  validVariantProperties,
  setVariantProperties,
  type Variant,
  variantMembers,
} from "./components";

/** Clone an explicit semantic correspondence; no heuristic name matching. */
export function createVariant(doc: SceneDocument, sourceId: string) {
  const source = doc.nodes[sourceId];
  if (source?.component?.kind !== "main")
    throw new Error("컴포넌트 원본을 선택해 주세요.");
  const next = structuredClone(doc);
  const main = next.nodes[sourceId].component as {
    kind: "main";
    variant?: Variant;
  };
  if (!main.variant) {
    const keys: Record<string, string> = Object.create(null);
    const visit = (id: string) => {
      keys[id] = `${next.nodes[id].type}:${crypto.randomUUID()}`;
      next.nodes[id].children.forEach(visit);
    };
    visit(sourceId);
    main.variant = {
      setId: crypto.randomUUID(),
      properties: { State: "Default" },
      keys,
    };
  }
  // Refresh only authored semantic keys. Materializing existing instances here
  // would make source propagation look like direct overrides at history capture.
  const refreshKeys = (id: string) => {
    main.variant!.keys[id] ??= `${next.nodes[id].type}:${crypto.randomUUID()}`;
    next.nodes[id].children.forEach(refreshKeys);
  };
  refreshKeys(sourceId);
  const variant = (next.nodes[sourceId].component as { variant: Variant })
    .variant;
  const copy = duplicateNodes(next, [sourceId], { x: source.width + 24, y: 0 });
  const id = copy.ids[0];
  if (!id) throw new Error("잠긴 원본은 복제할 수 없습니다.");
  const keys: Record<string, string> = Object.create(null);
  const match = (a: string, b: string) => {
    keys[b] = variant.keys[a];
    next.nodes[a].children.forEach((child, i) =>
      match(child, copy.document.nodes[b].children[i]),
    );
  };
  match(sourceId, id);
  const properties = { ...variant.properties };
  const property = Object.keys(properties)[0];
  let index = 2;
  const members = variantMembers(next, sourceId);
  const tuple = (p: Record<string, string>) =>
    JSON.stringify(
      Object.keys(p)
        .sort()
        .map((k) => p[k]),
    );
  const used = new Set(
    members.map((n) =>
      tuple((n.component as { variant: Variant }).variant.properties),
    ),
  );
  do {
    properties[property] = `Variant ${index++}`;
  } while (used.has(tuple(properties)));
  copy.document.nodes[id].component = {
    kind: "main",
    variant: { ...structuredClone(variant), keys },
  };
  return { document: setVariantProperties(copy.document, id, properties), id };
}

export type VariantRow = { id: string; name: string; values: string[] };

/** Apply a complete visual-editor transaction without changing semantic keys. */
export function editVariantSet(
  doc: SceneDocument,
  sourceId: string,
  axes: string[],
  rows: VariantRow[],
): SceneDocument {
  const members = variantMembers(doc, sourceId);
  if (!members.length || !rows.length)
    throw new Error("상태: 하나 이상의 상태가 필요합니다.");
  if (!axes.length || axes.length > 32)
    throw new Error("축: 1~32개가 필요합니다.");
  axes.forEach((axis, i) => {
    if (!validVariantProperties({ [axis]: "value" }))
      throw new Error(
        `축 ${i + 1} 이름: 공백 없는 1~80자 이름이 필요하며 예약 이름은 사용할 수 없습니다.`,
      );
    if (axes.indexOf(axis) !== i)
      throw new Error(`축 ${i + 1} 이름: '${axis}' 축이 중복됩니다.`);
  });
  const tuples = new Map<string, number>();
  const ids = new Set<string>();
  rows.forEach((row, i) => {
    if (!members.some((n) => n.id === row.id) || ids.has(row.id))
      throw new Error(`상태 ${i + 1}: 유효하지 않은 원본입니다.`);
    ids.add(row.id);
    if (!row.name.trim() || row.name.length > 200)
      throw new Error(`상태 ${i + 1} 이름: 1~200자가 필요합니다.`);
    if (row.values.length !== axes.length)
      throw new Error(`상태 ${i + 1}: 축별 값을 입력하세요.`);
    row.values.forEach((value, j) => {
      if (!validVariantProperties({ [axes[j]]: value }))
        throw new Error(
          `상태 ${i + 1} / 축 ${j + 1} (${axes[j]}) 값: 1~160자의 비어 있지 않은 값이 필요합니다.`,
        );
    });
    const tuple = JSON.stringify(row.values);
    if (tuples.has(tuple))
      throw new Error(
        `상태 ${i + 1}: 상태 ${tuples.get(tuple)! + 1}와 축·값 조합이 같습니다. 값을 변경하거나 중복 상태를 삭제하세요.`,
      );
    tuples.set(tuple, i);
  });
  const next = structuredClone(doc);
  for (const member of members) {
    const row = rows.find((r) => r.id === member.id);
    const changed =
      !row ||
      row.name !== member.name ||
      JSON.stringify(
        Object.fromEntries(axes.map((a, i) => [a, row.values[i]])),
      ) !==
        JSON.stringify(
          (member.component as { variant: Variant }).variant.properties,
        );
    if (changed && isNodeLocked(doc, member.id))
      throw new Error(`상태 '${member.name}': 잠긴 원본은 편집할 수 없습니다.`);
    if (row) {
      next.nodes[row.id].name = row.name;
      (
        next.nodes[row.id].component as { variant: Variant }
      ).variant.properties = Object.fromEntries(
        axes.map((a, i) => [a, row.values[i]]),
      );
    } else {
      const remove = (id: string) => {
        next.nodes[id].children.forEach(remove);
        delete next.nodes[id];
      };
      const parent = next.nodes[member.parentId!];
      parent.children = parent.children.filter((id) => id !== member.id);
      remove(member.id);
    }
  }
  validateDocument(next);
  return next;
}
