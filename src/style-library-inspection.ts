import type { SceneDocument } from "./core";
import {
  validateStyleLibrary,
  type StyleKind,
  type StyleValue,
} from "./style-library";

export type StyleDiagnostic = { path: string; message: string };
export type StyleLink = {
  nodeId: string;
  nodeName: string;
  path: string;
  source: "layer" | "override" | "variantOverride";
  sourceNodeId?: string;
  variantId?: string;
};
export type StyleChain = {
  theme?: string;
  paths: string[];
  tokenIds: string[];
  value?: StyleValue;
  error?: string;
};
export type StyleRelationship = {
  id: string;
  name: string;
  kind: StyleKind;
  chains: StyleChain[];
  linkedLayers: StyleLink[];
};
const plain = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const own = (v: object, key: string) => Object.hasOwn(v, key);
const kinds = ["color", "text", "effect"];
const validKey = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[A-Za-z0-9_-]{1,80}$/.test(v) &&
  !["__proto__", "constructor", "prototype"].includes(v);
const validName = (v: unknown) =>
  typeof v === "string" && !!v.trim() && v.length <= 200;
const entries = (v: unknown): [string, any][] =>
  plain(v) ? Object.entries(v) : [];
function validLiteral(kind: unknown, value: unknown): boolean {
  try {
    validateStyleLibrary({
      tokens: {},
      styles: { probe: { kind, name: "Probe", value } },
      themes: {},
    });
    return true;
  } catch {
    return false;
  }
}

/** Inspect authored bindings too: inactive component overrides still prevent deletion. */
function bindings(
  doc: SceneDocument,
): (StyleLink & { kind: string; styleId: unknown })[] {
  const result: (StyleLink & { kind: string; styleId: unknown })[] = [];
  for (const node of Object.values(doc.nodes)) {
    const collect = (
      refs: unknown,
      path: string,
      link: Omit<StyleLink, "path">,
    ) => {
      for (const [kind, styleId] of entries(refs))
        result.push({ ...link, path: `${path}.${kind}`, kind, styleId });
    };
    const link = {
      nodeId: node.id,
      nodeName: node.name,
      source: "layer" as const,
    };
    collect(node.styleRefs, `nodes.${node.id}.styleRefs`, link);
    if (node.component?.kind !== "instance") continue;
    const component = node.component;
    const collectPaths = (
      paths: Record<string, unknown>,
      prefix: string,
      details: Omit<StyleLink, "path">,
    ) => {
      for (const [path, value] of Object.entries(paths)) {
        if (value === null) continue;
        if (path === "styleRefs")
          collect(value, `${prefix}.styleRefs`, details);
        else if (path.startsWith("styleRefs.")) {
          result.push({
            ...details,
            path: `${prefix}.${path}`,
            kind: path.slice(10),
            styleId: value,
          });
        }
      }
    };
    for (const [sourceNodeId, paths] of Object.entries(component.overrides)) {
      const nodeId = component.nodeMap[sourceNodeId] ?? node.id;
      collectPaths(
        paths,
        `nodes.${node.id}.component.overrides.${sourceNodeId}`,
        {
          nodeId,
          nodeName: doc.nodes[nodeId]?.name ?? node.name,
          source: "override",
          sourceNodeId,
        },
      );
    }
    for (const [variantId, override] of Object.entries(
      component.variantOverrides ?? {},
    )) {
      collectPaths(
        override.paths,
        `nodes.${node.id}.component.variantOverrides.${variantId}.paths`,
        {
          nodeId: node.id,
          nodeName: node.name,
          source: "variantOverride",
          variantId,
        },
      );
    }
  }
  return result;
}

function trace(
  library: any,
  category: "tokens" | "styles",
  id: string,
  theme?: string,
): StyleChain {
  const chain: StyleChain = { theme, paths: [], tokenIds: [] };
  const seen = new Set<string>();
  let entry = library[category]?.[id];
  let path = `${category}.${id}.value`;
  let input = entry?.value;
  if (!plain(entry) || !kinds.includes(entry.kind)) {
    chain.paths.push(path);
    chain.error = "스타일 항목 또는 종류가 올바르지 않습니다.";
    return chain;
  }
  const token = (tokenId: string): boolean => {
    if (seen.has(tokenId)) {
      chain.error = `순환 참조: ${[...chain.tokenIds, tokenId].join(" → ")}`;
      return false;
    }
    seen.add(tokenId);
    chain.tokenIds.push(tokenId);
    entry = library.tokens?.[tokenId];
    if (!plain(entry)) {
      chain.error = `없는 토큰: ${tokenId}`;
      return false;
    }
    const overrides = library.themes?.[theme ?? ""]?.values;
    const overridden =
      theme !== undefined && plain(overrides) && own(overrides, tokenId);
    path = overridden
      ? `themes.${theme}.values.${tokenId}`
      : `tokens.${tokenId}.value`;
    input = overridden ? overrides[tokenId] : entry.value;
    return true;
  };
  const kind = entry?.kind;
  if (category === "tokens" && !token(id)) return chain;
  while (true) {
    chain.paths.push(path);
    if (!plain(input) || !own(input, "ref")) {
      if (validLiteral(kind, input))
        chain.value = structuredClone(input) as StyleValue;
      else chain.error = "스타일 값이 올바르지 않습니다.";
      return chain;
    }
    if (Object.keys(input).length !== 1) {
      chain.error = "참조에는 ref만 허용됩니다.";
      return chain;
    }
    const target = input.ref;
    if (
      !validKey(target) ||
      !plain(library.tokens) ||
      !own(library.tokens, target)
    ) {
      chain.error = `없는 토큰 참조: ${typeof target === "string" ? target : "잘못된 ID"}`;
      return chain;
    }
    if (library.tokens[target]?.kind !== kind) {
      chain.error = "토큰 종류가 일치하지 않습니다.";
      return chain;
    }
    if (!token(target)) return chain;
  }
}

/** Display helpers tolerate incomplete drafts; validation remains validateStyleLibrary's job. */
export function inspectStyleRelationships(
  doc: SceneDocument,
  library: unknown = doc.styleLibrary,
): {
  tokens: StyleRelationship[];
  styles: StyleRelationship[];
} {
  if (!plain(library)) return { tokens: [], styles: [] };
  const links = bindings(doc);
  const themes = [
    undefined,
    ...Object.keys(plain(library.themes) ? library.themes : {}),
  ];
  const styles = entries(library.styles).map(([id, entry]) => ({
    id,
    name: typeof entry?.name === "string" ? entry.name : id,
    kind: entry?.kind as StyleKind,
    chains: themes.map((theme) => trace(library, "styles", id, theme)),
    linkedLayers: links
      .filter((link) => link.styleId === id)
      .map(({ kind: _kind, styleId: _styleId, ...link }) => link),
  }));
  const tokens = entries(library.tokens).map(([id, entry]) => ({
    id,
    name: typeof entry?.name === "string" ? entry.name : id,
    kind: entry?.kind as StyleKind,
    chains: themes.map((theme) => trace(library, "tokens", id, theme)),
    linkedLayers: styles
      .filter((style) =>
        style.chains.some((chain) => chain.tokenIds.includes(id)),
      )
      .flatMap((style) => style.linkedLayers)
      .filter(
        (link, index, all) =>
          all.findIndex((other) => other.path === link.path) === index,
      ),
  }));
  return { tokens, styles };
}

/** Field-level explanations supplement, and never replace, the authoritative validator. */
export function diagnoseStyleLibrary(
  input: unknown,
  doc?: SceneDocument,
): StyleDiagnostic[] {
  let valid = false;
  try {
    validateStyleLibrary(input);
    valid = true;
  } catch {
    /* Attribute failures below. */
  }
  const diagnostics: StyleDiagnostic[] = [];
  const add = (path: string, message: string) => {
    if (!diagnostics.some((d) => d.path === path && d.message === message))
      diagnostics.push({ path, message });
  };
  if (!valid) {
    if (!plain(input)) add("$", "스타일 라이브러리는 객체여야 합니다.");
    else {
      for (const key of Object.keys(input))
        if (!["tokens", "styles", "themes", "activeTheme"].includes(key))
          add(key, "지원하지 않는 필드입니다.");
      for (const [category, limit] of [
        ["tokens", 512],
        ["styles", 512],
        ["themes", 16],
      ] as const) {
        if (!plain(input[category])) {
          add(category, "객체가 필요합니다.");
          continue;
        }
        if (Object.keys(input[category]).length > limit)
          add(category, `최대 ${limit}개까지 지원합니다.`);
        for (const [id, entry] of entries(input[category])) {
          const path = `${category}.${id}`;
          if (!validKey(id)) add(path, "ID 형식이 올바르지 않습니다.");
          if (!plain(entry)) {
            add(path, "객체가 필요합니다.");
            continue;
          }
          const fields =
            category === "themes"
              ? ["name", "values"]
              : ["kind", "name", "value"];
          for (const field of Object.keys(entry))
            if (!fields.includes(field))
              add(`${path}.${field}`, "지원하지 않는 필드입니다.");
          if (!validName(entry.name))
            add(
              `${path}.name`,
              "이름은 1–200자의 비어 있지 않은 문자열이어야 합니다.",
            );
          if (category !== "themes" && !kinds.includes(entry.kind))
            add(`${path}.kind`, "색·텍스트·효과 종류가 필요합니다.");
          if (category === "themes") {
            if (!plain(entry.values))
              add(`${path}.values`, "객체가 필요합니다.");
            if (entries(entry.values).length > 512)
              add(`${path}.values`, "최대 512개까지 지원합니다.");
            for (const [tokenId] of entries(entry.values)) {
              if (
                !validKey(tokenId) ||
                !plain(input.tokens) ||
                !own(input.tokens, tokenId)
              )
                add(
                  `${path}.values.${tokenId}`,
                  "존재하는 토큰 ID가 필요합니다.",
                );
            }
          }
        }
      }
      if (
        input.activeTheme !== undefined &&
        (!validKey(input.activeTheme) ||
          !plain(input.themes) ||
          !own(input.themes, input.activeTheme))
      )
        add("activeTheme", "존재하는 theme ID가 필요합니다.");
      const checkValue = (kind: unknown, value: unknown, path: string) => {
        if (!kinds.includes(kind as string)) return;
        if (plain(value) && own(value, "ref")) {
          for (const field of Object.keys(value))
            if (field !== "ref")
              add(`${path}.${field}`, "참조에는 ref만 허용됩니다.");
          if (
            !validKey(value.ref) ||
            !plain(input.tokens) ||
            !own(input.tokens, value.ref)
          )
            add(`${path}.ref`, "존재하는 토큰 ID가 필요합니다.");
          else if (input.tokens[value.ref]?.kind !== kind)
            add(`${path}.ref`, "토큰 종류가 일치하지 않습니다.");
          return;
        }
        if (validLiteral(kind, value)) return;
        // Substitute each authored field into a known-valid value. The validator
        // decides field validity, so attribution cannot drift into a second policy.
        const before = diagnostics.length;
        const probeFields = (
          value: Record<string, unknown>,
          baseline: Record<string, unknown>,
          at: string,
          wrap: (v: Record<string, unknown>) => unknown,
        ) => {
          for (const field of new Set([
            ...Object.keys(baseline),
            ...Object.keys(value),
          ])) {
            if (
              !validLiteral(kind, wrap({ ...baseline, [field]: value[field] }))
            )
              add(`${at}.${field}`, `${field} 값이 올바르지 않습니다.`);
          }
        };
        if (kind === "text" && plain(value)) {
          probeFields(
            value,
            {
              fontFamily: "sans-serif",
              fontSize: 16,
              fontWeight: 400,
              lineHeight: 20,
            },
            path,
            (v) => v,
          );
        } else if (kind === "effect" && Array.isArray(value)) {
          if (value.length > 8) add(path, "효과는 최대 8개까지 지원합니다.");
          value.forEach((shadow, index) => {
            const at = `${path}[${index}]`;
            if (!plain(shadow)) add(at, "효과 객체가 필요합니다.");
            else
              probeFields(
                shadow,
                { type: "drop-shadow", x: 0, y: 0, blur: 0, color: "#000000" },
                at,
                (v) => [v],
              );
          });
        }
        if (diagnostics.length === before)
          add(path, `${kind} 값이 올바르지 않습니다.`);
      };
      for (const category of ["tokens", "styles"] as const)
        for (const [id, entry] of entries(input[category])) {
          if (plain(entry))
            checkValue(entry.kind, entry.value, `${category}.${id}.value`);
        }
      for (const [themeId, theme] of entries(input.themes))
        for (const [id, value] of entries(theme?.values)) {
          checkValue(
            input.tokens?.[id]?.kind,
            value,
            `themes.${themeId}.values.${id}`,
          );
        }
      // Resolve all contexts, including unused tokens and inactive themes. Report the edge
      // that closes a cycle, retaining its authored theme/default path.
      for (const theme of [
        undefined,
        ...entries(input.themes).map(([id]) => id),
      ]) {
        for (const [id] of entries(input.tokens)) {
          const chain = trace(input, "tokens", id, theme);
          if (chain.error?.startsWith("순환"))
            add(
              `${chain.paths.at(-1)}.ref`,
              `${theme === undefined ? "기본 값" : `theme ${theme}`}: ${chain.error}`,
            );
        }
      }
      if (!diagnostics.length)
        add("$", "스타일·토큰·theme 참조 또는 값이 올바르지 않습니다.");
    }
  }
  if (doc) {
    const styles = plain(input) && plain(input.styles) ? input.styles : {};
    for (const link of bindings(doc)) {
      if (!validKey(link.styleId) || !own(styles, link.styleId))
        add(link.path, "연결된 스타일이 없습니다.");
      else if (styles[link.styleId]?.kind !== link.kind)
        add(link.path, "연결된 스타일 종류가 일치하지 않습니다.");
      else if (
        link.source === "layer" &&
        link.kind === "text" &&
        !doc.nodes[link.nodeId]?.text
      )
        add(link.path, "텍스트 레이어에만 텍스트 스타일을 연결할 수 있습니다.");
    }
  }
  return diagnostics;
}
