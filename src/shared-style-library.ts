import { validateDocument, type SceneDocument } from "./core";
import { validateStyleLibrary, type StyleLibrary } from "./style-library";

/** References stay document-local; these maps record the external origin of pinned entries. */
export type SharedStyleLibrary = {
  sourceId: string;
  sourceName: string;
  tokens: Record<string, string>;
  styles: Record<string, string>;
};
const plain = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const key = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[A-Za-z0-9_-]{1,80}$/.test(v) &&
  !["__proto__", "constructor", "prototype"].includes(v);
const fail = () => {
  throw new Error("공유 라이브러리 참조 정보가 올바르지 않습니다.");
};
export function validateSharedStyleLibraries(value: unknown) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 16) fail();
  const sources = new Set<string>(),
    targets = { tokens: new Set<string>(), styles: new Set<string>() };
  for (const item of value as any[]) {
    if (
      !plain(item) ||
      Object.keys(item).some(
        (k) => !["sourceId", "sourceName", "tokens", "styles"].includes(k),
      ) ||
      typeof item.sourceId !== "string" ||
      !item.sourceId.length ||
      item.sourceId.length > 1000 ||
      typeof item.sourceName !== "string" ||
      !item.sourceName.length ||
      item.sourceName.length > 1000 ||
      sources.has(item.sourceId)
    )
      fail();
    sources.add(item.sourceId);
    for (const category of ["tokens", "styles"] as const) {
      if (!plain(item[category]) || Object.keys(item[category]).length > 512)
        fail();
      for (const [id, target] of Object.entries(item[category])) {
        if (!key(id) || !key(target) || targets[category].has(target)) fail();
        targets[category].add(target as string);
      }
    }
  }
}
/** The source's selected theme is pinned, preserving aliases within that snapshot. */
function snapshot(source: SceneDocument): StyleLibrary {
  const library = structuredClone(
    source.styleLibrary ?? { tokens: {}, styles: {}, themes: {} },
  );
  validateStyleLibrary(library);
  const overrides = library.activeTheme
    ? library.themes[library.activeTheme].values
    : {};
  for (const [id, value] of Object.entries(overrides))
    library.tokens[id].value = structuredClone(value) as any;
  return { tokens: library.tokens, styles: library.styles, themes: {} };
}
const canonical = (v: any): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : plain(v)
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(",")}}`
      : JSON.stringify(v);
function remap(entry: any, tokens: Record<string, string>) {
  const copy = structuredClone(entry);
  if (plain(copy.value) && Object.hasOwn(copy.value, "ref"))
    copy.value.ref = tokens[copy.value.ref];
  return copy;
}
export type SharedLibraryState = {
  sourceId: string;
  sourceName: string;
  status: "current" | "update" | "missing";
  issues: string[];
};
export function inspectSharedStyleLibraries(
  doc: SceneDocument,
  documents: SceneDocument[],
): SharedLibraryState[] {
  return (doc.sharedStyleLibraries ?? []).map((link) => {
    const source = documents.find((d) => d.id === link.sourceId);
    if (!source)
      return {
        sourceId: link.sourceId,
        sourceName: link.sourceName,
        status: "missing",
        issues: ["원본 문서 없음 · 마지막 스냅샷 사용"],
      };
    const library = snapshot(source),
      issues: string[] = [];
    let changed =
      source.name !== link.sourceName ||
      Object.values(doc.styleLibrary?.themes ?? {}).some((theme) =>
        Object.values(link.tokens).some((id) =>
          Object.hasOwn(theme.values, id),
        ),
      );
    for (const category of ["tokens", "styles"] as const) {
      for (const [id, local] of Object.entries(link[category])) {
        if (!Object.hasOwn(library[category], id))
          issues.push(`${category}.${id}: 원본 항목 없음 · 마지막 스냅샷 사용`);
        else if (!Object.hasOwn(doc.styleLibrary?.[category] ?? {}, local))
          issues.push(`${category}.${id}: 로컬 스냅샷 없음`);
        else if (
          canonical(remap(library[category][id], link.tokens)) !==
          canonical(doc.styleLibrary![category][local])
        )
          changed = true;
      }
      if (
        Object.keys(library[category]).some(
          (id) => !Object.hasOwn(link[category], id),
        )
      )
        changed = true;
    }
    return {
      sourceId: link.sourceId,
      sourceName: source.name,
      status: issues.length ? "missing" : changed ? "update" : "current",
      issues,
    };
  });
}
/** One explicit import/refresh changes only the consuming document and is undoable. */
export function importSharedStyleLibrary(
  doc: SceneDocument,
  source: SceneDocument,
): SceneDocument {
  if (doc.id === source.id)
    throw new Error("자기 문서는 공유 원본으로 연결할 수 없습니다.");
  const next = structuredClone(doc),
    library = snapshot(source);
  const previous = structuredClone(doc.styleLibrary);
  const literal = (entry: any, lib: StyleLibrary): any => {
    let value = entry.value;
    const overrides = lib.activeTheme ? lib.themes[lib.activeTheme].values : {};
    while (plain(value) && Object.hasOwn(value, "ref")) {
      const id = value.ref;
      value = Object.hasOwn(overrides, id)
        ? overrides[id]
        : lib.tokens[id].value;
    }
    return structuredClone(value);
  };
  next.styleLibrary ??= { tokens: {}, styles: {}, themes: {} };
  next.sharedStyleLibraries ??= [];
  let link = next.sharedStyleLibraries.find((l) => l.sourceId === source.id);
  if (!link) {
    link = {
      sourceId: source.id,
      sourceName: source.name,
      tokens: {},
      styles: {},
    };
    next.sharedStyleLibraries.push(link);
  }
  link.sourceName = source.name;
  for (const category of ["tokens", "styles"] as const) {
    for (const id of Object.keys(library[category])) {
      if (!Object.hasOwn(link[category], id)) {
        let target: string;
        do {
          target = `shared-${crypto.randomUUID()}`;
        } while (
          Object.hasOwn(next.styleLibrary[category], target) ||
          next.sharedStyleLibraries.some((l) =>
            Object.values(l[category]).includes(target),
          )
        );
        link[category][id] = target;
      }
    }
  }
  for (const category of ["tokens", "styles"] as const)
    for (const [id, entry] of Object.entries(library[category]))
      next.styleLibrary[category][link[category][id]] = remap(
        entry,
        link.tokens,
      );
  // Deleted source entries remain as last-known fallbacks and stay visibly missing.
  // Consumer themes are local: refresh must not silently retain overrides on imported tokens.
  for (const theme of Object.values(next.styleLibrary.themes))
    for (const id of Object.values(link.tokens)) delete theme.values[id];
  // If a missing entry's still-present dependencies changed, freeze its last
  // resolved value rather than letting a partial refresh alter the fallback.
  if (previous)
    for (const category of ["tokens", "styles"] as const)
      for (const [id, local] of Object.entries(link[category]))
        if (
          !Object.hasOwn(library[category], id) &&
          Object.hasOwn(previous[category], local) &&
          Object.hasOwn(next.styleLibrary[category], local)
        ) {
          // Resolve tokens through an alias so their own theme override is honored.
          const oldEntry =
            category === "tokens"
              ? { value: { ref: local } }
              : previous[category][local];
          const newEntry =
            category === "tokens"
              ? { value: { ref: local } }
              : next.styleLibrary[category][local];
          const before = literal(oldEntry, previous);
          if (
            canonical(before) !==
            canonical(literal(newEntry, next.styleLibrary))
          )
            next.styleLibrary[category][local].value = before;
        }
  validateDocument(next);
  return canonical(next) === canonical(doc) ? doc : next;
}
/** Convert the pinned entries to ordinary local styles without changing any binding. */
export function detachSharedStyleLibrary(
  doc: SceneDocument,
  sourceId: string,
): SceneDocument {
  if (!doc.sharedStyleLibraries?.some((l) => l.sourceId === sourceId))
    return doc;
  const next = structuredClone(doc);
  next.sharedStyleLibraries = next.sharedStyleLibraries!.filter(
    (l) => l.sourceId !== sourceId,
  );
  if (!next.sharedStyleLibraries.length) delete next.sharedStyleLibraries;
  validateDocument(next);
  return next;
}
