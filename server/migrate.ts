import { Pool } from "pg";
import { migrate } from "./migrations";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});
try {
  await migrate(pool);
  console.log("Draftroom schema migrations complete");
} finally {
  await pool.end();
}
