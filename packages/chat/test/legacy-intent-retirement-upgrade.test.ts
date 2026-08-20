import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";

type Retirement = (input: {
  apply: boolean;
  connectionString: string;
  sidecarUrl: string;
  token: string;
  fetchImpl: typeof fetch;
}) => Promise<{
  ok: boolean;
  retired: number;
  purgedWorkspaces: number;
}>;

it("retires legacy item intents against the pre-Phase6 trigger and schema", async () => {
  const superUrl = new URL(process.env.CHAT_TEST_SUPER_URL!);
  const database = `idream_chat_legacy_retire_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const adminUrl = new URL(superUrl);
  adminUrl.pathname = "/postgres";
  const legacyUrl = new URL(superUrl);
  legacyUrl.pathname = `/${database}`;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  let legacy: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    legacy = new Pool({ connectionString: legacyUrl.toString() });
    await legacy.query(`
      CREATE SCHEMA chat;
      CREATE TABLE chat.chat_file_mutations (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        kind text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        applied_at timestamp without time zone
      );
      CREATE FUNCTION chat.redact_file_mutation_payload(
        mutation_id text,
        mutation_kind text,
        mutation_payload jsonb
      ) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
        SELECT jsonb_build_object(
          'kind', mutation_kind,
          'memoryId', mutation_payload -> 'memoryId'
        )
      $$;
      CREATE FUNCTION chat.assert_legacy_completion() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status = 'pending' AND NEW.status = 'applied' THEN
          IF NEW.payload IS DISTINCT FROM
            chat.redact_file_mutation_payload(OLD.id, OLD.kind, OLD.payload)
            OR NEW.attempts <> OLD.attempts + 1
            OR NEW.applied_at IS NULL THEN
            RAISE EXCEPTION 'chat file mutation completion evidence is invalid';
          END IF;
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'chat file mutation is immutable';
      END
      $$;
      CREATE TRIGGER chat_file_mutations_immutable
      BEFORE UPDATE ON chat.chat_file_mutations
      FOR EACH ROW EXECUTE FUNCTION chat.assert_legacy_completion();
      INSERT INTO chat.chat_file_mutations (id,user_id,kind,payload)
      VALUES
        ('legacy-update','legacy-user','memory_update',
          '{"kind":"memory_update","memoryId":"memory-1","content":"PRIVATE_UPDATE"}'),
        ('legacy-delete','legacy-user','memory_delete',
          '{"kind":"memory_delete","memoryId":"memory-2","content":"PRIVATE_DELETE"}');
    `);

    const moduleUrl = new URL(
      "../../../scripts/retire-legacy-chat-item-memory-intents.mjs",
      import.meta.url,
    ).href;
    const { retireLegacyItemMemoryIntents } = await import(moduleUrl) as {
      retireLegacyItemMemoryIntents: Retirement;
    };
    const report = await retireLegacyItemMemoryIntents({
      apply: true,
      connectionString: legacyUrl.toString(),
      sidecarUrl: "http://127.0.0.1:3101",
      token: "upgrade-test-token",
      fetchImpl: async () => Response.json({ ok: true, purged: 1 }),
    });
    expect(report).toMatchObject({ ok: true, retired: 2, purgedWorkspaces: 1 });

    const receipts = await legacy.query<{
      kind: string;
      payload: Record<string, unknown>;
      status: string;
    }>(`
      SELECT kind, payload, status
      FROM chat.chat_file_mutations
      ORDER BY id
    `);
    expect(receipts.rows).toEqual([
      { kind: "memory_delete", payload: { kind: "memory_delete", memoryId: "memory-2" }, status: "applied" },
      { kind: "memory_update", payload: { kind: "memory_update", memoryId: "memory-1" }, status: "applied" },
    ]);
    expect(JSON.stringify(receipts.rows)).not.toMatch(/PRIVATE_(?:UPDATE|DELETE)/u);
    const blocker = await legacy.query<{ clear: boolean }>(`
      SELECT NOT EXISTS (
        SELECT 1 FROM chat.chat_file_mutations
        WHERE kind IN ('memory_update','memory_delete') AND status='pending'
      ) AS clear
    `);
    expect(blocker.rows[0]?.clear).toBe(true);
  } finally {
    await legacy?.end();
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
      [database],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await admin.end();
  }
}, 30_000);
