import { describe, expect, it } from "vitest";
import {
  assertSafeChatTestDatabaseName,
  assertSafeChatTestDatabaseTarget,
  chatTestBullMqPrefix,
  chatTestDatabaseNameForWorkspace,
} from "./provision.mjs";
import {
  acquireChatTestDatabaseLease,
  dedicatedChatTestRedis,
} from "./global-setup.js";

describe("chat test database provisioning guard", () => {
  it("refuses production-like database names before destructive provisioning", () => {
    expect(() => assertSafeChatTestDatabaseName("idream")).toThrow(
      "Refusing to recreate non-test chat database",
    );
    expect(() => assertSafeChatTestDatabaseName("production")).toThrow(
      "Refusing to recreate non-test chat database",
    );
  });

  it("can require the stronger Playwright marker", () => {
    expect(assertSafeChatTestDatabaseName("idream_chat_test")).toBe(
      "idream_chat_test",
    );
    expect(() => assertSafeChatTestDatabaseName(
      "idream_chat_test",
      { requirePlaywright: true },
    )).toThrow("both test and playwright");
    expect(assertSafeChatTestDatabaseName(
      "idream_test_playwright_3110",
      { requirePlaywright: true },
    )).toBe("idream_test_playwright_3110");
  });

  it("derives collision-resistant names for linked worktrees", () => {
    const first = chatTestDatabaseNameForWorkspace("/repo-a/idream", true);
    const second = chatTestDatabaseNameForWorkspace("/repo-b/idream", true);

    expect(first).toMatch(/^idream_chat_test_idream_[a-f0-9]{8}$/);
    expect(second).toMatch(/^idream_chat_test_idream_[a-f0-9]{8}$/);
    expect(first).not.toBe(second);
    expect(chatTestDatabaseNameForWorkspace("/repo/idream", false)).toBe(
      "idream_chat_test",
    );
  });

  it("requires exact CI authority before resetting a remote database", () => {
    const target = {
      database: "idream_chat_test_ci",
      host: "postgres.internal",
    };

    expect(() => assertSafeChatTestDatabaseTarget(target)).toThrow(
      /Refusing remote chat test database reset/,
    );
    expect(() => assertSafeChatTestDatabaseTarget(target, {
      allowRemoteReset: true,
      confirmedDatabaseName: "idream_chat_test_ci",
    })).toThrow(/CI=true/);
    expect(() => assertSafeChatTestDatabaseTarget(target, {
      allowRemoteReset: true,
      ci: true,
      confirmedDatabaseName: "idream_chat_test_other",
    })).toThrow(/confirmation does not match/);
    expect(assertSafeChatTestDatabaseTarget(target, {
      allowRemoteReset: true,
      ci: true,
      confirmedDatabaseName: "idream_chat_test_ci",
    })).toEqual(target);
  });

  it("derives a secret-free Redis namespace from the database target", () => {
    const prefix = chatTestBullMqPrefix({
      database: "idream_chat_test",
      host: "localhost",
      port: "5433",
    });

    expect(prefix).toMatch(/^idream:chat:test:[a-f0-9]{64}$/);
    expect(prefix).not.toContain("postgres");
  });

  it("refuses unsafe Redis cleanup targets", () => {
    expect(() => dedicatedChatTestRedis({
      prefix: "idream:chat:test",
      url: "redis://127.0.0.1:6379/0",
    })).toThrow(/Redis DB 0/);
    expect(() => dedicatedChatTestRedis({
      prefix: "idream:chat:test",
      url: "redis://redis.internal:6379/14",
    })).toThrow(/external test Redis/);
    expect(() => dedicatedChatTestRedis({
      prefix: "idream:development",
      url: "redis://127.0.0.1:6379/14",
    })).toThrow(/non-test BullMQ prefix/);
  });

  it("holds a suite lease that rejects a concurrent destructive provision", async () => {
    await expect(acquireChatTestDatabaseLease({
      database: process.env.CHAT_TEST_DB ?? "idream_chat_test",
      host: process.env.PGHOST ?? "localhost",
      password:
        process.env.PGPASSWORD ??
        process.env.POSTGRES_PASSWORD ??
        "postgres",
      port: process.env.PGPORT ?? "5433",
      user: process.env.PG_SUPER ?? "postgres",
    })).rejects.toThrow(/another Chat test run is active/);
  });
});
