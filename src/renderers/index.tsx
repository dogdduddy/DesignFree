import { useEffect, useRef } from "react";
import type { SceneDocument, Viewport } from "../core";
import {
  createSvgEngine,
  ensureDocumentAssets,
  type RendererEngine,
} from "./svg";
import { createCanvasKitEngine } from "./canvaskit";
export { exportSvg, exportPng, escapeXml } from "./svg";
export { createSvgEngine, createCanvasKitEngine };
export type RendererKind = "svg" | "canvaskit";
export const createRenderer = (
  kind: RendererKind,
  host: HTMLElement,
  width: number,
  height: number,
) =>
  kind === "svg"
    ? createSvgEngine(host, width, height)
    : createCanvasKitEngine(host, width, height);
export function SceneRenderer(props: {
  document: SceneDocument;
  viewport: Viewport;
  width: number;
  height: number;
  renderer: RendererKind;
  onReady?: (info?: unknown) => void;
  onError?: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<RendererEngine | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    let canceled = false;
    let owned: RendererEngine | undefined;
    ensureDocumentAssets(props.document)
      .then(() =>
        canceled
          ? undefined
          : createRenderer(
              props.renderer,
              host.current!,
              props.width,
              props.height,
            ),
      )
      .then((value) => {
        if (!value) return;
        owned = value;
        if (canceled) {
          value.destroy();
          return;
        }
        engine.current = value;
        try {
          value.update(latest.current.document, latest.current.viewport);
          latest.current.onReady?.(value.info);
        } catch (e) {
          latest.current.onError?.(String(e));
        }
      })
      .catch((e) => {
        if (!canceled) latest.current.onError?.(String(e));
      });
    return () => {
      canceled = true;
      engine.current = null;
      owned?.destroy();
      owned = undefined;
    };
  }, [props.renderer, props.width, props.height]);
  useEffect(() => {
    try {
      engine.current?.update(props.document, props.viewport);
    } catch (e) {
      props.onError?.(String(e));
    }
  }, [props.document, props.viewport]);
  return (
    <div
      ref={host}
      style={{
        width: props.width,
        height: props.height,
        pointerEvents: "none",
        position: "absolute",
        inset: 0,
      }}
    />
  );
}
