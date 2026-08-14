import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { ExpectedMigration } from "./migration-authority";
import {
  inspectRecoveryRehearsalBundle,
  type RecoveryArchiveCommandRunner,
} from "./recovery-rehearsal-authority";
import { renderRecoveryDatabaseAuthoritySql } from "./recovery-database-authority";

const temporaryDirectories: string[] = [];
const expectedMigrations: ExpectedMigration[] = [
  { migrationName: "001_baseline", checksum: "a".repeat(64) },
  { migrationName: "002_launch_authority", checksum: "b".repeat(64) },
];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

const validArchiveRunner: RecoveryArchiveCommandRunner = {
  run(input) {
    if (input.command === "pg_restore") {
      return {
        stdout: Buffer.from([
          "; Archive created at 2026-08-12 00:00:00 UTC",
          ";     TOC Entries: 2",
          "; Selected TOC Entries:",
          "1; 0 0 TABLE public fixture postgres",
          "",
        ].join("\n")),
        stderr: Buffer.alloc(0),
        status: 0,
      };
    }
    const result = spawnSync(input.command, [...(input.args ?? [])], {
      encoding: null,
    });
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(`${input.stage} failed`);
    }
    return {
      stdout: Buffer.from(result.stdout ?? ""),
      stderr: Buffer.from(result.stderr ?? ""),
      status: result.status,
    };
  },
};

function writeRecoveryBundle(overrides?: {
  sourceCounts?: Record<string, unknown>;
  corruptFile?: string;
  completedAt?: string;
  sourceCheckpointSha256?: string;
  blobArtifactMode?: "remote" | "local" | "both";
  placeholderArchives?: boolean;
  quiescenceQueues?: readonly string[];
  quiescenceActiveBullRows?: readonly unknown[];
  remoteInventoryBucket?: string;
  remoteRecoveryChecksumSha256?: string;
  remoteRecoveryRetention?: string | null;
  queuePrefix?: string;
}) {
  const parent = mkdtempSync(path.join(tmpdir(), "idream-recovery-"));
  temporaryDirectories.push(parent);
  const bundleName = "idream-main-final-test-002";
  const bundle = path.join(parent, bundleName);
  const base = path.join(bundle, bundleName);
  mkdirSync(bundle);

  const chatFixture = path.join(parent, "chat");
  mkdirSync(chatFixture, { mode: 0o755 });
  writeFileSync(path.join(chatFixture, "session.json"), "chat", { mode: 0o600 });
  const chatArchiveFixture = path.join(parent, "chat.tar.gz");
  const archived = spawnSync(
    "tar",
    ["-czf", chatArchiveFixture, "-C", parent, "chat"],
    { encoding: null },
  );
  if (archived.error || archived.status !== 0) {
    throw archived.error ?? new Error("could not create Chat fixture archive");
  }

  const sourceCounts = JSON.stringify(
    {
      migrations: 2,
      latest_migration: "002_launch_authority",
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
      ...overrides?.sourceCounts,
    },
    null,
    2,
  );
  const quiescenceFacts = {
    runtime: {
      processes: [
        { name: "main-web", pmId: 1, status: "stopped" },
        { name: "gen-image", pmId: 2, status: "stopped" },
      ],
      ports: [3000, 3001, 3100].map((port) => ({ port, listener: false })),
    },
    generation: {
      pauseAndDrain: {
        ok: true,
        queues: (overrides?.quiescenceQueues ?? [
          "ai.image.generate",
          "ai.video.generate",
          "app.generation.terminal.ingest",
          "app.ai.finalize",
        ]).map((queue) => ({
          queue,
          paused: true,
        })),
        activeBullRows: overrides?.quiescenceActiveBullRows ?? [],
        pendingTerminalOutboxes: 0,
      },
      cutover: {
        ok: true,
        activeRequests: 0,
        inFlightBullRows: 0,
        pendingTerminalOutboxes: 0,
        issues: [],
      },
      ownership: {
        mode: "quiescent",
        ok: true,
        expected: { image: 0, video: 0 },
        issues: [],
      },
    },
    queueAuthority: {
      redis: "redis://redis.internal:6379/3",
      prefix: overrides?.queuePrefix ?? "idream:development",
    },
  };
  const quiescenceReceipt = `${JSON.stringify({
    schemaVersion: 1,
    checkedAt: overrides?.completedAt ?? new Date().toISOString(),
    ...quiescenceFacts,
    fingerprint: sha256(JSON.stringify(quiescenceFacts)),
  }, null, 2)}\n`;
  const schema = [
    "-- PostgreSQL database dump",
    'CREATE TABLE "public"."_prisma_migrations" ("id" text);',
    'CREATE TABLE "chat"."chat_sessions" ("id" text);',
    "",
  ].join("\n");
  const logical = `${JSON.stringify({
    manifest_version: 1,
    schema_definition_sha256: sha256(schema),
    authority: {
      required_roles: [
        "core_owner",
        "chat_owner",
        "chat_service",
        "chat_projector",
      ],
    },
    privilege_boundary: {},
    tables: [
      {
        schema: "public",
        table: "_prisma_migrations",
        relkind: "r",
        is_partition: false,
        row_count: 2,
        row_digest_sha256: "c".repeat(64),
      },
    ],
    sequences: [],
  }, null, 2)}\n`;
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
  } as const;
  const pairedFiles: Record<string, string | Buffer> = {
    "source-counts.json": sourceCounts,
    "restore-counts.json": sourceCounts,
    "source-schema.sql": schema,
    "restore-schema.sql": schema,
    "source-logical.json": logical,
    "restore-logical.json": logical,
    "chat-fs.source.sha256": `directory\t755\t-\t.\nfile\t600\t${sha256("chat")}\t./session.json\n`,
    "chat-fs.restore.sha256": `directory\t755\t-\t.\nfile\t600\t${sha256("chat")}\t./session.json\n`,
    "blob.source.sha256": `directory\t755\t-\t.\nfile\t600\t${"e".repeat(64)}\t./asset.bin\n`,
    "blob.restore.sha256": `directory\t755\t-\t.\nfile\t600\t${"e".repeat(64)}\t./asset.bin\n`,
  };
  const files: Record<string, string | Buffer> = {
    ...pairedFiles,
    dump: Buffer.concat([Buffer.from("PGDMP", "ascii"), Buffer.alloc(32)]),
    sql: schema,
    "pg16.sql": schema,
    "roles.json": `${JSON.stringify({
      password_restore_policy: "Credentials are excluded.",
      required_roles: [
        "core_owner",
        "chat_owner",
        "chat_service",
        "chat_projector",
      ],
      roles_without_passwords: [],
      memberships: [],
    })}\n`,
    "database-authority.json": `${JSON.stringify(databaseAuthority)}\n`,
    "database-authority.restore.sql": overrides?.placeholderArchives
      ? "-- \\set ON_ERROR_STOP on\n-- \\if :{?target_database}\n-- ALTER DATABASE\nSELECT 1;\n"
      : renderRecoveryDatabaseAuthoritySql(databaseAuthority),
    "file-authorities.json":
      '{"chat_fs":{"files":1,"bytes":16},"blob":{"authorities_match":true,"main_effective":{"provider":"r2"},"gen_effective":{"provider":"r2"},"files":1,"bytes":32}}\n',
    "tool-versions.json":
      '{"bun":"1.3.14","pg_dump":"pg_dump (PostgreSQL) 18.3","pg_restore":"pg_restore (PostgreSQL) 18.3","psql":"psql (PostgreSQL) 18.3","server_version":"16.14","server_version_num":"160014"}\n',
    "quiescence-receipt.json": quiescenceReceipt,
    "chat-fs.tar.gz": overrides?.placeholderArchives
      ? gzipSync(Buffer.from("chat archive"))
      : readFileSync(chatArchiveFixture),
    "blob-object-versions.json": `${JSON.stringify({
      provider: "r2",
      endpoint: "https://account.r2.cloudflarestorage.com/",
      bucket: overrides?.remoteInventoryBucket ?? "idream-production",
      recoveryAuthority: {
        endpoint: "https://recovery.r2.cloudflarestorage.com/",
        bucket: "idream-recovery",
        region: "auto",
        retentionDays: 30,
      },
      objects: [{
        key: "asset.bin",
        versionId: "version-1",
        etag: "etag-1",
        size: 32,
        sha256: "e".repeat(64),
        metadata: {
          contentType: "application/octet-stream",
          cacheControl: null,
          metadata: {},
          objectLockMode: null,
          objectLockRetainUntilDate: null,
          objectLockLegalHoldStatus: null,
        },
        recovery: {
          endpoint: "https://recovery.r2.cloudflarestorage.com/",
          bucket: "idream-recovery",
          key: `.idream-recovery/${bundleName}/asset.bin`,
          versionId: "recovery-version-1",
          checksumSha256: overrides?.remoteRecoveryChecksumSha256 ??
            Buffer.from("e".repeat(64), "hex").toString("base64"),
          objectLockMode: "COMPLIANCE",
          objectLockRetainUntilDate:
            overrides?.remoteRecoveryRetention === undefined
              ? "2027-08-12T00:00:00.000Z"
              : overrides.remoteRecoveryRetention,
        },
      }],
    })}\n`,
    "proof.sh": "#!/bin/sh\nexit 0\n",
    "RESTORE.md": "# restore\n",
  };
  const blobArtifactMode = overrides?.blobArtifactMode ?? "remote";
  if (blobArtifactMode === "local" || blobArtifactMode === "both") {
    files["blob.tar.gz"] = gzipSync(Buffer.from("local blob archive"));
  }
  if (blobArtifactMode === "local") {
    delete files["blob-object-versions.json"];
  }
  const checkpointSuffixes = [
    "quiescence-receipt.json",
    "source-counts.json",
    "source-schema.sql",
    "source-logical.json",
    "chat-fs.source.sha256",
    "blob.source.sha256",
    ...(files["blob-object-versions.json"]
      ? ["blob-object-versions.json"]
      : []),
  ];
  const sourceCheckpointSha256 = sha256(checkpointSuffixes
    .map((suffix) => {
      const filename = `${bundleName}.${suffix}`;
      return `${filename}\0${sha256(files[suffix]!)}\n`;
    })
    .sort()
    .join(""));
  files["metadata.json"] = `${JSON.stringify({
      schemaVersion: 1,
      completedAt: overrides?.completedAt ?? new Date().toISOString(),
      sourceCheckpointSha256:
        overrides?.sourceCheckpointSha256 ?? sourceCheckpointSha256,
      sourceAuthority: {
        database: {
          host: "db.internal",
          port: 5432,
          database: "idream",
        },
        chatFsRoot: "/var/lib/idream/chat",
        queue: {
          redis: "redis://redis.internal:6379/3",
          prefix: overrides?.queuePrefix ?? "idream:development",
        },
        blob: {
          provider: "r2",
          endpoint: "https://account.r2.cloudflarestorage.com/",
          bucket: "idream-production",
          root: null,
          recoveryRetentionDays: 30,
        },
      },
    })}\n`;

  const manifest: string[] = [];
  for (const [suffix, originalContent] of Object.entries(files)) {
    const filename = suffix === "pg16.sql"
      ? `${bundleName}-pg16.sql`
      : `${bundleName}.${suffix}`;
    const content = filename === overrides?.corruptFile
      ? Buffer.concat([Buffer.from(originalContent), Buffer.from("corrupt")])
      : originalContent;
    writeFileSync(path.join(bundle, filename), content);
    manifest.push(`${sha256(originalContent)}  ${filename}`);
  }
  writeFileSync(`${base}.sha256`, `${manifest.join("\n")}\n`);
  return bundle;
}

describe("recovery rehearsal bundle authority", () => {
  it("rejects a self-signed bundle whose manifest digest was not operator-approved", async () => {
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle(),
      expectedMigrations,
      approvedBundleDigest: "f".repeat(64),
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      "bundle manifest digest does not match RECOVERY_REHEARSAL_APPROVED_SHA256",
    );
  });

  it("never follows a symlinked master checksum manifest", async () => {
    const bundle = writeRecoveryBundle();
    const bundleName = path.basename(bundle);
    const checksum = path.join(bundle, `${bundleName}.sha256`);
    rmSync(checksum);
    symlinkSync(path.join(bundle, `${bundleName}.metadata.json`), checksum);

    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: bundle,
      expectedMigrations,
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.join("; ")).toContain(
      "recovery bundle inspection failed",
    );
  });

  it("rejects PGDMP magic plus zeros, gzip-wrapped text, and a no-op restore script", async () => {
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle({ placeholderArchives: true }),
      expectedMigrations,
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(expect.arrayContaining([
      expect.stringContaining("pg_restore --list"),
      expect.stringContaining("does not reconstruct its source authority manifest"),
      expect.stringContaining("database authority restore script differs from canonical authority"),
    ]));
  });

  it("accepts an integrity-checked current migration restore bundle", async () => {
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle(),
      expectedMigrations,
      commandRunner: validArchiveRunner,
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result).toMatchObject({
      ok: true,
      migrationCount: 2,
      latestMigration: "002_launch_authority",
      problems: [],
    });
  });

  it("rejects a bundle from an older migration authority", async () => {
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle({
        sourceCounts: {
          migrations: 1,
          latest_migration: "001_baseline",
        },
      }),
      expectedMigrations,
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      "checkpoint migration authority is 1/2 with latest 001_baseline, expected 002_launch_authority",
    );
  });

  it("rejects any artifact whose digest differs from the bundle manifest", async () => {
    const bundle = writeRecoveryBundle({
      corruptFile: "idream-main-final-test-002.restore-schema.sql",
    });
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: bundle,
      expectedMigrations,
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      "checksum mismatch: idream-main-final-test-002.restore-schema.sql",
    );
  });

  it("rejects metadata whose checkpoint identity is detached from source artifacts", async () => {
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle({
        sourceCheckpointSha256: "f".repeat(64),
      }),
      expectedMigrations,
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      "source checkpoint identity does not match checksummed recovery artifacts",
    );
  });

  it("rejects a bundle captured from a different current source authority", async () => {
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle(),
      expectedMigrations,
      expectedSourceAuthority: {
        database: {
          host: "db.internal",
          port: 5432,
          database: "idream",
        },
        chatFsRoot: "/var/lib/idream/chat",
        queue: {
          redis: "redis://redis.internal:6379/3",
          prefix: "idream:development",
        },
        blob: {
          provider: "r2",
          endpoint: "https://account.r2.cloudflarestorage.com/",
          bucket: "different-production-bucket",
          root: null,
          recoveryRetentionDays: 30,
        },
      },
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      "recovery Blob target does not match current authority",
    );
  });

  it("rejects a bundle captured from another Main/Gen queue authority", async () => {
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle({ queuePrefix: "idream:development" }),
      expectedMigrations,
      expectedSourceAuthority: {
        database: { host: "db.internal", port: 5432, database: "idream" },
        chatFsRoot: "/var/lib/idream/chat",
        queue: {
          redis: "redis://redis.internal:6379/3",
          prefix: "idream:production",
        },
        blob: {
          provider: "r2",
          endpoint: "https://account.r2.cloudflarestorage.com/",
          bucket: "idream-production",
          root: null,
          recoveryRetentionDays: 30,
        },
      },
      commandRunner: validArchiveRunner,
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      "recovery queue authority does not match current Main/Gen authority",
    );
  });

  it("rejects a remote inventory that is not bound to metadata source authority", async () => {
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle({
        remoteInventoryBucket: "unrelated-source-bucket",
      }),
      expectedMigrations,
      commandRunner: validArchiveRunner,
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      "idream-main-final-test-002.blob-object-versions.json is not a complete versioned Blob inventory",
    );
  });

  it("rejects a recovery checksum detached from the source bytes", async () => {
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle({
        remoteRecoveryChecksumSha256:
          Buffer.from("f".repeat(64), "hex").toString("base64"),
      }),
      expectedMigrations,
      commandRunner: validArchiveRunner,
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      "idream-main-final-test-002.blob-object-versions.json is not a complete versioned Blob inventory",
    );
  });

  it.each([null, "2025-01-01T00:00:00.000Z"])(
    "rejects remote recovery versions without sufficient retention: %s",
    async (remoteRecoveryRetention) => {
      const result = await inspectRecoveryRehearsalBundle({
        bundlePath: writeRecoveryBundle({ remoteRecoveryRetention }),
        expectedMigrations,
        commandRunner: validArchiveRunner,
        now: new Date("2026-08-12T00:00:00.000Z"),
        maxAgeMinutes: 60,
      });

      expect(result.ok).toBe(false);
      expect(result.problems).toContain(
        "idream-main-final-test-002.blob-object-versions.json is not a complete versioned Blob inventory",
      );
    },
  );

  it.each(["local", "both"] as const)(
    "rejects remote Blob metadata backed by %s artifact authority",
    async (blobArtifactMode) => {
      const result = await inspectRecoveryRehearsalBundle({
        bundlePath: writeRecoveryBundle({ blobArtifactMode }),
        expectedMigrations,
        now: new Date(),
        maxAgeMinutes: 60,
      });

      expect(result.ok).toBe(false);
      expect(result.problems).toContain(
        "remote Blob recovery metadata requires exactly one versioned object inventory and no local archive",
      );
    },
  );

  it("preserves durable backlog but rejects an in-flight checkpoint mutation", async () => {
    const backlog = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle({
        sourceCounts: {
          main_outbox_pending: 76,
          main_outbox_failed: 1,
          main_outbox_transport_pending: 1,
          main_outbox_transport_failed: 1,
          chat_file_mutations_pending: 4,
        },
      }),
      expectedMigrations,
      commandRunner: validArchiveRunner,
      now: new Date(),
      maxAgeMinutes: 60,
    });
    expect(backlog.ok).toBe(true);

    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle({
        sourceCounts: { main_outbox_dispatched: 1 },
      }),
      expectedMigrations,
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      "checkpoint has in-flight mutation: main_outbox_dispatched=1",
    );
  });

  it("rejects duplicate queue names or active rows in a signed quiescence receipt", async () => {
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle({
        quiescenceQueues: [
          "ai.image.generate",
          "ai.image.generate",
          "app.generation.terminal.ingest",
          "app.ai.finalize",
        ],
        quiescenceActiveBullRows: [{ queue: "ai.image.generate", jobId: "1" }],
      }),
      expectedMigrations,
      commandRunner: validArchiveRunner,
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      "quiescence receipt does not prove fresh Generation queue, cutover, worker, PM2, and port authority",
    );
  });

  it("rejects a self-consistent rehearsal outside the launch freshness window", async () => {
    const now = new Date();
    const completedAt = new Date(now.getTime() - 61 * 60_000).toISOString();
    const bundle = writeRecoveryBundle({ completedAt });
    const bundleName = path.basename(bundle);
    const checksum = path.join(bundle, `${bundleName}.sha256`);
    utimesSync(checksum, now, now);
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: bundle,
      expectedMigrations,
      now,
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.checkedAt).toBe(completedAt);
    expect(result.problems).toContain(
      "recovery rehearsal is older than 60 minutes",
    );
  });

  it("rejects checksummed placeholder artifacts that were not produced by backup tools", async () => {
    const bundle = writeRecoveryBundle();
    const bundleName = path.basename(bundle);
    const base = path.join(bundle, bundleName);
    const dumpName = `${bundleName}.dump`;
    const archiveName = `${bundleName}.chat-fs.tar.gz`;
    const manifestName = `${bundleName}.chat-fs.source.sha256`;
    const replacements = new Map([
      [dumpName, Buffer.from("not a pg_dump archive")],
      [archiveName, Buffer.from("not a gzip archive")],
      [manifestName, Buffer.from("file\t600\tabc\t../escape\n")],
    ]);
    const checksumLines = (await import("node:fs/promises"))
      .readFile(`${base}.sha256`, "utf8")
      .then((value) => value.trim().split("\n"));
    const rewritten = [];
    for (const line of await checksumLines) {
      const filename = line.slice(66);
      const replacement = replacements.get(filename);
      if (replacement) {
        writeFileSync(path.join(bundle, filename), replacement);
        rewritten.push(`${sha256(replacement)}  ${filename}`);
      } else {
        rewritten.push(line);
      }
    }
    writeFileSync(`${base}.sha256`, `${rewritten.join("\n")}\n`);

    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: bundle,
      expectedMigrations,
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(expect.arrayContaining([
      `${dumpName} is not a PostgreSQL custom-format dump`,
      `${archiveName} is not a gzip archive`,
      `${manifestName} contains an invalid authority entry`,
    ]));
  });
});
