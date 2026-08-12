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
import type { ExpectedMigration } from "./migration-authority";
import { inspectMigrationAuthority } from "./migration-authority";
import { inspectRecoveryRehearsalBundle } from "./recovery-rehearsal-authority";
import {
  buildFileAuthorityManifest,
  selectLiveBlobVersions,
  validateRecoveryCounts,
  type LiveBlobVersion,
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

type PostgresConnection = {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
};

export type DatabaseAclEntry = {
  readonly grantor: string;
  readonly grantor_is_superuser: boolean;
  readonly grantee: string;
  readonly privilege: string;
  readonly grantable: boolean;
};

type DatabaseAuthority = {
  readonly database: {
    readonly owner: string;
    readonly encoding: string;
    readonly locale_provider: string;
    readonly collate: string;
    readonly ctype: string;
    readonly icu_locale: string | null;
    readonly icu_rules: string | null;
    readonly tablespace: string;
    readonly connection_limit: number;
    readonly comment: string | null;
    readonly acl_is_null: boolean;
    readonly acl: readonly DatabaseAclEntry[];
  };
  readonly database_role_settings: readonly {
    readonly role: string | null;
    readonly settings: readonly string[];
  }[];
};

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
const livePm2Statuses = new Set(["online", "launching", "one-launch-status"]);

const COUNT_SQL = String.raw`
SELECT jsonb_build_object(
  'migrations', (SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
  'latest_migration', (SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1),
  'main_outbox_pending', (SELECT count(*) FROM public.main_outbox_events WHERE status = 'pending'),
  'main_outbox_failed', (SELECT count(*) FROM public.main_outbox_events WHERE status = 'failed'),
  'inbound_event_received', (SELECT count(*) FROM public.inbound_event_receipts WHERE "processingState" = 'received'),
  'chat_outbox_pending', (SELECT count(*) FROM chat.chat_outbox_events WHERE status = 'pending'),
  'chat_outbox_failed', (SELECT count(*) FROM chat.chat_outbox_events WHERE status = 'failed'),
  'chat_inbox_pending', (SELECT count(*) FROM chat.chat_inbox_events WHERE status = 'pending'),
  'chat_inbox_failed', (SELECT count(*) FROM chat.chat_inbox_events WHERE status = 'failed'),
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

function parsePostgresConnection(raw: string | undefined): PostgresConnection {
  if (!raw) throw new Error("DATABASE_URL is required");
  const url = new URL(raw);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be PostgreSQL");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!url.hostname || !database || !url.username) {
    throw new Error("DATABASE_URL is incomplete");
  }
  return {
    host: url.hostname,
    port: url.port || "5432",
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function postgresEnv(connection: PostgresConnection, env: NodeJS.ProcessEnv) {
  return {
    ...env,
    PGHOST: connection.host,
    PGPORT: connection.port,
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
    PGDATABASE: connection.database,
  };
}

function psql(
  runner: RecoveryCommandRunner,
  connection: PostgresConnection,
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

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

// INVARIANT: a delegated GRANT can only be replayed after its grantor has the
// same privilege with grant option. Database owners and superusers are roots.
export function orderDatabaseAclEntries(
  owner: string,
  entries: readonly DatabaseAclEntry[],
) {
  const pending = [...entries];
  const ordered: DatabaseAclEntry[] = [];
  const delegated = new Map<string, Set<string>>();
  while (pending.length > 0) {
    const index = pending.findIndex((entry) =>
      entry.grantor === owner ||
      entry.grantor_is_superuser ||
      delegated.get(entry.privilege)?.has(entry.grantor)
    );
    if (index < 0) {
      throw new Error("database ACL grant chain is not replayable");
    }
    const [entry] = pending.splice(index, 1);
    ordered.push(entry!);
    if (entry!.grantable && entry!.grantee !== "PUBLIC") {
      const authorities = delegated.get(entry!.privilege) ?? new Set<string>();
      authorities.add(entry!.grantee);
      delegated.set(entry!.privilege, authorities);
    }
  }
  return ordered;
}

function databaseAuthorityRestoreSql(authority: DatabaseAuthority) {
  const database = authority.database;
  const lines = [
    "\\set ON_ERROR_STOP on",
    "\\if :{?target_database}",
    "\\else",
    "SELECT 1 / 0;",
    "\\endif",
    `SELECT format('ALTER DATABASE %I WITH CONNECTION LIMIT ${database.connection_limit}', :'target_database') \\gexec`,
    database.comment === null
      ? "SELECT format('COMMENT ON DATABASE %I IS NULL', :'target_database') \\gexec"
      : `SELECT format('COMMENT ON DATABASE %I IS %L', :'target_database', ${quoteLiteral(database.comment)}) \\gexec`,
  ];
  if (!database.acl_is_null) {
    const grantees = new Set(database.acl.map((entry) => entry.grantee));
    grantees.add("PUBLIC");
    for (const grantee of grantees) {
      const rendered = grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(grantee);
      lines.push(
        `SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM ${rendered}', :'target_database') \\gexec`,
      );
    }
    for (const entry of orderDatabaseAclEntries(database.owner, database.acl)) {
      const grantee = entry.grantee === "PUBLIC"
        ? "PUBLIC"
        : quoteIdentifier(entry.grantee);
      lines.push(`SET SESSION AUTHORIZATION ${quoteIdentifier(entry.grantor)};`);
      lines.push(
        `SELECT format('GRANT ${entry.privilege} ON DATABASE %I TO ${grantee}${entry.grantable ? " WITH GRANT OPTION" : ""}', :'target_database') \\gexec`,
      );
      lines.push("RESET SESSION AUTHORIZATION;");
    }
  }
  for (const entry of authority.database_role_settings) {
    for (const setting of entry.settings) {
      const separator = setting.indexOf("=");
      if (separator <= 0) throw new Error("database role setting is malformed");
      const name = quoteIdentifier(setting.slice(0, separator));
      const value = quoteLiteral(setting.slice(separator + 1));
      if (entry.role === null) {
        lines.push(
          `SELECT format('ALTER DATABASE %I SET ${name} TO %L', :'target_database', ${value}) \\gexec`,
        );
      } else {
        lines.push(
          `SELECT format('ALTER ROLE ${quoteIdentifier(entry.role)} IN DATABASE %I SET ${name} TO %L', :'target_database', ${value}) \\gexec`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
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

function assertRuntimeQuiescent(runner: RecoveryCommandRunner, env: NodeJS.ProcessEnv) {
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
    if (name && ownedRuntimeNames.has(name) && status && livePm2Statuses.has(status)) {
      throw new Error(`runtime is not quiescent: ${name} is ${status}`);
    }
  }
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
  }
}

function captureCounts(
  runner: RecoveryCommandRunner,
  connection: PostgresConnection,
  env: NodeJS.ProcessEnv,
  stage: string,
  database = connection.database,
) {
  return parseJson<Record<string, unknown>>(
    psql(runner, connection, env, stage, COUNT_SQL, database),
    stage,
  );
}

function captureCanonicalSchema(
  runner: RecoveryCommandRunner,
  connection: PostgresConnection,
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
  connection: PostgresConnection,
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

function awsEnv(env: NodeJS.ProcessEnv) {
  const access = env.BLOB_ACCESS_KEY_ID ?? env.BLOB_ACCESS_KEY ?? env.AWS_ACCESS_KEY_ID;
  const secret = env.BLOB_SECRET_ACCESS_KEY ?? env.BLOB_SECRET_KEY ?? env.AWS_SECRET_ACCESS_KEY;
  if (!access || !secret) throw new Error("Blob credentials are required");
  return {
    ...env,
    AWS_ACCESS_KEY_ID: access,
    AWS_SECRET_ACCESS_KEY: secret,
    AWS_REGION: env.BLOB_REGION ?? "auto",
    AWS_DEFAULT_REGION: env.BLOB_REGION ?? "auto",
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
) {
  return runner.run({
    command: "aws",
    args: ["--endpoint-url", endpoint, "s3api", ...args, "--no-cli-pager"],
    env: awsEnv(env),
    stage,
  }).stdout.toString("utf8");
}

async function captureRemoteBlob(
  runner: RecoveryCommandRunner,
  env: NodeJS.ProcessEnv,
  plan: RecoveryRehearsalPlan,
  files: BundleFiles,
  scratch: string,
  cleanupVersions: Array<{ key: string; versionId: string }>,
) {
  const endpoint = plan.blob.endpoint;
  const bucket = plan.blob.bucket;
  if (!endpoint || !bucket) throw new Error("remote Blob authority is incomplete");
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
  const proven: Array<LiveBlobVersion & { sha256: string }> = [];
  const restorePrefix = `.idream-recovery/${plan.bundleName}`;
  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index]!;
    const sourcePath = path.join(scratch, `blob-source-${index}`);
    const restorePath = path.join(scratch, `blob-restore-${index}`);
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
    const put = parseJson<{ VersionId?: unknown }>(aws(runner, env, endpoint, [
      "put-object",
      "--bucket",
      bucket,
      "--key",
      restoreKey,
      "--body",
      sourcePath,
      "--output",
      "json",
    ], `blob_put_restore_${index}`), `blob_put_restore_${index}`);
    if (typeof put.VersionId !== "string" || put.VersionId === "null") {
      throw new Error("remote Blob restore copy did not return a version id");
    }
    cleanupVersions.push({ key: restoreKey, versionId: put.VersionId });
    aws(runner, env, endpoint, [
      "get-object",
      "--bucket",
      bucket,
      "--key",
      restoreKey,
      "--version-id",
      put.VersionId,
      restorePath,
    ], `blob_get_restore_${index}`);
    const restoreBytes = await readFile(restorePath);
    if (!sourceBytes.equals(restoreBytes)) {
      throw new Error(`remote Blob isolated restore differs: ${object.key}`);
    }
    proven.push({ ...object, sha256: sha256(sourceBytes) });
  }
  const manifest = blobManifest(proven);
  await writeFile(files.blobSourceManifest, manifest, { mode: 0o600 });
  await writeFile(files.blobRestoreManifest, manifest, { mode: 0o600 });
  await writeFile(files.blobInventory, `${JSON.stringify({
    provider: plan.blob.provider,
    endpoint,
    bucket,
    objects: proven,
  }, null, 2)}\n`, { mode: 0o600 });
  return {
    manifest,
    objects: proven.map(({ sha256: _sha256, ...object }) => object),
    files: proven.length,
    bytes: proven.reduce((sum, object) => sum + object.size, 0),
  };
}

function listRemoteBlobVersions(
  runner: RecoveryCommandRunner,
  env: NodeJS.ProcessEnv,
  plan: RecoveryRehearsalPlan,
  stage: string,
) {
  const endpoint = plan.blob.endpoint;
  const bucket = plan.blob.bucket;
  if (!endpoint || !bucket) throw new Error("remote Blob authority is incomplete");
  return selectLiveBlobVersions(parseJson<{
    Versions?: readonly Record<string, unknown>[];
    DeleteMarkers?: readonly Record<string, unknown>[];
  }>(aws(runner, env, endpoint, [
    "list-object-versions",
    "--bucket",
    bucket,
    "--output",
    "json",
  ], stage), stage));
}

async function cleanupRemoteBlob(
  runner: RecoveryCommandRunner,
  env: NodeJS.ProcessEnv,
  plan: RecoveryRehearsalPlan,
  cleanupVersions: readonly { key: string; versionId: string }[],
) {
  const endpoint = plan.blob.endpoint;
  const bucket = plan.blob.bucket;
  if (!endpoint || !bucket) return;
  for (const version of cleanupVersions.toReversed()) {
    try {
      aws(runner, env, endpoint, [
        "delete-object",
        "--bucket",
        bucket,
        "--key",
        version.key,
        "--version-id",
        version.versionId,
      ], "blob_cleanup_restore_copy");
    } catch {
      // Cleanup is rechecked below and converted into a failed rehearsal.
    }
  }
  if (cleanupVersions.length > 0) {
    const raw = parseJson<{
      Versions?: readonly Record<string, unknown>[];
      DeleteMarkers?: readonly Record<string, unknown>[];
    }>(aws(runner, env, endpoint, [
      "list-object-versions",
      "--bucket",
      bucket,
      "--prefix",
      `.idream-recovery/${plan.bundleName}/`,
      "--output",
      "json",
    ], "blob_cleanup_verify"), "blob_cleanup_verify");
    if ((raw.Versions?.length ?? 0) > 0 || (raw.DeleteMarkers?.length ?? 0) > 0) {
      throw new Error("remote Blob rehearsal copies were not fully cleaned up");
    }
  }
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
  connection: PostgresConnection;
}) {
  await writeFile(input.files.roles, `${JSON.stringify(input.roleAuthority, null, 2)}\n`, { mode: 0o600 });
  await writeFile(input.files.databaseAuthority, `${JSON.stringify(input.databaseAuthority, null, 2)}\n`, { mode: 0o600 });
  await writeFile(
    input.files.databaseAuthorityRestore,
    databaseAuthorityRestoreSql(input.databaseAuthority),
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
  const connection = parsePostgresConnection(input.env.DATABASE_URL);
  const parent = path.dirname(input.plan.bundlePath);
  const finalBundle = input.plan.bundlePath;
  const lockPath = path.join(parent, `.${input.plan.bundleName}.publish.lock`);
  let staging: string | null = null;
  let stagingParent: string | null = null;
  let scratch: string | null = null;
  let restoreDatabase: string | null = null;
  let lockHeld = false;
  let primaryError: unknown = null;
  const remoteCleanupVersions: Array<{ key: string; versionId: string }> = [];

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
    assertRuntimeQuiescent(runner, input.env);

    const migrationAuthority = await (
      input.inspectMigration ?? inspectMigrationAuthority
    )(input.env.DATABASE_URL!);
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
        remoteCleanupVersions,
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
    } else if (
      JSON.stringify(listRemoteBlobVersions(
        runner,
        input.env,
        input.plan,
        "post_dump_blob_versions",
      )) !== JSON.stringify(blob.objects)
    ) {
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
    const authoritySql = databaseAuthorityRestoreSql(databaseAuthority);
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

    await cleanupRemoteBlob(runner, input.env, input.plan, remoteCleanupVersions);
    remoteCleanupVersions.splice(0);
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
    } else if (
      JSON.stringify(listRemoteBlobVersions(
        runner,
        input.env,
        input.plan,
        "final_source_blob_versions",
      )) !== JSON.stringify(blob.objects)
    ) {
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
    });
    await publishChecksums(staging, files);
    await chmod(staging, 0o700);
    const inspection = await inspectRecoveryRehearsalBundle({
      bundlePath: staging,
      expectedMigrations: input.expectedMigrations,
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
    if (remoteCleanupVersions.length > 0) {
      try {
        await cleanupRemoteBlob(runner, input.env, input.plan, remoteCleanupVersions);
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
