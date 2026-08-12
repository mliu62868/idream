import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ExpectedMigration } from "./migration-authority";

type RecoveryCounts = {
  readonly migrations?: unknown;
  readonly latest_migration?: unknown;
  readonly main_outbox_pending?: unknown;
  readonly main_outbox_failed?: unknown;
  readonly inbound_event_received?: unknown;
  readonly chat_outbox_pending?: unknown;
  readonly chat_outbox_failed?: unknown;
  readonly chat_inbox_pending?: unknown;
  readonly chat_inbox_failed?: unknown;
  readonly chat_file_mutations_pending?: unknown;
};

export type RecoveryRehearsalAuthority = {
  readonly ok: boolean;
  readonly checkedAt: string | null;
  readonly bundleDigest: string | null;
  readonly migrationCount: number | null;
  readonly latestMigration: string | null;
  readonly problems: readonly string[];
};

const pairedAuthoritySuffixes = [
  ["source-counts.json", "restore-counts.json"],
  ["source-schema.sql", "restore-schema.sql"],
  ["source-logical.json", "restore-logical.json"],
  ["chat-fs.source.sha256", "chat-fs.restore.sha256"],
  ["blob.source.sha256", "blob.restore.sha256"],
] as const;

const requiredSuffixes = [
  "dump",
  "sql",
  "source-counts.json",
  "restore-counts.json",
  "source-schema.sql",
  "restore-schema.sql",
  "source-logical.json",
  "restore-logical.json",
  "roles.json",
  "database-authority.json",
  "database-authority.restore.sql",
  "chat-fs.tar.gz",
  "chat-fs.source.sha256",
  "chat-fs.restore.sha256",
  "blob.source.sha256",
  "blob.restore.sha256",
  "file-authorities.json",
  "tool-versions.json",
  "proof.sh",
  "RESTORE.md",
] as const;

const quiescentCountKeys = [
  "main_outbox_pending",
  "main_outbox_failed",
  "inbound_event_received",
  "chat_outbox_pending",
  "chat_outbox_failed",
  "chat_inbox_pending",
  "chat_inbox_failed",
  "chat_file_mutations_pending",
] as const;

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson<T>(value: Buffer, label: string, problems: string[]) {
  try {
    return JSON.parse(value.toString("utf8")) as T;
  } catch {
    problems.push(`${label} is not valid JSON`);
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hasSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validatePostgresDump(
  value: Buffer | undefined,
  label: string,
  problems: string[],
) {
  if (value && value.subarray(0, 5).toString("ascii") !== "PGDMP") {
    problems.push(`${label} is not a PostgreSQL custom-format dump`);
  }
}

function validateGzipArchive(
  value: Buffer | undefined,
  label: string,
  problems: string[],
) {
  if (
    value &&
    (value.length < 10 || value[0] !== 0x1f || value[1] !== 0x8b || value[2] !== 0x08)
  ) {
    problems.push(`${label} is not a gzip archive`);
  }
}

function validateSchema(
  value: Buffer | undefined,
  label: string,
  problems: string[],
) {
  if (!value) return;
  const sql = value.toString("utf8");
  if (
    !sql.includes('CREATE TABLE "public"."_prisma_migrations"') ||
    !sql.includes('CREATE TABLE "chat"."chat_sessions"')
  ) {
    problems.push(`${label} does not contain the Main and Chat schema authorities`);
  }
}

function validateFileManifest(
  value: Buffer | undefined,
  label: string,
  problems: string[],
) {
  if (!value) return;
  const lines = value.toString("utf8").trimEnd().split(/\r?\n/u);
  const paths = new Set<string>();
  let hasRoot = false;
  for (const line of lines) {
    const match = /^(directory|file)\t([0-7]{3,4})\t(-|[a-f0-9]{64})\t(\.(?:\/[^\t\r\n]+)?)$/u.exec(line);
    if (!match) {
      problems.push(`${label} contains an invalid authority entry`);
      return;
    }
    const [, kind, , digest, entryPath] = match;
    if (
      paths.has(entryPath) ||
      entryPath.includes("/../") ||
      entryPath.endsWith("/..") ||
      (kind === "directory" ? digest !== "-" : !hasSha256(digest))
    ) {
      problems.push(`${label} contains an invalid authority entry`);
      return;
    }
    paths.add(entryPath);
    hasRoot ||= kind === "directory" && entryPath === ".";
  }
  if (!hasRoot) {
    problems.push(`${label} does not declare the authority root`);
  }
}

function validateLogicalManifest(
  value: Buffer | undefined,
  schema: Buffer | undefined,
  label: string,
  problems: string[],
) {
  if (!value || !schema) return;
  const manifest = parseJson<Record<string, unknown>>(value, label, problems);
  if (!manifest) return;
  const tables = manifest.tables;
  const sequences = manifest.sequences;
  const authority = manifest.authority;
  const validTables = Array.isArray(tables) && tables.length > 0 && tables.every(
    (entry) => isRecord(entry) &&
      typeof entry.schema === "string" && entry.schema.length > 0 &&
      typeof entry.table === "string" && entry.table.length > 0 &&
      isNonNegativeInteger(entry.row_count) &&
      hasSha256(entry.row_digest_sha256),
  );
  if (
    manifest.manifest_version !== 1 ||
    manifest.schema_definition_sha256 !== sha256(schema) ||
    !isRecord(authority) ||
    !Array.isArray(authority.required_roles) ||
    !validTables ||
    !Array.isArray(sequences)
  ) {
    problems.push(`${label} is not a complete logical restore manifest`);
  }
}

function validateRoleAuthority(
  value: Buffer | undefined,
  label: string,
  problems: string[],
) {
  if (!value) return;
  const authority = parseJson<Record<string, unknown>>(value, label, problems);
  if (!authority) return;
  const roles = authority.required_roles;
  const required = ["core_owner", "chat_owner", "chat_service", "chat_projector"];
  if (
    !Array.isArray(roles) ||
    !required.every((role) => roles.includes(role)) ||
    !Array.isArray(authority.roles_without_passwords) ||
    !Array.isArray(authority.memberships)
  ) {
    problems.push(`${label} is not a complete role authority manifest`);
  }
}

function validateDatabaseAuthority(
  value: Buffer | undefined,
  label: string,
  problems: string[],
) {
  if (!value) return;
  const authority = parseJson<Record<string, unknown>>(value, label, problems);
  const database = authority && isRecord(authority.database)
    ? authority.database
    : null;
  if (
    !database ||
    typeof database.owner !== "string" || database.owner.length === 0 ||
    database.encoding !== "UTF8"
  ) {
    problems.push(`${label} is not a complete database authority manifest`);
  }
}

function validateRemoteBlobInventory(
  value: Buffer | undefined,
  label: string,
  problems: string[],
) {
  if (!value) return;
  const inventory = parseJson<Record<string, unknown>>(value, label, problems);
  const objects = inventory?.objects;
  if (
    !inventory ||
    typeof inventory.bucket !== "string" || inventory.bucket.length === 0 ||
    !Array.isArray(objects) || objects.length === 0 ||
    !objects.every((entry) => isRecord(entry) &&
      typeof entry.key === "string" && entry.key.length > 0 &&
      typeof entry.versionId === "string" && entry.versionId.length > 0 &&
      typeof entry.etag === "string" && entry.etag.length > 0 &&
      isNonNegativeInteger(entry.size))
  ) {
    problems.push(`${label} is not a complete versioned Blob inventory`);
  }
}

// SPEC: launch accepts a recovery rehearsal only when one flat, checksummed
// bundle proves the same Main DB, Chat FS and Blob authority before and after
// an isolated restore, at the exact migration revision shipped by this build.
// INTENT: this is a read-only verifier. It never creates a backup, restores a
// database, copies objects, or treats the historical migration-60 bundle as
// current launch evidence.
export async function inspectRecoveryRehearsalBundle(input: {
  readonly bundlePath: string;
  readonly expectedMigrations: readonly ExpectedMigration[];
  readonly now: Date;
  readonly maxAgeMinutes: number;
}): Promise<RecoveryRehearsalAuthority> {
  const problems: string[] = [];
  const bundlePath = path.resolve(input.bundlePath);
  const bundleName = path.basename(bundlePath);
  const baseName = path.join(bundlePath, bundleName);
  const checksumPath = `${baseName}.sha256`;
  let checkedAt: string | null = null;
  let bundleDigest: string | null = null;
  let migrationCount: number | null = null;
  let latestMigration: string | null = null;

  try {
    const bundleStat = await lstat(bundlePath);
    if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) {
      problems.push("recovery bundle path is not a real directory");
      return {
        ok: false,
        checkedAt,
        bundleDigest,
        migrationCount,
        latestMigration,
        problems,
      };
    }

    const checksumStat = await lstat(checksumPath);
    if (!checksumStat.isFile() || checksumStat.isSymbolicLink()) {
      problems.push("bundle checksum manifest is not a regular file");
    }
    checkedAt = checksumStat.mtime.toISOString();
    const ageMs = input.now.getTime() - checksumStat.mtimeMs;
    const maxAgeMs = input.maxAgeMinutes * 60_000;
    if (ageMs > maxAgeMs) {
      problems.push(
        `recovery rehearsal is older than ${input.maxAgeMinutes} minutes`,
      );
    }
    if (ageMs < -60_000) {
      problems.push("recovery rehearsal timestamp is in the future");
    }

    const checksumBytes = await readFile(checksumPath);
    bundleDigest = sha256(checksumBytes);
    const manifest = new Map<string, string>();
    for (const line of checksumBytes.toString("utf8").split(/\r?\n/u)) {
      if (!line) continue;
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/u.exec(line);
      if (!match) {
        problems.push("bundle checksum manifest contains an invalid line");
        continue;
      }
      const [, digest, filename] = match;
      if (manifest.has(filename)) {
        problems.push(`duplicate checksum entry: ${filename}`);
      } else {
        manifest.set(filename, digest);
      }
    }

    const actualEntries = await readdir(bundlePath, { withFileTypes: true });
    const expectedEntries = new Set([...manifest.keys(), path.basename(checksumPath)]);
    for (const entry of actualEntries) {
      if (!expectedEntries.has(entry.name)) {
        problems.push(`unmanifested bundle entry: ${entry.name}`);
      }
      if (!entry.isFile()) {
        problems.push(`bundle entry is not a regular file: ${entry.name}`);
      }
    }
    for (const filename of expectedEntries) {
      if (!actualEntries.some((entry) => entry.name === filename)) {
        problems.push(`missing bundle entry: ${filename}`);
      }
    }

    const fileBytes = new Map<string, Buffer>();
    for (const [filename, expectedDigest] of manifest) {
      const filePath = path.join(bundlePath, filename);
      const stat = await lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        problems.push(`bundle entry is not a regular file: ${filename}`);
        continue;
      }
      const bytes = await readFile(filePath);
      fileBytes.set(filename, bytes);
      if (sha256(bytes) !== expectedDigest) {
        problems.push(`checksum mismatch: ${filename}`);
      }
    }

    const filenameForSuffix = (suffix: string) =>
      suffix === "pg16.sql"
        ? `${bundleName}-pg16.sql`
        : `${bundleName}.${suffix}`;
    for (const suffix of requiredSuffixes) {
      const filename = filenameForSuffix(suffix);
      if (!manifest.has(filename)) {
        problems.push(`bundle manifest is missing required artifact: ${filename}`);
      }
    }
    const pg16Filename = filenameForSuffix("pg16.sql");
    if (!manifest.has(pg16Filename)) {
      problems.push(`bundle manifest is missing required artifact: ${pg16Filename}`);
    }
    const localBlobArchive = filenameForSuffix("blob.tar.gz");
    const remoteBlobInventory = filenameForSuffix("blob-object-versions.json");
    if (!manifest.has(localBlobArchive) && !manifest.has(remoteBlobInventory)) {
      problems.push(
        "bundle manifest has neither a local Blob archive nor a remote object-version inventory",
      );
    }

    const artifact = (suffix: string) => fileBytes.get(filenameForSuffix(suffix));
    validatePostgresDump(artifact("dump"), filenameForSuffix("dump"), problems);
    validateSchema(
      artifact("source-schema.sql"),
      filenameForSuffix("source-schema.sql"),
      problems,
    );
    validateSchema(
      artifact("restore-schema.sql"),
      filenameForSuffix("restore-schema.sql"),
      problems,
    );
    validateLogicalManifest(
      artifact("source-logical.json"),
      artifact("source-schema.sql"),
      filenameForSuffix("source-logical.json"),
      problems,
    );
    validateLogicalManifest(
      artifact("restore-logical.json"),
      artifact("restore-schema.sql"),
      filenameForSuffix("restore-logical.json"),
      problems,
    );
    validateRoleAuthority(
      artifact("roles.json"),
      filenameForSuffix("roles.json"),
      problems,
    );
    validateDatabaseAuthority(
      artifact("database-authority.json"),
      filenameForSuffix("database-authority.json"),
      problems,
    );
    validateGzipArchive(
      artifact("chat-fs.tar.gz"),
      filenameForSuffix("chat-fs.tar.gz"),
      problems,
    );
    if (manifest.has(localBlobArchive)) {
      validateGzipArchive(
        artifact("blob.tar.gz"),
        filenameForSuffix("blob.tar.gz"),
        problems,
      );
    } else {
      validateRemoteBlobInventory(
        artifact("blob-object-versions.json"),
        filenameForSuffix("blob-object-versions.json"),
        problems,
      );
    }
    for (const suffix of [
      "chat-fs.source.sha256",
      "chat-fs.restore.sha256",
      "blob.source.sha256",
      "blob.restore.sha256",
    ]) {
      validateFileManifest(artifact(suffix), filenameForSuffix(suffix), problems);
    }

    for (const [sourceSuffix, restoreSuffix] of pairedAuthoritySuffixes) {
      const sourceName = filenameForSuffix(sourceSuffix);
      const restoreName = filenameForSuffix(restoreSuffix);
      const source = fileBytes.get(sourceName);
      const restored = fileBytes.get(restoreName);
      if (source && restored && !source.equals(restored)) {
        problems.push(
          `isolated restore differs from source authority: ${sourceSuffix}`,
        );
      }
    }

    const countsName = filenameForSuffix("source-counts.json");
    const countsBytes = fileBytes.get(countsName);
    if (countsBytes) {
      const counts = parseJson<RecoveryCounts>(countsBytes, countsName, problems);
      if (counts) {
        migrationCount =
          typeof counts.migrations === "number" ? counts.migrations : null;
        latestMigration =
          typeof counts.latest_migration === "string"
            ? counts.latest_migration
            : null;
        const expectedLatest =
          input.expectedMigrations.at(-1)?.migrationName ?? null;
        if (
          migrationCount !== input.expectedMigrations.length ||
          latestMigration !== expectedLatest
        ) {
          problems.push(
            `checkpoint migration authority is ${migrationCount ?? "unknown"}/${input.expectedMigrations.length} with latest ${latestMigration ?? "unknown"}, expected ${expectedLatest ?? "none"}`,
          );
        }
        for (const key of quiescentCountKeys) {
          if (counts[key] !== 0) {
            problems.push(`checkpoint is not quiescent: ${key}=${String(counts[key])}`);
          }
        }
      }
    }

    const versionsName = filenameForSuffix("tool-versions.json");
    const versionsBytes = fileBytes.get(versionsName);
    if (versionsBytes) {
      const versions = parseJson<{ server_version_num?: unknown }>(
        versionsBytes,
        versionsName,
        problems,
      );
      const serverVersion = Number.parseInt(
        typeof versions?.server_version_num === "string"
          ? versions.server_version_num
          : "",
        10,
      );
      if (!Number.isFinite(serverVersion) || Math.floor(serverVersion / 10_000) !== 16) {
        problems.push("restore rehearsal did not use PostgreSQL 16");
      }
    }

    const authoritiesName = filenameForSuffix("file-authorities.json");
    const authoritiesBytes = fileBytes.get(authoritiesName);
    if (authoritiesBytes) {
      const authorities = parseJson<{
        blob?: { authorities_match?: unknown };
      }>(authoritiesBytes, authoritiesName, problems);
      if (authorities?.blob?.authorities_match !== true) {
        problems.push("Main and Gen Blob authorities do not match");
      }
    }
  } catch (error) {
    problems.push(
      `recovery bundle inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    ok: problems.length === 0,
    checkedAt,
    bundleDigest,
    migrationCount,
    latestMigration,
    problems,
  };
}
