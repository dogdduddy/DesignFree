import { useState } from "react";
import type { SceneDocument } from "./core";
import {
  detachSharedStyleLibrary,
  importSharedStyleLibrary,
  inspectSharedStyleLibraries,
} from "./shared-style-library";

export function SharedStyleLibraryInspector({
  document: doc,
  documents,
  disabled,
  onChange,
}: {
  document: SceneDocument;
  documents: SceneDocument[];
  disabled: boolean;
  onChange: (doc: SceneDocument) => void;
}) {
  const [sourceId, setSourceId] = useState(""),
    [error, setError] = useState("");
  const sources = documents.filter((d) => d.id !== doc.id && d.styleLibrary);
  const states = inspectSharedStyleLibraries(doc, documents);
  const run = (fn: () => SceneDocument) => {
    try {
      onChange(fn());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <details className="inspector-section" data-testid="shared-style-libraries">
      <summary>문서 간 공유 라이브러리</summary>
      <p className="property-hint">
        원본의 현재 테마를 스냅샷으로 연결합니다. 원본 변경은 업데이트로
        적용하며, 누락 시 마지막 값을 유지합니다. 로컬 수정·테마 재정의는
        업데이트 시 원본 값으로 교체됩니다.
      </p>
      <label className="property-field">
        원본 문서
        <select
          aria-label="공유 라이브러리 원본"
          value={sources.some((d) => d.id === sourceId) ? sourceId : ""}
          disabled={disabled}
          onChange={(e) => setSourceId(e.target.value)}
        >
          <option value="">문서 선택</option>
          {sources.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={disabled || !sources.some((d) => d.id === sourceId)}
        onClick={() =>
          run(() =>
            importSharedStyleLibrary(
              doc,
              sources.find((d) => d.id === sourceId)!,
            ),
          )
        }
      >
        공유 라이브러리 연결
      </button>
      {states.map((state) => (
        <div
          key={state.sourceId}
          data-testid={`shared-library-${state.sourceId}`}
          data-state={state.status}
        >
          <p>
            {state.sourceName} ·{" "}
            {state.status === "current"
              ? "최신 스냅샷"
              : state.status === "update"
                ? "업데이트 가능 · 로컬 수정 포함"
                : "참조 누락"}
          </p>
          {state.issues.length > 0 && (
            <ul role="status">
              {state.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          <button
            disabled={
              disabled || !documents.some((d) => d.id === state.sourceId)
            }
            onClick={() =>
              run(() =>
                importSharedStyleLibrary(
                  doc,
                  documents.find((d) => d.id === state.sourceId)!,
                ),
              )
            }
          >
            공유 업데이트
          </button>
          <button
            disabled={disabled}
            onClick={() =>
              run(() => detachSharedStyleLibrary(doc, state.sourceId))
            }
          >
            로컬 라이브러리로 전환
          </button>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
