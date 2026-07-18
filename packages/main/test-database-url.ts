import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

const BASE_TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:5433/idream_test";

export function testDatabaseUrlForWorkspace(workspaceRoot: string, isLinkedWorktree: boolean) {
  if (!isLinkedWorktree) return BASE_TEST_DATABASE_URL;
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const suffix = basename(resolvedWorkspaceRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(-40);
  const digest = createHash("sha256")
    .update(resolvedWorkspaceRoot)
    .digest("hex")
    .slice(0, 8);
  const parsed = new URL(BASE_TEST_DATABASE_URL);
  parsed.pathname = `/idream_test_${suffix || "worktree"}_${digest}`;
  return parsed.toString();
}

export function defaultTestDatabaseUrl(startDirectory = process.cwd()) {
  const workspaceRoot = resolve(mainPackageRoot(startDirectory), "../..");
  let linkedWorktree = false;
  try {
    linkedWorktree = statSync(resolve(workspaceRoot, ".git")).isFile();
  } catch {
    // Packaged/CI source trees without Git metadata keep the stable CI default.
  }
  return testDatabaseUrlForWorkspace(workspaceRoot, linkedWorktree);
}

function mainPackageRoot(startDirectory: string) {
  let current = resolve(startDirectory);
  while (true) {
    if (
      basename(current) === "main" &&
      existsSync(resolve(current, "test-database-url.ts"))
    ) {
      return current;
    }
    const nestedMain = resolve(current, "packages/main");
    if (existsSync(resolve(nestedMain, "test-database-url.ts"))) {
      return nestedMain;
    }
    const parent = resolve(current, "..");
    if (parent === current) return resolve(startDirectory);
    current = parent;
  }
}
