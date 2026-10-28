import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { STORAGE_SCHEMA } from "./store";
import { AUTH_SCHEMA } from "./auth";

export const migrations = [
  { version: 1, name: "library-and-operation-ledger", sql: STORAGE_SCHEMA },
  { version: 2, name: "owner-and-sessions", sql: AUTH_SCHEMA },
  {
    version: 3,
    name: "session-expiry-index",
    sql: "CREATE INDEX draftroom_sessions_expiry ON draftroom_sessions(expires_at)",
  },
];
export type Migration = (typeof migrations)[number];
export const migrationHash = (step: Migration) =>
  createHash("sha256")
    .update(`${step.version}:${step.name}:${step.sql}`)
    .digest("hex");

/** A failed upgrade rolls back the complete plan, including the version ledger.
 * Legacy H01/H03 tables are adopted by the idempotent baseline statements.
 * Never serve HTTP against a newer or modified migration history.
 */
export async function migrate(pool: Pool, plan: Migration[] = migrations) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(71404)");
    await client.query(`CREATE TABLE IF NOT EXISTS draftroom_schema_migrations (
      version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const { rows } = await client.query(
      "SELECT version, name, checksum FROM draftroom_schema_migrations ORDER BY version",
    );
    if (rows.length > plan.length)
      throw new Error(
        "Database schema is newer than this application; restore a compatible backup",
      );
    for (const [index, step] of plan.entries()) {
      if (step.version !== index + 1)
        throw new Error("Migration versions must be contiguous");
      const applied = rows[index];
      if (applied) {
        if (
          applied.version !== step.version ||
          applied.name !== step.name ||
          applied.checksum !== migrationHash(step)
        )
          throw new Error(
            `Migration history mismatch at version ${step.version}`,
          );
      } else {
        await client.query(step.sql);
        await client.query(
          "INSERT INTO draftroom_schema_migrations(version, name, checksum) VALUES($1, $2, $3)",
          [step.version, step.name, migrationHash(step)],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
