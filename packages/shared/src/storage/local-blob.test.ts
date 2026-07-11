import path from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveLocalBlobPath, resolveLocalBlobRoot } from "./local-blob";

describe("local blob paths", () => {
  it("defaults to the workspace-local blob root", () => {
    const workspaceRoot = findWorkspaceRoot(process.cwd());

    expect(resolveLocalBlobRoot(undefined)).toBe(
      path.join(workspaceRoot, "data", "blob"),
    );
  });

  it("resolves relative explicit roots from the workspace root", () => {
    const workspaceRoot = findWorkspaceRoot(process.cwd());

    expect(resolveLocalBlobRoot("data/blob")).toBe(
      path.join(workspaceRoot, "data", "blob"),
    );
    expect(resolveLocalBlobPath("pipeline/asset-1", "data/blob")).toBe(
      path.join(workspaceRoot, "data", "blob", "pipeline", "asset-1"),
    );
  });
});

function findWorkspaceRoot(start: string) {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, "turbo.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}
