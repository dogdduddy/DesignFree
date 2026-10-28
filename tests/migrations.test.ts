import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { migrate, migrations, migrationHash } from "../server/migrations";

function database(rows: unknown[] = [], failOn = "") {
  const query = vi.fn(async (sql: string) => {
    if (sql === failOn) throw new Error("injected migration failure");
    return { rows: sql.startsWith("SELECT version") ? rows : [] };
  });
  const release = vi.fn();
  return {
    query,
    release,
    pool: { connect: async () => ({ query, release }) } as unknown as Pool,
  };
}
describe("atomic schema migration", () => {
  it("applies a complete plan under the database lock before commit", async () => {
    const db = database();
    await migrate(db.pool);
    const calls = db.query.mock.calls.map(([sql]) => sql);
    expect(calls[0]).toBe("BEGIN");
    expect(calls[1]).toBe("SELECT pg_advisory_xact_lock(71404)");
    expect(calls.at(-1)).toBe("COMMIT");
    for (const step of migrations) expect(calls).toContain(step.sql);
    expect(db.release).toHaveBeenCalledOnce();
  });
  it("does not execute already applied DDL", async () => {
    const db = database(
      migrations.map((step) => ({ ...step, checksum: migrationHash(step) })),
    );
    await migrate(db.pool);
    for (const step of migrations)
      expect(db.query).not.toHaveBeenCalledWith(step.sql);
  });
  it("rolls back the full plan on failure and releases its connection", async () => {
    const db = database([], migrations[2].sql);
    await expect(migrate(db.pool)).rejects.toThrow("injected");
    expect(db.query).toHaveBeenCalledWith("ROLLBACK");
    expect(db.query).not.toHaveBeenCalledWith("COMMIT");
    expect(db.release).toHaveBeenCalledOnce();
  });
  it("rejects changed, newer and discontinuous histories", async () => {
    for (const rows of [
      [{ version: 1, name: "changed", checksum: "bad" }],
      Array.from({ length: 4 }, (_, i) => ({ version: i + 1 })),
      [{ ...migrations[1], checksum: migrationHash(migrations[1]) }],
    ]) {
      const db = database(rows);
      await expect(migrate(db.pool)).rejects.toThrow();
      expect(db.query).toHaveBeenCalledWith("ROLLBACK");
    }
    await expect(migrate(database().pool, [migrations[1]])).rejects.toThrow(
      "contiguous",
    );
  });
});
