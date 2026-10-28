// Pipe into: docker compose exec -T api node --import tsx --input-type=module
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { initialize } from "./server/store.ts";
import { initializeAuth } from "./server/auth.ts";
import { migrate, migrations } from "./server/migrations.ts";
const admin = new Pool();
const schema = "h04_" + randomBytes(8).toString("hex");
const pool = new Pool({ options: `-c search_path=${schema}` });
const checks = [];
const check = (name, value) => {
  assert.ok(value, name);
  checks.push(name);
};
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await initialize(pool);
  await initializeAuth(pool);
  await pool.query(
    "INSERT INTO draftroom_owner VALUES(1, 'legacy-owner', 'preserved-hash')",
  );
  await pool.query(
    "INSERT INTO draftroom_library VALUES(1, 7, '{\"legacy\":true}', clock_timestamp())",
  );
  await Promise.all([migrate(pool), migrate(pool)]);
  check(
    "concurrent legacy adoption retains owner/library and applies all versions once",
    (await pool.query("SELECT * FROM draftroom_schema_migrations")).rowCount ===
      3 &&
      (await pool.query("SELECT version FROM draftroom_library")).rows[0]
        .version === "7" &&
      (await pool.query("SELECT username FROM draftroom_owner")).rows[0]
        .username === "legacy-owner",
  );
  const success = {
    version: 4,
    name: "fixture-success",
    sql: "CREATE TABLE fixture_success(id integer)",
  };
  const failure = {
    version: 5,
    name: "fixture-failure",
    sql: "CREATE TABLE fixture_partial(id integer); SELECT nonexistent_column FROM draftroom_owner",
  };
  await assert.rejects(migrate(pool, [...migrations, success, failure]));
  check(
    "failed plan rolls back both earlier DDL and ledger",
    (
      await pool.query(
        "SELECT to_regclass('fixture_success') AS t, to_regclass('fixture_partial') AS p",
      )
    ).rows[0].t === null &&
      (await pool.query("SELECT to_regclass('fixture_partial') AS p")).rows[0]
        .p === null &&
      (await pool.query("SELECT * FROM draftroom_schema_migrations"))
        .rowCount === 3,
  );
  await migrate(pool, [...migrations, success]);
  check(
    "repair and retry applies the recovered plan once",
    (await pool.query("SELECT * FROM draftroom_schema_migrations")).rowCount ===
      4,
  );
  await assert.rejects(migrate(pool));
  check("older application refuses newer schema", true);
  await assert.rejects(
    migrate(pool, [...migrations, { ...success, sql: "SELECT 1" }]),
  );
  check("modified applied migration refuses startup", true);
  await migrate(pool, [...migrations, success]);
  check(
    "repeated recovery retains pre-migration library",
    (await pool.query("SELECT payload FROM draftroom_library")).rows[0].payload
      .legacy === true,
  );
  console.log(JSON.stringify({ passed: checks.length, checks }));
} finally {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
