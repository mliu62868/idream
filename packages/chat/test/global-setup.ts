// Provision the chat test DB once per run (Postgres-only — chat is PG-native).
// If Postgres is unreachable, fail loudly: the boundary tests are the whole point
// of P0-1 and silently skipping would hide a broken split.
import IORedis from "ioredis";
import { provisionChatTestDb } from "./provision.mjs";

export default async function setup() {
  const { chatServiceUrl, superUrl } = provisionChatTestDb();
  process.env.CHAT_DATABASE_URL = chatServiceUrl;
  process.env.CHAT_TEST_SUPER_URL = superUrl;

  // Dedicated Redis db for chat tests; flush so queues start empty.
  const redisUrl = process.env.CHAT_REDIS_URL ?? "redis://127.0.0.1:6379/14";
  process.env.CHAT_REDIS_URL = redisUrl;
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  try {
    await redis.flushdb();
  } finally {
    await redis.quit();
  }
}
