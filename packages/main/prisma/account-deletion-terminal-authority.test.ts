import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = new URL(
  "./migrations/20260811190000_account_deletion_terminal_authority/migration.sql",
  import.meta.url,
);

describe("account deletion terminal authority migration", () => {
  it("makes the grace period and three-authority terminal receipt database invariants", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql.startsWith("-- Account deletion")).toBe(true);
    expect(sql).toContain("BEGIN;");
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(sql).toContain('CHECK ("graceEndsAt" > "requestedAt")');
    expect(sql).toContain('"status" <> \'awaiting_chat\'');
    expect(sql).toContain('"chatCompletionEventId" IS NOT NULL');
    expect(sql).toContain('"chatFileMutationId" IS NOT NULL');
    expect(sql).toContain('"chatRequestEventId" IS NOT NULL');
    expect(sql).toContain('"blobDeletedCount" = "blobExpectedCount"');
    expect(sql).toContain('"userId" IS NULL');
    expect(sql).toContain('"mainPurgedAt" IS NOT NULL');
    expect(sql).toContain('"completedAt" IS NOT NULL');
  });

  it("persists retryable Blob work and anonymous ledger evidence without a User FK", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain('CREATE TABLE "account_deletion_blob_receipts"');
    expect(sql).toContain('"storageKeyHash" TEXT NOT NULL');
    expect(sql).toContain('"nextAttemptAt" TIMESTAMP(3) NOT NULL');
    expect(sql).toContain('"leaseExpiresAt" TIMESTAMP(3)');
    expect(sql).toContain('CREATE TABLE "erased_dreamcoin_ledger_entries"');
    expect(sql).toContain('"sourceEntryHash" TEXT NOT NULL');
    expect(sql).not.toContain(
      'FOREIGN KEY ("userId") REFERENCES "users"',
    );
  });

  it("re-enters legacy soft-deleted customers through a new post-grace Chat request", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain('INSERT INTO "account_deletions"');
    expect(sql).toContain("INTERVAL '30 days'");
    expect(sql).toContain("encode(sha256(convert_to(u.id, 'UTF8')), 'hex')");
    expect(sql).toContain("user_deleted_account_deletion_");
    expect(sql).toContain('INSERT INTO "main_outbox_events"');
    expect(sql).toContain('ad."chatRequestEventId"');
    expect(sql).toContain("'user.account_deletion.requested.v2'");
    expect(sql).toContain("'schemaVersion', 2");
    expect(sql).not.toContain("'eventType', 'user.deleted'");
    expect(sql).toContain("to_char(ad.\"requestedAt\",");
    expect(sql).not.toContain('ad."requestedAt" AT TIME ZONE');
  });

  it("fails closed when a rollback binary soft-deletes a customer without workflow authority", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain('CREATE FUNCTION "enforce_customer_account_deletion_authority"()');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER "customer_account_deletion_authority_required"');
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(sql).toContain("deleted customer requires AccountDeletion authority");
    expect(sql.indexOf('INSERT INTO "account_deletions"')).toBeLessThan(
      sql.indexOf('CREATE CONSTRAINT TRIGGER "customer_account_deletion_authority_required"'),
    );
  });
});
