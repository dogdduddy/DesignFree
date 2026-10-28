import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { createApi } from "../server/http";
import {
  assertSameOrigin,
  credentials,
  hashPassword,
  OwnerAuth,
  sessionCookie,
  verifyPassword,
} from "../server/auth";

const request = (headers: Record<string, string>) =>
  ({ headers }) as IncomingMessage;
describe("owner authentication", () => {
  it("salts scrypt hashes and rejects incorrect passwords", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).not.toContain("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("incorrect password", hash)).toBe(false);
    expect(await hashPassword("correct horse battery")).not.toBe(hash);
    expect(await verifyPassword("anything", "invalid")).toBe(false);
  });
  it("caps concurrent derivations so login bursts cannot allocate unbounded scrypt memory", async () => {
    const results = await Promise.allSettled([
      hashPassword("password one"),
      hashPassword("password two"),
      hashPassword("password three"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(2);
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason.message).toBe("too_many_attempts");
    expect(await hashPassword("password after burst")).toMatch(
      /^[a-f0-9]{32}:[a-f0-9]{128}$/,
    );
  });
  it("bounds and validates credentials without trimming passwords", () => {
    expect(
      credentials({ username: " owner ", password: " 12345678901 " }),
    ).toEqual({ username: "owner", password: " 12345678901 " });
    for (const value of [
      null,
      {},
      { username: " ", password: "a".repeat(20) },
      { username: "a", password: "short" },
      { username: "a", password: "a".repeat(257) },
    ])
      expect(() => credentials(value)).toThrow("invalid_credentials");
  });
  it("rejects cross-site and sibling-origin writes before mutation", () => {
    expect(() =>
      assertSameOrigin(
        request({ host: "localhost:4173", origin: "http://evil.test" }),
      ),
    ).toThrow("cross_site_write");
    expect(() =>
      assertSameOrigin(request({ host: "localhost:4173", origin: "null" })),
    ).toThrow();
    expect(() =>
      assertSameOrigin(
        request({ host: "localhost:4173", "sec-fetch-site": "cross-site" }),
      ),
    ).toThrow();
    expect(() =>
      assertSameOrigin(
        request({
          host: "192.168.1.5:4173",
          origin: "http://192.168.1.5:4173",
        }),
      ),
    ).not.toThrow();
  });
  it("uses bounded browser cookies and supports explicit HTTPS security", () => {
    expect(sessionCookie("token")).toContain(
      "Path=/api; HttpOnly; SameSite=Strict; Max-Age=604800",
    );
    expect(sessionCookie("", true)).toContain("Max-Age=0; Secure");
  });
  it("globally limits expensive password attempts and resets the window", () => {
    const auth = new OwnerAuth({} as Pool);
    for (let i = 0; i < 20; i++) auth.throttle(1);
    expect(() => auth.throttle(2)).toThrow("too_many_attempts");
    expect(() => auth.throttle(300001)).not.toThrow();
  });
  it("does not reveal or replace an existing owner during setup and rolls back", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const release = vi.fn();
    const auth = new OwnerAuth({
      connect: async () => ({ query, release }),
    } as unknown as Pool);
    await expect(
      auth.setup({ username: "owner", password: "correct horse battery" }),
    ).rejects.toThrow("owner_already_exists");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("ON CONFLICT(id) DO NOTHING"),
      ),
    ).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
  it("looks up only hashed unexpired tokens and deletes their hashes on logout", async () => {
    const query = vi.fn(async () => ({ rows: [{ token_hash: "hash" }] }));
    const auth = new OwnerAuth({ query } as unknown as Pool);
    const token = "ab".repeat(32),
      req = request({ cookie: `draftroom_session=${token}` });
    expect(await auth.authenticated(req)).toBe(true);
    const [sql, values] = query.mock.calls[0] as unknown as [string, string[]];
    expect(sql).toContain("expires_at > clock_timestamp()");
    expect(values[0]).not.toBe(token);
    await auth.logout(req);
    expect(query).toHaveBeenLastCalledWith(
      "DELETE FROM draftroom_sessions WHERE token_hash = $1",
      values,
    );
    expect(
      await auth.authenticated(
        request({ cookie: "draftroom_session=invalid" }),
      ),
    ).toBe(false);
  });
  it("guards library, assets and cleanup HTTP endpoints without consulting document storage", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const server = createApi({ query } as unknown as Pool);
    const call = async (url: string, method: string, headers = {}) => {
      const req = Object.assign(Readable.from([]), { url, method, headers });
      let status = 0,
        body = "";
      const res = {
        setHeader: vi.fn(),
        writeHead: (code: number) => {
          status = code;
        },
        end: (value: string) => {
          body = value;
        },
        headersSent: false,
      };
      await (server.listeners("request")[0] as Function)(req, res);
      return { status, body: JSON.parse(body) };
    };
    for (const [path, method] of [
      ["/api/library/current", "GET"],
      ["/api/library/current", "PUT"],
      ["/api/documents/x/assets/y", "GET"],
      ["/api/assets/cleanup", "POST"],
    ])
      expect((await call(path, method)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(
      (
        await call("/api/auth/setup", "POST", {
          origin: "http://evil.test",
          host: "localhost:4173",
        })
      ).status,
    ).toBe(403);
    expect((await call("/api/auth/status", "GET")).body).toEqual({
      initialized: false,
      authenticated: false,
    });
  });
});
