import {
  createNode,
  parseDocument,
  serializeDocument,
  type SceneDocument,
} from "./core";

export const pageIds = (document: SceneDocument) =>
  document.pageIds ?? [document.rootId];

/** Lossless, explicit v1 -> v2 migration; v1 remains readable and never overwritten on read. */
export function migratePages(document: SceneDocument): SceneDocument {
  const copy = parseDocument(serializeDocument(document));
  return { ...copy, schemaVersion: 2, pageIds: [...pageIds(copy)] };
}
export function newDocument(): SceneDocument {
  const page = createNode("page", null, {
    name: "Page 1",
    width: 1440,
    height: 900,
  });
  return {
    schemaVersion: 2,
    id: crypto.randomUUID(),
    name: "Untitled",
    rootId: page.id,
    pageIds: [page.id],
    nodes: { [page.id]: page },
    assets: {},
  };
}
export function addPage(document: SceneDocument): SceneDocument {
  const next = migratePages(document);
  const page = createNode("page", null, {
    name: `Page ${next.pageIds!.length + 1}`,
    width: 1440,
    height: 900,
  });
  next.nodes[page.id] = page;
  next.pageIds!.push(page.id);
  next.rootId = page.id;
  return next;
}
export function switchPage(document: SceneDocument, id: string): SceneDocument {
  if (!pageIds(document).includes(id)) throw new Error("Unknown page");
  return { ...document, rootId: id };
}
export function renamePage(
  document: SceneDocument,
  name: string,
): SceneDocument {
  name = checkedName(name);
  return {
    ...document,
    nodes: {
      ...document.nodes,
      [document.rootId]: { ...document.nodes[document.rootId], name },
    },
  };
}
export function removePage(document: SceneDocument): SceneDocument {
  const next = migratePages(document);
  if (next.pageIds!.length === 1) throw new Error("Keep at least one page");
  const remove = (id: string) => {
    next.nodes[id].children.forEach(remove);
    delete next.nodes[id];
  };
  const index = next.pageIds!.indexOf(next.rootId);
  remove(next.rootId);
  next.pageIds!.splice(index, 1);
  next.rootId = next.pageIds![Math.min(index, next.pageIds!.length - 1)];
  // Owned assets may be shared by other pages; retaining unused assets is lossless.
  return next;
}
export function checkedName(name: string) {
  const value = name.trim();
  if (!value || value.length > 200)
    throw new Error("이름은 1~200자로 입력하세요.");
  return value;
}
export function duplicateDocument(document: SceneDocument): SceneDocument {
  const copy = parseDocument(serializeDocument(document));
  // Layer/page/asset IDs are document-scoped and can be retained safely.
  return {
    ...copy,
    id: crypto.randomUUID(),
    name: `${copy.name.slice(0, 195)} copy`,
  };
}
