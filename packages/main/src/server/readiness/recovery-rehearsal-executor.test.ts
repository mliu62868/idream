import {
  cpSync,
  chmodSync,
  existsSync,
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
  buildRemoteBlobRestorePutArgs,
  captureRuntimeQuiescence,
  executeRecoveryRehearsal,
  listSourceBlobVersions,
  orderDatabaseAclEntries,
  RECOVERY_COUNT_SQL,
  remoteBlobSourceAuthorityMatches,
  resolveRecoveryObjectRetention,
  type RecoveryCommandRunner,
} from "./recovery-rehearsal-executor";
import {
  MAIN_OUTBOX_TRANSPORT_EVENT_TYPES,
  MAIN_OUTBOX_TRANSPORT_TERMINAL_STATUSES,
} from "@/server/events/main-outbox-transport";
import { resolveRecoveryRehearsalPlan } from "./recovery-rehearsal-producer";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fakeRunner(
  counts: Record<string, unknown>,
  failStage?: string,
  chatAuthority?: {
    request?: Record<string, unknown>;
    projector?: Record<string, unknown>;
  },
  pm2Processes: readonly Record<string, unknown>[] = [],
) {
  const archives = new Map<string, string>();
  const calls: string[] = [];
  const chatDatabaseConnections: Array<Record<string, string | undefined>> = [];
  const databaseChildTargetOverrides: Array<{
    stage: string;
    hostaddr: string | undefined;
    service: string | undefined;
  }> = [];
  const quiescenceEnvironments: NodeJS.ProcessEnv[] = [];
  const databaseExecutionUsers: Array<{
    stage: string;
    user: string | undefined;
  }> = [];
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
  const archiveListing = (source: string) => {
    const root = path.basename(source);
    const rows = [`${root}/`];
    const visit = (directory: string, relative: string) => {
      for (const name of readdirSync(directory).sort()) {
        const target = path.join(directory, name);
        const entry = path.posix.join(root, relative, name);
        if (statSync(target).isDirectory()) {
          rows.push(`${entry}/`);
          visit(target, path.posix.join(relative, name));
        } else {
          rows.push(entry);
        }
      }
    };
    visit(source, "");
    return `${rows.join("\n")}\n`;
  };

  const runner: RecoveryCommandRunner = {
    run(input) {
      calls.push(input.stage);
      if (
        input.stage === "generation_pause_and_drain" ||
        input.stage === "generation_cutover_authority" ||
        input.stage === "generation_worker_ownership"
      ) {
        quiescenceEnvironments.push(input.env ?? { NODE_ENV: "test" });
      }
      if (
        input.stage === "postgres_custom_dump" ||
        input.stage === "restore_database_create" ||
        input.stage === "restore_database_apply"
      ) {
        databaseExecutionUsers.push({
          stage: input.stage,
          user: input.env?.PGUSER,
        });
      }
      if (input.stage === failStage) {
        throw new Error(`injected failure at ${input.stage}`);
      }
      const result = (stdout = "", status = 0) => ({
        stdout: Buffer.from(stdout),
        stderr: Buffer.alloc(0),
        status,
      });
      if (input.stage.startsWith("tool_preflight_")) return result("tool 1\n");
      if (input.stage === "runtime_quiescence_pm2") {
        return result(`warning\n${JSON.stringify(pm2Processes)}\n`);
      }
      if (input.stage === "generation_pause_and_drain") {
        return result(JSON.stringify({
          ok: true,
          queues: [
            { queue: "ai.image.generate", paused: true },
            { queue: "ai.video.generate", paused: true },
            { queue: "app.generation.terminal.ingest", paused: true },
            { queue: "app.ai.finalize", paused: true },
          ],
          activeBullRows: [],
          pendingTerminalOutboxes: 0,
        }));
      }
      if (input.stage === "generation_cutover_authority") {
        return result(JSON.stringify({
          ok: true,
          activeRequests: 0,
          inFlightBullRows: 0,
          pendingTerminalOutboxes: 0,
          issues: [],
        }));
      }
      if (input.stage === "generation_worker_ownership") {
        return result(JSON.stringify({
          mode: "quiescent",
          ok: true,
          expected: { image: 0, video: 0 },
          issues: [],
        }));
      }
      if (input.stage === "recovery_bundle_pg_restore_list") {
        return result([
          "; Archive created at 2026-08-12 00:00:00 UTC",
          ";     TOC Entries: 2",
          "; Selected TOC Entries:",
          "1; 0 0 TABLE public fixture postgres",
          "",
        ].join("\n"));
      }
      if (input.stage.endsWith("_list") && input.command === "tar") {
        const archive = input.args?.at(-1);
        const manifest = archive ? archives.get(archive) : undefined;
        if (!manifest) throw new Error("test archive fixture is missing");
        return result(archiveListing(manifest));
      }
      if (input.stage.startsWith("runtime_quiescence_port_")) return result("", 1);
      if (input.stage === "chat_request_database_authority") {
        databaseChildTargetOverrides.push({
          stage: input.stage,
          hostaddr: input.env?.PGHOSTADDR,
          service: input.env?.PGSERVICE,
        });
        chatDatabaseConnections.push({
          stage: input.stage,
          host: input.env?.PGHOST,
          port: input.env?.PGPORT,
          database: input.env?.PGDATABASE,
          user: input.env?.PGUSER,
          password: input.env?.PGPASSWORD,
        });
        return result(JSON.stringify(chatAuthority?.request ?? {
          session_user: "chat_service",
          current_user: "chat_service",
          database: "idream",
        }));
      }
      if (input.stage === "chat_projector_database_authority") {
        databaseChildTargetOverrides.push({
          stage: input.stage,
          hostaddr: input.env?.PGHOSTADDR,
          service: input.env?.PGSERVICE,
        });
        chatDatabaseConnections.push({
          stage: input.stage,
          host: input.env?.PGHOST,
          port: input.env?.PGPORT,
          database: input.env?.PGDATABASE,
          user: input.env?.PGUSER,
          password: input.env?.PGPASSWORD,
        });
        return result(JSON.stringify(chatAuthority?.projector ?? {
          session_user: "chat_projector",
          current_user: "chat_projector",
          database: "idream",
        }));
      }
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
      if (input.stage.endsWith("_restore") || input.stage.endsWith("_extract")) {
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
  return {
    calls,
    chatDatabaseConnections,
    databaseChildTargetOverrides,
    quiescenceEnvironments,
    databaseExecutionUsers,
    runner,
  };
}

describe("recovery rehearsal executor", () => {
  it("preserves remote Blob metadata, checksum, version-retention, and legal hold on the independent restore", () => {
    expect(buildRemoteBlobRestorePutArgs({
      bucket: "idream-recovery-eu",
      key: "probe/asset.bin",
      body: "/tmp/source.bin",
      checksumSha256: "base64-checksum",
      source: {
        ContentType: "image/png",
        CacheControl: "private, max-age=31536000, immutable",
        Metadata: { character: "mara", authority: "release-7" },
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: "2027-08-12T00:00:00Z",
        ObjectLockLegalHoldStatus: "ON",
      },
    })).toEqual([
      "put-object",
      "--bucket", "idream-recovery-eu",
      "--key", "probe/asset.bin",
      "--body", "/tmp/source.bin",
      "--checksum-algorithm", "SHA256",
      "--checksum-sha256", "base64-checksum",
      "--content-type", "image/png",
      "--cache-control", "private, max-age=31536000, immutable",
      "--metadata", '{"authority":"release-7","character":"mara"}',
      "--object-lock-mode", "COMPLIANCE",
      "--object-lock-retain-until-date", "2027-08-12T00:00:00Z",
      "--object-lock-legal-hold-status", "ON",
      "--output", "json",
    ]);
  });

  it("adds policy retention when the live source has no Object Lock", () => {
    const retention = resolveRecoveryObjectRetention(
      {},
      new Date("2026-08-12T00:00:00.000Z"),
      30,
    );
    expect(retention).toEqual({
      mode: "COMPLIANCE",
      retainUntil: "2026-09-11T00:00:00.000Z",
    });
    expect(buildRemoteBlobRestorePutArgs({
      bucket: "idream-recovery",
      key: "probe/asset.bin",
      body: "/tmp/source.bin",
      checksumSha256: "base64-checksum",
      source: {},
      retention,
    })).toEqual(expect.arrayContaining([
      "--object-lock-mode",
      "COMPLIANCE",
      "--object-lock-retain-until-date",
      "2026-09-11T00:00:00.000Z",
    ]));
  });

  it("rejects checksum or legal-hold drift on the same source version", () => {
    const metadata = {
      contentType: "image/png",
      cacheControl: null,
      metadata: { authority: "release-7" },
      objectLockMode: "COMPLIANCE",
      objectLockRetainUntilDate: "2027-08-12T00:00:00Z",
      objectLockLegalHoldStatus: "ON",
    } as const;
    const captured = [{
      key: "asset.bin",
      versionId: "source-version-1",
      etag: '"etag"',
      size: 7,
      sha256: "e".repeat(64),
      metadata,
    }];
    const current = [{
      key: "asset.bin",
      versionId: "source-version-1",
      etag: '"etag"',
      size: 7,
      checksumSha256: Buffer.from("e".repeat(64), "hex").toString("base64"),
      metadata,
    }];

    expect(remoteBlobSourceAuthorityMatches(current, captured)).toBe(true);
    expect(remoteBlobSourceAuthorityMatches([{ ...current[0]!,
      checksumSha256: Buffer.from("f".repeat(64), "hex").toString("base64"),
    }], captured)).toBe(false);
    expect(remoteBlobSourceAuthorityMatches([{ ...current[0]!, metadata: {
      ...metadata,
      objectLockLegalHoldStatus: "OFF",
    } }], captured)).toBe(false);
  });

  it("rechecks live object versions only against the source endpoint, bucket, and credentials", () => {
    const calls: Array<{
      args?: readonly string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    const runner: RecoveryCommandRunner = {
      run(input) {
        calls.push({ args: input.args, env: input.env });
        return {
          stdout: Buffer.from(JSON.stringify({
            Versions: [{
              Key: "asset.bin",
              VersionId: "source-version-1",
              IsLatest: true,
              ETag: '"etag"',
              Size: 7,
            }],
          })),
          stderr: Buffer.alloc(0),
          status: 0,
        };
      },
    };
    const plan = {
      blob: {
        endpoint: "https://live.example.internal/",
        bucket: "live-bucket",
        recovery: {
          endpoint: "https://recovery.example.internal/",
          bucket: "recovery-bucket",
          region: "eu-west-1",
        },
      },
    } as unknown as Parameters<typeof listSourceBlobVersions>[2];

    expect(listSourceBlobVersions(runner, {
      NODE_ENV: "test",
      BLOB_ACCESS_KEY_ID: "live-access",
      BLOB_SECRET_ACCESS_KEY: "live-secret",
      RECOVERY_BLOB_ACCESS_KEY_ID: "recovery-access",
      RECOVERY_BLOB_SECRET_ACCESS_KEY: "recovery-secret",
    }, plan, "source_version_recheck")).toEqual([{
      key: "asset.bin",
      versionId: "source-version-1",
      etag: '"etag"',
      size: 7,
    }]);
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "--endpoint-url",
      "https://live.example.internal/",
      "--bucket",
      "live-bucket",
    ]));
    expect(calls[0]?.args).not.toContain("recovery-bucket");
    expect(calls[0]?.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "live-access",
      AWS_SECRET_ACCESS_KEY: "live-secret",
    });
  });

  it("rejects an owned PM2 process unless it has an explicit terminal status", () => {
    const { runner } = fakeRunner({}, undefined, undefined, [
      { name: "main-web", pm_id: 1, pm2_env: {} },
    ]);

    expect(() => captureRuntimeQuiescence(runner, { NODE_ENV: "test" })).toThrow(
      "runtime is not quiescent: main-web is unknown",
    );
  });

  it("derives Main transport checkpoint states from the canonical carrier authority", () => {
    for (const eventType of MAIN_OUTBOX_TRANSPORT_EVENT_TYPES) {
      expect(RECOVERY_COUNT_SQL).toContain(`'${eventType}'`);
    }
    expect(RECOVERY_COUNT_SQL).toContain("'main_outbox_dispatched'");
    expect(RECOVERY_COUNT_SQL).toContain("'main_outbox_transport_unknown'");
    expect(RECOVERY_COUNT_SQL).toContain("'inbound_event_processing'");
    expect(RECOVERY_COUNT_SQL).toContain("'chat_inbox_processing'");
    expect(RECOVERY_COUNT_SQL).not.toContain("character.release.published.v2");
  });

  it("classifies audited Main transport dispositions as known terminal states", () => {
    expect(MAIN_OUTBOX_TRANSPORT_TERMINAL_STATUSES).toEqual([
      "delivered",
      "failed",
      "rejected",
      "cancelled",
      "discarded_target_missing",
    ]);
    for (const status of MAIN_OUTBOX_TRANSPORT_TERMINAL_STATUSES) {
      expect(RECOVERY_COUNT_SQL).toContain(`'${status}'`);
    }
  });

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
      DATABASE_URL: "postgresql://main:source-secret@db.internal:5432/idream",
      RECOVERY_DATABASE_URL:
        "postgresql://postgres:secret@db.internal:5432/idream",
      REDIS_URL: "redis://redis.internal:6379/3",
      BULLMQ_PREFIX: "idream:development",
      CHAT_DATABASE_URL:
        "postgresql://chat_service:request-secret@db.internal:5432/idream",
      CHAT_PROJECTOR_DATABASE_URL:
        "postgresql://chat_projector:projector-secret@db.internal:5432/idream",
      CHAT_FS_ROOT: chatRoot,
      BLOB_PROVIDER: "mock",
      GEN_BLOB_PROVIDER: "mock",
      BLOB_ROOT: blobRoot,
      PGHOSTADDR: "",
      PGSERVICE: "",
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
      main_outbox_transport_pending: 0,
      main_outbox_transport_failed: 0,
      main_outbox_dispatched: 0,
      main_outbox_transport_unknown: 0,
      inbound_event_received: 0,
      inbound_event_processing: 0,
      chat_outbox_pending: 0,
      chat_outbox_failed: 0,
      chat_inbox_pending: 0,
      chat_inbox_failed: 0,
      chat_inbox_processing: 0,
      chat_file_mutations_pending: 0,
    };
    const {
      calls,
      chatDatabaseConnections,
      databaseChildTargetOverrides,
      databaseExecutionUsers,
      quiescenceEnvironments,
      runner,
    } = fakeRunner(counts);
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
      env: env as unknown as NodeJS.ProcessEnv,
      expectedMigrations,
      workspaceRoot,
      runner,
      inspectMigration: async () => exactMigrationAuthority,
    });

    expect(result).toMatchObject({ ok: true, bundleName, migrationCount: 2 });
    expect(calls).toEqual(expect.arrayContaining([
      "generation_pause_and_drain",
      "generation_cutover_authority",
      "generation_worker_ownership",
      "runtime_quiescence_pm2",
      "chat_request_database_authority",
      "chat_projector_database_authority",
      "source_counts",
      "postgres_custom_dump",
      "restore_database_apply",
      "restore_counts",
      "restore_database_cleanup",
    ]));
    expect(calls.indexOf("chat_request_database_authority"))
      .toBeLessThan(calls.indexOf("source_counts"));
    expect(calls.indexOf("chat_projector_database_authority"))
      .toBeLessThan(calls.indexOf("source_counts"));
    expect(chatDatabaseConnections).toEqual([
      {
        stage: "chat_request_database_authority",
        host: "db.internal",
        port: "5432",
        database: "idream",
        user: "chat_service",
        password: "request-secret",
      },
      {
        stage: "chat_projector_database_authority",
        host: "db.internal",
        port: "5432",
        database: "idream",
        user: "chat_projector",
        password: "projector-secret",
      },
    ]);
    expect(databaseChildTargetOverrides).toEqual([
      {
        stage: "chat_request_database_authority",
        hostaddr: undefined,
        service: undefined,
      },
      {
        stage: "chat_projector_database_authority",
        hostaddr: undefined,
        service: undefined,
      },
    ]);
    expect(quiescenceEnvironments).toHaveLength(3);
    expect(quiescenceEnvironments.every((value) =>
      value.REDIS_URL === "redis://redis.internal:6379/3" &&
      value.GEN_REDIS_URL === "redis://redis.internal:6379/3" &&
      value.BULLMQ_PREFIX === "idream:development"
    )).toBe(true);
    expect(databaseExecutionUsers).toEqual([
      { stage: "postgres_custom_dump", user: "postgres" },
      { stage: "restore_database_create", user: "postgres" },
      { stage: "restore_database_apply", user: "postgres" },
    ]);
    const entries = await readdir(result.bundlePath);
    expect(entries).toContain(`${bundleName}.dump`);
    expect(entries).toContain(`${bundleName}.chat-fs.tar.gz`);
    expect(entries).toContain(`${bundleName}.blob.tar.gz`);
    expect(entries).toContain(`${bundleName}.quiescence-receipt.json`);
    expect(entries).toContain(`${bundleName}.sha256`);
    expect(entries.every((entry) => !entry.includes("staging"))).toBe(true);
  });

  it("authenticates both Chat roles against the exact Main source before capture", async () => {
    const workspaceRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), "idream-recovery-chat-authority-")),
    );
    temporaryDirectories.push(workspaceRoot);
    const env = {
      APP_ENV: "production",
      IDREAM_QUIESCED: "1",
      DATABASE_URL: "postgresql://postgres:secret@db.internal:5432/idream",
      RECOVERY_DATABASE_URL:
        "postgresql://postgres:secret@db.internal:5432/idream",
      REDIS_URL: "redis://redis.internal:6379/3",
      BULLMQ_PREFIX: "idream:development",
      CHAT_DATABASE_URL:
        "postgresql://chat_service:secret@db.internal:5432/idream",
      CHAT_PROJECTOR_DATABASE_URL:
        "postgresql://chat_projector:secret@db.internal:5432/idream",
      CHAT_FS_ROOT: path.join(workspaceRoot, "chat"),
      BLOB_PROVIDER: "mock",
      GEN_BLOB_PROVIDER: "mock",
      BLOB_ROOT: path.join(workspaceRoot, "blob"),
    };
    const bundleName = "idream-recovery-chat-authority-1";
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
      expectedMigrationCount: 1,
      latestMigration: "001_terminal",
      workspaceRoot,
    });
    const { calls, runner } = fakeRunner({}, undefined, {
      projector: {
        session_user: "postgres",
        current_user: "chat_projector",
        database: "idream",
      },
    });

    await expect(executeRecoveryRehearsal({
      plan,
      env: env as unknown as NodeJS.ProcessEnv,
      expectedMigrations: [
        { migrationName: "001_terminal", checksum: "a".repeat(64) },
      ],
      workspaceRoot,
      runner,
    })).rejects.toThrow(
      "CHAT_PROJECTOR_DATABASE_URL did not authenticate as exact role chat_projector",
    );

    expect(calls).toContain("chat_request_database_authority");
    expect(calls).toContain("chat_projector_database_authority");
    expect(calls).not.toContain("source_counts");
    expect(calls).not.toContain("postgres_custom_dump");
    expect(calls).not.toContain("restore_database_create");
  });

  it("rejects execution-time Chat database target drift before authentication", async () => {
    const workspaceRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), "idream-recovery-chat-target-")),
    );
    temporaryDirectories.push(workspaceRoot);
    const env = {
      APP_ENV: "production",
      IDREAM_QUIESCED: "1",
      DATABASE_URL: "postgresql://postgres:secret@db.internal:5432/idream",
      RECOVERY_DATABASE_URL:
        "postgresql://postgres:secret@db.internal:5432/idream",
      REDIS_URL: "redis://redis.internal:6379/3",
      BULLMQ_PREFIX: "idream:development",
      CHAT_DATABASE_URL:
        "postgresql://chat_service:secret@db.internal:5432/idream",
      CHAT_PROJECTOR_DATABASE_URL:
        "postgresql://chat_projector:secret@db.internal:5432/idream",
      CHAT_FS_ROOT: path.join(workspaceRoot, "chat"),
      BLOB_PROVIDER: "mock",
      GEN_BLOB_PROVIDER: "mock",
      BLOB_ROOT: path.join(workspaceRoot, "blob"),
    };
    const bundleName = "idream-recovery-chat-target-1";
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
      expectedMigrationCount: 1,
      latestMigration: "001_terminal",
      workspaceRoot,
    });
    const executionEnv = {
      ...env,
      CHAT_PROJECTOR_DATABASE_URL:
        "postgresql://chat_projector:secret@other.internal:5432/idream",
    };
    const { calls, runner } = fakeRunner({});

    await expect(executeRecoveryRehearsal({
      plan,
      env: executionEnv as unknown as NodeJS.ProcessEnv,
      expectedMigrations: [
        { migrationName: "001_terminal", checksum: "a".repeat(64) },
      ],
      workspaceRoot,
      runner,
    })).rejects.toThrow(
      "CHAT_PROJECTOR_DATABASE_URL must target the exact Main source database",
    );

    expect(calls).toEqual([]);
    expect(existsSync(path.join(workspaceRoot, "backups"))).toBe(false);
  });

  it.each([
    [
      "query target override",
      {
        DATABASE_URL:
          "postgresql://postgres:secret@db.internal:5432/idream?host=other.internal",
      },
      "DATABASE_URL must be an unambiguous PostgreSQL URL",
    ],
    [
      "ambient target override",
      { PGHOSTADDR: "203.0.113.10" },
      "ambient libpq target variable PGHOSTADDR is not allowed",
    ],
    [
      "Chat role override",
      {
        CHAT_DATABASE_URL:
          "postgresql://postgres:secret@db.internal:5432/idream",
      },
      "CHAT_DATABASE_URL must use chat_service",
    ],
  ])("rejects execution-time %s before every side effect", async (
    _caseName,
    override,
    expectedError,
  ) => {
    const workspaceRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), "idream-recovery-pre-effect-")),
    );
    temporaryDirectories.push(workspaceRoot);
    const env = {
      APP_ENV: "production",
      IDREAM_QUIESCED: "1",
      DATABASE_URL: "postgresql://postgres:secret@db.internal:5432/idream",
      RECOVERY_DATABASE_URL:
        "postgresql://postgres:secret@db.internal:5432/idream",
      REDIS_URL: "redis://redis.internal:6379/3",
      BULLMQ_PREFIX: "idream:development",
      CHAT_DATABASE_URL:
        "postgresql://chat_service:secret@db.internal:5432/idream",
      CHAT_PROJECTOR_DATABASE_URL:
        "postgresql://chat_projector:secret@db.internal:5432/idream",
      CHAT_FS_ROOT: path.join(workspaceRoot, "chat"),
      BLOB_PROVIDER: "mock",
      GEN_BLOB_PROVIDER: "mock",
      BLOB_ROOT: path.join(workspaceRoot, "blob"),
    };
    const bundleName = "idream-recovery-pre-effect-1";
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
      expectedMigrationCount: 1,
      latestMigration: "001_terminal",
      workspaceRoot,
    });
    const { calls, runner } = fakeRunner({});

    await expect(executeRecoveryRehearsal({
      plan,
      env: { ...env, ...override } as unknown as NodeJS.ProcessEnv,
      expectedMigrations: [
        { migrationName: "001_terminal", checksum: "a".repeat(64) },
      ],
      workspaceRoot,
      runner,
    })).rejects.toThrow(expectedError);

    expect(calls).toEqual([]);
    expect(existsSync(path.join(workspaceRoot, "backups"))).toBe(false);
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
      RECOVERY_DATABASE_URL:
        "postgresql://postgres:secret@db.internal:5432/idream",
      REDIS_URL: "redis://redis.internal:6379/3",
      BULLMQ_PREFIX: "idream:development",
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
      main_outbox_transport_pending: 0,
      main_outbox_transport_failed: 0,
      main_outbox_dispatched: 0,
      main_outbox_transport_unknown: 0,
      inbound_event_received: 0,
      inbound_event_processing: 0,
      chat_outbox_pending: 0,
      chat_outbox_failed: 0,
      chat_inbox_pending: 0,
      chat_inbox_failed: 0,
      chat_inbox_processing: 0,
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
      env: env as unknown as NodeJS.ProcessEnv,
      expectedMigrations,
      workspaceRoot,
      runner,
      inspectMigration: async () => exactMigrationAuthority,
    })).rejects.toThrow("injected failure at restore_database_apply");

    expect(calls).toContain("restore_database_failure_cleanup");
    expect(await readdir(bundleParent)).toEqual([]);
  });
});
