import { useEffect, useRef, useState } from "react";
import type { SceneDocument } from "./core";
import {
  DraftConflictError,
  loadLocalDraft,
  saveLocalDraft,
} from "./local-draft-storage";

import { ServerDraftStorage, serverStorage } from "./server-storage";

export type DraftStatus =
  "loading" | "idle" | "saving" | "saved" | "error" | "conflict";
type State = {
  status: DraftStatus;
  ready: boolean;
  detail: string;
  canRetry: boolean;
};

// One session owns one serialized writer. React StrictMode may attach twice, but
// reuses the same bootstrap promise and never starts two storage reads/writers.
export class LocalDraftSession {
  constructor(
    public storage = serverStorage ? new ServerDraftStorage() : undefined,
  ) {}
  state: State = {
    status: "loading",
    ready: false,
    detail: "",
    canRetry: false,
  };
  listeners = new Set<() => void>();
  boot?: Promise<SceneDocument | null>;
  revision: number | null = null;
  saved = "";
  latest = "";
  document?: SceneDocument;
  documents: SceneDocument[] = [];
  timer?: ReturnType<typeof setTimeout>;
  writing = false;
  blocked = false;
  hadSave = false;
  get dirty() {
    return (
      this.latest !== this.saved || this.writing || !!this.storage?.pending
    );
  }
  publish(status: DraftStatus, detail = "", canRetry = false) {
    this.state = { status, ready: status !== "loading", detail, canRetry };
    this.listeners.forEach((listener) => listener());
  }
  start(initial: SceneDocument) {
    return (this.boot ??= (
      this.storage ? this.storage.load() : loadLocalDraft()
    )
      .then((record) => {
        this.revision = record?.revision ?? null;
        this.hadSave = !!record;
        this.documents = record?.documents ?? [];
        this.document = record?.document ?? initial;
        this.saved = this.latest = this.key(this.document);
        this.publish(record ? "saved" : "idle");
        return record?.document ?? null;
      })
      .catch((error: unknown) => {
        this.document = initial;
        this.saved = this.latest = this.key(initial);
        this.blocked = true;
        this.publish(
          "error",
          "기존 초안을 읽지 못해 자동 저장을 중지했습니다. JSON으로 백업한 뒤 새로고침하세요. " +
            errorText(error),
        );
        return null;
      }));
  }
  key(document: SceneDocument) {
    return JSON.stringify({ document, documents: this.documents });
  }
  change = (document: SceneDocument, documents: SceneDocument[]) => {
    if (!this.state.ready || this.blocked || this.state.status === "error")
      return false;
    this.documents = structuredClone(documents);
    this.document = structuredClone(document);
    this.latest = this.key(document);
    this.schedule();
    return true;
  };
  observe = (document: SceneDocument) => {
    if (!this.state.ready) return;
    const key = this.key(document);
    if (key === this.latest) return;
    this.latest = key;
    this.document = structuredClone(document);
    if (this.blocked || this.state.status === "error") return;
    this.schedule();
  };
  schedule() {
    clearTimeout(this.timer);
    if (!this.writing && !this.storage?.pending && this.latest === this.saved) {
      this.publish(this.hadSave ? "saved" : "idle");
      return;
    }
    this.publish("saving");
    this.timer = setTimeout(() => void this.flush(), 200);
  }
  async flush() {
    if (
      this.writing ||
      this.blocked ||
      !this.document ||
      (this.latest === this.saved && !this.storage?.pending)
    )
      return;
    const document = this.document,
      key = this.latest;
    this.writing = true;
    try {
      const record = await (this.storage
        ? this.storage.save(document, this.revision, this.documents)
        : saveLocalDraft(document, this.revision, this.documents));
      this.revision = record.revision;
      this.saved = this.storage
        ? JSON.stringify({
            document: record.document,
            documents: record.documents ?? [],
          })
        : key;
      this.hadSave = true;
      this.writing = false;
      if (this.latest !== this.saved) this.schedule();
      else this.publish("saved");
    } catch (error) {
      this.writing = false;
      clearTimeout(this.timer);
      if (error instanceof DraftConflictError) {
        this.blocked = true;
        this.publish(
          "conflict",
          "다른 탭 또는 기기에서 문서를 변경했습니다. 현재 작업을 JSON으로 백업한 뒤 새로고침하세요. 자동 저장을 중지했습니다.",
        );
      } else
        this.publish(
          "error",
          "자동 저장에 실패했습니다. 작업은 메모리에 있습니다. JSON 백업 또는 저장 재시도를 이용하세요. " +
            errorText(error),
          true,
        );
    }
  }
  retry = () => {
    if (!this.blocked && this.state.canRetry) this.schedule();
  };
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : "저장소 오류";
}

export function useLocalDraft(
  initial: SceneDocument,
  restore: (document: SceneDocument) => void,
  uncommitted = false,
) {
  const uncommittedRef = useRef(uncommitted);
  uncommittedRef.current = uncommitted;
  const [session] = useState(() => new LocalDraftSession());
  const [state, setState] = useState(session.state);
  useEffect(() => {
    let active = true;
    const listener = () => {
      if (active) setState(session.state);
    };
    session.listeners.add(listener);
    void session.start(initial).then((document) => {
      if (!active) return;
      if (document) restore(document);
      listener();
    });
    const unload = (event: BeforeUnloadEvent) => {
      if (session.dirty || uncommittedRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      active = false;
      session.listeners.delete(listener);
      window.removeEventListener("beforeunload", unload);
    };
  }, [session]);
  return {
    ...state,
    observe: session.observe,
    retry: session.retry,
    change: session.change,
    documents: session.documents,
  };
}
