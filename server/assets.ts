import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  readdir,
  stat,
  utimes,
  open,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Library } from "../src/server-storage";
import type { ImageAsset } from "../src/core";
import { ASSET_DIGEST, MISSING_PNG } from "../src/assets";

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
type DiskAsset = Omit<ImageAsset, "dataUrl" | "missing"> & { blobKey: string };
/** JSONB stores document-scoped immutable digests; paths never contain user IDs. */
export class AssetVolume {
  constructor(readonly root: string) {}
  path(documentId: string, key: string) {
    if (!ASSET_DIGEST.test(key)) throw new Error("Invalid asset digest");
    return join(this.root, digest(documentId), key + ".png");
  }
  async read(documentId: string, key: string) {
    const bytes = await readFile(this.path(documentId, key));
    if (digest(bytes) !== key) throw new Error("Asset integrity mismatch");
    return bytes;
  }
  async pack(library: Library): Promise<Library> {
    const stored = structuredClone(library);
    for (const doc of [stored.document, ...stored.documents]) {
      const directory = join(this.root, digest(doc.id));
      await mkdir(directory, { recursive: true });
      const rootHandle = await open(this.root, "r");
      try {
        await rootHandle.sync();
      } finally {
        await rootHandle.close();
      }
      for (const [id, asset] of Object.entries(doc.assets)) {
        let key = asset.missing;
        if (!key) {
          const bytes = Buffer.from(asset.dataUrl.split(",")[1], "base64");
          key = digest(bytes);
          const target = this.path(doc.id, key);
          // Flush before publishing the reference. Temp files are also GC candidates.
          const temp = join(directory, randomUUID() + ".tmp");
          const handle = await open(temp, "wx");
          try {
            await handle.writeFile(bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temp, target);
          const dir = await open(directory, "r");
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        }
        // A new committed reference begins a new live episode. Clearing before
        // COMMIT can only extend retention if the DB transaction later fails.
        await rm(this.path(doc.id, key) + ".orphan", { force: true });
        const referencedDirectory = await open(directory, "r");
        try {
          await referencedDirectory.sync();
        } finally {
          await referencedDirectory.close();
        }
        const { dataUrl: _data, missing: _missing, ...metadata } = asset;
        doc.assets[id] = { ...metadata, blobKey: key } as unknown as ImageAsset;
      }
    }
    return stored;
  }
  async unpack(library: Library): Promise<Library> {
    const hydrated = structuredClone(library);
    for (const doc of [hydrated.document, ...hydrated.documents]) {
      for (const [id, value] of Object.entries(doc.assets)) {
        const disk = value as unknown as DiskAsset;
        if (!disk.blobKey) continue; // H01 embedded data migrates on the next save.
        const { blobKey, ...metadata } = disk;
        try {
          const bytes = await this.read(doc.id, blobKey);
          doc.assets[id] = {
            ...metadata,
            dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
          };
        } catch (error) {
          if (!ASSET_DIGEST.test(blobKey)) throw error;
          doc.assets[id] = {
            ...metadata,
            dataUrl: MISSING_PNG,
            missing: blobKey,
          };
        }
      }
    }
    return hydrated;
  }
  /** Caller holds the library transaction lock, also used by save. Never removes live references. */
  async cleanup(library: Library | null, now = Date.now()) {
    const live = new Set<string>();
    if (library)
      for (const doc of [library.document, ...library.documents])
        for (const asset of Object.values(doc.assets)) {
          const key = (asset as unknown as DiskAsset).blobKey;
          if (key) live.add(this.path(doc.id, key));
        }
    await mkdir(this.root, { recursive: true });
    let removed = 0;
    for (const dir of await readdir(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !ASSET_DIGEST.test(dir.name)) continue;
      for (const file of await readdir(join(this.root, dir.name))) {
        if (!/^(?:[a-f0-9]{64}\.png|[a-f0-9-]{36}\.tmp)$/.test(file)) continue;
        const path = join(this.root, dir.name, file);
        const marker = path + ".orphan";
        if (live.has(path)) {
          await rm(marker, { force: true });
        } else {
          // First observation starts the grace period, independent of blob age.
          try {
            await stat(marker);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            await writeFile(marker, "orphan");
            await utimes(marker, new Date(now), new Date(now));
          }
          if ((await stat(marker)).mtimeMs <= now - ORPHAN_GRACE_MS) {
            await rm(path);
            await rm(marker, { force: true });
            removed++;
          }
        }
      }
    }
    return { removed, graceDays: 7 };
  }
}
