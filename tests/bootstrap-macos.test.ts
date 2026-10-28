import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const script = resolve("scripts/bootstrap-macos.sh");
function bash(code: string, ...args: string[]) {
  return spawnSync(
    "/bin/bash",
    ["-c", 'source "$1"; ' + code, "--", script, ...args],
    { encoding: "utf8" },
  );
}
function fixture(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "designfree-bootstrap-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function repo(
  dir: string,
  origin = "https://github.com/dogdduddy/DesignFree.git",
) {
  expect(spawnSync("git", ["init", dir], { stdio: "ignore" }).status).toBe(0);
  expect(
    spawnSync("git", ["-C", dir, "remote", "add", "origin", origin], {
      stdio: "ignore",
    }).status,
  ).toBe(0);
}
describe.skipIf(process.platform === "win32")(
  "macOS bootstrap safety without installing anything",
  () => {
    it("parses with the system Bash and --help has no installation effects", () => {
      expect(spawnSync("/bin/bash", ["-n", script]).status).toBe(0);
      const result = spawnSync("/bin/bash", [script, "--help"], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Homebrew/Git/nvm");
    });
    it("adds quoted Homebrew setup once without replacing existing profile content", () =>
      fixture((dir) => {
        const profile = join(dir, "profile with spaces");
        writeFileSync(profile, "# keep existing settings\n");
        const result = bash(
          'append_brew_profile "$2" "$3"; append_brew_profile "$2" "$3"',
          profile,
          "/opt/brew path/bin/brew",
        );
        expect(result.status).toBe(0);
        const text = readFileSync(profile, "utf8");
        expect(text.startsWith("# keep existing settings\n")).toBe(true);
        expect(text.match(/DesignFree: Homebrew PATH/g)?.length).toBe(1);
        expect(spawnSync("/bin/bash", ["-n", profile]).status).toBe(0);
        expect(text).toContain("brew\\ path");
      }));
    it("does not edit a symlinked profile", () =>
      fixture((dir) => {
        const target = join(dir, "real");
        const link = join(dir, "link");
        writeFileSync(target, "keep\n");
        symlinkSync(target, link);
        expect(
          bash('append_brew_profile "$2" /opt/homebrew/bin/brew', link).status,
        ).not.toBe(0);
        expect(readFileSync(target, "utf8")).toBe("keep\n");
      }));
    it("rejects unrelated folders and nested repo paths without deleting files", () =>
      fixture((dir) => {
        writeFileSync(join(dir, "keep.txt"), "keep");
        expect(bash('prepare_checkout "$2"', dir).status).not.toBe(0);
        repo(dir);
        const nested = join(dir, "nested");
        spawnSync("mkdir", ["-p", nested]);
        expect(bash('prepare_checkout "$2"', nested).status).not.toBe(0);
        expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("keep");
      }));
    it("rejects a wrong origin and reuses an existing correct checkout without reset/pull", () =>
      fixture((dir) => {
        repo(dir, "https://github.com/example/unrelated.git");
        writeFileSync(join(dir, "keep.txt"), "keep");
        expect(bash('prepare_checkout "$2"', dir).status).not.toBe(0);
        spawnSync("git", [
          "-C",
          dir,
          "remote",
          "set-url",
          "origin",
          "https://github.com/dogdduddy/DesignFree.git",
        ]);
        expect(bash('prepare_checkout "$2"', dir).status).toBe(0);
        expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("keep");
      }));
    it("rejects a remote desktop endpoint before any engine API call", () =>
      fixture((dir) => {
        const marker = join(dir, "unexpected-engine-call");
        const result = bash(
          'marker="$2"; docker(){ if [ "$1" = context ]; then printf "tcp://remote.invalid:2375\\n"; else touch "$marker"; fi; }; desktop_ready',
          marker,
        );
        expect(result.status).toBe(2);
        expect(existsSync(marker)).toBe(false);
        expect(result.stderr).toContain("로컬 Docker 소켓이 아니므로");
      }));
    it("refuses other compose working directories without container mutations", () => {
      const result = bash(
        'docker(){ if [ "$1" = ps ]; then printf "fixture-id\\n"; else printf "/different/checkout\\n"; fi; }; check_compose_ownership /expected/checkout',
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("기존 설치를 변경하지 않습니다");
    });
    it("preserves orphan data volumes when a new checkout has no private environment", () =>
      fixture((dir) => {
        const code =
          'docker(){ if [ "$1" = volume ]; then printf "designfree_document-data\\n"; fi; }; check_compose_ownership "$2"';
        const rejected = bash(code, dir);
        expect(rejected.status).not.toBe(0);
        expect(rejected.stderr).toContain("기존 designfree 데이터 볼륨");
        writeFileSync(
          join(dir, ".env"),
          "DRAFTROOM_DB_PASSWORD=preserved-test-value\n",
        );
        expect(bash(code, dir).status).toBe(0);
      }));
    it("the registered EXIT cleanup survives main returning and removes only its scratch directory", () =>
      fixture((dir) => {
        const scratch = join(dir, "scratch with spaces");
        spawnSync("mkdir", ["-p", scratch]);
        writeFileSync(join(dir, "keep.txt"), "keep");
        const result = bash(
          'register(){ local scratch="$2"; trap "$(printf \'rm -rf -- %q\' "$scratch")" EXIT; }; register unused "$2"',
          scratch,
        );
        expect(result.status).toBe(0);
        expect(existsSync(scratch)).toBe(false);
        expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("keep");
      }));
  },
);
