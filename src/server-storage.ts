import { parseDocument, serializeDocument, type SceneDocument } from "./core";
import { DraftConflictError, type StoredDraft } from "./local-draft-storage";

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
  constructor(
    private request: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
  ) {}
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
    if (!this.pending) {
      const request = {
        ...validateLibrary({ document, documents }),
        operationId: crypto.randomUUID(),
        expectedVersion: revision ?? 0,
      };
      this.pending = { request, body: JSON.stringify(request) };
    }
    const pending = this.pending;
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
    this.pending = undefined;
    return {
      version: 2,
      revision: ack.version,
      updatedAt: ack.updatedAt,
      document: pending.request.document,
      documents: pending.request.documents,
    };
  }
}
