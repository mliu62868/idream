import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = new URL(
  "./migrations/20260828210000_chat_runtime_hardening/migration.sql",
  import.meta.url,
);

describe("Companion Chat runtime hardening migration", () => {
  it("persists frozen execution, fair admission and durable outbox leases", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain('"executionSnapshot" JSONB');
    expect(sql).toContain('"admissionNextRunAt"');
    expect(sql).toContain('"admissionLeaseToken"');
    expect(sql).toContain('"leaseToken" TEXT');
    expect(sql).toContain('"leaseExpiresAt" TIMESTAMP(3)');
  });

  it("backfills non-deletable usage and seeds monotonic memory authority", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "chat_turn_usage_facts"');
    expect(sql).toContain('INSERT INTO "chat_turn_usage_facts"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "companion_memory_authorities"');
    expect(sql).toContain("MAX((payload -> 'payload' ->> 'authorityVersion')::bigint)");
    expect(sql).toContain('GREATEST(\n  "companion_memory_authorities"."version"');
  });

  it("backfills Release visual pins and avoids coupling usage to deletable Turns", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain('session."characterReleaseId" = release."id"');
    // PostgreSQL forbids qualifying the target column on the left side of SET.
    expect(sql).toContain('"characterVisualProfileId" = session."characterVisualProfileId"');
    expect(sql).toContain('"recent_chats_characterVisualProfile_pin_check"');
    expect(sql).toContain('"chat_turns_characterVisualProfile_pin_check"');
    expect(sql).not.toContain(
      'FOREIGN KEY ("turnId") REFERENCES "chat_turns"',
    );
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });
});
