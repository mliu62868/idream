import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dedicatedTestRedis,
  testBullMqPrefixForDatabase,
} from "../../../test-redis";

describe("test Redis isolation guard", () => {
  it("accepts loopback, a non-zero DB, and a test-scoped prefix", () => {
    expect(dedicatedTestRedis({
      url: "redis://127.0.0.1:6379/15",
      prefix: "idream:test",
    })).toMatchObject({
      prefix: "idream:test",
      keyPattern: "idream:test:*",
    });
  });

  it("accepts the bracketed IPv6 loopback form returned by URL parsing", () => {
    expect(dedicatedTestRedis({
      url: "redis://[::1]:6379/15",
      prefix: "idream:test:ipv6",
    })).toMatchObject({
      prefix: "idream:test:ipv6",
      keyPattern: "idream:test:ipv6:*",
    });
  });

  it.each([
    ["redis://127.0.0.1:6379/0", "idream:test"],
    ["redis://redis.internal:6379/15", "idream:test"],
    ["redis://127.0.0.1:6379/15", "idream:development"],
  ])("refuses unsafe Redis isolation %s with %s", (url, prefix) => {
    expect(() => dedicatedTestRedis({ url, prefix })).toThrow(/Refusing/);
  });

  it("derives a distinct safe queue namespace from each isolated test database", () => {
    const first = testBullMqPrefixForDatabase(
      "postgresql://postgres:postgres@localhost:5433/idream_test_agent_a",
    );
    const second = testBullMqPrefixForDatabase(
      "postgresql://postgres:postgres@localhost:5433/idream_test_agent_b",
    );

    expect(first).toMatch(/^idream:test:[a-f0-9]{64}$/);
    expect(second).toMatch(/^idream:test:[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(() => dedicatedTestRedis({
      url: "redis://127.0.0.1:6379/15",
      prefix: first,
    })).not.toThrow();
  });

  it("uses host, port, database, and schema as the complete queue identity", () => {
    const prefixes = [
      "postgresql://postgres:secret@localhost:5433/idream_test?schema=public",
      "postgresql://postgres:secret@127.0.0.1:5433/idream_test?schema=public",
      "postgresql://postgres:secret@localhost:5434/idream_test?schema=public",
      "postgresql://postgres:secret@localhost:5433/idream_test_other?schema=public",
      "postgresql://postgres:secret@localhost:5433/idream_test?schema=agent_b",
    ].map(testBullMqPrefixForDatabase);

    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes.every((prefix) => !prefix.includes("secret"))).toBe(true);
  });

  it("normalizes default port and schema without coupling the queue to credentials", () => {
    const implicit = testBullMqPrefixForDatabase(
      "postgresql://first:secret@localhost/idream_test",
    );
    const explicit = testBullMqPrefixForDatabase(
      "postgresql://second:different@localhost:5432/idream_test?schema=public&sslmode=require",
    );

    expect(implicit).toBe(explicit);
  });

  it.each([
    "mysql://localhost/idream_test",
    "postgresql://localhost",
  ])("refuses an invalid test database identity: %s", (url) => {
    expect(() => testBullMqPrefixForDatabase(url)).toThrow(/Test database URL/);
  });

  it("uses the derived namespace for both test workers and global cleanup", () => {
    const vitestConfig = readFileSync(
      new URL("../../../vitest.config.ts", import.meta.url),
      "utf8",
    );
    const globalSetup = readFileSync(
      new URL("./global-setup.ts", import.meta.url),
      "utf8",
    );

    expect(vitestConfig).toContain("testBullMqPrefixForDatabase(DATABASE_URL)");
    expect(vitestConfig).toContain("BULLMQ_PREFIX,");
    expect(vitestConfig).not.toContain("process.env.BULLMQ_PREFIX");
    expect(globalSetup).toContain("testBullMqPrefixForDatabase(DATABASE_URL)");
    expect(globalSetup).toContain("prefix: BULLMQ_PREFIX");
    expect(globalSetup).not.toContain("process.env.BULLMQ_PREFIX");
  });
});
