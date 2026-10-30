import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RotateCcw, X } from "lucide-react";
import type { SceneDocument } from "./core";
import { sceneMarkup } from "./renderers/svg";
import { hotspots, isScreen, previewTarget, type Transition } from "./prototype";

/** Full-window prototype player. Reads a committed document snapshot; never
 * changes the document, history or autosave. */
export function PrototypePreview({
  doc,
  start,
  onClose,
}: {
  doc: SceneDocument;
  start: string;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(start);
  const close = useRef(onClose);
  close.current = onClose;
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const [past, setPast] = useState<string[]>([]);
  const [leaving, setLeaving] = useState<{ id: string; duration: number } | null>(null);
  const [flash, setFlash] = useState(false);
  const [pointer, setPointer] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = stage.current!;
    const measure = () => setArea({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const markup = useMemo(() => new Map<string, string>(), [doc]);
  const screenMarkup = (id: string) => {
    let svg = markup.get(id);
    if (svg === undefined) {
      const frame = doc.nodes[id];
      // Render the screen alone, at its own origin.
      svg = sceneMarkup(
        { ...doc, rootId: id, nodes: { ...doc.nodes, [id]: { ...frame, transform: [1, 0, 0, 1, 0, 0] } } },
        undefined,
        "prototype",
      );
      markup.set(id, svg);
    }
    return svg;
  };
  // The shown screen can disappear when the document changes underneath
  // (recovery, another tab): fall back to the start, else close.
  const shown = isScreen(doc, current) ? current : isScreen(doc, start) ? start : null;
  useEffect(() => {
    if (!shown) close.current();
  }, [shown]);
  const go = (id: string, transition: Transition, back = false) => {
    if (!shown || !isScreen(doc, id) || id === shown) return;
    setLeaving(transition.type === "dissolve" && transition.duration > 0 ? { id: shown, duration: transition.duration } : null);
    if (back) setPast((p) => p.slice(0, -1));
    else setPast((p) => [...p, shown]);
    setCurrent(id);
  };
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setLeaving(null), leaving.duration);
    return () => clearTimeout(t);
  }, [leaving]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Editor shortcuts stay inactive while the player is open.
      e.stopPropagation();
      if (e.key === "Escape") close.current();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  if (!shown) return null;
  const frame = doc.nodes[shown];
  // Fit each screen into the stage, never enlarging beyond 100%.
  const fit = (w: number, h: number) =>
    area.width ? Math.max(0.05, Math.min(1, (area.width - 48) / Math.max(1, w), (area.height - 48) / Math.max(1, h))) : 1;
  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * frame.width, y: ((e.clientY - r.top) / r.height) * frame.height };
  };
  const layer = (id: string, entering: boolean, duration = 0) => {
    const f = doc.nodes[id];
    return (
      <svg
        key={`${id}-${entering ? "in" : "out"}`}
        data-testid={entering ? "prototype-screen" : "prototype-leaving"}
        data-screen={id}
        className={`prototype-screen${entering && leaving ? " entering" : ""}`}
        style={{
          width: f.width * fit(f.width, f.height),
          height: f.height * fit(f.width, f.height),
          animationDuration: entering && leaving ? `${duration}ms` : undefined,
          cursor: entering && pointer ? "pointer" : "default",
          pointerEvents: entering ? "auto" : "none",
        }}
        viewBox={`0 0 ${f.width} ${f.height}`}
        onPointerMove={entering ? (e) => setPointer(!!previewTarget(doc, id, local(e))) : undefined}
        onClick={
          entering
            ? (e) => {
                const target = previewTarget(doc, id, local(e));
                if (target) go(target.interaction.action.destinationId, target.interaction.action.transition);
                else {
                  // Like Figma, a miss briefly outlines what can be clicked.
                  clearTimeout(flashTimer.current);
                  setFlash(true);
                  flashTimer.current = setTimeout(() => setFlash(false), 600);
                }
              }
            : undefined
        }
      >
        <g dangerouslySetInnerHTML={{ __html: screenMarkup(id) }} />
        {entering && flash &&
          hotspots(doc, id).map((h) => (
            <rect key={h.id} data-testid="prototype-hotspot" x={h.x} y={h.y} width={h.width} height={h.height} className="prototype-hotspot" />
          ))}
      </svg>
    );
  };
  return (
    <div className="prototype-preview" role="dialog" aria-modal="true" aria-label="프로토타입 미리보기">
      <div className="prototype-bar">
        <button
          aria-label="이전 화면"
          disabled={!past.length || !isScreen(doc, past[past.length - 1] ?? "")}
          onClick={() => go(past[past.length - 1], { type: "instant" }, true)}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          aria-label="처음 화면"
          disabled={shown === start && !past.length}
          onClick={() => {
            setLeaving(null);
            setPast([]);
            setCurrent(start);
          }}
        >
          <RotateCcw size={15} />
        </button>
        <strong data-testid="prototype-title">{frame.name}</strong>
        <span>클릭할 수 있는 곳은 빈 곳을 누르면 표시됩니다 · Esc로 닫기</span>
        <button aria-label="미리보기 닫기" autoFocus onClick={() => close.current()}>
          <X size={16} />
        </button>
      </div>
      <div className="prototype-stage" ref={stage}>
        {leaving && doc.nodes[leaving.id] && layer(leaving.id, false)}
        {layer(shown, true, leaving?.duration)}
      </div>
    </div>
  );
}
