import { formatGridTracks, parseGridTracks, validGrid } from "./grid-layout";
import { useState } from "react";
import type { SceneNode } from "./core";
import type { Layout } from "./flex-layout";

export function LayoutInspector({
  node,
  computed,
  parent,
  disabled,
  onChange,
}: {
  node: SceneNode;
  computed: SceneNode;
  parent?: SceneNode;
  disabled: boolean;
  onChange: (change: Partial<SceneNode>) => void;
}) {
  const [error, setError] = useState("");
  if (node.type === "group" || node.type === "page") return null;
  const layout: Layout = node.layout ?? { mode: "absolute" };
  const patch = (change: Partial<Layout>) => {
    const next = { ...layout, ...change };
    if (
      (next.minWidth ?? 0) > (next.maxWidth ?? Infinity) ||
      (next.minHeight ?? 0) > (next.maxHeight ?? Infinity)
    ) {
      setError("최소 크기는 최대 크기 이하여야 합니다.");
      return;
    }
    try {
      if (!validGrid(next.grid)) throw new Error("Invalid Grid settings");
      onChange({ layout: next });
      setError("");
    } catch {
      setError(
        "적용할 수 없는 레이아웃 설정입니다. 크기와 부모 구조를 확인해 주세요.",
      );
    }
  };
  const gridText = (
    label: string,
    value: string,
    apply: (text: string) => void,
  ) => (
    <label className="layout-field">
      <span>{label}</span>
      <input
        key={label + value}
        aria-label={label}
        defaultValue={value}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={(e) => {
          try {
            apply(e.target.value);
          } catch {
            setError(
              "Grid 입력을 확인해 주세요. 트랙은 px/fr/auto, 영역은 직사각형이어야 합니다.",
            );
          }
        }}
      />
    </label>
  );
  const gridPatch = (change: Partial<NonNullable<Layout["grid"]>>) =>
    patch({ grid: { ...layout.grid, ...change } });
  const select = (
    label: string,
    value: string,
    options: readonly string[],
    onValue: (v: string) => void,
  ) => (
    <label className="layout-field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onValue(e.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
  const number = (
    label: string,
    value: number | undefined,
    onValue: (v: number | undefined) => void,
    optional = false,
  ) => (
    <label className="number-field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        min="0"
        placeholder={optional ? "없음" : undefined}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => {
          if (optional && e.target.value === "") onValue(undefined);
          else if (
            Number.isFinite(e.target.valueAsNumber) &&
            e.target.valueAsNumber >= 0 &&
            e.target.valueAsNumber <= 1e7
          )
            onValue(e.target.valueAsNumber);
        }}
      />
    </label>
  );
  return (
    <section
      className="inspector-section layout-inspector"
      aria-label="Flex/Grid 레이아웃 설정"
      data-testid="layout-inspector"
    >
      <div className="section-title">레이아웃 설정</div>
      {error && (
        <p className="property-hint" role="alert">
          {error}
        </p>
      )}
      {node.type === "frame" &&
        select(
          "레이아웃 모드",
          layout.mode ?? "absolute",
          ["absolute", "flex", "grid"],
          (value) => patch({ mode: value as Layout["mode"] }),
        )}
      <div className="field-grid">
        {select(
          "너비 방식",
          layout.width ?? "fixed",
          ["fixed", "hug", "fill"],
          (value) => patch({ width: value as Layout["width"] }),
        )}
        {select(
          "높이 방식",
          layout.height ?? "fixed",
          ["fixed", "hug", "fill"],
          (value) => patch({ height: value as Layout["height"] }),
        )}
        {number(
          "최소 너비",
          layout.minWidth,
          (value) => patch({ minWidth: value }),
          true,
        )}
        {number(
          "최대 너비",
          layout.maxWidth,
          (value) => patch({ maxWidth: value }),
          true,
        )}
        {number(
          "최소 높이",
          layout.minHeight,
          (value) => patch({ minHeight: value }),
          true,
        )}
        {number(
          "최대 높이",
          layout.maxHeight,
          (value) => patch({ maxHeight: value }),
          true,
        )}
      </div>
      {parent &&
        ["flex", "grid"].includes(parent.layout.mode) &&
        select(
          parent.layout.mode === "grid" ? "Grid 자식 배치" : "Flex 자식 배치",
          layout.position ?? "flow",
          ["flow", "absolute"],
          (value) => patch({ position: value as Layout["position"] }),
        )}
      {parent && ["flex", "grid"].includes(parent.layout.mode) && (
        <p className="property-hint">
          absolute는 원본 X/Y를 다시 사용합니다. flow로 돌아가면 원본
          크기·제약·Grid 배치 규칙을 사용합니다. 계산 좌표는 원본에 덮어쓰지
          않습니다. 부모 밖으로 이동하려면 레이어 패널에서 드래그하세요. flow의
          Alt/Option 드래그 복제는 삽입 규칙과 함께 처리하지 않으므로 복제
          명령을 사용하세요.
        </p>
      )}
      {parent?.layout.mode === "grid" && (
        <>
          {gridText("Grid 영역 이름", layout.grid?.area ?? "", (text) =>
            gridPatch({ area: text.trim() || undefined }),
          )}
          <div className="field-grid">
            {number(
              "Grid 열 시작선",
              layout.grid?.column,
              (value) => gridPatch({ column: value }),
              true,
            )}
            {number(
              "Grid 행 시작선",
              layout.grid?.row,
              (value) => gridPatch({ row: value }),
              true,
            )}
            {number("Grid 열 span", layout.grid?.columnSpan ?? 1, (value) =>
              gridPatch({ columnSpan: value }),
            )}
            {number("Grid 행 span", layout.grid?.rowSpan ?? 1, (value) =>
              gridPatch({ rowSpan: value }),
            )}
          </div>
        </>
      )}
      {layout.mode === "grid" && (
        <>
          {gridText(
            "Grid 열 트랙",
            formatGridTracks(layout.grid?.columns),
            (text) => gridPatch({ columns: parseGridTracks(text) }),
          )}
          {gridText(
            "Grid 행 트랙",
            formatGridTracks(layout.grid?.rows),
            (text) => gridPatch({ rows: parseGridTracks(text) }),
          )}
          {gridText(
            "Grid 영역 행 (; 구분)",
            layout.grid?.areas?.join("; ") ?? "",
            (text) =>
              gridPatch({
                areas: text.trim()
                  ? text.split(";").map((s) => s.trim())
                  : undefined,
              }),
          )}
          {gridText(
            "Grid 자동 열",
            formatGridTracks([layout.grid?.autoColumns ?? "auto"]),
            (text) => {
              const tracks = parseGridTracks(text);
              if (tracks?.length !== 1) throw new Error("One track required");
              gridPatch({ autoColumns: tracks[0] });
            },
          )}
          {gridText(
            "Grid 자동 행",
            formatGridTracks([layout.grid?.autoRows ?? "auto"]),
            (text) => {
              const tracks = parseGridTracks(text);
              if (tracks?.length !== 1) throw new Error("One track required");
              gridPatch({ autoRows: tracks[0] });
            },
          )}
          {number("Grid 간격", layout.gap ?? 0, (value) =>
            patch({ gap: value ?? 0 }),
          )}
          <div className="field-grid">
            {["위", "오른쪽", "아래", "왼쪽"].map((side, index) => (
              <div key={side}>
                {number(
                  `Grid 안쪽 여백 ${side}`,
                  layout.padding?.[index] ?? 0,
                  (value) => {
                    const padding: [number, number, number, number] = [
                      ...(layout.padding ?? [0, 0, 0, 0]),
                    ];
                    padding[index] = value ?? 0;
                    patch({ padding });
                  },
                )}
              </div>
            ))}
          </div>
          {select(
            "Grid 세로 정렬",
            layout.align ?? "start",
            ["start", "center", "end", "stretch"],
            (value) => patch({ align: value as Layout["align"] }),
          )}
          <p className="property-hint">
            트랙 예: 80px 1fr auto. 시작선은 1부터, 빈 값은 자동 배치. 영역 예:
            header header; nav main. fill은 셀 크기를 채웁니다.
          </p>
        </>
      )}
      {layout.mode === "flex" && (
        <>
          {select(
            "Flex 방향",
            layout.direction ?? "row",
            ["row", "column"],
            (value) => patch({ direction: value as Layout["direction"] }),
          )}
          {number("Flex 간격", layout.gap ?? 0, (value) =>
            patch({ gap: value ?? 0 }),
          )}
          <div className="field-grid">
            {["위", "오른쪽", "아래", "왼쪽"].map((side, index) => (
              <div key={side}>
                {number(
                  `안쪽 여백 ${side}`,
                  layout.padding?.[index] ?? 0,
                  (value) => {
                    const padding: [number, number, number, number] = [
                      ...(layout.padding ?? [0, 0, 0, 0]),
                    ];
                    padding[index] = value ?? 0;
                    patch({ padding });
                  },
                )}
              </div>
            ))}
          </div>
          {select(
            "Flex 교차축 정렬",
            layout.align ?? "start",
            ["start", "center", "end", "stretch"],
            (value) => patch({ align: value as Layout["align"] }),
          )}
          {select(
            "Flex 주축 정렬",
            layout.justify ?? "start",
            [
              "start",
              "center",
              "end",
              "space-between",
              "space-around",
              "space-evenly",
            ],
            (value) => patch({ justify: value as Layout["justify"] }),
          )}
          <label className="layout-wrap">
            <input
              aria-label="Flex 줄바꿈"
              type="checkbox"
              disabled={disabled}
              checked={layout.wrap ?? false}
              onChange={(e) => patch({ wrap: e.target.checked })}
            />
            줄바꿈
          </label>
        </>
      )}
      <p className="property-hint">
        계산된 크기 {Math.round(computed.width * 100) / 100} ×{" "}
        {Math.round(computed.height * 100) / 100}. W/H는 원본 fixed 크기입니다.
      </p>
      <p className="property-hint">
        fixed: 지정 크기 · hug: 콘텐츠에 맞춤 · fill: 남는 공간 분배. CSS의 auto
        / 100%와 동일하지 않습니다. 자세한 제약은 README를 참고하세요.
      </p>
    </section>
  );
}
