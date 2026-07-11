import { statSync } from "node:fs";
import { basename, resolve } from "node:path";

const BASE_TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:5433/idream_test";

export function testDatabaseUrlForWorkspace(workspaceRoot: string, isLinkedWorktree: boolean) {
  if (!isLinkedWorktree) return BASE_TEST_DATABASE_URL;
  const suffix = basename(workspaceRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(-40);
  const parsed = new URL(BASE_TEST_DATABASE_URL);
  parsed.pathname = `/idream_test_${suffix || "worktree"}`;
  return parsed.toString();
}

export function defaultTestDatabaseUrl() {
  const workspaceRoot = resolve(import.meta.dirname, "../..");
  let linkedWorktree = false;
  try {
    linkedWorktree = statSync(resolve(workspaceRoot, ".git")).isFile();
  } catch {
    // Packaged/CI source trees without Git metadata keep the stable CI default.
  }
  return testDatabaseUrlForWorkspace(workspaceRoot, linkedWorktree);
}
