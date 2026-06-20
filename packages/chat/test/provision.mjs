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
const SUPER = process.env.PG_SUPER ?? process.env.USER ?? "postgres";
const HOST = process.env.PGHOST ?? "localhost";
const PORT = process.env.PGPORT ?? "5432";

function psqlSuper(db, sql) {
  execFileSync("psql", ["-U", SUPER, "-h", HOST, "-p", PORT, "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

export function provisionChatTestDb() {
  // 1. fresh database
  psqlSuper("postgres", `DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`);
  psqlSuper("postgres", `CREATE DATABASE ${DB};`);

  // 2. main schema → public, via main's own db-push (handles db-provider switch).
  //    Restore the schema provider to sqlite afterward so main's portable
  //    dev/test loop is never left in a postgres state by a chat test run.
  const url = `postgresql://${SUPER}@${HOST}:${PORT}/${DB}`;
  try {
    execFileSync("node", ["scripts/db-push.mjs"], {
      cwd: mainDir,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, DB_PROVIDER: "postgresql", DATABASE_URL: url },
    });
  } finally {
    execFileSync("node", ["scripts/db-provider.mjs"], {
      cwd: mainDir,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, DB_PROVIDER: "sqlite" },
    });
  }

  // 3. boundary SQL + assertions
  execFileSync("bash", [path.join(repoRoot, "db", "sql", "apply-validate.sh")], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, DB, SUPER },
  });

  return { db: DB, superUrl: url, chatServiceUrl: `postgresql://chat_service@${HOST}:${PORT}/${DB}` };
}
