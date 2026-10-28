import { useState, useRef } from "react";
import type { Paint, SceneNode } from "./core";
import { nodeFills, sortedStops } from "./paints";
function HexField({
  value,
  label = "채우기 HEX",
  disabled,
  onCommit,
  onInvalid,
}: {
  value: string;
  label?: string;
  disabled: boolean;
  onCommit: (value: string) => void;
  onInvalid: () => void;
}) {
  const [draft, setDraft] = useState(value.toUpperCase());
  const canceled = useRef(false);
  const commit = () => {
    if (canceled.current) {
      canceled.current = false;
      return;
    }
    const color = draft.trim().startsWith("#")
      ? draft.trim()
      : "#" + draft.trim();
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) {
      if (color.toLowerCase() !== value.toLowerCase()) onCommit(color);
    } else {
      setDraft(value.toUpperCase());
      onInvalid();
    }
  };
  return (
    <input
      aria-label={label}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          canceled.current = true;
          setDraft(value.toUpperCase());
          e.currentTarget.blur();
        }
      }}
    />
  );
}

// Native color controls edit RGB; keep authored HEX alpha in the text field.
const rgb = (hex: string) =>
  hex.length <= 5
    ? "#" + [...hex.slice(1, 4)].map((c) => c + c).join("")
    : hex.slice(0, 7);
const alpha = (hex: string) =>
  hex.length === 5 ? hex[4].repeat(2) : hex.length === 9 ? hex.slice(7) : "";
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const defaultPaint = (type: Paint["type"]): Paint =>
  type === "none"
    ? { type }
    : type === "solid"
      ? { type, color: "#B6A7F8" }
      : {
          type,
          from: type === "radial" ? [0.5, 0.5] : [0, 0],
          to: type === "radial" ? [1, 0.5] : [1, 1],
          stops: [
            { offset: 0, color: "#B6A7F8" },
            { offset: 1, color: "#4F46E5" },
          ],
        };
export function PaintInspector({
  node,
  disabled,
  onChange,
  onInvalid,
}: {
  node: SceneNode;
  disabled: boolean;
  onChange: (value: Partial<SceneNode>) => void;
  onInvalid: () => void;
}) {
  const fills = nodeFills(node);
  const paintDisabled = disabled || node.type === "group";
  const save = (next: Paint[]) =>
    onChange({ fills: next, fill: next[0] ?? { type: "none" } });
  const change = (i: number, p: Paint) =>
    save(fills.map((f, j) => (i === j ? p : f)));
  const number = (
    label: string,
    value: number,
    commit: (v: number) => void,
    off = paintDisabled,
  ) => (
    <PaintNumber
      key={label + ":" + value}
      label={label}
      value={value}
      disabled={off}
      onCommit={commit}
    />
  );
  const color = (label: string, value: string, commit: (v: string) => void) => (
    <div className="color-field">
      <input
        aria-label={label.replace("HEX", "색상")}
        type="color"
        value={rgb(value)}
        disabled={paintDisabled}
        onChange={(e) => commit(e.target.value + alpha(value))}
      />
      <HexField
        key={label + ":" + value}
        label={label}
        value={value}
        disabled={paintDisabled}
        onCommit={commit}
        onInvalid={onInvalid}
      />
    </div>
  );
  const stroke = node.stroke;
  return (
    <>
      <section className="inspector-section paint-section">
        <div className="section-title">
          채우기{" "}
          <button
            disabled={paintDisabled || fills.length >= 32}
            aria-label="채우기 추가"
            onClick={() => save([...fills, defaultPaint("solid")])}
          >
            +
          </button>
        </div>
        <p className="property-hint">아래 항목일수록 위에 그려집니다.</p>
        {fills.map((p, i) => (
          <div className="paint-layer" key={i} data-testid={`fill-${i}`}>
            <div className="paint-actions">
              <span>채우기 {i + 1}</span>
              <button
                aria-label={`채우기 ${i + 1} 아래로`}
                disabled={paintDisabled || i === 0}
                onClick={() => {
                  const next = [...fills];
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  save(next);
                }}
              >
                ↓
              </button>
              <button
                aria-label={`채우기 ${i + 1} 위로`}
                disabled={paintDisabled || i === fills.length - 1}
                onClick={() => {
                  const next = [...fills];
                  [next[i + 1], next[i]] = [next[i], next[i + 1]];
                  save(next);
                }}
              >
                ↑
              </button>
              <button
                aria-label={`채우기 ${i + 1} 삭제`}
                disabled={paintDisabled}
                onClick={() => save(fills.filter((_, j) => i !== j))}
              >
                ×
              </button>
            </div>
            <select
              aria-label={`채우기 ${i + 1} 유형`}
              disabled={paintDisabled}
              value={p.type}
              onChange={(e) =>
                change(i, {
                  ...defaultPaint(e.target.value as Paint["type"]),
                  opacity: p.opacity,
                })
              }
            >
              <option value="none">없음</option>
              <option value="solid">단색</option>
              <option value="linear">Linear</option>
              <option value="radial">Radial</option>
            </select>
            {p.type === "solid" &&
              color(
                i === 0 ? "채우기 HEX" : `채우기 ${i + 1} HEX`,
                p.color,
                (c) => change(i, { ...p, color: c }),
              )}
            {p.type !== "none" &&
              number(`채우기 ${i + 1} 불투명도`, (p.opacity ?? 1) * 100, (v) =>
                change(i, { ...p, opacity: clamp(v / 100) }),
              )}
            {(p.type === "linear" || p.type === "radial") && (
              <>
                <div className="field-grid">
                  {(["from", "to"] as const).flatMap((endpoint) =>
                    ([0, 1] as const).map((axis) =>
                      number(
                        `채우기 ${i + 1} ${endpoint} ${axis === 0 ? "X" : "Y"}`,
                        p[endpoint][axis] * 100,
                        (v) => {
                          const point = [...p[endpoint]] as [number, number];
                          point[axis] = v / 100;
                          change(i, { ...p, [endpoint]: point });
                        },
                      ),
                    ),
                  )}
                </div>
                {p.stops.map((s, j) => (
                  <div className="gradient-stop" key={j}>
                    {color(`채우기 ${i + 1} stop ${j + 1} HEX`, s.color, (c) =>
                      change(i, {
                        ...p,
                        stops: p.stops.map((t, k) =>
                          k === j ? { ...t, color: c } : t,
                        ),
                      }),
                    )}
                    <div className="field-grid">
                      {number(
                        `Stop ${i + 1}.${j + 1} 위치`,
                        s.offset * 100,
                        (v) =>
                          change(i, {
                            ...p,
                            stops: sortedStops(
                              p.stops.map((t, k) =>
                                k === j ? { ...t, offset: clamp(v / 100) } : t,
                              ),
                            ),
                          }),
                      )}
                      {number(
                        `Stop ${i + 1}.${j + 1} 불투명도`,
                        (s.opacity ?? 1) * 100,
                        (v) =>
                          change(i, {
                            ...p,
                            stops: p.stops.map((t, k) =>
                              k === j ? { ...t, opacity: clamp(v / 100) } : t,
                            ),
                          }),
                      )}
                    </div>
                    <button
                      disabled={paintDisabled || p.stops.length <= 2}
                      aria-label={`Stop ${i + 1}.${j + 1} 삭제`}
                      onClick={() =>
                        change(i, {
                          ...p,
                          stops: p.stops.filter((_, k) => j !== k),
                        })
                      }
                    >
                      Stop 삭제
                    </button>
                  </div>
                ))}
                <button
                  aria-label={`채우기 ${i + 1} stop 추가`}
                  disabled={paintDisabled || p.stops.length >= 64}
                  onClick={() =>
                    change(i, {
                      ...p,
                      stops: sortedStops([
                        ...p.stops,
                        { offset: 0.5, color: "#FFFFFF" },
                      ]),
                    })
                  }
                >
                  Stop 추가
                </button>
              </>
            )}
          </div>
        ))}
      </section>
      <section className="inspector-section">
        <div className="section-title">
          테두리{" "}
          <button
            aria-label={stroke ? "테두리 삭제" : "테두리 추가"}
            disabled={paintDisabled}
            onClick={() =>
              onChange({
                stroke: stroke
                  ? undefined
                  : { color: "#222222", width: 1, position: "center" },
              })
            }
          >
            {stroke ? "−" : "+"}
          </button>
        </div>
        {stroke && (
          <>
            {color("테두리 HEX", stroke.color, (c) =>
              onChange({ stroke: { ...stroke, color: c } }),
            )}
            <div className="field-grid">
              {number("테두리 두께", stroke.width, (v) =>
                onChange({ stroke: { ...stroke, width: Math.max(0, v) } }),
              )}
              {number("테두리 불투명도", (stroke.opacity ?? 1) * 100, (v) =>
                onChange({ stroke: { ...stroke, opacity: clamp(v / 100) } }),
              )}
            </div>
            <label className="property-hint">
              위치
              <select
                aria-label="테두리 위치"
                disabled={paintDisabled || node.type === "text"}
                value={
                  node.type === "text"
                    ? "center"
                    : (stroke.position ?? "center")
                }
                onChange={(e) =>
                  onChange({
                    stroke: { ...stroke, position: e.target.value as "center" },
                  })
                }
              >
                <option value="inside">안쪽</option>
                <option value="center">중앙</option>
                <option value="outside">바깥쪽</option>
              </select>
            </label>
            {node.type === "text" && (
              <p className="property-hint">
                텍스트 테두리는 중앙 위치를 사용합니다.
              </p>
            )}
            <DashField
              key={JSON.stringify(stroke.dash)}
              value={stroke.dash ?? []}
              disabled={paintDisabled}
              onCommit={(dash) => onChange({ stroke: { ...stroke, dash } })}
            />
          </>
        )}
      </section>
    </>
  );
}
function DashField({
  value,
  disabled,
  onCommit,
}: {
  value: number[];
  disabled: boolean;
  onCommit: (v: number[]) => void;
}) {
  const [draft, setDraft] = useState(value.join(" "));
  const [error, setError] = useState(false);
  const commit = () => {
    const tokens = draft.trim() ? draft.trim().split(/[\s,]+/) : [];
    const next = tokens.map(Number);
    if (next.length > 16 || next.some((x) => !Number.isFinite(x) || x <= 0)) {
      setError(true);
      return;
    }
    setError(false);
    if (JSON.stringify(value) !== JSON.stringify(next)) onCommit(next);
  };
  return (
    <label className="property-hint">
      점선 (예: 8 4, 빈 값은 실선)
      <input
        aria-label="테두리 점선"
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(value.join(" "));
            setError(false);
            /* Prevent blur committing the canceled draft. */ e.preventDefault();
          }
        }}
      />
      {error && <span role="alert">양수 간격을 16개 이하로 입력하세요.</span>}
    </label>
  );
}

function PaintNumber({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100));
  const canceled = useRef(false);
  return (
    <label className="number-field">
      <span>
        {label
          .replace(/^채우기 \d+ /, "")
          .replace(/^Stop [\d.]+ /, "")
          .replace(/^테두리 /, "")
          .replace("불투명도", "불투명도 %")
          .replace("from", "시작")
          .replace("to", "끝")}
      </span>
      <input
        aria-label={label}
        type="number"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (canceled.current) {
            canceled.current = false;
            return;
          }
          const v = Number(draft);
          setDraft(String(Math.round(value * 100) / 100));
          if (draft.trim() && Number.isFinite(v)) {
            if (v !== value) onCommit(v);
          } else setDraft(String(value));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            canceled.current = true;
            setDraft(String(Math.round(value * 100) / 100));
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
