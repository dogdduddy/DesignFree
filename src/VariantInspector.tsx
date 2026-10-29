import { useEffect, useState } from "react";
import { isNodeLocked, type SceneDocument } from "./core";
import { variantMembers, type Variant } from "./components";
import { createVariant, editVariantSet, type VariantRow } from "./variants";

function ValueName({
  value,
  label,
  onCommit,
}: {
  value: string;
  label: string;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function VariantInspector({
  document: doc,
  sourceId,
  disabled,
  onChange,
}: {
  document: SceneDocument;
  sourceId: string;
  disabled: boolean;
  onChange: (doc: SceneDocument) => void;
}) {
  const [draft, setDraft] = useState<SceneDocument | null>(null);
  const [axes, setAxes] = useState<string[]>([]);
  const [rows, setRows] = useState<VariantRow[]>([]);
  const [error, setError] = useState("");
  const members = variantMembers(doc, sourceId);
  useEffect(() => {
    setDraft(null);
    setError("");
  }, [doc]);
  const start = () => {
    setDraft(structuredClone(doc));
    setAxes(
      Object.keys(
        (members[0].component as { variant: Variant }).variant.properties,
      ),
    );
    setRows(
      members.map((n) => ({
        id: n.id,
        name: n.name,
        values: Object.keys(
          (members[0].component as { variant: Variant }).variant.properties,
        ).map(
          (a) => (n.component as { variant: Variant }).variant.properties[a],
        ),
      })),
    );
    setError("");
  };
  const cancel = () => {
    setDraft(null);
    setError("");
  };
  const run = (fn: () => void) => {
    try {
      fn();
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const addState = (axisIndex?: number) =>
    run(() => {
      if (!draft) return;
      const cloneRow =
        rows.find((r) => r.id === sourceId && !isNodeLocked(draft, r.id)) ??
        rows.find((r) => !isNodeLocked(draft, r.id));
      if (!cloneRow)
        throw new Error("상태 추가: 잠기지 않은 원본이 필요합니다.");
      const result = createVariant(draft, cloneRow.id);
      let values = [...cloneRow.values];
      let stateIndex = 2;
      while (
        rows.some((r) =>
          r.values.every(
            (v, i) => v === (i === 0 ? `Variant ${stateIndex}` : values[i]),
          ),
        )
      )
        stateIndex++;
      values[0] = `Variant ${stateIndex}`;
      if (axisIndex !== undefined) {
        values = [...cloneRow.values];
        let index = 1;
        while (rows.some((r) => r.values[axisIndex] === `Value ${index}`))
          index++;
        values[axisIndex] = `Value ${index}`;
      }
      setDraft(result.document);
      setRows([
        ...rows,
        { id: result.id, name: result.document.nodes[result.id].name, values },
      ]);
    });
  const linked = Object.values(doc.nodes).filter(
    (n) =>
      n.component?.kind === "instance" &&
      members.some(
        (m) => m.id === (n.component as { sourceId: string }).sourceId,
      ),
  ).length;
  return (
    <div
      className="variant-editor"
      data-testid="variant-editor"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
    >
      <p className="property-hint">
        연결된 인스턴스 {linked}개. 축·값·상태 이름 변경은 identity와 override를
        보존합니다. 전환 시 공통 레이어 override를 유지하고, 없는 레이어의
        override는 복귀할 때 복원합니다.
      </p>
      {!draft ? (
        <button className="subtle-action" disabled={disabled} onClick={start}>
          Variants 편집
        </button>
      ) : (
        <fieldset disabled={disabled}>
          <legend>축 · 값 · 상태 편집</legend>
          <p className="property-hint">
            적용 전에는 저장하지 않습니다. Escape/취소로 이전 장면·선택을
            유지합니다. 상태 삭제는 원본과 하위 레이어를 삭제하며, 그 원본에
            직접 연결된 인스턴스는 현재 모습과 활성 override를 가진 독립
            스냅샷으로 분리됩니다. 분리 후 전환·숨겨진 override 복원은
            불가합니다. Undo로 연결을 복원할 수 있습니다.
          </p>
          {axes.map((axis, i) => (
            <div key={i} className="variant-axis">
              <label>
                축 {i + 1}
                <input
                  aria-label={`축 ${i + 1} 이름`}
                  value={axis}
                  onChange={(e) =>
                    setAxes(axes.map((a, j) => (j === i ? e.target.value : a)))
                  }
                />
              </label>
              <details>
                <summary>축 {i + 1} 값 관리</summary>
                <p className="property-hint">
                  값 추가는 선택한 상태(삭제·잠김 시 다른 편집 가능한 상태)를
                  복제합니다. 이름 변경은 이 값을 쓰는 모든 상태에 반영됩니다.
                  값 삭제는 이 값을 쓰는 상태를 모두 삭제합니다. 마지막 상태는
                  삭제할 수 없습니다.
                </p>
                {[...new Set(rows.map((r) => r.values[i]))].map((value, v) => (
                  <div key={v}>
                    <label>
                      값 {v + 1}
                      <ValueName
                        label={`축 ${i + 1} 값 ${v + 1} 이름`}
                        value={value}
                        onCommit={(text) =>
                          setRows(
                            rows.map((r) => ({
                              ...r,
                              values: r.values.map((old, j) =>
                                j === i && old === value ? text : old,
                              ),
                            })),
                          )
                        }
                      />
                    </label>
                    <button
                      type="button"
                      disabled={
                        rows.every((r) => r.values[i] === value) ||
                        rows.some(
                          (r) =>
                            r.values[i] === value && isNodeLocked(draft, r.id),
                        )
                      }
                      onClick={() =>
                        setRows(rows.filter((r) => r.values[i] !== value))
                      }
                    >
                      축 {i + 1} 값 {v + 1} 삭제 (
                      {rows.filter((r) => r.values[i] === value).length}개 상태)
                    </button>
                  </div>
                ))}
                <button type="button" onClick={() => addState(i)}>
                  축 {i + 1} 값 추가
                </button>
              </details>
              <button
                type="button"
                disabled={axes.length === 1}
                onClick={() => {
                  setAxes(axes.filter((_, j) => j !== i));
                  setRows(
                    rows.map((r) => ({
                      ...r,
                      values: r.values.filter((_, j) => j !== i),
                    })),
                  );
                }}
              >
                축 {i + 1} 삭제
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={axes.length >= 32}
            onClick={() => {
              setAxes([...axes, `Axis ${axes.length + 1}`]);
              setRows(
                rows.map((r) => ({ ...r, values: [...r.values, "Default"] })),
              );
            }}
          >
            축 추가
          </button>
          {rows.map((row, r) => (
            <div key={row.id} className="variant-state">
              <label>
                상태 {r + 1}
                <input
                  aria-label={`상태 ${r + 1} 이름`}
                  value={row.name}
                  onChange={(e) =>
                    setRows(
                      rows.map((n) =>
                        n.id === row.id ? { ...n, name: e.target.value } : n,
                      ),
                    )
                  }
                />
              </label>
              {axes.map((axis, i) => (
                <label key={i}>
                  {axis || `축 ${i + 1}`} 값
                  <input
                    aria-label={`상태 ${r + 1} 축 ${i + 1} 값`}
                    value={row.values[i]}
                    onChange={(e) =>
                      setRows(
                        rows.map((n) =>
                          n.id === row.id
                            ? {
                                ...n,
                                values: n.values.map((v, j) =>
                                  j === i ? e.target.value : v,
                                ),
                              }
                            : n,
                        ),
                      )
                    }
                  />
                </label>
              ))}
              <p className="property-hint">
                직접 연결{" "}
                {
                  Object.values(doc.nodes).filter(
                    (n) =>
                      n.component?.kind === "instance" &&
                      n.component.sourceId === row.id,
                  ).length
                }
                개{isNodeLocked(draft, row.id) ? " · 잠김" : ""}
              </p>
              <button
                type="button"
                disabled={rows.length === 1 || isNodeLocked(draft, row.id)}
                onClick={() => setRows(rows.filter((n) => n.id !== row.id))}
              >
                상태 {r + 1} 삭제
              </button>
            </div>
          ))}
          <button type="button" onClick={() => addState()}>
            상태 추가
          </button>
          <div className="variant-actions">
            <button
              type="button"
              onClick={() =>
                run(() => {
                  onChange(editVariantSet(draft, rows[0].id, axes, rows));
                  cancel();
                })
              }
            >
              Variants 적용
            </button>
            <button type="button" onClick={cancel}>
              Variants 취소
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
        </fieldset>
      )}
    </div>
  );
}
