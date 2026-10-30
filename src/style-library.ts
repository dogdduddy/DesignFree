import { validateDocument, type SceneDocument, type SceneNode } from "./core";

export type StyleKind =
  "color" | "text" | "effect" | "number" | "spacing" | "radius";
export type StyleBinding =
  | "color"
  | "text"
  | "effect"
  | "gap"
  | "padding"
  | "width"
  | "height"
  | "radius";
export type TextStyle = Omit<
  NonNullable<SceneNode["text"]>,
  "content" | "sizing"
>;
/** Local-space drop shadow: blur is Gaussian sigma, with no spread or inset. */
export type Shadow = {
  type: "drop-shadow";
  x: number;
  y: number;
  blur: number;
  color: string;
};
export type StyleValues = {
  color: string;
  text: TextStyle;
  effect: Shadow[];
  number: number;
  spacing: number;
  radius: number;
};
export type StyleValue = StyleValues[StyleKind];
export type TokenReference = { ref: string };
export type StyleEntry = {
  [K in StyleKind]: {
    kind: K;
    name: string;
    value: StyleValues[K] | TokenReference;
  };
}[StyleKind];
export type StyleLibrary = {
  tokens: Record<string, StyleEntry>;
  styles: Record<string, StyleEntry>;
  themes: Record<
    string,
    { name: string; values: Record<string, StyleValue | TokenReference> }
  >;
  activeTheme?: string;
};
export type StyleRefs = Partial<Record<StyleBinding, string>>;
export const styleKinds: StyleKind[] = [
  "color",
  "text",
  "effect",
  "number",
  "spacing",
  "radius",
];
export const styleBindings: StyleBinding[] = [
  "color",
  "text",
  "effect",
  "gap",
  "padding",
  "width",
  "height",
  "radius",
];
/** Typed dimensions use numbers; spacing and radius also accept a generic number. */
export function compatibleStyleBinding(binding: string, kind: string): boolean {
  if (binding === "gap" || binding === "padding")
    return kind === "spacing" || kind === "number";
  if (binding === "width" || binding === "height") return kind === "number";
  if (binding === "radius") return kind === "radius" || kind === "number";
  return ["color", "text", "effect"].includes(binding) && binding === kind;
}

const plain = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const own = (v: object, k: string) => Object.hasOwn(v, k);
const key = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[A-Za-z0-9_-]{1,80}$/.test(v) &&
  !["__proto__", "constructor", "prototype"].includes(v);
const name = (v: unknown) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 200;
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const color = (v: unknown) =>
  typeof v === "string" &&
  /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);
const reference = (v: unknown): v is TokenReference =>
  plain(v) && own(v, "ref");
function fail(): never {
  throw new Error("스타일·토큰·theme 참조 또는 값이 올바르지 않습니다.");
}
const kinds = styleKinds;
export function validShadows(value: unknown): value is Shadow[] {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every(
      (v) =>
        plain(v) &&
        Object.keys(v).every((k) =>
          ["type", "x", "y", "blur", "color"].includes(k),
        ) &&
        v.type === "drop-shadow" &&
        finite(v.x) &&
        Math.abs(v.x) <= 10000 &&
        finite(v.y) &&
        Math.abs(v.y) <= 10000 &&
        finite(v.blur) &&
        v.blur >= 0 &&
        v.blur <= 256 &&
        color(v.color),
    )
  );
}
function validValue(kind: StyleKind, v: unknown): boolean {
  if (["number", "spacing", "radius"].includes(kind))
    return finite(v) && v >= 0 && v <= 1e7;
  if (kind === "color") return color(v);
  if (kind === "effect") return validShadows(v);
  return (
    plain(v) &&
    Object.keys(v).every((k) =>
      [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "lineHeight",
        "letterSpacing",
        "align",
      ].includes(k),
    ) &&
    name(v.fontFamily) &&
    ["fontSize", "fontWeight", "lineHeight"].every(
      (k) => finite(v[k]) && v[k] > 0 && v[k] <= 10000,
    ) &&
    (v.letterSpacing === undefined ||
      (finite(v.letterSpacing) && Math.abs(v.letterSpacing) <= 10000)) &&
    (v.align === undefined || ["left", "center", "right"].includes(v.align))
  );
}
function dictionary(
  value: unknown,
  limit: number,
): asserts value is Record<string, any> {
  if (
    !plain(value) ||
    Object.keys(value).length > limit ||
    !Object.keys(value).every(key)
  )
    fail();
}
/** Resolve every entry, including unused tokens and every theme, before accepting a library. */
export function validateStyleLibrary(
  value: unknown,
): asserts value is StyleLibrary {
  if (
    !plain(value) ||
    Object.keys(value).some(
      (k) => !["tokens", "styles", "themes", "activeTheme"].includes(k),
    )
  )
    fail();
  dictionary(value.tokens, 512);
  dictionary(value.styles, 512);
  dictionary(value.themes, 16);
  for (const entries of [value.tokens, value.styles]) {
    for (const entry of Object.values(entries)) {
      if (
        !plain(entry) ||
        Object.keys(entry).some(
          (k) => !["kind", "name", "value"].includes(k),
        ) ||
        !kinds.includes(entry.kind) ||
        !name(entry.name)
      )
        fail();
    }
  }
  for (const theme of Object.values(value.themes)) {
    if (
      !plain(theme) ||
      Object.keys(theme).some((k) => !["name", "values"].includes(k)) ||
      !name(theme.name)
    )
      fail();
    dictionary(theme.values, 512);
    for (const id of Object.keys(theme.values))
      if (!own(value.tokens, id)) fail();
  }
  if (
    value.activeTheme !== undefined &&
    (!key(value.activeTheme) || !own(value.themes, value.activeTheme))
  )
    fail();
  const library = value as StyleLibrary;
  for (const theme of [undefined, ...Object.keys(library.themes)])
    resolvedEntries(library, theme);
}
function resolvedEntries(library: StyleLibrary, theme?: string) {
  const cache = new Map<string, StyleValue>();
  const visiting = new Set<string>();
  const overrides =
    theme === undefined ? undefined : library.themes[theme].values;
  function value(kind: StyleKind, input: unknown, depth: number): StyleValue {
    if (reference(input)) {
      if (
        Object.keys(input).length !== 1 ||
        !key(input.ref) ||
        !own(library.tokens, input.ref) ||
        library.tokens[input.ref].kind !== kind
      )
        fail();
      return token(input.ref, depth + 1);
    }
    if (!validValue(kind, input)) fail();
    return input as StyleValue;
  }
  function token(id: string, depth: number): StyleValue {
    if (visiting.has(id)) fail();
    if (cache.has(id)) return cache.get(id)!;
    visiting.add(id);
    const entry = library.tokens[id];
    const result = value(
      entry.kind,
      overrides && own(overrides, id) ? overrides[id] : entry.value,
      depth,
    );
    visiting.delete(id);
    cache.set(id, result);
    return result;
  }
  for (const id of Object.keys(library.tokens)) token(id, 0);
  const styles: Record<string, StyleValue> = Object.create(null);
  for (const [id, entry] of Object.entries(library.styles))
    styles[id] = value(entry.kind, entry.value, 0);
  return styles;
}
/** Called at the authoring validator; no derived values are written into history. */
export function validateDocumentStyles(doc: SceneDocument) {
  if (doc.styleLibrary !== undefined) validateStyleLibrary(doc.styleLibrary);
  function refs(value: unknown) {
    if (
      !plain(value) ||
      Object.keys(value).some((k) => !styleBindings.includes(k as StyleBinding))
    )
      fail();
    for (const [kind, id] of Object.entries(value)) {
      if (
        !key(id) ||
        !doc.styleLibrary ||
        !own(doc.styleLibrary.styles, id) ||
        !compatibleStyleBinding(kind, doc.styleLibrary.styles[id].kind)
      )
        fail();
    }
  }
  for (const node of Object.values(doc.nodes)) {
    if (node.component?.kind === "instance") {
      const paths = [
        ...Object.values(node.component.overrides),
        ...Object.values(node.component.variantOverrides ?? {}).map(
          (entry) => entry.paths,
        ),
      ];
      for (const entry of paths)
        for (const [path, value] of Object.entries(entry)) {
          if (value === null) continue;
          if (path === "styleRefs") refs(value);
          else if (path.startsWith("styleRefs."))
            refs({ [path.slice(10)]: value });
          else if (path === "effects" && !validShadows(value)) fail();
        }
    }
    if (node.effects !== undefined && !validShadows(node.effects)) fail();
    if (node.styleRefs === undefined) continue;
    if (
      !plain(node.styleRefs) ||
      Object.keys(node.styleRefs).some(
        (k) => !styleBindings.includes(k as StyleBinding),
      )
    )
      fail();
    for (const [kind, id] of Object.entries(node.styleRefs)) {
      if (
        !key(id) ||
        !doc.styleLibrary ||
        !own(doc.styleLibrary.styles, id) ||
        !compatibleStyleBinding(kind, doc.styleLibrary.styles[id].kind) ||
        (kind === "text" && !node.text)
      )
        fail();
    }
  }
}
/** Pure derived scene; content, sizing, geometry and authored fallback values stay local. */
export function resolveDocumentStyles(doc: SceneDocument): SceneDocument {
  if (!doc.styleLibrary) return doc;
  const styles = resolvedEntries(
    doc.styleLibrary,
    doc.styleLibrary.activeTheme,
  );
  const next = structuredClone(doc);
  for (const node of Object.values(next.nodes)) {
    for (const [kind, id] of Object.entries(node.styleRefs ?? {})) {
      const value = structuredClone(styles[id]);
      if (kind === "color") {
        node.fill = { type: "solid", color: value as string };
        node.fills = [node.fill];
      } else if (kind === "text" && node.text) {
        // Replace optional typography too: absent tracking/alignment means default.
        node.text = {
          content: node.text.content,
          sizing: node.text.sizing,
          ...(value as TextStyle),
        };
      } else if (kind === "effect") node.effects = value as Shadow[];
      else if (kind === "gap") node.layout.gap = value as number;
      else if (kind === "padding")
        node.layout.padding = [value, value, value, value] as [
          number,
          number,
          number,
          number,
        ];
      else if (kind === "width" || kind === "height" || kind === "radius")
        node[kind] = value as number;
    }
  }
  return next;
}
export function setStyleLibrary(
  doc: SceneDocument,
  library: StyleLibrary,
): SceneDocument {
  const next = { ...doc, styleLibrary: structuredClone(library) };
  validateDocument(next);
  // Dictionary order is not authoring meaning. An absent library and an empty
  // library are equivalent, so applying the initial editor is also a no-op.
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (plain(value))
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(",")}}`;
    return JSON.stringify(value);
  };
  if (
    canonical(doc.styleLibrary ?? { tokens: {}, styles: {}, themes: {} }) ===
    canonical(library)
  )
    return doc;
  return next;
}
export function switchTheme(doc: SceneDocument, theme?: string): SceneDocument {
  if (!doc.styleLibrary) fail();
  const library = structuredClone(doc.styleLibrary);
  if (theme === undefined) delete library.activeTheme;
  else library.activeTheme = theme;
  return setStyleLibrary(doc, library);
}
/** Removing a binding freezes its current resolved value, rather than reverting to an old fallback. */
export function bindStyle(
  doc: SceneDocument,
  id: string,
  kind: StyleBinding,
  style?: string,
): SceneDocument {
  if (!own(doc.nodes, id) || !styleBindings.includes(kind)) fail();
  if ((doc.nodes[id].styleRefs?.[kind] ?? undefined) === (style || undefined))
    return doc;
  const next = structuredClone(doc);
  if (!style) {
    const resolved = resolveDocumentStyles(doc).nodes[id],
      node = next.nodes[id];
    if (kind === "color") {
      node.fill = structuredClone(resolved.fill);
      node.fills = structuredClone(resolved.fills);
    }
    if (kind === "text") node.text = structuredClone(resolved.text);
    if (kind === "effect") node.effects = structuredClone(resolved.effects);
    if (kind === "gap") node.layout.gap = resolved.layout.gap;
    if (kind === "padding")
      node.layout.padding = structuredClone(resolved.layout.padding);
    if (kind === "width" || kind === "height" || kind === "radius")
      node[kind] = resolved[kind];
    if (node.styleRefs) {
      delete node.styleRefs[kind];
      if (!Object.keys(node.styleRefs).length) delete node.styleRefs;
    }
  } else
    next.nodes[id].styleRefs = { ...next.nodes[id].styleRefs, [kind]: style };
  validateDocument(next);
  return next;
}
