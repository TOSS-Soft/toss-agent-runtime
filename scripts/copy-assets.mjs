import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "contracts", "runtime");
const destination = path.join(root, "dist", "contracts", "runtime");

await mkdir(destination, { recursive: true });
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".schema.json")) {
    await cp(path.join(source, entry.name), path.join(destination, entry.name), {
      dereference: false,
      errorOnExist: false,
      force: true,
    });
  }
}
