import type { AssetVolume } from "./assets";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  validateLibrary,
  type SaveAck,
  type SaveRequest,
} from "../src/server-storage";

export class StorageError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

// JSON object key ordering is not payload identity. Array ordering remains meaningful.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export function validateRequest(value: unknown): SaveRequest {
  if (!value || typeof value !== "object")
    throw new StorageError(400, "invalid_request");
  const raw = value as SaveRequest;
  if (
    typeof raw.operationId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.operationId) ||
    !Number.isSafeInteger(raw.expectedVersion) ||
    raw.expectedVersion < 0 ||
    raw.expectedVersion >= Number.MAX_SAFE_INTEGER ||
    Object.keys(raw).some(
      (k) =>
        !["operationId", "expectedVersion", "document", "documents"].includes(
          k,
        ),
    )
  )
    throw new StorageError(400, "invalid_request");
  try {
    return {
      ...validateLibrary(raw),
      operationId: raw.operationId,
      expectedVersion: raw.expectedVersion,
    };
  } catch {
    throw new StorageError(400, "invalid_document");
  }
}

export const STORAGE_SCHEMA = `CREATE TABLE IF NOT EXISTS draftroom_library (
    id integer PRIMARY KEY CHECK (id = 1), version bigint NOT NULL CHECK (version >= 1),
    payload jsonb NOT NULL, updated_at timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS draftroom_operations (
    operation_id text PRIMARY KEY, request_hash text NOT NULL, ack jsonb NOT NULL
  )`;
export async function initialize(pool: Pool) {
  await pool.query(STORAGE_SCHEMA);
}
export async function loadLibrary(pool: Pool, assets?: AssetVolume) {
  const { rows } = await pool.query(
    "SELECT version, payload, updated_at FROM draftroom_library WHERE id = 1",
  );
  if (assets && rows.length)
    rows[0].payload = await assets.unpack(rows[0].payload);
  return rows.length
    ? {
        ...rows[0].payload,
        version: Number(rows[0].version),
        updatedAt: rows[0].updated_at.toISOString(),
      }
    : null;
}
export async function saveLibrary(
  pool: Pool,
  value: unknown,
  assets?: AssetVolume,
): Promise<SaveAck> {
  const request = validateRequest(value);
  // Hash the complete accepted request, not normalized output: changes to ignored
  // document fields must not silently reuse an already committed operation ID.
  const hash = createHash("sha256").update(canonical(value)).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Fixed transaction lock includes initial creation and ledger lookup. The
    // singleton library is the same atomicity boundary as F01 IndexedDB storage.
    await client.query("SELECT pg_advisory_xact_lock(71401)");
    const previous = await client.query(
      "SELECT request_hash, ack FROM draftroom_operations WHERE operation_id = $1",
      [request.operationId],
    );
    let ack: SaveAck;
    if (previous.rows.length) {
      if (previous.rows[0].request_hash !== hash)
        throw new StorageError(422, "operation_payload_mismatch");
      ack = previous.rows[0].ack;
    } else {
      const current = await client.query(
        "SELECT version FROM draftroom_library WHERE id = 1",
      );
      if (Number(current.rows[0]?.version ?? 0) !== request.expectedVersion)
        throw new StorageError(409, "stale_version");
      const time = await client.query("SELECT clock_timestamp() AS now");
      ack = {
        operationId: request.operationId,
        version: request.expectedVersion + 1,
        updatedAt: time.rows[0].now.toISOString(),
      };
      const library = {
        document: request.document,
        documents: request.documents,
      };
      const payload = JSON.stringify(
        assets ? await assets.pack(library) : library,
      );
      await client.query(
        `INSERT INTO draftroom_library(id, version, payload, updated_at) VALUES(1, $1, $2, $3)
        ON CONFLICT(id) DO UPDATE SET version = EXCLUDED.version, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
        [ack.version, payload, ack.updatedAt],
      );
      await client.query(
        "INSERT INTO draftroom_operations(operation_id, request_hash, ack) VALUES($1, $2, $3)",
        [request.operationId, hash, JSON.stringify(ack)],
      );
    }
    await client.query("COMMIT");
    // Only this resolved value may be sent over HTTP. A failed/ambiguous COMMIT
    // never becomes a success response; retry consults the durable ledger.
    return ack;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
