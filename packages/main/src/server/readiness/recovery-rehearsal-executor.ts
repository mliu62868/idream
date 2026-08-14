import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAIN_OUTBOX_TRANSPORT_EVENT_TYPES,
  MAIN_OUTBOX_TRANSPORT_KNOWN_STATUSES,
} from "@/server/events/main-outbox-transport";
import type { ExpectedMigration } from "./migration-authority";
import { inspectMigrationAuthority } from "./migration-authority";
import {
  renderRecoveryDatabaseAuthoritySql,
  type RecoveryDatabaseAuthority,
} from "./recovery-database-authority";
export { orderDatabaseAclEntries } from "./recovery-database-authority";
import {
  computeRecoverySourceCheckpointSha256,
  inspectRecoveryRehearsalBundle,
  type RecoveryRehearsalSourceAuthority,
} from "./recovery-rehearsal-authority";
import {
  buildFileAuthorityManifest,
  assertNoRecoveryAmbientLibpqTargetOverrides,
  parseRecoveryPostgresConnection,
  RECOVERY_AMBIENT_LIBPQ_TARGET_VARIABLES,
  selectLiveBlobVersions,
  validateRecoveryCounts,
  type LiveBlobVersion,
  type RecoveryPostgresConnection,
  type RecoveryRehearsalPlan,
} from "./recovery-rehearsal-producer";

type CommandInput = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string | Buffer;
  readonly allowExitCodes?: readonly number[];
  readonly stage: string;
};

export type RecoveryCommandRunner = {
  run(input: CommandInput): { stdout: Buffer; stderr: Buffer; status: number };
};

export type RecoveryRehearsalExecution = {
  readonly ok: true;
  readonly bundlePath: string;
  readonly bundleName: string;
  readonly migrationCount: number;
  readonly latestMigration: string;
  readonly blobProvider: string;
};

type DatabaseAuthority = RecoveryDatabaseAuthority;

type RoleAuthority = {
  readonly required_roles: readonly string[];
  readonly roles_without_passwords: readonly Record<string, unknown>[];
  readonly memberships: readonly Record<string, unknown>[];
  readonly password_restore_policy: string;
};

type BundleFiles = ReturnType<typeof bundleFiles>;

const ownedRuntimeNames = new Set([
  "fish-audio",
  "main-web",
  "admin-web",
  "chat",
  "gen-image",
  "gen-video",
  "gen-finalizer",
  "main-event-consumer",
  "admin-command-worker",
]);
const quiescedPm2Statuses = new Set(["stopped", "errored"]);

const mainOutboxTransportEventTypesSql = MAIN_OUTBOX_TRANSPORT_EVENT_TYPES
  .map((eventType) => `'${eventType.replaceAll("'", "''")}'`)
  .join(", ");
const mainOutboxTransportKnownStatusesSql = MAIN_OUTBOX_TRANSPORT_KNOWN_STATUSES
  .map((status) => `'${status.replaceAll("'", "''")}'`)
  .join(", ");

export const RECOVERY_COUNT_SQL = String.raw`
SELECT jsonb_build_object(
  'migrations', (SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
  'latest_migration', (SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1),
  'main_outbox_pending', (SELECT count(*) FROM public.main_outbox_events WHERE status = 'pending'),
  'main_outbox_failed', (SELECT count(*) FROM public.main_outbox_events WHERE status = 'failed'),
  'main_outbox_transport_pending', (SELECT count(*) FROM public.main_outbox_events WHERE "eventType" IN (${mainOutboxTransportEventTypesSql}) AND status = 'pending'),
  'main_outbox_transport_failed', (SELECT count(*) FROM public.main_outbox_events WHERE "eventType" IN (${mainOutboxTransportEventTypesSql}) AND status = 'failed'),
  'main_outbox_dispatched', (SELECT count(*) FROM public.main_outbox_events WHERE "eventType" IN (${mainOutboxTransportEventTypesSql}) AND status = 'dispatched'),
  'main_outbox_transport_unknown', (SELECT count(*) FROM public.main_outbox_events WHERE "eventType" IN (${mainOutboxTransportEventTypesSql}) AND status NOT IN (${mainOutboxTransportKnownStatusesSql})),
  'inbound_event_received', (SELECT count(*) FROM public.inbound_event_receipts WHERE "processingState" = 'received'),
  'inbound_event_processing', (SELECT count(*) FROM public.inbound_event_receipts WHERE "processingState" = 'processing'),
  'chat_outbox_pending', (SELECT count(*) FROM chat.chat_outbox_events WHERE status = 'pending'),
  'chat_outbox_failed', (SELECT count(*) FROM chat.chat_outbox_events WHERE status = 'failed'),
  'chat_inbox_pending', (SELECT count(*) FROM chat.chat_inbox_events WHERE status = 'pending'),
  'chat_inbox_failed', (SELECT count(*) FROM chat.chat_inbox_events WHERE status = 'failed'),
  'chat_inbox_processing', (SELECT count(*) FROM chat.chat_inbox_events WHERE status = 'processing'),
  'chat_file_mutations_pending', (SELECT count(*) FROM chat.chat_file_mutations WHERE status = 'pending')
);`;

const TABLE_MANIFEST_SQL = String.raw`
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL IntervalStyle = 'iso_8601';
SET LOCAL bytea_output = 'hex';
SET LOCAL extra_float_digits = 3;
SELECT format(
$query$
SELECT jsonb_build_object(
  'schema', %L,
  'table', %L,
  'relkind', %L,
  'is_partition', %L::boolean,
  'row_count', count(*),
  'row_digest_sha256', encode(sha256(convert_to(COALESCE(string_agg(row_json, E'\n' ORDER BY row_json COLLATE "C"), ''), 'UTF8')), 'hex')
)
FROM (SELECT to_jsonb(candidate)::text AS row_json FROM %I.%I AS candidate) AS canonical_rows
$query$,
  namespace.nspname,
  class.relname,
  class.relkind::text,
  class.relispartition,
  namespace.nspname,
  class.relname
)
FROM pg_class AS class
JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
WHERE class.relkind IN ('r', 'p')
  AND namespace.nspname NOT LIKE 'pg_%'
  AND namespace.nspname <> 'information_schema'
ORDER BY namespace.nspname, class.relname
\gexec
COMMIT;`;

const SEQUENCE_MANIFEST_SQL = String.raw`
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT format(
$query$
SELECT jsonb_build_object(
  'schema', %L,
  'sequence', %L,
  'last_value', last_value::text,
  'is_called', is_called
)
FROM %I.%I
$query$,
  namespace.nspname,
  class.relname,
  namespace.nspname,
  class.relname
)
FROM pg_class AS class
JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
WHERE class.relkind = 'S'
  AND namespace.nspname NOT LIKE 'pg_%'
  AND namespace.nspname <> 'information_schema'
ORDER BY namespace.nspname, class.relname
\gexec
COMMIT;`;

const DATABASE_AUTHORITY_SQL = String.raw`
WITH database_row AS (
  SELECT database.*, tablespace.spcname AS tablespace_name
  FROM pg_database AS database
  JOIN pg_tablespace AS tablespace ON tablespace.oid = database.dattablespace
  WHERE database.datname = current_database()
), acl_rows AS (
  SELECT jsonb_build_object(
    'grantor', pg_get_userbyid(acl.grantor),
    'grantor_is_superuser', grantor.rolsuper,
    'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END,
    'privilege', acl.privilege_type,
    'grantable', acl.is_grantable
  ) AS item
  FROM database_row
  CROSS JOIN LATERAL aclexplode(database_row.datacl) AS acl
  JOIN pg_roles AS grantor ON grantor.oid = acl.grantor
), settings AS (
  SELECT jsonb_build_object(
    'role', CASE WHEN setting.setrole = 0 THEN NULL ELSE pg_get_userbyid(setting.setrole) END,
    'settings', to_jsonb(setting.setconfig)
  ) AS item
  FROM pg_db_role_setting AS setting
  WHERE setting.setdatabase = (SELECT oid FROM database_row)
)
SELECT jsonb_build_object(
  'database', jsonb_build_object(
    'owner', pg_get_userbyid(database_row.datdba),
    'encoding', pg_encoding_to_char(database_row.encoding),
    'locale_provider', CASE database_row.datlocprovider WHEN 'c' THEN 'libc' WHEN 'i' THEN 'icu' WHEN 'b' THEN 'builtin' ELSE database_row.datlocprovider::text END,
    'collate', database_row.datcollate,
    'ctype', database_row.datctype,
    'icu_locale', database_row.daticulocale,
    'icu_rules', database_row.daticurules,
    'tablespace', database_row.tablespace_name,
    'connection_limit', database_row.datconnlimit,
    'comment', shobj_description(database_row.oid, 'pg_database'),
    'acl_is_null', database_row.datacl IS NULL,
    'acl', COALESCE((SELECT jsonb_agg(item ORDER BY item::text) FROM acl_rows), '[]'::jsonb)
  ),
  'database_role_settings', COALESCE((SELECT jsonb_agg(item ORDER BY item::text) FROM settings), '[]'::jsonb)
)
FROM database_row;`;

const ROLE_AUTHORITY_SQL = String.raw`
WITH user_namespaces AS (
  SELECT oid, nspowner, nspacl
  FROM pg_namespace
  WHERE nspname NOT LIKE 'pg_%'
    AND nspname <> 'information_schema'
), user_relations AS (
  SELECT class.relowner, class.relacl
  FROM pg_class AS class
  JOIN user_namespaces AS namespace ON namespace.oid = class.relnamespace
  WHERE class.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
), user_routines AS (
  SELECT routine.proowner, routine.proacl
  FROM pg_proc AS routine
  JOIN user_namespaces AS namespace ON namespace.oid = routine.pronamespace
), role_oids AS (
  SELECT datdba AS role_oid FROM pg_database WHERE datname = current_database()
  UNION SELECT nspowner FROM user_namespaces
  UNION SELECT relowner FROM user_relations
  UNION SELECT proowner FROM user_routines
  UNION SELECT defaclrole FROM pg_default_acl
  UNION SELECT acl.grantor FROM user_namespaces CROSS JOIN LATERAL aclexplode(nspacl) AS acl
  UNION SELECT acl.grantee FROM user_namespaces CROSS JOIN LATERAL aclexplode(nspacl) AS acl
  UNION SELECT acl.grantor FROM user_relations CROSS JOIN LATERAL aclexplode(relacl) AS acl
  UNION SELECT acl.grantee FROM user_relations CROSS JOIN LATERAL aclexplode(relacl) AS acl
  UNION SELECT acl.grantor FROM user_routines CROSS JOIN LATERAL aclexplode(proacl) AS acl
  UNION SELECT acl.grantee FROM user_routines CROSS JOIN LATERAL aclexplode(proacl) AS acl
  UNION SELECT acl.grantor FROM pg_default_acl CROSS JOIN LATERAL aclexplode(defaclacl) AS acl
  UNION SELECT acl.grantee FROM pg_default_acl CROSS JOIN LATERAL aclexplode(defaclacl) AS acl
  UNION SELECT acl.grantor FROM pg_database CROSS JOIN LATERAL aclexplode(datacl) AS acl WHERE datname = current_database()
  UNION SELECT acl.grantee FROM pg_database CROSS JOIN LATERAL aclexplode(datacl) AS acl WHERE datname = current_database()
), required(role) AS (
  SELECT role.rolname
  FROM role_oids
  JOIN pg_roles AS role ON role.oid = role_oids.role_oid
  WHERE role_oids.role_oid <> 0
  UNION SELECT 'core_owner'
  UNION SELECT 'chat_owner'
  UNION SELECT 'chat_service'
  UNION SELECT 'chat_projector'
), roles AS (
  SELECT jsonb_build_object(
    'role', role.rolname,
    'superuser', role.rolsuper,
    'inherit', role.rolinherit,
    'create_role', role.rolcreaterole,
    'create_db', role.rolcreatedb,
    'can_login', role.rolcanlogin,
    'replication', role.rolreplication,
    'bypass_rls', role.rolbypassrls,
    'connection_limit', role.rolconnlimit,
    'password_material', 'EXCLUDED_USE_SECRET_MANAGER'
  ) AS item
  FROM pg_roles AS role
  JOIN required ON required.role = role.rolname
), memberships AS (
  SELECT jsonb_build_object(
    'role', granted.rolname,
    'member', member.rolname,
    'grantor', pg_get_userbyid(membership.grantor),
    'admin_option', membership.admin_option,
    'inherit_option', membership.inherit_option,
    'set_option', membership.set_option
  ) AS item
  FROM pg_auth_members AS membership
  JOIN pg_roles AS granted ON granted.oid = membership.roleid
  JOIN pg_roles AS member ON member.oid = membership.member
  WHERE granted.rolname IN (SELECT role FROM required)
     OR member.rolname IN (SELECT role FROM required)
)
SELECT jsonb_build_object(
  'required_roles', (SELECT jsonb_agg(role ORDER BY role) FROM required),
  'roles_without_passwords', COALESCE((SELECT jsonb_agg(item ORDER BY item::text) FROM roles), '[]'::jsonb),
  'memberships', COALESCE((SELECT jsonb_agg(item ORDER BY item::text) FROM memberships), '[]'::jsonb),
  'password_restore_policy', 'Credentials are intentionally excluded; provision them from the secret manager.'
);`;

class SystemRecoveryCommandRunner implements RecoveryCommandRunner {
  run(input: CommandInput) {
    const result = spawnSync(input.command, [...(input.args ?? [])], {
      cwd: input.cwd,
      env: input.env,
      input: input.input,
      encoding: null,
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (result.error) {
      throw new Error(`${input.stage} failed to start ${input.command}`);
    }
    const status = result.status ?? 1;
    const allowed = input.allowExitCodes ?? [0];
    if (!allowed.includes(status)) {
      throw new Error(`${input.stage} failed with exit code ${status}`);
    }
    return {
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
      stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""),
      status,
    };
  }
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSameDatabaseAuthority(
  source: RecoveryPostgresConnection,
  candidate: RecoveryPostgresConnection,
  label: string,
) {
  if (
    candidate.host.toLowerCase() !== source.host.toLowerCase() ||
    candidate.port !== source.port ||
    candidate.database !== source.database
  ) {
    throw new Error(`${label} must target the exact Main source database`);
  }
}

function postgresEnv(
  connection: RecoveryPostgresConnection,
  env: NodeJS.ProcessEnv,
) {
  const childEnv = { ...env };
  for (const name of RECOVERY_AMBIENT_LIBPQ_TARGET_VARIABLES) {
    delete childEnv[name];
  }
  return {
    ...childEnv,
    PGHOST: connection.host,
    PGPORT: connection.port,
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
    PGDATABASE: connection.database,
  };
}

function psql(
  runner: RecoveryCommandRunner,
  connection: RecoveryPostgresConnection,
  env: NodeJS.ProcessEnv,
  stage: string,
  sql: string,
  database = connection.database,
) {
  return runner.run({
    command: "psql",
    args: ["-XqAt", "-v", "ON_ERROR_STOP=1", "--dbname", database],
    env: postgresEnv(connection, env),
    input: sql,
    stage,
  }).stdout.toString("utf8").trim();
}

function assertChatDatabaseAuthority(
  runner: RecoveryCommandRunner,
  env: NodeJS.ProcessEnv,
  source: RecoveryPostgresConnection,
  connection: RecoveryPostgresConnection,
  label: string,
  expectedRole: "chat_service" | "chat_projector",
  stage: string,
) {
  assertSameDatabaseAuthority(source, connection, label);
  const identity = parseJson<{
    session_user?: unknown;
    current_user?: unknown;
    database?: unknown;
  }>(psql(
    runner,
    connection,
    env,
    stage,
    "SELECT jsonb_build_object('session_user', session_user, 'current_user', current_user, 'database', current_database());",
  ), stage);
  if (
    identity.session_user !== expectedRole ||
    identity.current_user !== expectedRole ||
    identity.database !== source.database
  ) {
    throw new Error(`${label} did not authenticate as exact role ${expectedRole}`);
  }
}

function parseJson<T>(value: string, stage: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${stage} returned invalid JSON`);
  }
}

function parseJsonLines(value: string, stage: string) {
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  try {
    return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    throw new Error(`${stage} returned an invalid JSON row`);
  }
}

function normalizePlainDump(value: Buffer) {
  const filtered = value.toString("utf8").split(/\r?\n/u).filter((line) =>
    line !== "SET transaction_timeout = 0;" &&
    !line.startsWith("\\restrict ") &&
    !line.startsWith("\\unrestrict ")
  );
  return Buffer.from(`${filtered.join("\n")}\n`);
}

function canonicalSchema(value: Buffer) {
  const filtered = value.toString("utf8").split(/\r?\n/u).filter((line) =>
    !line.startsWith("-- Dumped from database version ") &&
    !line.startsWith("-- Dumped by pg_dump version ") &&
    line !== "SET transaction_timeout = 0;" &&
    !line.startsWith("\\restrict ") &&
    !line.startsWith("\\unrestrict ")
  );
  return Buffer.from(`${filtered.join("\n")}\n`);
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function bundleFiles(staging: string, bundleName: string) {
  const base = path.join(staging, bundleName);
  return {
    base,
    dump: `${base}.dump`,
    sql: `${base}.sql`,
    pg16Sql: `${base}-pg16.sql`,
    sourceCounts: `${base}.source-counts.json`,
    restoreCounts: `${base}.restore-counts.json`,
    sourceSchema: `${base}.source-schema.sql`,
    restoreSchema: `${base}.restore-schema.sql`,
    sourceLogical: `${base}.source-logical.json`,
    restoreLogical: `${base}.restore-logical.json`,
    roles: `${base}.roles.json`,
    databaseAuthority: `${base}.database-authority.json`,
    databaseAuthorityRestore: `${base}.database-authority.restore.sql`,
    chatArchive: `${base}.chat-fs.tar.gz`,
    chatSourceManifest: `${base}.chat-fs.source.sha256`,
    chatRestoreManifest: `${base}.chat-fs.restore.sha256`,
    blobArchive: `${base}.blob.tar.gz`,
    blobInventory: `${base}.blob-object-versions.json`,
    blobSourceManifest: `${base}.blob.source.sha256`,
    blobRestoreManifest: `${base}.blob.restore.sha256`,
    fileAuthorities: `${base}.file-authorities.json`,
    toolVersions: `${base}.tool-versions.json`,
    quiescenceReceipt: `${base}.quiescence-receipt.json`,
    metadata: `${base}.metadata.json`,
    proof: `${base}.proof.sh`,
    restoreRunbook: `${base}.RESTORE.md`,
    checksums: `${base}.sha256`,
  };
}

async function ensureRealDirectory(root: string, label: string) {
  const absolute = path.resolve(root);
  const rootStat = await lstat(absolute);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
  if (await realpath(absolute) !== absolute) {
    throw new Error(`${label} is not canonical`);
  }
  return absolute;
}

function parsePm2Json(value: string) {
  const candidates = value.split(/\r?\n/u);
  for (let index = 0; index < candidates.length; index += 1) {
    const suffix = candidates.slice(index).join("\n").trim();
    if (!suffix) continue;
    try {
      const parsed = JSON.parse(suffix) as unknown;
      if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
    } catch {
      // PM2 may print a warning before JSON. Only a real array suffix is authority.
    }
  }
  throw new Error("PM2 jlist did not return a JSON array");
}

export function captureRuntimeQuiescence(
  runner: RecoveryCommandRunner,
  env: NodeJS.ProcessEnv,
) {
  const processes = parsePm2Json(runner.run({
    command: "pm2",
    args: ["jlist"],
    env,
    stage: "runtime_quiescence_pm2",
  }).stdout.toString("utf8"));
  for (const process of processes) {
    const name = typeof process.name === "string" ? process.name : null;
    const pm2Env = process.pm2_env && typeof process.pm2_env === "object"
      ? process.pm2_env as Record<string, unknown>
      : null;
    const status = typeof pm2Env?.status === "string" ? pm2Env.status : null;
    if (
      name &&
      ownedRuntimeNames.has(name) &&
      !quiescedPm2Statuses.has(status ?? "")
    ) {
      throw new Error(`runtime is not quiescent: ${name} is ${status ?? "unknown"}`);
    }
  }
  const ports: Array<{ port: number; listener: false }> = [];
  for (const port of [3000, 3001, 3100]) {
    const result = runner.run({
      command: "lsof",
      args: ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      env,
      allowExitCodes: [0, 1],
      stage: `runtime_quiescence_port_${port}`,
    });
    if (result.status === 0 && result.stdout.toString("utf8").trim()) {
      throw new Error(`runtime is not quiescent: TCP port ${port} has a listener`);
    }
    ports.push({ port, listener: false });
  }
  return {
    processes: processes.flatMap((process) => {
      const name = typeof process.name === "string" ? process.name : null;
      if (!name || !ownedRuntimeNames.has(name)) return [];
      const pm2Env = process.pm2_env && typeof process.pm2_env === "object"
        ? process.pm2_env as Record<string, unknown>
        : null;
      return [{
        name,
        pmId: typeof process.pm_id === "number" ? process.pm_id : null,
        status: typeof pm2Env?.status === "string" ? pm2Env.status : null,
      }];
    }).sort((left, right) =>
      left.name.localeCompare(right.name) || (left.pmId ?? -1) - (right.pmId ?? -1)
    ),
    ports,
  };
}

function parseJsonObjectSuffix(value: string, stage: string) {
  const lines = value.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index]?.trimStart().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(lines.slice(index).join("\n").trim()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // bun may print its command prefix before the final JSON report.
    }
  }
  throw new Error(`${stage} did not return a JSON authority report`);
}

function assertGenerationQuiescenceReport(
  report: Record<string, unknown>,
  stage: string,
) {
  if (report.ok !== true) {
    throw new Error(`${stage} did not prove quiescence`);
  }
  return report;
}

function captureQuiescenceReceipt(input: {
  readonly runner: RecoveryCommandRunner;
  readonly env: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
  readonly queueAuthority: RecoveryRehearsalPlan["queueAuthority"];
}) {
  const mainCwd = path.join(input.workspaceRoot, "packages/main");
  const mainRedisUrl = input.env.IDREAM_MAIN_REDIS_URL ?? input.env.REDIS_URL;
  const genRedisUrl = input.env.IDREAM_GEN_REDIS_URL ??
    input.env.GEN_REDIS_URL ?? input.env.REDIS_URL;
  if (!mainRedisUrl || !genRedisUrl || !input.queueAuthority.prefix) {
    throw new Error("quiescence queue execution authority is incomplete");
  }
  // INTENT: APP_ENV is only the recovery safety fence. Every child gets the
  // already-resolved service queue authority explicitly, so a temporary
  // production fence cannot redirect development-prefixed queues.
  const quiescenceEnv = {
    ...input.env,
    REDIS_URL: mainRedisUrl,
    GEN_REDIS_URL: genRedisUrl,
    BULLMQ_PREFIX: input.queueAuthority.prefix,
  };
  const pauseAndDrain = assertGenerationQuiescenceReport(
    parseJsonObjectSuffix(input.runner.run({
      command: "bun",
      args: ["run", "generation-cutover:pause-and-drain"],
      cwd: mainCwd,
      env: quiescenceEnv,
      stage: "generation_pause_and_drain",
    }).stdout.toString("utf8"), "generation_pause_and_drain"),
    "generation_pause_and_drain",
  );
  const cutover = assertGenerationQuiescenceReport(
    parseJsonObjectSuffix(input.runner.run({
      command: "bun",
      args: ["run", "check:generation-cutover"],
      cwd: mainCwd,
      env: quiescenceEnv,
      stage: "generation_cutover_authority",
    }).stdout.toString("utf8"), "generation_cutover_authority"),
    "generation_cutover_authority",
  );
  if (
    cutover.activeRequests !== 0 ||
    cutover.inFlightBullRows !== 0 ||
    cutover.pendingTerminalOutboxes !== 0
  ) {
    throw new Error("generation_cutover_authority retained active authority");
  }
  const ownership = assertGenerationQuiescenceReport(
    parseJsonObjectSuffix(input.runner.run({
      command: "node",
      args: [
        path.join(input.workspaceRoot, "scripts/check-gen-image-worker-ownership.cjs"),
        "--mode",
        "quiescent",
        "--expected",
        "0",
        "--expected-video",
        "0",
        "--attempts",
        "10",
      ],
      cwd: input.workspaceRoot,
      env: quiescenceEnv,
      stage: "generation_worker_ownership",
    }).stdout.toString("utf8"), "generation_worker_ownership"),
    "generation_worker_ownership",
  );
  const expected = ownership.expected && typeof ownership.expected === "object"
    ? ownership.expected as Record<string, unknown>
    : null;
  if (
    ownership.mode !== "quiescent" ||
    expected?.image !== 0 ||
    expected.video !== 0
  ) {
    throw new Error("generation_worker_ownership did not prove zero ownership");
  }
  const runtime = captureRuntimeQuiescence(input.runner, input.env);
  const facts = {
    runtime,
    generation: { pauseAndDrain, cutover, ownership },
    queueAuthority: input.queueAuthority,
  };
  return {
    schemaVersion: 1 as const,
    checkedAt: new Date().toISOString(),
    ...facts,
    fingerprint: sha256(JSON.stringify(facts)),
  };
}

function captureCounts(
  runner: RecoveryCommandRunner,
  connection: RecoveryPostgresConnection,
  env: NodeJS.ProcessEnv,
  stage: string,
  database = connection.database,
) {
  return parseJson<Record<string, unknown>>(
    psql(runner, connection, env, stage, RECOVERY_COUNT_SQL, database),
    stage,
  );
}

function captureCanonicalSchema(
  runner: RecoveryCommandRunner,
  connection: RecoveryPostgresConnection,
  env: NodeJS.ProcessEnv,
  stage: string,
  database = connection.database,
) {
  return canonicalSchema(runner.run({
    command: "pg_dump",
    args: [
      "--schema-only",
      "--format=plain",
      "--quote-all-identifiers",
      "--dbname",
      database,
    ],
    env: postgresEnv(connection, env),
    stage,
  }).stdout);
}

function captureLogicalManifest(
  runner: RecoveryCommandRunner,
  connection: RecoveryPostgresConnection,
  env: NodeJS.ProcessEnv,
  stage: string,
  schema: Buffer,
  roleAuthority: RoleAuthority,
  databaseAuthority: DatabaseAuthority,
  database = connection.database,
) {
  const tables = parseJsonLines(
    psql(runner, connection, env, `${stage}_tables`, TABLE_MANIFEST_SQL, database),
    `${stage}_tables`,
  );
  const sequences = parseJsonLines(
    psql(runner, connection, env, `${stage}_sequences`, SEQUENCE_MANIFEST_SQL, database),
    `${stage}_sequences`,
  );
  return `${JSON.stringify({
    manifest_version: 1,
    schema_definition_sha256: sha256(schema),
    tables,
    sequences,
    authority: {
      required_roles: roleAuthority.required_roles,
      database_authority: databaseAuthority.database,
      database_role_settings: databaseAuthority.database_role_settings,
    },
    privilege_boundary: {},
  }, null, 2)}\n`;
}

function manifestCounts(manifest: string) {
  let files = 0;
  const bytes = 0;
  for (const line of manifest.trimEnd().split(/\r?\n/u)) {
    const [kind, , digest] = line.split("\t");
    if (kind === "file" && digest) files += 1;
  }
  return { files, bytes };
}

async function directoryBytes(root: string) {
  let bytes = 0;
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const targetStat = await lstat(target);
      if (targetStat.isSymbolicLink()) throw new Error("file authority contains a symlink");
      if (targetStat.isDirectory()) await visit(target);
      else if (targetStat.isFile()) bytes += targetStat.size;
      else throw new Error("file authority contains a non-regular entry");
    }
  }
  await visit(root);
  return bytes;
}

function blobManifest(objects: readonly (LiveBlobVersion & { readonly sha256: string })[]) {
  return `directory\t700\t-\t.\n${objects.map((object) =>
    `file\t600\t${object.sha256}\t./${object.key}`
  ).join("\n")}\n`;
}

function awsEnv(
  env: NodeJS.ProcessEnv,
  authority: "source" | "recovery",
) {
  const access = authority === "recovery"
    ? env.RECOVERY_BLOB_ACCESS_KEY_ID
    : env.BLOB_ACCESS_KEY_ID ?? env.BLOB_ACCESS_KEY ?? env.AWS_ACCESS_KEY_ID;
  const secret = authority === "recovery"
    ? env.RECOVERY_BLOB_SECRET_ACCESS_KEY
    : env.BLOB_SECRET_ACCESS_KEY ?? env.BLOB_SECRET_KEY ?? env.AWS_SECRET_ACCESS_KEY;
  if (!access || !secret) throw new Error("Blob credentials are required");
  return {
    ...env,
    AWS_ACCESS_KEY_ID: access,
    AWS_SECRET_ACCESS_KEY: secret,
    AWS_REGION: authority === "recovery"
      ? env.RECOVERY_BLOB_REGION ?? "auto"
      : env.BLOB_REGION ?? "auto",
    AWS_DEFAULT_REGION: authority === "recovery"
      ? env.RECOVERY_BLOB_REGION ?? "auto"
      : env.BLOB_REGION ?? "auto",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_PAGER: "",
  };
}

function aws(
  runner: RecoveryCommandRunner,
  env: NodeJS.ProcessEnv,
  endpoint: string,
  args: readonly string[],
  stage: string,
  authority: "source" | "recovery" = "source",
) {
  return runner.run({
    command: "aws",
    args: ["--endpoint-url", endpoint, "s3api", ...args, "--no-cli-pager"],
    env: awsEnv(env, authority),
    stage,
  }).stdout.toString("utf8");
}

type RemoteBlobHead = {
  readonly ChecksumSHA256?: unknown;
  readonly ContentType?: unknown;
  readonly CacheControl?: unknown;
  readonly Metadata?: unknown;
  readonly ObjectLockMode?: unknown;
  readonly ObjectLockRetainUntilDate?: unknown;
  readonly ObjectLockLegalHoldStatus?: unknown;
};

type RecoveryObjectRetention = {
  readonly mode: "GOVERNANCE" | "COMPLIANCE";
  readonly retainUntil: string;
};

export function resolveRecoveryObjectRetention(
  source: RemoteBlobHead,
  policyStartedAt: Date,
  retentionDays: number,
): RecoveryObjectRetention {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
    throw new Error("recovery Blob retention days must be positive");
  }
  const policyUntil = policyStartedAt.getTime() + retentionDays * 86_400_000;
  const sourceUntil = typeof source.ObjectLockRetainUntilDate === "string"
    ? Date.parse(source.ObjectLockRetainUntilDate)
    : Number.NaN;
  const retainUntil = new Date(
    Number.isFinite(sourceUntil) ? Math.max(policyUntil, sourceUntil) : policyUntil,
  ).toISOString();
  const mode = source.ObjectLockMode === "GOVERNANCE" ||
      source.ObjectLockMode === "COMPLIANCE"
    ? source.ObjectLockMode
    : "COMPLIANCE";
  return { mode, retainUntil };
}

function sortedStringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, entry]) => typeof entry === "string")) return null;
  return Object.fromEntries(entries.sort(([left], [right]) =>
    left.localeCompare(right)
  )) as Record<string, string>;
}

export function buildRemoteBlobRestorePutArgs(input: {
  readonly bucket: string;
  readonly key: string;
  readonly body: string;
  readonly checksumSha256: string;
  readonly source: RemoteBlobHead;
  readonly retention?: RecoveryObjectRetention;
}) {
  const args = [
    "put-object",
    "--bucket",
    input.bucket,
    "--key",
    input.key,
    "--body",
    input.body,
    "--checksum-algorithm",
    "SHA256",
    "--checksum-sha256",
    input.checksumSha256,
  ];
  if (typeof input.source.ContentType === "string") {
    args.push("--content-type", input.source.ContentType);
  }
  if (typeof input.source.CacheControl === "string") {
    args.push("--cache-control", input.source.CacheControl);
  }
  const metadata = sortedStringRecord(input.source.Metadata);
  if (metadata) args.push("--metadata", JSON.stringify(metadata));
  const retentionMode = input.retention?.mode ?? input.source.ObjectLockMode;
  const retainUntil = input.retention?.retainUntil ??
    input.source.ObjectLockRetainUntilDate;
  if (typeof retentionMode === "string") {
    args.push("--object-lock-mode", retentionMode);
  }
  if (typeof retainUntil === "string") {
    args.push(
      "--object-lock-retain-until-date",
      retainUntil,
    );
  }
  if (typeof input.source.ObjectLockLegalHoldStatus === "string") {
    args.push(
      "--object-lock-legal-hold-status",
      input.source.ObjectLockLegalHoldStatus,
    );
  }
  args.push("--output", "json");
  return args;
}

function remoteBlobMetadata(value: RemoteBlobHead) {
  const retainUntil = typeof value.ObjectLockRetainUntilDate === "string"
    ? Date.parse(value.ObjectLockRetainUntilDate)
    : Number.NaN;
  return {
    contentType: typeof value.ContentType === "string" ? value.ContentType : null,
    cacheControl: typeof value.CacheControl === "string" ? value.CacheControl : null,
    metadata: sortedStringRecord(value.Metadata) ?? {},
    objectLockMode:
      typeof value.ObjectLockMode === "string" ? value.ObjectLockMode : null,
    objectLockRetainUntilDate:
      Number.isFinite(retainUntil)
        ? new Date(retainUntil).toISOString()
        : null,
    objectLockLegalHoldStatus:
      typeof value.ObjectLockLegalHoldStatus === "string"
        ? value.ObjectLockLegalHoldStatus
        : null,
  };
}

async function captureRemoteBlob(
  runner: RecoveryCommandRunner,
  env: NodeJS.ProcessEnv,
  plan: RecoveryRehearsalPlan,
  files: BundleFiles,
  scratch: string,
) {
  const endpoint = plan.blob.endpoint;
  const bucket = plan.blob.bucket;
  const recoveryEndpoint = plan.blob.recovery.endpoint;
  const recoveryBucket = plan.blob.recovery.bucket;
  if (!endpoint || !bucket || !recoveryEndpoint || !recoveryBucket) {
    throw new Error("remote Blob recovery authorities are incomplete");
  }
  const raw = parseJson<{
    Versions?: readonly Record<string, unknown>[];
    DeleteMarkers?: readonly Record<string, unknown>[];
  }>(aws(runner, env, endpoint, [
    "list-object-versions",
    "--bucket",
    bucket,
    "--output",
    "json",
  ], "blob_list_versions"), "blob_list_versions");
  const objects = selectLiveBlobVersions(raw);
  const proven: Array<LiveBlobVersion & {
    sha256: string;
    metadata: ReturnType<typeof remoteBlobMetadata>;
    recovery: {
      endpoint: string;
      bucket: string;
      key: string;
      versionId: string;
      checksumSha256: string;
      objectLockMode: "GOVERNANCE" | "COMPLIANCE";
      objectLockRetainUntilDate: string;
    };
  }> = [];
  const restorePrefix = `.idream-recovery/${plan.bundleName}`;
  const retentionDays = plan.blob.recovery.retentionDays;
  if (!retentionDays) throw new Error("remote Blob retention policy is incomplete");
  const retentionPolicyStartedAt = new Date();
  for (const [authority, authorityEndpoint, authorityBucket] of [
    ["source", endpoint, bucket],
    ["recovery", recoveryEndpoint, recoveryBucket],
  ] as const) {
    const versioning = parseJson<{ Status?: unknown }>(aws(
      runner,
      env,
      authorityEndpoint,
      ["get-bucket-versioning", "--bucket", authorityBucket, "--output", "json"],
      `blob_${authority}_bucket_versioning`,
      authority,
    ), `blob_${authority}_bucket_versioning`);
    if (versioning.Status !== "Enabled") {
      throw new Error(`${authority} Blob bucket versioning is not Enabled`);
    }
  }
  const objectLock = parseJson<{ ObjectLockEnabled?: unknown }>(aws(
    runner,
    env,
    recoveryEndpoint,
    ["get-object-lock-configuration", "--bucket", recoveryBucket, "--output", "json"],
    "blob_recovery_object_lock",
    "recovery",
  ), "blob_recovery_object_lock");
  if (objectLock.ObjectLockEnabled !== "Enabled") {
    throw new Error("recovery Blob bucket Object Lock is not Enabled");
  }
  const existingRecoveryPrefix = parseJson<{
    Versions?: readonly Record<string, unknown>[];
    DeleteMarkers?: readonly Record<string, unknown>[];
  }>(aws(runner, env, recoveryEndpoint, [
    "list-object-versions",
    "--bucket",
    recoveryBucket,
    "--prefix",
    `${restorePrefix}/`,
    "--output",
    "json",
  ], "blob_recovery_prefix_absence", "recovery"), "blob_recovery_prefix_absence");
  if (
    (existingRecoveryPrefix.Versions?.length ?? 0) > 0 ||
    (existingRecoveryPrefix.DeleteMarkers?.length ?? 0) > 0
  ) {
    throw new Error("remote Blob recovery prefix is not empty");
  }
  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index]!;
    const sourcePath = path.join(scratch, `blob-source-${index}`);
    const restorePath = path.join(scratch, `blob-restore-${index}`);
    const sourceHead = parseJson<RemoteBlobHead>(aws(runner, env, endpoint, [
      "head-object",
      "--bucket",
      bucket,
      "--key",
      object.key,
      "--version-id",
      object.versionId,
      "--checksum-mode",
      "ENABLED",
      "--output",
      "json",
    ], `blob_head_source_${index}`), `blob_head_source_${index}`);
    aws(runner, env, endpoint, [
      "get-object",
      "--bucket",
      bucket,
      "--key",
      object.key,
      "--version-id",
      object.versionId,
      sourcePath,
    ], `blob_get_source_${index}`);
    const sourceBytes = await readFile(sourcePath);
    if (sourceBytes.length !== object.size) {
      throw new Error(`Blob source size differs from inventory: ${object.key}`);
    }
    const restoreKey = `${restorePrefix}/${object.key}`;
    const checksumSha256 = createHash("sha256").update(sourceBytes).digest("base64");
    if (sourceHead.ChecksumSHA256 !== checksumSha256) {
      throw new Error(`remote Blob source checksum differs: ${object.key}`);
    }
    const retention = resolveRecoveryObjectRetention(
      sourceHead,
      retentionPolicyStartedAt,
      retentionDays,
    );
    const put = parseJson<{ VersionId?: unknown }>(aws(
      runner,
      env,
      recoveryEndpoint,
      buildRemoteBlobRestorePutArgs({
        bucket: recoveryBucket,
        key: restoreKey,
        body: sourcePath,
        checksumSha256,
        source: sourceHead,
        retention,
      }),
      `blob_put_restore_${index}`,
      "recovery",
    ), `blob_put_restore_${index}`);
    if (typeof put.VersionId !== "string" || put.VersionId === "null") {
      throw new Error("remote Blob restore copy did not return a version id");
    }
    aws(runner, env, recoveryEndpoint, [
      "get-object",
      "--bucket",
      recoveryBucket,
      "--key",
      restoreKey,
      "--version-id",
      put.VersionId,
      restorePath,
    ], `blob_get_restore_${index}`, "recovery");
    const restoreBytes = await readFile(restorePath);
    if (!sourceBytes.equals(restoreBytes)) {
      throw new Error(`remote Blob isolated restore differs: ${object.key}`);
    }
    const restoreHead = parseJson<RemoteBlobHead>(aws(
      runner,
      env,
      recoveryEndpoint,
      [
        "head-object",
        "--bucket",
        recoveryBucket,
        "--key",
        restoreKey,
        "--version-id",
        put.VersionId,
        "--checksum-mode",
        "ENABLED",
        "--output",
        "json",
      ],
      `blob_head_restore_${index}`,
      "recovery",
    ), `blob_head_restore_${index}`);
    if (restoreHead.ChecksumSHA256 !== checksumSha256) {
      throw new Error(`remote Blob recovery checksum differs: ${object.key}`);
    }
    const expectedRestoreMetadata = {
      ...remoteBlobMetadata(sourceHead),
      objectLockMode: retention.mode,
      objectLockRetainUntilDate: retention.retainUntil,
    };
    if (JSON.stringify(expectedRestoreMetadata) !==
        JSON.stringify(remoteBlobMetadata(restoreHead))) {
      throw new Error(`remote Blob metadata or retention differs: ${object.key}`);
    }
    proven.push({
      ...object,
      sha256: sha256(sourceBytes),
      metadata: remoteBlobMetadata(sourceHead),
      recovery: {
        endpoint: recoveryEndpoint,
        bucket: recoveryBucket,
        key: restoreKey,
        versionId: put.VersionId,
        checksumSha256,
        objectLockMode: retention.mode,
        objectLockRetainUntilDate: retention.retainUntil,
      },
    });
  }
  const manifest = blobManifest(proven);
  await writeFile(files.blobSourceManifest, manifest, { mode: 0o600 });
  await writeFile(files.blobRestoreManifest, manifest, { mode: 0o600 });
  await writeFile(files.blobInventory, `${JSON.stringify({
    provider: plan.blob.provider,
    endpoint,
    bucket,
    recoveryAuthority: plan.blob.recovery,
    objects: proven,
  }, null, 2)}\n`, { mode: 0o600 });
  return {
    manifest,
    objects: proven,
    files: proven.length,
    bytes: proven.reduce((sum, object) => sum + object.size, 0),
  };
}

function captureSourceBlobAuthority(
  runner: RecoveryCommandRunner,
  env: NodeJS.ProcessEnv,
  plan: RecoveryRehearsalPlan,
  stage: string,
) {
  const endpoint = plan.blob.endpoint;
  const bucket = plan.blob.bucket;
  if (!endpoint || !bucket) throw new Error("source Blob authority is incomplete");
  return listSourceBlobVersions(runner, env, plan, `${stage}_versions`).map(
    (object, index) => {
      const head = parseJson<RemoteBlobHead>(aws(runner, env, endpoint, [
        "head-object",
        "--bucket",
        bucket,
        "--key",
        object.key,
        "--version-id",
        object.versionId,
        "--checksum-mode",
        "ENABLED",
        "--output",
        "json",
      ], `${stage}_head_${index}`), `${stage}_head_${index}`);
      return {
        ...object,
        checksumSha256:
          typeof head.ChecksumSHA256 === "string" ? head.ChecksumSHA256 : null,
        metadata: remoteBlobMetadata(head),
      };
    },
  );
}

function expectedSourceBlobAuthority(
  objects: readonly (LiveBlobVersion & {
    readonly sha256?: string;
    readonly metadata?: ReturnType<typeof remoteBlobMetadata>;
  })[],
) {
  return objects.map((object) => ({
    key: object.key,
    versionId: object.versionId,
    etag: object.etag,
    size: object.size,
    checksumSha256: object.sha256
      ? Buffer.from(object.sha256, "hex").toString("base64")
      : null,
    metadata: object.metadata ?? null,
  }));
}

export function remoteBlobSourceAuthorityMatches(
  current: readonly {
    readonly key: string;
    readonly versionId: string;
    readonly etag: string;
    readonly size: number;
    readonly checksumSha256: string | null;
    readonly metadata: ReturnType<typeof remoteBlobMetadata>;
  }[],
  captured: readonly (LiveBlobVersion & {
    readonly sha256?: string;
    readonly metadata?: ReturnType<typeof remoteBlobMetadata>;
  })[],
) {
  return JSON.stringify(current) ===
    JSON.stringify(expectedSourceBlobAuthority(captured));
}

export function listSourceBlobVersions(
  runner: RecoveryCommandRunner,
  env: NodeJS.ProcessEnv,
  plan: RecoveryRehearsalPlan,
  stage: string,
) {
  const endpoint = plan.blob.endpoint;
  const bucket = plan.blob.bucket;
  if (!endpoint || !bucket) throw new Error("source Blob authority is incomplete");
  return selectLiveBlobVersions(parseJson<{
    Versions?: readonly Record<string, unknown>[];
    DeleteMarkers?: readonly Record<string, unknown>[];
  }>(aws(runner, env, endpoint, [
    "list-object-versions",
    "--bucket",
    bucket,
    "--output",
    "json",
  ], stage, "source"), stage));
}

async function captureLocalFiles(
  runner: RecoveryCommandRunner,
  root: string,
  archive: string,
  sourceManifestFile: string,
  restoreManifestFile: string,
  scratch: string,
  label: string,
) {
  const sourceManifest = await buildFileAuthorityManifest(root);
  await writeFile(sourceManifestFile, sourceManifest, { mode: 0o600 });
  runner.run({
    command: "tar",
    args: ["-czf", archive, "-C", path.dirname(root), path.basename(root)],
    stage: `${label}_archive`,
  });
  const restoreParent = path.join(scratch, `${label}-restore`);
  await mkdir(restoreParent, { mode: 0o700 });
  runner.run({
    command: "tar",
    args: ["-xzf", archive, "-C", restoreParent],
    stage: `${label}_restore`,
  });
  const restoredRoot = path.join(restoreParent, path.basename(root));
  const restoredManifest = await buildFileAuthorityManifest(restoredRoot);
  await writeFile(restoreManifestFile, restoredManifest, { mode: 0o600 });
  if (sourceManifest !== restoredManifest) {
    throw new Error(`${label} isolated restore manifest differs from source`);
  }
  return {
    manifest: sourceManifest,
    files: manifestCounts(sourceManifest).files,
    bytes: await directoryBytes(root),
  };
}

async function writeBundleMetadata(input: {
  plan: RecoveryRehearsalPlan;
  files: BundleFiles;
  expectedMigrations: readonly ExpectedMigration[];
  roleAuthority: RoleAuthority;
  databaseAuthority: DatabaseAuthority;
  chat: { files: number; bytes: number };
  blob: { files: number; bytes: number };
  runner: RecoveryCommandRunner;
  env: NodeJS.ProcessEnv;
  connection: RecoveryPostgresConnection;
  sourceAuthority: RecoveryRehearsalSourceAuthority;
}) {
  await writeFile(input.files.roles, `${JSON.stringify(input.roleAuthority, null, 2)}\n`, { mode: 0o600 });
  await writeFile(input.files.databaseAuthority, `${JSON.stringify(input.databaseAuthority, null, 2)}\n`, { mode: 0o600 });
  await writeFile(
    input.files.databaseAuthorityRestore,
    renderRecoveryDatabaseAuthoritySql(input.databaseAuthority),
    { mode: 0o600 },
  );
  await writeFile(input.files.fileAuthorities, `${JSON.stringify({
    chat_fs: input.chat,
    blob: {
      authorities_match: true,
      main_effective: input.plan.blob,
      gen_effective: input.plan.blob,
      ...input.blob,
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const version = (command: string, args: readonly string[], stage: string) =>
    input.runner.run({ command, args, env: input.env, stage }).stdout.toString("utf8").trim();
  const serverVersion = psql(
    input.runner,
    input.connection,
    input.env,
    "tool_server_version",
    "SHOW server_version;",
  );
  const serverVersionNum = psql(
    input.runner,
    input.connection,
    input.env,
    "tool_server_version_num",
    "SHOW server_version_num;",
  );
  await writeFile(input.files.toolVersions, `${JSON.stringify({
    bun: version("bun", ["--version"], "tool_bun_version"),
    pg_dump: version("pg_dump", ["--version"], "tool_pg_dump_version"),
    pg_restore: version("pg_restore", ["--version"], "tool_pg_restore_version"),
    psql: version("psql", ["--version"], "tool_psql_version"),
    server_version: serverVersion,
    server_version_num: serverVersionNum,
  }, null, 2)}\n`, { mode: 0o600 });
  const checkpointFiles = [
    input.files.quiescenceReceipt,
    input.files.sourceCounts,
    input.files.sourceSchema,
    input.files.sourceLogical,
    input.files.chatSourceManifest,
    input.files.blobSourceManifest,
    ...(input.plan.blob.provider === "mock" ? [] : [input.files.blobInventory]),
  ];
  const sourceCheckpointSha256 = computeRecoverySourceCheckpointSha256(
    await Promise.all(checkpointFiles.map(async (file) => ({
      filename: path.basename(file),
      bytes: await readFile(file),
    }))),
  );
  await writeFile(input.files.metadata, `${JSON.stringify({
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    sourceCheckpointSha256,
    sourceAuthority: input.sourceAuthority,
  }, null, 2)}\n`, { mode: 0o600 });
  const invocation = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `# Provenance only. Bundle ${input.plan.bundleName} was produced by the repository recovery:rehearse command.`,
    `# Migration authority: ${input.expectedMigrations.length}/${input.expectedMigrations.at(-1)?.migrationName ?? "none"}.`,
    "echo 'This proof file records provenance; use RESTORE.md for recovery.'",
    "",
  ].join("\n");
  await writeFile(input.files.proof, invocation, { mode: 0o700 });
  await writeFile(input.files.restoreRunbook, [
    `# iDream recovery rehearsal ${input.plan.bundleName}`,
    "",
    "This bundle was captured only after the production runtime and durable work reached a silent boundary.",
    "It contains a PostgreSQL custom dump and PG16-normalized SQL, an exact Chat file archive, and either a local Blob archive or a versioned remote-object inventory.",
    "",
    "1. Verify the adjacent `.sha256` manifest before reading any artifact.",
    "2. Provision the roles in `.roles.json` from the secret manager; passwords are deliberately absent.",
    "3. Create an isolated PostgreSQL 16 database with the recorded database authority, apply `.database-authority.restore.sql`, and restore `-pg16.sql` in one transaction.",
    "4. Restore Chat FS and Blob into isolated targets and compare the source manifests before any cutover.",
    "5. Never restore directly over a live authority; repeat the same quiescence and operator approval fence used by this producer.",
    "",
  ].join("\n"), { mode: 0o600 });
}

async function publishChecksums(staging: string, files: BundleFiles) {
  const entries = await readdir(staging, { withFileTypes: true });
  const artifactNames = entries
    .filter((entry) => entry.isFile() && path.join(staging, entry.name) !== files.checksums)
    .map((entry) => entry.name)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const lines: string[] = [];
  for (const name of artifactNames) {
    lines.push(`${sha256(await readFile(path.join(staging, name)))}  ${name}`);
  }
  await writeFile(files.checksums, `${lines.join("\n")}\n`, { mode: 0o600 });
  for (const entry of await readdir(staging, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`bundle contains a non-file entry: ${entry.name}`);
    await chmod(path.join(staging, entry.name), entry.name.endsWith(".proof.sh") ? 0o700 : 0o600);
  }
}

// SPEC: apply produces one immutable flat bundle after a real same-source
// PostgreSQL restore and a byte-equivalent Chat/Blob isolated restore.
// INTENT: all broad effects are created under fresh, validated names. Cleanup
// only targets the recorded restore database, staging directory, lock, and exact
// remote object versions produced by this invocation.
export async function executeRecoveryRehearsal(input: {
  readonly plan: RecoveryRehearsalPlan;
  readonly env: NodeJS.ProcessEnv;
  readonly expectedMigrations: readonly ExpectedMigration[];
  readonly workspaceRoot: string;
  readonly runner?: RecoveryCommandRunner;
  readonly inspectMigration?: typeof inspectMigrationAuthority;
}): Promise<RecoveryRehearsalExecution> {
  if (input.plan.mode !== "apply" || !input.plan.safeToApply) {
    throw new Error("recovery rehearsal apply requires a safe confirmed plan");
  }
  const runner = input.runner ?? new SystemRecoveryCommandRunner();
  // Fail before mkdir/tool preflight: no recovery effect may begin until all
  // three runtime URLs have one exact node-pg authority and libpq has no ambient
  // alternate target.
  assertNoRecoveryAmbientLibpqTargetOverrides(input.env);
  const sourceConnection = parseRecoveryPostgresConnection(
    input.env.DATABASE_URL,
    "DATABASE_URL",
  );
  const connection = parseRecoveryPostgresConnection(
    input.env.RECOVERY_DATABASE_URL,
    "RECOVERY_DATABASE_URL",
  );
  const chatConnection = parseRecoveryPostgresConnection(
    input.env.CHAT_DATABASE_URL,
    "CHAT_DATABASE_URL",
  );
  const projectorConnection = parseRecoveryPostgresConnection(
    input.env.CHAT_PROJECTOR_DATABASE_URL,
    "CHAT_PROJECTOR_DATABASE_URL",
  );
  assertSameDatabaseAuthority(
    sourceConnection,
    connection,
    "RECOVERY_DATABASE_URL",
  );
  assertSameDatabaseAuthority(sourceConnection, chatConnection, "CHAT_DATABASE_URL");
  assertSameDatabaseAuthority(
    sourceConnection,
    projectorConnection,
    "CHAT_PROJECTOR_DATABASE_URL",
  );
  if (chatConnection.user !== "chat_service") {
    throw new Error("CHAT_DATABASE_URL must use chat_service");
  }
  if (projectorConnection.user !== "chat_projector") {
    throw new Error("CHAT_PROJECTOR_DATABASE_URL must use chat_projector");
  }
  const parent = path.dirname(input.plan.bundlePath);
  const finalBundle = input.plan.bundlePath;
  const lockPath = path.join(parent, `.${input.plan.bundleName}.publish.lock`);
  let staging: string | null = null;
  let stagingParent: string | null = null;
  let scratch: string | null = null;
  let restoreDatabase: string | null = null;
  let lockHeld = false;
  let primaryError: unknown = null;

  try {
    await mkdir(parent, { mode: 0o700, recursive: true });
    await ensureRealDirectory(parent, "bundle parent");
    await lstat(finalBundle).then(
      () => { throw new Error("refusing to overwrite an existing recovery bundle"); },
      (error: unknown) => {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      },
    );
    await mkdir(lockPath, { mode: 0o700 });
    lockHeld = true;
    stagingParent = await mkdtemp(
      path.join(parent, `.${input.plan.bundleName}.staging.`),
    );
    staging = path.join(stagingParent, input.plan.bundleName);
    await mkdir(staging, { mode: 0o700 });
    scratch = await mkdtemp(path.join(tmpdir(), "idream-recovery-rehearsal-"));
    const files = bundleFiles(staging, input.plan.bundleName);

    const requiredTools: Array<readonly [string, readonly string[]]> = [
      ["bun", ["--version"]],
      ["pg_dump", ["--version"]],
      ["pg_restore", ["--version"]],
      ["psql", ["--version"]],
      ["createdb", ["--version"]],
      ["dropdb", ["--version"]],
      ["tar", ["--version"]],
      ["pm2", ["--version"]],
      ["lsof", ["-v"]],
    ];
    if (input.plan.blob.provider !== "mock") {
      requiredTools.push(["aws", ["--version"]]);
    }
    for (const [command, args] of requiredTools) {
      runner.run({ command, args, env: input.env, stage: `tool_preflight_${command}` });
    }
    const quiescenceReceipt = captureQuiescenceReceipt({
      runner,
      env: input.env,
      workspaceRoot: input.workspaceRoot,
      queueAuthority: input.plan.queueAuthority,
    });
    await writeFile(
      files.quiescenceReceipt,
      `${JSON.stringify(quiescenceReceipt, null, 2)}\n`,
      { mode: 0o600 },
    );
    assertChatDatabaseAuthority(
      runner,
      input.env,
      sourceConnection,
      chatConnection,
      "CHAT_DATABASE_URL",
      "chat_service",
      "chat_request_database_authority",
    );
    assertChatDatabaseAuthority(
      runner,
      input.env,
      sourceConnection,
      projectorConnection,
      "CHAT_PROJECTOR_DATABASE_URL",
      "chat_projector",
      "chat_projector_database_authority",
    );

    const migrationAuthority = await (
      input.inspectMigration ?? inspectMigrationAuthority
    )(input.env.RECOVERY_DATABASE_URL!);
    if (!migrationAuthority.schemaPostconditionsChecked || !migrationAuthority.ok) {
      throw new Error("source migration authority is not exact");
    }
    const sourceCounts = captureCounts(runner, connection, input.env, "source_counts");
    const countProblems = validateRecoveryCounts(
      sourceCounts,
      input.expectedMigrations.length,
      input.expectedMigrations.at(-1)?.migrationName ?? null,
    );
    if (countProblems.length > 0) throw new Error(countProblems.join("; "));
    const activeClients = psql(
      runner,
      connection,
      input.env,
      "source_active_clients",
      "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid();",
    );
    if (activeClients !== "0") throw new Error("source database has active clients");
    const superuser = psql(
      runner,
      connection,
      input.env,
      "source_restore_actor",
      "SELECT rolsuper FROM pg_roles WHERE rolname = current_user;",
    );
    if (superuser !== "t") throw new Error("restore rehearsal requires a PostgreSQL superuser actor");
    const serverVersionNum = Number.parseInt(
      psql(runner, connection, input.env, "source_postgres_version", "SHOW server_version_num;"),
      10,
    );
    if (Math.floor(serverVersionNum / 10_000) !== 16) {
      throw new Error("recovery rehearsal requires PostgreSQL 16");
    }

    const chatRoot = await ensureRealDirectory(input.plan.chatFsRoot!, "CHAT_FS_ROOT");
    const roleAuthority = parseJson<RoleAuthority>(
      psql(runner, connection, input.env, "source_role_authority", ROLE_AUTHORITY_SQL),
      "source_role_authority",
    );
    const recordedRoles = new Set(
      roleAuthority.roles_without_passwords.map((entry) => entry.role),
    );
    if (
      !["core_owner", "chat_owner", "chat_service", "chat_projector"]
        .every((role) => roleAuthority.required_roles.includes(role)) ||
      !roleAuthority.required_roles.every((role) => recordedRoles.has(role))
    ) {
      throw new Error("required PostgreSQL restore roles are missing");
    }
    const databaseAuthority = parseJson<DatabaseAuthority>(
      psql(runner, connection, input.env, "source_database_authority", DATABASE_AUTHORITY_SQL),
      "source_database_authority",
    );
    const sourceSchema = captureCanonicalSchema(runner, connection, input.env, "source_schema");
    const sourceLogical = captureLogicalManifest(
      runner,
      connection,
      input.env,
      "source_logical",
      sourceSchema,
      roleAuthority,
      databaseAuthority,
    );
    await writeFile(files.sourceCounts, `${JSON.stringify(sourceCounts, null, 2)}\n`, { mode: 0o600 });
    await writeFile(files.sourceSchema, sourceSchema, { mode: 0o600 });
    await writeFile(files.sourceLogical, sourceLogical, { mode: 0o600 });

    const chat = await captureLocalFiles(
      runner,
      chatRoot,
      files.chatArchive,
      files.chatSourceManifest,
      files.chatRestoreManifest,
      scratch,
      "chat_fs",
    );
    let blob: {
      files: number;
      bytes: number;
      manifest: string;
      objects?: readonly LiveBlobVersion[];
    };
    if (input.plan.blob.provider === "mock") {
      const blobRoot = await ensureRealDirectory(input.plan.blob.root!, "BLOB_ROOT");
      blob = await captureLocalFiles(
        runner,
        blobRoot,
        files.blobArchive,
        files.blobSourceManifest,
        files.blobRestoreManifest,
        scratch,
        "blob",
      );
    } else {
      blob = await captureRemoteBlob(
        runner,
        input.env,
        input.plan,
        files,
        scratch,
      );
    }

    runner.run({
      command: "pg_dump",
      args: [
        "--format=custom",
        "--serializable-deferrable",
        "--file",
        files.dump,
        "--dbname",
        connection.database,
      ],
      env: postgresEnv(connection, input.env),
      stage: "postgres_custom_dump",
    });
    runner.run({ command: "pg_restore", args: ["--list", files.dump], env: input.env, stage: "postgres_dump_verify" });
    const rawSql = runner.run({
      command: "pg_restore",
      args: ["--file", "-", files.dump],
      env: input.env,
      stage: "postgres_plain_export",
    }).stdout;
    await writeFile(files.sql, rawSql, { mode: 0o600 });
    await writeFile(files.pg16Sql, normalizePlainDump(rawSql), { mode: 0o600 });

    const afterDumpCounts = captureCounts(runner, connection, input.env, "post_dump_counts");
    if (JSON.stringify(afterDumpCounts) !== JSON.stringify(sourceCounts)) {
      throw new Error("source database changed during checkpoint");
    }
    if (!captureCanonicalSchema(runner, connection, input.env, "post_dump_schema").equals(sourceSchema)) {
      throw new Error("source schema changed during checkpoint");
    }
    if (captureLogicalManifest(
      runner,
      connection,
      input.env,
      "post_dump_logical",
      sourceSchema,
      roleAuthority,
      databaseAuthority,
    ) !== sourceLogical) {
      throw new Error("source logical authority changed during checkpoint");
    }
    if (await buildFileAuthorityManifest(chatRoot) !== chat.manifest) {
      throw new Error("CHAT_FS_ROOT changed during checkpoint");
    }
    if (input.plan.blob.provider === "mock") {
      if (await buildFileAuthorityManifest(input.plan.blob.root!) !== blob.manifest) {
        throw new Error("BLOB_ROOT changed during checkpoint");
      }
    } else if (!remoteBlobSourceAuthorityMatches(
      captureSourceBlobAuthority(
        runner,
        input.env,
        input.plan,
        "post_dump_blob_versions",
      ),
      blob.objects ?? [],
    )) {
      throw new Error("remote Blob authority changed during checkpoint");
    }

    restoreDatabase = `idream_restore_${input.expectedMigrations.length}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const exists = psql(
      runner,
      connection,
      input.env,
      "restore_database_absence",
      `SELECT count(*) FROM pg_database WHERE datname = ${quoteLiteral(restoreDatabase)};`,
      "postgres",
    );
    if (exists !== "0") throw new Error("restore database already exists");
    const db = databaseAuthority.database;
    const createdbArgs = [
      "--maintenance-db=postgres",
      "--template=template0",
      `--encoding=${db.encoding}`,
      `--owner=${db.owner}`,
      `--locale-provider=${db.locale_provider}`,
      `--lc-collate=${db.collate}`,
      `--lc-ctype=${db.ctype}`,
      `--tablespace=${db.tablespace}`,
    ];
    if (db.locale_provider === "icu" && db.icu_locale) {
      createdbArgs.push(`--icu-locale=${db.icu_locale}`);
      if (db.icu_rules) createdbArgs.push(`--icu-rules=${db.icu_rules}`);
    }
    createdbArgs.push(restoreDatabase);
    runner.run({
      command: "createdb",
      args: createdbArgs,
      env: postgresEnv(connection, input.env),
      stage: "restore_database_create",
    });
    const authoritySql = renderRecoveryDatabaseAuthoritySql(databaseAuthority);
    await writeFile(files.databaseAuthorityRestore, authoritySql, { mode: 0o600 });
    runner.run({
      command: "psql",
      args: [
        "-Xq",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        `target_database=${restoreDatabase}`,
        "--dbname",
        "postgres",
        "--file",
        files.databaseAuthorityRestore,
      ],
      env: postgresEnv(connection, input.env),
      stage: "restore_database_authority",
    });
    runner.run({
      command: "psql",
      args: [
        "-Xq",
        "-v",
        "ON_ERROR_STOP=1",
        "--single-transaction",
        "--dbname",
        restoreDatabase,
        "--file",
        files.pg16Sql,
      ],
      env: postgresEnv(connection, input.env),
      stage: "restore_database_apply",
    });
    const restoreCounts = captureCounts(
      runner,
      connection,
      input.env,
      "restore_counts",
      restoreDatabase,
    );
    const restoreSchema = captureCanonicalSchema(
      runner,
      connection,
      input.env,
      "restore_schema",
      restoreDatabase,
    );
    const restoreDatabaseAuthority = parseJson<DatabaseAuthority>(
      psql(runner, connection, input.env, "restore_database_authority_capture", DATABASE_AUTHORITY_SQL, restoreDatabase),
      "restore_database_authority_capture",
    );
    const restoreLogical = captureLogicalManifest(
      runner,
      connection,
      input.env,
      "restore_logical",
      restoreSchema,
      roleAuthority,
      restoreDatabaseAuthority,
      restoreDatabase,
    );
    await writeFile(files.restoreCounts, `${JSON.stringify(restoreCounts, null, 2)}\n`, { mode: 0o600 });
    await writeFile(files.restoreSchema, restoreSchema, { mode: 0o600 });
    await writeFile(files.restoreLogical, restoreLogical, { mode: 0o600 });
    if (JSON.stringify(restoreCounts) !== JSON.stringify(sourceCounts)) {
      throw new Error("isolated PostgreSQL restore counts differ from source");
    }
    if (!restoreSchema.equals(sourceSchema)) {
      throw new Error("isolated PostgreSQL restore schema differs from source");
    }
    if (restoreLogical !== sourceLogical) {
      throw new Error("isolated PostgreSQL restore logical authority differs from source");
    }
    runner.run({
      command: "dropdb",
      args: ["--maintenance-db=postgres", restoreDatabase],
      env: postgresEnv(connection, input.env),
      stage: "restore_database_cleanup",
    });
    restoreDatabase = null;

    const finalCounts = captureCounts(
      runner,
      connection,
      input.env,
      "final_source_counts",
    );
    if (JSON.stringify(finalCounts) !== JSON.stringify(sourceCounts)) {
      throw new Error("source database changed during isolated restore");
    }
    if (!captureCanonicalSchema(
      runner,
      connection,
      input.env,
      "final_source_schema",
    ).equals(sourceSchema)) {
      throw new Error("source schema changed during isolated restore");
    }
    if (captureLogicalManifest(
      runner,
      connection,
      input.env,
      "final_source_logical",
      sourceSchema,
      roleAuthority,
      databaseAuthority,
    ) !== sourceLogical) {
      throw new Error("source logical authority changed during isolated restore");
    }
    if (await buildFileAuthorityManifest(chatRoot) !== chat.manifest) {
      throw new Error("CHAT_FS_ROOT changed during isolated restore");
    }
    if (input.plan.blob.provider === "mock") {
      if (await buildFileAuthorityManifest(input.plan.blob.root!) !== blob.manifest) {
        throw new Error("BLOB_ROOT changed during isolated restore");
      }
    } else if (!remoteBlobSourceAuthorityMatches(
      captureSourceBlobAuthority(
        runner,
        input.env,
        input.plan,
        "final_source_blob_versions",
      ),
      blob.objects ?? [],
    )) {
      throw new Error("remote Blob authority changed during isolated restore");
    }
    const finalActiveClients = psql(
      runner,
      connection,
      input.env,
      "final_source_active_clients",
      "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid();",
    );
    if (finalActiveClients !== "0") {
      throw new Error("source database gained active clients during isolated restore");
    }
    const provider = input.plan.blob.provider;
    if (provider !== "mock" && provider !== "r2" && provider !== "s3") {
      throw new Error("recovery Blob provider is not exact");
    }
    const sourceAuthority: RecoveryRehearsalSourceAuthority = {
      database: {
        host: sourceConnection.host,
        port: Number.parseInt(sourceConnection.port, 10),
        database: sourceConnection.database,
      },
      chatFsRoot: chatRoot,
      queue: {
        redis: input.plan.queueAuthority.redis!,
        prefix: input.plan.queueAuthority.prefix!,
      },
      blob: {
        provider,
        endpoint: input.plan.blob.endpoint,
        bucket: input.plan.blob.bucket,
        root: input.plan.blob.root,
        recoveryRetentionDays: input.plan.blob.recovery.retentionDays,
      },
    };
    await writeBundleMetadata({
      plan: input.plan,
      files,
      expectedMigrations: input.expectedMigrations,
      roleAuthority,
      databaseAuthority,
      chat,
      blob,
      runner,
      env: input.env,
      connection,
      sourceAuthority,
    });
    await publishChecksums(staging, files);
    await chmod(staging, 0o700);
    const inspection = await inspectRecoveryRehearsalBundle({
      bundlePath: staging,
      expectedMigrations: input.expectedMigrations,
      expectedSourceAuthority: sourceAuthority,
      commandRunner: runner,
      now: new Date(),
      maxAgeMinutes: 60,
    });
    if (!inspection.ok) {
      throw new Error(
        `generated recovery bundle failed authority inspection: ${inspection.problems.join("; ")}`,
      );
    }
    await rename(staging, finalBundle);
    staging = null;
    if (stagingParent) {
      await rmdir(stagingParent);
      stagingParent = null;
    }
    return {
      ok: true,
      bundlePath: finalBundle,
      bundleName: input.plan.bundleName,
      migrationCount: input.expectedMigrations.length,
      latestMigration: input.expectedMigrations.at(-1)?.migrationName ?? "",
      blobProvider: input.plan.blob.provider ?? "unknown",
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (restoreDatabase && /^idream_restore_[0-9]+_[a-f0-9]{16}$/u.test(restoreDatabase)) {
      try {
        runner.run({
          command: "dropdb",
          args: ["--maintenance-db=postgres", "--if-exists", restoreDatabase],
          env: postgresEnv(connection, input.env),
          stage: "restore_database_failure_cleanup",
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (scratch) await rm(scratch, { force: true, recursive: true });
    if (stagingParent) await rm(stagingParent, { force: true, recursive: true });
    if (lockHeld) await rmdir(lockPath).catch((error) => cleanupErrors.push(error));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        primaryError === null ? cleanupErrors : [primaryError, ...cleanupErrors],
        "recovery rehearsal cleanup failed",
      );
    }
  }
}
