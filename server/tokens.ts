import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { StorageError } from "./store";

/** Personal access tokens for AI tools (MCP). Only a SHA-256 digest is
 * stored; the token itself is shown once at creation. Scope is read-only
 * until collaborative editing can carry AI writes. */
export const TOKEN_SCHEMA = `CREATE TABLE draftroom_api_tokens (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    scope text NOT NULL CHECK (scope IN ('read')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_used_at timestamptz,
    revoked_at timestamptz
  )`;
export const TOKEN_PREFIX = "dft_";
const MAX_ACTIVE = 50;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export type TokenInfo = {
  id: string;
  name: string;
  scope: "read";
  createdAt: string;
  lastUsedAt: string | null;
};
const info = (row: Record<string, any>): TokenInfo => ({
  id: row.id,
  name: row.name,
  scope: row.scope,
  createdAt: new Date(row.created_at).toISOString(),
  lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
});

export function tokenName(value: unknown): string {
  const name = (value as { name?: unknown } | null)?.name;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
    throw new StorageError(400, "invalid_token_name");
  return name.trim();
}

export async function listTokens(pool: Pool): Promise<TokenInfo[]> {
  const { rows } = await pool.query(
    "SELECT id, name, scope, created_at, last_used_at FROM draftroom_api_tokens WHERE revoked_at IS NULL ORDER BY created_at",
  );
  return rows.map(info);
}

export async function createToken(pool: Pool, body: unknown): Promise<TokenInfo & { token: string }> {
  const name = tokenName(body);
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(71405)");
    const { rows: count } = await client.query(
      "SELECT count(*)::int AS n FROM draftroom_api_tokens WHERE revoked_at IS NULL",
    );
    if (count[0].n >= MAX_ACTIVE) throw new StorageError(409, "too_many_tokens");
    const { rows } = await client.query(
      "INSERT INTO draftroom_api_tokens(id, name, token_hash, scope) VALUES ($1, $2, $3, 'read') RETURNING id, name, scope, created_at, last_used_at",
      [randomUUID(), name, digest(token)],
    );
    await client.query("COMMIT");
    return { ...info(rows[0]), token };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function revokeToken(pool: Pool, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new StorageError(404, "token_not_found");
  const { rowCount } = await pool.query(
    "UPDATE draftroom_api_tokens SET revoked_at = clock_timestamp() WHERE id = $1 AND revoked_at IS NULL",
    [id],
  );
  if (!rowCount) throw new StorageError(404, "token_not_found");
}

/** Resolves an `Authorization: Bearer dft_…` header to an active token. */
export async function verifyBearer(pool: Pool, header: string | undefined): Promise<{ id: string; scope: "read" } | null> {
  const match = /^Bearer\s+(dft_[A-Za-z0-9_-]{20,100})\s*$/i.exec(header ?? "");
  if (!match) return null;
  const { rows } = await pool.query(
    "SELECT id, scope, last_used_at FROM draftroom_api_tokens WHERE token_hash = $1 AND revoked_at IS NULL",
    [digest(match[1])],
  );
  if (!rows.length) return null;
  // Record use at most once a minute.
  if (!rows[0].last_used_at || Date.now() - new Date(rows[0].last_used_at).getTime() > 60_000)
    await pool.query("UPDATE draftroom_api_tokens SET last_used_at = clock_timestamp() WHERE id = $1", [rows[0].id]);
  return { id: rows[0].id, scope: rows[0].scope };
}
