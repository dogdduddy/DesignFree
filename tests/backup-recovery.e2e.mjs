import { serverTestUrl, browserLaunchOptions, artifactPath } from "./browser-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { authenticatedTestSession } from "./auth-helpers.mjs";
import { checksum } from "../scripts/backup.mjs";
const project = process.env.COMPOSE_PROJECT;
assert.ok(
  project?.startsWith("draftroom-h04-test"),
  "This destructive recovery suite requires a disposable draftroom-h04-test project",
);
const url = serverTestUrl();
const compose = ["compose", "-p", project];
const docker = (args, input) =>
  execFileSync("docker", [...compose, ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
  });
const command = (mode, path) =>
  execFileSync(process.execPath, ["scripts/backup.mjs", mode, path], {
    encoding: "utf8",
    timeout: 120000,
  });
const auth = await authenticatedTestSession(url);
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage({
  storageState: auth.storageState,
  viewport: { width: 1440, height: 1000 },
});
const errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const check = async (name, run) => {
  await run();
  checks.push(name);
  console.log("PASS " + name);
};
const directory = await mkdtemp(join(tmpdir(), "draftroom-h04-"));
const backup = join(directory, "snapshot");
const ready = () =>
  page.waitForFunction(() =>
    ["saved", "idle"].includes(
      document.querySelector('[data-testid="save-status"]')?.dataset.state,
    ),
  );
const load = async () => {
  // A stopped/recreated HTTP server can close a pooled keep-alive socket.
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await auth.fetch("/api/library/current", {
        headers: { Connection: "close" },
      });
      assert.equal(r.status, 200);
      return await r.json();
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
};
let initial, reference;
let complete = false;
try {
  await check(
    "browser creates and acknowledges a document with a PNG",
    async () => {
      await page.goto(url, { waitUntil: "networkidle" });
      await ready();
      await page.locator(".document-library summary").click();
      await page.getByRole("button", { name: "새 문서", exact: true }).click();
      await ready();
      const png = Buffer.from(
        await page.evaluate(() => {
          const c = document.createElement("canvas");
          c.width = 9;
          c.height = 7;
          const g = c.getContext("2d");
          g.fillStyle = "#12ab34";
          g.fillRect(0, 0, 9, 7);
          return c.toDataURL().split(",")[1];
        }),
        "base64",
      );
      await page.locator('input[accept="image/png"]').setInputFiles({
        name: "recovery.png",
        mimeType: "image/png",
        buffer: png,
      });
      await page
        .getByTestId("asset-status")
        .filter({ hasText: "이미지 1개" })
        .waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-status"]')?.dataset
            .state === "saved",
      );
      initial = await load();
      assert.ok(
        Object.values(initial.document.assets).some(
          (a) =>
            a.dataUrl === "data:image/png;base64," + png.toString("base64"),
        ),
      );
      reference = createHash("sha256")
        .update(JSON.stringify(initial))
        .digest("hex");
    },
  );
  await check(
    "offline backup contains checksummed database and PNG volume pair and resumes traffic",
    async () => {
      command("backup", backup);
      const manifest = JSON.parse(
        await readFile(join(backup, "manifest.json")),
      );
      assert.equal(manifest.format, 1);
      assert.throws(
        () => command("backup", backup),
        "existing snapshot must never be overwritten",
      );
      assert.ok(
        (await readFile(join(backup, "assets.ndjson"), "utf8")).includes(
          ".png",
        ),
      );
      assert.equal(
        createHash("sha256")
          .update(JSON.stringify(await load()))
          .digest("hex"),
        reference,
      );
    },
  );
  await check(
    "corrupt snapshot is rejected before stopping services",
    async () => {
      const corrupt = join(directory, "corrupt");
      await cp(backup, corrupt, { recursive: true });
      await writeFile(join(corrupt, "assets.ndjson"), "corruption");
      assert.throws(() => command("restore", corrupt));
      assert.equal((await load()).version, initial.version);
    },
  );
  await check(
    "restore SQL failure atomically rolls back and automatically recovers DB and PNGs",
    async () => {
      const bad = join(directory, "bad-sql");
      await cp(backup, bad, { recursive: true });
      await writeFile(
        join(bad, "database.sql"),
        "\nSELECT deliberately_invalid_sql;\n",
        { flag: "a" },
      );
      const manifest = JSON.parse(await readFile(join(bad, "manifest.json")));
      manifest.files["database.sql"] = await checksum(
        join(bad, "database.sql"),
      );
      await writeFile(join(bad, "manifest.json"), JSON.stringify(manifest));
      assert.throws(() => command("restore", bad));
      assert.deepEqual(await load(), initial);
    },
  );
  await check(
    "killed restore CLI terminates orphan workers and resumes from the original paired recovery snapshot",
    async () => {
      const slow = join(directory, "slow");
      await cp(backup, slow, { recursive: true });
      await writeFile(join(slow, "database.sql"), "\nSELECT pg_sleep(60);\n", {
        flag: "a",
      });
      const manifest = JSON.parse(await readFile(join(slow, "manifest.json")));
      manifest.files["database.sql"] = await checksum(
        join(slow, "database.sql"),
      );
      await writeFile(join(slow, "manifest.json"), JSON.stringify(manifest));
      const child = spawn(
        process.execPath,
        ["scripts/backup.mjs", "restore", slow],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.resume();
      child.stderr.resume();
      const exited = new Promise((resolve) => child.once("exit", resolve));
      let sleeping = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const count = docker([
          "exec",
          "-T",
          "postgres",
          "psql",
          "-XAt",
          "-U",
          "draftroom",
          "-d",
          "draftroom",
          "-c",
          "SELECT count(*) FROM pg_stat_activity WHERE query='SELECT pg_sleep(60);' AND state='active'",
        ]);
        if (Number(count.trim()) > 0) {
          sleeping = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      try {
        assert.ok(sleeping, "restore transaction reached its deliberate pause");
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
      // Force the retry to fail too: rollback must use the original pre-restore pair.
      const invalid = join(directory, "retry-invalid");
      await cp(backup, invalid, { recursive: true });
      await writeFile(
        join(invalid, "database.sql"),
        "\nSELECT invalid_retry_sql;\n",
        { flag: "a" },
      );
      const bad = JSON.parse(await readFile(join(invalid, "manifest.json")));
      bad.files["database.sql"] = await checksum(join(invalid, "database.sql"));
      await writeFile(join(invalid, "manifest.json"), JSON.stringify(bad));
      assert.throws(() => command("restore", invalid));
      assert.deepEqual(await load(), initial);
      assert.equal(
        execFileSync(
          "docker",
          [
            "ps",
            "-aq",
            "--filter",
            `label=io.draftroom.maintenance=${project}`,
          ],
          { encoding: "utf8" },
        ).trim(),
        "",
      );
    },
  );
  await check(
    "changed DB and removed PNGs restore to the same committed library, owner/session and assets",
    async () => {
      const change = structuredClone(initial);
      change.document.name = "after-backup";
      const r = await auth.fetch("/api/library/current", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document: change.document,
          documents: change.documents,
          operationId: randomUUID(),
          expectedVersion: initial.version,
        }),
      });
      assert.equal(r.status, 200);
      docker([
        "exec",
        "-T",
        "api",
        "node",
        "--input-type=module",
        "-e",
        "import {readdir,rm} from 'node:fs/promises'; for(const d of await readdir('/app/asset-data')) await rm('/app/asset-data/'+d,{recursive:true,force:true})",
      ]);
      command("restore", backup);
      assert.deepEqual(await load(), initial);
      await page.reload({ waitUntil: "networkidle" });
      await ready();
      assert.equal(
        await page.locator('[data-asset-status="missing"]').count(),
        0,
      );
    },
  );
  await check(
    "asset restore failure after successful SQL rolls back the entire DB and PNG pair",
    async () => {
      const badAssets = join(directory, "bad-assets");
      await cp(backup, badAssets, { recursive: true });
      await writeFile(
        join(badAssets, "assets.ndjson"),
        '{"path":"../invalid","data":"bad"}\n',
      );
      const manifest = JSON.parse(
        await readFile(join(badAssets, "manifest.json")),
      );
      manifest.files["assets.ndjson"] = await checksum(
        join(badAssets, "assets.ndjson"),
      );
      await writeFile(
        join(badAssets, "manifest.json"),
        JSON.stringify(manifest),
      );
      assert.throws(() => command("restore", badAssets));
      assert.deepEqual(await load(), initial);
    },
  );
  await check(
    "backup restores into entirely fresh database and asset volumes",
    async () => {
      docker(["down", "-v"]);
      docker(["up", "-d", "--no-build", "--wait", "postgres"]);
      command("restore", backup);
      docker(["up", "-d", "--no-build", "--wait"]);
      assert.deepEqual(await load(), initial);
      await page.reload({ waitUntil: "networkidle" });
      await ready();
    },
  );
  await check(
    "all containers recreate with identical document/PNG references and persistent session",
    async () => {
      const before = docker(["ps", "-q"]).trim().split("\n");
      docker(["up", "-d", "--no-build", "--force-recreate", "--wait"]);
      const after = docker(["ps", "-q"]).trim().split("\n");
      assert.ok(before.every((id) => !after.includes(id)));
      assert.deepEqual(await load(), initial);
      await page.reload({ waitUntil: "networkidle" });
      await ready();
    },
  );
  await check(
    "SIGKILL of API/PostgreSQL/editor recovers committed state and rolls back an open transaction",
    async () => {
      const pending = spawn(
        "docker",
        [
          ...compose,
          "exec",
          "-T",
          "postgres",
          "psql",
          "-X",
          "-U",
          "draftroom",
          "-d",
          "draftroom",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const completed = new Promise((resolve) => pending.on("close", resolve));
      let reached = "";
      const started = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("transaction did not start")),
          10000,
        );
        pending.stdout.on("data", (bytes) => {
          reached += bytes;
          if (reached.includes("UNCOMMITTED_READY")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      pending.stdin.end(
        "BEGIN; INSERT INTO draftroom_operations VALUES('h04-uncommitted', 'fixture', '{}');\\echo UNCOMMITTED_READY\nSELECT pg_sleep(60); COMMIT;\n",
      );
      await started;
      docker(["kill", "-s", "SIGKILL", "api", "postgres", "editor"]);
      await completed;
      docker(["up", "-d", "--no-build", "--wait"]);
      assert.equal(
        docker([
          "exec",
          "-T",
          "postgres",
          "psql",
          "-XAt",
          "-U",
          "draftroom",
          "-d",
          "draftroom",
          "-c",
          "SELECT count(*) FROM draftroom_operations WHERE operation_id='h04-uncommitted'",
        ]).trim(),
        "0",
      );
      assert.deepEqual(await load(), initial);
      assert.match(
        docker(["logs", "--no-color", "postgres"]),
        /database system was interrupted|redo starts at|automatic recovery in progress/,
      );
      await page.reload({ waitUntil: "networkidle" });
      await ready();
    },
  );
  await check(
    "actual PostgreSQL migration adoption, failure, repair, concurrency and version guards",
    async () => {
      const output = docker(
        ["exec", "-T", "api", "node", "--import", "tsx", "--input-type=module"],
        await readFile("tests/migrations.postgres.mjs", "utf8"),
      );
      const result = JSON.parse(output.trim().split("\n").at(-1));
      assert.equal(result.passed, 6);
    },
  );
  assert.deepEqual(errors, []);
  await writeFile(
    process.env.BACKUP_REPORT || artifactPath("126-h04-recovery-browser.json"),
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        pageErrors: errors,
        project,
        browser: browser.version(),
        snapshotReference: reference,
        physicalPowerLossVerified: false,
      },
      null,
      2,
    ) + "\n",
  );
  complete = true;
} finally {
  await browser.close();
  if (complete) await rm(directory, { recursive: true, force: true });
  else console.error("Recovery fixtures retained: " + directory);
}
