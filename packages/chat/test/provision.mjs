// Provision a Postgres test DB for the chat service:
//   1. (re)create the database as superuser
//   2. push main's Prisma schema into public (base tables the views read)
//   3. apply the P0-1 boundary SQL (schemas/roles/views/chat tables/grants)
// Honours env: CHAT_TEST_DB, PG_SUPER. Designed for local dev + CI (a PG with a
// superuser). No-ops gracefully if PG is unreachable (caller decides to skip).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const mainDir = path.join(repoRoot, "packages", "main");

const DB = process.env.CHAT_TEST_DB ?? "idream_chat_test";
const SUPER = process.env.PG_SUPER ?? "postgres";
const HOST = process.env.PGHOST ?? "localhost";
const PORT = process.env.PGPORT ?? "5433";
const SUPER_PASSWORD = process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD ?? "postgres";
const CHAT_SERVICE_PASSWORD = process.env.CHAT_SERVICE_PASSWORD ?? "chat_service_change_me";

function userInfo(user, password) {
  return `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ""}`;
}

function psqlSuper(db, sql) {
  execFileSync("psql", ["-U", SUPER, "-h", HOST, "-p", PORT, "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], {
    env: { ...process.env, PGPASSWORD: SUPER_PASSWORD },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

export function provisionChatTestDb() {
  // 1. fresh database
  psqlSuper("postgres", `DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`);
  psqlSuper("postgres", `CREATE DATABASE ${DB};`);

  // 2. main schema → public, via main's own Postgres db-push.
  const url = `postgresql://${userInfo(SUPER, SUPER_PASSWORD)}@${HOST}:${PORT}/${DB}`;
  execFileSync("node", ["scripts/db-push.mjs"], {
    cwd: mainDir,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, DATABASE_URL: url },
  });

  // 3. boundary SQL + assertions
  execFileSync("bash", [path.join(repoRoot, "db", "sql", "apply-validate.sh")], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      DB,
      SUPER,
      SUPER_PASSWORD,
      CHAT_SERVICE_PASSWORD,
      PGHOST: HOST,
      PGPORT: PORT,
    },
  });

  return {
    db: DB,
    superUrl: url,
    chatServiceUrl: `postgresql://${userInfo("chat_service", CHAT_SERVICE_PASSWORD)}@${HOST}:${PORT}/${DB}`,
  };
}
