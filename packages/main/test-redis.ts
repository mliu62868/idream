import { createHash } from "node:crypto";

const TEST_PREFIX_TOKEN = /(^|[:_-])(test|e2e|playwright)([:_-]|$)/i;
const SAFE_PREFIX = /^[a-z0-9:_-]+$/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function testBullMqPrefixForDatabase(databaseUrl: string) {
  const parsed = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("Test database URL must use postgres:// or postgresql://");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) {
    throw new Error("Test database URL must include a database name");
  }
  const identity = JSON.stringify({
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    database,
    schema: parsed.searchParams.get("schema") ?? "public",
  });
  const digest = createHash("sha256").update(identity).digest("hex");
  return `idream:test:${digest}`;
}

export function dedicatedTestRedis(input: {
  readonly url: string;
  readonly prefix: string;
}) {
  const parsed = new URL(input.url);
  if (!["redis:", "rediss:"].includes(parsed.protocol)) {
    throw new Error("Test Redis URL must use redis:// or rediss://");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
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
      "Refusing Redis DB 0 or an invalid DB; tests require a dedicated non-zero logical database",
    );
  }
  if (
    !SAFE_PREFIX.test(input.prefix) ||
    !TEST_PREFIX_TOKEN.test(input.prefix)
  ) {
    throw new Error(
      `Refusing non-test BullMQ prefix "${input.prefix || "(missing)"}"`,
    );
  }
  return {
    url: parsed.toString(),
    prefix: input.prefix,
    keyPattern: `${input.prefix}:*`,
  } as const;
}
