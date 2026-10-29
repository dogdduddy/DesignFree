import { describe, expect, it } from "vitest";
import { createDemoDocument } from "../src/core";
import { ServerDraftStorage } from "../src/server-storage";
import { LocalDraftSession } from "../src/use-local-draft";

function fixture() {
  let disk: string | null = null;
  let beforeClear: (() => Promise<void>) | undefined;
  let failDisk = false,
    offline = false,
    loseAck = false;
  let current = {
    document: createDemoDocument(),
    documents: [],
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  const ledger = new Map();
  const bodies: string[] = [];
  const outbox = {
    transact: async (expected?: string | null, next?: string | null) => {
      if (failDisk) throw new Error("disk unavailable");
      if (expected !== undefined) {
        if (disk !== expected) throw new Error("another writer");
        if (next === null) await beforeClear?.();
        disk = next!;
      }
      return disk;
    },
  };
  const transport = async (_url: unknown, options?: RequestInit) => {
    if (offline) throw new Error("offline");
    if (!options?.method) return Response.json(current);
    bodies.push(String(options.body));
    const request = JSON.parse(String(options.body));
    if (!ledger.has(request.operationId)) {
      if (current.version !== request.expectedVersion)
        return new Response("{}", { status: 409 });
      current = {
        ...request,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      ledger.set(request.operationId, {
        operationId: request.operationId,
        version: current.version,
        updatedAt: current.updatedAt,
      });
    }
    if (loseAck) {
      loseAck = false;
      throw new Error("ACK lost");
    }
    return Response.json(ledger.get(request.operationId));
  };
  return {
    beforeClear: (callback: () => Promise<void>) => {
      beforeClear = callback;
    },
    storage: () => new ServerDraftStorage(transport as typeof fetch, outbox),
    get disk() {
      return disk;
    },
    get current() {
      return current;
    },
    bodies,
    diskFailure: (value: boolean) => {
      failDisk = value;
    },
    offline: (value: boolean) => {
      offline = value;
    },
    loseAck: () => {
      loseAck = true;
    },
  };
}

describe("durable server journal", () => {
  it("never sends when durable staging fails; retry can persist later", async () => {
    const f = fixture(),
      storage = f.storage();
    f.diskFailure(true);
    await expect(storage.save(f.current.document, 1)).rejects.toThrow("disk");
    expect(f.bodies).toHaveLength(0);
    f.diskFailure(false);
    await storage.save(f.current.document, 1);
    expect(f.current.version).toBe(2);
    expect(f.disk).toBeNull();
  });
  it("replays identical bytes from a new writer after lost ACK", async () => {
    const f = fixture(),
      storage = f.storage();
    f.loseAck();
    await expect(
      storage.save({ ...f.current.document, name: "B" }, 1),
    ).rejects.toThrow("ACK");
    const recovered = await f.storage().recover();
    expect(recovered?.document.name).toBe("B");
    expect(f.bodies[0]).toBe(f.bodies[1]);
    expect(f.current.version).toBe(2);
    expect(f.disk).toBeNull();
  });
  it("does not let a second tab overwrite an unresolved journal", async () => {
    const f = fixture();
    await f.storage().stage({ ...f.current.document, name: "A" }, 1);
    const before = f.disk;
    await expect(
      f.storage().save({ ...f.current.document, name: "B" }, 1),
    ).rejects.toThrow("another writer");
    expect(f.disk).toBe(before);
    expect(f.bodies).toHaveLength(0);
  });
  it("keeps newer error-state edits through recovery retry", async () => {
    const f = fixture(),
      a = f.current.document;
    await f.storage().stage({ ...a, name: "B" }, 1);
    f.offline(true);
    const session = new LocalDraftSession(f.storage());
    await session.start(a);
    expect(session.state.status).toBe("error");
    session.observe({ ...a, name: "C" });
    await session.staging;
    expect(JSON.parse(f.disk!).latest.document.name).toBe("C");
    f.offline(false);
    await session.reloadRecovery();
    expect(session.document?.name).toBe("C");
    expect(f.current.document.name).toBe("C");
    expect(f.current.version).toBe(3);
    expect(f.disk).toBeNull();
  });
  it("retries staging after a transient disk error during offline recovery", async () => {
    const f = fixture(),
      a = f.current.document;
    await f.storage().stage({ ...a, name: "B" }, 1);
    f.offline(true);
    const session = new LocalDraftSession(f.storage());
    await session.start(a);
    f.diskFailure(true);
    session.observe({ ...a, name: "C" });
    await session.staging.catch(() => {});
    f.diskFailure(false);
    f.offline(false);
    await session.reloadRecovery();
    expect(session.state.status).toBe("saved");
    expect(f.current.document.name).toBe("C");
    expect(f.disk).toBeNull();
  });
  it("uses confirmed ACK version for edits queued while the journal is clearing", async () => {
    const f = fixture(),
      storage = f.storage(),
      a = f.current.document;
    let release!: () => void, reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clearing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.beforeClear(async () => {
      reached();
      await waiting;
    });
    const save = storage.save({ ...a, name: "B" }, 1);
    await clearing;
    const stage = storage.stage({ ...a, name: "C" }, 1);
    release();
    await save;
    await stage;
    expect(storage.pending?.request.expectedVersion).toBe(2);
    await storage.save({ ...a, name: "C" }, 1);
    expect(f.current.version).toBe(3);
    expect(f.current.document.name).toBe("C");
    expect(f.disk).toBeNull();
  });
  it("explicit server selection can recover from a rejected staging promise", async () => {
    const f = fixture(),
      session = new LocalDraftSession(f.storage());
    await session.start(f.current.document);
    f.diskFailure(true);
    session.observe({ ...f.current.document, name: "local" });
    await session.staging.catch(() => {});
    f.diskFailure(false);
    await session.reloadRecovery(true);
    clearTimeout(session.timer);
    expect(session.state.status).toBe("saved");
    expect(session.document).toEqual(f.current.document);
    expect(f.current.version).toBe(1);
  });
});
