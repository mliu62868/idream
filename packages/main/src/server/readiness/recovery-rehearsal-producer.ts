import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { resolveChatFsRoot } from "@idream/shared";
import type { RecoveryRehearsalSourceAuthority } from "./recovery-rehearsal-authority";

export type RecoveryRehearsalCliOptions = {
  readonly apply: boolean;
  readonly bundleName: string | null;
  readonly bundleParent: string;
  readonly chatEnvFile: string | null;
  readonly confirmation: string | null;
  readonly genEnvFile: string | null;
  readonly help: boolean;
  readonly launchEnvFile: string | null;
};

export type RecoveryRehearsalPlan = {
  readonly schemaVersion: 1;
  readonly mode: "dry_run" | "apply";
  readonly bundleName: string;
  readonly bundlePath: string;
  readonly confirmation: string;
  readonly safeToApply: boolean;
  readonly blockers: readonly string[];
  readonly database: {
    readonly host: string | null;
    readonly port: number | null;
    readonly database: string | null;
    readonly user: string | null;
  };
  readonly recoveryDatabase: {
    readonly host: string | null;
    readonly port: number | null;
    readonly database: string | null;
    readonly user: string | null;
  };
  readonly chatFsRoot: string | null;
  readonly queueAuthority: {
    readonly redis: string | null;
    readonly prefix: string | null;
  };
  readonly blob: {
    readonly provider: string | null;
    readonly endpoint: string | null;
    readonly bucket: string | null;
    readonly region: string | null;
    readonly root: string | null;
    readonly recovery: {
      readonly endpoint: string | null;
      readonly bucket: string | null;
      readonly region: string | null;
      readonly retentionDays: number | null;
    };
  };
  readonly migrationAuthority: {
    readonly count: number;
    readonly latest: string | null;
  };
};

type RecoveryCounts = Record<string, unknown>;
export type RecoveryEnvironment = Readonly<Record<string, string | undefined>>;
export type RecoveryPostgresConnection = {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
};

export const RECOVERY_AMBIENT_LIBPQ_TARGET_VARIABLES = [
  "PGHOSTADDR",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGDATABASE",
  "PGUSER",
  "PGOPTIONS",
] as const;

const forbiddenPostgresUrlOverrides = new Set([
  "database",
  "dbname",
  "host",
  "hostaddr",
  "passfile",
  "password",
  "port",
  "service",
  "user",
  "username",
]);

const safeBundleName = /^idream-recovery-[A-Za-z0-9._-]+$/u;
const inFlightMutationCountKeys = [
  "main_outbox_dispatched",
  "main_outbox_transport_unknown",
  "inbound_event_processing",
  "chat_inbox_processing",
] as const;

function nextValue(args: readonly string[], index: number, flag: string) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseRecoveryRehearsalCliArgs(
  args: readonly string[],
): RecoveryRehearsalCliOptions {
  let apply = false;
  let bundleName: string | null = null;
  let bundleParent = "local-backups";
  let chatEnvFile: string | null = null;
  let confirmation: string | null = null;
  let genEnvFile: string | null = null;
  let help = false;
  let launchEnvFile: string | null = null;

  const values = new Map<string, (value: string) => void>([
    ["--bundle-name", (value) => { bundleName = value; }],
    ["--bundle-parent", (value) => { bundleParent = value; }],
    ["--launch-env-file", (value) => { launchEnvFile = value; }],
    ["--chat-env-file", (value) => { chatEnvFile = value; }],
    ["--gen-env-file", (value) => { genEnvFile = value; }],
    ["--confirmation", (value) => { confirmation = value; }],
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      if (apply) throw new Error("Duplicate argument: --apply");
      apply = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    const setter = values.get(arg);
    if (!setter) throw new Error(`Unknown option: ${arg}`);
    const value = nextValue(args, index, arg);
    setter(value);
    index += 1;
  }

  if (bundleName !== null && !safeBundleName.test(bundleName)) {
    throw new Error("--bundle-name must be a safe bundle name beginning idream-recovery-");
  }
  if (!apply && confirmation !== null) {
    throw new Error("--confirmation is only valid with --apply");
  }

  return {
    apply,
    bundleName,
    bundleParent,
    chatEnvFile,
    confirmation,
    genEnvFile,
    help,
    launchEnvFile,
  };
}

export function assertNoRecoveryAmbientLibpqTargetOverrides(
  env: RecoveryEnvironment,
) {
  for (const name of RECOVERY_AMBIENT_LIBPQ_TARGET_VARIABLES) {
    if (env[name]) {
      throw new Error(
        `ambient libpq target variable ${name} is not allowed`,
      );
    }
  }
}

export function parseRecoveryPostgresConnection(
  raw: string | undefined,
  label: string,
): RecoveryPostgresConnection {
  if (!raw || raw !== raw.trim()) {
    throw new Error(`${label} must be an unambiguous PostgreSQL URL`);
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error("protocol");
    }
    for (const key of url.searchParams.keys()) {
      if (forbiddenPostgresUrlOverrides.has(key.toLowerCase())) {
        throw new Error("query override");
      }
    }
    if (url.pathname.startsWith("//")) throw new Error("database path");
    if (!url.hostname || url.hostname.includes(",") || !url.username) {
      throw new Error("authority");
    }
    const decodedDatabase = decodeURIComponent(url.pathname.slice(1));
    const normalizedDatabase = decodedDatabase.toLowerCase();
    if (
      !decodedDatabase ||
      decodedDatabase.includes("=") ||
      normalizedDatabase.startsWith("postgres://") ||
      normalizedDatabase.startsWith("postgresql://")
    ) {
      throw new Error("database name");
    }
    // Keep the operator path on the same parser as Chat runtime. The explicit
    // URL components below independently ensure node-pg did not derive target
    // authority from ambient PG* state.
    const effective = new Client({ connectionString: raw });
    const expectedPort = Number.parseInt(url.port || "5432", 10);
    const expectedUser = decodeURIComponent(url.username);
    if (
      String(effective.host).toLowerCase() !== url.hostname.toLowerCase() ||
      effective.port !== expectedPort ||
      effective.database !== decodeURI(url.pathname.slice(1)) ||
      effective.user !== expectedUser
    ) {
      throw new Error("effective authority");
    }
    return {
      host: String(effective.host),
      port: String(effective.port),
      database: effective.database!,
      user: effective.user!,
      password: decodeURIComponent(url.password),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} `)) {
      throw error;
    }
    throw new Error(`${label} must be an unambiguous PostgreSQL URL`);
  }
}

function tryParsePostgresUrl(raw: string | undefined, label: string) {
  try {
    return parseRecoveryPostgresConnection(raw, label);
  } catch {
    return null;
  }
}

function databaseIdentity(value: RecoveryPostgresConnection | null) {
  return value
    ? `${value.host.toLowerCase()}:${value.port}/${value.database}`
    : null;
}

function normalizedEndpoint(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizedRedisAuthority(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!new Set(["redis:", "rediss:"]).has(url.protocol)) return null;
    if (!url.hostname || url.search || url.hash) return null;
    const database = url.pathname.replace(/^\//u, "") || "0";
    if (!/^(?:0|[1-9][0-9]*)$/u.test(database)) return null;
    const port = Number.parseInt(url.port || "6379", 10);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
    // Credentials are execution input, never bundle/plan authority.
    return `${url.protocol}//${url.hostname.toLowerCase()}:${port}/${database}`;
  } catch {
    return null;
  }
}

function firstEnv(env: RecoveryEnvironment, names: readonly string[]) {
  for (const name of names) {
    if (env[name] !== undefined) return env[name] ?? null;
  }
  return null;
}

function isPlaceholder(value: string | null | undefined) {
  return typeof value === "string" &&
    /(?:replace[-_ ]with|change[-_ ]me|change[-_ ]before|example\.com)/iu.test(value);
}

function resolveLocalRoot(workspaceRoot: string, raw: string | undefined, fallback: string) {
  return path.resolve(workspaceRoot, raw?.trim() || fallback);
}

function resolveRecoverySourceTargets(input: {
  readonly env: RecoveryEnvironment;
  readonly workspaceRoot: string;
  readonly chatWorkingDirectory?: string;
}) {
  const database = tryParsePostgresUrl(input.env.DATABASE_URL, "DATABASE_URL");
  const provider = input.env.BLOB_PROVIDER?.trim() || "mock";
  const endpoint = provider === "mock"
    ? null
    : normalizedEndpoint(input.env.BLOB_ENDPOINT);
  const bucket = provider === "mock"
    ? null
    : input.env.BLOB_BUCKET?.trim() || null;
  const region = provider === "mock"
    ? null
    : input.env.BLOB_REGION?.trim() || "auto";
  const root = provider === "mock"
    ? resolveLocalRoot(input.workspaceRoot, input.env.BLOB_ROOT, "data/blob")
    : null;
  const chatFsRoot = input.env.CHAT_FS_ROOT?.trim()
    ? resolveChatFsRoot(
        input.env.CHAT_FS_ROOT,
        input.chatWorkingDirectory ?? path.join(input.workspaceRoot, "packages/chat"),
      )
    : null;
  return { database, provider, endpoint, bucket, region, root, chatFsRoot };
}

export function resolveRecoveryRehearsalSourceAuthority(input: {
  readonly env: RecoveryEnvironment;
  readonly workspaceRoot: string;
  readonly chatWorkingDirectory?: string;
}): RecoveryRehearsalSourceAuthority {
  assertNoRecoveryAmbientLibpqTargetOverrides(input.env);
  const targets = resolveRecoverySourceTargets(input);
  const mainRedis = normalizedRedisAuthority(
    input.env.IDREAM_MAIN_REDIS_URL ?? input.env.REDIS_URL,
  );
  const genRedis = normalizedRedisAuthority(
    input.env.IDREAM_GEN_REDIS_URL ?? input.env.GEN_REDIS_URL ?? input.env.REDIS_URL,
  );
  const mainPrefix =
    input.env.IDREAM_MAIN_BULLMQ_PREFIX?.trim() || input.env.BULLMQ_PREFIX?.trim();
  const genPrefix =
    input.env.IDREAM_GEN_BULLMQ_PREFIX?.trim() || input.env.BULLMQ_PREFIX?.trim();
  const recoveryRetentionDaysRaw = input.env.RECOVERY_BLOB_RETENTION_DAYS?.trim();
  const recoveryRetentionDays = recoveryRetentionDaysRaw &&
      /^(?:[1-9][0-9]*)$/u.test(recoveryRetentionDaysRaw)
    ? Number.parseInt(recoveryRetentionDaysRaw, 10)
    : null;
  const chatDatabase = tryParsePostgresUrl(
    input.env.CHAT_DATABASE_URL,
    "CHAT_DATABASE_URL",
  );
  const projectorDatabase = tryParsePostgresUrl(
    input.env.CHAT_PROJECTOR_DATABASE_URL,
    "CHAT_PROJECTOR_DATABASE_URL",
  );
  if (!targets.database) {
    throw new Error("DATABASE_URL must identify the current PostgreSQL source");
  }
  if (
    !chatDatabase || chatDatabase.user !== "chat_service" ||
    !projectorDatabase || projectorDatabase.user !== "chat_projector" ||
    databaseIdentity(targets.database) !== databaseIdentity(chatDatabase) ||
    databaseIdentity(targets.database) !== databaseIdentity(projectorDatabase)
  ) {
    throw new Error(
      "Main, Chat request, and Chat projector must use their exact roles on one database authority",
    );
  }
  if (!targets.chatFsRoot) {
    throw new Error("CHAT_FS_ROOT must identify the current Chat file source");
  }
  if (!mainRedis || mainRedis !== genRedis || !mainPrefix || mainPrefix !== genPrefix) {
    throw new Error("Main and Gen must use one exact Redis and BullMQ queue authority");
  }
  if (
    targets.provider !== "mock" &&
    targets.provider !== "r2" &&
    targets.provider !== "s3"
  ) {
    throw new Error("BLOB_PROVIDER must identify the current Blob source");
  }
  if (
    targets.provider !== "mock" &&
    (!targets.endpoint || !targets.bucket)
  ) {
    throw new Error("remote Blob source authority is incomplete");
  }
  if (targets.provider !== "mock" && !recoveryRetentionDays) {
    throw new Error("remote Blob recovery retention authority is incomplete");
  }
  return {
    database: {
      host: targets.database.host,
      port: Number.parseInt(targets.database.port, 10),
      database: targets.database.database,
    },
    chatFsRoot: targets.chatFsRoot,
    queue: { redis: mainRedis, prefix: mainPrefix },
    blob: {
      provider: targets.provider,
      endpoint: targets.endpoint,
      bucket: targets.bucket,
      root: targets.root,
      recoveryRetentionDays:
        targets.provider === "mock" ? null : recoveryRetentionDays,
    },
  };
}

export function resolveRecoveryRehearsalPlan(input: {
  readonly options: RecoveryRehearsalCliOptions;
  readonly env: RecoveryEnvironment;
  readonly expectedMigrationCount: number;
  readonly latestMigration: string | null;
  readonly workspaceRoot: string;
  readonly chatWorkingDirectory?: string;
}): RecoveryRehearsalPlan {
  const blockers: string[] = [];
  const timestamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const bundleName = input.options.bundleName ??
    `idream-recovery-${timestamp}-${input.expectedMigrationCount}`;
  const confirmation = `CREATE RECOVERY REHEARSAL ${bundleName}`;
  const sourceTargets = resolveRecoverySourceTargets({
    env: input.env,
    workspaceRoot: input.workspaceRoot,
    chatWorkingDirectory: input.chatWorkingDirectory,
  });
  const {
    database,
    provider,
    endpoint,
    bucket,
    region,
    root,
    chatFsRoot,
  } = sourceTargets;
  const recoveryDatabase = tryParsePostgresUrl(
    input.env.RECOVERY_DATABASE_URL,
    "RECOVERY_DATABASE_URL",
  );
  const chatDatabase = tryParsePostgresUrl(
    input.env.CHAT_DATABASE_URL,
    "CHAT_DATABASE_URL",
  );
  const projectorDatabase = tryParsePostgresUrl(
    input.env.CHAT_PROJECTOR_DATABASE_URL,
    "CHAT_PROJECTOR_DATABASE_URL",
  );
  const genProvider = input.env.GEN_BLOB_PROVIDER?.trim() || provider;
  const genRoot = genProvider === "mock"
    ? resolveLocalRoot(
        input.workspaceRoot,
        input.env.IDREAM_GEN_BLOB_ROOT ?? input.env.BLOB_ROOT,
        "data/blob",
      )
    : null;
  const genEndpoint = genProvider === "mock"
    ? null
    : normalizedEndpoint(
        input.env.IDREAM_GEN_BLOB_ENDPOINT ?? input.env.BLOB_ENDPOINT,
      );
  const genBucket = genProvider === "mock"
    ? null
    : input.env.IDREAM_GEN_BLOB_BUCKET?.trim() || bucket;
  const mainRedis = normalizedRedisAuthority(
    input.env.IDREAM_MAIN_REDIS_URL ?? input.env.REDIS_URL,
  );
  const genRedis = normalizedRedisAuthority(
    input.env.IDREAM_GEN_REDIS_URL ?? input.env.GEN_REDIS_URL ?? input.env.REDIS_URL,
  );
  const mainPrefix = input.env.IDREAM_MAIN_BULLMQ_PREFIX?.trim() ||
    input.env.BULLMQ_PREFIX?.trim() || null;
  const genPrefix = input.env.IDREAM_GEN_BULLMQ_PREFIX?.trim() ||
    input.env.BULLMQ_PREFIX?.trim() || null;
  const recoveryEndpoint = provider === "mock"
    ? null
    : normalizedEndpoint(input.env.RECOVERY_BLOB_ENDPOINT);
  const recoveryBucket = provider === "mock"
    ? null
    : input.env.RECOVERY_BLOB_BUCKET?.trim() || null;
  const recoveryRegion = provider === "mock"
    ? null
    : input.env.RECOVERY_BLOB_REGION?.trim() || null;
  const recoveryRetentionDaysRaw = provider === "mock"
    ? null
    : input.env.RECOVERY_BLOB_RETENTION_DAYS?.trim() || null;
  const recoveryRetentionDays = recoveryRetentionDaysRaw &&
      /^(?:[1-9][0-9]*)$/u.test(recoveryRetentionDaysRaw)
    ? Number.parseInt(recoveryRetentionDaysRaw, 10)
    : null;
  if ((input.env.IDREAM_RECOVERY_APP_ENV ?? input.env.APP_ENV) !== "production") {
    blockers.push("APP_ENV must be production");
  }
  if (input.env.IDREAM_QUIESCED !== "1") {
    blockers.push("IDREAM_QUIESCED must be 1");
  }
  if (!database) {
    blockers.push("DATABASE_URL must be an unambiguous PostgreSQL URL");
  }
  if (!recoveryDatabase) {
    blockers.push("RECOVERY_DATABASE_URL must be an unambiguous PostgreSQL URL");
  } else if (databaseIdentity(database) !== databaseIdentity(recoveryDatabase)) {
    blockers.push("RECOVERY_DATABASE_URL must identify the exact Main source database");
  }
  if (!chatDatabase || !projectorDatabase) {
    blockers.push(
      "CHAT_DATABASE_URL and CHAT_PROJECTOR_DATABASE_URL must be unambiguous PostgreSQL URLs",
    );
  }
  for (const name of RECOVERY_AMBIENT_LIBPQ_TARGET_VARIABLES) {
    if (input.env[name]) {
      blockers.push(`ambient libpq target variable ${name} is not allowed`);
    }
  }
  if (
    databaseIdentity(database) === null ||
    databaseIdentity(database) !== databaseIdentity(chatDatabase) ||
    databaseIdentity(database) !== databaseIdentity(projectorDatabase)
  ) {
    blockers.push(
      "Main, Chat request, and Chat projector database authorities must match",
    );
  }
  if (chatDatabase && chatDatabase.user !== "chat_service") {
    blockers.push("CHAT_DATABASE_URL must use chat_service");
  }
  if (projectorDatabase && projectorDatabase.user !== "chat_projector") {
    blockers.push("CHAT_PROJECTOR_DATABASE_URL must use chat_projector");
  }
  if (database && /(?:test|playwright)/iu.test(database.database)) {
    blockers.push("source database must not be a test or Playwright database");
  }
  if (
    isPlaceholder(database?.host) ||
    isPlaceholder(database?.password) ||
    isPlaceholder(chatDatabase?.host) ||
    isPlaceholder(chatDatabase?.password) ||
    isPlaceholder(projectorDatabase?.host) ||
    isPlaceholder(projectorDatabase?.password)
  ) {
    blockers.push("database authority contains placeholder values");
  }
  if (!chatFsRoot) blockers.push("CHAT_FS_ROOT is required");
  if (!new Set(["mock", "r2", "s3"]).has(provider)) {
    blockers.push("BLOB_PROVIDER must be mock, r2, or s3");
  }
  if (provider !== genProvider) {
    blockers.push("Main and Gen Blob providers must match");
  }
  if (!mainRedis || !genRedis || mainRedis !== genRedis) {
    blockers.push("Main and Gen Redis authorities must match");
  }
  if (!mainPrefix || !genPrefix || mainPrefix !== genPrefix) {
    blockers.push("Main and Gen BullMQ prefixes must match");
  }
  if (
    provider === "mock" &&
    genProvider === "mock" &&
    root !== genRoot
  ) {
    blockers.push("Main and Gen local Blob roots must match");
  }
  if (
    provider !== "mock" &&
    genProvider !== "mock" &&
    (endpoint !== genEndpoint || bucket !== genBucket)
  ) {
    blockers.push("Main and Gen remote Blob targets must match");
  }
  if (provider !== "mock") {
    if (!endpoint) blockers.push("BLOB_ENDPOINT must be a credential-free HTTPS URL");
    if (!bucket) blockers.push("BLOB_BUCKET is required");
    if (!firstEnv(input.env, [
      "BLOB_ACCESS_KEY_ID",
      "BLOB_ACCESS_KEY",
      "AWS_ACCESS_KEY_ID",
    ])) {
      blockers.push("Blob access key is required");
    }
    if (!firstEnv(input.env, [
      "BLOB_SECRET_ACCESS_KEY",
      "BLOB_SECRET_KEY",
      "AWS_SECRET_ACCESS_KEY",
    ])) {
      blockers.push("Blob secret key is required");
    }
    if (
      isPlaceholder(endpoint) ||
      isPlaceholder(bucket) ||
      isPlaceholder(firstEnv(input.env, [
        "BLOB_ACCESS_KEY_ID",
        "BLOB_ACCESS_KEY",
        "AWS_ACCESS_KEY_ID",
      ])) ||
      isPlaceholder(firstEnv(input.env, [
        "BLOB_SECRET_ACCESS_KEY",
        "BLOB_SECRET_KEY",
        "AWS_SECRET_ACCESS_KEY",
      ]))
    ) {
      blockers.push("Blob authority contains placeholder values");
    }
    if (!recoveryEndpoint) {
      blockers.push(
        "RECOVERY_BLOB_ENDPOINT must identify an independent HTTPS authority",
      );
    }
    if (!recoveryBucket) {
      blockers.push(
        "RECOVERY_BLOB_BUCKET must identify an independent versioned bucket",
      );
    }
    if (recoveryEndpoint === endpoint) {
      blockers.push("Recovery Blob endpoint must differ from the live endpoint");
    }
    if (recoveryBucket === bucket) {
      blockers.push("Recovery Blob bucket must differ from the live bucket");
    }
    if (!input.env.RECOVERY_BLOB_ACCESS_KEY_ID?.trim()) {
      blockers.push("Recovery Blob access credential is required");
    }
    if (!input.env.RECOVERY_BLOB_SECRET_ACCESS_KEY?.trim()) {
      blockers.push("Recovery Blob signing credential is required");
    }
    if (!recoveryRetentionDays || !Number.isSafeInteger(recoveryRetentionDays)) {
      blockers.push("RECOVERY_BLOB_RETENTION_DAYS must be a positive integer");
    }
    if (
      isPlaceholder(recoveryEndpoint) ||
      isPlaceholder(recoveryBucket) ||
      isPlaceholder(input.env.RECOVERY_BLOB_ACCESS_KEY_ID) ||
      isPlaceholder(input.env.RECOVERY_BLOB_SECRET_ACCESS_KEY)
    ) {
      blockers.push("Recovery Blob authority contains placeholder values");
    }
  }
  if (
    input.options.apply &&
    input.options.confirmation !== confirmation
  ) {
    blockers.push("typed confirmation does not match");
  }

  return {
    schemaVersion: 1,
    mode: input.options.apply ? "apply" : "dry_run",
    bundleName,
    bundlePath: path.resolve(input.workspaceRoot, input.options.bundleParent, bundleName),
    confirmation,
    safeToApply: blockers.length === 0,
    blockers,
    database: {
      host: database?.host ?? null,
      port: database ? Number.parseInt(database.port, 10) : null,
      database: database?.database ?? null,
      user: database?.user ?? null,
    },
    recoveryDatabase: {
      host: recoveryDatabase?.host ?? null,
      port: recoveryDatabase ? Number.parseInt(recoveryDatabase.port, 10) : null,
      database: recoveryDatabase?.database ?? null,
      user: recoveryDatabase?.user ?? null,
    },
    chatFsRoot,
    queueAuthority: {
      redis: mainRedis,
      prefix: mainPrefix,
    },
    blob: {
      provider,
      endpoint,
      bucket,
      region,
      root,
      recovery: {
        endpoint: recoveryEndpoint,
        bucket: recoveryBucket,
        region: recoveryRegion,
        retentionDays: recoveryRetentionDays,
      },
    },
    migrationAuthority: {
      count: input.expectedMigrationCount,
      latest: input.latestMigration,
    },
  };
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeAuthorityPath(relativePath: string) {
  if (
    relativePath.includes("\t") ||
    relativePath.includes("\n") ||
    relativePath.includes("\r") ||
    relativePath.split(path.sep).includes("..")
  ) {
    throw new Error(`file authority contains an unsafe path: ${relativePath}`);
  }
}

export async function buildFileAuthorityManifest(root: string) {
  const canonicalRoot = path.resolve(root);
  const rootStat = await lstat(canonicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`file authority root is not a real directory: ${canonicalRoot}`);
  }
  const entries: Array<{
    kind: "directory" | "file";
    mode: string;
    digest: string;
    authorityPath: string;
  }> = [];

  async function visit(absolute: string, relative: string) {
    safeAuthorityPath(relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`file authority contains a symlink: ${relative || "."}`);
    }
    const authorityPath = relative ? `./${relative.split(path.sep).join("/")}` : ".";
    const mode = (stat.mode & 0o7777).toString(8).padStart(3, "0");
    if (stat.isDirectory()) {
      entries.push({ kind: "directory", mode, digest: "-", authorityPath });
      const children = await readdir(absolute);
      children.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      for (const child of children) {
        await visit(path.join(absolute, child), path.join(relative, child));
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`file authority contains a non-regular entry: ${authorityPath}`);
    }
    entries.push({
      kind: "file",
      mode,
      digest: sha256(await readFile(absolute)),
      authorityPath,
    });
  }

  await visit(canonicalRoot, "");
  return `${entries.map((entry) =>
    `${entry.kind}\t${entry.mode}\t${entry.digest}\t${entry.authorityPath}`
  ).join("\n")}\n`;
}

type RawBlobVersion = {
  readonly Key?: unknown;
  readonly VersionId?: unknown;
  readonly IsLatest?: unknown;
  readonly ETag?: unknown;
  readonly Size?: unknown;
};

export type LiveBlobVersion = {
  readonly key: string;
  readonly versionId: string;
  readonly etag: string;
  readonly size: number;
};

function safeBlobKey(key: string) {
  return key.length > 0 &&
    !key.startsWith("/") &&
    !key.includes("\\") &&
    !key.includes("\t") &&
    !key.includes("\n") &&
    !key.includes("\r") &&
    !key.split("/").includes("..");
}

export function selectLiveBlobVersions(input: {
  readonly Versions?: readonly RawBlobVersion[];
  readonly DeleteMarkers?: readonly RawBlobVersion[];
}): LiveBlobVersion[] {
  const latestDeleteKeys = new Set(
    (input.DeleteMarkers ?? [])
      .filter((entry) => entry.IsLatest === true && typeof entry.Key === "string")
      .map((entry) => entry.Key as string),
  );
  const versions = (input.Versions ?? [])
    .filter((entry) => entry.IsLatest === true)
    .filter((entry) => typeof entry.Key === "string")
    .filter((entry) => !latestDeleteKeys.has(entry.Key as string))
    .filter((entry) => !(entry.Key as string).startsWith(".idream-recovery/"))
    .map((entry) => {
      const key = entry.Key as string;
      if (!safeBlobKey(key)) throw new Error(`Blob inventory contains an unsafe key: ${key}`);
      if (
        typeof entry.VersionId !== "string" ||
        entry.VersionId.length === 0 ||
        entry.VersionId === "null"
      ) {
        throw new Error("Blob bucket versioning is required for recovery rehearsal");
      }
      if (
        typeof entry.ETag !== "string" ||
        !Number.isSafeInteger(entry.Size) ||
        (entry.Size as number) < 0
      ) {
        throw new Error(`Blob inventory contains incomplete metadata: ${key}`);
      }
      return {
        key,
        versionId: entry.VersionId,
        etag: entry.ETag,
        size: entry.Size as number,
      };
    });
  versions.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  if (versions.length === 0) {
    throw new Error("Blob recovery rehearsal requires at least one live versioned object");
  }
  return versions;
}

export function validateRecoveryCounts(
  counts: RecoveryCounts,
  expectedMigrationCount: number,
  latestMigration: string | null,
) {
  const problems: string[] = [];
  if (
    counts.migrations !== expectedMigrationCount ||
    counts.latest_migration !== latestMigration
  ) {
    problems.push(
      `migration authority is ${String(counts.migrations)}/${expectedMigrationCount} with latest ${String(counts.latest_migration)}, expected ${latestMigration ?? "none"}`,
    );
  }
  for (const key of inFlightMutationCountKeys) {
    if (counts[key] !== 0) {
      problems.push(
        `checkpoint has in-flight mutation: ${key}=${String(counts[key])}`,
      );
    }
  }
  return problems;
}
