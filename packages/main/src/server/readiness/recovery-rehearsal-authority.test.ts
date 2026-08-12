import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { ExpectedMigration } from "./migration-authority";
import { inspectRecoveryRehearsalBundle } from "./recovery-rehearsal-authority";

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

function writeRecoveryBundle(overrides?: {
  sourceCounts?: Record<string, unknown>;
  corruptFile?: string;
}) {
  const parent = mkdtempSync(path.join(tmpdir(), "idream-recovery-"));
  temporaryDirectories.push(parent);
  const bundleName = "idream-main-final-test-002";
  const bundle = path.join(parent, bundleName);
  const base = path.join(bundle, bundleName);
  mkdirSync(bundle);

  const sourceCounts = JSON.stringify(
    {
      migrations: 2,
      latest_migration: "002_launch_authority",
      main_outbox_pending: 0,
      main_outbox_failed: 0,
      inbound_event_received: 0,
      chat_outbox_pending: 0,
      chat_outbox_failed: 0,
      chat_inbox_pending: 0,
      chat_inbox_failed: 0,
      chat_file_mutations_pending: 0,
      ...overrides?.sourceCounts,
    },
    null,
    2,
  );
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
  const pairedFiles: Record<string, string | Buffer> = {
    "source-counts.json": sourceCounts,
    "restore-counts.json": sourceCounts,
    "source-schema.sql": schema,
    "restore-schema.sql": schema,
    "source-logical.json": logical,
    "restore-logical.json": logical,
    "chat-fs.source.sha256": `directory\t755\t-\t.\nfile\t600\t${"d".repeat(64)}\t./session.json\n`,
    "chat-fs.restore.sha256": `directory\t755\t-\t.\nfile\t600\t${"d".repeat(64)}\t./session.json\n`,
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
    "database-authority.json":
      '{"database":{"owner":"postgres","encoding":"UTF8"},"database_role_settings":[]}\n',
    "database-authority.restore.sql": "SELECT 1;\n",
    "file-authorities.json":
      '{"chat_fs":{"files":1,"bytes":16},"blob":{"authorities_match":true,"main_effective":{"provider":"r2"},"gen_effective":{"provider":"r2"},"files":1,"bytes":32}}\n',
    "tool-versions.json":
      '{"bun":"1.3.14","pg_dump":"pg_dump (PostgreSQL) 18.3","pg_restore":"pg_restore (PostgreSQL) 18.3","psql":"psql (PostgreSQL) 18.3","server_version":"16.14","server_version_num":"160014"}\n',
    "chat-fs.tar.gz": gzipSync(Buffer.from("chat archive")),
    "blob-object-versions.json":
      '{"bucket":"idream-production","objects":[{"key":"asset.bin","versionId":"version-1","etag":"etag-1","size":32}]}\n',
    "proof.sh": "#!/bin/sh\nexit 0\n",
    "RESTORE.md": "# restore\n",
  };

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
  it("accepts an integrity-checked current migration restore bundle", async () => {
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle(),
      expectedMigrations,
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

  it("rejects a checkpoint captured with durable work still unresolved", async () => {
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: writeRecoveryBundle({
        sourceCounts: { main_outbox_failed: 1 },
      }),
      expectedMigrations,
      now: new Date(),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      "checkpoint is not quiescent: main_outbox_failed=1",
    );
  });

  it("rejects a self-consistent rehearsal outside the launch freshness window", async () => {
    const bundle = writeRecoveryBundle();
    const result = await inspectRecoveryRehearsalBundle({
      bundlePath: bundle,
      expectedMigrations,
      now: new Date(Date.now() + 61 * 60_000),
      maxAgeMinutes: 60,
    });

    expect(result.ok).toBe(false);
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
