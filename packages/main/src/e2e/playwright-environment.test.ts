import { describe, expect, it } from "vitest";
import {
  assertPlaywrightChatDatabaseUrl,
  assertPlaywrightDatabaseUrl,
  managedPlaywrightWebServers,
  resolvePlaywrightEnvironment,
} from "../../playwright-environment";

describe("managed Playwright environment", () => {
  it("derives one Playwright-only authority database and four non-reused servers", () => {
    const first = resolvePlaywrightEnvironment({
      TEST_DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5433/idream_test_workspace",
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_ADMIN_BASE_URL: "http://127.0.0.1:3111",
      CHAT_SERVICE_URL: "http://127.0.0.1:3100",
      CHAT_DATABASE_URL:
        "postgresql://chat_service:chat_service_change_me@localhost:5433/idream",
    });
    const second = resolvePlaywrightEnvironment({
      TEST_DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5433/idream_test_workspace",
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_ADMIN_BASE_URL: "http://127.0.0.1:3111",
    });
    const databaseName = decodeURIComponent(new URL(first.databaseURL).pathname.slice(1));
    const chatDatabase = new URL(first.chatDatabaseURL);
    const servers = managedPlaywrightWebServers(first);

    expect(first.databaseURL).toBe(second.databaseURL);
    expect(new URL(first.databaseURL).pathname).not.toBe("/idream_test_workspace");
    expect(databaseName).toMatch(/(^|[_-])test([_-]|$)/i);
    expect(databaseName).toMatch(/(^|[_-])playwright([_-]|$)/i);
    expect(databaseName.length).toBeLessThanOrEqual(63);
    expect(chatDatabase.pathname).toBe(new URL(first.databaseURL).pathname);
    expect(chatDatabase.username).toBe("chat_service");
    expect(first.chatBaseURL).toBe("http://127.0.0.1:3113");
    expect(first.chatBaseURL).not.toBe("http://127.0.0.1:3100");
    expect(chatDatabase.pathname).not.toBe("/idream");
    expect(servers).toHaveLength(4);
    expect(servers.every((server) => server.reuseExistingServer === false)).toBe(true);
    expect(servers.map((server) => server.url)).toEqual([
      `${first.chatBaseURL}/healthz`,
      first.mainBaseURL,
      first.adminBaseURL,
      `${first.pipelineBaseURL}/health`,
    ]);
    expect(servers[0]?.command).toContain("start-playwright-chat-service");
    expect(servers[0]?.env.CHAT_DATABASE_URL).toBe(first.chatDatabaseURL);
    expect(servers[0]?.env.CHAT_REDIS_URL).toBe(first.redisURL);
    expect(servers[0]?.env.CHAT_FS_ROOT).toBe(first.chatFsRoot);
    expect(servers[1]?.env.CHAT_SERVICE_URL).toBe(first.chatBaseURL);
  });

  it("isolates derived databases and chat services by main port", () => {
    const first = resolvePlaywrightEnvironment({
      TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/idream_test",
      PW_BASE_URL: "http://127.0.0.1:3110",
    });
    const second = resolvePlaywrightEnvironment({
      TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/idream_test",
      PW_BASE_URL: "http://127.0.0.1:3210",
    });

    expect(first.databaseURL).not.toBe(second.databaseURL);
    expect(first.chatDatabaseURL).not.toBe(second.chatDatabaseURL);
    expect(first.chatBaseURL).not.toBe(second.chatBaseURL);
    expect(first.chatFsRoot).not.toBe(second.chatFsRoot);
  });

  it("accepts only explicit Playwright test databases", () => {
    const authority =
      "postgresql://postgres:postgres@localhost:5433/idream_test_playwright_manual";
    expect(assertPlaywrightDatabaseUrl(authority)).toContain(
      "idream_test_playwright_manual",
    );
    expect(assertPlaywrightChatDatabaseUrl(
      "postgresql://chat_service:chat_service_change_me@localhost:5433/idream_test_playwright_manual",
      authority,
    )).toContain("idream_test_playwright_manual");
    expect(() => assertPlaywrightDatabaseUrl(
      "postgresql://postgres:postgres@localhost:5433/idream_test",
    )).toThrow("both test and playwright");
    expect(() => assertPlaywrightDatabaseUrl(
      "postgresql://postgres:postgres@localhost:5433/idream",
    )).toThrow("both test and playwright");
    expect(() => assertPlaywrightChatDatabaseUrl(
      "postgresql://chat_service:chat_service_change_me@localhost:5433/idream",
      authority,
    )).toThrow("both test and playwright");
    expect(() => assertPlaywrightChatDatabaseUrl(
      "postgresql://chat_service:chat_service_change_me@localhost:5433/idream_test_playwright_other",
      authority,
    )).toThrow("same database");
    expect(() => assertPlaywrightChatDatabaseUrl(
      authority,
      authority,
    )).toThrow("chat_service role");
  });

  it("rejects external services, ambient overrides, and unmanaged mode", () => {
    expect(() => resolvePlaywrightEnvironment({
      PW_BASE_URL: "https://example.com:3110",
    })).toThrow("plain loopback");
    expect(() => resolvePlaywrightEnvironment({
      PW_ADMIN_BASE_URL: "http://127.0.0.1:3000/admin",
    })).toThrow("plain loopback");
    expect(() => resolvePlaywrightEnvironment({
      PW_CHAT_SERVICE_URL: "http://127.0.0.1:3100",
    })).toThrow("derived");
    expect(() => resolvePlaywrightEnvironment({
      PW_CHAT_DATABASE_URL:
        "postgresql://chat_service:chat_service_change_me@localhost:5433/idream_test_playwright_manual",
    })).toThrow("derived");
    expect(() => resolvePlaywrightEnvironment({
      PW_REDIS_URL: "redis://127.0.0.1:6379/0",
    })).toThrow("dedicated non-zero");
    expect(() => resolvePlaywrightEnvironment({
      PW_WEBSERVER: "0",
    })).toThrow("always manages isolated");
  });
});
