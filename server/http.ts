import type { AssetVolume } from "./assets";
import { OwnerAuth, assertSameOrigin, sessionCookie } from "./auth";
import { createServer, type IncomingMessage } from "node:http";
import type { Pool } from "pg";
import { loadLibrary, saveLibrary, StorageError } from "./store";
import { createToken, listTokens, revokeToken, verifyBearer } from "./tokens";
import { handleRpc, type McpLibrary } from "./mcp";

const MAX_BODY = 32 * 1024 * 1024;
async function readJSON(request: IncomingMessage, limit = MAX_BODY) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")
  )
    throw new StorageError(415, "json_required");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new StorageError(413, "body_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StorageError(400, "invalid_json");
  }
}
export function createApi(pool: Pool, assets?: AssetVolume) {
  const auth = new OwnerAuth(pool);
  const secureCookie = process.env.DRAFTROOM_SECURE_COOKIE === "true";
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const send = (status: number, value: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(value));
    };
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? ""))
        assertSameOrigin(request);
      if (request.url === "/api/auth/status" && request.method === "GET") {
        send(200, await auth.status(request));
        return;
      }
      if (
        ["/api/auth/setup", "/api/auth/login"].includes(request.url ?? "") &&
        request.method === "POST"
      ) {
        const body = await readJSON(request, 4096);
        const result =
          request.url === "/api/auth/setup"
            ? await auth.setup(body)
            : await auth.login(body);
        response.setHeader(
          "Set-Cookie",
          sessionCookie(result.token, secureCookie),
        );
        send(200, {
          initialized: true,
          authenticated: true,
          username: result.username,
        });
        return;
      }
      if (request.url === "/api/auth/logout" && request.method === "POST") {
        await auth.logout(request);
        response.setHeader("Set-Cookie", sessionCookie("", secureCookie));
        send(200, { initialized: true, authenticated: false });
        return;
      }
      if (request.url?.split("?")[0].replace(/\/+$/, "") === "/api/mcp") {
        // AI tools authenticate with a personal token, never the browser session.
        if (!(await verifyBearer(pool, request.headers.authorization))) {
          response.setHeader("WWW-Authenticate", 'Bearer realm="designfree"');
          throw new StorageError(401, "token_required");
        }
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          throw new StorageError(405, "method_not_allowed");
        }
        const body = await readJSON(request, 1024 * 1024);
        // Batches (dropped from MCP 2025-06-18) are kept small for older clients.
        if (Array.isArray(body) && (!body.length || body.length > 10)) {
          send(200, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: batch must hold 1-10 messages" } });
          return;
        }
        // One library read per HTTP request; PNG bytes only for exported layers.
        let library: Promise<McpLibrary | null> | undefined;
        const ctx = {
          load: () => (library ??= loadLibrary(pool) as Promise<McpLibrary | null>),
          readImage: assets ? (documentId: string, key: string) => assets.read(documentId, key) : undefined,
        };
        const replies: unknown[] = [];
        for (const m of Array.isArray(body) ? body : [body]) {
          const reply = await handleRpc(m, ctx);
          if (reply !== undefined) replies.push(reply);
        }
        if (!replies.length) {
          response.writeHead(202);
          response.end();
        } else send(200, Array.isArray(body) ? replies : replies[0]);
        return;
      }
      if (request.url !== "/api/health" && !(await auth.authenticated(request)))
        throw new StorageError(401, "authentication_required");
      if (request.url === "/api/health" && request.method === "GET") {
        await pool.query("SELECT 1");
        send(200, { ok: true });
      } else if (request.url === "/api/tokens" && request.method === "GET") {
        send(200, { tokens: await listTokens(pool) });
      } else if (request.url === "/api/tokens" && request.method === "POST") {
        if (request.headers["sec-fetch-site"] === "cross-site")
          throw new StorageError(403, "cross_site_write");
        send(201, await createToken(pool, await readJSON(request, 4096)));
      } else if (
        request.url?.startsWith("/api/tokens/") &&
        request.method === "DELETE"
      ) {
        if (request.headers["sec-fetch-site"] === "cross-site")
          throw new StorageError(403, "cross_site_write");
        let id: string;
        try {
          id = decodeURIComponent(request.url.slice("/api/tokens/".length));
        } catch {
          throw new StorageError(404, "token_not_found");
        }
        await revokeToken(pool, id);
        send(200, { revoked: true });
      } else if (
        request.url === "/api/library/current" &&
        request.method === "GET"
      ) {
        send(200, await loadLibrary(pool, assets));
      } else if (
        request.url === "/api/library/current" &&
        request.method === "PUT"
      ) {
        // No CORS. Cross-site browser writes must also fail before reading a body.
        if (request.headers["sec-fetch-site"] === "cross-site")
          throw new StorageError(403, "cross_site_write");
        send(200, await saveLibrary(pool, await readJSON(request), assets));
      } else if (
        request.url === "/api/assets/cleanup" &&
        request.method === "POST" &&
        assets
      ) {
        if (request.headers["sec-fetch-site"] === "cross-site")
          throw new StorageError(403, "cross_site_write");
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(71401)");
          const { rows } = await client.query(
            "SELECT payload FROM draftroom_library WHERE id = 1",
          );
          const result = await assets.cleanup(rows[0]?.payload ?? null);
          await client.query("COMMIT");
          send(200, result);
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      } else if (
        request.method === "GET" &&
        assets &&
        request.url?.startsWith("/api/documents/")
      ) {
        const match = /^\/api\/documents\/([^/]+)\/assets\/([^/]+)$/.exec(
          request.url,
        );
        if (!match) throw new StorageError(404, "not_found");
        let documentId: string, assetId: string;
        try {
          documentId = decodeURIComponent(match[1]);
          assetId = decodeURIComponent(match[2]);
        } catch {
          throw new StorageError(400, "invalid_asset_path");
        }
        // Resolve only through this document's current asset inventory. No arbitrary blob URLs.
        const library = await loadLibrary(pool);
        const doc =
          library &&
          [library.document, ...library.documents].find(
            (d) => d.id === documentId,
          );
        const asset =
          doc && Object.hasOwn(doc.assets, assetId)
            ? doc.assets[assetId]
            : undefined;
        if (!asset) throw new StorageError(404, "asset_not_found");
        let bytes: Buffer;
        try {
          bytes = (asset as unknown as { blobKey?: string }).blobKey
            ? await assets.read(
                documentId,
                (asset as unknown as { blobKey: string }).blobKey,
              )
            : Buffer.from(asset.dataUrl.split(",")[1], "base64");
        } catch {
          throw new StorageError(404, "asset_missing");
        }
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        response.setHeader("Content-Type", "image/png");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.writeHead(200);
        response.end(bytes);
      } else send(404, { error: "not_found" });
    } catch (error) {
      const known = error instanceof StorageError;
      if (!known)
        console.error(
          "API storage request failed",
          error instanceof Error ? error.name : "UnknownError",
        );
      if (!response.headersSent)
        send(known ? error.status : 503, {
          error: known ? error.code : "storage_unavailable",
        });
      else response.destroy();
    }
  });
  server.requestTimeout = 30000;
  return server;
}
