import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const project = "designfree-test-p01";
const port = 43172;
const env = {
  ...process.env,
  COMPOSE_PROJECT: project,
  DRAFTROOM_BIND_ADDRESS: "127.0.0.1",
  DRAFTROOM_PORT: String(port),
  DRAFTROOM_DB_PASSWORD: randomBytes(32).toString("hex"),
  DRAFTROOM_TEST_USERNAME: `p01-${randomBytes(8).toString("hex")}`,
  DRAFTROOM_TEST_PASSWORD: randomBytes(32).toString("hex"),
  DRAFTROOM_URL: `http://127.0.0.1:${port}/`,
  AUTH_REPORT: "test-results/p01-auth.json",
  SERVER_REPORT: "test-results/p01-storage.json",
  DRAFTROOM_SECURE_COOKIE: "false",
};
for (const key of [
  "COMPOSE_FILE",
  "COMPOSE_ENV_FILES",
  "COMPOSE_PROFILES",
  "DOCKER_DEFAULT_PLATFORM",
  "AUTH_SCREENSHOT",
  "SERVER_SCREENSHOT",
])
  delete env[key];
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args[0]} failed (${result.status})`,
  );
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
    "Refusing existing P01 resources",
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
await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
const override = new URL("../test-results/p01-compose.yaml", import.meta.url);
await writeFile(
  override,
  `services:\n  editor:\n    platform: linux/amd64\n    image: designfree-test-p01-editor:local\n  api:\n    platform: linux/amd64\n    image: designfree-test-p01-api:local\n  postgres:\n    platform: linux/amd64\n`,
);
const compose = [
  "compose",
  "-f",
  `${cwd}compose.yaml`,
  "-f",
  fileURLToPath(override),
  "--env-file",
  "/dev/null",
  "-p",
  project,
];
const evidence = {
  date: new Date().toISOString(),
  host: process.arch,
  docker: run(
    "docker",
    ["info", "--format", "{{.Architecture}} {{.OSType}}"],
    true,
  ),
  images: [],
  checks: [],
};
let failure;
try {
  run("docker", [...compose, "build", "editor", "api"]);
  run("docker", [...compose, "up", "--wait", "--wait-timeout", "180", "-d"]);
  for (const service of ["editor", "api", "postgres"]) {
    const id = run("docker", [...compose, "ps", "-q", service], true);
    const imageId = run(
      "docker",
      ["inspect", "--format", "{{.Image}}", id],
      true,
    );
    const info = JSON.parse(
      run(
        "docker",
        [
          "image",
          "inspect",
          "--platform",
          "linux/amd64",
          "--format",
          "{{json .}}",
          imageId,
        ],
        true,
      ),
    );
    assert.equal(info.Architecture, "amd64");
    assert.equal(info.Os, "linux");
    const runtime = run(
      "docker",
      [...compose, "exec", "-T", service, "uname", "-m"],
      true,
    );
    assert.equal(runtime, "x86_64");
    evidence.images.push({
      service,
      id: info.Id,
      repoDigests: info.RepoDigests,
      os: info.Os,
      architecture: info.Architecture,
      runtime,
    });
  }
  run(process.execPath, ["tests/auth.e2e.mjs"]);
  evidence.checks.push(
    "auth regression including browser first-owner creation",
  );
  run(process.execPath, ["tests/server-storage.e2e.mjs"]);
  evidence.checks.push("server-storage regression");
  env.P01_PHASE = "save";
  run(process.execPath, ["tests/amd64-persistence.e2e.mjs"]);
  run("docker", [...compose, "down"]);
  run("docker", [...compose, "up", "--wait", "--wait-timeout", "180", "-d"]);
  env.P01_PHASE = "load";
  run(process.execPath, ["tests/amd64-persistence.e2e.mjs"]);
  evidence.checks.push(
    "browser edit and exact library reload after all containers recreated with retained volumes",
  );
  evidence.passed = true;
} catch (error) {
  failure = error;
  evidence.passed = false;
} finally {
  try {
    run("docker", [...compose, "down", "-v", "--remove-orphans"]);
    evidence.cleaned = true;
  } catch (error) {
    failure ??= error;
    evidence.cleaned = false;
  }
  await writeFile(
    new URL("../test-results/p01-environment.json", import.meta.url),
    JSON.stringify(evidence, null, 2) + "\n",
  );
}
if (failure) throw failure;
