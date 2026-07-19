// Provision a Postgres test DB for the chat service:
//   1. (re)create the database as superuser
//   2. push main's Prisma schema into public (base tables the views read)
//   3. apply the P0-1 boundary SQL (schemas/roles/views/chat tables/grants)
// Honours env: CHAT_TEST_DB, PG_SUPER. Designed for local dev + CI (a PG with a
// superuser). No-ops gracefully if PG is unreachable (caller decides to skip).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const mainDir = path.join(repoRoot, "packages", "main");

const TEST_DATABASE_TOKEN = /(^|[_-])test([_-]|$)/i;
const PLAYWRIGHT_DATABASE_TOKEN = /(^|[_-])playwright([_-]|$)/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function userInfo(user, password) {
  return `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ""}`;
}

function psqlSuper(target, db, sql) {
  execFileSync("psql", ["-U", target.superUser, "-h", target.host, "-p", target.port, "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], {
    env: { ...process.env, PGPASSWORD: target.superPassword },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function psqlFile(target, db, file, role) {
  execFileSync(
    "psql",
    [
      "-U",
      target.superUser,
      "-h",
      target.host,
      "-p",
      target.port,
      "-d",
      db,
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      ...(role ? ["-c", `SET ROLE ${role};`] : []),
      "-f",
      file,
    ],
    {
      env: { ...process.env, PGPASSWORD: target.superPassword },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
}

function validateTurnMemoryAuthorityUpgrade(target, db) {
  psqlFile(target, db, path.join(repoRoot, "db", "sql", "01_schemas_roles.sql"));
  psqlSuper(
    target,
    db,
    `
      DROP SCHEMA chat CASCADE;
      CREATE SCHEMA chat AUTHORIZATION chat_owner;
      SET ROLE chat_owner;
      CREATE TABLE chat.messages (
        id text PRIMARY KEY,
        role text NOT NULL,
        status text NOT NULL,
        deleted_at timestamp,
        updated_at timestamp NOT NULL DEFAULT timezone('utc', now()),
        memory_extracted_attempt integer NOT NULL DEFAULT 0,
        attempt integer NOT NULL DEFAULT 1,
        reply_to_message_id text
      );
      INSERT INTO chat.messages (id, role, status)
      VALUES ('legacy_before_memory_authority', 'assistant', 'sent');
      RESET ROLE;
    `,
  );
  psqlFile(
    target,
    db,
    path.join(repoRoot, "db", "sql", "2026-07-18-chat-turn-memory-authority.sql"),
    "chat_owner",
  );
  psqlSuper(
    target,
    db,
    `
      DO $upgrade$
      DECLARE
        authority text;
      BEGIN
        SELECT memory_authority
        INTO authority
        FROM chat.messages
        WHERE id = 'legacy_before_memory_authority';
        IF authority IS DISTINCT FROM 'legacy_unknown' THEN
          RAISE EXCEPTION 'legacy row did not fail closed: %', authority;
        END IF;
        BEGIN
          UPDATE chat.messages
          SET memory_authority = 'enabled'
          WHERE id = 'legacy_before_memory_authority';
          RAISE EXCEPTION 'legacy authority mutation was allowed';
        EXCEPTION
          WHEN check_violation THEN
            NULL;
        END;
      END
      $upgrade$;
      DROP SCHEMA chat CASCADE;
    `,
  );
}

function validateFileMutationAuthorityUpgrade(target, db) {
  psqlFile(target, db, path.join(repoRoot, "db", "sql", "01_schemas_roles.sql"));
  psqlSuper(
    target,
    db,
    `
      DROP SCHEMA IF EXISTS chat CASCADE;
      CREATE SCHEMA chat AUTHORIZATION chat_owner;
      SET ROLE chat_owner;
      CREATE TABLE chat.chat_file_mutations (
        id text PRIMARY KEY,
        sequence bigint,
        user_id text NOT NULL,
        kind text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        created_at timestamp NOT NULL DEFAULT timezone('utc', now()),
        applied_at timestamp
      );
      INSERT INTO chat.chat_file_mutations
        (id,sequence,user_id,kind,payload,status)
      VALUES
        (
          'legacy_pending_file_intent',
          7,
          'legacy_file_user',
          'account_delete',
          '{}',
          'pending'
        ),
        (
          'legacy_applied_trace',
          NULL,
          'legacy_file_user',
          'trace_append',
          '{"kind":"trace_append","sessionId":"legacy_session","entry":{"secret":"legacy-secret-must-redact"}}',
          'applied'
        );
      CREATE FUNCTION chat.purge_applied_relationship_sets(
        text,
        text,
        bigint
      )
      RETURNS integer
      LANGUAGE sql
      AS 'SELECT 0';
      GRANT EXECUTE ON FUNCTION
        chat.purge_applied_relationship_sets(text, text, bigint)
        TO chat_service;
      RESET ROLE;
    `,
  );
  psqlFile(
    target,
    db,
    path.join(
      repoRoot,
      "db",
      "sql",
      "2026-07-18-chat-file-mutation-authority.sql",
    ),
    "chat_owner",
  );
  // A real redeploy happens with immutable applied receipts still present.
  // Reapply before validation/drop so trigger replacement and normalization are
  // proven idempotent over retained production-shaped evidence.
  psqlFile(
    target,
    db,
    path.join(
      repoRoot,
      "db",
      "sql",
      "2026-07-18-chat-file-mutation-authority.sql",
    ),
    "chat_owner",
  );
  psqlSuper(
    target,
    db,
    `
      DO $upgrade$
      DECLARE
        pending_sequence bigint;
        applied_sequence bigint;
        pending_kind text;
        applied_payload text;
        sequence_default text;
        runtime_can_purge_relationship boolean;
      BEGIN
        SELECT sequence
        INTO pending_sequence
        FROM chat.chat_file_mutations
        WHERE id = 'legacy_pending_file_intent';
        IF pending_sequence IS NULL THEN
          RAISE EXCEPTION 'partial-table upgrade did not backfill sequence';
        END IF;
        SELECT sequence
        INTO applied_sequence
        FROM chat.chat_file_mutations
        WHERE id = 'legacy_applied_trace';
        IF applied_sequence IS NULL
           OR applied_sequence = pending_sequence THEN
          RAISE EXCEPTION
            'mixed partial sequence backfill was not collision-free';
        END IF;

        SELECT payload ->> 'kind'
        INTO pending_kind
        FROM chat.chat_file_mutations
        WHERE id = 'legacy_pending_file_intent';
        IF pending_kind IS DISTINCT FROM 'account_delete' THEN
          RAISE EXCEPTION
            'partial pending payload kind was not canonicalized: %',
            pending_kind;
        END IF;

        SELECT payload::text
        INTO applied_payload
        FROM chat.chat_file_mutations
        WHERE id = 'legacy_applied_trace';
        IF applied_payload LIKE '%legacy-secret-must-redact%' THEN
          RAISE EXCEPTION 'applied payload was not redacted';
        END IF;

        SELECT column_default
        INTO sequence_default
        FROM information_schema.columns
        WHERE table_schema = 'chat'
          AND table_name = 'chat_file_mutations'
          AND column_name = 'sequence';
        IF sequence_default IS NULL
           OR sequence_default NOT LIKE 'nextval(%' THEN
          RAISE EXCEPTION 'sequence default missing after upgrade: %',
            sequence_default;
        END IF;

        SELECT has_function_privilege(
          'chat_service',
          'chat.purge_applied_relationship_sets(text,text,bigint)',
          'EXECUTE'
        )
        INTO runtime_can_purge_relationship;
        IF runtime_can_purge_relationship THEN
          RAISE EXCEPTION
            'upgrade retained request-role relationship purge capability';
        END IF;

        BEGIN
          UPDATE chat.chat_file_mutations
          SET status = 'applied'
          WHERE id = 'legacy_pending_file_intent';
          RAISE EXCEPTION 'forged completion was allowed';
        EXCEPTION
          WHEN OTHERS THEN
            IF SQLERRM = 'forged completion was allowed' THEN
              RAISE;
            END IF;
        END;

        BEGIN
          SET LOCAL ROLE chat_service;
          DELETE FROM chat.chat_file_mutations
          WHERE id = 'legacy_pending_file_intent';
          RESET ROLE;
          RAISE EXCEPTION 'runtime pending delete was allowed';
        EXCEPTION
          WHEN insufficient_privilege THEN
            RESET ROLE;
        END;
      END
      $upgrade$;
      DROP SCHEMA chat CASCADE;
    `,
  );
}

export function provisionChatTestDb() {
  const target = chatTestDatabaseTarget();
  const db = assertSafeChatTestDatabaseName(target.database, {
    requirePlaywright: process.env.CHAT_TEST_REQUIRE_PLAYWRIGHT === "1",
  });
  assertSafeChatTestDatabaseTarget(target, {
    allowRemoteReset:
      process.env.CHAT_TEST_ALLOW_REMOTE_RESET === "1",
    ci: process.env.CI === "true",
    confirmedDatabaseName:
      process.env.CHAT_TEST_RESET_CONFIRM,
  });

  // 1. fresh database
  psqlSuper(target, "postgres", `DROP DATABASE IF EXISTS ${db} WITH (FORCE);`);
  psqlSuper(target, "postgres", `CREATE DATABASE ${db};`);

  // 2. main schema → public, via main's own Postgres db-push.
  const url = `postgresql://${userInfo(target.superUser, target.superPassword)}@${target.host}:${target.port}/${db}`;
  execFileSync("node", ["scripts/db-push.mjs"], {
    cwd: mainDir,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, DATABASE_URL: url },
  });

  // 3. Rehearse the forward DDL over a real pre-column row. Historical turns
  // must become legacy_unknown and the new authority must be immutable.
  validateTurnMemoryAuthorityUpgrade(target, db);
  validateFileMutationAuthorityUpgrade(target, db);

  // 4. boundary SQL + assertions. Apply twice so the suite proves the SQL is
  // genuinely idempotent against its own latest view/table shape, not merely
  // installable on a fresh database.
  for (let pass = 0; pass < 2; pass += 1) {
    execFileSync("bash", [path.join(repoRoot, "db", "sql", "apply-validate.sh")], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        DB: db,
        SUPER: target.superUser,
        SUPER_PASSWORD: target.superPassword,
        CHAT_SERVICE_PASSWORD: target.chatServicePassword,
        CHAT_PROJECTOR_PASSWORD: target.chatProjectorPassword,
        PGHOST: target.host,
        PGPORT: target.port,
      },
    });
  }

  return {
    db,
    superUrl: url,
    chatServiceUrl: `postgresql://${userInfo("chat_service", target.chatServicePassword)}@${target.host}:${target.port}/${db}`,
    chatProjectorUrl: `postgresql://${userInfo("chat_projector", target.chatProjectorPassword)}@${target.host}:${target.port}/${db}`,
  };
}

export function chatTestDatabaseNameForWorkspace(
  workspaceRoot,
  isLinkedWorktree,
) {
  if (!isLinkedWorktree) return "idream_chat_test";
  const resolvedRoot = path.resolve(workspaceRoot);
  const suffix = path.basename(resolvedRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(-32);
  const digest = createHash("sha256")
    .update(resolvedRoot)
    .digest("hex")
    .slice(0, 8);
  return `idream_chat_test_${suffix || "worktree"}_${digest}`;
}

export function defaultChatTestDatabaseName() {
  let linkedWorktree = false;
  try {
    linkedWorktree = statSync(path.join(repoRoot, ".git")).isFile();
  } catch {
    // CI source archives without Git metadata use the stable isolated default.
  }
  return chatTestDatabaseNameForWorkspace(repoRoot, linkedWorktree);
}

export function chatTestDatabaseTarget() {
  return {
    database:
      process.env.CHAT_TEST_DB ??
      defaultChatTestDatabaseName(),
    host: process.env.PGHOST ?? "localhost",
    port: process.env.PGPORT ?? "5433",
    superUser: process.env.PG_SUPER ?? "postgres",
    superPassword:
      process.env.PGPASSWORD ??
      process.env.POSTGRES_PASSWORD ??
      "postgres",
    chatServicePassword:
      process.env.CHAT_SERVICE_PASSWORD ??
      "chat_service_change_me",
    chatProjectorPassword:
      process.env.CHAT_PROJECTOR_PASSWORD ??
      "chat_projector_change_me",
  };
}

export function assertSafeChatTestDatabaseTarget(
  target,
  authority = {},
) {
  assertSafeChatTestDatabaseName(target.database);
  const hostname = String(target.host ?? "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    if (!authority.allowRemoteReset) {
      throw new Error(
        `Refusing remote chat test database reset on host "${target.host || "(missing)"}"`,
      );
    }
    if (!authority.ci) {
      throw new Error(
        "Refusing remote chat test database reset unless CI=true",
      );
    }
    if (authority.confirmedDatabaseName !== target.database) {
      throw new Error(
        `Remote chat test database reset confirmation does not match "${target.database}"`,
      );
    }
  }
  return target;
}

export function chatTestBullMqPrefix(target) {
  const identity = JSON.stringify({
    database: target.database,
    host: String(target.host).replace(/^\[|\]$/g, "").toLowerCase(),
    port: target.port || "5432",
  });
  const digest = createHash("sha256").update(identity).digest("hex");
  return `idream:chat:test:${digest}`;
}

export function assertSafeChatTestDatabaseName(
  value,
  { requirePlaywright = false } = {},
) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_]+$/.test(value) ||
    Buffer.byteLength(value, "utf8") > 63 ||
    !TEST_DATABASE_TOKEN.test(value)
  ) {
    throw new Error(
      `Refusing to recreate non-test chat database "${String(value || "(missing)")}"`,
    );
  }
  if (requirePlaywright && !PLAYWRIGHT_DATABASE_TOKEN.test(value)) {
    throw new Error(
      `Refusing Playwright chat database "${value}"; the database name must contain both test and playwright`,
    );
  }
  return value;
}
