import { describe, expect, it, vi } from "vitest";
import { createDemoDocument } from "../src/core";
import { ServerDraftStorage, validateLibrary } from "../src/server-storage";
import { canonical, saveLibrary, validateRequest } from "../server/store";
import { DraftConflictError } from "../src/local-draft-storage";
import type { Pool } from "pg";

const request = () => ({
  operationId: "test-op",
  expectedVersion: 0,
  document: createDemoDocument(),
  documents: [],
});
const ack = {
  operationId: "test-op",
  version: 1,
  updatedAt: "2026-10-27T00:00:00.000Z",
};
describe("server persistence contract", () => {
  it("calls the default browser fetch with its global receiver", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(Response.json(null));
    } as typeof fetch;
    try {
      expect(await new ServerDraftStorage().load()).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
  it("validates snapshots and isolates caller mutation", () => {
    const input = request();
    const library = validateLibrary(input);
    input.document.name = "changed";
    expect(library.document.name).not.toBe("changed");
    expect(() =>
      validateLibrary({ ...input, documents: [input.document] }),
    ).toThrow();
    expect(() => validateLibrary({ ...input, documents: undefined })).toThrow();
    expect(() =>
      validateLibrary({ ...input, document: { schemaVersion: 99 } }),
    ).toThrow();
  });
  it("rejects invalid operation/version/unknown request fields", () => {
    for (const change of [
      { operationId: "" },
      { operationId: "x".repeat(129) },
      { expectedVersion: -1 },
      { expectedVersion: 0.5 },
      { expectedVersion: Number.MAX_SAFE_INTEGER },
      { extra: true },
    ])
      expect(() => validateRequest({ ...request(), ...change })).toThrow();
    expect(validateRequest(request()).expectedVersion).toBe(0);
  });
  it("canonicalizes object key ordering while retaining all payload content and array order", () => {
    expect(canonical({ b: 1, a: { y: 2, x: 3 } })).toBe(
      canonical({ a: { x: 3, y: 2 }, b: 1 }),
    );
    expect(canonical({ a: [1, 2] })).not.toBe(canonical({ a: [2, 1] }));
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: 1, extra: true }));
  });
  it("retries byte-identical operation after a lost ACK despite later editor changes", async () => {
    const calls: string[] = [];
    const transport = vi.fn(async (_url: unknown, options?: RequestInit) => {
      calls.push(String(options?.body));
      if (calls.length === 1) throw new TypeError("ACK lost after commit");
      const body = JSON.parse(calls.at(-1)!);
      return Response.json({
        ...ack,
        operationId: body.operationId,
        version: body.expectedVersion + 1,
      });
    });
    const storage = new ServerDraftStorage(transport as typeof fetch);
    const doc = createDemoDocument();
    const original = structuredClone(doc);
    await expect(storage.save(doc, null)).rejects.toThrow("ACK lost");
    doc.name = "later edit";
    const recovered = await storage.save(doc, null);
    expect(calls[0]).toBe(calls[1]);
    expect(recovered.document).toEqual(original);
    const next = await storage.save(doc, recovered.revision);
    expect(next.document.name).toBe("later edit");
    expect(JSON.parse(calls[2]).operationId).not.toBe(
      JSON.parse(calls[0]).operationId,
    );
    expect(JSON.parse(calls[2]).expectedVersion).toBe(1);
  });
  it("stops on stale version and retains uncertain request on HTTP or malformed ACK errors", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 409 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(Response.json(ack));
    const storage = new ServerDraftStorage(transport);
    await expect(
      storage.save(createDemoDocument(), null),
    ).rejects.toBeInstanceOf(DraftConflictError);
    const body = storage.pending?.body;
    await expect(storage.save(createDemoDocument(), null)).rejects.toThrow(
      "503",
    );
    await expect(storage.save(createDemoDocument(), null)).rejects.toThrow(
      "acknowledgement",
    );
    expect(storage.pending?.body).toBe(body);
  });
  it("validates GET records and never treats a failed server as an empty library", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(Response.json(null))
      .mockResolvedValueOnce(
        Response.json({ ...request(), version: 4, updatedAt: ack.updatedAt }),
      )
      .mockResolvedValueOnce(Response.json({ version: -1 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const storage = new ServerDraftStorage(transport);
    expect(await storage.load()).toBeNull();
    expect((await storage.load())?.revision).toBe(4);
    await expect(storage.load()).rejects.toThrow();
    await expect(storage.load()).rejects.toThrow("503");
  });
  it("does not resolve a save until COMMIT resolves, and releases the client", async () => {
    let finish!: () => void;
    let reachedCommit!: () => void;
    const atCommit = new Promise<void>((resolve) => {
      reachedCommit = resolve;
    });
    const commit = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const query = vi.fn(async (sql: string) => {
      if (sql === "COMMIT") {
        reachedCommit();
        await commit;
      }
      if (sql.includes("clock_timestamp"))
        return { rows: [{ now: new Date(ack.updatedAt) }] };
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: async () => ({ query, release }),
    } as unknown as Pool;
    let resolved = false;
    const saving = saveLibrary(pool, request()).then((value) => {
      resolved = true;
      return value;
    });
    await atCommit;
    expect(resolved).toBe(false);
    expect(release).not.toHaveBeenCalled();
    finish();
    expect(await saving).toEqual(ack);
    expect(release).toHaveBeenCalledOnce();
  });
  it("rolls back and never returns an ACK when COMMIT fails", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "COMMIT") throw new Error("connection lost");
      if (sql.includes("clock_timestamp"))
        return { rows: [{ now: new Date(ack.updatedAt) }] };
      return { rows: [] };
    });
    const release = vi.fn();
    await expect(
      saveLibrary(
        { connect: async () => ({ query, release }) } as unknown as Pool,
        request(),
      ),
    ).rejects.toThrow("connection lost");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
