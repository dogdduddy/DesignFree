import type {
  StyleLibrary,
  StyleEntry,
  StyleValue,
  TextStyle,
  Shadow,
} from "./style-library";
import { cssFont } from "./text-layout";

// Validated ASCII IDs are safe CSS identifier suffixes. Keep token/style namespaces separate.
export const styleVariable = (
  kind: "token" | "style",
  id: string,
  property?: string,
) => `--dr-${kind}-${id.length}-${id}${property ? `--${property}` : ""}`;
const textProperties = [
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
];
const shadows = (value: Shadow[]) =>
  value.length
    ? value
        .map((e) => `drop-shadow(${e.x}px ${e.y}px ${e.blur}px ${e.color})`)
        .join(" ")
    : "none";

/** Emit all base values in every theme scope so aliases resolve in that scope. */
export function webStyleVariables(
  library: StyleLibrary,
  theme?: string,
): string {
  const declarations: string[] = [];
  const entry = (
    namespace: "token" | "style",
    id: string,
    definition: StyleEntry,
    value: StyleValue | { ref: string },
  ) => {
    const properties =
      definition.kind === "text" ? textProperties : [undefined];
    for (const property of properties) {
      let css: string;
      if (typeof value === "object" && !Array.isArray(value) && "ref" in value)
        css = `var(${styleVariable("token", value.ref, property)})`;
      else if (definition.kind === "color") css = value as string;
      else if (definition.kind === "effect") css = shadows(value as Shadow[]);
      else {
        const t = value as TextStyle;
        css = {
          "font-family": cssFont(t.fontFamily),
          "font-size": `${t.fontSize}px`,
          "font-weight": String(t.fontWeight),
          "line-height": `${t.lineHeight}px`,
          "letter-spacing": `${t.letterSpacing ?? 0}px`,
          "text-align": t.align ?? "left",
        }[property!]!;
      }
      declarations.push(`${styleVariable(namespace, id, property)}:${css}`);
    }
  };
  for (const [id, definition] of Object.entries(library.tokens))
    entry(
      "token",
      id,
      definition,
      theme && Object.hasOwn(library.themes[theme].values, id)
        ? library.themes[theme].values[id]
        : definition.value,
    );
  for (const [id, definition] of Object.entries(library.styles))
    entry("style", id, definition, definition.value);
  return declarations.join(";");
}
