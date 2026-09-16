import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import IORedis from "ioredis";
import pg from "pg";
import { defaultTestDatabaseUrl } from "../../../test-database-url";
import {
  dedicatedTestRedis,
  testBullMqPrefixForDatabase,
} from "../../../test-redis";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const TEST_DATABASE_LEASE_PREFIX = "idream:main-vitest";

// SPEC: Reset the dedicated test database to a clean, seeded baseline before the
// whole Vitest run. Reuses the project's own db-push + seed scripts against a
// dedicated Postgres database/schema.
// INTENT: Deterministic suite — every run starts from the same seeded state, fully
// isolated from the dev database.
const DATABASE_URL = dedicatedTestDatabaseUrl(
  process.env.TEST_DATABASE_URL ??
    defaultTestDatabaseUrl(),
  {
    allowRemoteReset:
      process.env.TEST_DATABASE_ALLOW_REMOTE_RESET === "1",
    confirmedDatabaseName:
      process.env.TEST_DATABASE_RESET_CONFIRM,
    ci: process.env.CI === "true",
  },
);
const BULLMQ_PREFIX = testBullMqPrefixForDatabase(DATABASE_URL);

type RemoteTestDatabaseResetAuthority = {
  readonly allowRemoteReset?: boolean;
  readonly confirmedDatabaseName?: string;
  readonly ci?: boolean;
};

type TestDatabaseLease = {
  readonly release: () => Promise<void>;
};

export function dedicatedTestDatabaseUrl(
  value: string,
  authority: RemoteTestDatabaseResetAuthority = {},
) {
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(
      "Test database URL must use postgres:// or postgresql://",
    );
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(
      `Refusing to reset non-test database "${databaseName || "(missing)"}"; set TEST_DATABASE_URL to a dedicated test database`,
    );
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    if (!authority.allowRemoteReset) {
      throw new Error(
        `Refusing remote test database reset on host "${parsed.hostname || "(missing)"}"; set TEST_DATABASE_ALLOW_REMOTE_RESET=1 and TEST_DATABASE_RESET_CONFIRM=${databaseName} only in an isolated CI environment`,
      );
    }
    if (!authority.ci) {
      throw new Error(
        "Refusing remote test database reset unless CI=true",
      );
    }
    if (authority.confirmedDatabaseName !== databaseName) {
      throw new Error(
        `Remote test database reset confirmation does not match "${databaseName}"`,
      );
    }
  }
  return value;
}

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

export function testDatabaseLeaseIdentity(url: string) {
  return JSON.stringify({
    database: postgresDatabase(url),
    schema: postgresSchema(url),
  });
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function acquireTestDatabaseLease(
  url: string,
): Promise<TestDatabaseLease> {
  const client = new pg.Client({
    connectionString: postgresUrl(url),
    application_name: "idream-main-vitest-lease",
  });
  await client.connect();
  const identity = `${TEST_DATABASE_LEASE_PREFIX}:${testDatabaseLeaseIdentity(url)}`;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired",
      [identity],
    );
    if (!result.rows[0]?.acquired) {
      throw new Error(
        `Refusing to reset "${postgresDatabase(url)}.${postgresSchema(url)}": another Main test run is active for this database`,
      );
    }
  } catch (error) {
    await client.end();
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query(
          "select pg_advisory_unlock(hashtextextended($1, 0))",
          [identity],
        );
      } finally {
        await client.end();
      }
    },
  };
}

async function ensureDatabase(url: string) {
  const databaseName = postgresDatabase(url);
  if (!databaseName || databaseName === "postgres") return;

  const client = new pg.Client({ connectionString: postgresUrl(url, "postgres") });
  await client.connect();
  const provisioningIdentity =
    `${TEST_DATABASE_LEASE_PREFIX}:provision:${databaseName}`;
  try {
    await client.query(
      "select pg_advisory_lock(hashtextextended($1, 0))",
      [provisioningIdentity],
    );
    try {
      const existing = await client.query(
        "select 1 from pg_database where datname = $1",
        [databaseName],
      );
      if (existing.rowCount === 0) {
        await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      }
    } finally {
      await client.query(
        "select pg_advisory_unlock(hashtextextended($1, 0))",
        [provisioningIdentity],
      );
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

async function alignDeferrableAuthorityConstraints(url: string) {
  const client = new pg.Client({
    connectionString: postgresUrl(url),
    options: `-c search_path=${quoteIdentifier(postgresSchema(url))}`,
  });
  await client.connect();
  try {
    for (const constraint of [
      "character_serving_characterId_fkey",
      "character_serving_currentReleaseId_fkey",
    ]) {
      await client.query(
        `ALTER TABLE "character_serving" ALTER CONSTRAINT ${quoteIdentifier(constraint)} DEFERRABLE INITIALLY IMMEDIATE`,
      );
    }
  } finally {
    await client.end();
  }
}

async function installInvariantAuthorityConstraints(url: string) {
  const schema = postgresSchema(url);
  const source = await readFile(
    new URL(
      "../../../prisma/manual/2026-08-03-invariant-collapse-check-constraints.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const sql = source.replaceAll("public.", `${quoteIdentifier(schema)}.`);
  const client = new pg.Client({ connectionString: postgresUrl(url) });
  await client.connect();
  try {
    await client.query(sql);
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await client.query(await readFile(new URL(
      "../../../prisma/migrations/20260909090500_voice_clip_billing_authority/migration.sql",
      import.meta.url,
    ), "utf8"));
    // db push cannot install triggers/CHECKs. This newly reset, pre-seed table
    // is empty: recreate it from the complete immutable migration, with no
    // copied cash constraints or edits to already-applied migration history.
    const captures = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM "cash_capture_facts"');
    if (captures.rows[0]?.count !== "0") throw new Error("Refusing to recreate a nonempty cash capture table");
    const immutable = await client.query<{ present: boolean }>("SELECT to_regprocedure('reject_admin_evidence_update()') IS NOT NULL AS present");
    if (!immutable.rows[0]?.present) {
      const immutableMigration = await readFile(new URL(
        "../../../prisma/migrations/20260711120000_immutable_admin_evidence/migration.sql",
        import.meta.url,
      ), "utf8");
      // This fixed, immutable migration defines the shared function before its
      // first trigger. Require the exact boundary instead of copying the body.
      const boundary = "CREATE TRIGGER analytics_events_immutable\n";
      const functionEnd = immutableMigration.indexOf(boundary);
      if (functionEnd <= 0) throw new Error("Immutable evidence function migration boundary changed");
      await client.query(immutableMigration.slice(0, functionEnd));
    }
    await client.query('DROP TABLE "cash_capture_facts"');
    await client.query(await readFile(new URL(
      "../../../prisma/migrations/20260913090000_cash_capture_facts/migration.sql",
      import.meta.url,
    ), "utf8"));
    await installReleaseManifestContract(client);
  } finally {
    await client.end();
  }
}

// SPEC: 把 Release placement manifest 的数据库契约函数装进测试库。
// INTENT: 2026-09-05 共享 Zod 契约取消了逐图审核决定，数据库里的同名契约没跟上，于是每一次
//         角色发布都在执行器里回滚 —— 而 12 处 publish 集成用例全绿，因为 db push 装不了函数。
//         只装这两个纯函数（不装任何触发器），既不改变任何既有写入行为，又让契约对齐用例
//         能把同一组样本同时喂给 Zod 和真实 SQL。
async function installReleaseManifestContract(client: pg.Client) {
  const parityMigration = await readFile(new URL(
    "../../../prisma/migrations/20260717031000_live_public_release_manifest_exact_parity/migration.sql",
    import.meta.url,
  ), "utf8");
  // 这个固定的历史 migration 先定义 trim_ecmascript_whitespace，再定义 manifest 契约函数。
  // 按这个边界切，只取前者，后者由下面那条最新 migration 给出当前定义。
  const boundary = "CREATE OR REPLACE FUNCTION assert_character_release_asset_manifest_v2(";
  const trimFunctionEnd = parityMigration.indexOf(boundary);
  if (trimFunctionEnd <= 0) {
    throw new Error("Release manifest parity migration boundary changed");
  }
  const trimFunction = parityMigration.slice(0, trimFunctionEnd).replace(/^BEGIN;/, "");
  const installed = await client.query<{ present: boolean }>(
    "SELECT to_regprocedure('trim_ecmascript_whitespace(text)') IS NOT NULL AS present",
  );
  if (!installed.rows[0]?.present) await client.query(trimFunction);
  await client.query(await readFile(new URL(
    "../../../prisma/migrations/20260913120000_release_manifest_optional_review_lineage/migration.sql",
    import.meta.url,
  ), "utf8"));
}

export default async function setup() {
  const childEnv = {
    ...process.env,
    DB_PROVIDER: "postgresql",
    DATABASE_URL,
    BULLMQ_PREFIX,
  };

  await ensureDatabase(DATABASE_URL);
  const databaseLease = await acquireTestDatabaseLease(DATABASE_URL);
  try {
    await resetSchema(DATABASE_URL);

    const options = { stdio: "inherit" as const, env: childEnv };
    execFileSync("node", ["scripts/db-push.mjs"], options);
    await installInvariantAuthorityConstraints(DATABASE_URL);
    await alignDeferrableAuthorityConstraints(DATABASE_URL);
    execFileSync("npx", ["tsx", "prisma/seed.ts"], options);

    const redisIsolation = dedicatedTestRedis({
      url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15",
      prefix: BULLMQ_PREFIX,
    });
    const redis = new IORedis(redisIsolation.url);
    try {
      let cursor = "0";
      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          redisIsolation.keyPattern,
          "COUNT",
          1_000,
        );
        cursor = nextCursor;
        if (keys.length > 0) await redis.unlink(...keys);
      } while (cursor !== "0");
    } finally {
      await redis.quit();
    }
  } catch (error) {
    await databaseLease.release();
    throw error;
  }

  return async () => {
    await databaseLease.release();
  };
}
