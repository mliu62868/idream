// P0-1 acceptance: the chat_service DB boundary has teeth (design §2, PLAN P0-1).
// Positive: chat Prisma (as chat_service) reads the 4 views + CRUD chat.*.
// Negative: raw writes/reads of public.* and writes to the views are DB-rejected.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "../generated/client/client.js";
import { createChatPrisma, createChatProjectorPrisma } from "../src/db.js";
import {
  projectChatFileMutations,
  recordChatFileMutation,
} from "../src/file-mutations.js";
import type { ChatModel } from "../src/providers.js";
import {
  assertChatSchemaReady,
  RuntimeReadiness,
  warmRuntime,
} from "../src/runtime-readiness.js";

const prisma = createChatPrisma();
const projectorPrisma = createChatProjectorPrisma();
const pool = new Pool({ connectionString: process.env.CHAT_DATABASE_URL });
const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });

afterAll(async () => {
  await prisma.$disconnect();
  await projectorPrisma.$disconnect();
  await pool.end();
  await superPool.end();
});

describe("chat boundary (chat_service role)", () => {
  it("exposes exactly the documented runtime privilege matrix", async () => {
    const tableDrift = await superPool.query<{ drift: string }>(`
      WITH runtime_roles(role_name) AS (
        VALUES ('chat_service'), ('chat_projector')
      ), table_privileges(privilege_name) AS (
        VALUES
          ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
          ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
      ), chat_relations AS (
        SELECT class.oid, class.relname
        FROM pg_class AS class
        JOIN pg_namespace AS namespace
          ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'chat'
          AND class.relkind IN ('r', 'p', 'v', 'm', 'f')
      ), actual AS (
        SELECT
          role_name,
          relname,
          privilege_name,
          has_table_privilege(
            role_name,
            oid,
            privilege_name
          ) AS is_granted
        FROM runtime_roles
        CROSS JOIN chat_relations
        CROSS JOIN table_privileges
      )
      SELECT
        role_name || ':' || relname || ':' || privilege_name AS drift
      FROM actual
      WHERE is_granted IS DISTINCT FROM CASE role_name
        WHEN 'chat_service' THEN CASE
          WHEN relname IN (
            'chat_sessions',
            'chat_send_receipts',
            'chat_session_release_migrations',
            'messages',
            'message_attachments',
            'message_versions',
            'chat_usage',
            'chat_moderation_events',
            'chat_outbox_events',
            'chat_inbox_events'
          ) THEN privilege_name IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
          WHEN relname = 'chat_scene_revisions'
            THEN privilege_name IN ('SELECT', 'INSERT')
          WHEN relname = 'chat_file_mutations'
            THEN privilege_name = 'SELECT'
          ELSE false
        END
        WHEN 'chat_projector' THEN CASE
          WHEN relname IN (
            'chat_sessions',
            'messages',
            'chat_file_mutations',
            'chat_send_receipts',
            'chat_outbox_events'
          ) THEN privilege_name = 'SELECT'
          ELSE false
        END
        ELSE false
      END
      ORDER BY role_name, relname, privilege_name
    `);

    const columnDrift = await superPool.query<{ drift: string }>(`
      WITH runtime_roles(role_name) AS (
        VALUES ('chat_service'), ('chat_projector')
      ), column_privileges(privilege_name) AS (
        VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')
      ), chat_columns AS (
        SELECT class.oid, class.relname, attribute.attname
        FROM pg_class AS class
        JOIN pg_namespace AS namespace
          ON namespace.oid = class.relnamespace
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = class.oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
        WHERE namespace.nspname = 'chat'
          AND class.relkind IN ('r', 'p', 'v', 'm', 'f')
      ), actual AS (
        SELECT
          role_name,
          relname,
          attname,
          privilege_name,
          has_column_privilege(
            role_name,
            oid,
            attname,
            privilege_name
          ) AS is_granted
        FROM runtime_roles
        CROSS JOIN chat_columns
        CROSS JOIN column_privileges
      )
      SELECT
        role_name || ':' || relname || ':' || attname || ':' ||
          privilege_name AS drift
      FROM actual
      WHERE is_granted IS DISTINCT FROM CASE role_name
        WHEN 'chat_service' THEN CASE
          WHEN relname IN (
            'chat_sessions',
            'chat_send_receipts',
            'chat_session_release_migrations',
            'messages',
            'message_attachments',
            'message_versions',
            'chat_usage',
            'chat_moderation_events',
            'chat_outbox_events',
            'chat_inbox_events'
          ) THEN privilege_name IN ('SELECT', 'INSERT', 'UPDATE')
          WHEN relname = 'chat_scene_revisions'
            THEN privilege_name IN ('SELECT', 'INSERT')
          WHEN relname = 'chat_file_mutations'
            THEN privilege_name = 'SELECT'
              OR (
                privilege_name = 'INSERT'
                AND attname IN ('id', 'user_id', 'kind', 'payload')
              )
          ELSE false
        END
        WHEN 'chat_projector' THEN CASE
          WHEN relname IN (
            'chat_sessions',
            'messages',
            'chat_file_mutations',
            'chat_send_receipts',
            'chat_outbox_events'
          ) AND privilege_name = 'SELECT' THEN true
          WHEN relname = 'chat_sessions'
            AND attname IN ('log_extracted_seq', 'updated_at')
            AND privilege_name = 'UPDATE' THEN true
          WHEN relname = 'messages'
            AND attname IN ('memory_extracted_attempt', 'updated_at')
            AND privilege_name = 'UPDATE' THEN true
          WHEN relname = 'chat_file_mutations'
            AND attname IN (
              'status', 'payload', 'attempts', 'last_error', 'applied_at'
            )
            AND privilege_name = 'UPDATE' THEN true
          WHEN relname = 'chat_outbox_events'
            AND attname IN (
              'id', 'event_type', 'aggregate_type', 'aggregate_id',
              'payload', 'schema_version', 'status', 'attempts',
              'next_run_at', 'created_at'
            )
            AND privilege_name = 'INSERT' THEN true
          ELSE false
        END
        ELSE false
      END
      ORDER BY role_name, relname, attname, privilege_name
    `);

    const schemaDrift = await superPool.query<{ drift: string }>(`
      WITH runtime_roles(role_name) AS (
        VALUES ('chat_service'), ('chat_projector')
      ), application_schemas(schema_name) AS (
        VALUES ('chat'), ('core'), ('billing'), ('compliance'), ('public')
      ), schema_privileges(privilege_name) AS (
        VALUES ('USAGE'), ('CREATE')
      ), actual AS (
        SELECT
          role_name,
          schema_name,
          privilege_name,
          has_schema_privilege(
            role_name,
            schema_name,
            privilege_name
          ) AS is_granted
        FROM runtime_roles
        CROSS JOIN application_schemas
        CROSS JOIN schema_privileges
      )
      SELECT
        role_name || ':' || schema_name || ':' || privilege_name AS drift
      FROM actual
      WHERE schema_name <> 'public'
        AND is_granted IS DISTINCT FROM (
          privilege_name = 'USAGE'
          AND (
            (role_name = 'chat_service'
              AND schema_name IN ('chat', 'core', 'billing', 'compliance'))
            OR (role_name = 'chat_projector' AND schema_name = 'chat')
          )
        )
        OR privilege_name = 'CREATE' AND is_granted
      ORDER BY role_name, schema_name, privilege_name
    `);

    const sequenceDrift = await superPool.query<{ drift: string }>(`
      WITH runtime_roles(role_name) AS (
        VALUES ('chat_service'), ('chat_projector')
      ), sequence_privileges(privilege_name) AS (
        VALUES ('USAGE'), ('SELECT'), ('UPDATE')
      ), chat_sequences AS (
        SELECT class.oid, class.relname
        FROM pg_class AS class
        JOIN pg_namespace AS namespace
          ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'chat'
          AND class.relkind = 'S'
      ), actual AS (
        SELECT
          role_name,
          relname,
          privilege_name,
          has_sequence_privilege(
            role_name,
            oid,
            privilege_name
          ) AS is_granted
        FROM runtime_roles
        CROSS JOIN chat_sequences
        CROSS JOIN sequence_privileges
      )
      SELECT
        role_name || ':' || relname || ':' || privilege_name AS drift
      FROM actual
      WHERE is_granted IS DISTINCT FROM (
        role_name = 'chat_service'
        AND relname = 'chat_file_mutations_sequence_seq'
        AND privilege_name = 'USAGE'
      )
      ORDER BY role_name, relname, privilege_name
    `);

    const functionDrift = await superPool.query<{ drift: string }>(`
      WITH runtime_roles(role_name) AS (
        VALUES ('chat_service'), ('chat_projector')
      ), chat_functions AS (
        SELECT procedure.oid, procedure.proname
        FROM pg_proc AS procedure
        JOIN pg_namespace AS namespace
          ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'chat'
      ), actual AS (
        SELECT
          role_name,
          oid,
          oid::regprocedure::text AS procedure_name,
          has_function_privilege(role_name, oid, 'EXECUTE') AS is_granted
        FROM runtime_roles
        CROSS JOIN chat_functions
      )
      SELECT role_name || ':' || procedure_name AS drift
      FROM actual
      WHERE is_granted IS DISTINCT FROM CASE role_name
        WHEN 'chat_service' THEN oid IN (
          to_regprocedure('chat.redact_file_mutation_payload(text,text,jsonb)'),
          to_regprocedure('chat.purge_file_mutations_for_account(text,text)')
        )
        WHEN 'chat_projector' THEN oid IN (
          to_regprocedure('chat.redact_file_mutation_payload(text,text,jsonb)'),
          to_regprocedure('chat.purge_file_mutations_for_account(text,text)'),
          to_regprocedure('chat.purge_applied_relationship_sets(text,text,bigint)')
        )
        ELSE false
      END
      ORDER BY role_name, procedure_name
    `);

    const defaultPrivilegeDrift = await superPool.query<{ drift: string }>(`
      WITH default_grants AS (
        SELECT
          object_type.code::text AS object_type,
          expanded.grantee
        FROM pg_roles AS owner_role
        CROSS JOIN (
          VALUES ('r'::"char"), ('S'::"char"), ('f'::"char")
        ) AS object_type(code)
        CROSS JOIN LATERAL aclexplode(
          COALESCE(
            (
              SELECT defaults.defaclacl
              FROM pg_default_acl AS defaults
              WHERE defaults.defaclrole = owner_role.oid
                AND defaults.defaclnamespace = 0
                AND defaults.defaclobjtype = object_type.code
            ),
            acldefault(object_type.code, owner_role.oid)
          )
        ) AS expanded
        WHERE owner_role.rolname = 'chat_owner'
        UNION ALL
        SELECT
          defaults.defaclobjtype::text AS object_type,
          expanded.grantee
        FROM pg_roles AS owner_role
        JOIN pg_default_acl AS defaults
          ON defaults.defaclrole = owner_role.oid
         AND defaults.defaclnamespace = (
           SELECT oid FROM pg_namespace WHERE nspname = 'chat'
         )
         AND defaults.defaclobjtype IN ('r', 'S', 'f')
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS expanded
        WHERE owner_role.rolname = 'chat_owner'
      )
      SELECT
        object_type || ':' || COALESCE(role.rolname, 'PUBLIC') AS drift
      FROM default_grants
      LEFT JOIN pg_roles AS role ON role.oid = default_grants.grantee
      WHERE default_grants.grantee = 0
         OR role.rolname IN ('chat_service', 'chat_projector')
      ORDER BY object_type, role.rolname
    `);

    expect({
      tables: tableDrift.rows,
      columns: columnDrift.rows,
      schemas: schemaDrift.rows,
      sequences: sequenceDrift.rows,
      functions: functionDrift.rows,
      defaults: defaultPrivilegeDrift.rows,
    }).toEqual({
      tables: [],
      columns: [],
      schemas: [],
      sequences: [],
      functions: [],
      defaults: [],
    });
  });

  it("runs the real memory projector SQL surface with the narrow role", async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const userId = `boundary_projector_user_${suffix}`;
    const characterId = `boundary_projector_character_${suffix}`;
    const sessionId = `boundary_projector_session_${suffix}`;
    const userMessageId = `boundary_projector_user_message_${suffix}`;
    const assistantMessageId = `boundary_projector_assistant_${suffix}`;
    const receiptId = `boundary_projector_receipt_${suffix}`;
    const fsRoot = await mkdtemp(
      path.join(tmpdir(), "idream-chat-projector-boundary-"),
    );
    const previousFsRoot = process.env.CHAT_FS_ROOT;
    process.env.CHAT_FS_ROOT = fsRoot;

    try {
      await prisma.chatSession.create({
        data: { id: sessionId, userId, characterId },
      });
      await prisma.message.createMany({
        data: [
          {
            id: userMessageId,
            sessionId,
            role: "user",
            content: "projector source",
            status: "sent",
            safetyStatus: "passed",
          },
          {
            id: assistantMessageId,
            sessionId,
            role: "assistant",
            content: "projector response",
            status: "sent",
            safetyStatus: "passed",
            attempt: 1,
            replyToMessageId: userMessageId,
            memoryAuthority: "enabled",
          },
        ],
      });
      await prisma.chatSendReceipt.create({
        data: {
          id: receiptId,
          userId,
          sessionId,
          idempotencyKey: `boundary-projector-${suffix}`,
          requestHash: `boundary-projector-hash-${suffix}`,
          userMessageId,
          assistantMessageId,
          responseStatus: "generating",
        },
      });
      await prisma.$transaction((tx) =>
        recordChatFileMutation(tx, userId, {
          kind: "memory_extract",
          sessionId,
          userMessageId,
          characterId,
          turnKey: assistantMessageId,
          attempt: 1,
          summaryDelta: "projector summary",
          candidates: [],
          maxStored: 0,
        }),
      );

      await expect(
        projectChatFileMutations(userId, projectorPrisma),
      ).resolves.toBe(1);
      await expect(prisma.message.findUniqueOrThrow({
        where: { id: assistantMessageId },
        select: { memoryExtractedAttempt: true },
      })).resolves.toEqual({ memoryExtractedAttempt: 1 });
      await expect(prisma.chatSession.findUniqueOrThrow({
        where: { id: sessionId },
        select: { logExtractedSeq: true },
      })).resolves.toEqual({ logExtractedSeq: 1n });
      await expect(prisma.chatOutboxEvent.findFirst({
        where: {
          aggregateId: characterId,
          payload: { path: ["userId"], equals: userId },
        },
      })).resolves.toBeTruthy();
    } finally {
      const cleanup = await superPool.connect();
      try {
        await cleanup.query("BEGIN");
        await cleanup.query(
          `SELECT set_config(
             'idream.account_erasure_file_mutation_user',
             $1,
             true
           )`,
          [userId],
        );
        await cleanup.query(
          "DELETE FROM chat.chat_outbox_events WHERE aggregate_id = $1",
          [characterId],
        );
        await cleanup.query(
          "DELETE FROM chat.chat_send_receipts WHERE id = $1",
          [receiptId],
        );
        await cleanup.query(
          "DELETE FROM chat.messages WHERE session_id = $1",
          [sessionId],
        );
        await cleanup.query(
          "DELETE FROM chat.chat_sessions WHERE id = $1",
          [sessionId],
        );
        await cleanup.query(
          "DELETE FROM chat.chat_file_mutations WHERE user_id = $1",
          [userId],
        );
        await cleanup.query("COMMIT");
      } catch (error) {
        await cleanup.query("ROLLBACK");
        throw error;
      } finally {
        cleanup.release();
      }
      if (previousFsRoot === undefined) delete process.env.CHAT_FS_ROOT;
      else process.env.CHAT_FS_ROOT = previousFsRoot;
      await rm(fsRoot, { recursive: true, force: true });
    }
  });

  it("admits the canonical request/projector role and capability split", async () => {
    const readiness = new RuntimeReadiness();
    const chat: ChatModel = {
      async *stream() {
        yield { delta: "READY", done: true };
      },
      async complete() {
        return { content: "{}" };
      },
    };

    await warmRuntime({
      prisma,
      projectorPrisma,
      chat,
      memoryChat: chat,
      profiles: [{
        adapter: "openai-compatible-v1",
        provider: "openai",
        baseUrl: "http://model/v1",
        model: "boundary-model",
        apiKey: "",
        maxOutputTokens: 100,
        firstTokenTimeoutMs: 100,
        idleTimeoutMs: 100,
        completionTimeoutMs: 100,
        supportsTools: true,
      }],
      pingRedis: async () => {},
      readiness,
    });

    expect(readiness.snapshot()).toMatchObject({ ready: true, lastError: null });
  });

  it("rejects a superuser login that masks itself with SET ROLE", async () => {
    const connectionUrl = new URL(process.env.CHAT_TEST_SUPER_URL!);
    connectionUrl.searchParams.set("options", "-c role=chat_service");
    const maskedPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionUrl.toString() }),
    });
    try {
      await expect(warmRuntime({
        prisma: maskedPrisma,
        projectorPrisma,
        chat: { stream: async function* () {} } as unknown as ChatModel,
        pingRedis: async () => {},
        readiness: new RuntimeReadiness(),
      })).rejects.toThrow("chat request authenticated role is not canonical");
    } finally {
      await maskedPrisma.$disconnect();
    }
  });

  it("rejects a request role that gained forbidden Scene mutation authority", async () => {
    await superPool.query(
      "GRANT UPDATE ON chat.chat_scene_revisions TO chat_service",
    );
    try {
      await expect(warmRuntime({
        prisma,
        projectorPrisma,
        chat: { stream: async function* () {} } as unknown as ChatModel,
        pingRedis: async () => {},
        readiness: new RuntimeReadiness(),
      })).rejects.toThrow("chat request database capability is not canonical");
    } finally {
      await superPool.query(
        "REVOKE UPDATE ON chat.chat_scene_revisions FROM chat_service",
      );
    }
  });

  it.each([
    {
      label: "request schema CREATE",
      grant: "GRANT CREATE ON SCHEMA chat TO chat_service",
      revoke: "REVOKE CREATE ON SCHEMA chat FROM chat_service",
      error: "chat request database capability is not canonical",
    },
    {
      label: "request table TRUNCATE",
      grant: "GRANT TRUNCATE ON chat.chat_usage TO chat_service",
      revoke: "REVOKE TRUNCATE ON chat.chat_usage FROM chat_service",
      error: "chat request database capability is not canonical",
    },
    {
      label: "request table REFERENCES",
      grant: "GRANT REFERENCES ON chat.chat_usage TO chat_service",
      revoke: "REVOKE REFERENCES ON chat.chat_usage FROM chat_service",
      error: "chat request database capability is not canonical",
    },
    {
      label: "request table TRIGGER",
      grant: "GRANT TRIGGER ON chat.chat_usage TO chat_service",
      revoke: "REVOKE TRIGGER ON chat.chat_usage FROM chat_service",
      error: "chat request database capability is not canonical",
    },
    {
      label: "request legacy function EXECUTE",
      grant: `GRANT EXECUTE ON FUNCTION
        chat.redact_file_mutation_payload(text,jsonb) TO chat_service`,
      revoke: `REVOKE EXECUTE ON FUNCTION
        chat.redact_file_mutation_payload(text,jsonb) FROM chat_service`,
      error: "chat request database capability is not canonical",
    },
    {
      label: "projector unrelated table DELETE",
      grant: "GRANT DELETE ON chat.chat_sessions TO chat_projector",
      revoke: "REVOKE DELETE ON chat.chat_sessions FROM chat_projector",
      error: "chat projector database capability is not canonical",
    },
    {
      label: "projector unauthorized session column UPDATE",
      grant: "GRANT UPDATE (title) ON chat.chat_sessions TO chat_projector",
      revoke: "REVOKE UPDATE (title) ON chat.chat_sessions FROM chat_projector",
      error: "chat projector database capability is not canonical",
    },
    {
      label: "projector unauthorized outbox column INSERT",
      grant: "GRANT INSERT (delivered_at) ON chat.chat_outbox_events TO chat_projector",
      revoke: "REVOKE INSERT (delivered_at) ON chat.chat_outbox_events FROM chat_projector",
      error: "chat projector database capability is not canonical",
    },
    {
      label: "projector Scene SELECT",
      grant: "GRANT SELECT ON chat.chat_scene_revisions TO chat_projector",
      revoke: "REVOKE SELECT ON chat.chat_scene_revisions FROM chat_projector",
      error: "chat projector database capability is not canonical",
    },
  ])("rejects $label capability drift", async ({ grant, revoke, error }) => {
    await superPool.query(grant);
    try {
      await expect(warmRuntime({
        prisma,
        projectorPrisma,
        chat: { stream: async function* () {} } as unknown as ChatModel,
        pingRedis: async () => {},
        readiness: new RuntimeReadiness(),
      })).rejects.toThrow(error);
    } finally {
      await superPool.query(revoke);
    }
  });

  it("can read all 4 read-only views", async () => {
    await expect(prisma.chatUserView.findMany({ take: 1 })).resolves.toBeDefined();
    await expect(prisma.chatCharacterView.findMany({ take: 1 })).resolves.toBeDefined();
    await expect(prisma.chatEntitlementView.findMany({ take: 1 })).resolves.toBeDefined();
    await expect(prisma.chatUserEligibilityView.findMany({ take: 1 })).resolves.toBeDefined();
  });

  it("can CRUD chat.* authority tables", async () => {
    const id = "test_sess_boundary";
    await prisma.chatSession.create({
      data: { id, userId: "u_test", characterId: "c_test" },
    });
    const found = await prisma.chatSession.findUnique({ where: { id } });
    expect(found?.userId).toBe("u_test");
    await prisma.chatSession.delete({ where: { id } });
  });

  // Negative tests use raw pg so we bypass Prisma's view/model surface and hit the
  // DB grants directly — exactly what an attacker / a bug would attempt.
  // Rejection can be a grant denial ("permission denied") or, for the views, a
  // structural one ("cannot insert into view" — no auto-update rule). Both prove
  // the write never lands.
  async function mustReject(sql: string) {
    await expect(pool.query(sql)).rejects.toThrow(
      /permission denied|cannot insert into view|cannot update view|cannot.*view/i,
    );
  }

  it("CANNOT write core base tables", async () => {
    await mustReject("INSERT INTO public.users (id, email) VALUES ('x', 'x@x')");
    await mustReject("UPDATE public.users SET status = 'suspended'");
  });

  it("CANNOT read core base tables (only the views)", async () => {
    await mustReject("SELECT * FROM public.users LIMIT 1");
    await mustReject("SELECT * FROM public.entitlements LIMIT 1");
  });

  it("CANNOT write the read-only views", async () => {
    await mustReject("INSERT INTO core.chat_user_view (user_id) VALUES ('x')");
    await mustReject("UPDATE billing.chat_entitlement_view SET model_tier = 'deluxe'");
  });

  it("refuses readiness when the file-mutation trigger only runs for replica sessions", async () => {
    await superPool.query(
      "ALTER TABLE chat.chat_file_mutations ENABLE REPLICA TRIGGER chat_file_mutations_immutable",
    );
    try {
      await expect(assertChatSchemaReady(prisma)).rejects.toThrow(
        "file mutation authority is not canonical",
      );
    } finally {
      await superPool.query(
        "ALTER TABLE chat.chat_file_mutations ENABLE TRIGGER chat_file_mutations_immutable",
      );
    }
  });

  it("refuses readiness when the message memory-authority trigger only runs for replica sessions", async () => {
    await superPool.query(
      "ALTER TABLE chat.messages ENABLE REPLICA TRIGGER message_memory_authority_immutable",
    );
    try {
      await expect(assertChatSchemaReady(prisma)).rejects.toThrow(
        "message memory authority is not canonical",
      );
    } finally {
      await superPool.query(
        "ALTER TABLE chat.messages ENABLE TRIGGER message_memory_authority_immutable",
      );
    }
  });

  it("refuses readiness when the message memory-authority function becomes a no-op", async () => {
    const original = await superPool.query<{ definition: string }>(
      `SELECT pg_get_functiondef(
        'chat.reject_message_memory_authority_mutation()'::regprocedure
      ) AS definition`,
    );
    await superPool.query(`
      CREATE OR REPLACE FUNCTION chat.reject_message_memory_authority_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN NEW;
      END
      $$
    `);
    try {
      await expect(assertChatSchemaReady(prisma)).rejects.toThrow(
        "message memory authority is not canonical",
      );
    } finally {
      await superPool.query(original.rows[0]!.definition);
    }
  });

  it("refuses readiness when the file-mutation trigger function returns before enforcement", async () => {
    const original = await superPool.query<{ definition: string }>(
      `SELECT pg_get_functiondef(
        'chat.assert_file_mutation_update()'::regprocedure
      ) AS definition`,
    );
    await superPool.query(`
      CREATE OR REPLACE FUNCTION chat.assert_file_mutation_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN NEW;
        PERFORM chat.redact_file_mutation_payload(OLD.id, OLD.kind, OLD.payload);
      END
      $$
    `);
    try {
      await expect(assertChatSchemaReady(prisma)).rejects.toThrow(
        "file mutation authority is not canonical",
      );
    } finally {
      await superPool.query(original.rows[0]!.definition);
    }
  });
});
