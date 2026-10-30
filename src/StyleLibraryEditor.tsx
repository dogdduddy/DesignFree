import { diagnoseStyleLibrary } from "./style-library-inspection";
import { StyleRelationships } from "./StyleRelationships";
import { useEffect, useState } from "react";
import type { SceneDocument } from "./core";
import {
  setStyleLibrary,
  type StyleLibrary,
  type StyleKind,
  type StyleValue,
  type TokenReference,
  type TextStyle,
  type Shadow,
} from "./style-library";

const labels = {
  color: "색",
  text: "텍스트",
  effect: "효과",
  number: "숫자",
  spacing: "간격",
  radius: "모서리",
};
export function defaultStyleValue(kind: StyleKind): StyleValue {
  if (["number", "spacing", "radius"].includes(kind)) return 8;
  if (kind === "color") return "#3366ff";
  if (kind === "text")
    return {
      fontFamily: "Noto Sans KR",
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 24,
    };
  return [{ type: "drop-shadow", x: 0, y: 4, blur: 4, color: "#00000040" }];
}
function ValueEditor({
  kind,
  value,
  library,
  onChange,
}: {
  kind: StyleKind;
  value: StyleValue | TokenReference;
  library: StyleLibrary;
  onChange: (v: StyleValue | TokenReference) => void;
}) {
  const ref =
    typeof value === "object" && !Array.isArray(value) && "ref" in value
      ? value.ref
      : undefined;
  const number = (label: string, v: number, change: (n: number) => void) => (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        value={Number.isFinite(v) ? v : ""}
        onChange={(e) =>
          change(e.target.value === "" ? NaN : Number(e.target.value))
        }
      />
    </label>
  );
  return (
    <div className="style-value-editor">
      <label>
        값 출처
        <select
          aria-label="값 출처"
          value={ref === undefined ? "literal" : "token"}
          onChange={(e) =>
            onChange(
              e.target.value === "literal"
                ? defaultStyleValue(kind)
                : {
                    ref:
                      Object.keys(library.tokens).find(
                        (id) => library.tokens[id].kind === kind,
                      ) ?? "",
                  },
            )
          }
        >
          <option value="literal">직접 값 (연결 해제 시 기본값)</option>
          <option value="token">토큰 참조</option>
        </select>
      </label>
      {ref !== undefined ? (
        <label>
          참조 토큰
          <select
            aria-label="참조 토큰"
            value={ref}
            onChange={(e) => onChange({ ref: e.target.value })}
          >
            <option value="">토큰 선택</option>
            {Object.entries(library.tokens)
              .filter(([, t]) => t.kind === kind)
              .map(([id, t]) => (
                <option key={id} value={id}>
                  {t.name} ({id})
                </option>
              ))}
          </select>
        </label>
      ) : ["number", "spacing", "radius"].includes(kind) ? (
        number(`${labels[kind]} 값`, value as number, onChange)
      ) : kind === "color" ? (
        <label>
          색 값
          <input
            aria-label="색 값"
            value={value as string}
            onChange={(e) => onChange(e.target.value)}
          />
          <input
            aria-label="색 선택"
            type="color"
            value={
              /^#[0-9a-f]{6}$/i.test(value as string)
                ? (value as string)
                : "#3366ff"
            }
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      ) : kind === "text" ? (
        <>
          <label>
            글꼴
            <input
              aria-label="글꼴"
              value={(value as TextStyle).fontFamily}
              onChange={(e) =>
                onChange({
                  ...(value as TextStyle),
                  fontFamily: e.target.value,
                })
              }
            />
          </label>
          {(
            [
              ["글자 크기", "fontSize"],
              ["굵기", "fontWeight"],
              ["행간", "lineHeight"],
              ["자간", "letterSpacing"],
            ] as const
          ).map(([label, key]) => (
            <div key={key}>
              {number(label, (value as TextStyle)[key] ?? 0, (n) =>
                onChange({ ...(value as TextStyle), [key]: n }),
              )}
            </div>
          ))}
          <label>
            정렬
            <select
              aria-label="정렬"
              value={(value as TextStyle).align ?? "left"}
              onChange={(e) =>
                onChange({
                  ...(value as TextStyle),
                  align: e.target.value as TextStyle["align"],
                })
              }
            >
              {["left", "center", "right"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <>
          {(value as Shadow[]).map((shadow, i) => (
            <fieldset key={i}>
              <legend>그림자 {i + 1}</legend>
              {(["x", "y", "blur"] as const).map((key) => (
                <div key={key}>
                  {number(`그림자 ${i + 1} ${key}`, shadow[key], (n) =>
                    onChange(
                      (value as Shadow[]).map((s, j) =>
                        j === i ? { ...s, [key]: n } : s,
                      ),
                    ),
                  )}
                </div>
              ))}
              <label>
                그림자 색
                <input
                  aria-label={`그림자 ${i + 1} 색`}
                  value={shadow.color}
                  onChange={(e) =>
                    onChange(
                      (value as Shadow[]).map((s, j) =>
                        j === i ? { ...s, color: e.target.value } : s,
                      ),
                    )
                  }
                />
              </label>
              <button
                onClick={() =>
                  onChange((value as Shadow[]).filter((_, j) => j !== i))
                }
              >
                그림자 {i + 1} 삭제
              </button>
            </fieldset>
          ))}
          <button
            disabled={(value as Shadow[]).length >= 8}
            onClick={() =>
              onChange([
                ...(value as Shadow[]),
                ...(defaultStyleValue("effect") as Shadow[]),
              ])
            }
          >
            그림자 추가
          </button>
        </>
      )}
    </div>
  );
}

export function StyleLibraryEditor({
  document: doc,
  disabled,
  onChange,
}: {
  document: SceneDocument;
  disabled: boolean;
  onChange: (d: SceneDocument) => void;
}) {
  const [draft, setDraft] = useState<StyleLibrary | null>(null);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<StyleKind>("color");
  useEffect(() => {
    setDraft(null);
    setError("");
  }, [doc]);
  const library = draft ??
    doc.styleLibrary ?? { tokens: {}, styles: {}, themes: {} };
  const diagnostics = draft ? diagnoseStyleLibrary(draft, doc) : [];
  const update = (fn: (next: StyleLibrary) => void) => {
    const next = structuredClone(library);
    fn(next);
    setDraft(next);
    setError("");
  };
  const cancel = () => {
    setDraft(null);
    setError("");
  };
  return (
    <div
      className="style-visual-editor"
      data-testid="style-visual-editor"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
    >
      <StyleRelationships document={doc} library={library} />
      {!draft ? (
        <button
          disabled={disabled}
          onClick={() => setDraft(structuredClone(library))}
        >
          스타일·토큰·테마 편집
        </button>
      ) : (
        <fieldset disabled={disabled}>
          <legend>스타일 · 토큰 · 테마 초안</legend>
          <p className="property-hint">
            적용 전 장면·선택은 유지됩니다. 취소/Escape는 저장하지 않습니다.
            삭제는 참조 해제 후 가능합니다. 토큰 참조 해제는 타입 기본값으로
            시작합니다.
          </p>
          <label>
            새 항목 타입
            <select
              aria-label="새 항목 타입"
              value={kind}
              onChange={(e) => setKind(e.target.value as StyleKind)}
            >
              {Object.entries(labels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {(["tokens", "styles"] as const).map((group) => (
            <section key={group}>
              <h4>{group === "tokens" ? "토큰" : "스타일"}</h4>
              {Object.entries(library[group]).map(([id, entry]) => (
                <details key={id} data-testid={`style-entry-${id}`}>
                  <summary>
                    {entry.name || "(이름 없음)"} · {labels[entry.kind]}
                  </summary>
                  <p className="property-hint">
                    {group}.{id}
                  </p>
                  <label>
                    이름
                    <input
                      aria-label={`${group}.${id} 이름`}
                      value={entry.name}
                      onChange={(e) =>
                        update((l) => {
                          l[group][id].name = e.target.value;
                        })
                      }
                    />
                  </label>
                  <ValueEditor
                    kind={entry.kind}
                    value={entry.value}
                    library={library}
                    onChange={(v) =>
                      update((l) => {
                        l[group][id].value = v;
                      })
                    }
                  />
                  <button
                    onClick={() =>
                      update((l) => {
                        delete l[group][id];
                      })
                    }
                  >
                    {group}.{id} 삭제
                  </button>
                </details>
              ))}
              <button
                disabled={Object.keys(library[group]).length >= 512}
                onClick={() =>
                  update((l) => {
                    const id = `${group === "tokens" ? "token" : "style"}-${crypto.randomUUID()}`;
                    l[group][id] = {
                      kind,
                      name: `새 ${labels[kind]} ${group === "tokens" ? "토큰" : "스타일"}`,
                      value: defaultStyleValue(kind),
                    } as (typeof l)[typeof group][string];
                  })
                }
              >
                {group === "tokens" ? "토큰 추가" : "스타일 추가"}
              </button>
            </section>
          ))}
          <section>
            <h4>테마</h4>
            {Object.entries(library.themes).map(([id, theme]) => (
              <details key={id} data-testid={`style-theme-${id}`}>
                <summary>{theme.name || "(이름 없음)"}</summary>
                <p className="property-hint">
                  themes.{id} · 미지정 값은 기본 토큰에서 상속합니다.
                </p>
                <label>
                  이름
                  <input
                    aria-label={`themes.${id} 이름`}
                    value={theme.name}
                    onChange={(e) =>
                      update((l) => {
                        l.themes[id].name = e.target.value;
                      })
                    }
                  />
                </label>
                {Object.entries(library.tokens).map(([tid, token]) => (
                  <details key={tid}>
                    <summary>
                      {token.name} ·{" "}
                      {Object.hasOwn(theme.values, tid)
                        ? "테마 값"
                        : "기본 상속"}
                    </summary>
                    <label>
                      <input
                        aria-label={`${id}.${tid} 재정의`}
                        type="checkbox"
                        checked={Object.hasOwn(theme.values, tid)}
                        onChange={(e) =>
                          update((l) => {
                            if (e.target.checked)
                              l.themes[id].values[tid] = structuredClone(
                                token.value,
                              );
                            else delete l.themes[id].values[tid];
                          })
                        }
                      />
                      테마 재정의
                    </label>
                    {Object.hasOwn(theme.values, tid) && (
                      <ValueEditor
                        kind={token.kind}
                        value={theme.values[tid]}
                        library={library}
                        onChange={(v) =>
                          update((l) => {
                            l.themes[id].values[tid] = v;
                          })
                        }
                      />
                    )}
                  </details>
                ))}
                <button
                  onClick={() =>
                    update((l) => {
                      delete l.themes[id];
                      if (l.activeTheme === id) delete l.activeTheme;
                    })
                  }
                >
                  {id} 테마 삭제
                </button>
              </details>
            ))}
            <button
              disabled={Object.keys(library.themes).length >= 16}
              onClick={() =>
                update((l) => {
                  l.themes[`theme-${crypto.randomUUID()}`] = {
                    name: "새 테마",
                    values: {},
                  };
                })
              }
            >
              테마 추가
            </button>
          </section>
          <button
            onClick={() => {
              try {
                if (
                  JSON.stringify(library) !==
                  JSON.stringify(
                    doc.styleLibrary ?? { tokens: {}, styles: {}, themes: {} },
                  )
                )
                  onChange(setStyleLibrary(doc, library));
                cancel();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            시각 편집 적용
          </button>
          <button onClick={cancel}>시각 편집 취소</button>
          {diagnostics.length > 0 && (
            <ul role="alert" data-testid="style-diagnostics">
              {diagnostics.map((d, i) => (
                <li key={i}>
                  {d.path}: {d.message}
                </li>
              ))}
            </ul>
          )}
          {error && <p role="alert">{error}</p>}
        </fieldset>
      )}
    </div>
  );
}
