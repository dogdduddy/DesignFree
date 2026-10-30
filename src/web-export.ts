import fontLicense from "../public/fonts/OFL.txt?raw";
import { validateDocument, type SceneDocument } from "./core";
import { computeLayout } from "./flex-layout";
import { webLayout } from "./web-layout";
import { nodeFills } from "./paints";
import { cssFont, missingFont, textLayout } from "./text-layout";
import { webStyleVariables, styleVariable } from "./web-style-variables";

const html = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const px = (value: number) => `${value}px`;
const color = (hex: string, opacity = 1) => {
  let value = hex.slice(1);
  if (value.length <= 4) value = [...value].map((c) => c + c).join("");
  return `rgba(${parseInt(value.slice(0, 2), 16)},${parseInt(value.slice(2, 4), 16)},${parseInt(value.slice(4, 6), 16)},${(value.length === 8 ? parseInt(value.slice(6, 8), 16) / 255 : 1) * opacity})`;
};
export type WebExport = {
  html: string;
  css: string;
  warnings: string[];
  width: number;
  height: number;
};
/** Semantic layout where supported; never changes authoring or executes imported markup. */
function exportFrameSnapshot(
  source: SceneDocument,
  frameId: string,
  fontDataUrl?: string,
  prefix = "dr",
  fontAvailable = !!fontDataUrl,
): WebExport & { markup: string; templates: string } {
  validateDocument(source);
  if (
    !Object.hasOwn(source.nodes, frameId) ||
    source.nodes[frameId].type !== "frame"
  )
    throw new Error("미리보기할 frame 하나를 선택하세요.");
  if (
    fontDataUrl &&
    !/^data:font\/ttf;base64,[A-Za-z0-9+/=]+$/.test(fontDataUrl)
  )
    throw new Error("Invalid embedded font");
  const doc = computeLayout(source),
    frame = doc.nodes[frameId];
  const warnings = new Set<string>([
    "반응형 Flex/Grid: 지원 frame은 viewport 폭을 사용합니다. absolute 요소는 고정 좌표를 유지합니다. 경고된 intrinsic 규칙은 고정 스냅샷입니다.",
  ]);
  // Analyze only the visible exported subtree; unrelated pages must not add warnings.
  const nodes: SceneDocument["nodes"] = {};
  const collect = (id: string) => {
    const node = doc.nodes[id];
    if (!node.visible) return;
    nodes[id] = {
      ...node,
      children: node.children.filter((child) => doc.nodes[child].visible),
    };
    node.children.forEach(collect);
  };
  collect(frameId);
  const layout = webLayout({ ...doc, nodes }, warnings);
  const rules = [
    ...(fontDataUrl ? [`/* ${fontLicense.replaceAll("*/", "* / ")} */`] : []),
    "html,body{margin:0;padding:0} .dr-node{position:absolute;left:0;top:0;box-sizing:border-box;transform-origin:0 0} .dr-line{position:absolute;white-space:pre;line-height:1}",
  ];
  if (fontDataUrl)
    rules.push(
      `@font-face{font-family:'Noto Sans KR';src:url(${fontDataUrl}) format('truetype');font-weight:100 900;font-display:block}`,
    );
  let serial = 0;
  const shared = new Map<string, string>();
  const templates: string[] = [];
  const componentClasses = new Map<string, string>();
  for (const node of Object.values(doc.nodes)) {
    const c = node.component;
    if (c) {
      const sourceId = c.kind === "main" ? node.id : c.sourceId;
      if (!componentClasses.has(sourceId))
        componentClasses.set(
          sourceId,
          `${prefix}-component-${componentClasses.size}`,
        );
    }
  }
  function visit(id: string, root = false): string {
    const node = doc.nodes[id];
    if (!node.visible) return "";
    const key = `${prefix}-${serial++}`,
      style = [
        `width:${px(node.width)}`,
        `height:${px(node.height)}`,
        `opacity:${node.opacity}`,
      ];
    if (node.effects?.length)
      style.push(
        `filter:${node.effects.map((e) => `drop-shadow(${px(e.x)} ${px(e.y)} ${px(e.blur)} ${color(e.color)})`).join(" ")}`,
      );
    if (root) style.push("position:relative");
    else style.push(`transform:matrix(${node.transform.join(",")})`);
    style.push(...layout.styles(node, root));
    if (node.layout.width === "hug" || node.layout.height === "hug")
      warnings.add(
        `${node.name}: hug 크기는 내보내기 시점의 계산값으로 고정합니다.`,
      );
    if (node.clipContent) style.push("overflow:hidden");
    if (node.type !== "group" || node.clipContent)
      style.push(
        `border-radius:${node.type === "ellipse" ? "50%" : px(node.radius)}`,
      );
    const fills =
      node.type === "group"
        ? []
        : nodeFills(node).filter((p) => p.type !== "none");
    if (fills.some((p) => p.type !== "solid"))
      warnings.add(`${node.name}: gradient 채우기는 생략됩니다.`);
    const solids = fills.filter((p) => p.type === "solid");
    if (node.stroke?.width) warnings.add(`${node.name}: stroke는 생략됩니다.`);
    let content = "";
    if (node.type === "text" && node.text) {
      const t = node.text,
        top = solids.at(-1);
      if (solids.length > 1)
        warnings.add(`${node.name}: text는 맨 위 solid 채우기만 사용합니다.`);
      if (missingFont(t.fontFamily))
        warnings.add(`${node.name}: 누락 폰트를 Noto Sans KR로 대체합니다.`);
      if (!fontAvailable && cssFont(t.fontFamily).includes("Noto Sans"))
        warnings.add("Noto Sans KR 미포함: 시스템 폰트로 대체될 수 있습니다.");
      style.push(
        `color:${top ? color(top.color, top.opacity) : "transparent"}`,
        `font-family:${cssFont(t.fontFamily)}`,
        `font-size:${px(t.fontSize)}`,
        `font-weight:${t.fontWeight}`,
        `letter-spacing:${px(t.letterSpacing ?? 0)}`,
      );
      content = textLayout(node)
        .lines.map((line, i) => {
          const lineKey = `${key}-line-${i}`;
          // DOM line boxes use browser font metrics; baseline parity is not guaranteed.
          rules.push(
            `.${lineKey}{left:${px(line.x)};top:${px(i * t.lineHeight)}}`,
          );
          return `<span class="dr-line ${lineKey}">${html(line.content)}</span>`;
        })
        .join("");
      warnings.add(
        "텍스트는 계산된 줄바꿈·줄 위치를 고정합니다. 폭 변경에 따른 재줄바꿈과 DOM 폰트 baseline·glyph raster의 editor pixel 동등성은 지원하지 않습니다.",
      );
    } else if (solids.length) {
      style.push(
        `background-image:${[...solids]
          .reverse()
          .map((p) => {
            const c = color(p.color, p.opacity);
            return `linear-gradient(${c},${c})`;
          })
          .join(",")}`,
      );
    }
    if (node.type === "image") {
      const asset = node.assetId ? doc.assets[node.assetId] : undefined;
      if (
        !asset ||
        asset.missing ||
        !/^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/.test(asset.dataUrl)
      )
        throw new Error(`누락되거나 잘못된 PNG: ${node.name}`);
      content += `<img alt="${html(node.name)}" src="${asset.dataUrl}" style="display:block;width:100%;height:100%;object-fit:fill;border-radius:inherit">`;
    }
    const refs = node.styleRefs;
    const appearance: string[] = [];
    if (refs?.color && node.type !== "group") {
      const value = `var(${styleVariable("style", refs.color)})`;
      appearance.push(
        node.type === "text"
          ? `color:${value}`
          : `background-image:linear-gradient(${value},${value})`,
      );
    }
    if (refs?.effect)
      appearance.push(`filter:var(${styleVariable("style", refs.effect)})`);
    if (refs?.text && node.text) {
      for (const property of [
        "font-family",
        "font-size",
        "font-weight",
        "letter-spacing",
      ])
        appearance.push(
          `${property}:var(${styleVariable("style", refs.text, property)})`,
        );
    }
    // Placement remains local; identical appearances share a reusable class.
    const properties =
      /^(color|background-image|filter|font-family|font-size|font-weight|letter-spacing|border-radius|opacity):/;
    const local = style.filter((s) => !properties.test(s));
    const paint = [
      ...style.filter((s) => properties.test(s)),
      ...appearance,
    ].join(";");
    let sharedClass = shared.get(paint);
    if (!sharedClass) {
      sharedClass = `${prefix}-appearance-${shared.size}`;
      shared.set(paint, sharedClass);
      rules.push(`.${sharedClass}{${paint}}`);
    }
    rules.push(`.${key}{${local.join(";")}}`);
    const component = node.component;
    const componentClass = component
      ? componentClasses.get(
          component.kind === "main" ? node.id : component.sourceId,
        )
      : undefined;
    const markup = `<div class="dr-node ${key} ${sharedClass}${componentClass ? ` ${componentClass}` : ""}" data-node-id="${html(id)}"${componentClass ? ` data-dr-component="${componentClass}"` : ""} aria-label="${html(node.name)}">${content}${node.children.map((child) => visit(child)).join("")}</div>`;
    if (componentClass)
      templates.push(
        `<template id="${key}-template" data-dr-component="${componentClass}">${markup}</template>`,
      );
    return markup;
  }
  const markup = visit(frameId, true),
    css = rules.join("\n");
  const policy =
    "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  const result = `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(frame.name)}</title><style>${css}</style></head><body>${markup}${fontDataUrl ? `<pre hidden>${html(fontLicense)}</pre>` : ""}</body></html>`;
  return {
    markup,
    templates: templates.join("\n"),
    html: result,
    css,
    warnings: [...warnings],
    width: frame.width,
    height: frame.height,
  };
}
/** Standalone theme sets include separately computed text/layout snapshots.
 * Switching the html data-dr-theme attribute needs no script or editor runtime.
 */
export function exportFrameWeb(
  source: SceneDocument,
  frameId: string,
  fontDataUrl?: string,
): WebExport {
  validateDocument(source);
  const library = source.styleLibrary;
  if (!library) {
    const result = exportFrameSnapshot(source, frameId, fontDataUrl);
    return {
      ...result,
      html: result.html.replace("</body>", `${result.templates}</body>`),
    };
  }
  const active = library.activeTheme ?? "";
  const themes = [
    active,
    ...["", ...Object.keys(library.themes)].filter((id) => id !== active),
  ];
  const warnings = new Set<string>();
  const sheets: string[] = [];
  const markup: string[] = [];
  let first: ReturnType<typeof exportFrameSnapshot> | undefined;
  themes.forEach((theme, i) => {
    const scene = structuredClone(source);
    if (theme) scene.styleLibrary!.activeTheme = theme;
    else delete scene.styleLibrary!.activeTheme;
    const snapshot = exportFrameSnapshot(
      scene,
      frameId,
      i === 0 ? fontDataUrl : undefined,
      `dr-t${i}`,
      !!fontDataUrl,
    );
    first ??= snapshot;
    snapshot.warnings.forEach((warning) => warnings.add(warning));
    const scope = `.dr-theme-${i}`;
    sheets.push(
      `${scope}{display:none;${webStyleVariables(library, theme || undefined)}}`,
    );
    sheets.push(`html[data-dr-theme="${theme}"] ${scope}{display:block}`);
    sheets.push(snapshot.css);
    markup.push(
      `<section class="${scope.slice(1)}" data-dr-theme-set="${theme}">${snapshot.markup}${snapshot.templates}</section>`,
    );
  });
  warnings.add(
    "테마 전환: html의 data-dr-theme을 빈 문자열(기본) 또는 theme ID로 설정하세요. 각 테마의 텍스트·geometry는 별도 스냅샷이며 변수 수동 수정 시 재계산되지 않습니다. 컴포넌트 template은 해당 테마 안에서 복제하는 정적 마크업입니다.",
  );
  const css = sheets.join("\n");
  const result = first!;
  return {
    html: result.html
      .replace('<html lang="ko">', `<html lang="ko" data-dr-theme="${active}">`)
      .replace(/<style>[\s\S]*?<\/style>/, () => `<style>${css}</style>`)
      .replace(
        /<body>[\s\S]*?<\/body>/,
        () => `<body>${markup.join("\n")}</body>`,
      ),
    css,
    warnings: [...warnings],
    width: result.width,
    height: result.height,
  };
}
export async function embeddedWebFont(): Promise<string> {
  const response = await fetch("/fonts/NotoSansKR.ttf");
  if (!response.ok) throw new Error("미리보기 폰트를 읽을 수 없습니다.");
  const blob = new Blob([await response.arrayBuffer()], { type: "font/ttf" });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("미리보기 폰트 변환 실패"));
    reader.readAsDataURL(blob);
  });
}

/** Browser decode gate for the visible exported subtree, before exposing download actions. */
export async function prepareFrameWeb(
  source: SceneDocument,
  frameId: string,
  fontDataUrl: string,
): Promise<WebExport> {
  const result = exportFrameWeb(source, frameId, fontDataUrl);
  const images = new Set<string>();
  const visit = (id: string) => {
    const node = source.nodes[id];
    if (!node.visible) return;
    if (node.type === "image" && node.assetId)
      images.add(source.assets[node.assetId].dataUrl);
    node.children.forEach(visit);
  };
  visit(frameId);
  for (const data of images) {
    const image = new Image();
    image.src = data;
    try {
      await image.decode();
    } catch {
      throw new Error("PNG 이미지를 디코딩할 수 없습니다.");
    }
  }
  return result;
}
