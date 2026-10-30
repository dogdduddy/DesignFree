import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// Own a fresh project for this invocation only. Never read the personal .env.
const cwd = fileURLToPath(new URL("../", import.meta.url));
const project = "designfree-test-d03";
const port = 43189;
const env = {
  ...process.env,
  COMPOSE_PROJECT: project,
  DRAFTROOM_BIND_ADDRESS: "127.0.0.1",
  DRAFTROOM_PORT: String(port),
  DRAFTROOM_DB_PASSWORD: randomBytes(32).toString("hex"),
  DRAFTROOM_TEST_USERNAME: `d03-${randomBytes(8).toString("hex")}`,
  DRAFTROOM_TEST_PASSWORD: randomBytes(32).toString("hex"),
  STYLE_SERVER: "1",
  SHARED_STYLE_REPORT: "test-results/d03-server-shared-styles.json",
  NUMERIC_STYLE_REPORT: "test-results/d03-server-numeric-styles.json",
  COMPONENT_SERVER: "1",
  STYLE_EDITOR_REPORT: "test-results/d03-server-style-editor.json",
  STYLE_REPORT: "test-results/d03-server-styles.json",
  STYLE_EDITOR_SCREENSHOT: "test-results/d03-server-style-editor.png",
  STYLE_SCREENSHOT: "test-results/d03-server-styles.png",
  COMPONENT_REPORT: "test-results/d03-server-components.json",
  DRAFTROOM_SECURE_COOKIE: "false",
  DRAFTROOM_URL: `http://127.0.0.1:${port}/`,
};
delete env.COMPOSE_FILE;
delete env.COMPOSE_ENV_FILES;
delete env.COMPOSE_PROFILES;
delete env.DOCKER_DEFAULT_PLATFORM;
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
for (const args of [
  ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`],
  [
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ],
  [
    "network",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ],
])
  assert.equal(
    run("docker", args, true),
    "",
    "Refusing existing D03 resources",
  );
// Compose can reuse same-name resources even when their project label is absent.
for (const [kind, names] of [
  ["volume", [`${project}_document-data`, `${project}_asset-data`]],
  ["network", [`${project}_default`]],
]) {
  const existing = run(
    "docker",
    [kind, "ls", "--format", "{{.Name}}"],
    true,
  ).split("\n");
  for (const name of names)
    assert.ok(!existing.includes(name), `Refusing existing ${kind} ${name}`);
}
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
  for (const suite of [
    "shared-style-libraries",
    "numeric-styles",
    "style-editor",
    "styles",
    "components",
    "auth",
    "server-storage",
  ]) {
    console.log(`D03 server: ${suite}`);
    run(process.execPath, [`tests/${suite}.e2e.mjs`]);
  }
} finally {
  run("docker", [...compose, "down", "-v", "--remove-orphans"]);
}
