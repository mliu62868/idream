// Provision a Postgres test DB for the chat service:
//   1. (re)create the database as superuser
//   2. push main's Prisma schema into public (base tables the views read)
//   3. apply the P0-1 boundary SQL (schemas/roles/views/chat tables/grants)
// Honours env: CHAT_TEST_DB, PG_SUPER. Designed for local dev + CI (a PG with a
// superuser). No-ops gracefully if PG is unreachable (caller decides to skip).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const mainDir = path.join(repoRoot, "packages", "main");

const TEST_DATABASE_TOKEN = /(^|[_-])test([_-]|$)/i;
const PLAYWRIGHT_DATABASE_TOKEN = /(^|[_-])playwright([_-]|$)/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function userInfo(user, password) {
  return `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ""}`;
}

function psqlSuper(target, db, sql) {
  execFileSync("psql", ["-U", target.superUser, "-h", target.host, "-p", target.port, "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], {
    env: { ...process.env, PGPASSWORD: target.superPassword },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

export function provisionChatTestDb() {
  const target = chatTestDatabaseTarget();
  const db = assertSafeChatTestDatabaseName(target.database, {
    requirePlaywright: process.env.CHAT_TEST_REQUIRE_PLAYWRIGHT === "1",
  });
  assertSafeChatTestDatabaseTarget(target, {
    allowRemoteReset:
      process.env.CHAT_TEST_ALLOW_REMOTE_RESET === "1",
    ci: process.env.CI === "true",
    confirmedDatabaseName:
      process.env.CHAT_TEST_RESET_CONFIRM,
  });

  // 1. fresh database
  psqlSuper(target, "postgres", `DROP DATABASE IF EXISTS ${db} WITH (FORCE);`);
  psqlSuper(target, "postgres", `CREATE DATABASE ${db};`);

  // 2. main schema → public, via main's own Postgres db-push.
  const url = `postgresql://${userInfo(target.superUser, target.superPassword)}@${target.host}:${target.port}/${db}`;
  execFileSync("node", ["scripts/db-push.mjs"], {
    cwd: mainDir,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, DATABASE_URL: url },
  });

  // 3. boundary SQL + assertions. Apply twice so the suite proves the SQL is
  // genuinely idempotent against its own latest view/table shape, not merely
  // installable on a fresh database.
  for (let pass = 0; pass < 2; pass += 1) {
    execFileSync("bash", [path.join(repoRoot, "db", "sql", "apply-validate.sh")], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        DB: db,
        SUPER: target.superUser,
        SUPER_PASSWORD: target.superPassword,
        CHAT_SERVICE_PASSWORD: target.chatServicePassword,
        PGHOST: target.host,
        PGPORT: target.port,
      },
    });
  }

  return {
    db,
    superUrl: url,
    chatServiceUrl: `postgresql://${userInfo("chat_service", target.chatServicePassword)}@${target.host}:${target.port}/${db}`,
  };
}

export function chatTestDatabaseNameForWorkspace(
  workspaceRoot,
  isLinkedWorktree,
) {
  if (!isLinkedWorktree) return "idream_chat_test";
  const resolvedRoot = path.resolve(workspaceRoot);
  const suffix = path.basename(resolvedRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(-32);
  const digest = createHash("sha256")
    .update(resolvedRoot)
    .digest("hex")
    .slice(0, 8);
  return `idream_chat_test_${suffix || "worktree"}_${digest}`;
}

export function defaultChatTestDatabaseName() {
  let linkedWorktree = false;
  try {
    linkedWorktree = statSync(path.join(repoRoot, ".git")).isFile();
  } catch {
    // CI source archives without Git metadata use the stable isolated default.
  }
  return chatTestDatabaseNameForWorkspace(repoRoot, linkedWorktree);
}

export function chatTestDatabaseTarget() {
  return {
    database:
      process.env.CHAT_TEST_DB ??
      defaultChatTestDatabaseName(),
    host: process.env.PGHOST ?? "localhost",
    port: process.env.PGPORT ?? "5433",
    superUser: process.env.PG_SUPER ?? "postgres",
    superPassword:
      process.env.PGPASSWORD ??
      process.env.POSTGRES_PASSWORD ??
      "postgres",
    chatServicePassword:
      process.env.CHAT_SERVICE_PASSWORD ??
      "chat_service_change_me",
  };
}

export function assertSafeChatTestDatabaseTarget(
  target,
  authority = {},
) {
  assertSafeChatTestDatabaseName(target.database);
  const hostname = String(target.host ?? "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    if (!authority.allowRemoteReset) {
      throw new Error(
        `Refusing remote chat test database reset on host "${target.host || "(missing)"}"`,
      );
    }
    if (!authority.ci) {
      throw new Error(
        "Refusing remote chat test database reset unless CI=true",
      );
    }
    if (authority.confirmedDatabaseName !== target.database) {
      throw new Error(
        `Remote chat test database reset confirmation does not match "${target.database}"`,
      );
    }
  }
  return target;
}

export function chatTestBullMqPrefix(target) {
  const identity = JSON.stringify({
    database: target.database,
    host: String(target.host).replace(/^\[|\]$/g, "").toLowerCase(),
    port: target.port || "5432",
  });
  const digest = createHash("sha256").update(identity).digest("hex");
  return `idream:chat:test:${digest}`;
}

export function assertSafeChatTestDatabaseName(
  value,
  { requirePlaywright = false } = {},
) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_]+$/.test(value) ||
    Buffer.byteLength(value, "utf8") > 63 ||
    !TEST_DATABASE_TOKEN.test(value)
  ) {
    throw new Error(
      `Refusing to recreate non-test chat database "${String(value || "(missing)")}"`,
    );
  }
  if (requirePlaywright && !PLAYWRIGHT_DATABASE_TOKEN.test(value)) {
    throw new Error(
      `Refusing Playwright chat database "${value}"; the database name must contain both test and playwright`,
    );
  }
  return value;
}
