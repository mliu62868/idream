import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import IORedis from "ioredis";

// SPEC: Reset the dedicated test database to a clean, seeded baseline before the
// whole Vitest run. Reuses the project's own db-push + seed scripts (the custom
// db-push.mjs is required because the better-sqlite3 driver-adapter datasource is
// not compatible with `prisma db push`). Honours DB_PROVIDER/DATABASE_URL so the
// same suite runs against SQLite locally and Postgres in the dual-DB CI matrix.
// INTENT: Deterministic suite — every run starts from the same seeded state, fully
// isolated from the dev database.
const DB_PROVIDER = process.env.DB_PROVIDER ?? "sqlite";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  (DB_PROVIDER === "sqlite"
    ? "file:./prisma/test.db"
    : "postgresql://postgres:postgres@localhost:5432/idream_test");

function sqliteFile(url: string) {
  if (!url.startsWith("file:")) return undefined;
  return path.resolve(url.slice("file:".length));
}

export default async function setup() {
  const childEnv = {
    ...process.env,
    DB_PROVIDER,
    DATABASE_URL,
  };

  if (DB_PROVIDER === "sqlite") {
    const dbFile = sqliteFile(DATABASE_URL);
    if (dbFile) {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        const candidate = `${dbFile}${suffix}`;
        if (existsSync(candidate)) rmSync(candidate);
      }
    }
  }

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
