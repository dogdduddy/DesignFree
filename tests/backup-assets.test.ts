import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const directory = "a".repeat(64);
const bytes = Buffer.from("immutable-asset-fixture");
const key = createHash("sha256").update(bytes).digest("hex");
const path = `${directory}/${key}.png`;
const record = JSON.stringify({ path, data: bytes.toString("base64") }) + "\n";
const codec = (root: string, mode: string, input = "") =>
  spawnSync(process.execPath, ["server/backup-assets.mjs", mode], {
    env: { ...process.env, ASSET_ROOT: root },
    input,
    encoding: "utf8",
  });
describe("offline asset snapshot codec", () => {
  it("omits stale temp/orphan markers and interrupted stages, restores PNGs with API-readable ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "draftroom-codec-"));
    try {
      await mkdir(join(root, directory));
      await writeFile(join(root, path), bytes);
      const temporary = randomUUID() + ".tmp";
      await writeFile(join(root, directory, temporary), "incomplete");
      await writeFile(join(root, directory, temporary + ".orphan"), "orphan");
      await writeFile(join(root, path + ".orphan"), "orphan");
      await mkdir(join(root, ".restore-" + randomUUID()));
      const exported = codec(root, "export");
      expect(exported.status).toBe(0);
      expect(exported.stdout).toBe(record);
      const imported = codec(root, "import", record);
      expect(imported.status).toBe(0);
      expect(await readFile(join(root, path))).toEqual(bytes);
      expect(codec(root, "export").stdout).toBe(record);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects traversal, corruption and duplicates before replacing the current assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "draftroom-codec-"));
    try {
      await mkdir(join(root, directory));
      await writeFile(join(root, path), bytes);
      for (const invalid of [
        record + record,
        record.replace(directory, ".."),
        JSON.stringify({ path, data: "YmFk" }),
      ]) {
        expect(codec(root, "import", invalid).status).not.toBe(0);
        expect(await readFile(join(root, path))).toEqual(bytes);
      }
      await symlink(join(root, path), join(root, directory, "link.png"));
      expect(codec(root, "export").status).not.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
