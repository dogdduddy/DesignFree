import { duplicateNodes, type SceneDocument } from "./core";
import {
  reconcileComponents,
  setVariantProperties,
  type Variant,
  variantMembers,
} from "./components";

/** Clone an explicit semantic correspondence; no heuristic name matching. */
export function createVariant(doc: SceneDocument, sourceId: string) {
  const source = doc.nodes[sourceId];
  if (source?.component?.kind !== "main")
    throw new Error("컴포넌트 원본을 선택해 주세요.");
  let next = structuredClone(doc);
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
  next = reconcileComponents(next);
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
