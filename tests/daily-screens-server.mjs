import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// Own a fresh project for this invocation only. Never read the personal .env.
const cwd = fileURLToPath(new URL("../", import.meta.url));
const project = "designfree-test-a01";
const port = 43171;
const env = {
  ...process.env,
  COMPOSE_PROJECT: project,
  DRAFTROOM_BIND_ADDRESS: "127.0.0.1",
  DRAFTROOM_PORT: String(port),
  DRAFTROOM_DB_PASSWORD: randomBytes(32).toString("hex"),
  DRAFTROOM_TEST_USERNAME: `a01-${randomBytes(8).toString("hex")}`,
  DRAFTROOM_TEST_PASSWORD: randomBytes(32).toString("hex"),
  DRAFTROOM_URL: `http://127.0.0.1:${port}/`,
  A01_SERVER: "1",
};
delete env.COMPOSE_FILE;
delete env.COMPOSE_ENV_FILES;
delete env.COMPOSE_PROFILES;
const compose = [
  "compose",
  "-f",
  fileURLToPath(new URL("../compose.yaml", import.meta.url)),
  "--env-file",
  "/dev/null",
  "-p",
  project,
];
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${command} failed (${result.status})`);
  return result.stdout?.trim();
}
for (const [kind, args] of [
  [
    "containers",
    ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`],
  ],
  [
    "volumes",
    [
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
  ],
])
  assert.equal(
    run("docker", args, true),
    "",
    `Existing ${project} ${kind}: refusing to reuse or remove them`,
  );
await new Promise((resolve, reject) => {
  const socket = createServer();
  socket.once("error", reject);
  socket.listen(port, "127.0.0.1", () => socket.close(resolve));
});
try {
  run("docker", [
    ...compose,
    "up",
    "--build",
    "--wait",
    "--wait-timeout",
    "120",
    "-d",
  ]);
  // Separate Chromium processes; server data survives between both runs.
  for (let repeat = 1; repeat <= 2; repeat++) {
    env.A01_RUN = String(repeat);
    console.log(`A01 server acceptance run ${repeat}/2`);
    run(process.execPath, ["tests/daily-screens.e2e.mjs"]);
  }
  if (process.env.A01_REGRESSIONS === "1") {
    run(process.execPath, ["tests/auth.e2e.mjs"]);
    run(process.execPath, ["tests/server-storage.e2e.mjs"]);
  }
} finally {
  run("docker", [...compose, "down", "-v", "--remove-orphans"]);
}
