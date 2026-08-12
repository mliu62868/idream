import {
  cpSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { ExpectedMigration, MigrationAuthority } from "./migration-authority";
import {
  executeRecoveryRehearsal,
  orderDatabaseAclEntries,
  type RecoveryCommandRunner,
} from "./recovery-rehearsal-executor";
import { resolveRecoveryRehearsalPlan } from "./recovery-rehearsal-producer";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fakeRunner(counts: Record<string, unknown>, failStage?: string) {
  const archives = new Map<string, string>();
  const calls: string[] = [];
  const schema = [
    "-- PostgreSQL database dump",
    'CREATE TABLE "public"."_prisma_migrations" ("id" text);',
    'CREATE TABLE "chat"."chat_sessions" ("id" text);',
    "",
  ].join("\n");
  const roles = {
    required_roles: ["chat_owner", "chat_projector", "chat_service", "core_owner"],
    roles_without_passwords: [
      { role: "chat_owner" },
      { role: "chat_projector" },
      { role: "chat_service" },
      { role: "core_owner" },
    ],
    memberships: [],
    password_restore_policy: "Credentials are excluded.",
  };
  const databaseAuthority = {
    database: {
      owner: "postgres",
      encoding: "UTF8",
      locale_provider: "libc",
      collate: "C",
      ctype: "C",
      icu_locale: null,
      icu_rules: null,
      tablespace: "pg_default",
      connection_limit: -1,
      comment: null,
      acl_is_null: true,
      acl: [],
    },
    database_role_settings: [],
  };
  const table = JSON.stringify({
    schema: "public",
    table: "_prisma_migrations",
    relkind: "r",
    is_partition: false,
    row_count: 2,
    row_digest_sha256: "a".repeat(64),
  });
  const copyModes = (source: string, target: string) => {
    chmodSync(target, statSync(source).mode & 0o7777);
    if (!statSync(source).isDirectory()) return;
    for (const name of readdirSync(source)) {
      copyModes(path.join(source, name), path.join(target, name));
    }
  };

  const runner: RecoveryCommandRunner = {
    run(input) {
      calls.push(input.stage);
      if (input.stage === failStage) {
        throw new Error(`injected failure at ${input.stage}`);
      }
      const result = (stdout = "", status = 0) => ({
        stdout: Buffer.from(stdout),
        stderr: Buffer.alloc(0),
        status,
      });
      if (input.stage.startsWith("tool_preflight_")) return result("tool 1\n");
      if (input.stage === "runtime_quiescence_pm2") return result("warning\n[]\n");
      if (input.stage.startsWith("runtime_quiescence_port_")) return result("", 1);
      if (input.stage.endsWith("_counts") || input.stage === "post_dump_counts") {
        return result(JSON.stringify(counts));
      }
      if (
        input.stage === "source_active_clients" ||
        input.stage === "final_source_active_clients"
      ) return result("0\n");
      if (input.stage === "source_restore_actor") return result("t\n");
      if (input.stage === "source_postgres_version" || input.stage === "tool_server_version_num") {
        return result("160014\n");
      }
      if (input.stage === "tool_server_version") return result("16.14\n");
      if (input.stage === "source_role_authority") return result(JSON.stringify(roles));
      if (
        input.stage === "source_database_authority" ||
        input.stage === "restore_database_authority_capture"
      ) {
        return result(JSON.stringify(databaseAuthority));
      }
      if (input.stage.endsWith("_tables")) return result(`${table}\n`);
      if (input.stage.endsWith("_sequences")) return result("");
      if (input.stage.endsWith("_schema")) return result(schema);
      if (input.stage === "restore_database_absence") return result("0\n");
      if (input.stage === "postgres_custom_dump") {
        const args = input.args ?? [];
        const file = args[args.indexOf("--file") + 1];
        writeFileSync(file!, Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(32)]));
        return result();
      }
      if (input.stage === "postgres_plain_export") return result(schema);
      if (input.stage.endsWith("_archive")) {
        const args = input.args ?? [];
        const archive = args[args.indexOf("-czf") + 1]!;
        const source = path.join(
          args[args.indexOf("-C") + 1]!,
          args[args.indexOf("-C") + 2]!,
        );
        archives.set(archive, source);
        writeFileSync(archive, gzipSync("archive"));
        return result();
      }
      if (input.stage.endsWith("_restore")) {
        const args = input.args ?? [];
        const archive = args[args.indexOf("-xzf") + 1]!;
        const target = args[args.indexOf("-C") + 1]!;
        const source = archives.get(archive)!;
        const restored = path.join(target, path.basename(source));
        cpSync(source, restored, {
          recursive: true,
          preserveTimestamps: true,
        });
        copyModes(source, restored);
        return result();
      }
      return result("tool 1\n");
    },
  };
  return { calls, runner };
}

describe("recovery rehearsal executor", () => {
  it("orders delegated database grants after their grant-option authority", () => {
    const recipient = {
      grantor: "delegator",
      grantor_is_superuser: false,
      grantee: "recipient",
      privilege: "CONNECT",
      grantable: false,
    } as const;
    const delegator = {
      grantor: "database_owner",
      grantor_is_superuser: false,
      grantee: "delegator",
      privilege: "CONNECT",
      grantable: true,
    } as const;

    expect(orderDatabaseAclEntries("database_owner", [recipient, delegator]))
      .toEqual([delegator, recipient]);
    expect(() => orderDatabaseAclEntries("database_owner", [recipient]))
      .toThrow("database ACL grant chain is not replayable");
  });

  it("publishes only after the isolated DB, Chat FS, and Blob restore all match", async () => {
    const workspaceRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), "idream-recovery-executor-")),
    );
    temporaryDirectories.push(workspaceRoot);
    const chatRoot = path.join(workspaceRoot, "chat");
    const blobRoot = path.join(workspaceRoot, "blob");
    mkdirSync(path.join(chatRoot, "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(blobRoot, "objects"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(chatRoot, "sessions", "one.json"), "chat", { mode: 0o600 });
    writeFileSync(path.join(blobRoot, "objects", "one.bin"), "blob", { mode: 0o600 });

    const expectedMigrations: ExpectedMigration[] = [
      { migrationName: "001_baseline", checksum: "a".repeat(64) },
      { migrationName: "002_terminal", checksum: "b".repeat(64) },
    ];
    const env = {
      NODE_ENV: "production",
      APP_ENV: "production",
      IDREAM_QUIESCED: "1",
      DATABASE_URL: "postgresql://postgres:secret@db.internal:5432/idream",
      CHAT_DATABASE_URL:
        "postgresql://chat_service:secret@db.internal:5432/idream",
      CHAT_PROJECTOR_DATABASE_URL:
        "postgresql://chat_projector:secret@db.internal:5432/idream",
      CHAT_FS_ROOT: chatRoot,
      BLOB_PROVIDER: "mock",
      GEN_BLOB_PROVIDER: "mock",
      BLOB_ROOT: blobRoot,
    };
    const bundleName = "idream-recovery-roundtrip-2";
    const plan = resolveRecoveryRehearsalPlan({
      options: {
        apply: true,
        bundleName,
        bundleParent: path.join(workspaceRoot, "backups"),
        chatEnvFile: null,
        confirmation: `CREATE RECOVERY REHEARSAL ${bundleName}`,
        genEnvFile: null,
        help: false,
        launchEnvFile: null,
      },
      env,
      expectedMigrationCount: expectedMigrations.length,
      latestMigration: expectedMigrations.at(-1)!.migrationName,
      workspaceRoot,
    });
    const counts = {
      migrations: 2,
      latest_migration: "002_terminal",
      main_outbox_pending: 0,
      main_outbox_failed: 0,
      inbound_event_received: 0,
      chat_outbox_pending: 0,
      chat_outbox_failed: 0,
      chat_inbox_pending: 0,
      chat_inbox_failed: 0,
      chat_file_mutations_pending: 0,
    };
    const { calls, runner } = fakeRunner(counts);
    const exactMigrationAuthority: MigrationAuthority = {
      expectedCount: 2,
      appliedCount: 2,
      localOnly: [],
      databaseOnly: [],
      checksumMismatches: [],
      incomplete: [],
      duplicateApplied: [],
      schemaPostconditionsChecked: true,
      schemaPostconditionFailures: [],
      ok: true,
    };

    const result = await executeRecoveryRehearsal({
      plan,
      env: env as NodeJS.ProcessEnv,
      expectedMigrations,
      workspaceRoot,
      runner,
      inspectMigration: async () => exactMigrationAuthority,
    });

    expect(result).toMatchObject({ ok: true, bundleName, migrationCount: 2 });
    expect(calls).toEqual(expect.arrayContaining([
      "runtime_quiescence_pm2",
      "source_counts",
      "postgres_custom_dump",
      "restore_database_apply",
      "restore_counts",
      "restore_database_cleanup",
    ]));
    const entries = await readdir(result.bundlePath);
    expect(entries).toContain(`${bundleName}.dump`);
    expect(entries).toContain(`${bundleName}.chat-fs.tar.gz`);
    expect(entries).toContain(`${bundleName}.blob.tar.gz`);
    expect(entries).toContain(`${bundleName}.sha256`);
    expect(entries.every((entry) => !entry.includes("staging"))).toBe(true);
  });

  it("drops only the fresh restore database and removes staging after failure", async () => {
    const workspaceRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), "idream-recovery-cleanup-")),
    );
    temporaryDirectories.push(workspaceRoot);
    const chatRoot = path.join(workspaceRoot, "chat");
    const blobRoot = path.join(workspaceRoot, "blob");
    mkdirSync(chatRoot, { recursive: true, mode: 0o700 });
    mkdirSync(blobRoot, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(chatRoot, "one.json"), "chat", { mode: 0o600 });
    writeFileSync(path.join(blobRoot, "one.bin"), "blob", { mode: 0o600 });
    const expectedMigrations: ExpectedMigration[] = [
      { migrationName: "001_terminal", checksum: "a".repeat(64) },
    ];
    const env = {
      NODE_ENV: "production",
      APP_ENV: "production",
      IDREAM_QUIESCED: "1",
      DATABASE_URL: "postgresql://postgres:secret@db.internal:5432/idream",
      CHAT_DATABASE_URL:
        "postgresql://chat_service:secret@db.internal:5432/idream",
      CHAT_PROJECTOR_DATABASE_URL:
        "postgresql://chat_projector:secret@db.internal:5432/idream",
      CHAT_FS_ROOT: chatRoot,
      BLOB_PROVIDER: "mock",
      GEN_BLOB_PROVIDER: "mock",
      BLOB_ROOT: blobRoot,
    };
    const bundleParent = path.join(workspaceRoot, "backups");
    const bundleName = "idream-recovery-cleanup-1";
    const plan = resolveRecoveryRehearsalPlan({
      options: {
        apply: true,
        bundleName,
        bundleParent,
        chatEnvFile: null,
        confirmation: `CREATE RECOVERY REHEARSAL ${bundleName}`,
        genEnvFile: null,
        help: false,
        launchEnvFile: null,
      },
      env,
      expectedMigrationCount: 1,
      latestMigration: "001_terminal",
      workspaceRoot,
    });
    const counts = {
      migrations: 1,
      latest_migration: "001_terminal",
      main_outbox_pending: 0,
      main_outbox_failed: 0,
      inbound_event_received: 0,
      chat_outbox_pending: 0,
      chat_outbox_failed: 0,
      chat_inbox_pending: 0,
      chat_inbox_failed: 0,
      chat_file_mutations_pending: 0,
    };
    const { calls, runner } = fakeRunner(counts, "restore_database_apply");
    const exactMigrationAuthority: MigrationAuthority = {
      expectedCount: 1,
      appliedCount: 1,
      localOnly: [],
      databaseOnly: [],
      checksumMismatches: [],
      incomplete: [],
      duplicateApplied: [],
      schemaPostconditionsChecked: true,
      schemaPostconditionFailures: [],
      ok: true,
    };

    await expect(executeRecoveryRehearsal({
      plan,
      env: env as NodeJS.ProcessEnv,
      expectedMigrations,
      workspaceRoot,
      runner,
      inspectMigration: async () => exactMigrationAuthority,
    })).rejects.toThrow("injected failure at restore_database_apply");

    expect(calls).toContain("restore_database_failure_cleanup");
    expect(await readdir(bundleParent)).toEqual([]);
  });
});
