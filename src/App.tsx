import { StyleInspector } from "./StyleInspector";
import { createVariant } from "./variants";
import {
  makeComponent,
  variantMembers,
  switchVariant,
  setVariantProperties,
  createInstance,
  detachInstance,
  resetInstanceOverrides,
  instanceOwner,
} from "./components";
import { prepareFrameWeb, embeddedWebFont, type WebExport } from "./web-export";
import { ensureFonts } from "./renderers/svg";
import { useOwnerSession } from "./AuthGate";
import { layerRows, layerWindow, LAYER_ROW_HEIGHT } from "./layer-window";
import { computeLayout } from "./flex-layout";
import { LayoutInspector } from "./LayoutInspector";
import { PaintInspector } from "./PaintInspector";
import { FONT_FAMILIES, missingFont, cssFont } from "./text-layout";
import { useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import {
  MousePointer2,
  Frame,
  Square,
  Circle,
  Type,
  ImagePlus,
  Undo2,
  Redo2,
  Download,
  Upload,
  ChevronRight,
  ChevronDown,
  Eye,
  EyeOff,
  LockKeyhole,
  LockKeyholeOpen,
  Plus,
  Minus,
  Maximize,
  Layers,
  SlidersHorizontal,
  ArrowUpRight,
  X,
  Copy,
  Check,
  Trash2,
  FlaskConical,
  AlignHorizontalJustifyStart,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignHorizontalSpaceBetween,
  AlignVerticalSpaceBetween,
} from "lucide-react";
import {
  createDemoDocument,
  DocumentHistory,
  getWorldTransform,
  hitTest,
  groupNodes,
  ungroupNodes,
  groupHitTarget,
  updateNodes,
  serializeDocument,
  parseDocument,
  duplicateNodes,
  selectionRoots,
  isNodeLocked,
} from "./core";
import type { SceneDocument, SceneNode, Matrix, Viewport } from "./core";
import { SceneRenderer, exportSvg, exportPng } from "./renderers";
import { snapMove, snapResize, type SnapGuide } from "./snapping";
import { marqueeBox, marqueeSelection, type MarqueeBox } from "./marquee";
import { measureBounds } from "./measurement";
import {
  alignNodes,
  distributeNodes,
  arrangeableRoots,
  canDistribute,
} from "./arrangement";
import type { Alignment } from "./arrangement";
import {
  addPage,
  checkedName,
  duplicateDocument,
  newDocument,
  pageIds,
  removePage,
  renamePage,
  switchPage,
} from "./documents";
import { serverStorage } from "./server-storage";
import { useLocalDraft } from "./use-local-draft";
import { CLIPBOARD_MIME, copySelection, pasteSelection } from "./clipboard";

import { moveLayers, stepLayers, reparentCanvasDrop } from "./layers";
import {
  handles,
  transformFrame,
  resizeBox,
  resizeSelection,
  rotateSelection,
  rotationDelta,
  frameRotation,
  type Handle,
} from "./transforms";

type Tool = "select" | "frame" | "rectangle" | "ellipse" | "text";
type XY = { x: number; y: number };
const point = (m: Matrix, p: XY): XY => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
});
const inverse = (m: Matrix): Matrix => {
  const d = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / d,
    -m[1] / d,
    -m[2] / d,
    m[0] / d,
    (m[2] * m[5] - m[3] * m[4]) / d,
    (m[1] * m[4] - m[0] * m[5]) / d,
  ];
};
const uid = () => crypto.randomUUID();
const isLocked = isNodeLocked;

// Transform tools cannot write computed layout geometry back into authored nodes.
function layoutManaged(doc: SceneDocument, ids: string[]) {
  const managed = (n: SceneNode) =>
    ["flex", "grid"].includes(n.layout?.mode) ||
    (n.layout?.width !== undefined && n.layout.width !== "fixed") ||
    (n.layout?.height !== undefined && n.layout.height !== "fixed") ||
    [
      n.layout?.minWidth,
      n.layout?.maxWidth,
      n.layout?.minHeight,
      n.layout?.maxHeight,
    ].some((value) => value !== undefined);
  const descendants = (id: string): boolean => {
    const n = doc.nodes[id];
    return !!n && (managed(n) || n.children.some(descendants));
  };
  return ids.some((id) => {
    if (descendants(id)) return true;
    let node = doc.nodes[id];
    while (node?.parentId) {
      node = doc.nodes[node.parentId];
      if (node && managed(node)) return true;
    }
    return false;
  });
}
const layoutMessage =
  "Flex/Grid 레이아웃은 레이아웃 설정에서 크기와 배치를 변경해 주세요. 이동·회전·그룹 변환은 지원하지 않습니다.";

function bounds(doc: SceneDocument, ids: string[]) {
  const ps = ids.flatMap((id) => {
    const n = doc.nodes[id];
    if (!n) return [];
    const m = getWorldTransform(doc, id);
    return [
      point(m, { x: 0, y: 0 }),
      point(m, { x: n.width, y: 0 }),
      point(m, { x: 0, y: n.height }),
      point(m, { x: n.width, y: n.height }),
    ];
  });
  if (!ps.length) return null;
  const x = Math.min(...ps.map((p) => p.x)),
    y = Math.min(...ps.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(...ps.map((p) => p.x)) - x,
    height: Math.max(...ps.map((p) => p.y)) - y,
  };
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const iconFor = (type: string) =>
  type === "group"
    ? Layers
    : type === "frame"
      ? Frame
      : type === "text"
        ? Type
        : type === "ellipse"
          ? Circle
          : type === "image"
            ? ImagePlus
            : Square;

function RotationDeltaField({
  disabled,
  onCommit,
}: {
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState("0");
  const canceled = useRef(false);
  return (
    <label className="number-field">
      <span>회전 Δ°</span>
      <input
        aria-label="회전 Δ°"
        type="number"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const value = Number(draft);
          if (
            !canceled.current &&
            draft.trim() &&
            Number.isFinite(value) &&
            value !== 0
          )
            onCommit(value);
          canceled.current = false;
          setDraft("0");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            canceled.current = true;
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

export default function App() {
  const ownerSession = useOwnerSession();
  const [history] = useState(() => ({
    current: new DocumentHistory(createDemoDocument()),
  }));
  const [doc, setDoc] = useState<SceneDocument>(() => history.current.document),
    [selected, setSelected] = useState<string[]>([]),
    [tool, setTool] = useState<Tool>("select"),
    [viewport, setViewport] = useState<Viewport>({ x: 70, y: 70, zoom: 0.75 }),
    [size, setSize] = useState({ width: 0, height: 0 }),
    [message, setMessage] = useState(""),
    [renderer, setRenderer] = useState<"svg" | "canvaskit">("svg"),
    [renderError, setRenderError] = useState(""),
    [menu, setMenu] = useState(false),
    [pngScale, setPngScale] = useState(2),
    [exporting, setExporting] = useState(false),
    [editing, setEditing] = useState<string | null>(null),
    [textDraft, setTextDraft] = useState(""),
    [space, setSpace] = useState(false),
    [option, setOption] = useState(false),
    [hoverPoint, setHoverPoint] = useState<XY | null>(null),
    [gesturing, setGesturing] = useState(false),
    [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]),
    [marquee, setMarquee] = useState<MarqueeBox | null>(null),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const geometry = useMemo(() => computeLayout(doc), [doc]);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const libraryPanel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !libraryPanel.current?.contains(event.target)
      )
        libraryPanel.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const layerTree = useRef<HTMLDivElement>(null);
  const [layerScroll, setLayerScroll] = useState(0);
  const [layerHeight, setLayerHeight] = useState(700);
  const rows = useMemo(() => layerRows(doc, collapsed), [doc, collapsed]);
  const rowWindow = layerWindow(rows.length, layerScroll, layerHeight);
  useLayoutEffect(() => {
    const element = layerTree.current!;
    const observer = new ResizeObserver(() =>
      setLayerHeight(element.clientHeight),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (rows.length <= 500 || selected.length !== 1) return;
    const index = rows.findIndex((row) => row.id === selected[0]);
    const element = layerTree.current;
    if (!element || index < 0) return;
    const y = index * LAYER_ROW_HEIGHT;
    if (y < element.scrollTop) element.scrollTop = y;
    else if (y + LAYER_ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = y + LAYER_ROW_HEIGHT - element.clientHeight;
  }, [selected]);
  const layerDrag = useRef<string[]>([]);
  const [layerDrop, setLayerDrop] = useState<{
    id: string;
    zone: string;
  } | null>(null);
  const groupScope = useRef<string | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const viewRef = useRef(viewport);
  viewRef.current = viewport;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const stage = useRef<HTMLDivElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    importInput = useRef<HTMLInputElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    gesture = useRef<any>(null),
    composing = useRef(false),
    modifierMove = useRef<(e: KeyboardEvent) => void>(() => {});
  const uncommitted = Boolean(
    (editing && doc.nodes[editing]?.text?.content !== textDraft) ||
    (gesturing &&
      gesture.current &&
      !["pan", "marquee"].includes(gesture.current.mode)),
  );
  const documentEpoch = useRef(0);
  const restoreDocument = (restored: SceneDocument) => {
    documentEpoch.current++;
    groupScope.current = null;
    history.current = new DocumentHistory(restored);
    const normalized = history.current.document;
    docRef.current = normalized;
    selectedRef.current = [];
    gesture.current = null;
    setDoc(normalized);
    setSelected([]);
    setEditing(null);
    setCollapsed(new Set());
    setHoverPoint(null);
    setSnapGuides([]);
    setMarquee(null);
    setLayerScroll(0);
    if (layerTree.current) layerTree.current.scrollTop = 0;
    didFit.current = false;
  };
  const localDraft = useLocalDraft(
    history.current.document,
    restoreDocument,
    uncommitted,
  );
  const libraryBusy =
    !localDraft.ready ||
    !!editing ||
    gesturing ||
    exporting ||
    localDraft.status === "error" ||
    localDraft.status === "conflict";
  const changeDocument = (next: SceneDocument, others: SceneDocument[]) => {
    if (libraryBusy) return;
    if (localDraft.change(next, others)) restoreDocument(next);
  };
  const openDocument = (id: string) => {
    if (id === doc.id) return;
    const next = localDraft.documents.find((d) => d.id === id);
    if (next)
      changeDocument(next, [
        ...localDraft.documents.filter((d) => d.id !== id),
        history.current.committedDocument,
      ]);
  };
  const saveStatus =
    uncommitted &&
    localDraft.ready &&
    localDraft.status !== "error" &&
    localDraft.status !== "conflict"
      ? "editing"
      : localDraft.status;
  const readyRef = useRef(false);
  readyRef.current = localDraft.ready && !ownerSession?.locked;
  useEffect(() => {
    if (import.meta.env.DEV) {
      Object.defineProperty(window, "__draftroom", {
        configurable: true,
        value: Object.freeze({
          getState: () => ({
            document: structuredClone(docRef.current),
            selection: [...selectedRef.current],
            viewport: { ...viewRef.current },
          }),
        }),
      });
      return () => {
        delete (window as any).__draftroom;
      };
    }
  }, []);
  const sync = () => {
    const next = history.current.document;
    const pageChanged = next.rootId !== docRef.current.rootId;
    const nextSelection = pageChanged
      ? []
      : selectedRef.current.filter((id) => Boolean(next.nodes[id]));
    if (pageChanged) {
      documentEpoch.current++;
      groupScope.current = null;
      setCollapsed(new Set());
      setHoverPoint(null);
      didFit.current = false;
    }
    if (!next.nodes[groupScope.current ?? ""]) groupScope.current = null;
    docRef.current = next;
    selectedRef.current = nextSelection;
    setDoc(next);
    setSelected(nextSelection);
    setEditing((id) => (id && next.nodes[id] ? id : null));
    localDraft.observe(history.current.committedDocument);
  };
  const execute = (next: SceneDocument) => {
    if (!readyRef.current) return;
    try {
      history.current.execute(next);
      sync();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "문서를 변경할 수 없습니다.",
      );
    }
  };
  const preview = (next: SceneDocument, fromCurrent = false) => {
    try {
      history.current.preview(next, fromCurrent);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "문서를 변경할 수 없습니다.",
      );
    }
  };
  const arrange = (mode: Alignment | "distribute-x" | "distribute-y") => {
    if (!readyRef.current || editing || gesture.current || gesturing) return;
    const current = docRef.current;
    const ids = selectedRef.current;
    if (layoutManaged(current, ids)) {
      tell(layoutMessage);
      return;
    }
    const next =
      mode === "distribute-x" || mode === "distribute-y"
        ? distributeNodes(current, ids, mode === "distribute-x" ? "x" : "y")
        : alignNodes(current, ids, mode);
    if (next !== current) execute(next);
  };
  const patch = (changes: Record<string, Partial<SceneNode>>) =>
    execute(updateNodes(docRef.current, changes));
  const tell = (s: string) => setMessage(s);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(""), 5000);
    return () => clearTimeout(t);
  }, [message]);
  useLayoutEffect(() => {
    const el = stage.current!;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = () => {
    const d = geometryRef.current;
    const b = bounds(d, d.nodes[d.rootId].children);
    if (!b) return;
    const z = Math.min(
      1.1,
      (size.width - 130) / b.width,
      (size.height - 130) / b.height,
    );
    setViewport({
      x: (size.width - b.width * z) / 2 - b.x * z,
      y: (size.height - b.height * z) / 2 - b.y * z,
      zoom: Math.max(0.05, z),
    });
  };
  const didFit = useRef(false);
  useEffect(() => {
    if (localDraft.ready && size.width > 300 && !didFit.current) {
      fit();
      didFit.current = true;
    }
  }, [size, localDraft.ready, doc.id, doc.rootId]);
  useEffect(() => {
    if (editing) {
      textarea.current?.focus();
      textarea.current?.select();
    }
  }, [editing]);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const world = (p: XY) => ({
    x: (p.x - viewRef.current.x) / viewRef.current.zoom,
    y: (p.y - viewRef.current.y) / viewRef.current.zoom,
  });
  const zoom = (
    factor: number,
    anchor: XY = { x: size.width / 2, y: size.height / 2 },
  ) =>
    setViewport((v) => {
      const z = Math.max(0.05, Math.min(8, v.zoom * factor));
      const q = { x: (anchor.x - v.x) / v.zoom, y: (anchor.y - v.y) / v.zoom };
      return { x: anchor.x - q.x * z, y: anchor.y - q.y * z, zoom: z };
    });
  const roots = (ids: string[], d = docRef.current) => selectionRoots(d, ids);
  const remove = () => {
    const d = docRef.current;
    const ids = roots(selectedRef.current);
    if (!ids.length) return;
    const next = structuredClone(d);
    const del = (id: string) => {
      next.nodes[id].children.forEach(del);
      delete next.nodes[id];
    };
    ids.forEach((id) => {
      const n = next.nodes[id];
      if (isLocked(d, id)) return;
      const p = next.nodes[n.parentId!];
      p.children = p.children.filter((i) => i !== id);
      del(id);
    });
    execute(next);
    setSelected([]);
  };
  const duplicate = () => {
    const copied = duplicateNodes(docRef.current, selectedRef.current, {
      x: 24,
      y: 24,
    });
    if (copied.ids.length) {
      execute(copied.document);
      setSelected(copied.ids);
    }
  };
  const clipboardEditing = useRef(false);
  clipboardEditing.current = !!editing;
  useEffect(() => {
    const blocked = (e: ClipboardEvent) =>
      !readyRef.current ||
      !!document.querySelector(".web-preview") ||
      !!gesture.current ||
      clipboardEditing.current ||
      composing.current ||
      (e.target instanceof Element &&
        !!e.target.closest('input,textarea,[contenteditable="true"]'));
    const copy = (e: ClipboardEvent) => {
      if (blocked(e) || !e.clipboardData) return;
      if (layoutManaged(docRef.current, selectedRef.current)) {
        e.preventDefault();
        tell(
          "Flex 선택은 JSON 문서 저장으로 보존해 주세요. 클립보드 복사는 아직 지원하지 않습니다.",
        );
        return;
      }
      try {
        const data = copySelection(docRef.current, selectedRef.current);
        if (!data) return;
        e.clipboardData.setData(CLIPBOARD_MIME, data.json);
        e.clipboardData.setData("text/plain", data.json);
        e.clipboardData.setData("image/svg+xml", data.svg);
        // Chromium exposes SVG to other applications through HTML as well.
        e.clipboardData.setData("text/html", data.svg);
        e.preventDefault();
        if (e.type === "cut") remove();
      } catch {
        e.preventDefault();
        tell("클립보드에 복사하지 못했습니다. 원본은 유지됩니다.");
      }
    };
    const paste = (e: ClipboardEvent) => {
      if (blocked(e) || !e.clipboardData) return;
      const json =
        e.clipboardData.getData(CLIPBOARD_MIME) ||
        e.clipboardData.getData("text/plain");
      if (!json) return;
      try {
        const result = pasteSelection(
          docRef.current,
          json,
          selectedRef.current,
        );
        e.preventDefault();
        if (result.ids.length) {
          execute(result.document);
          selectedRef.current = result.ids;
          setSelected(result.ids);
        }
      } catch {
        e.preventDefault();
        tell("붙여넣을 수 없는 클립보드입니다. Draftroom에서 복사해 주세요.");
      }
    };
    window.addEventListener("copy", copy);
    window.addEventListener("cut", copy);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("copy", copy);
      window.removeEventListener("cut", copy);
      window.removeEventListener("paste", paste);
    };
  }, []);
  const moveBy = (dx: number, dy: number) => {
    if (layoutManaged(docRef.current, selectedRef.current)) {
      tell(layoutMessage);
      return;
    }
    const d = docRef.current;
    const changes: Record<string, Partial<SceneNode>> = {};
    roots(selectedRef.current).forEach((id) => {
      const n = d.nodes[id];
      if (isLocked(d, id)) return;
      const m = n.parentId
        ? inverse(getWorldTransform(d, n.parentId))
        : ([1, 0, 0, 1, 0, 0] as Matrix);
      const tr = [...n.transform] as Matrix;
      tr[4] += m[0] * dx + m[2] * dy;
      tr[5] += m[1] * dx + m[3] * dy;
      changes[id] = { transform: tr };
    });
    patch(changes);
  };
  const undo = () => {
    setGesturing(false);
    setSnapGuides([]);
    setMarquee(null);
    gesture.current = null;
    history.current.undo();
    sync();
    setEditing(null);
  };
  const redo = () => {
    setGesturing(false);
    setSnapGuides([]);
    setMarquee(null);
    gesture.current = null;
    history.current.redo();
    sync();
    setEditing(null);
  };
  const cancel = () => {
    setGesturing(false);
    setSnapGuides([]);
    setMarquee(null);
    setOption(false);
    if (gesture.current) {
      const originalSelection = gesture.current.originalSelection;
      history.current.cancelTransaction();
      sync();
      if (originalSelection) {
        selectedRef.current = originalSelection;
        setSelected(originalSelection);
      }
      gesture.current = null;
    }
    setEditing(null);
    setTool("select");
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!readyRef.current) return;
      const input = (e.target as HTMLElement).closest(
        'input,textarea,[contenteditable="true"]',
      );
      if (e.isComposing || composing.current) return;
      if (input) return;
      if (e.key === "Alt") setOption(true);
      if (e.key === "Alt" || e.key === "Meta" || e.key === "Shift")
        modifierMove.current(e);
      if (gesture.current && e.key !== "Escape") return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === "Space") {
        e.preventDefault();
        setSpace(true);
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicate();
      } else if (
        mod &&
        (e.code === "BracketLeft" || e.code === "BracketRight")
      ) {
        e.preventDefault();
        if (!editing)
          execute(
            stepLayers(
              docRef.current,
              selectedRef.current,
              e.code === "BracketRight",
            ),
          );
      } else if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (editing || e.repeat) return;
        if (layoutManaged(docRef.current, selectedRef.current)) {
          tell(layoutMessage);
          return;
        }
        const result = (e.shiftKey ? ungroupNodes : groupNodes)(
          docRef.current,
          selectedRef.current,
        );
        if (result.document !== docRef.current) {
          execute(result.document);
          selectedRef.current = result.ids;
          setSelected(result.ids);
        } else
          tell(
            "같은 부모의 잠기지 않은 레이어를 선택해 주세요. 그룹 해제는 효과가 없는 보이는 그룹에 지원됩니다.",
          );
      } else if (e.key === "Escape") {
        if (groupScope.current && !gesture.current) {
          const id = groupScope.current;
          groupScope.current = docRef.current.nodes[id]?.parentId ?? null;
          if (docRef.current.nodes[groupScope.current ?? ""]?.type !== "group")
            groupScope.current = null;
          setSelected([id]);
          return;
        }
        const activeGesture = !!gesture.current;
        cancel();
        if (!activeGesture) setSelected([]);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove();
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const n = e.shiftKey ? 10 : 1;
        moveBy(
          e.key === "ArrowLeft" ? -n : e.key === "ArrowRight" ? n : 0,
          e.key === "ArrowUp" ? -n : e.key === "ArrowDown" ? n : 0,
        );
      } else if (!mod) {
        const shortcuts: Record<string, Tool> = {
          v: "select",
          f: "frame",
          r: "rectangle",
          o: "ellipse",
          t: "text",
        };
        if (shortcuts[e.key.toLowerCase()])
          setTool(shortcuts[e.key.toLowerCase()]);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt" || e.key === "Meta" || e.key === "Shift")
        modifierMove.current(e);
      if (e.code === "Space") setSpace(false);
      if (e.key === "Alt" || !e.altKey) setOption(false);
    };
    const blur = () => {
      setOption(false);
      setHoverPoint(null);
      setSpace(false);
      if (gesture.current) cancel();
    };
    const focus = (e: FocusEvent) => {
      if (
        (e.target as HTMLElement)?.closest?.(
          'input,textarea,[contenteditable="true"]',
        )
      )
        setOption(false);
    };
    window.addEventListener("blur", blur);
    window.addEventListener("focusin", focus);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("focusin", focus);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);
  useEffect(() => {
    const el = stage.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoom(Math.exp(-e.deltaY * 0.008), local(e));
      else setViewport((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [size]);
  useEffect(() => {
    if (editing || tool !== "select" || menu) setOption(false);
  }, [editing, tool, menu, space]);
  const createNode = (kind: Tool, p: XY): SceneNode => ({
    id: uid(),
    type: kind as SceneNode["type"],
    name:
      kind === "frame"
        ? "Frame"
        : kind === "rectangle"
          ? "Rectangle"
          : kind === "ellipse"
            ? "Ellipse"
            : "Text",
    parentId: docRef.current.rootId,
    children: [],
    transform: [1, 0, 0, 1, p.x, p.y],
    width: kind === "text" ? 180 : 1,
    height: kind === "text" ? 40 : 1,
    fill: {
      type: "solid",
      color:
        kind === "text" ? "#242331" : kind === "frame" ? "#FFFFFF" : "#A8A0F6",
    },
    opacity: 1,
    radius: kind === "rectangle" ? 12 : 0,
    clipContent: kind === "frame",
    visible: true,
    locked: false,
    layout: { mode: "absolute" },
    ...(kind === "text"
      ? {
          text: {
            content: "새로운 텍스트",
            fontFamily: "Noto Sans KR",
            fontSize: 24,
            fontWeight: 500,
            lineHeight: 32,
            sizing: "auto-height",
            align: "left",
            letterSpacing: 0,
          },
        }
      : {}),
  });
  const onDown = (e: React.PointerEvent) => {
    if (!readyRef.current) return;
    if (editing || e.button === 2) return;
    setHoverPoint(null);
    setGesturing(true);
    const p = local(e),
      w = world(p);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (space || e.button === 1) {
      gesture.current = { mode: "pan", p, view: { ...viewRef.current } };
      return;
    }
    if (tool !== "select") {
      const originalSelection = [...selectedRef.current];
      const d = structuredClone(docRef.current);
      const node = createNode(tool, w);
      d.nodes[node.id] = node;
      d.nodes[d.rootId].children.push(node.id);
      history.current.beginTransaction();
      preview(d);
      sync();
      setSelected([node.id]);
      gesture.current = {
        mode: "create",
        id: node.id,
        p: w,
        base: d,
        originalSelection,
      };
      return;
    }
    const rawHit = hitTest(geometryRef.current, w);
    if (groupScope.current) {
      let ancestor = rawHit;
      while (ancestor && ancestor !== groupScope.current)
        ancestor = docRef.current.nodes[ancestor].parentId;
      if (!ancestor) groupScope.current = null;
    }
    const id = groupHitTarget(docRef.current, rawHit, groupScope.current);
    if (
      !id ||
      id === docRef.current.rootId ||
      id === groupScope.current ||
      (docRef.current.nodes[id].type === "frame" &&
        !selectedRef.current.includes(id))
    ) {
      const originalSelection = [...selectedRef.current];
      gesture.current = {
        mode: "marquee",
        p: w,
        screenStart: p,
        base: geometryRef.current,
        scope: id || groupScope.current || docRef.current.rootId,
        originalSelection,
        additive: e.shiftKey,
        moved: false,
      };
      if (!e.shiftKey) setSelected([]);
      return;
    }
    const originalSelection = [...selectedRef.current];
    const ids = e.shiftKey
      ? selectedRef.current.includes(id)
        ? selectedRef.current.filter((i) => i !== id)
        : [...selectedRef.current, id]
      : selectedRef.current.includes(id)
        ? selectedRef.current
        : [id];
    setSelected(ids);
    if (!ids.length) return;
    if (layoutManaged(docRef.current, ids)) {
      setGesturing(false);
      tell(layoutMessage);
      return;
    }
    history.current.beginTransaction();
    gesture.current = {
      mode: "drag",
      p: w,
      ids: arrangeableRoots(docRef.current, ids),
      base: docRef.current,
      moved: false,
      originalSelection,
      altAtStart: e.altKey,
    };
  };
  const beginTransform = (
    e: React.PointerEvent,
    mode: "resize" | "rotate",
    handle: Handle = handles[4],
  ) => {
    e.stopPropagation();
    if (!readyRef.current || gesture.current || editing || e.button !== 0)
      return;
    if (layoutManaged(docRef.current, selectedRef.current)) {
      tell(layoutMessage);
      return;
    }
    const frame = transformFrame(docRef.current, selectedRef.current);
    if (!frame) return;
    setGesturing(true);
    setHoverPoint(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    history.current.beginTransaction();
    gesture.current = {
      mode,
      handle,
      frame,
      p: world(local(e)),
      base: docRef.current,
    };
  };
  const onMove = (e: React.PointerEvent) => {
    if (!readyRef.current) return;
    setHoverPoint(local(e));
    setOption(
      e.altKey &&
        !document.activeElement?.closest(
          'input,textarea,[contenteditable="true"]',
        ),
    );
    const g = gesture.current;
    if (!g) return;
    g.lastPointer = { clientX: e.clientX, clientY: e.clientY };
    const p = local(e),
      w = world(p);
    if (g.mode === "pan") {
      setViewport({
        ...g.view,
        x: g.view.x + p.x - g.p.x,
        y: g.view.y + p.y - g.p.y,
      });
      return;
    }
    if (g.mode === "marquee") {
      if (
        !g.moved &&
        Math.hypot(p.x - g.screenStart.x, p.y - g.screenStart.y) < 3
      )
        return;
      g.moved = true;
      setMarquee(marqueeBox(g.p, w));
      const hits = marqueeSelection(g.base, g.p, w, g.scope);
      const ids = [
        ...new Set([...(g.additive ? g.originalSelection : []), ...hits]),
      ];
      selectedRef.current = ids;
      setSelected(ids);
      return;
    }
    let changes: Record<string, Partial<SceneNode>> = {};
    if (g.mode === "create") {
      changes[g.id] = {
        transform: [1, 0, 0, 1, Math.min(w.x, g.p.x), Math.min(w.y, g.p.y)],
        width: Math.max(1, Math.abs(w.x - g.p.x)),
        height: Math.max(1, Math.abs(w.y - g.p.y)),
      };
    } else if (g.mode === "resize") {
      const q = point(inverse(g.frame.basis), w);
      const start = point(inverse(g.frame.basis), g.p);
      const handlePoint = {
        x: g.handle.x * g.frame.width + q.x - start.x,
        y: g.handle.y * g.frame.height + q.y - start.y,
      };
      let box = resizeBox(g.frame, g.handle, handlePoint, e.shiftKey, e.altKey);
      // Retain E01 bottom/right snapping where its unconstrained origin contract applies.
      if (
        g.frame.ids.length === 1 &&
        g.handle.key === "se" &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        g.base.nodes[g.frame.ids[0]].type !== "group"
      ) {
        const snapped = snapResize(
          g.base,
          g.frame.ids[0],
          box.width,
          box.height,
          viewRef.current.zoom,
        );
        box = { ...box, width: snapped.width, height: snapped.height };
        setSnapGuides(snapped.guides);
      } else setSnapGuides([]);
      preview(resizeSelection(g.base, g.frame, box));
      sync();
      return;
    } else if (g.mode === "rotate") {
      preview(
        rotateSelection(
          g.base,
          g.frame,
          rotationDelta(g.frame, g.p, w, e.shiftKey),
        ),
      );
      sync();
      return;
    } else {
      let dx = w.x - g.p.x,
        dy = w.y - g.p.y;
      if (!g.moved) {
        // Sample Alt/Option at pointerdown or the first real movement only.
        // Latch the choice for the gesture; releasing Alt never changes the source.
        if (Math.abs(dx) + Math.abs(dy) <= 1) return;
        g.moved = true;
        if (g.altAtStart || e.altKey) {
          const copied = duplicateNodes(g.base, g.ids);
          g.base = copied.document;
          g.ids = copied.ids;
          selectedRef.current = copied.ids;
          setSelected(copied.ids);
        }
      }
      const snapped =
        e.altKey || e.metaKey
          ? { dx, dy, guides: [] }
          : snapMove(g.base, g.ids, dx, dy, viewRef.current.zoom);
      dx = snapped.dx;
      dy = snapped.dy;
      setSnapGuides(snapped.guides);
      g.ids.forEach((id: string) => {
        const n = g.base.nodes[id];
        if (isLocked(g.base, id)) return;
        const m = n.parentId
          ? inverse(getWorldTransform(g.base, n.parentId))
          : ([1, 0, 0, 1, 0, 0] as Matrix);
        const tr = [...n.transform] as Matrix;
        tr[4] += m[0] * dx + m[2] * dy;
        tr[5] += m[1] * dx + m[3] * dy;
        changes[id] = { transform: tr };
      });
    }
    preview(updateNodes(g.base, changes));
    sync();
  };
  modifierMove.current = (e) => {
    const g = gesture.current;
    if (!g?.lastPointer || !["drag", "resize", "rotate"].includes(g.mode))
      return;
    onMove({
      ...g.lastPointer,
      altKey: e.altKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    } as React.PointerEvent);
  };
  const onUp = () => {
    setGesturing(false);
    setSnapGuides([]);
    setMarquee(null);
    const g = gesture.current;
    if (!g) return;
    if (g.mode === "marquee" && !g.moved && g.scope !== docRef.current.rootId) {
      setSelected(
        g.additive
          ? [...new Set([...g.originalSelection, g.scope])]
          : [g.scope],
      );
    }
    if (g.mode !== "pan" && g.mode !== "marquee") {
      if (g.mode === "create") {
        const n = history.current.document.nodes[g.id];
        if (n.width < 4 && n.height < 4) {
          preview(
            updateNodes(history.current.document, {
              [g.id]: {
                width: n.type === "text" ? 180 : n.type === "frame" ? 320 : 120,
                height: n.type === "text" ? 40 : n.type === "frame" ? 560 : 120,
              },
            }),
            true,
          );
        }
      }
      if (
        g.mode === "drag" &&
        g.moved &&
        g.lastPointer &&
        !layoutManaged(geometryRef.current, [
          hitTest(geometryRef.current, world(local(g.lastPointer))) ?? "",
        ])
      ) {
        preview(
          reparentCanvasDrop(
            history.current.document,
            g.ids,
            world(local(g.lastPointer)),
          ),
          true,
        );
      }
      history.current.commitTransaction();
      sync();
      if (g.mode === "create") setTool("select");
    }
    gesture.current = null;
  };
  const beginText = (id: string) => {
    const n = docRef.current.nodes[id];
    if (n?.type === "text" && !isLocked(docRef.current, id)) {
      setSelected([id]);
      setTextDraft(n.text!.content);
      setEditing(id);
    }
  };
  const commitText = () => {
    if (!editing) return;
    const n = docRef.current.nodes[editing];
    if (n && n.text && textDraft !== n.text.content)
      patch({ [editing]: { text: { ...n.text, content: textDraft } } });
    setEditing(null);
  };
  const uploadImage = async (file: File) => {
    if (!readyRef.current) return;
    const epoch = documentEpoch.current;
    if (file.type !== "image/png") {
      tell("PNG 이미지만 지원합니다. PNG 파일을 선택해 주세요.");
      return;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      // File decoding can finish while a new pointer gesture is previewing.
      if (epoch !== documentEpoch.current) return;
      // Commit the asset against the last committed scene, never that preview.
      cancel();
      const d = structuredClone(docRef.current),
        assetId = uid(),
        n = createNode(
          "rectangle",
          world({ x: size.width / 2 - 120, y: size.height / 2 - 120 }),
        );
      n.type = "image";
      n.name = file.name;
      n.assetId = assetId;
      n.width = Math.min(400, img.naturalWidth);
      n.height = (n.width * img.naturalHeight) / img.naturalWidth;
      n.fill = { type: "none" };
      d.assets[assetId] = {
        id: assetId,
        mimeType: "image/png",
        dataUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
      d.nodes[n.id] = n;
      d.nodes[d.rootId].children.push(n.id);
      execute(d);
      setSelected([n.id]);
      tell("PNG 이미지를 추가했습니다.");
    } catch {
      tell("이미지를 읽을 수 없습니다. 올바른 PNG 파일인지 확인해 주세요.");
    }
  };
  const importDoc = async (file: File) => {
    if (!readyRef.current) return;
    const epoch = documentEpoch.current;
    try {
      const d = parseDocument(await file.text());
      if (epoch !== documentEpoch.current) return;
      if (localDraft.documents.some((other) => other.id === d.id)) d.id = uid();
      documentEpoch.current++;
      groupScope.current = null;
      cancel();
      history.current = new DocumentHistory(d);
      sync();
      setSelected([]);
      setEditing(null);
      setHoverPoint(null);
      setSpace(false);
      tell("문서를 불러왔습니다.");
      setTimeout(fit, 50);
    } catch (e) {
      tell(
        "불러오기 실패: " +
          (e instanceof Error ? e.message : "잘못된 문서입니다."),
      );
    }
  };
  const save = () => {
    download(
      new Blob([serializeDocument(history.current.committedDocument)], {
        type: "application/json",
      }),
      "draftroom-document.json",
    );
    tell("문서를 JSON 파일로 저장했습니다.");
  };
  const [webPreview, setWebPreview] = useState<WebExport | null>(null);
  const webFrame =
    selected.length === 1 && doc.nodes[selected[0]]?.type === "frame"
      ? selected[0]
      : null;
  const openWebPreview = async () => {
    if (!webFrame || exporting) return;
    setMenu(false);
    setExporting(true);
    const snapshot = history.current.committedDocument;
    try {
      await ensureFonts();
      const font = await embeddedWebFont();
      setWebPreview(await prepareFrameWeb(snapshot, webFrame, font));
    } catch (error) {
      tell(
        "웹 미리보기 실패: " +
          (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      setExporting(false);
    }
  };
  const doExport = async (kind: "svg" | "png") => {
    if (exporting) return;
    setMenu(false);
    setExporting(true);
    try {
      if (kind === "svg")
        download(
          new Blob([exportSvg(geometryRef.current)], { type: "image/svg+xml" }),
          "draftroom-design.svg",
        );
      else
        download(
          await exportPng(geometryRef.current, pngScale),
          `draftroom-design@${pngScale}x.png`,
        );
      tell(kind.toUpperCase() + " 내보내기를 완료했습니다.");
    } catch (e) {
      tell("내보내기 실패: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setExporting(false);
    }
  };
  const managedSelection = layoutManaged(doc, selected);
  const arrangementCount = arrangeableRoots(doc, selected).length;
  const arrangementBusy =
    !readyRef.current || !!editing || gesturing || managedSelection;
  const distributionAvailable = {
    x: canDistribute(doc, selected, "x"),
    y: canDistribute(doc, selected, "y"),
  };
  const distributionBlocked =
    arrangementCount >= 3
      ? [!distributionAvailable.x && "가로", !distributionAvailable.y && "세로"]
          .filter(Boolean)
          .join("·")
      : "";
  const alignmentOptions = [
    ["left", "왼쪽 정렬", AlignHorizontalJustifyStart],
    ["center-x", "가로 중앙 정렬", AlignHorizontalJustifyCenter],
    ["right", "오른쪽 정렬", AlignHorizontalJustifyEnd],
    ["top", "위쪽 정렬", AlignVerticalJustifyStart],
    ["center-y", "세로 중앙 정렬", AlignVerticalJustifyCenter],
    ["bottom", "아래쪽 정렬", AlignVerticalJustifyEnd],
  ] as const;
  const n = selected.length === 1 ? doc.nodes[selected[0]] : null;
  const displayText = n?.styleRefs?.text ? geometry.nodes[n.id].text : n?.text;
  let layoutGroupAncestor = n?.parentId;
  let layoutInGroup = false;
  while (layoutGroupAncestor) {
    const ancestor = doc.nodes[layoutGroupAncestor];
    if (ancestor.type === "group") layoutInGroup = true;
    layoutGroupAncestor = ancestor.parentId;
  }
  const b = bounds(
    geometry,
    selected.filter((id) => {
      let node: SceneNode | undefined = doc.nodes[id];
      while (node) {
        if (!node.visible) return false;
        node = node.parentId ? doc.nodes[node.parentId] : undefined;
      }
      return Boolean(doc.nodes[id]);
    }),
  );
  // Ignore selection roots and their descendants, while retaining an ancestor
  // frame as a target. Core hit testing keeps clipping, shapes and lock rules.
  const ignored = new Set(roots(selected, doc));
  const targetId =
    option &&
    hoverPoint &&
    b &&
    tool === "select" &&
    !editing &&
    !menu &&
    !space &&
    !gesturing
      ? hitTest(geometry, world(hoverPoint), ignored)
      : null;
  const targetBounds = targetId ? bounds(geometry, [targetId]) : null;
  const measurements = b && targetBounds ? measureBounds(b, targetBounds) : [];
  const editable = !!n && !isLocked(doc, n.id);
  const transformBounds = managedSelection
    ? null
    : transformFrame(geometry, selected);
  // Leave the center available for dragging even when zoom makes the box tiny.
  const handleSize = transformBounds
    ? Math.max(
        2,
        Math.min(
          12,
          (Math.hypot(transformBounds.basis[0], transformBounds.basis[1]) *
            transformBounds.width *
            viewport.zoom) /
            3,
          (Math.hypot(transformBounds.basis[2], transformBounds.basis[3]) *
            transformBounds.height *
            viewport.zoom) /
            3,
        ),
      )
    : 12;
  const transformBusy = !readyRef.current || !!editing || gesturing;
  const resizeNumeric = (axis: "width" | "height", value: number) => {
    if (
      managedSelection &&
      n &&
      editable &&
      !transformBusy &&
      (n.layout?.[axis] ?? "fixed") === "fixed"
    ) {
      updateOne({ [axis]: Math.max(1, value) });
      return;
    }
    if (!transformBounds || transformBusy) return;
    execute(
      resizeSelection(doc, transformBounds, {
        x: 0,
        y: 0,
        width: transformBounds.width,
        height: transformBounds.height,
        [axis]: Math.max(8, value),
      }),
    );
  };
  const rotateNumeric = (value: number) => {
    if (transformBounds && !transformBusy)
      execute(
        rotateSelection(
          doc,
          transformBounds,
          value - frameRotation(transformBounds),
        ),
      );
  };
  const field = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    disabled = false,
  ) => (
    <label className="number-field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        value={Math.round(value * 100) / 100}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber))
            onChange(e.target.valueAsNumber);
        }}
      />
    </label>
  );
  const updateOne = (change: Partial<SceneNode>) => {
    if (!n) return;
    if (change.text && n.styleRefs?.text) {
      // Content remains local; typography is changed through its shared style.
      const { content, sizing } = change.text;
      change = { ...change, text: { ...n.text!, content, sizing } };
    }
    patch({ [n.id]: change });
  };
  const tree = (id: string, depth = 0): React.ReactNode => {
    const node = doc.nodes[id];
    if (!node) return null;
    const Icon = iconFor(node.type);
    const active = selected.includes(id);
    return (
      <div key={id}>
        <div
          className={
            "layer " +
            (active ? "selected " : "") +
            (!node.visible ? "is-hidden" : "") +
            (layerDrop?.id === id ? " drop-" + layerDrop.zone : "")
          }
          style={{ paddingLeft: 12 + depth * 15 }}
          onClick={(e) =>
            setSelected(
              e.shiftKey
                ? selected.includes(id)
                  ? selected.filter((i) => i !== id)
                  : [...selected, id]
                : [id],
            )
          }
          onDoubleClick={() => {
            if (node.type === "group") groupScope.current = id;
            else beginText(id);
          }}
          draggable={
            !isLocked(doc, id) &&
            !editing &&
            !gesturing &&
            localDraft.ready &&
            !layoutManaged(doc, selected.includes(id) ? selected : [id])
          }
          onDragStart={(e) => {
            if (
              (e.target as HTMLElement).closest("button") ||
              gesture.current ||
              layoutManaged(
                docRef.current,
                selected.includes(id) ? selected : [id],
              )
            ) {
              e.preventDefault();
              return;
            }
            layerDrag.current = selected.includes(id) ? selected : [id];
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", id);
          }}
          onDragOver={(e) => {
            if (!layerDrag.current.length) return;
            e.preventDefault();
            const box = e.currentTarget.getBoundingClientRect(),
              ratio = (e.clientY - box.y) / box.height;
            const zone =
              ["frame", "group"].includes(node.type) &&
              ratio > 0.25 &&
              ratio < 0.75
                ? "inside"
                : ratio < 0.5
                  ? "before"
                  : "after";
            setLayerDrop({ id, zone });
          }}
          onDragEnd={() => {
            layerDrag.current = [];
            setLayerDrop(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (!layerDrop || layerDrop.id !== id || !layerDrag.current.length)
              return;
            const parent = layerDrop.zone === "inside" ? id : node.parentId!;
            if (layoutManaged(docRef.current, [parent])) {
              tell(layoutMessage);
              setLayerDrop(null);
              layerDrag.current = [];
              return;
            }
            const index =
              layerDrop.zone === "inside"
                ? doc.nodes[parent].children.length
                : doc.nodes[parent].children.indexOf(id) +
                  (layerDrop.zone === "after" ? 1 : 0);
            const next = moveLayers(
              docRef.current,
              layerDrag.current,
              parent,
              index,
            );
            if (next !== docRef.current) {
              execute(next);
              setSelected(layerDrag.current);
              setCollapsed((c) => {
                const n = new Set(c);
                n.delete(parent);
                return n;
              });
            }
            layerDrag.current = [];
            setLayerDrop(null);
          }}
          data-testid={"layer-" + id}
        >
          <button
            className={"tree-chevron " + (!node.children.length ? "empty" : "")}
            aria-label={node.name + " 펼치기"}
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed((c) => {
                const s = new Set(c);
                s.has(id) ? s.delete(id) : s.add(id);
                return s;
              });
            }}
          >
            {collapsed.has(id) ? (
              <ChevronRight size={12} />
            ) : (
              <ChevronDown size={12} />
            )}
          </button>
          <Icon size={14} />
          <span className="layer-name">{node.name}</span>
          <span className="layer-actions">
            <button
              aria-label={node.name + (node.locked ? " 잠금 해제" : " 잠금")}
              onClick={(e) => {
                e.stopPropagation();
                patch({ [id]: { locked: !node.locked } });
              }}
            >
              {node.locked ? (
                <LockKeyhole size={12} />
              ) : (
                <LockKeyholeOpen size={12} />
              )}
            </button>
            <button
              aria-label={node.name + (node.visible ? " 숨기기" : " 표시")}
              onClick={(e) => {
                e.stopPropagation();
                patch({ [id]: { visible: !node.visible } });
              }}
            >
              {node.visible ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
          </span>
        </div>
      </div>
    );
  };
  const textNode = editing ? geometry.nodes[editing] : null;
  const textMatrix = textNode ? getWorldTransform(geometry, textNode.id) : null;
  return (
    <div className="editor-app">
      <header className="topbar" inert={!readyRef.current || !!webPreview}>
        <div className="brand-mark">
          <span />
          <span />
          <span />
        </div>
        <strong className="brand-name">Draftroom</strong>
        <span className="header-divider" />
        <details ref={libraryPanel} className="document-library">
          <summary>문서 목록</summary>
          <div className="document-library-menu">
            <label>
              로컬 문서
              <select
                aria-label="로컬 문서"
                disabled={libraryBusy}
                value={doc.id}
                onChange={(e) => openDocument(e.target.value)}
              >
                {[doc, ...localDraft.documents].map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <form
              key={doc.id + doc.name}
              onSubmit={(e) => {
                e.preventDefault();
                if (libraryBusy) return;
                try {
                  execute({
                    ...doc,
                    name: checkedName(
                      String(new FormData(e.currentTarget).get("name")),
                    ),
                  });
                } catch (error) {
                  tell((error as Error).message);
                }
              }}
            >
              <input
                name="name"
                aria-label="문서 이름"
                defaultValue={doc.name}
                maxLength={200}
                disabled={libraryBusy}
              />
              <button disabled={libraryBusy}>이름 변경</button>
            </form>
            <button
              disabled={libraryBusy}
              onClick={() =>
                changeDocument(newDocument(), [
                  ...localDraft.documents,
                  history.current.committedDocument,
                ])
              }
            >
              새 문서
            </button>
            <button
              disabled={libraryBusy}
              onClick={() =>
                changeDocument(
                  duplicateDocument(history.current.committedDocument),
                  [...localDraft.documents, history.current.committedDocument],
                )
              }
            >
              문서 복제
            </button>
            <button
              disabled={libraryBusy}
              onClick={() => {
                if (
                  !window.confirm(
                    `“${doc.name}” 문서를 삭제할까요? JSON 백업이 없으면 복구할 수 없습니다.`,
                  )
                )
                  return;
                const [next, ...others] = localDraft.documents;
                changeDocument(next ?? newDocument(), others);
              }}
            >
              문서 삭제
            </button>
            <small>
              {serverStorage
                ? "개인 서버에 저장됩니다."
                : "이 브라우저·주소에 저장됩니다."}{" "}
              문서 전환 시 Undo 기록을 비웁니다.
            </small>
          </div>
        </details>
        <div className="document-title">
          <span className="document-dot" />
          <span>{doc.name}</span>
          <span className="file-badge">T0</span>
        </div>
        <span
          data-testid="asset-status"
          role="status"
          data-state={
            Object.values(doc.assets).some((a) => a.missing)
              ? "missing"
              : saveStatus === "saving"
                ? "uploading"
                : ["error", "conflict"].includes(saveStatus)
                  ? "unconfirmed"
                  : "referenced"
          }
          title="이미지 업로드는 문서 저장과 함께 서버에서 확정됩니다. 누락 시 원본 PNG를 다시 추가해 주세요."
        >
          {Object.values(doc.assets).some((a) => a.missing)
            ? `이미지 누락 ${Object.values(doc.assets).filter((a) => a.missing).length}개`
            : `이미지 ${Object.keys(doc.assets).length}개${saveStatus === "saving" ? " 저장 중…" : ["error", "conflict"].includes(saveStatus) ? " · 저장 미확정" : ""}`}
        </span>
        <div className="topbar-spacer" />
        <span
          className="local-indicator"
          data-testid="save-status"
          data-state={saveStatus}
          aria-live="polite"
          title={
            serverStorage
              ? "서버가 저장을 확인한 뒤 저장됨을 표시합니다. 브라우저 초안은 자동 이전하지 않습니다."
              : "현재 URL의 브라우저 저장소에만 저장됩니다. 다른 기기·브라우저·URL과 공유되지 않으며 서버로 전송하지 않습니다."
          }
        >
          <span />
          {
            {
              loading: "초안 불러오는 중",
              idle: serverStorage
                ? "서버 문서 · 편집 대기"
                : "브라우저 초안 · 편집 대기",
              editing: "편집 중 · 완료 후 저장",
              saving: serverStorage ? "서버에 저장 중…" : "브라우저에 저장 중…",
              saved: serverStorage ? "서버에 저장됨" : "브라우저에 저장됨",
              error: "자동 저장 오류",
              conflict: "다른 탭과 저장 충돌",
            }[saveStatus]
          }
        </span>
        {ownerSession && (
          <button
            className="header-button"
            disabled={!["idle", "saved"].includes(saveStatus) || uncommitted}
            title="저장이 끝난 뒤 로그아웃할 수 있습니다. 저장 오류 시 JSON으로 백업하세요."
            onClick={() => void ownerSession.logout()}
          >
            로그아웃
          </button>
        )}
        <div className="history-buttons">
          <button
            title="실행 취소 · ⌘Z"
            aria-label="실행 취소"
            disabled={!history.current.canUndo}
            onClick={undo}
          >
            <Undo2 size={16} />
          </button>
          <button
            title="다시 실행 · ⇧⌘Z"
            aria-label="다시 실행"
            disabled={!history.current.canRedo}
            onClick={redo}
          >
            <Redo2 size={16} />
          </button>
        </div>
        <button
          className="header-button import-button"
          onClick={() => importInput.current?.click()}
        >
          <Upload size={14} />
          <span>불러오기</span>
        </button>
        <button className="header-button" onClick={save}>
          <Download size={14} />
          <span>JSON 저장</span>
        </button>
        <div className="export-wrap">
          <button
            className="export-button"
            disabled={exporting}
            onClick={() => setMenu(!menu)}
          >
            내보내기
            <ChevronDown size={13} />
          </button>
          {menu && (
            <div className="export-menu">
              <button disabled={!webFrame} onClick={openWebPreview}>
                선택 frame 웹 미리보기
              </button>
              {!webFrame && (
                <div className="export-size">frame 하나를 선택하세요.</div>
              )}
              <button onClick={() => doExport("svg")}>
                SVG 벡터 파일
                <ArrowUpRight size={14} />
              </button>
              <label className="export-scale">
                PNG 배율
                <select
                  aria-label="PNG 배율"
                  value={pngScale}
                  onChange={(e) => setPngScale(Number(e.target.value))}
                >
                  {[1, 2, 3, 4].map((scale) => (
                    <option key={scale} value={scale}>
                      {scale}x
                    </option>
                  ))}
                </select>
              </label>
              <div className="export-size" aria-live="polite">
                {Math.ceil(doc.nodes[doc.rootId].width * pngScale)} ×{" "}
                {Math.ceil(doc.nodes[doc.rootId].height * pngScale)} px
              </div>
              <button onClick={() => doExport("png")}>
                PNG 이미지 ({pngScale}x)
                <ArrowUpRight size={14} />
              </button>
            </div>
          )}
        </div>
      </header>
      {localDraft.detail && (
        <div className="draft-notice" role="alert">
          <span>{localDraft.detail}</span>
          {localDraft.canRetry && (
            <button onClick={localDraft.retry}>저장 재시도</button>
          )}
        </div>
      )}
      {webPreview && (
        <div className="web-preview-backdrop">
          <section
            className="web-preview"
            role="dialog"
            aria-modal="true"
            aria-label="Frame 웹 미리보기"
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setWebPreview(null);
              if (e.key === "Tab") {
                const controls = [
                  ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button",
                  ),
                ];
                const index = controls.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                if (
                  (e.shiftKey && index <= 0) ||
                  (!e.shiftKey && index === controls.length - 1)
                ) {
                  e.preventDefault();
                  controls[e.shiftKey ? controls.length - 1 : 0]?.focus();
                }
              }
            }}
          >
            <div className="web-preview-actions">
              <strong>
                HTML/CSS · {webPreview.width} × {webPreview.height}
              </strong>
              <button
                onClick={() =>
                  download(
                    new Blob([webPreview.html], { type: "text/html" }),
                    "draftroom-frame.html",
                  )
                }
              >
                HTML 다운로드
              </button>
              <button
                onClick={() =>
                  download(
                    new Blob([webPreview.css], { type: "text/css" }),
                    "draftroom-frame.css",
                  )
                }
              >
                CSS 다운로드
              </button>
              <button autoFocus onClick={() => setWebPreview(null)}>
                미리보기 닫기
              </button>
            </div>
            <ul>
              {webPreview.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <div className="web-preview-scroll">
              <iframe
                title="Frame HTML 미리보기"
                sandbox=""
                srcDoc={webPreview.html}
                style={{ width: webPreview.width, height: webPreview.height }}
              />
            </div>
          </section>
        </div>
      )}
      <div className="workspace" inert={!readyRef.current || !!webPreview}>
        <aside className="layers-panel">
          <div className="panel-tabs">
            <span className="active">레이어</span>
            <span className="panel-heading-icon">
              <Layers size={15} />
            </span>
          </div>
          <div className="page-tabs" role="tablist" aria-label="페이지">
            {pageIds(doc).map((id) => (
              <button
                key={id}
                role="tab"
                aria-selected={id === doc.rootId}
                disabled={libraryBusy}
                onClick={() => {
                  if (id !== doc.rootId)
                    changeDocument(
                      switchPage(history.current.committedDocument, id),
                      localDraft.documents,
                    );
                }}
              >
                {doc.nodes[id].name}
              </button>
            ))}
          </div>
          <div className="page-actions">
            <button
              aria-label="페이지 추가"
              disabled={libraryBusy}
              onClick={() => {
                execute(addPage(doc));
                setSelected([]);
                setCollapsed(new Set());
              }}
            >
              +
            </button>
            <form
              key={doc.rootId + doc.nodes[doc.rootId].name}
              onSubmit={(e) => {
                e.preventDefault();
                if (libraryBusy) return;
                try {
                  execute(
                    renamePage(
                      doc,
                      String(new FormData(e.currentTarget).get("pageName")),
                    ),
                  );
                } catch (error) {
                  tell((error as Error).message);
                }
              }}
            >
              <input
                aria-label="페이지 이름"
                name="pageName"
                defaultValue={doc.nodes[doc.rootId].name}
                disabled={libraryBusy}
                maxLength={200}
              />
              <button disabled={libraryBusy}>변경</button>
            </form>
            <button
              aria-label="페이지 삭제"
              disabled={libraryBusy || pageIds(doc).length < 2}
              onClick={() => {
                if (window.confirm("현재 페이지와 모든 레이어를 삭제할까요?")) {
                  execute(removePage(doc));
                  setSelected([]);
                }
              }}
            >
              ×
            </button>
          </div>
          <div className="layers-label">
            레이어 <span>{Object.keys(doc.nodes).length - 1}</span>
          </div>
          <div
            className="layer-tree"
            ref={layerTree}
            onScroll={(e) => setLayerScroll(e.currentTarget.scrollTop)}
          >
            <div style={{ height: rowWindow.start * LAYER_ROW_HEIGHT }} />
            {rows
              .slice(rowWindow.start, rowWindow.end)
              .map(({ id, depth }) => tree(id, depth))}
            <div
              style={{
                height: (rows.length - rowWindow.end) * LAYER_ROW_HEIGHT,
              }}
            />
          </div>
          <div className="left-footer">
            <span className="mini-mark">D</span>
            <div>
              <strong>당신의 다음 아이디어</strong>
              <span>자유롭게 그리고, 파일로 간직하세요.</span>
            </div>
          </div>
        </aside>
        <main className="canvas-area">
          <div className="canvas-topline">
            <span>
              <span className="breadcrumb">워크스페이스</span>
              <ChevronRight size={12} />
              {doc.nodes[doc.rootId].name}
            </span>
            <a href="/bench.html" target="_blank" rel="noreferrer">
              <FlaskConical size={13} />
              성능 실험
              <ArrowUpRight size={12} />
            </a>
          </div>
          <div
            ref={stage}
            className={
              "canvas-stage " +
              (space ? "panning" : tool !== "select" ? "drawing" : "")
            }
            data-testid="canvas-stage"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={cancel}
            onPointerLeave={() => setHoverPoint(null)}
            onDoubleClick={(e) => {
              const raw = hitTest(geometryRef.current, world(local(e)));
              const id = groupHitTarget(
                docRef.current,
                raw,
                groupScope.current,
              );
              if (id && docRef.current.nodes[id].type === "group") {
                groupScope.current = id;
                const child = groupHitTarget(docRef.current, raw, id);
                setSelected(child && child !== id ? [child] : []);
              } else if (id) beginText(id);
            }}
          >
            <div className="renderer-surface">
              <SceneRenderer
                document={geometry}
                viewport={viewport}
                width={size.width}
                height={size.height}
                renderer={renderer}
                onError={(error: any) =>
                  setRenderError(String(error?.message || error))
                }
              />
            </div>
            <svg
              className="selection-overlay"
              width={size.width}
              height={size.height}
            >
              {marquee && (
                <rect
                  data-testid="marquee"
                  className="marquee"
                  x={marquee.x * viewport.zoom + viewport.x}
                  y={marquee.y * viewport.zoom + viewport.y}
                  width={marquee.width * viewport.zoom}
                  height={marquee.height * viewport.zoom}
                />
              )}
              {doc.nodes[doc.rootId].children
                .filter(
                  (id) =>
                    doc.nodes[id].type === "frame" && doc.nodes[id].visible,
                )
                .map((id) => {
                  const box = bounds(geometry, [id])!;
                  return (
                    <text
                      key={id}
                      x={box.x * viewport.zoom + viewport.x}
                      y={box.y * viewport.zoom + viewport.y - 12}
                      className={
                        selected.includes(id)
                          ? "frame-label active"
                          : "frame-label"
                      }
                    >
                      {doc.nodes[id].name}
                    </text>
                  );
                })}
              {transformBounds && !editing && (
                <polygon
                  data-testid="transform-outline"
                  points={[
                    [0, 0],
                    [transformBounds.width, 0],
                    [transformBounds.width, transformBounds.height],
                    [0, transformBounds.height],
                  ]
                    .map(([x, y]) => {
                      const p = point(transformBounds.basis, { x, y });
                      return `${p.x * viewport.zoom + viewport.x},${p.y * viewport.zoom + viewport.y}`;
                    })
                    .join(" ")}
                  fill="none"
                  stroke="#7c5cf5"
                  strokeWidth="1.25"
                />
              )}
              {b && !editing && (
                <g>
                  <rect
                    x={b.x * viewport.zoom + viewport.x}
                    y={b.y * viewport.zoom + viewport.y}
                    width={b.width * viewport.zoom}
                    height={b.height * viewport.zoom}
                    fill="none"
                    stroke="#7c5cf5"
                    strokeWidth="1.25"
                    opacity={transformBounds ? 0.25 : 1}
                  />
                  {!transformBounds &&
                    [
                      [0, 0],
                      [1, 0],
                      [0, 1],
                      [1, 1],
                    ].map(([x, y], i) => (
                      <rect
                        key={i}
                        x={(b.x + b.width * x) * viewport.zoom + viewport.x - 3}
                        y={
                          (b.y + b.height * y) * viewport.zoom + viewport.y - 3
                        }
                        width="6"
                        height="6"
                        fill="white"
                        stroke="#7c5cf5"
                      />
                    ))}
                </g>
              )}
            </svg>
            {targetId && targetBounds && measurements.length > 0 && (
              <svg
                className="measurement-overlay"
                data-testid="measurement-overlay"
                data-target-id={targetId}
                width={size.width}
                height={size.height}
                aria-label="선택 항목과 가리킨 레이어의 간격"
              >
                <rect
                  x={targetBounds.x * viewport.zoom + viewport.x}
                  y={targetBounds.y * viewport.zoom + viewport.y}
                  width={targetBounds.width * viewport.zoom}
                  height={targetBounds.height * viewport.zoom}
                  fill="none"
                  stroke="#e5484d"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
                {measurements.map((line, i) => {
                  const x1 = line.start.x * viewport.zoom + viewport.x,
                    y1 = line.start.y * viewport.zoom + viewport.y,
                    x2 = line.end.x * viewport.zoom + viewport.x,
                    y2 = line.end.y * viewport.zoom + viewport.y;
                  const label = `${Math.round(line.value * 100) / 100} px`,
                    lx = (x1 + x2) / 2 + (line.axis === "y" ? 16 : 0),
                    ly = (y1 + y2) / 2 - (line.axis === "x" ? 10 : 0),
                    labelWidth = label.length * 6.5 + 10;
                  return (
                    <g
                      key={i}
                      data-testid="measurement-guide"
                      data-axis={line.axis}
                      data-value={line.value}
                    >
                      <path d={`M${x1},${y1} L${x2},${y2}`} />
                      <path
                        d={
                          line.axis === "x"
                            ? `M${x1},${y1 - 4} v8 M${x2},${y2 - 4} v8`
                            : `M${x1 - 4},${y1} h8 M${x2 - 4},${y2} h8`
                        }
                      />
                      <rect
                        x={lx - labelWidth / 2}
                        y={ly - 9}
                        width={labelWidth}
                        height={18}
                        rx={4}
                      />
                      <text
                        data-testid="measurement-label"
                        x={lx}
                        y={ly}
                        dominantBaseline="central"
                        textAnchor="middle"
                      >
                        {label}
                      </text>
                    </g>
                  );
                })}
              </svg>
            )}
            {gesturing && snapGuides.length > 0 && (
              <svg
                className="measurement-overlay"
                data-testid="snap-overlay"
                width={size.width}
                height={size.height}
                aria-label="스마트 정렬선"
              >
                {snapGuides.map((guide, i) => (
                  <line
                    key={i}
                    data-testid="snap-guide"
                    data-axis={guide.axis}
                    data-target-id={guide.targetId}
                    x1={guide.start.x * viewport.zoom + viewport.x}
                    y1={guide.start.y * viewport.zoom + viewport.y}
                    x2={guide.end.x * viewport.zoom + viewport.x}
                    y2={guide.end.y * viewport.zoom + viewport.y}
                    stroke="#e5484d"
                    strokeWidth="1"
                  />
                ))}
              </svg>
            )}
            {transformBounds &&
              !editing &&
              tool === "select" &&
              handles.map((handle) => {
                const p = point(transformBounds.basis, {
                  x: handle.x * transformBounds.width,
                  y: handle.y * transformBounds.height,
                });
                return (
                  <button
                    key={handle.key}
                    className="resize-handle"
                    data-testid={`resize-${handle.key}`}
                    aria-label={`${handle.label} 크기 조절`}
                    style={{
                      left: p.x * viewport.zoom + viewport.x - handleSize / 2,
                      top: p.y * viewport.zoom + viewport.y - handleSize / 2,
                      width: handleSize,
                      height: handleSize,
                      cursor: handle.cursor,
                    }}
                    onPointerDown={(e) => beginTransform(e, "resize", handle)}
                    onPointerMove={(e) => {
                      e.stopPropagation();
                      onMove(e);
                    }}
                    onPointerUp={(e) => {
                      e.stopPropagation();
                      onUp();
                    }}
                  />
                );
              })}
            {transformBounds &&
              !editing &&
              tool === "select" &&
              (() => {
                const top = point(transformBounds.basis, {
                  x: transformBounds.width / 2,
                  y: 0,
                });
                const center = point(transformBounds.basis, {
                  x: transformBounds.width / 2,
                  y: transformBounds.height / 2,
                });
                const length =
                  Math.hypot(top.x - center.x, top.y - center.y) || 1;
                const x =
                  top.x * viewport.zoom +
                  viewport.x +
                  ((top.x - center.x) / length) * 28;
                const y =
                  top.y * viewport.zoom +
                  viewport.y +
                  ((top.y - center.y) / length) * 28;
                return (
                  <button
                    className="resize-handle rotation-handle"
                    aria-label="회전"
                    data-testid="rotate-handle"
                    style={{
                      left: x - 6,
                      top: y - 6,
                      cursor: "grab",
                      borderRadius: "50%",
                    }}
                    onPointerDown={(e) => beginTransform(e, "rotate")}
                    onPointerMove={(e) => {
                      e.stopPropagation();
                      onMove(e);
                    }}
                    onPointerUp={(e) => {
                      e.stopPropagation();
                      onUp();
                    }}
                  />
                );
              })()}
            {textNode && textMatrix && (
              <textarea
                ref={textarea}
                className="text-editor"
                aria-label="텍스트 직접 편집"
                value={textDraft}
                style={{
                  left: viewport.x + textMatrix[4] * viewport.zoom,
                  top: viewport.y + textMatrix[5] * viewport.zoom,
                  width: textNode.width,
                  height: Math.max(textNode.height, 60),
                  transform: `matrix(${textMatrix[0] * viewport.zoom},${textMatrix[1] * viewport.zoom},${textMatrix[2] * viewport.zoom},${textMatrix[3] * viewport.zoom},0,0)`,
                  fontFamily: cssFont(textNode.text!.fontFamily),
                  textAlign: textNode.text!.align ?? "left",
                  letterSpacing: (textNode.text!.letterSpacing ?? 0) + "px",
                  whiteSpace:
                    !textNode.text!.sizing ||
                    textNode.text!.sizing === "auto-width"
                      ? "pre"
                      : "pre-wrap",
                  overflowWrap: "anywhere",
                  border: 0,
                  outline: "1px solid #8c69e8",
                  scrollbarWidth: "none",
                  wordBreak: "break-all",
                  fontSize: textNode.text!.fontSize,
                  fontWeight: textNode.text!.fontWeight,
                  lineHeight: textNode.text!.lineHeight + "px",
                  color:
                    textNode.fill.type === "solid"
                      ? textNode.fill.color
                      : "#222",
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => setTextDraft(e.target.value)}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={() => (composing.current = false)}
                onBlur={commitText}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setEditing(null);
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    commitText();
                  }
                }}
              />
            )}
          </div>
          <div
            className="floating-toolbar"
            role="toolbar"
            aria-label="그리기 도구"
          >
            {(
              [
                { id: "select", icon: MousePointer2, label: "선택", key: "V" },
                { id: "frame", icon: Frame, label: "프레임", key: "F" },
                { id: "rectangle", icon: Square, label: "사각형", key: "R" },
                { id: "ellipse", icon: Circle, label: "타원", key: "O" },
                { id: "text", icon: Type, label: "텍스트", key: "T" },
              ] as const
            ).map(({ id, icon: Icon, label, key }) => (
              <button
                key={id}
                className={tool === id ? "active" : ""}
                title={label + " · " + key}
                aria-label={label + " 도구"}
                aria-pressed={tool === id}
                onClick={() => {
                  setTool(id);
                  setEditing(null);
                }}
              >
                <Icon size={19} />
                {tool === id && <span className="tool-key">{key}</span>}
              </button>
            ))}
            <span className="toolbar-divider" />
            <button
              title="PNG 이미지 추가"
              aria-label="PNG 이미지 추가"
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlus size={19} />
            </button>
          </div>
          <div className="canvas-bottom">
            <span className="canvas-help">
              {selected.length
                ? `${selected.length}개 선택됨 · 방향키 이동 · Option/Alt + 가리키기로 간격`
                : "Space + 드래그로 이동"}
              <span className="help-dot">·</span>
              {tool === "select" ? "V 선택 도구" : "캔버스를 드래그해 그리세요"}
            </span>
            <div className="zoom-controls">
              <button aria-label="축소" onClick={() => zoom(1 / 1.2)}>
                <Minus size={14} />
              </button>
              <span>{Math.round(viewport.zoom * 100)}%</span>
              <button aria-label="확대" onClick={() => zoom(1.2)}>
                <Plus size={14} />
              </button>
              <span className="zoom-divider" />
              <button aria-label="전체 보기" title="전체 보기" onClick={fit}>
                <Maximize size={14} />
              </button>
            </div>
          </div>
        </main>
        <aside className="inspector-panel">
          <div className="panel-tabs">
            <span className="active">디자인</span>
            <SlidersHorizontal size={14} />
          </div>
          <StyleInspector
            key={doc.id}
            document={doc}
            node={n}
            disabled={transformBusy}
            selectionDisabled={!editable}
            onChange={execute}
          />
          {selected.length > 0 && (
            <section
              className="inspector-section arrangement-section"
              data-testid="arrange-controls"
              aria-label="정렬 및 간격"
            >
              <div className="section-title">
                <span>정렬 및 간격</span>
                <span className="property-badge">
                  {arrangementCount}개 대상
                </span>
              </div>
              <div
                className="alignment-buttons"
                role="group"
                aria-label="선택 영역에 정렬"
              >
                {alignmentOptions.map(([mode, label, Icon]) => (
                  <button
                    key={mode}
                    type="button"
                    aria-label={label}
                    title={label}
                    disabled={arrangementBusy || arrangementCount < 2}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => arrange(mode)}
                  >
                    <Icon size={17} aria-hidden="true" />
                  </button>
                ))}
              </div>
              <div
                className="distribution-buttons"
                role="group"
                aria-label="간격 균등 배치"
              >
                {(
                  [
                    [
                      "distribute-x",
                      "가로 간격 균등",
                      AlignHorizontalSpaceBetween,
                    ],
                    [
                      "distribute-y",
                      "세로 간격 균등",
                      AlignVerticalSpaceBetween,
                    ],
                  ] as const
                ).map(([mode, label, Icon]) => (
                  <button
                    key={mode}
                    type="button"
                    aria-label={label}
                    title={
                      arrangementCount >= 3 &&
                      !distributionAvailable[
                        mode === "distribute-x" ? "x" : "y"
                      ]
                        ? `${label} · 양 끝과 순서를 유지할 공간이 부족해요.`
                        : label
                    }
                    disabled={
                      arrangementBusy ||
                      !distributionAvailable[
                        mode === "distribute-x" ? "x" : "y"
                      ]
                    }
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => arrange(mode)}
                  >
                    <Icon size={15} aria-hidden="true" />
                    {label}
                  </button>
                ))}
              </div>
              <p className="arrangement-hint">
                정렬 2개 · 간격 균등 3개 이상
                <br />
                숨김·잠금 제외, 그룹은 하나로 배치해요.
                {distributionBlocked && (
                  <>
                    <br />
                    {distributionBlocked} 간격: 양 끝과 순서를 유지할 공간이
                    부족해요.
                  </>
                )}
              </p>
            </section>
          )}
          {!n && transformBounds && (
            <section className="inspector-section">
              <div className="section-title">선택 변환 · 월드 경계</div>
              <div className="field-grid">
                {field(
                  "W",
                  transformBounds.width,
                  (v) => resizeNumeric("width", v),
                  transformBusy,
                )}
                {field(
                  "H",
                  transformBounds.height,
                  (v) => resizeNumeric("height", v),
                  transformBusy,
                )}
                <RotationDeltaField
                  disabled={transformBusy}
                  onCommit={(value) => {
                    if (transformBounds && !transformBusy)
                      execute(rotateSelection(doc, transformBounds, value));
                  }}
                />
              </div>
              <p className="property-hint">
                Shift: 비율 유지 / 회전 15° · Alt: 중심 기준
              </p>
            </section>
          )}
          {n ? (
            <>
              <section className="inspector-section object-heading">
                <div className="object-icon">
                  {(() => {
                    const Icon = iconFor(n.type);
                    return <Icon size={17} />;
                  })()}
                </div>
                <input
                  aria-label="레이어 이름"
                  disabled={!editable}
                  value={n.name}
                  onChange={(e) => updateOne({ name: e.target.value })}
                />
                <button
                  aria-label="선택 항목 복제"
                  title="복제 · ⌘D"
                  onClick={duplicate}
                >
                  <Copy size={14} />
                </button>
              </section>
              <section className="inspector-section">
                <div className="section-title">
                  컴포넌트{" "}
                  {n.component?.kind === "main"
                    ? "원본"
                    : n.component?.kind === "instance"
                      ? "인스턴스"
                      : ""}
                </div>
                {n.component?.kind === "main" ? (
                  <>
                    <button
                      className="subtle-action"
                      disabled={!editable}
                      onClick={() => {
                        try {
                          const result = createInstance(doc, n.id);
                          execute(result.document);
                          setSelected([result.id]);
                        } catch (e) {
                          tell((e as Error).message);
                        }
                      }}
                    >
                      인스턴스 생성
                    </button>
                    <button
                      className="subtle-action"
                      disabled={!editable}
                      onClick={() => {
                        try {
                          const result = createVariant(doc, n.id);
                          execute(result.document);
                          setSelected([result.id]);
                        } catch (e) {
                          tell((e as Error).message);
                        }
                      }}
                    >
                      Variant 추가
                    </button>
                    {n.component.variant && (
                      <label>
                        Variant 속성 (JSON)
                        <input
                          aria-label="Variant 속성"
                          key={
                            n.id +
                            JSON.stringify(n.component.variant.properties)
                          }
                          defaultValue={JSON.stringify(
                            n.component.variant.properties,
                          )}
                          disabled={!editable}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                          onBlur={(e) => {
                            try {
                              execute(
                                setVariantProperties(
                                  doc,
                                  n.id,
                                  JSON.parse(e.target.value),
                                ),
                              );
                            } catch (err) {
                              tell((err as Error).message);
                              e.target.value = JSON.stringify(
                                n.component?.kind === "main"
                                  ? n.component.variant?.properties
                                  : {},
                              );
                            }
                          }}
                        />
                      </label>
                    )}
                  </>
                ) : n.component?.kind === "instance" ? (
                  <>
                    <p className="property-hint">
                      원본: {doc.nodes[n.component.sourceId]?.name} · override{" "}
                      {Object.values(n.component.overrides).reduce(
                        (sum, paths) => sum + Object.keys(paths).length,
                        0,
                      )}
                      개
                    </p>
                    {variantMembers(doc, n.component.sourceId).length > 0 && (
                      <label>
                        Variant
                        <select
                          aria-label="Variant 전환"
                          value={n.component.sourceId}
                          disabled={!editable}
                          onChange={(e) => {
                            try {
                              execute(switchVariant(doc, n.id, e.target.value));
                            } catch (err) {
                              tell((err as Error).message);
                            }
                          }}
                        >
                          {variantMembers(doc, n.component.sourceId).map(
                            (member) => (
                              <option key={member.id} value={member.id}>
                                {member.component?.kind === "main" &&
                                  Object.entries(
                                    member.component.variant!.properties,
                                  )
                                    .map(([k, v]) => `${k}=${v}`)
                                    .join(", ")}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                    )}
                    <button
                      className="subtle-action"
                      disabled={!editable}
                      onClick={() => execute(detachInstance(doc, n.id))}
                    >
                      인스턴스 분리
                    </button>
                    <button
                      className="subtle-action"
                      disabled={!editable}
                      onClick={() => execute(resetInstanceOverrides(doc, n.id))}
                    >
                      override 초기화
                    </button>
                  </>
                ) : ["frame", "group"].includes(n.type) &&
                  !instanceOwner(doc, n.id) ? (
                  <button
                    className="subtle-action"
                    disabled={!editable}
                    onClick={() => execute(makeComponent(doc, n.id))}
                  >
                    컴포넌트 생성
                  </button>
                ) : null}
                {instanceOwner(doc, n.id) && (
                  <p className="property-hint">
                    속성 수정은 override로 보존됩니다. 내부 구조 변경은
                    인스턴스를 분리한 뒤 사용하세요.
                  </p>
                )}
              </section>
              <section className="inspector-section">
                <div className="section-title">
                  레이아웃
                  <span className="property-badge">
                    {n.layout.mode === "flex"
                      ? "Flex"
                      : n.layout.mode === "grid"
                        ? "Grid"
                        : "Absolute"}
                  </span>
                </div>
                <div className="field-grid">
                  {field(
                    "X",
                    n.transform[4],
                    (v) => {
                      const t = [...n.transform] as Matrix;
                      t[4] = v;
                      updateOne({ transform: t });
                    },
                    !editable ||
                      (["flex", "grid"].includes(
                        doc.nodes[n.parentId ?? ""]?.layout?.mode,
                      ) &&
                        n.layout?.position !== "absolute"),
                  )}
                  {field(
                    "Y",
                    n.transform[5],
                    (v) => {
                      const t = [...n.transform] as Matrix;
                      t[5] = v;
                      updateOne({ transform: t });
                    },
                    !editable ||
                      (["flex", "grid"].includes(
                        doc.nodes[n.parentId ?? ""]?.layout?.mode,
                      ) &&
                        n.layout?.position !== "absolute"),
                  )}
                  {field(
                    "W",
                    n.width,
                    (v) => resizeNumeric("width", v),
                    !editable ||
                      transformBusy ||
                      (n.layout?.width ?? "fixed") !== "fixed" ||
                      (!managedSelection && !transformBounds),
                  )}
                  {field(
                    "H",
                    n.height,
                    (v) => resizeNumeric("height", v),
                    !editable ||
                      transformBusy ||
                      (n.layout?.height ?? "fixed") !== "fixed" ||
                      (!managedSelection && !transformBounds),
                  )}
                </div>
                <div className="field-grid single-row">
                  {field(
                    "모서리",
                    n.radius,
                    (v) => updateOne({ radius: Math.max(0, v) }),
                    !editable || n.type === "group",
                  )}
                  {field(
                    "불투명도",
                    n.opacity * 100,
                    (v) =>
                      updateOne({ opacity: Math.max(0, Math.min(1, v / 100)) }),
                    !editable,
                  )}
                </div>
                {transformBounds &&
                  field(
                    "회전 °",
                    frameRotation(transformBounds),
                    rotateNumeric,
                    transformBusy,
                  )}
                <p className="property-hint">
                  Shift: 비율 유지 / 회전 15° · Alt: 중심 기준
                </p>
              </section>
              <LayoutInspector
                key={"layout-" + n.id}
                node={n}
                computed={geometry.nodes[n.id]}
                parent={doc.nodes[n.parentId ?? ""]}
                disabled={!editable || transformBusy || layoutInGroup}
                onChange={updateOne}
              />
              {layoutInGroup && (
                <p className="property-hint layout-managed-hint">
                  그룹 밖의 프레임에서 Flex/Grid 레이아웃을 설정해 주세요.
                </p>
              )}
              {managedSelection && (
                <p className="property-hint layout-managed-hint">
                  {layoutMessage}
                </p>
              )}
              <PaintInspector
                key={n.id}
                node={n}
                disabled={!editable || !!n.styleRefs?.color}
                onChange={updateOne}
                onInvalid={() => tell("올바른 HEX 색상을 입력해 주세요.")}
              />
              {n.text && (
                <section className="inspector-section">
                  {renderer === "canvaskit" && (
                    <p className="property-hint" role="status">
                      CanvasKit 실험: 브라우저가 글자를 그린 타일을 합성해요.
                      극단적인 확대에서는 선명도가 제한될 수 있어요.
                    </p>
                  )}
                  <div className="section-title">
                    텍스트
                    <Type size={14} />
                  </div>
                  <label className="property-hint">
                    글꼴 패밀리
                    <select
                      aria-label="글꼴 패밀리"
                      disabled={!editable || !!n.styleRefs?.text}
                      value={displayText!.fontFamily}
                      onChange={(e) =>
                        updateOne({
                          text: { ...n.text!, fontFamily: e.target.value },
                        })
                      }
                    >
                      {missingFont(displayText!.fontFamily) && (
                        <option value={displayText!.fontFamily}>
                          {displayText!.fontFamily} (누락)
                        </option>
                      )}
                      {FONT_FAMILIES.map((family) => (
                        <option key={family}>{family}</option>
                      ))}
                    </select>
                  </label>
                  {missingFont(displayText!.fontFamily) && (
                    <p role="status" className="property-hint">
                      누락 글꼴: {displayText!.fontFamily} · Noto Sans KR로 대체
                      표시
                    </p>
                  )}
                  <label className="property-hint">
                    굵기
                    <select
                      aria-label="굵기"
                      disabled={!editable || !!n.styleRefs?.text}
                      value={displayText!.fontWeight}
                      onChange={(e) =>
                        updateOne({
                          text: {
                            ...n.text!,
                            fontWeight: Number(e.target.value),
                          },
                        })
                      }
                    >
                      {![100, 200, 300, 400, 500, 600, 700, 800, 900].includes(
                        displayText!.fontWeight,
                      ) && (
                        <option value={displayText!.fontWeight}>
                          {displayText!.fontWeight}
                        </option>
                      )}
                      {[100, 200, 300, 400, 500, 600, 700, 800, 900].map(
                        (weight) => (
                          <option key={weight} value={weight}>
                            {weight}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label className="property-hint">
                    텍스트 크기 방식
                    <select
                      aria-label="텍스트 크기 방식"
                      disabled={!editable}
                      value={n.text.sizing ?? "legacy"}
                      onChange={(e) =>
                        updateOne({
                          text: {
                            ...n.text!,
                            sizing: e.target.value as
                              "fixed" | "auto-width" | "auto-height",
                          },
                        })
                      }
                    >
                      {!n.text.sizing && (
                        <option value="legacy">기존 개행 유지</option>
                      )}
                      <option value="fixed">고정 폭·높이 (자동 줄바꿈)</option>
                      <option value="auto-width">자동 폭</option>
                      <option value="auto-height">고정 폭·자동 높이</option>
                    </select>
                  </label>
                  <label className="property-hint">
                    텍스트 정렬
                    <select
                      aria-label="텍스트 정렬"
                      disabled={!editable || !!n.styleRefs?.text}
                      value={displayText!.align ?? "left"}
                      onChange={(e) =>
                        updateOne({
                          text: {
                            ...n.text!,
                            align: e.target.value as
                              "left" | "center" | "right",
                          },
                        })
                      }
                    >
                      <option value="left">왼쪽</option>
                      <option value="center">가운데</option>
                      <option value="right">오른쪽</option>
                    </select>
                  </label>
                  <div className="field-grid">
                    {field(
                      "크기",
                      displayText!.fontSize,
                      (v) =>
                        updateOne({
                          text: { ...n.text!, fontSize: Math.max(1, v) },
                        }),
                      !editable || !!n.styleRefs?.text,
                    )}
                    {field(
                      "행간 px",
                      displayText!.lineHeight,
                      (v) =>
                        updateOne({
                          text: { ...n.text!, lineHeight: Math.max(1, v) },
                        }),
                      !editable || !!n.styleRefs?.text,
                    )}
                    {field(
                      "자간 px",
                      displayText!.letterSpacing ?? 0,
                      (v) =>
                        updateOne({ text: { ...n.text!, letterSpacing: v } }),
                      !editable || !!n.styleRefs?.text,
                    )}
                  </div>
                  <textarea
                    className="inspector-text"
                    aria-label="텍스트 내용"
                    value={n.text.content}
                    disabled={!editable}
                    onChange={(e) =>
                      updateOne({
                        text: { ...n.text!, content: e.target.value },
                      })
                    }
                  />
                  <p className="property-hint">
                    캔버스에서 두 번 클릭해 직접 편집할 수 있어요.
                  </p>
                </section>
              )}
              <section className="inspector-section">
                <button
                  className="subtle-action danger"
                  disabled={!editable}
                  onClick={remove}
                >
                  <Trash2 size={14} />
                  선택 항목 삭제
                </button>
              </section>
            </>
          ) : (
            <div className="empty-inspector">
              <div className="empty-symbol">
                <MousePointer2 size={25} />
              </div>
              <h3>
                {selected.length ? "여러 레이어 선택" : "아이디어를 구체적으로"}
              </h3>
              <p>
                {selected.length
                  ? `${selected.length}개 레이어가 선택되었습니다. 함께 이동하거나 복제할 수 있어요.`
                  : "캔버스에서 객체를 선택하면 여기에서 속성을 편집할 수 있어요."}
              </p>
              {selected.length > 0 && (
                <button className="subtle-action" onClick={duplicate}>
                  <Copy size={14} />
                  선택 항목 복제
                </button>
              )}
              <div className="shortcut-card">
                <span>빠른 도구</span>
                <div>
                  선택<kbd>V</kbd>
                </div>
                <div>
                  프레임<kbd>F</kbd>
                </div>
                <div>
                  사각형<kbd>R</kbd>
                </div>
                <div>
                  텍스트<kbd>T</kbd>
                </div>
                <div>
                  복제<kbd>⌘ D</kbd>
                </div>
              </div>
            </div>
          )}
          <div className="renderer-control">
            <span>렌더러 실험</span>
            <select
              aria-label="렌더러 선택"
              value={renderer}
              onChange={(e) => {
                setRenderError("");
                setRenderer(e.target.value as "svg" | "canvaskit");
              }}
            >
              <option value="svg">SVG · 기본</option>
              <option value="canvaskit">CanvasKit · 실험</option>
            </select>
            <small>
              {serverStorage
                ? "문서는 개인 서버에 저장됩니다."
                : "초안은 현재 URL의 이 브라우저에만 저장됩니다. 서버 저장은 없어요."}
              JSON 파일로 별도 백업하세요.
            </small>
          </div>
        </aside>
      </div>
      {renderError && (
        <div className="render-error" role="alert">
          <strong>렌더러 오류</strong>
          <span>{renderError}</span>
          <button
            onClick={() => {
              setRenderer("svg");
              setRenderError("");
            }}
          >
            SVG로 돌아가기
          </button>
        </div>
      )}
      {message && (
        <div className="toast" role="status">
          <Check size={16} />
          <span>{message}</span>
          <button aria-label="알림 닫기" onClick={() => setMessage("")}>
            <X size={14} />
          </button>
        </div>
      )}
      <input
        hidden
        type="file"
        ref={fileInput}
        accept="image/png"
        onChange={(e) => {
          if (e.target.files?.[0]) uploadImage(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <input
        hidden
        type="file"
        ref={importInput}
        accept="application/json,.json"
        onChange={(e) => {
          if (e.target.files?.[0]) importDoc(e.target.files[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
