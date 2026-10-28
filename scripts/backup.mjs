import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  lstat,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { createServer } from "node:net";

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = process.env.COMPOSE_PROJECT || "designfree";
if (!/^[a-z0-9][a-z0-9_-]*$/.test(project) || project.startsWith("penpot"))
  throw new Error("Invalid Draftroom project");
const compose = ["compose", "-p", project];
const applicationPrefix =
  "draftroom-maintenance-" +
  createHash("sha256").update(project).digest("hex").slice(0, 16) +
  "-";
let helpers;
const files = ["database.sql", "assets.ndjson"];
export async function checksum(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function verifySnapshot(path) {
  const manifest = JSON.parse(
    await readFile(join(path, "manifest.json"), "utf8"),
  );
  if (
    manifest.format !== 1 ||
    manifest.postgresMajor !== 17 ||
    Object.keys(manifest.files || {})
      .sort()
      .join(",") !== [...files].sort().join(",")
  )
    throw new Error("Unsupported or incomplete snapshot");
  for (const name of files) {
    const file = join(path, name);
    if (
      !(await lstat(file)).isFile() ||
      (await checksum(file)) !== manifest.files[name]
    )
      throw new Error("Snapshot integrity failure: " + name);
  }
  return manifest;
}
async function docker(args, { input, output, capture = false } = {}) {
  const child = spawn(
    "docker",
    args[0] === "@global" ? args.slice(1) : [...compose, ...args],
    {
      cwd,
      stdio: [
        input ? "pipe" : "ignore",
        output || capture ? "pipe" : "inherit",
        "inherit",
      ],
    },
  );
  const completed = new Promise((ok, fail) => {
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? ok() : fail(new Error(`docker ${args[0]} failed (${code})`)),
    );
  });
  const jobs = [completed];
  let text = "";
  if (capture)
    child.stdout.on("data", (chunk) => {
      text += chunk;
    });
  if (input) jobs.push(pipeline(createReadStream(input), child.stdin));
  if (output)
    jobs.push(
      pipeline(
        child.stdout,
        createWriteStream(output, { flags: "wx", mode: 0o600 }),
      ),
    );
  await Promise.all(jobs);
  return text.trim();
}
const assetCommand = (mode) => [
  "@global",
  "exec",
  "-i",
  helpers.api,
  "node",
  "server/backup-assets.mjs",
  mode,
];
const postgresCommand = (args) => [
  "@global",
  "exec",
  "-i",
  "-e",
  "PGAPPNAME=" + applicationPrefix + helpers.postgres.slice(-17, -9),
  helpers.postgres,
  "sh",
  "-c",
  'export PGPASSWORD="$POSTGRES_PASSWORD"; exec "$@"',
  "--",
  ...args,
];
async function stopOrphanHelpers() {
  const ids = (
    await docker(
      [
        "@global",
        "ps",
        "-aq",
        "--filter",
        `label=io.draftroom.maintenance=${project}`,
      ],
      { capture: true },
    )
  )
    .split("\n")
    .filter(Boolean);
  if (ids.length) await docker(["@global", "rm", "-f", ...ids]);
  // Closing a TCP client does not immediately interrupt a sleeping PostgreSQL query.
  // Terminate our orphan backends explicitly so their transactions release locks.
  await docker(
    [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-X",
      "-U",
      "draftroom",
      "-d",
      "draftroom",
      "-c",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name LIKE '${applicationPrefix}%' AND pid <> pg_backend_pid()`,
    ],
    { capture: true },
  );
}
async function startHelpers() {
  for (const service of ["api", "postgres"])
    await docker([
      "run",
      "-d",
      "--rm",
      "--no-deps",
      "--name",
      helpers[service],
      "--label",
      `io.draftroom.maintenance=${project}`,
      "--entrypoint",
      "sleep",
      service,
      "infinity",
    ]);
}
async function snapshot(path) {
  // Publish only a complete directory. Refuse overwriting an older backup.
  try {
    await lstat(path);
    throw new Error("Snapshot destination already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temp = path + ".partial-" + randomUUID();
  await mkdir(temp, { recursive: true, mode: 0o700 });
  try {
    await docker(
      postgresCommand([
        "pg_dump",
        "-h",
        "postgres",
        "-U",
        "draftroom",
        "-d",
        "draftroom",
        "--schema=public",
        "--no-owner",
        "--no-privileges",
      ]),
      { output: join(temp, files[0]) },
    );
    await docker(assetCommand("export"), { output: join(temp, files[1]) });
    const manifest = {
      format: 1,
      postgresMajor: 17,
      project,
      createdAt: new Date().toISOString(),
      files: {},
    };
    for (const file of files)
      manifest.files[file] = await checksum(join(temp, file));
    await writeFile(
      join(temp, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 },
    );
    await verifySnapshot(temp);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}
async function install(path) {
  await verifySnapshot(path);
  // pg_dump includes public schema creation. Drop + restore share one transaction.
  const sql = path + ".restore-" + randomUUID() + ".sql";
  try {
    await writeFile(sql, "DROP SCHEMA public CASCADE;\n", {
      flag: "wx",
      mode: 0o600,
    });
    const append = createWriteStream(sql, { flags: "a" });
    await pipeline(createReadStream(join(path, files[0])), append);
    await docker(
      postgresCommand([
        "psql",
        "-h",
        "postgres",
        "-X",
        "-U",
        "draftroom",
        "-d",
        "draftroom",
        "--single-transaction",
        "--set=ON_ERROR_STOP=1",
      ]),
      { input: sql },
    );
    await docker(assetCommand("import"), { input: join(path, files[1]) });
    // Migrate with the installed binary before reopening traffic. Failure triggers rollback.
    await docker([
      "@global",
      "exec",
      "-e",
      "PGAPPNAME=" + applicationPrefix + "migration",
      helpers.api,
      "node",
      "--import",
      "tsx",
      "server/migrate.ts",
    ]);
  } finally {
    await rm(sql, { force: true });
  }
}
async function maintain(command, target) {
  if (!["backup", "restore"].includes(command) || !target)
    throw new Error(
      "Usage: node scripts/backup.mjs backup|restore /absolute/snapshot-directory",
    );
  const path = resolve(target);
  if (command === "restore") await verifySnapshot(path);
  const lock = join(cwd, ".maintenance", project);
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  let interrupted;
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = await readFile(join(lock, "owner.json"), "utf8")
      .then(JSON.parse)
      .catch(() => ({}));
    interrupted = owner;
    if (owner.host && owner.host !== hostname())
      throw new Error("Maintenance lock belongs to another host");
    try {
      if (!Number.isInteger(owner.pid))
        throw Object.assign(new Error("Missing owner"), { code: "ESRCH" });
      process.kill(owner.pid, 0);
      throw new Error("Maintenance already running");
    } catch (check) {
      if (check.code !== "ESRCH") throw check;
    }
    if (command !== "restore")
      throw new Error(
        "Interrupted maintenance: restore the recovery snapshot listed in " +
          join(lock, "owner.json"),
      );
    // An explicit restore is the recovery path after a killed maintenance process.
  }
  let running = (
    await docker(["ps", "--status", "running", "--services"], { capture: true })
  )
    .split("\n")
    .filter((s) => ["editor", "api"].includes(s));
  if (interrupted?.running)
    running = [
      ...new Set([
        ...running,
        ...interrupted.running.filter((s) => ["editor", "api"].includes(s)),
      ]),
    ];
  // Never use an interrupted restore's potentially mixed DB/assets as rollback truth.
  let inheritedRecovery;
  if (interrupted) {
    inheritedRecovery =
      interrupted.command === "restore" && interrupted.recovery
        ? await verifySnapshot(interrupted.recovery)
            .then(() => interrupted.recovery)
            .catch(() => path)
        : path;
  }
  const recovery = inheritedRecovery || path + ".before-" + randomUUID();
  const helperPrefix = `${project}-maintenance-${randomUUID()}`;
  helpers = {
    api: helperPrefix + "-api",
    postgres: helperPrefix + "-postgres",
  };
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify(
      {
        pid: process.pid,
        host: hostname(),
        command,
        path,
        recovery,
        running,
        interrupted,
        helpers,
      },
      null,
      2,
    ),
  );
  let safe = false;
  try {
    await stopOrphanHelpers();
    await docker(["stop", "-t", "30", "editor", "api"]);
    const stillRunning = await docker(
      ["ps", "--status", "running", "--services"],
      { capture: true },
    );
    if (stillRunning.split("\n").some((s) => ["editor", "api"].includes(s)))
      throw new Error("Writers are still running");
    await startHelpers();
    if (command === "backup") {
      // Export is read-only: even an unsuccessful export may resume the writers.
      safe = true;
      await snapshot(path);
    } else {
      if (!inheritedRecovery) await snapshot(recovery);
      console.log("Pre-restore recovery snapshot: " + recovery);
      try {
        await install(path);
        safe = true;
      } catch (error) {
        console.error(
          "Restore failed; rolling back DB and assets to " + recovery,
        );
        try {
          await install(recovery);
          safe = true;
        } catch {
          console.error(
            "Recovery failed. Services remain stopped. Retry restore with compatible API image: " +
              recovery,
          );
        }
        throw error;
      }
    }
    console.log(command + " complete: " + path);
  } finally {
    await stopOrphanHelpers();
    if (safe) {
      if (running.length)
        await docker(["up", "-d", "--no-deps", "--wait", ...running]);
      await rm(lock, { recursive: true });
    } else
      console.error(
        "Maintenance lock retained; services remain stopped: " + lock,
      );
  }
}
export async function main(command, target) {
  const port =
    49152 +
    (Number.parseInt(
      createHash("sha256").update(project).digest("hex").slice(0, 8),
      16,
    ) %
      16000);
  const guard = createServer();
  await new Promise((ok, fail) => {
    guard.once("error", fail);
    guard.listen({ host: "127.0.0.1", port, exclusive: true }, ok);
  });
  try {
    return await maintain(command, target);
  } finally {
    await new Promise((resolve) => guard.close(resolve));
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main(process.argv[2], process.argv[3]);
