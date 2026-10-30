import { snapshotDocument, type SceneDocument } from "./core";

export const DRAFT_DB_NAME = "draftroom-local-drafts";
export const DRAFT_STORE_NAME = "drafts";
export const DRAFT_KEY = "current";
const OPEN_TIMEOUT_MS = 3000;

export type StoredDraft = {
  version: 1 | 2;
  /** Inactive documents. The active document remains in document for v1 callers. */
  documents?: SceneDocument[];
  revision: number;
  updatedAt: string;
  document: SceneDocument;
};

export class DraftConflictError extends Error {
  constructor() {
    super("The local draft changed in another tab. Reload it before saving.");
    this.name = "DraftConflictError";
  }
}

const snapshot = snapshotDocument;

function validateStored(value: unknown): StoredDraft {
  if (!value || typeof value !== "object")
    throw new Error("Invalid local draft record");
  const draft = value as StoredDraft;
  if (
    ![1, 2].includes(draft.version) ||
    !Number.isSafeInteger(draft.revision) ||
    draft.revision < 1 ||
    typeof draft.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(draft.updatedAt)) ||
    new Date(draft.updatedAt).toISOString() !== draft.updatedAt
  )
    throw new Error("Invalid or unsupported local draft record");
  const document = snapshot(draft.document);
  if (draft.version === 1 && draft.documents !== undefined)
    throw new Error("Invalid legacy local draft");
  if (draft.version === 2) {
    if (!Array.isArray(draft.documents))
      throw new Error("Missing document library");
    const documents = draft.documents.map(snapshot);
    const ids = [document.id, ...documents.map((d) => d.id)];
    if (new Set(ids).size !== ids.length)
      throw new Error("Duplicate document identity");
    return { ...draft, document, documents };
  }
  return { ...draft, document };
}

/** Open per operation: failed, blocked, and late opens never become cached handles. */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error("Opening local draft storage timed out")),
      OPEN_TIMEOUT_MS,
    );
    try {
      if (!globalThis.indexedDB)
        throw new Error("Local draft storage is unavailable in this browser");
      const request = indexedDB.open(DRAFT_DB_NAME, 1);
      request.onblocked = () =>
        fail(new Error("Local draft storage is blocked by another tab"));
      request.onerror = () =>
        fail(request.error ?? new Error("Could not open local draft storage"));
      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction?.abort();
          return;
        }
        if (!request.result.objectStoreNames.contains(DRAFT_STORE_NAME))
          request.result.createObjectStore(DRAFT_STORE_NAME);
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        database.onversionchange = () => database.close();
        resolve(database);
      };
    } catch (error) {
      fail(error);
    }
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  operation: (
    store: IDBObjectStore,
    result: (value: T) => void,
    fail: (error: unknown) => void,
  ) => void,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(DRAFT_STORE_NAME, mode);
      let value: T;
      let hasResult = false;
      let failure: unknown;
      const fail = (error: unknown) => {
        failure ??= error;
        try {
          transaction.abort();
        } catch {
          reject(failure);
        }
      };
      transaction.oncomplete = () => {
        if (failure) reject(failure);
        else if (hasResult) resolve(value);
        else
          reject(
            new Error("Local draft transaction completed without a result"),
          );
      };
      transaction.onabort = () =>
        reject(
          failure ??
            transaction.error ??
            new Error("Local draft transaction aborted"),
        );
      transaction.onerror = () => {
        failure ??=
          transaction.error ?? new Error("Local draft transaction failed");
      };
      database.onversionchange = () => {
        fail(new Error("Local draft storage changed in another tab"));
        database.close();
      };
      try {
        operation(
          transaction.objectStore(DRAFT_STORE_NAME),
          (next) => {
            value = next;
            hasResult = true;
          },
          fail,
        );
      } catch (error) {
        fail(error);
      }
    });
  } finally {
    database.close();
  }
}

// Check key existence separately so an explicitly stored undefined is treated as
// corruption, never as an absent draft that a first save may overwrite.
function readStored(
  store: IDBObjectStore,
  receive: (draft: StoredDraft | null) => void,
  fail: (error: unknown) => void,
) {
  const key = store.getKey(DRAFT_KEY);
  key.onerror = () => fail(key.error);
  key.onsuccess = () => {
    try {
      if (key.result === undefined) {
        receive(null);
        return;
      }
      const request = store.get(DRAFT_KEY);
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        try {
          receive(validateStored(request.result));
        } catch (error) {
          fail(error);
        }
      };
    } catch (error) {
      fail(error);
    }
  };
}

export function loadLocalDraft(): Promise<StoredDraft | null> {
  return transact("readonly", (store, result, fail) => {
    readStored(store, result, fail);
  });
}

export async function saveLocalDraft(
  document: SceneDocument,
  expectedRevision: number | null,
  documents?: SceneDocument[],
): Promise<StoredDraft> {
  // Snapshot before yielding so caller edits cannot change an in-flight save.
  const copy = snapshot(document);
  const library = documents?.map(snapshot);
  if (
    expectedRevision !== null &&
    (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
  )
    throw new Error("Invalid expected local draft revision");
  return transact("readwrite", (store, result, fail) => {
    readStored(
      store,
      (current) => {
        if ((current?.revision ?? null) !== expectedRevision)
          throw new DraftConflictError();
        const revision = (current?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision))
          throw new Error("Local draft revision limit reached");
        const inactive =
          library ?? current?.documents?.filter((d) => d.id !== copy.id);
        // copy/library were validated and detached before yielding; readStored
        // did the same for inherited inactive documents. Do not JSON-roundtrip
        // the entire library a second time inside the write transaction.
        const ids = [copy.id, ...(inactive ?? []).map((d) => d.id)];
        if (new Set(ids).size !== ids.length)
          throw new Error("Duplicate document identity");
        const next: StoredDraft = {
          version: inactive ? 2 : 1,
          ...(inactive ? { documents: inactive } : {}),
          revision,
          updatedAt: new Date().toISOString(),
          document: copy,
        };
        const write = store.put(next, DRAFT_KEY);
        write.onerror = () => fail(write.error);
        write.onsuccess = () => result(next);
      },
      fail,
    );
  });
}
