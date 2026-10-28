import { spawnSync } from "node:child_process";
import { readFile, readdir, lstat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
);
const omitted = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
  "work",
  "artifacts",
  "asset-data",
  "backups",
  ".maintenance",
]);
async function walk(directory, prefix = "") {
  const list = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (omitted.has(entry.name)) continue;
    const name = prefix + entry.name;
    if (entry.isDirectory())
      list.push(...(await walk(resolve(directory, entry.name), name + "/")));
    else if (
      (name !== ".env" && !name.startsWith(".env.")) ||
      name === ".env.example"
    )
      list.push(name);
  }
  return list;
}
const files = [
  ...new Set(
    git.status === 0
      ? git.stdout.split("\0").filter(Boolean)
      : await walk(root),
  ),
];
const findings = [];
const forbidden =
  /(^|\/)(?:\.env(?:\..+)?|auth\.json|hosts\.yml|credentials\.json|service-account[^/]*\.json|[^/]*\.(?:pem|key|p12|pfx|sql|dump|db|sqlite\w*))$/i;
const privateRoots = new RegExp(
  ["/" + "Users/", "/" + "home/", "[A-Za-z]:\\\\Users\\\\"].join("|"),
);
const patterns = [
  ["private user path", privateRoots],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    "GitHub token",
    /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  ],
  ["OpenAI secret key", /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{30,}/],
  ["AWS access identifier", /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ["Slack token", /xox[baprs]-[A-Za-z0-9-]{20,}/],
];
for (const file of files) {
  if (
    (forbidden.test(file) && file !== ".env.example") ||
    (file.startsWith(".codex/") && file !== ".codex/config.toml") ||
    file.split("/").some((p) => omitted.has(p))
  )
    findings.push({ file, category: "forbidden runtime/credential file" });
  const path = resolve(root, file);
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      findings.push({ file, category: "unreviewed symlink" });
      continue;
    }
    const bytes = await readFile(path);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    for (const [category, pattern] of patterns)
      if (pattern.test(text)) findings.push({ file, category });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const history = spawnSync("git", ["log", "--format=%ae%n%ce"], {
  cwd: root,
  encoding: "utf8",
});
if (history.status === 0) {
  const emails = history.stdout.split("\n").filter(Boolean);
  if (
    emails.some(
      (email) =>
        !/@(?:users\.)?noreply\.github\.com$/.test(email) &&
        !/@[^@]*\.invalid$/.test(email),
    )
  )
    findings.push({
      file: ".git history",
      category: "author/committer email requires privacy review",
    });
}
if (findings.length) {
  console.error(
    JSON.stringify({ status: "review required", findings }, null, 2),
  );
  process.exitCode = 1;
} else
  console.log(
    JSON.stringify({
      status: "passed",
      checkedFiles: files.length,
      secretValuesPrinted: false,
    }),
  );
