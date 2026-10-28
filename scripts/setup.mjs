import { randomBytes } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function initializeEnvironment(root) {
  const destination = join(root, ".env");
  try {
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(
        "Existing .env must be a regular file; it was not changed.",
      );
    const text = await readFile(destination, "utf8");
    if (!/^DRAFTROOM_DB_PASSWORD[ \t]*=[ \t]*[^\s\r\n][^\r\n]*$/m.test(text))
      throw new Error(
        "Existing .env has no database password; configure it locally. It was not changed.",
      );
    return { created: false };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const example = await readFile(join(root, ".env.example"), "utf8");
  if (!/^DRAFTROOM_DB_PASSWORD=[ \t]*$/m.test(example))
    throw new Error(
      "The environment template must contain an empty database password.",
    );
  const content = example.replace(
    /^DRAFTROOM_DB_PASSWORD=[ \t]*$/m,
    "DRAFTROOM_DB_PASSWORD=" + randomBytes(32).toString("hex"),
  );
  await writeFile(destination, content, { flag: "wx", mode: 0o600 });
  return { created: true };
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const result = await initializeEnvironment(root);
    console.log(
      result.created
        ? "Created private .env with a new database password; no credential values were printed."
        : "Existing .env preserved.",
    );
    console.log(
      "Next: npm run start:docker. Create a new owner in the browser on first launch.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
