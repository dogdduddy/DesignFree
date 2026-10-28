import { migrate } from "./migrations";
import { AssetVolume } from "./assets";
import { Pool } from "pg";
import { createApi } from "./http";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  max: 10,
});
pool.on("error", (error) => console.error("PostgreSQL pool error", error.name));
await migrate(pool);
const server = createApi(
  pool,
  new AssetVolume(process.env.ASSET_ROOT ?? "./asset-data"),
);
server.listen(
  Number(process.env.PORT ?? 3000),
  process.env.HOST ?? "127.0.0.1",
  () => console.log("Draftroom API ready"),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close(() => void pool.end());
  });
