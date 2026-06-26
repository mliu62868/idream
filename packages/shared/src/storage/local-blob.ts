import { existsSync } from "node:fs";
import path from "node:path";

export function resolveLocalBlobRoot(explicitRoot = process.env.BLOB_ROOT) {
  if (explicitRoot?.trim()) return path.resolve(explicitRoot);
  return path.join(findWorkspaceRoot(process.cwd()), "packages", "main", "data", "main-blob");
}

export function resolveLocalBlobPath(key: string, explicitRoot = process.env.BLOB_ROOT) {
  return path.resolve(resolveLocalBlobRoot(explicitRoot), key);
}

function findWorkspaceRoot(start: string) {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, "turbo.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}
