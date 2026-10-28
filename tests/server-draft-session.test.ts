import { describe, expect, it, vi } from "vitest";
import { createDemoDocument } from "../src/core";
import { ServerDraftStorage } from "../src/server-storage";
import { LocalDraftSession } from "../src/use-local-draft";

describe("server autosave recovery", () => {
  it("retries an uncertain commit even if Undo restored the last acknowledged content", async () => {
    vi.useFakeTimers();
    try {
      const a = createDemoDocument();
      const b = { ...a, name: "B" };
      const writes: {
        operationId: string;
        expectedVersion: number;
        document: { name: string };
      }[] = [];
      let rejectFirst!: (error: Error) => void;
      const first = new Promise<Response>((_resolve, reject) => {
        rejectFirst = reject;
      });
      const transport = vi.fn(async (_url: unknown, options?: RequestInit) => {
        if (!options?.method)
          return Response.json({
            document: a,
            documents: [],
            version: 1,
            updatedAt: "2026-10-27T00:00:00.000Z",
          });
        const body = JSON.parse(String(options.body));
        writes.push(body);
        if (writes.length === 1) return first;
        return Response.json({
          operationId: body.operationId,
          version: body.expectedVersion + 1,
          updatedAt: "2026-10-27T00:00:01.000Z",
        });
      });
      const session = new LocalDraftSession(
        new ServerDraftStorage(transport as typeof fetch),
      );
      await session.start(a);
      session.observe(b);
      const writing = session.flush();
      session.observe(a); // Undo while B is in flight.
      rejectFirst(new Error("ACK lost"));
      await writing;
      expect(session.state.status).toBe("error");
      expect(session.dirty).toBe(true);
      session.retry();
      expect(session.state.status).toBe("saving");
      await session.flush(); // Recover B's ACK, then save A against version 2.
      expect(session.dirty).toBe(true);
      await session.flush();
      expect(writes).toHaveLength(3);
      expect(writes[1]).toEqual(writes[0]);
      expect(writes[2].document.name).toBe(a.name);
      expect(writes[2].expectedVersion).toBe(2);
      expect(session.state.status).toBe("saved");
      expect(session.dirty).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
