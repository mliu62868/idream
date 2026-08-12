import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFileAuthorityManifest,
  parseRecoveryRehearsalCliArgs,
  resolveRecoveryRehearsalPlan,
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
        IDREAM_QUIESCED: "1",
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

    expect(plan.safeToApply).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.database).toEqual({
      database: "idream",
      host: "db.internal",
      port: 5432,
      user: "main",
    });
    expect(plan.blob).toEqual({
      provider: "r2",
      endpoint: "https://account.r2.cloudflarestorage.com/",
      bucket: "idream-private-media",
      region: "auto",
      root: null,
    });
    expect(JSON.stringify(plan)).not.toContain("secret");
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

  it("requires the exact migration and a silent durable-work boundary", () => {
    expect(validateRecoveryCounts({
      migrations: 71,
      latest_migration: "migration-71",
      main_outbox_pending: 0,
      main_outbox_failed: 0,
      inbound_event_received: 0,
      chat_outbox_pending: 0,
      chat_outbox_failed: 0,
      chat_inbox_pending: 0,
      chat_inbox_failed: 0,
      chat_file_mutations_pending: 0,
    }, 71, "migration-71")).toEqual([]);

    expect(validateRecoveryCounts({
      migrations: 70,
      latest_migration: "migration-70",
      main_outbox_pending: 1,
    }, 71, "migration-71")).toEqual(expect.arrayContaining([
      "migration authority is 70/71 with latest migration-70, expected migration-71",
      "checkpoint is not quiescent: main_outbox_pending=1",
    ]));
  });
});
