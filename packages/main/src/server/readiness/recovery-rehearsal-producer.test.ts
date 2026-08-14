import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFileAuthorityManifest,
  parseRecoveryRehearsalCliArgs,
  resolveRecoveryRehearsalPlan,
  resolveRecoveryRehearsalSourceAuthority,
  selectLiveBlobVersions,
  validateRecoveryCounts,
} from "./recovery-rehearsal-producer";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("recovery rehearsal producer", () => {
  it("parses a read-only plan separately from the confirmed apply operation", () => {
    expect(parseRecoveryRehearsalCliArgs([
      "--bundle-parent",
      "/srv/backups",
      "--bundle-name",
      "idream-recovery-20260811-71",
      "--launch-env-file",
      "/run/secrets/main.env",
      "--chat-env-file",
      "/run/secrets/chat.env",
      "--gen-env-file",
      "/run/secrets/gen.env",
    ])).toEqual({
      apply: false,
      bundleName: "idream-recovery-20260811-71",
      bundleParent: "/srv/backups",
      chatEnvFile: "/run/secrets/chat.env",
      confirmation: null,
      genEnvFile: "/run/secrets/gen.env",
      help: false,
      launchEnvFile: "/run/secrets/main.env",
    });

    expect(() => parseRecoveryRehearsalCliArgs([
      "--confirmation",
      "CREATE RECOVERY REHEARSAL idream-recovery-20260811-71",
    ])).toThrow("--confirmation is only valid with --apply");
    expect(() => parseRecoveryRehearsalCliArgs([
      "--apply",
      "--bundle-name",
      "../escape",
    ])).toThrow("safe bundle name");
  });

  it("builds a sanitized fail-closed production plan", () => {
    const plan = resolveRecoveryRehearsalPlan({
      options: {
        apply: true,
        bundleName: "idream-recovery-20260811-71",
        bundleParent: "/srv/backups",
        chatEnvFile: null,
        confirmation: "CREATE RECOVERY REHEARSAL idream-recovery-20260811-71",
        genEnvFile: null,
        help: false,
        launchEnvFile: null,
      },
      env: {
        APP_ENV: "production",
        IDREAM_RECOVERY_APP_ENV: "production",
        IDREAM_QUIESCED: "1",
        IDREAM_MAIN_REDIS_URL: "redis://redis.internal:6379/3",
        IDREAM_MAIN_BULLMQ_PREFIX: "idream:development",
        IDREAM_GEN_REDIS_URL: "redis://redis.internal:6379/3",
        IDREAM_GEN_BULLMQ_PREFIX: "idream:development",
        DATABASE_URL: "postgresql://main:secret@db.internal:5432/idream",
        CHAT_DATABASE_URL:
          "postgresql://chat_service:chat-secret@db.internal:5432/idream",
        CHAT_PROJECTOR_DATABASE_URL:
          "postgresql://chat_projector:projector-secret@db.internal:5432/idream",
        CHAT_FS_ROOT: "/var/lib/idream/chat",
        BLOB_PROVIDER: "r2",
        GEN_BLOB_PROVIDER: "r2",
        BLOB_ENDPOINT: "https://account.r2.cloudflarestorage.com",
        BLOB_BUCKET: "idream-private-media",
        BLOB_REGION: "auto",
        BLOB_ACCESS_KEY_ID: "access-secret",
        BLOB_SECRET_ACCESS_KEY: "write-secret",
      },
      expectedMigrationCount: 71,
      latestMigration: "20260811190000_account_deletion_terminal_authority",
      workspaceRoot: "/workspace/idream",
    });

    expect(plan.safeToApply).toBe(false);
    expect(plan.blockers).toEqual(expect.arrayContaining([
      "RECOVERY_BLOB_ENDPOINT must identify an independent HTTPS authority",
      "RECOVERY_BLOB_BUCKET must identify an independent versioned bucket",
      "Recovery Blob access credential is required",
      "Recovery Blob signing credential is required",
    ]));
    expect(plan.database).toEqual({
      database: "idream",
      host: "db.internal",
      port: 5432,
      user: "main",
    });
    expect(plan.recoveryDatabase).toEqual({
      database: null,
      host: null,
      port: null,
      user: null,
    });
    expect(plan.blob).toMatchObject({
      provider: "r2",
      endpoint: "https://account.r2.cloudflarestorage.com/",
      bucket: "idream-private-media",
      region: "auto",
      root: null,
      recovery: {
        endpoint: null,
        bucket: null,
        region: null,
      },
    });
    expect(JSON.stringify(plan)).not.toContain("secret");
  });

  it("accepts a remote rehearsal only with an explicit independent recovery authority", () => {
    const bundleName = "idream-recovery-independent-71";
    const plan = resolveRecoveryRehearsalPlan({
      options: {
        apply: true,
        bundleName,
        bundleParent: "/srv/backups",
        chatEnvFile: null,
        confirmation: `CREATE RECOVERY REHEARSAL ${bundleName}`,
        genEnvFile: null,
        help: false,
        launchEnvFile: null,
      },
      env: {
        APP_ENV: "production",
        IDREAM_RECOVERY_APP_ENV: "production",
        IDREAM_QUIESCED: "1",
        IDREAM_MAIN_REDIS_URL: "redis://redis.internal:6379/3",
        IDREAM_MAIN_BULLMQ_PREFIX: "idream:development",
        IDREAM_GEN_REDIS_URL: "redis://redis.internal:6379/3",
        IDREAM_GEN_BULLMQ_PREFIX: "idream:development",
        DATABASE_URL: "postgresql://main:db-pass@db.internal:5432/idream",
        RECOVERY_DATABASE_URL:
          "postgresql://postgres:recovery-pass@db.internal:5432/idream",
        CHAT_DATABASE_URL:
          "postgresql://chat_service:chat-pass@db.internal:5432/idream",
        CHAT_PROJECTOR_DATABASE_URL:
          "postgresql://chat_projector:projector-pass@db.internal:5432/idream",
        CHAT_FS_ROOT: "/var/lib/idream/chat",
        BLOB_PROVIDER: "s3",
        GEN_BLOB_PROVIDER: "s3",
        BLOB_ENDPOINT: "https://s3.us-west-2.amazonaws.com",
        BLOB_BUCKET: "idream-live-us-west-2",
        BLOB_REGION: "us-west-2",
        BLOB_ACCESS_KEY_ID: "live-access",
        BLOB_SECRET_ACCESS_KEY: "live-signing",
        RECOVERY_BLOB_ENDPOINT: "https://s3.eu-west-1.amazonaws.com",
        RECOVERY_BLOB_BUCKET: "idream-recovery-eu-west-1",
        RECOVERY_BLOB_REGION: "eu-west-1",
        RECOVERY_BLOB_ACCESS_KEY_ID: "recovery-access",
        RECOVERY_BLOB_SECRET_ACCESS_KEY: "recovery-signing",
        RECOVERY_BLOB_RETENTION_DAYS: "30",
      },
      expectedMigrationCount: 71,
      latestMigration: "migration-71",
      workspaceRoot: "/workspace/idream",
    });

    expect(plan.safeToApply).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.blob.recovery).toEqual({
      endpoint: "https://s3.eu-west-1.amazonaws.com/",
      bucket: "idream-recovery-eu-west-1",
      region: "eu-west-1",
      retentionDays: 30,
    });
    expect(plan.queueAuthority).toEqual({
      redis: "redis://redis.internal:6379/3",
      prefix: "idream:development",
    });
    expect(plan.recoveryDatabase).toEqual({
      database: "idream",
      host: "db.internal",
      port: 5432,
      user: "postgres",
    });
    expect(JSON.stringify(plan)).not.toContain("pass");
    expect(JSON.stringify(plan)).not.toContain("signing");
  });

  it("fails closed when Main and Gen effective Redis or BullMQ prefix differ", () => {
    const plan = resolveRecoveryRehearsalPlan({
      options: {
        apply: false,
        bundleName: "idream-recovery-queue-authority-71",
        bundleParent: "/srv/backups",
        chatEnvFile: null,
        confirmation: null,
        genEnvFile: null,
        help: false,
        launchEnvFile: null,
      },
      env: {
        APP_ENV: "production",
        IDREAM_RECOVERY_APP_ENV: "production",
        IDREAM_QUIESCED: "1",
        IDREAM_MAIN_REDIS_URL: "redis://redis.internal:6379/3",
        IDREAM_MAIN_BULLMQ_PREFIX: "idream:development",
        IDREAM_GEN_REDIS_URL: "redis://redis.internal:6379/4",
        IDREAM_GEN_BULLMQ_PREFIX: "idream:production",
        DATABASE_URL: "postgresql://main:secret@db.internal:5432/idream",
        RECOVERY_DATABASE_URL:
          "postgresql://postgres:secret@other.internal:5432/idream",
        CHAT_DATABASE_URL:
          "postgresql://chat_service:secret@db.internal:5432/idream",
        CHAT_PROJECTOR_DATABASE_URL:
          "postgresql://chat_projector:secret@db.internal:5432/idream",
        CHAT_FS_ROOT: "/var/lib/idream/chat",
        BLOB_PROVIDER: "mock",
        GEN_BLOB_PROVIDER: "mock",
        BLOB_ROOT: "/var/lib/idream/blob",
        IDREAM_GEN_BLOB_ROOT: "/var/lib/idream/blob",
      },
      expectedMigrationCount: 71,
      latestMigration: "migration-71",
      workspaceRoot: "/workspace/idream",
    });

    expect(plan.safeToApply).toBe(false);
    expect(plan.blockers).toEqual(expect.arrayContaining([
      "Main and Gen Redis authorities must match",
      "Main and Gen BullMQ prefixes must match",
      "RECOVERY_DATABASE_URL must identify the exact Main source database",
    ]));
  });

  it("resolves a relative Chat file root from the Chat service working directory", () => {
    const plan = resolveRecoveryRehearsalPlan({
      options: {
        apply: false,
        bundleName: "idream-recovery-relative-chat-root-71",
        bundleParent: "/srv/backups",
        chatEnvFile: null,
        confirmation: null,
        genEnvFile: null,
        help: false,
        launchEnvFile: null,
      },
      env: {
        CHAT_FS_ROOT: "data/chat",
        REDIS_URL: "redis://redis.internal:6379/3",
        BULLMQ_PREFIX: "idream:development",
      },
      expectedMigrationCount: 71,
      latestMigration: "migration-71",
      workspaceRoot: "/workspace/idream",
    });

    expect(plan.chatFsRoot).toBe(
      "/workspace/idream/packages/chat/data/chat",
    );
    expect(resolveRecoveryRehearsalSourceAuthority({
      env: {
        DATABASE_URL: "postgresql://main:secret@db.internal:5432/idream",
        CHAT_DATABASE_URL:
          "postgresql://chat_service:secret@db.internal:5432/idream",
        CHAT_PROJECTOR_DATABASE_URL:
          "postgresql://chat_projector:secret@db.internal:5432/idream",
        CHAT_FS_ROOT: "data/chat",
        REDIS_URL: "redis://redis.internal:6379/3",
        BULLMQ_PREFIX: "idream:development",
        BLOB_PROVIDER: "mock",
        BLOB_ROOT: "data/blob",
      },
      workspaceRoot: "/workspace/idream",
    })).toEqual({
      database: {
        host: "db.internal",
        port: 5432,
        database: "idream",
      },
      chatFsRoot: "/workspace/idream/packages/chat/data/chat",
      queue: {
        redis: "redis://redis.internal:6379/3",
        prefix: "idream:development",
      },
      blob: {
        provider: "mock",
        endpoint: null,
        bucket: null,
        root: "/workspace/idream/data/blob",
        recoveryRetentionDays: null,
      },
    });

    expect(() => resolveRecoveryRehearsalSourceAuthority({
      env: {
        DATABASE_URL: "postgresql://main:secret@db.internal:5432/idream",
        CHAT_DATABASE_URL:
          "postgresql://chat_service:secret@db.internal:5432/idream",
        CHAT_PROJECTOR_DATABASE_URL:
          "postgresql://chat_projector:secret@other.internal:5432/idream",
        CHAT_FS_ROOT: "data/chat",
        REDIS_URL: "redis://redis.internal:6379/3",
        BULLMQ_PREFIX: "idream:development",
        BLOB_PROVIDER: "mock",
        BLOB_ROOT: "data/blob",
      },
      workspaceRoot: "/workspace/idream",
    })).toThrow(
      "Main, Chat request, and Chat projector must use their exact roles on one database authority",
    );
  });

  it.each([
    [
      "query target override",
      "postgresql://main:secret@db.internal:5432/idream?host=other.internal",
    ],
    [
      "multiple leading database slash",
      "postgresql://main:secret@db.internal:5432//idream",
    ],
    [
      "libpq conninfo database",
      "postgresql://main:secret@db.internal:5432/host%3Dother.internal",
    ],
    [
      "multi-host authority",
      "postgresql://main:secret@db.internal,other.internal:5432/idream",
    ],
  ])("rejects a Main PostgreSQL %s", (_caseName, databaseUrl) => {
    const plan = resolveRecoveryRehearsalPlan({
      options: {
        apply: false,
        bundleName: "idream-recovery-ambiguous-database-71",
        bundleParent: "/srv/backups",
        chatEnvFile: null,
        confirmation: null,
        genEnvFile: null,
        help: false,
        launchEnvFile: null,
      },
      env: {
        APP_ENV: "production",
        IDREAM_QUIESCED: "1",
        DATABASE_URL: databaseUrl,
        CHAT_DATABASE_URL:
          "postgresql://chat_service:chat-secret@db.internal:5432/idream",
        CHAT_PROJECTOR_DATABASE_URL:
          "postgresql://chat_projector:projector-secret@db.internal:5432/idream",
        CHAT_FS_ROOT: "/var/lib/idream/chat",
        BLOB_PROVIDER: "mock",
        GEN_BLOB_PROVIDER: "mock",
        BLOB_ROOT: "/var/lib/idream/blob",
      },
      expectedMigrationCount: 71,
      latestMigration: "migration-71",
      workspaceRoot: "/workspace/idream",
    });

    expect(plan.safeToApply).toBe(false);
    expect(plan.blockers).toContain(
      "DATABASE_URL must be an unambiguous PostgreSQL URL",
    );
  });

  it("rejects ambient libpq target authority", () => {
    const plan = resolveRecoveryRehearsalPlan({
      options: {
        apply: false,
        bundleName: "idream-recovery-ambient-database-71",
        bundleParent: "/srv/backups",
        chatEnvFile: null,
        confirmation: null,
        genEnvFile: null,
        help: false,
        launchEnvFile: null,
      },
      env: {
        APP_ENV: "production",
        IDREAM_QUIESCED: "1",
        DATABASE_URL:
          "postgresql://main:secret@db.internal:5432/idream",
        CHAT_DATABASE_URL:
          "postgresql://chat_service:chat-secret@db.internal:5432/idream",
        CHAT_PROJECTOR_DATABASE_URL:
          "postgresql://chat_projector:projector-secret@db.internal:5432/idream",
        CHAT_FS_ROOT: "/var/lib/idream/chat",
        BLOB_PROVIDER: "mock",
        GEN_BLOB_PROVIDER: "mock",
        BLOB_ROOT: "/var/lib/idream/blob",
        PGHOSTADDR: "203.0.113.10",
      },
      expectedMigrationCount: 71,
      latestMigration: "migration-71",
      workspaceRoot: "/workspace/idream",
    });

    expect(plan.safeToApply).toBe(false);
    expect(plan.blockers).toContain(
      "ambient libpq target variable PGHOSTADDR is not allowed",
    );
  });

  it("rejects split database, Blob, environment, and typed-confirmation authority", () => {
    const plan = resolveRecoveryRehearsalPlan({
      options: {
        apply: true,
        bundleName: "idream-recovery-20260811-71",
        bundleParent: "local-backups",
        chatEnvFile: null,
        confirmation: "wrong",
        genEnvFile: null,
        help: false,
        launchEnvFile: null,
      },
      env: {
        APP_ENV: "development",
        DATABASE_URL: "postgresql://main:pw@db.internal:5432/idream",
        CHAT_DATABASE_URL:
          "postgresql://chat_service:pw@other.internal:5432/idream",
        CHAT_PROJECTOR_DATABASE_URL:
          "postgresql://chat_projector:pw@db.internal:5432/idream",
        CHAT_FS_ROOT: "/var/lib/idream/chat",
        BLOB_PROVIDER: "r2",
        GEN_BLOB_PROVIDER: "mock",
        BLOB_ENDPOINT: "https://account.r2.cloudflarestorage.com",
        BLOB_BUCKET: "idream-private-media",
      },
      expectedMigrationCount: 71,
      latestMigration: "migration-71",
      workspaceRoot: "/workspace/idream",
    });

    expect(plan.safeToApply).toBe(false);
    expect(plan.blockers).toEqual(expect.arrayContaining([
      "APP_ENV must be production",
      "IDREAM_QUIESCED must be 1",
      "Main, Chat request, and Chat projector database authorities must match",
      "Main and Gen Blob providers must match",
      "typed confirmation does not match",
    ]));
  });

  it("does not call production examples safe to apply", () => {
    const plan = resolveRecoveryRehearsalPlan({
      options: {
        apply: false,
        bundleName: "idream-recovery-example-71",
        bundleParent: "/srv/backups",
        chatEnvFile: null,
        confirmation: null,
        genEnvFile: null,
        help: false,
        launchEnvFile: null,
      },
      env: {
        APP_ENV: "production",
        IDREAM_QUIESCED: "1",
        DATABASE_URL:
          "postgresql://app:replace-with-password@postgres.example.com:5432/idream",
        CHAT_DATABASE_URL:
          "postgresql://chat_service:replace-with-password@postgres.example.com:5432/idream",
        CHAT_PROJECTOR_DATABASE_URL:
          "postgresql://chat_projector:replace-with-password@postgres.example.com:5432/idream",
        CHAT_FS_ROOT: "/var/lib/idream/chat",
        BLOB_PROVIDER: "r2",
        GEN_BLOB_PROVIDER: "r2",
        BLOB_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
        BLOB_BUCKET: "idream-private-media",
        BLOB_ACCESS_KEY_ID: "replace-with-access-key",
        BLOB_SECRET_ACCESS_KEY: "replace-with-secret-key",
      },
      expectedMigrationCount: 71,
      latestMigration: "migration-71",
      workspaceRoot: "/workspace/idream",
    });

    expect(plan.safeToApply).toBe(false);
    expect(plan.blockers).toEqual(expect.arrayContaining([
      "database authority contains placeholder values",
      "Blob authority contains placeholder values",
    ]));
  });

  it("creates a deterministic file authority manifest and rejects symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "idream-file-authority-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "a.txt"), "hello");

    const first = await buildFileAuthorityManifest(root);
    const second = await buildFileAuthorityManifest(root);
    expect(first).toBe(second);
    expect(first).toMatch(/^directory\t[0-7]{3,4}\t-\t\.\n/mu);
    expect(first).toMatch(/file\t[0-7]{3,4}\t[a-f0-9]{64}\t\.\/nested\/a\.txt/mu);

    await symlink(path.join(root, "nested", "a.txt"), path.join(root, "link"));
    await expect(buildFileAuthorityManifest(root)).rejects.toThrow("symlink");
  });

  it("selects only live versioned objects and rejects an unversioned bucket", () => {
    expect(selectLiveBlobVersions({
      Versions: [
        { ETag: '"old"', IsLatest: false, Key: "a.bin", Size: 1, VersionId: "v1" },
        { ETag: '"new"', IsLatest: true, Key: "a.bin", Size: 2, VersionId: "v2" },
        { ETag: '"skip"', IsLatest: true, Key: ".idream-recovery/run/a.bin", Size: 2, VersionId: "v3" },
      ],
      DeleteMarkers: [
        { IsLatest: true, Key: "deleted.bin", VersionId: "delete-1" },
      ],
    })).toEqual([
      { etag: '"new"', key: "a.bin", size: 2, versionId: "v2" },
    ]);

    expect(() => selectLiveBlobVersions({
      Versions: [
        { ETag: '"etag"', IsLatest: true, Key: "a.bin", Size: 1, VersionId: "null" },
      ],
    })).toThrow("versioning");
  });

  it("requires the exact migration and no in-flight mutation while preserving durable backlog", () => {
    expect(validateRecoveryCounts({
      migrations: 71,
      latest_migration: "migration-71",
      main_outbox_pending: 76,
      main_outbox_failed: 1,
      main_outbox_transport_pending: 1,
      main_outbox_transport_failed: 1,
      main_outbox_dispatched: 0,
      main_outbox_transport_unknown: 0,
      inbound_event_received: 3,
      inbound_event_processing: 0,
      chat_outbox_pending: 4,
      chat_outbox_failed: 2,
      chat_inbox_pending: 5,
      chat_inbox_failed: 1,
      chat_inbox_processing: 0,
      chat_file_mutations_pending: 6,
    }, 71, "migration-71")).toEqual([]);

    expect(validateRecoveryCounts({
      migrations: 70,
      latest_migration: "migration-70",
      main_outbox_dispatched: 1,
      main_outbox_transport_unknown: 4,
      inbound_event_processing: 2,
      chat_inbox_processing: 3,
    }, 71, "migration-71")).toEqual(expect.arrayContaining([
      "migration authority is 70/71 with latest migration-70, expected migration-71",
      "checkpoint has in-flight mutation: main_outbox_dispatched=1",
      "checkpoint has in-flight mutation: main_outbox_transport_unknown=4",
      "checkpoint has in-flight mutation: inbound_event_processing=2",
      "checkpoint has in-flight mutation: chat_inbox_processing=3",
    ]));
  });
});
