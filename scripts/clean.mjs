import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(root, "dist");

if (path.dirname(target) !== root || path.basename(target) !== "dist") {
  throw new Error("Refusing to clean a path outside the repository dist directory");
}

await rm(target, { force: true, recursive: true });
