import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Pool } from "pg";
import { StorageError } from "./store";

export const SESSION_SECONDS = 7 * 24 * 60 * 60;
const COOKIE = "draftroom_session";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
let activeDerivations = 0;
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    // Keep simultaneous unauthenticated requests from exhausting process memory.
    if (activeDerivations >= 2) {
      reject(new StorageError(429, "too_many_attempts"));
      return;
    }
    activeDerivations++;
    nodeScrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        activeDerivations--;
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [salt, hash] = encoded.split(":");
  if (!/^[a-f0-9]{32}$/.test(salt ?? "") || !/^[a-f0-9]{128}$/.test(hash ?? ""))
    return false;
  return timingSafeEqual(
    await derive(password, salt),
    Buffer.from(hash, "hex"),
  );
}
export function credentials(value: unknown) {
  if (!value || typeof value !== "object")
    throw new StorageError(400, "invalid_credentials");
  const { username, password } = value as Record<string, unknown>;
  if (
    typeof username !== "string" ||
    !username.trim() ||
    username.trim().length > 64 ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 256
  )
    throw new StorageError(400, "invalid_credentials");
  return { username: username.trim(), password };
}
export function assertSameOrigin(request: IncomingMessage) {
  if (request.headers["sec-fetch-site"] === "cross-site")
    throw new StorageError(403, "cross_site_write");
  const origin = request.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.host !== request.headers.host
      )
        throw new Error();
    } catch {
      throw new StorageError(403, "cross_site_write");
    }
  }
}
export function sessionCookie(token: string, secure = false) {
  return `${COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_SECONDS : 0}${secure ? "; Secure" : ""}`;
}
function sessionToken(request: IncomingMessage) {
  const token = request.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export const AUTH_SCHEMA = `CREATE TABLE IF NOT EXISTS draftroom_owner (
    id integer PRIMARY KEY CHECK (id = 1), username text NOT NULL, password_hash text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS draftroom_sessions (
    token_hash text PRIMARY KEY, expires_at timestamptz NOT NULL
  )`;
export async function initializeAuth(pool: Pool) {
  await pool.query(AUTH_SCHEMA);
}
export class OwnerAuth {
  private attempts = 0;
  private windowEnds = 0;
  constructor(private pool: Pool) {}
  // Bound expensive password derivations across all addresses (no unbounded IP map).
  throttle(now = Date.now()) {
    if (now >= this.windowEnds) {
      this.attempts = 0;
      this.windowEnds = now + 5 * 60 * 1000;
    }
    if (++this.attempts > 20) throw new StorageError(429, "too_many_attempts");
  }
  async authenticated(request: IncomingMessage) {
    const token = sessionToken(request);
    if (!token) return false;
    const result = await this.pool.query(
      "SELECT token_hash FROM draftroom_sessions WHERE token_hash = $1 AND expires_at > clock_timestamp()",
      [digest(token)],
    );
    return result.rows.length > 0;
  }
  async status(request: IncomingMessage) {
    const { rows } = await this.pool.query(
      "SELECT username FROM draftroom_owner WHERE id = 1",
    );
    const authenticated =
      rows.length > 0 && (await this.authenticated(request));
    return {
      initialized: rows.length > 0,
      authenticated,
      ...(authenticated ? { username: rows[0].username } : {}),
    };
  }
  async setup(value: unknown) {
    this.throttle();
    const { username, password } = credentials(value);
    const passwordHash = await hashPassword(password);
    const token = randomBytes(32).toString("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "INSERT INTO draftroom_owner(id, username, password_hash) VALUES (1, $1, $2) ON CONFLICT(id) DO NOTHING RETURNING id",
        [username, passwordHash],
      );
      if (!result.rows.length)
        throw new StorageError(409, "owner_already_exists");
      await client.query(
        "INSERT INTO draftroom_sessions(token_hash, expires_at) VALUES ($1, clock_timestamp() + $2 * interval '1 second')",
        [digest(token), SESSION_SECONDS],
      );
      await client.query("COMMIT");
      return { token, username };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async login(value: unknown) {
    this.throttle();
    const { username, password } = credentials(value);
    const { rows } = await this.pool.query(
      "SELECT username, password_hash FROM draftroom_owner WHERE id = 1",
    );
    // Use the same expensive derivation for wrong usernames and missing owners.
    const valid = await verifyPassword(
      password,
      rows[0]?.password_hash ?? `${"0".repeat(32)}:${"0".repeat(128)}`,
    );
    if (!valid || rows[0]?.username !== username)
      throw new StorageError(401, "invalid_credentials");
    const token = randomBytes(32).toString("hex");
    await this.pool.query(
      "DELETE FROM draftroom_sessions WHERE expires_at <= clock_timestamp()",
    );
    await this.pool.query(
      "INSERT INTO draftroom_sessions(token_hash, expires_at) VALUES ($1, clock_timestamp() + $2 * interval '1 second')",
      [digest(token), SESSION_SECONDS],
    );
    return { token, username };
  }
  async logout(request: IncomingMessage) {
    const token = sessionToken(request);
    if (token)
      await this.pool.query(
        "DELETE FROM draftroom_sessions WHERE token_hash = $1",
        [digest(token)],
      );
  }
}
