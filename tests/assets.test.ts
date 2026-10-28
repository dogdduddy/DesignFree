import { describe, it, expect } from "vitest";
import CanvasKitInit from "canvaskit-wasm";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetVolume, ORPHAN_GRACE_MS } from "../server/assets";
import { saveLibrary } from "../server/store";
import type { Pool } from "pg";
import {
  createDemoDocument,
  parseDocument,
  serializeDocument,
} from "../src/core";
import { MISSING_PNG } from "../src/assets";
import type { Library } from "../src/server-storage";

async function fixture(run: (v: AssetVolume, l: Library) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "draftroom-assets-"));
  try {
    await run(new AssetVolume(root), {
      document: createDemoDocument(),
      documents: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const keyOf = (l: Library) =>
  (Object.values(l.document.assets)[0] as unknown as { blobKey: string })
    .blobKey;
describe("document-scoped asset volume", () => {
  it("rolls back and never acknowledges a failed asset write", async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return {
          rows: sql.includes("clock_timestamp") ? [{ now: new Date() }] : [],
        };
      },
      release: () => {},
    };
    const volume = {
      pack: async () => {
        throw new Error("disk unavailable");
      },
    } as unknown as AssetVolume;
    await expect(
      saveLibrary(
        { connect: async () => client } as unknown as Pool,
        {
          document: createDemoDocument(),
          documents: [],
          operationId: "asset-fail",
          expectedVersion: 0,
        },
        volume,
      ),
    ).rejects.toThrow("disk unavailable");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(queries.some((q) => q.includes("INSERT INTO"))).toBe(false);
  });
  it("resets orphan grace when a normal save resurrects a reference", () =>
    fixture(async (v, l) => {
      const now = Date.now();
      await v.pack(l);
      expect((await v.cleanup(null, now)).removed).toBe(0);
      const disk = await v.pack(l); // no cleanup(live) between saves
      expect((await v.cleanup(null, now + ORPHAN_GRACE_MS)).removed).toBe(0);
      expect((await v.cleanup(disk, now + ORPHAN_GRACE_MS * 2)).removed).toBe(
        0,
      );
      expect(await v.unpack(disk)).toEqual(l);
    }));
  it("decodes the missing placeholder in the real CanvasKit PNG decoder", async () => {
    const ck = await CanvasKitInit({
      locateFile: (name) =>
        decodeURIComponent(
          new URL(`../node_modules/canvaskit-wasm/bin/${name}`, import.meta.url)
            .pathname,
        ),
    });
    const image = ck.MakeImageFromEncoded(
      Buffer.from(MISSING_PNG.split(",")[1], "base64"),
    );
    expect(image).not.toBeNull();
    expect(image?.width()).toBe(16);
    image?.delete();
  });
  it("starts grace on first orphan observation even for an old blob", () =>
    fixture(async (v, l) => {
      const disk = await v.pack(l),
        path = v.path(l.document.id, keyOf(disk));
      await utimes(path, new Date(0), new Date(0));
      const now = Date.now();
      expect((await v.cleanup(null, now)).removed).toBe(0);
      expect((await v.cleanup(null, now + ORPHAN_GRACE_MS)).removed).toBe(1);
    }));
  it("externalizes PNG bytes and losslessly hydrates portable documents", () =>
    fixture(async (v, l) => {
      const disk = await v.pack(l);
      expect(JSON.stringify(disk)).not.toContain("data:image/png");
      expect(await v.unpack(disk)).toEqual(l);
      expect(await v.unpack(l)).toEqual(l); // H01 migration is read-only.
      expect(await v.pack(l)).toEqual(disk); // deterministic lost-ACK retry
    }));
  it("isolates identical asset IDs and bytes by document identity", () =>
    fixture(async (v, l) => {
      const disk = await v.pack(l),
        key = keyOf(disk);
      await expect(v.read("other-document", key)).rejects.toThrow();
      await expect(v.read(l.document.id, "../" + key)).rejects.toThrow();
      expect(v.path(l.document.id, key)).not.toContain(l.document.id);
      l.documents = [{ ...structuredClone(l.document), id: "other-document" }];
      const both = await v.pack(l);
      expect(await v.unpack(both)).toEqual(l);
      await rm(v.path(l.document.id, key));
      const hydrated = await v.unpack(both);
      expect(Object.values(hydrated.document.assets)[0].missing).toBe(key);
      expect(
        Object.values(hydrated.documents[0].assets)[0].missing,
      ).toBeUndefined();
    }));
  it("preserves missing references across save and recovers restored bytes", () =>
    fixture(async (v, l) => {
      const disk = await v.pack(l),
        key = keyOf(disk),
        path = v.path(l.document.id, key);
      const bytes = await v.read(l.document.id, key);
      await rm(path);
      const missing = await v.unpack(disk);
      expect(Object.values(missing.document.assets)[0].dataUrl).toBe(
        MISSING_PNG,
      );
      expect(parseDocument(serializeDocument(missing.document))).toEqual(
        missing.document,
      );
      expect(await v.pack(missing)).toEqual(disk);
      await expect(v.read(l.document.id, key)).rejects.toThrow();
      await writeFile(path, bytes);
      expect(await v.unpack(disk)).toEqual(l);
    }));
  it("detects corrupted bytes without losing the reference", () =>
    fixture(async (v, l) => {
      const disk = await v.pack(l),
        key = keyOf(disk);
      await writeFile(v.path(l.document.id, key), "corrupt");
      await expect(v.read(l.document.id, key)).rejects.toThrow("integrity");
      expect(
        Object.values((await v.unpack(disk)).document.assets)[0].missing,
      ).toBe(key);
      await v.pack(l); // portable original heals it
      expect(await v.unpack(disk)).toEqual(l);
    }));
  it("protects live and missing references, then collects only observed orphans after seven days", () =>
    fixture(async (v, l) => {
      const disk = await v.pack(l),
        key = keyOf(disk),
        path = v.path(l.document.id, key);
      const now = Date.now();
      await utimes(path, new Date(0), new Date(0));
      expect((await v.cleanup(disk, now)).removed).toBe(0);
      expect((await v.cleanup(null, now)).removed).toBe(0);
      expect((await v.cleanup(null, now + ORPHAN_GRACE_MS - 1)).removed).toBe(
        0,
      );
      expect((await v.cleanup(disk, now + ORPHAN_GRACE_MS)).removed).toBe(0);
      expect((await v.cleanup(null, now + ORPHAN_GRACE_MS)).removed).toBe(0);
      expect((await v.cleanup(null, now + ORPHAN_GRACE_MS * 2)).removed).toBe(
        1,
      );
      await expect(v.read(l.document.id, key)).rejects.toThrow();
    }));
});
