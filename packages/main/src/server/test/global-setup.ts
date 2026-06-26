import { execFileSync } from "node:child_process";
import IORedis from "ioredis";
import pg from "pg";

// SPEC: Reset the dedicated test database to a clean, seeded baseline before the
// whole Vitest run. Reuses the project's own db-push + seed scripts against a
// dedicated Postgres database/schema.
// INTENT: Deterministic suite — every run starts from the same seeded state, fully
// isolated from the dev database.
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/idream_test";

function postgresUrl(url: string, databaseName?: string) {
  const parsed = new URL(url);
  parsed.searchParams.delete("schema");
  if (databaseName) parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function postgresDatabase(url: string) {
  const parsed = new URL(url);
  return decodeURIComponent(parsed.pathname.replace(/^\//, ""));
}

function postgresSchema(url: string) {
  return new URL(url).searchParams.get("schema") ?? "public";
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function ensureDatabase(url: string) {
  const databaseName = postgresDatabase(url);
  if (!databaseName || databaseName === "postgres") return;

  const client = new pg.Client({ connectionString: postgresUrl(url, "postgres") });
  await client.connect();
  try {
    const existing = await client.query("select 1 from pg_database where datname = $1", [
      databaseName,
    ]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    }
  } finally {
    await client.end();
  }
}

async function resetSchema(url: string) {
  const schema = postgresSchema(url);
  const client = new pg.Client({ connectionString: postgresUrl(url) });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  } finally {
    await client.end();
  }
}

export default async function setup() {
  const childEnv = {
    ...process.env,
    DB_PROVIDER: "postgresql",
    DATABASE_URL,
  };

  await ensureDatabase(DATABASE_URL);
  await resetSchema(DATABASE_URL);

  const options = { stdio: "inherit" as const, env: childEnv };
  execFileSync("node", ["scripts/db-push.mjs"], options);
  execFileSync("npx", ["tsx", "prisma/seed.ts"], options);

  const redis = new IORedis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15");
  try {
    await redis.flushdb();
  } finally {
    await redis.quit();
  }
}
