import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

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
  readonly chatFsRoot: string | null;
  readonly blob: {
    readonly provider: string | null;
    readonly endpoint: string | null;
    readonly bucket: string | null;
    readonly region: string | null;
    readonly root: string | null;
  };
  readonly migrationAuthority: {
    readonly count: number;
    readonly latest: string | null;
  };
};

type RecoveryCounts = Record<string, unknown>;
export type RecoveryEnvironment = Readonly<Record<string, string | undefined>>;

const safeBundleName = /^idream-recovery-[A-Za-z0-9._-]+$/u;
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

function parsePostgresUrl(raw: string | undefined) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      return null;
    }
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (!url.hostname || !database || !url.username) return null;
    return {
      host: url.hostname,
      port: Number.parseInt(url.port || "5432", 10),
      database,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    return null;
  }
}

function databaseIdentity(value: ReturnType<typeof parsePostgresUrl>) {
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

export function resolveRecoveryRehearsalPlan(input: {
  readonly options: RecoveryRehearsalCliOptions;
  readonly env: RecoveryEnvironment;
  readonly expectedMigrationCount: number;
  readonly latestMigration: string | null;
  readonly workspaceRoot: string;
}): RecoveryRehearsalPlan {
  const blockers: string[] = [];
  const timestamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const bundleName = input.options.bundleName ??
    `idream-recovery-${timestamp}-${input.expectedMigrationCount}`;
  const confirmation = `CREATE RECOVERY REHEARSAL ${bundleName}`;
  const database = parsePostgresUrl(input.env.DATABASE_URL);
  const chatDatabase = parsePostgresUrl(input.env.CHAT_DATABASE_URL);
  const projectorDatabase = parsePostgresUrl(
    input.env.CHAT_PROJECTOR_DATABASE_URL,
  );
  const provider = input.env.BLOB_PROVIDER?.trim() || "mock";
  const genProvider = input.env.GEN_BLOB_PROVIDER?.trim() || provider;
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
  const chatFsRoot = input.env.CHAT_FS_ROOT?.trim()
    ? resolveLocalRoot(input.workspaceRoot, input.env.CHAT_FS_ROOT, "data/chat")
    : null;

  if (input.env.APP_ENV !== "production") {
    blockers.push("APP_ENV must be production");
  }
  if (input.env.IDREAM_QUIESCED !== "1") {
    blockers.push("IDREAM_QUIESCED must be 1");
  }
  if (!database) blockers.push("DATABASE_URL must be a valid PostgreSQL URL");
  if (!chatDatabase || !projectorDatabase) {
    blockers.push("CHAT_DATABASE_URL and CHAT_PROJECTOR_DATABASE_URL are required");
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
      port: database?.port ?? null,
      database: database?.database ?? null,
      user: database?.user ?? null,
    },
    chatFsRoot,
    blob: { provider, endpoint, bucket, region, root },
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
  for (const key of quiescentCountKeys) {
    if (counts[key] !== 0) {
      problems.push(`checkpoint is not quiescent: ${key}=${String(counts[key])}`);
    }
  }
  return problems;
}
