import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;
function check(label, ok, advice, required = true) {
  console.log(
    `${ok ? "OK" : required ? "MISSING" : "OPTIONAL"} ${label}${ok ? "" : ": " + advice}`,
  );
  if (required && !ok) failed = true;
}
const major = Number(process.versions.node.split(".")[0]);
check("Node.js 26", major === 26, "Use the version in .nvmrc / .node-version.");
check("Dependencies", existsSync(resolve(root, "node_modules")), "Run npm ci.");
const docker = spawnSync("docker", ["compose", "version"], {
  cwd: root,
  encoding: "utf8",
});
check(
  "Docker Compose v2",
  docker.status === 0,
  "Install/start Docker with Compose for server mode.",
  false,
);
check(
  "Private environment",
  existsSync(resolve(root, ".env")),
  "Run npm run setup for Docker mode.",
  false,
);
try {
  const { chromium } = await import("@playwright/test");
  check(
    "Bundled Chromium",
    existsSync(chromium.executablePath()),
    "Run npx playwright install chromium, or set CHROME_EXECUTABLE.",
    false,
  );
} catch {
  check("Browser tooling", false, "Run npm ci before browser tests.", false);
}
check(
  "Codex CLI (optional)",
  spawnSync("codex", ["--version"], { cwd: root, stdio: "ignore" }).status ===
    0,
  "The Codex desktop app can open this repository without the CLI.",
  false,
);
console.log(
  "This command does not print environment values, accounts or authentication state.",
);
if (failed) process.exitCode = 1;
