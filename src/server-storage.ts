import { parseDocument, serializeDocument, type SceneDocument } from "./core";
import { DraftConflictError, type StoredDraft } from "./local-draft-storage";
import { ServerOutbox } from "./server-outbox";

export type Library = { document: SceneDocument; documents: SceneDocument[] };
export type SaveRequest = Library & {
  operationId: string;
  expectedVersion: number;
};
export type SaveAck = {
  operationId: string;
  version: number;
  updatedAt: string;
};
export const serverStorage =
  import.meta.env?.VITE_DRAFTROOM_STORAGE === "server";

/** Same validator is used at both trust boundaries; never accepts duplicate IDs. */
export function validateLibrary(value: unknown): Library {
  if (!value || typeof value !== "object") throw new Error("Invalid library");
  const raw = value as Library;
  if (!Array.isArray(raw.documents)) throw new Error("Missing documents");
  const document = parseDocument(serializeDocument(raw.document));
  const documents = raw.documents.map((d) =>
    parseDocument(serializeDocument(d)),
  );
  const ids = [document.id, ...documents.map((d) => d.id)];
  if (new Set(ids).size !== ids.length)
    throw new Error("Duplicate document identity");
  return { document, documents };
}

async function responseJSON(response: Response, bootstrap = false) {
  if (response.status === 401 && typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent("draftroom-session-expired", { detail: { bootstrap } }),
    );
  if (response.status === 409) throw new DraftConflictError();
  if (!response.ok) throw new Error(`Server storage HTTP ${response.status}`);
  return response.json();
}

/** Keep one immutable request until its ACK arrives, including manual retries. */
export class ServerDraftStorage {
  pending?: { body: string; request: SaveRequest };
  private journal: string | null = null;
  private latest?: Library;
  private confirmedVersion = 0;
  private mutations: Promise<unknown> = Promise.resolve();
  recoveryError?: unknown;
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(action);
    this.mutations = result.catch(() => {});
    return result;
  }
  private async replace(
    pending: { body: string; request: SaveRequest } | undefined,
    latest?: Library,
  ) {
    const next = pending
      ? JSON.stringify({ version: 1, body: pending.body, latest })
      : null;
    if (this.outbox) await this.outbox.transact(this.journal, next);
    this.journal = next;
    this.pending = pending;
    this.latest = latest;
  }
  constructor(
    private request: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
    private outbox:
      Pick<ServerOutbox, "transact"> | undefined = typeof window === "undefined"
      ? undefined
      : new ServerOutbox(),
  ) {}
  /** Persist committed editor snapshots immediately, before debounce/network. */
  stage(
    document: SceneDocument,
    revision: number | null,
    documents: SceneDocument[] = [],
  ) {
    const latest = validateLibrary({ document, documents });
    return this.mutate(async () => {
      const request = this.pending?.request ?? {
        ...latest,
        operationId: crypto.randomUUID(),
        expectedVersion: Math.max(revision ?? 0, this.confirmedVersion),
      };
      await this.replace(
        this.pending ?? { request, body: JSON.stringify(request) },
        latest,
      );
    });
  }
  /** Startup replay always consults the idempotency ledger before reading current state. */
  async recover(): Promise<StoredDraft | null> {
    this.recoveryError = undefined;
    const journal = this.outbox ? await this.outbox.transact() : this.journal;
    if (journal) {
      const raw = JSON.parse(journal);
      const request = JSON.parse(raw.body) as SaveRequest;
      if (
        raw.version !== 1 ||
        typeof raw.body !== "string" ||
        typeof request.operationId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId) ||
        !Number.isSafeInteger(request.expectedVersion) ||
        request.expectedVersion < 0 ||
        request.expectedVersion >= Number.MAX_SAFE_INTEGER
      )
        throw new Error("Invalid server outbox request");
      validateLibrary(request);
      this.journal = journal;
      this.pending = { body: raw.body, request };
      this.latest = validateLibrary(raw.latest);
      try {
        while (this.pending) await this.send();
      } catch (error) {
        this.recoveryError = error;
        return {
          ...this.latest!,
          version: 2,
          revision: this.pending!.request.expectedVersion,
          updatedAt: new Date().toISOString(),
        };
      }
    }
    return this.load();
  }
  async useServer(): Promise<StoredDraft | null> {
    // Failed reads must never discard the local recovery copy.
    const current = await this.load();
    await this.mutate(() => this.replace(undefined));
    this.recoveryError = undefined;
    return current;
  }
  async load(): Promise<StoredDraft | null> {
    const raw = await responseJSON(
      await this.request("/api/library/current", {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      }),
      true,
    );
    if (raw === null) return null;
    if (
      !Number.isSafeInteger(raw.version) ||
      raw.version < 1 ||
      typeof raw.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(raw.updatedAt))
    )
      throw new Error("Invalid server version");
    return {
      ...validateLibrary(raw),
      version: 2,
      revision: raw.version,
      updatedAt: raw.updatedAt,
    };
  }
  async save(
    document: SceneDocument,
    revision: number | null,
    documents: SceneDocument[] = [],
  ): Promise<StoredDraft> {
    if (!this.pending) await this.stage(document, revision, documents);
    return this.send();
  }
  private async send(): Promise<StoredDraft> {
    await this.mutations;
    const pending = this.pending!;
    const ack = (await responseJSON(
      await this.request("/api/library/current", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: pending.body,
        signal: AbortSignal.timeout(10000),
      }),
    )) as SaveAck;
    if (
      ack.operationId !== pending.request.operationId ||
      ack.version !== pending.request.expectedVersion + 1 ||
      typeof ack.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(ack.updatedAt))
    )
      throw new Error("Invalid server acknowledgement");
    await this.mutate(async () => {
      const latest = this.latest!;
      if (
        JSON.stringify(latest) !==
        JSON.stringify({
          document: pending.request.document,
          documents: pending.request.documents,
        })
      ) {
        const request = {
          ...latest,
          operationId: crypto.randomUUID(),
          expectedVersion: ack.version,
        };
        await this.replace({ request, body: JSON.stringify(request) }, latest);
      } else await this.replace(undefined);
      this.confirmedVersion = ack.version;
    });
    return {
      version: 2,
      revision: ack.version,
      updatedAt: ack.updatedAt,
      document: pending.request.document,
      documents: pending.request.documents,
    };
  }
}
