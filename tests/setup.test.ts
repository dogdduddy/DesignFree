import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Node setup module is deliberately usable before dependencies exist.
import { initializeEnvironment } from "../scripts/setup.mjs";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "designfree-setup-"));
  directories.push(dir);
  await writeFile(
    join(dir, ".env.example"),
    "DRAFTROOM_DB_PASSWORD=\nDRAFTROOM_PORT=4173\n",
  );
  return dir;
}
describe("private local environment setup", () => {
  it("generates separate random credentials without changing the public example", async () => {
    const a = await fixture(),
      b = await fixture();
    await initializeEnvironment(a);
    await initializeEnvironment(b);
    const first = await readFile(join(a, ".env"), "utf8"),
      second = await readFile(join(b, ".env"), "utf8");
    expect(first).toMatch(
      /^DRAFTROOM_DB_PASSWORD=[a-f0-9]{64}\nDRAFTROOM_PORT=4173\n$/,
    );
    expect(first).not.toEqual(second);
    expect(await readFile(join(a, ".env.example"), "utf8")).toBe(
      "DRAFTROOM_DB_PASSWORD=\nDRAFTROOM_PORT=4173\n",
    );
    if (process.platform !== "win32")
      expect((await stat(join(a, ".env"))).mode & 0o777).toBe(0o600);
  });
  it("preserves an existing credential file byte-for-byte", async () => {
    const dir = await fixture();
    await initializeEnvironment(dir);
    const before = await readFile(join(dir, ".env"), "utf8");
    expect(await initializeEnvironment(dir)).toEqual({ created: false });
    expect(await readFile(join(dir, ".env"), "utf8")).toBe(before);
  });
  it("does not overwrite incomplete environment files or follow a symlink", async () => {
    const dir = await fixture();
    await writeFile(
      join(dir, ".env"),
      "DRAFTROOM_DB_PASSWORD=\nDRAFTROOM_PORT=4173\n",
    );
    await expect(initializeEnvironment(dir)).rejects.toThrow(
      "no database password",
    );
    expect(await readFile(join(dir, ".env"), "utf8")).toBe(
      "DRAFTROOM_DB_PASSWORD=\nDRAFTROOM_PORT=4173\n",
    );
    if (process.platform !== "win32") {
      await rm(join(dir, ".env"));
      await symlink(join(dir, ".env.example"), join(dir, ".env"));
      await expect(initializeEnvironment(dir)).rejects.toThrow("regular file");
    }
  });
});
