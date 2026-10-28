import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error operational CLI is plain Node ESM
import { checksum, verifySnapshot } from "../scripts/backup.mjs";

describe("snapshot integrity", () => {
  it("accepts a complete pair and rejects corruption, missing files and unsupported format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "draftroom-backup-"));
    try {
      await writeFile(join(dir, "database.sql"), "SQL snapshot");
      await writeFile(join(dir, "assets.ndjson"), "assets");
      const manifest = {
        format: 1,
        postgresMajor: 17,
        files: {
          "database.sql": await checksum(join(dir, "database.sql")),
          "assets.ndjson": await checksum(join(dir, "assets.ndjson")),
        },
      };
      const save = () =>
        writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
      await save();
      expect((await verifySnapshot(dir)).format).toBe(1);
      await writeFile(join(dir, "assets.ndjson"), "corrupted");
      await expect(verifySnapshot(dir)).rejects.toThrow("integrity");
      await rm(join(dir, "assets.ndjson"));
      await expect(verifySnapshot(dir)).rejects.toThrow();
      manifest.format = 99;
      await save();
      await expect(verifySnapshot(dir)).rejects.toThrow("Unsupported");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
