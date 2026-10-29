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
  staging: Promise<unknown> = Promise.resolve();
  recovering = false;
  restore?: (document: SceneDocument) => void;
  initial?: SceneDocument;
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
    this.initial = initial;
    return (this.boot ??= (
      this.storage ? this.storage.recover() : loadLocalDraft()
    )
      .then((record) => {
        this.revision = record?.revision ?? null;
        this.hadSave = !!record;
        this.documents = record?.documents ?? [];
        this.document = record?.document ?? initial;
        this.saved = this.latest = this.key(this.document);
        if (this.storage?.recoveryError) {
          this.recovering = true;
          this.failed(this.storage.recoveryError);
        } else this.publish(record ? "saved" : "idle");
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
    if (this.blocked || this.state.status === "error") {
      if (this.storage) {
        this.staging = this.storage.stage(
          document,
          this.revision,
          this.documents,
        );
        void this.staging.catch((error) =>
          this.publish(
            "error",
            "브라우저 복구본 갱신 실패 · 현재 작업을 JSON으로 백업하세요. " +
              errorText(error),
            !this.blocked,
          ),
        );
      }
      return;
    }
    this.schedule();
  };
  schedule() {
    clearTimeout(this.timer);
    if (!this.writing && !this.storage?.pending && this.latest === this.saved) {
      this.publish(this.hadSave ? "saved" : "idle");
      return;
    }
    if (this.storage && this.document) {
      this.staging = this.storage.stage(
        this.document,
        this.revision,
        this.documents,
      );
      void this.staging.catch((error) => {
        clearTimeout(this.timer);
        this.publish(
          "error",
          "브라우저 복구본을 보존하지 못해 전송을 중지했습니다. JSON 백업 후 재시도하세요. " +
            errorText(error),
          true,
        );
      });
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
      await this.staging;
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
      this.failed(error);
    }
  }
  failed(error: unknown) {
    if (error instanceof DraftConflictError) {
      this.blocked = true;
      this.publish(
        "conflict",
        this.storage
          ? "서버에 더 최신 버전이 있습니다. 로컬 복구본을 JSON으로 백업한 뒤 서버 버전을 선택하세요. 자동 병합하거나 덮어쓰지 않습니다."
          : "다른 탭에서 초안을 변경했습니다. 현재 작업을 JSON으로 백업한 뒤 새로고침하세요. 자동 저장을 중지했습니다.",
      );
    } else
      this.publish(
        "error",
        this.storage
          ? "서버 저장 미확정 · 브라우저 복구본에서 재시도합니다. JSON 백업도 권장합니다. " +
              errorText(error)
          : "자동 저장에 실패했습니다. 작업은 메모리에 있습니다. JSON 백업 또는 저장 재시도를 이용하세요. " +
              errorText(error),
        !this.blocked,
      );
  }
  async reloadRecovery(discard = false) {
    if (!this.storage || this.writing) return;
    this.writing = true;
    this.publish("loading");
    try {
      await this.staging.catch(() => {});
      if (!discard && this.document)
        await this.storage.stage(this.document, this.revision, this.documents);
      const record = await (discard
        ? this.storage.useServer()
        : this.storage.recover());
      this.revision = record?.revision ?? null;
      this.documents = record?.documents ?? [];
      this.document = record?.document ?? this.initial!;
      this.saved = this.latest = this.key(this.document);
      this.hadSave = !!record;
      this.restore?.(this.document);
      this.blocked = false;
      if (this.storage.recoveryError) this.failed(this.storage.recoveryError);
      else {
        this.recovering = false;
        this.publish(record ? "saved" : "idle");
      }
    } catch (error) {
      this.failed(error);
    } finally {
      this.writing = false;
    }
  }
  useServer = () => void this.reloadRecovery(true);
  backup = () =>
    JSON.stringify(
      { document: this.document, documents: this.documents },
      null,
      2,
    );

  retry = () => {
    if (!this.blocked && this.state.canRetry) {
      if (this.recovering) void this.reloadRecovery();
      else this.schedule();
    }
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
  session.restore = restore;
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
    useServer: session.useServer,
    backup: session.backup,
  };
}
