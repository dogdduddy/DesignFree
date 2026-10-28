import fs from "node:fs/promises";
import crypto from "node:crypto";
const root = new URL("../", import.meta.url);
export async function sourceFingerprint() {
  const hash = crypto.createHash("sha256");
  async function visit(path) {
    for (const e of (
      await fs.readdir(new URL(path, root), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path + e.name;
      if (e.isDirectory()) await visit(name + "/");
      else {
        hash.update(name);
        hash.update(await fs.readFile(new URL(name, root)));
      }
    }
  }
  await visit("src/");
  await visit("tests/");
  hash.update(await fs.readFile(new URL("package-lock.json", root)));
  hash.update(await fs.readFile(new URL("public/fonts/NotoSansKR.ttf", root)));
  return hash.digest("hex");
}
