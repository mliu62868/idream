// Provision the chat test DB once per run (Postgres-only — chat is PG-native).
// If Postgres is unreachable, fail loudly: the boundary tests are the whole point
// of P0-1 and silently skipping would hide a broken split.
import IORedis from "ioredis";
import pg from "pg";
import {
  assertSafeChatTestDatabaseTarget,
  chatTestBullMqPrefix,
  chatTestDatabaseTarget,
  provisionChatTestDb,
} from "./provision.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const TEST_PREFIX_TOKEN = /(^|[:_-])test([:_-]|$)/i;

type ChatTestLeaseInput = {
  readonly database: string;
  readonly host: string;
  readonly password: string;
  readonly port: string;
  readonly user: string;
};

type ChatTestLease = {
  readonly release: () => Promise<void>;
};

export async function acquireChatTestDatabaseLease(
  input: ChatTestLeaseInput,
): Promise<ChatTestLease> {
  const client = new pg.Client({
    application_name: "idream-chat-vitest-lease",
    database: "postgres",
    host: input.host,
    password: input.password,
    port: Number.parseInt(input.port, 10),
    user: input.user,
  });
  await client.connect();
  const identity = `idream:chat-vitest:${input.database}`;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired",
      [identity],
    );
    if (!result.rows[0]?.acquired) {
      throw new Error(
        `Refusing to recreate "${input.database}": another Chat test run is active`,
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

export function dedicatedChatTestRedis(input: {
  readonly prefix: string;
  readonly url: string;
}) {
  const parsed = new URL(input.url);
  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing external test Redis host "${parsed.hostname || "(missing)"}"`,
    );
  }
  const databaseText = parsed.pathname.replace(/^\//, "");
  const database = Number.parseInt(databaseText, 10);
  if (
    !/^\d+$/.test(databaseText) ||
    !Number.isInteger(database) ||
    database <= 0
  ) {
    throw new Error(
      "Refusing Redis DB 0 or an invalid DB for Chat tests",
    );
  }
  if (!TEST_PREFIX_TOKEN.test(input.prefix)) {
    throw new Error(
      `Refusing non-test BullMQ prefix "${input.prefix || "(missing)"}"`,
    );
  }
  return {
    keyPattern: `${input.prefix}:*`,
    prefix: input.prefix,
    url: parsed.toString(),
  } as const;
}

export default async function setup() {
  const target = chatTestDatabaseTarget();
  assertSafeChatTestDatabaseTarget(target, {
    allowRemoteReset:
      process.env.CHAT_TEST_ALLOW_REMOTE_RESET === "1",
    ci: process.env.CI === "true",
    confirmedDatabaseName:
      process.env.CHAT_TEST_RESET_CONFIRM,
  });
  const lease = await acquireChatTestDatabaseLease({
    database: target.database,
    host: target.host,
    password: target.superPassword,
    port: target.port,
    user: target.superUser,
  });
  try {
    process.env.CHAT_TEST_DB = target.database;
    process.env.BULLMQ_PREFIX = chatTestBullMqPrefix(target);
    const { chatServiceUrl, superUrl } = provisionChatTestDb();
    process.env.CHAT_DATABASE_URL = chatServiceUrl;
    process.env.CHAT_TEST_SUPER_URL = superUrl;

    const redisIsolation = dedicatedChatTestRedis({
      prefix: process.env.BULLMQ_PREFIX,
      url:
        process.env.CHAT_TEST_REDIS_URL ??
        "redis://127.0.0.1:6379/14",
    });
    process.env.CHAT_REDIS_URL = redisIsolation.url;
    const redis = new IORedis(redisIsolation.url, {
      maxRetriesPerRequest: null,
    });
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
    await lease.release();
    throw error;
  }

  return async () => {
    await lease.release();
  };
}
