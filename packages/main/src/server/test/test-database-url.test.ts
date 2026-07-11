import { describe, expect, it } from "vitest";
import { testDatabaseUrlForWorkspace } from "../../../test-database-url";

describe("worktree test database isolation", () => {
  it("keeps the stable primary-worktree database", () => {
    expect(testDatabaseUrlForWorkspace("/repo/idream", false)).toBe(
      "postgresql://postgres:postgres@localhost:5433/idream_test",
    );
  });

  it("derives a PostgreSQL-safe database per linked worktree", () => {
    expect(testDatabaseUrlForWorkspace("/repo/iDream Creative Loop", true)).toBe(
      "postgresql://postgres:postgres@localhost:5433/idream_test_idream_creative_loop",
    );
  });
});
