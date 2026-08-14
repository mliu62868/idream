import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GENERATION_CUTOVER_QUEUES } from "@idream/shared/contracts";
import type { ExpectedMigration } from "./migration-authority";
import {
  renderRecoveryDatabaseAuthoritySql,
  type RecoveryDatabaseAuthority,
} from "./recovery-database-authority";
import { buildFileAuthorityManifest } from "./recovery-rehearsal-producer";

export type RecoveryArchiveCommandRunner = {
  run(input: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly stage: string;
  }): { stdout: Buffer; stderr: Buffer; status: number };
};

class SystemRecoveryArchiveCommandRunner implements RecoveryArchiveCommandRunner {
  run(input: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly stage: string;
  }) {
    const result = spawnSync(input.command, [...(input.args ?? [])], {
      encoding: null,
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `${input.stage} failed${result.status === null ? " to start" : ` with exit code ${result.status}`}`,
      );
    }
    return {
      stdout: Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.from(result.stdout ?? ""),
      stderr: Buffer.isBuffer(result.stderr)
        ? result.stderr
        : Buffer.from(result.stderr ?? ""),
      status: result.status,
    };
  }
}

type RecoveryCounts = {
  readonly migrations?: unknown;
  readonly latest_migration?: unknown;
  readonly main_outbox_pending?: unknown;
  readonly main_outbox_failed?: unknown;
  readonly main_outbox_transport_pending?: unknown;
  readonly main_outbox_transport_failed?: unknown;
  readonly main_outbox_dispatched?: unknown;
  readonly main_outbox_transport_unknown?: unknown;
  readonly inbound_event_received?: unknown;
  readonly inbound_event_processing?: unknown;
  readonly chat_outbox_pending?: unknown;
  readonly chat_outbox_failed?: unknown;
  readonly chat_inbox_pending?: unknown;
  readonly chat_inbox_failed?: unknown;
  readonly chat_inbox_processing?: unknown;
  readonly chat_file_mutations_pending?: unknown;
};

export type RecoveryRehearsalAuthority = {
  readonly ok: boolean;
  readonly checkedAt: string | null;
  readonly bundleDigest: string | null;
  readonly sourceCheckpointSha256: string | null;
  readonly sourceAuthority: RecoveryRehearsalSourceAuthority | null;
  readonly migrationCount: number | null;
  readonly latestMigration: string | null;
  readonly problems: readonly string[];
};

export type RecoveryRehearsalSourceAuthority = {
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
  };
  readonly chatFsRoot: string;
  readonly queue: {
    readonly redis: string;
    readonly prefix: string;
  };
  readonly blob: {
    readonly provider: "mock" | "r2" | "s3";
    readonly endpoint: string | null;
    readonly bucket: string | null;
    readonly root: string | null;
    readonly recoveryRetentionDays: number | null;
  };
};

type RecoveryRehearsalMetadata = {
  readonly schemaVersion: 1;
  readonly completedAt: string;
  readonly sourceCheckpointSha256: string;
  readonly sourceAuthority: RecoveryRehearsalSourceAuthority;
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
  "quiescence-receipt.json",
  "metadata.json",
  "proof.sh",
  "RESTORE.md",
] as const;

const inFlightMutationCountKeys = [
  "main_outbox_dispatched",
  "main_outbox_transport_unknown",
  "inbound_event_processing",
  "chat_inbox_processing",
] as const;

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

export function computeRecoverySourceCheckpointSha256(
  entries: readonly { readonly filename: string; readonly bytes: Buffer }[],
) {
  const names = new Set<string>();
  const canonical = entries.map(({ filename, bytes }) => {
    if (!filename || names.has(filename)) {
      throw new Error("recovery source checkpoint contains a duplicate filename");
    }
    names.add(filename);
    return { filename, digest: sha256(bytes) };
  }).sort((left, right) =>
    left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0
  );
  return sha256(canonical.map(({ filename, digest }) =>
    `${filename}\0${digest}\n`
  ).join(""));
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
  filePath: string,
  label: string,
  problems: string[],
  runner: RecoveryArchiveCommandRunner,
) {
  if (!value) return;
  if (value.subarray(0, 5).toString("ascii") !== "PGDMP") {
    problems.push(`${label} is not a PostgreSQL custom-format dump`);
    return;
  }
  try {
    const listing = runner.run({
      command: "pg_restore",
      args: ["--list", filePath],
      stage: "recovery_bundle_pg_restore_list",
    }).stdout.toString("utf8");
    const tocEntries = /;\s+TOC Entries:\s+([0-9]+)/u.exec(listing)?.[1];
    if (
      !listing.includes("; Archive created at ") ||
      !tocEntries ||
      Number.parseInt(tocEntries, 10) < 1
    ) {
      problems.push(`${label} pg_restore --list did not return a real archive catalog`);
    }
  } catch {
    problems.push(`${label} failed real pg_restore --list validation`);
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

async function validateArchiveReconstruction(input: {
  readonly archivePath: string;
  readonly archiveLabel: string;
  readonly expectedRoot: string;
  readonly expectedManifest: Buffer | undefined;
  readonly problems: string[];
  readonly runner: RecoveryArchiveCommandRunner;
}) {
  if (!input.expectedManifest) return;
  let scratch: string | null = null;
  try {
    const listing = input.runner.run({
      command: "tar",
      args: ["-tzf", input.archivePath],
      stage: `recovery_bundle_${input.archiveLabel}_list`,
    }).stdout.toString("utf8");
    const entries = listing.split(/\r?\n/u).filter(Boolean);
    if (entries.length === 0) throw new Error("empty archive");
    for (const entry of entries) {
      const normalized = entry.replace(/\/$/u, "");
      if (
        path.posix.isAbsolute(normalized) ||
        normalized.split("/").includes("..") ||
        normalized.split("/")[0] !== input.expectedRoot
      ) {
        throw new Error("unsafe or split archive root");
      }
    }
    scratch = await mkdtemp(path.join(tmpdir(), "idream-recovery-inspect-"));
    input.runner.run({
      command: "tar",
      args: ["-xzf", input.archivePath, "-C", scratch],
      stage: `recovery_bundle_${input.archiveLabel}_extract`,
    });
    const topLevel = await readdir(scratch, { withFileTypes: true });
    if (
      topLevel.length !== 1 ||
      topLevel[0]?.name !== input.expectedRoot ||
      !topLevel[0].isDirectory()
    ) {
      throw new Error("archive did not reconstruct one exact authority root");
    }
    const reconstructed = await buildFileAuthorityManifest(
      path.join(scratch, input.expectedRoot),
    );
    if (reconstructed !== input.expectedManifest.toString("utf8")) {
      throw new Error("archive manifest differs");
    }
  } catch {
    input.problems.push(
      `${input.archiveLabel} does not reconstruct its source authority manifest`,
    );
  } finally {
    if (scratch) await rm(scratch, { force: true, recursive: true });
  }
}

function validateDatabaseAuthorityRestore(
  value: Buffer | undefined,
  authority: RecoveryDatabaseAuthority | null,
  problems: string[],
) {
  if (!value || !authority) return;
  let expected: string;
  try {
    expected = renderRecoveryDatabaseAuthoritySql(authority);
  } catch {
    problems.push("database authority restore script is not executable authority");
    return;
  }
  if (value.toString("utf8") !== expected) {
    problems.push("database authority restore script differs from canonical authority");
  }
}

function validateQuiescenceReceipt(
  value: Buffer | undefined,
  now: Date,
  maxAgeMinutes: number,
  problems: string[],
  expectedQueueAuthority: RecoveryRehearsalSourceAuthority["queue"] | null,
) {
  if (!value) return;
  const receipt = parseJson<Record<string, unknown>>(
    value,
    "quiescence receipt",
    problems,
  );
  if (!receipt) return;
  const runtime = isRecord(receipt.runtime) ? receipt.runtime : null;
  const generation = isRecord(receipt.generation) ? receipt.generation : null;
  const queueAuthority = isRecord(receipt.queueAuthority)
    ? receipt.queueAuthority
    : null;
  const processes = runtime?.processes;
  const ports = runtime?.ports;
  const pauseAndDrain = generation && isRecord(generation.pauseAndDrain)
    ? generation.pauseAndDrain
    : null;
  const cutover = generation && isRecord(generation.cutover)
    ? generation.cutover
    : null;
  const ownership = generation && isRecord(generation.ownership)
    ? generation.ownership
    : null;
  const expected = ownership && isRecord(ownership.expected)
    ? ownership.expected
    : null;
  const facts = runtime && generation && queueAuthority
    ? { runtime, generation, queueAuthority }
    : null;
  const checkedAt = typeof receipt.checkedAt === "string"
    ? Date.parse(receipt.checkedAt)
    : Number.NaN;
  const fresh = Number.isFinite(checkedAt) &&
    checkedAt <= now.getTime() + 60_000 &&
    now.getTime() - checkedAt <= maxAgeMinutes * 60_000;
  const queues = pauseAndDrain?.queues;
  const exactQueueNames = Array.isArray(queues)
    ? queues.flatMap((entry) =>
        isRecord(entry) && typeof entry.queue === "string" ? [entry.queue] : []
      )
    : [];
  if (
    receipt.schemaVersion !== 1 ||
    !fresh ||
    !facts ||
    receipt.fingerprint !== sha256(JSON.stringify(facts)) ||
    queueAuthority?.redis !== expectedQueueAuthority?.redis ||
    queueAuthority?.prefix !== expectedQueueAuthority?.prefix ||
    !Array.isArray(processes) ||
    !processes.every((entry) =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      (entry.status === "stopped" || entry.status === "errored")
    ) ||
    !Array.isArray(ports) ||
    ![3000, 3001, 3100].every((port) =>
      ports.some((entry) =>
        isRecord(entry) && entry.port === port && entry.listener === false
      )
    ) ||
    pauseAndDrain?.ok !== true ||
    !Array.isArray(queues) ||
    queues.length !== GENERATION_CUTOVER_QUEUES.length ||
    !queues.every((entry) => isRecord(entry) && entry.paused === true) ||
    new Set(exactQueueNames).size !== GENERATION_CUTOVER_QUEUES.length ||
    !GENERATION_CUTOVER_QUEUES.every((queue) => exactQueueNames.includes(queue)) ||
    !Array.isArray(pauseAndDrain.activeBullRows) ||
    pauseAndDrain.activeBullRows.length !== 0 ||
    pauseAndDrain.pendingTerminalOutboxes !== 0 ||
    cutover?.ok !== true ||
    cutover.activeRequests !== 0 ||
    cutover.inFlightBullRows !== 0 ||
    cutover.pendingTerminalOutboxes !== 0 ||
    ownership?.ok !== true ||
    ownership.mode !== "quiescent" ||
    expected?.image !== 0 ||
    expected.video !== 0
  ) {
    problems.push(
      "quiescence receipt does not prove fresh Generation queue, cutover, worker, PM2, and port authority",
    );
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
): RecoveryDatabaseAuthority | null {
  if (!value) return null;
  const authority = parseJson<Record<string, unknown>>(value, label, problems);
  const database = authority && isRecord(authority.database)
    ? authority.database
    : null;
  const acl = database?.acl;
  const settings = authority?.database_role_settings;
  if (
    !database ||
    typeof database.owner !== "string" || database.owner.length === 0 ||
    database.encoding !== "UTF8" ||
    typeof database.locale_provider !== "string" ||
    typeof database.collate !== "string" ||
    typeof database.ctype !== "string" ||
    !(database.icu_locale === null || typeof database.icu_locale === "string") ||
    !(database.icu_rules === null || typeof database.icu_rules === "string") ||
    typeof database.tablespace !== "string" ||
    !Number.isInteger(database.connection_limit) ||
    !(database.comment === null || typeof database.comment === "string") ||
    typeof database.acl_is_null !== "boolean" ||
    !Array.isArray(acl) ||
    !acl.every((entry) =>
      isRecord(entry) &&
      typeof entry.grantor === "string" &&
      typeof entry.grantor_is_superuser === "boolean" &&
      typeof entry.grantee === "string" &&
      typeof entry.privilege === "string" &&
      typeof entry.grantable === "boolean"
    ) ||
    !Array.isArray(settings) ||
    !settings.every((entry) =>
      isRecord(entry) &&
      (entry.role === null || typeof entry.role === "string") &&
      Array.isArray(entry.settings) &&
      entry.settings.every((setting) => typeof setting === "string")
    )
  ) {
    problems.push(`${label} is not a complete database authority manifest`);
    return null;
  }
  return authority as unknown as RecoveryDatabaseAuthority;
}

function validateRemoteBlobInventory(
  value: Buffer | undefined,
  label: string,
  expectedSource: RecoveryRehearsalSourceAuthority["blob"] | null,
  bundleName: string,
  problems: string[],
  now: Date,
) {
  if (!value) return;
  const inventory = parseJson<Record<string, unknown>>(value, label, problems);
  const objects = inventory?.objects;
  const recoveryAuthority = inventory && isRecord(inventory.recoveryAuthority)
    ? inventory.recoveryAuthority
    : null;
  const sourceEndpoint = normalizedHttpsEndpoint(inventory?.endpoint);
  const recoveryEndpoint = normalizedHttpsEndpoint(recoveryAuthority?.endpoint);
  const sourceKeys = new Set<string>();
  const recoveryKeys = new Set<string>();
  const validMetadata = (value: unknown) => {
    if (!isRecord(value) || !isRecord(value.metadata)) return false;
    const retention = value.objectLockRetainUntilDate;
    return (value.contentType === null || typeof value.contentType === "string") &&
      (value.cacheControl === null || typeof value.cacheControl === "string") &&
      Object.values(value.metadata).every((entry) => typeof entry === "string") &&
      (value.objectLockMode === null ||
        value.objectLockMode === "GOVERNANCE" ||
        value.objectLockMode === "COMPLIANCE") &&
      (retention === null ||
        (typeof retention === "string" &&
          Number.isFinite(Date.parse(retention)))) &&
      (value.objectLockLegalHoldStatus === null ||
        value.objectLockLegalHoldStatus === "ON" ||
        value.objectLockLegalHoldStatus === "OFF");
  };
  const validObjects = Array.isArray(objects) && objects.length > 0 &&
    objects.every((entry) => {
      if (!isRecord(entry) || !isRecord(entry.recovery)) return false;
      const sourceKey = entry.key;
      const recoveryKey = entry.recovery.key;
      if (
        typeof sourceKey !== "string" || sourceKey.length === 0 ||
        typeof recoveryKey !== "string" ||
        recoveryKey !== `.idream-recovery/${bundleName}/${sourceKey}` ||
        sourceKeys.has(sourceKey) || recoveryKeys.has(recoveryKey)
      ) return false;
      sourceKeys.add(sourceKey);
      recoveryKeys.add(recoveryKey);
      return typeof entry.versionId === "string" && entry.versionId.length > 0 &&
        typeof entry.etag === "string" && entry.etag.length > 0 &&
        Number.isSafeInteger(entry.size) && (entry.size as number) >= 0 &&
        hasSha256(entry.sha256) &&
        validMetadata(entry.metadata) &&
        entry.recovery.endpoint === recoveryEndpoint &&
        entry.recovery.bucket === recoveryAuthority?.bucket &&
        typeof entry.recovery.versionId === "string" &&
        entry.recovery.versionId.length > 0 &&
        typeof entry.recovery.checksumSha256 === "string" &&
        /^[A-Za-z0-9+/]{43}=$/u.test(entry.recovery.checksumSha256) &&
        Buffer.from(entry.sha256 as string, "hex").toString("base64") ===
          entry.recovery.checksumSha256 &&
        (entry.recovery.objectLockMode === "GOVERNANCE" ||
          entry.recovery.objectLockMode === "COMPLIANCE") &&
        typeof entry.recovery.objectLockRetainUntilDate === "string" &&
        Number.isFinite(Date.parse(entry.recovery.objectLockRetainUntilDate)) &&
        Date.parse(entry.recovery.objectLockRetainUntilDate) >=
          now.getTime() +
            Math.max(0, (expectedSource?.recoveryRetentionDays ?? 0) - 1) *
              86_400_000;
    });
  if (
    !inventory ||
    (inventory.provider !== "r2" && inventory.provider !== "s3") ||
    !sourceEndpoint ||
    typeof inventory.bucket !== "string" || inventory.bucket.length === 0 ||
    !expectedSource ||
    inventory.provider !== expectedSource.provider ||
    sourceEndpoint !== expectedSource.endpoint ||
    inventory.bucket !== expectedSource.bucket ||
    !recoveryAuthority ||
    !recoveryEndpoint ||
    recoveryEndpoint === sourceEndpoint ||
    typeof recoveryAuthority.bucket !== "string" ||
    recoveryAuthority.bucket.length === 0 ||
    recoveryAuthority.bucket === inventory.bucket ||
    recoveryAuthority.retentionDays !== expectedSource.recoveryRetentionDays ||
    !validObjects
  ) {
    problems.push(`${label} is not a complete versioned Blob inventory`);
  }
}

function normalizedHttpsEndpoint(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
      return null;
    }
    return endpoint.toString();
  } catch {
    return null;
  }
}

function normalizedRedisAuthority(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!new Set(["redis:", "rediss:"]).has(url.protocol)) return null;
    if (url.username || url.password || !url.hostname || url.search || url.hash) {
      return null;
    }
    const database = url.pathname.replace(/^\//u, "") || "0";
    if (!/^(?:0|[1-9][0-9]*)$/u.test(database)) return null;
    const port = Number.parseInt(url.port || "6379", 10);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
    return `${url.protocol}//${url.hostname.toLowerCase()}:${port}/${database}`;
  } catch {
    return null;
  }
}

function validateRecoveryMetadata(
  value: Buffer | undefined,
  label: string,
  problems: string[],
): RecoveryRehearsalMetadata | null {
  if (!value) return null;
  const metadata = parseJson<Record<string, unknown>>(value, label, problems);
  if (!metadata) return null;
  const sourceAuthority = isRecord(metadata.sourceAuthority)
    ? metadata.sourceAuthority
    : null;
  const database = sourceAuthority && isRecord(sourceAuthority.database)
    ? sourceAuthority.database
    : null;
  const blob = sourceAuthority && isRecord(sourceAuthority.blob)
    ? sourceAuthority.blob
    : null;
  const completedAt = typeof metadata.completedAt === "string"
    ? metadata.completedAt
    : null;
  const completedAtMs = completedAt === null ? Number.NaN : Date.parse(completedAt);
  const validCompletedAt = completedAt !== null &&
    Number.isFinite(completedAtMs) &&
    new Date(completedAtMs).toISOString() === completedAt;
  const chatFsRoot = sourceAuthority?.chatFsRoot;
  const queue = sourceAuthority && isRecord(sourceAuthority.queue)
    ? sourceAuthority.queue
    : null;
  const provider = blob?.provider;
  const endpoint = blob?.endpoint;
  const bucket = blob?.bucket;
  const root = blob?.root;
  const recoveryRetentionDays = blob?.recoveryRetentionDays;
  const validBlob = (provider === "mock" &&
      endpoint === null &&
      bucket === null &&
      typeof root === "string" &&
      recoveryRetentionDays === null &&
      path.isAbsolute(root) &&
      path.normalize(root) === root) ||
    ((provider === "r2" || provider === "s3") &&
      normalizedHttpsEndpoint(endpoint) === endpoint &&
      typeof bucket === "string" && bucket.length > 0 &&
      Number.isSafeInteger(recoveryRetentionDays) &&
      (recoveryRetentionDays as number) > 0 &&
      root === null);
  if (
    metadata.schemaVersion !== 1 ||
    !validCompletedAt ||
    !hasSha256(metadata.sourceCheckpointSha256) ||
    !database ||
    typeof database.host !== "string" || database.host.length === 0 ||
    !Number.isInteger(database.port) ||
    (database.port as number) < 1 ||
    (database.port as number) > 65_535 ||
    typeof database.database !== "string" || database.database.length === 0 ||
    typeof chatFsRoot !== "string" ||
    !path.isAbsolute(chatFsRoot) ||
    path.normalize(chatFsRoot) !== chatFsRoot ||
    !queue ||
    normalizedRedisAuthority(queue.redis) !== queue.redis ||
    typeof queue.prefix !== "string" || queue.prefix.length === 0 ||
    !validBlob
  ) {
    problems.push(`${label} is not complete immutable recovery metadata`);
    return null;
  }
  return metadata as unknown as RecoveryRehearsalMetadata;
}

function compareSourceAuthority(
  actual: RecoveryRehearsalSourceAuthority,
  expected: RecoveryRehearsalSourceAuthority,
  problems: string[],
) {
  if (
    actual.database.host.toLowerCase() !== expected.database.host.toLowerCase() ||
    actual.database.port !== expected.database.port ||
    actual.database.database !== expected.database.database
  ) {
    problems.push("recovery source database does not match current authority");
  }
  if (actual.chatFsRoot !== expected.chatFsRoot) {
    problems.push("recovery Chat FS root does not match current authority");
  }
  if (
    actual.queue.redis !== expected.queue.redis ||
    actual.queue.prefix !== expected.queue.prefix
  ) {
    problems.push("recovery queue authority does not match current Main/Gen authority");
  }
  if (
    actual.blob.provider !== expected.blob.provider ||
    actual.blob.endpoint !== expected.blob.endpoint ||
    actual.blob.bucket !== expected.blob.bucket ||
    actual.blob.root !== expected.blob.root
    || actual.blob.recoveryRetentionDays !== expected.blob.recoveryRetentionDays
  ) {
    problems.push("recovery Blob target does not match current authority");
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
  readonly expectedSourceAuthority?: RecoveryRehearsalSourceAuthority;
  readonly approvedBundleDigest?: string | null;
  readonly commandRunner?: RecoveryArchiveCommandRunner;
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
  let sourceCheckpointSha256: string | null = null;
  let sourceAuthority: RecoveryRehearsalSourceAuthority | null = null;
  let migrationCount: number | null = null;
  let latestMigration: string | null = null;
  const commandRunner = input.commandRunner ??
    new SystemRecoveryArchiveCommandRunner();

  try {
    const bundleStat = await lstat(bundlePath);
    if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) {
      problems.push("recovery bundle path is not a real directory");
      return {
        ok: false,
        checkedAt,
        bundleDigest,
        sourceCheckpointSha256,
        sourceAuthority,
        migrationCount,
        latestMigration,
        problems,
      };
    }

    const checksumHandle = await open(
      checksumPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let checksumBytes: Buffer;
    try {
      const checksumStat = await checksumHandle.stat();
      if (!checksumStat.isFile() || checksumStat.size > 4 * 1024 * 1024) {
        throw new Error("bundle checksum manifest is not a bounded regular file");
      }
      checksumBytes = await checksumHandle.readFile();
    } finally {
      await checksumHandle.close();
    }
    bundleDigest = sha256(checksumBytes);
    if (
      input.approvedBundleDigest !== undefined &&
      input.approvedBundleDigest !== bundleDigest
    ) {
      problems.push(
        "bundle manifest digest does not match RECOVERY_REHEARSAL_APPROVED_SHA256",
      );
    }
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
    const metadata = validateRecoveryMetadata(
      artifact("metadata.json"),
      filenameForSuffix("metadata.json"),
      problems,
    );
    if (metadata) {
      checkedAt = metadata.completedAt;
      sourceCheckpointSha256 = metadata.sourceCheckpointSha256;
      sourceAuthority = metadata.sourceAuthority;
      const ageMs = input.now.getTime() - Date.parse(metadata.completedAt);
      const maxAgeMs = input.maxAgeMinutes * 60_000;
      if (ageMs > maxAgeMs) {
        problems.push(
          `recovery rehearsal is older than ${input.maxAgeMinutes} minutes`,
        );
      }
      if (ageMs < -60_000) {
        problems.push("recovery rehearsal timestamp is in the future");
      }
      if (input.expectedSourceAuthority) {
        compareSourceAuthority(
          metadata.sourceAuthority,
          input.expectedSourceAuthority,
          problems,
        );
      }
      const hasLocalBlobArchive = manifest.has(localBlobArchive);
      const hasRemoteBlobInventory = manifest.has(remoteBlobInventory);
      if (metadata.sourceAuthority.blob.provider === "mock") {
        if (!hasLocalBlobArchive || hasRemoteBlobInventory) {
          problems.push(
            "local Blob recovery metadata requires exactly one local archive and no versioned object inventory",
          );
        }
      } else if (hasLocalBlobArchive || !hasRemoteBlobInventory) {
        problems.push(
          "remote Blob recovery metadata requires exactly one versioned object inventory and no local archive",
        );
      }
      const checkpointFilenames = [
        filenameForSuffix("quiescence-receipt.json"),
        filenameForSuffix("source-counts.json"),
        filenameForSuffix("source-schema.sql"),
        filenameForSuffix("source-logical.json"),
        filenameForSuffix("chat-fs.source.sha256"),
        filenameForSuffix("blob.source.sha256"),
        ...(metadata.sourceAuthority.blob.provider === "mock"
          ? []
          : [remoteBlobInventory]),
      ];
      const checkpointEntries = checkpointFilenames.flatMap((filename) => {
        const bytes = fileBytes.get(filename);
        return bytes ? [{ filename, bytes }] : [];
      });
      if (
        checkpointEntries.length === checkpointFilenames.length &&
        computeRecoverySourceCheckpointSha256(checkpointEntries) !==
          metadata.sourceCheckpointSha256
      ) {
        problems.push(
          "source checkpoint identity does not match checksummed recovery artifacts",
        );
      }
    }
    validatePostgresDump(
      artifact("dump"),
      path.join(bundlePath, filenameForSuffix("dump")),
      filenameForSuffix("dump"),
      problems,
      commandRunner,
    );
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
    const databaseAuthority = validateDatabaseAuthority(
      artifact("database-authority.json"),
      filenameForSuffix("database-authority.json"),
      problems,
    );
    validateDatabaseAuthorityRestore(
      artifact("database-authority.restore.sql"),
      databaseAuthority,
      problems,
    );
    validateQuiescenceReceipt(
      artifact("quiescence-receipt.json"),
      input.now,
      input.maxAgeMinutes,
      problems,
      metadata?.sourceAuthority.queue ?? null,
    );
    validateGzipArchive(
      artifact("chat-fs.tar.gz"),
      filenameForSuffix("chat-fs.tar.gz"),
      problems,
    );
    if (metadata?.sourceAuthority.blob.provider === "mock") {
      validateGzipArchive(
        artifact("blob.tar.gz"),
        filenameForSuffix("blob.tar.gz"),
        problems,
      );
    } else if (metadata) {
      validateRemoteBlobInventory(
        artifact("blob-object-versions.json"),
        filenameForSuffix("blob-object-versions.json"),
        metadata.sourceAuthority.blob,
        bundleName,
        problems,
        input.now,
      );
    } else if (manifest.has(localBlobArchive)) {
      validateGzipArchive(
        artifact("blob.tar.gz"),
        filenameForSuffix("blob.tar.gz"),
        problems,
      );
    } else {
      validateRemoteBlobInventory(
        artifact("blob-object-versions.json"),
        filenameForSuffix("blob-object-versions.json"),
        null,
        bundleName,
        problems,
        input.now,
      );
    }
    if (metadata) {
      await validateArchiveReconstruction({
        archivePath: path.join(bundlePath, filenameForSuffix("chat-fs.tar.gz")),
        archiveLabel: "Chat FS archive",
        expectedRoot: path.basename(metadata.sourceAuthority.chatFsRoot),
        expectedManifest: artifact("chat-fs.source.sha256"),
        problems,
        runner: commandRunner,
      });
      if (metadata.sourceAuthority.blob.provider === "mock") {
        await validateArchiveReconstruction({
          archivePath: path.join(bundlePath, filenameForSuffix("blob.tar.gz")),
          archiveLabel: "local Blob archive",
          expectedRoot: path.basename(metadata.sourceAuthority.blob.root!),
          expectedManifest: artifact("blob.source.sha256"),
          problems,
          runner: commandRunner,
        });
      }
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
        for (const key of inFlightMutationCountKeys) {
          if (counts[key] !== 0) {
            problems.push(
              `checkpoint has in-flight mutation: ${key}=${String(counts[key])}`,
            );
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
    sourceCheckpointSha256,
    sourceAuthority,
    migrationCount,
    latestMigration,
    problems,
  };
}
