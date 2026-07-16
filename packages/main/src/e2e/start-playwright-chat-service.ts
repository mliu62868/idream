import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import IORedis from "ioredis";
import pg from "pg";
import {
  assertPlaywrightChatDatabaseUrl,
  assertPlaywrightDatabaseUrl,
} from "../../playwright-environment";

const mainDir = path.resolve(import.meta.dirname, "../..");
const chatDir = path.resolve(mainDir, "../chat");

async function preparePlaywrightAuthority() {
  const databaseURL = assertPlaywrightDatabaseUrl(
    process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "",
  );
  const chatDatabaseURL = assertPlaywrightChatDatabaseUrl(
    process.env.CHAT_DATABASE_URL ?? "",
    databaseURL,
  );
  const database = new URL(databaseURL);
  const databaseName = decodeURIComponent(database.pathname.replace(/^\//, ""));
  const superUser = decodeURIComponent(database.username);
  const superPassword = decodeURIComponent(database.password);
  if (!superUser) {
    throw new Error(
      "Playwright authority database URL must include its provisioning user",
    );
  }

  process.env.CHAT_TEST_DB = databaseName;
  process.env.CHAT_TEST_REQUIRE_PLAYWRIGHT = "1";
  process.env.PG_SUPER = superUser;
  process.env.PGHOST = database.hostname;
  process.env.PGPORT = database.port || "5432";
  process.env.PGPASSWORD = superPassword;
  process.env.SUPER_PASSWORD = superPassword;
  process.env.POSTGRES_PASSWORD = superPassword;

  const provisionModuleUrl = pathToFileURL(
    path.resolve(chatDir, "test/provision.mjs"),
  ).href;
  const provisionModule = await import(provisionModuleUrl) as {
    provisionChatTestDb: () => {
      superUrl: string;
      chatServiceUrl: string;
    };
  };
  const provisioned = provisionModule.provisionChatTestDb();
  assertSameDatabase(databaseURL, provisioned.superUrl);
  assertSameDatabase(
    chatDatabaseURL,
    assertPlaywrightChatDatabaseUrl(
      provisioned.chatServiceUrl,
      databaseURL,
    ),
  );

  const childEnv = {
    ...process.env,
    APP_ENV: "test",
    DB_PROVIDER: "postgresql",
    TEST_DATABASE_URL: databaseURL,
    DATABASE_URL: databaseURL,
    CHAT_DATABASE_URL: chatDatabaseURL,
  };
  await alignDeferrableAuthorityConstraints(databaseURL);
  execFileSync("npx", ["tsx", "prisma/seed.ts"], {
    cwd: mainDir,
    stdio: "inherit",
    env: childEnv,
  });
  execFileSync("bun", ["run", "db:generate"], {
    cwd: chatDir,
    stdio: "inherit",
    env: childEnv,
  });

  const redis = new IORedis(
    process.env.CHAT_REDIS_URL ??
      process.env.REDIS_URL ??
      "",
    { maxRetriesPerRequest: null },
  );
  try {
    await redis.flushdb();
  } finally {
    await redis.quit();
  }

  const chatFsRoot = process.env.CHAT_FS_ROOT;
  if (
    !chatFsRoot ||
    !path.isAbsolute(chatFsRoot) ||
    !path.basename(chatFsRoot).startsWith("playwright-chat-")
  ) {
    throw new Error(
      "CHAT_FS_ROOT must be an absolute Playwright-only chat directory",
    );
  }
  await rm(chatFsRoot, { recursive: true, force: true });
  await mkdir(chatFsRoot, { recursive: true });
}

async function alignDeferrableAuthorityConstraints(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const constraint of [
      "character_serving_characterId_fkey",
      "character_serving_currentReleaseId_fkey",
      "character_serving_scheduledReleaseId_fkey",
    ]) {
      await client.query(
        `ALTER TABLE "character_serving" ALTER CONSTRAINT ${quoteIdentifier(constraint)} DEFERRABLE INITIALLY IMMEDIATE`,
      );
    }
  } finally {
    await client.end();
  }
}

function assertSameDatabase(expectedValue: string, actualValue: string) {
  const expected = new URL(expectedValue);
  const actual = new URL(actualValue);
  if (
    expected.hostname !== actual.hostname ||
    (expected.port || "5432") !== (actual.port || "5432") ||
    expected.pathname !== actual.pathname
  ) {
    throw new Error(
      "Playwright Chat provisioning returned an unexpected database authority",
    );
  }
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

await preparePlaywrightAuthority();
await import(pathToFileURL(path.resolve(chatDir, "src/main.ts")).href);
