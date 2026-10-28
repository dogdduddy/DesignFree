// Internal offline volume codec. NDJSON keeps memory bounded to one PNG.
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  readdir,
  readFile,
  mkdir,
  writeFile,
  rm,
  rename,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
const root = process.env.ASSET_ROOT || "/app/asset-data";
const mode = process.argv[2];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const directoryPattern = /^[a-f0-9]{64}$/;
const pathPattern = /^[a-f0-9]{64}\/[a-f0-9]{64}\.png$/;
const MAX_PNG = 32 * 1024 * 1024;
async function directories() {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (/^\.restore-[a-f0-9-]{36}$/.test(entry.name) && entry.isDirectory())
      continue;
    if (!directoryPattern.test(entry.name) || !entry.isDirectory())
      throw new Error("Unexpected asset volume entry: " + entry.name);
  }
  return entries.filter((entry) => directoryPattern.test(entry.name));
}
if (mode === "export") {
  for (const dir of await directories()) {
    for (const file of await readdir(join(root, dir.name), {
      withFileTypes: true,
    })) {
      if (!file.isFile())
        throw new Error("Asset links and nested directories are unsupported");
      // Temporary writes are unreferenced; omission resets GC grace conservatively.
      if (
        /^(?:[a-f0-9-]{36}\.tmp(?:\.orphan)?|[a-f0-9]{64}\.png\.orphan)$/.test(
          file.name,
        )
      )
        continue;
      const path = `${dir.name}/${file.name}`;
      if (!pathPattern.test(path)) throw new Error("Unexpected asset filename");
      const location = join(root, path);
      if ((await lstat(location)).size > MAX_PNG)
        throw new Error("PNG exceeds snapshot limit");
      const bytes = await readFile(location);
      if (hash(bytes) !== file.name.slice(0, 64))
        throw new Error("Asset digest mismatch: " + path);
      if (
        !process.stdout.write(
          JSON.stringify({ path, data: bytes.toString("base64") }) + "\n",
        )
      )
        await once(process.stdout, "drain");
    }
  }
} else if (mode === "import") {
  // Stage inside the volume, then replace while API/editor remain stopped.
  // A prior interrupted import is offline and recoverable from the pre-restore snapshot.
  for (const entry of await readdir(root))
    if (/^\.restore-[a-f0-9-]{36}$/.test(entry))
      await rm(join(root, entry), { recursive: true, force: true });
  await directories();
  const stage = join(root, ".restore-" + randomUUID());
  await mkdir(stage);
  try {
    const seen = new Set();
    for await (const line of createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    })) {
      if (line.length > MAX_PNG * 1.4)
        throw new Error("Asset record exceeds limit");
      const { path, data } = JSON.parse(line);
      if (
        typeof path !== "string" ||
        !pathPattern.test(path) ||
        typeof data !== "string" ||
        seen.has(path)
      )
        throw new Error("Invalid or duplicate asset path");
      const bytes = Buffer.from(data, "base64");
      if (
        bytes.length > MAX_PNG ||
        hash(bytes) !== path.split("/")[1].slice(0, 64)
      )
        throw new Error("Invalid asset digest");
      seen.add(path);
      await mkdir(join(stage, path.split("/")[0]), { recursive: true });
      await writeFile(join(stage, path), bytes, { flag: "wx", mode: 0o600 });
    }
    for (const dir of await readdir(root, { withFileTypes: true }))
      if (directoryPattern.test(dir.name))
        await rm(join(root, dir.name), { recursive: true });
    for (const dir of await readdir(stage))
      await rename(join(stage, dir), join(root, dir));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
} else throw new Error("Expected export or import");
