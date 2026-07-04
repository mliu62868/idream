import { existsSync } from "node:fs";
import path from "node:path";

export function resolveLocalBlobRoot(explicitRoot = process.env.BLOB_ROOT) {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  if (explicitRoot?.trim()) {
    return path.isAbsolute(explicitRoot)
      ? path.resolve(explicitRoot)
      : path.resolve(workspaceRoot, explicitRoot);
  }
  return path.join(workspaceRoot, "data", "blob");
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
