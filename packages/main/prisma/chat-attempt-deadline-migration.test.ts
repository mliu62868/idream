import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";

it("upgrades existing usage evidence without charging failed or never-admitted attempts", async () => {
  const url = process.env.DATABASE_URL!;
  expect(new URL(url).pathname).toMatch(/[_-]test(?:[_-]|$)/u);
  const client = new pg.Client({ connectionString: url });
  const schema = `chat_recheck_${randomUUID().replaceAll("-", "")}`;
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query("SELECT set_config('search_path', $1, true)", [schema]);
    await client.query(`
      CREATE TABLE "chat_turns" (id text PRIMARY KEY, "assistantStatus" text,
        "statsCountedAt" timestamp(3), "admittedAt" timestamp(3), "terminalAt" timestamp(3));
      CREATE TABLE "chat_turn_usage_facts" ("turnId" text PRIMARY KEY,
        "createdAt" timestamp(3) NOT NULL, "voidedAt" timestamp(3));
      INSERT INTO "chat_turns" VALUES
        ('sent', 'sent', NULL, '2026-09-29 12:00:00', '2026-09-29 12:01:00'),
        ('stopped_stream', 'cancelled', NULL, '2026-09-29 12:00:00', '2026-09-29 12:01:00'),
        ('stopped_pending', 'cancelled', NULL, NULL, '2026-09-29 12:01:00'),
        ('failed', 'failed', NULL, '2026-09-29 12:00:00', '2026-09-29 12:01:00'),
        ('sent_then_failed', 'failed', '2026-09-29 11:00:00', NULL, '2026-09-29 12:01:00');
      INSERT INTO "chat_turn_usage_facts"
        SELECT id, '2026-09-29 10:00:00', '2026-09-29 12:02:00' FROM "chat_turns";
    `);
    const migration = await readFile(new URL("./migrations/20260930020000_chat_attempt_deadline_and_consumed_usage/migration.sql", import.meta.url), "utf8");
    await client.query(migration);
    const result = await client.query<{ turnId: string; consumedAt: Date | null; voidedAt: Date | null }>(
      'SELECT "turnId", "consumedAt", "voidedAt" FROM "chat_turn_usage_facts" ORDER BY "turnId"',
    );
    expect(result.rows).toEqual([
      { turnId: "failed", consumedAt: null, voidedAt: expect.any(Date) },
      { turnId: "sent", consumedAt: expect.any(Date), voidedAt: null },
      { turnId: "sent_then_failed", consumedAt: expect.any(Date), voidedAt: null },
      { turnId: "stopped_pending", consumedAt: null, voidedAt: expect.any(Date) },
      { turnId: "stopped_stream", consumedAt: expect.any(Date), voidedAt: null },
    ]);
    expect((await client.query('SELECT "executionDeadlineAt" FROM "chat_turns"')).rows)
      .toEqual(Array.from({ length: 5 }, () => ({ executionDeadlineAt: null })));
    expect((await client.query(`SELECT "consumedAt" = TIMESTAMP '2026-09-29 11:00:00' AS "keptOriginalConsumption"
      FROM "chat_turn_usage_facts" WHERE "turnId" = 'sent_then_failed'`)).rows)
      .toEqual([{ keptOriginalConsumption: true }]);
    expect((await client.query("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = $2", [
      schema, "chat_turns_assistantStatus_executionDeadlineAt_idx",
    ])).rowCount).toBe(1);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
