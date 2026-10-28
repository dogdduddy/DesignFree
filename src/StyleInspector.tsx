import { useState } from "react";
import type { SceneDocument, SceneNode } from "./core";
import {
  bindStyle,
  resolveDocumentStyles,
  setStyleLibrary,
  switchTheme,
  type StyleEntry,
  type StyleKind,
  type StyleLibrary,
} from "./style-library";
const empty = (): StyleLibrary => ({ tokens: {}, styles: {}, themes: {} });
export function StyleInspector({
  document: doc,
  node,
  disabled,
  selectionDisabled,
  onChange,
}: {
  document: SceneDocument;
  node: SceneNode | null;
  disabled: boolean;
  selectionDisabled: boolean;
  onChange: (doc: SceneDocument) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null),
    [error, setError] = useState("");
  const library = doc.styleLibrary ?? empty();
  const run = (fn: () => SceneDocument) => {
    try {
      onChange(fn());
      setDraft(null);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const labels = { color: "색", text: "텍스트", effect: "효과" };
  return (
    <details
      className="inspector-section style-library-inspector"
      data-testid="style-inspector"
    >
      <summary>공통 스타일 · 토큰</summary>
      <label className="property-field">
        Theme
        <select
          aria-label="스타일 theme"
          disabled={disabled || !doc.styleLibrary}
          value={library.activeTheme ?? ""}
          onChange={(e) =>
            run(() => switchTheme(doc, e.target.value || undefined))
          }
        >
          <option value="">기본 값</option>
          {Object.entries(library.themes).map(([id, t]) => (
            <option key={id} value={id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {node &&
        (["color", "text", "effect"] as StyleKind[])
          .filter((kind) => kind !== "text" || node.text)
          .map((kind) => (
            <div key={kind}>
              <label className="property-field">
                {labels[kind]} 스타일
                <select
                  aria-label={`${labels[kind]} 스타일`}
                  disabled={disabled || selectionDisabled}
                  value={node.styleRefs?.[kind] ?? ""}
                  onChange={(e) =>
                    run(() =>
                      bindStyle(
                        doc,
                        node.id,
                        kind,
                        e.target.value || undefined,
                      ),
                    )
                  }
                >
                  <option value="">로컬 값</option>
                  {Object.entries(library.styles)
                    .filter(([, s]) => s.kind === kind)
                    .map(([id, s]) => (
                      <option key={id} value={id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
              <button
                className="subtle-action"
                disabled={disabled || selectionDisabled}
                onClick={() =>
                  run(() => {
                    const resolved = resolveDocumentStyles(doc).nodes[node.id],
                      next = structuredClone(library),
                      id = `style-${crypto.randomUUID()}`;
                    let entry: StyleEntry;
                    if (kind === "color") {
                      const fill = (resolved.fills ?? [resolved.fill]).at(-1);
                      if (fill?.type !== "solid")
                        throw new Error(
                          "색 스타일은 맨 위 solid 채우기를 사용합니다.",
                        );
                      entry = {
                        kind,
                        name: `${node.name} 색`,
                        value: fill.color,
                      };
                    } else if (kind === "text") {
                      const {
                        content: _content,
                        sizing: _sizing,
                        ...text
                      } = resolved.text!;
                      entry = {
                        kind,
                        name: `${node.name} 텍스트`,
                        value: text,
                      };
                    } else
                      entry = {
                        kind,
                        name: `${node.name} 효과`,
                        value: resolved.effects ?? [
                          {
                            type: "drop-shadow",
                            x: 0,
                            y: 4,
                            blur: 4,
                            color: "#00000040",
                          },
                        ],
                      };
                    next.styles[id] = entry;
                    return bindStyle(
                      setStyleLibrary(doc, next),
                      node.id,
                      kind,
                      id,
                    );
                  })
                }
              >
                선택 {labels[kind]} 스타일 저장
              </button>
            </div>
          ))}
      <p className="property-hint">
        색은 단일 solid, 효과는 순차 drop shadow입니다. 스타일이 연결된 속성은
        아래 편집기에서 직접 수정하기 전에 로컬 값으로 전환하세요.
      </p>
      <label className="property-field">
        라이브러리 (JSON)
        <textarea
          className="style-library-json"
          aria-label="스타일 라이브러리 JSON"
          rows={8}
          disabled={disabled}
          value={draft ?? JSON.stringify(library, null, 2)}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <button
        className="subtle-action"
        disabled={disabled}
        onClick={() =>
          run(() =>
            setStyleLibrary(doc, JSON.parse(draft ?? JSON.stringify(library))),
          )
        }
      >
        스타일 라이브러리 적용
      </button>
      <p className="property-hint">
        tokens/styles: kind·name·value. 참조는 {`{"ref":"token-id"}`}, themes:
        name·values(token ID별 값/참조). color/text/effect 타입이 일치해야
        합니다. 참조 중인 항목 삭제는 먼저 연결을 해제하세요.
      </p>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
