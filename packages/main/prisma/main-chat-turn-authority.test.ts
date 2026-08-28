import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = new URL(
  "./migrations/20260827120000_main_chat_turn_authority/migration.sql",
  import.meta.url,
);

describe("Main Chat Turn authority migration", () => {
  it("archives older duplicate active sessions before adding the unique active identity", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const rankDuplicates = sql.indexOf("WITH ranked_active_sessions AS");
    const archiveDuplicates = sql.indexOf("ranked.recency_rank = 1");
    const createUniqueIndex = sql.indexOf(
      'CREATE UNIQUE INDEX IF NOT EXISTS "recent_chats_activeKey_key"',
    );

    expect(rankDuplicates).toBeGreaterThan(-1);
    expect(archiveDuplicates).toBeGreaterThan(rankDuplicates);
    expect(createUniqueIndex).toBeGreaterThan(archiveDuplicates);
    expect(sql).toContain('PARTITION BY "userId", "characterId"');
    expect(sql).toContain('"lastMessageAt" DESC NULLS LAST');
    expect(sql).toContain("ELSE 'archived'");
    expect(sql).toContain('"activeKey" = NULL');
  });

  it("is atomic and can resume after the failed partial deployment", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain("BEGIN;");
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(11);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "chat_turns"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "chat_turn_attachments"');
  });
});
