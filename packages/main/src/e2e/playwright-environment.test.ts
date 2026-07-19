import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPlaywrightBlobRoot,
  assertPlaywrightChatDatabaseUrl,
  assertPlaywrightChatProjectorDatabaseUrl,
  assertPlaywrightDatabaseUrl,
  managedPlaywrightWebServers,
  resolvePlaywrightEnvironment,
} from "../../playwright-environment";
import {
  assertPlaywrightCleanupPlan,
  createPlaywrightCleanupPlan,
} from "./playwright-cleanup";

describe("managed Playwright environment", () => {
  it("binds authority lifecycle to the first-started and last-stopped managed server", () => {
    const configSource = readFileSync(
      new URL("../../playwright.config.ts", import.meta.url),
      "utf8",
    );

    expect(configSource).not.toContain("globalSetup:");
    expect(configSource).not.toContain("playwright-cleanup-reporter");
    expect(configSource).toContain("createPlaywrightLifecycleVerifier");
  });

  it("derives one Playwright-only authority database and six non-reused managed processes", () => {
    const first = resolvePlaywrightEnvironment({
      TEST_DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5433/idream_test_workspace",
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_ADMIN_BASE_URL: "http://127.0.0.1:3111",
      CHAT_SERVICE_URL: "http://127.0.0.1:3100",
      CHAT_DATABASE_URL:
        "postgresql://chat_service:chat_service_change_me@localhost:5433/idream",
      BLOB_ROOT: path.resolve(import.meta.dirname, "../../../..", "data/blob"),
      PW_RUN_ID: "a1b2c3d4",
    });
    const second = resolvePlaywrightEnvironment({
      TEST_DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5433/idream_test_workspace",
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_ADMIN_BASE_URL: "http://127.0.0.1:3111",
      PW_RUN_ID: "a1b2c3d4",
    });
    const databaseName = decodeURIComponent(new URL(first.databaseURL).pathname.slice(1));
    const chatDatabase = new URL(first.chatDatabaseURL);
    const chatProjectorDatabase = new URL(
      first.chatProjectorDatabaseURL,
    );
    const servers = managedPlaywrightWebServers(first);

    expect(first.databaseURL).toBe(second.databaseURL);
    expect(new URL(first.databaseURL).pathname).not.toBe("/idream_test_workspace");
    expect(databaseName).toMatch(/(^|[_-])test([_-]|$)/i);
    expect(databaseName).toMatch(/(^|[_-])playwright([_-]|$)/i);
    expect(databaseName.length).toBeLessThanOrEqual(63);
    expect(chatDatabase.pathname).toBe(new URL(first.databaseURL).pathname);
    expect(chatDatabase.username).toBe("chat_service");
    expect(chatProjectorDatabase.pathname).toBe(
      new URL(first.databaseURL).pathname,
    );
    expect(chatProjectorDatabase.username).toBe("chat_projector");
    expect(first.chatBaseURL).toBe("http://127.0.0.1:3113");
    expect(first.chatBaseURL).not.toBe("http://127.0.0.1:3100");
    expect(chatDatabase.pathname).not.toBe("/idream");
    expect(servers).toHaveLength(6);
    expect(servers.every((server) => server.reuseExistingServer === false)).toBe(true);
    expect(servers.map((server) => server.url)).toEqual([
      `${first.chatBaseURL}/healthz`,
      first.mainBaseURL,
      first.adminBaseURL,
      `${first.pipelineBaseURL}/health`,
      undefined,
      undefined,
    ]);
    expect(servers.filter((server) => server.url)).toHaveLength(4);
    expect(servers[0]?.command).toContain("start-playwright-chat-service");
    expect(servers[0]?.gracefulShutdown).toEqual({
      signal: "SIGTERM",
      timeout: 30_000,
    });
    expect(servers[0]?.env.CHAT_DATABASE_URL).toBe(first.chatDatabaseURL);
    expect(servers[0]?.env.CHAT_PROJECTOR_DATABASE_URL).toBe(
      first.chatProjectorDatabaseURL,
    );
    expect(servers[0]?.env.CHAT_REDIS_URL).toBe(first.redisURL);
    expect(servers[0]?.env.CHAT_FS_ROOT).toBe(first.chatFsRoot);
    expect(servers[0]?.env.BLOB_ROOT).toBe(first.blobRoot);
    expect(servers[1]?.env.CHAT_SERVICE_URL).toBe(first.chatBaseURL);
    expect(servers[1]?.env.BLOB_ROOT).toBe(first.blobRoot);
    expect(servers[1]?.env.IDREAM_NEXT_DIST_DIR).toBe(
      ".next/playwright-main-3110-a1b2c3d4",
    );
    expect(servers[1]?.env.IDREAM_NEXT_TSCONFIG).toBe(
      ".next/playwright-config-main-3110-a1b2c3d4/tsconfig.json",
    );
    expect(servers[2]?.env.IDREAM_NEXT_DIST_DIR).toBe(
      ".next/playwright-admin-3111-a1b2c3d4",
    );
    expect(servers[2]?.env.IDREAM_NEXT_TSCONFIG).toBe(
      ".next/playwright-config-admin-3111-a1b2c3d4/tsconfig.json",
    );
    expect(servers[2]?.env.BLOB_ROOT).toBe(first.blobRoot);
    expect(servers[4]?.command).toBe("bun run --cwd ../gen start:image");
    expect(servers[4]?.wait).toEqual({
      stdout: /gen\/image workers started/,
    });
    expect(servers[4]?.gracefulShutdown).toEqual({
      signal: "SIGTERM",
      timeout: 30_000,
    });
    expect(servers[4]?.env.REDIS_URL).toBe(first.redisURL);
    expect(servers[4]?.env.GEN_REDIS_URL).toBe(first.redisURL);
    expect(servers[4]?.env.BULLMQ_PREFIX).toBe(first.bullmqPrefix);
    expect(servers[4]?.env.GEN_IMAGE_PROVIDER).toBe("pipeline");
    expect(servers[4]?.env.GEN_MODERATION_PROVIDER).toBe("mock");
    expect(servers[4]?.env.GEN_BLOB_PROVIDER).toBe("mock");
    expect(servers[4]?.env.BLOB_ROOT).toBe(first.blobRoot);
    expect(servers[4]?.env.PIPELINE_API_URL).toBe(first.pipelineBaseURL);
    expect(servers[4]?.env.MAIN_WEB_URL).toBe(first.mainBaseURL);
    expect(servers[4]?.env.INTERNAL_TOKEN).toBe(
      first.serviceEnv.INTERNAL_TOKEN,
    );
    expect(servers[4]?.env.LOG_LEVEL).toBe("info");
    expect(servers[5]?.command).toBe("bun src/processes/finalizer.ts");
    expect(servers[5]?.wait).toEqual({
      stdout: /gen-finalizer started/,
    });
    expect(servers[5]?.gracefulShutdown).toEqual({
      signal: "SIGTERM",
      timeout: 30_000,
    });
    expect(servers[5]?.env.REDIS_URL).toBe(first.redisURL);
    expect(servers[5]?.env.BULLMQ_PREFIX).toBe(first.bullmqPrefix);
    expect(servers[5]?.env.GEN_FINALIZER_QUEUES).toBe("app.ai.finalize");
    expect(servers[5]?.env.INTERNAL_TOKEN).toBe(
      first.serviceEnv.INTERNAL_TOKEN,
    );
    expect(servers[5]?.env.BLOB_ROOT).toBe(first.blobRoot);
    expect(servers[5]?.env.LOG_LEVEL).toBe("info");
    expect(first.serviceEnv.BLOB_ROOT).toBe(first.blobRoot);
    expect(first.blobRoot).toBe(
      path.resolve(
        tmpdir(),
        "idream-playwright-blobs",
        "playwright-blob-3110-a1b2c3d4-1d8aa2ea1ee7",
      ),
    );
    expect(first.blobRoot).not.toBe(
      path.resolve(import.meta.dirname, "../../../..", "data/blob"),
    );
    expect(first.bullmqPrefix).toBe("idream:e2e:3110:a1b2c3d4");
    expect(first.ownsDatabase).toBe(true);
    expect(
      assertPlaywrightCleanupPlan(createPlaywrightCleanupPlan(first)),
    ).toEqual(createPlaywrightCleanupPlan(first));
  });

  it("rejects a cleanup plan whose Chat directory is not the exact run authority", () => {
    const environment = resolvePlaywrightEnvironment({
      TEST_DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5433/idream_test",
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_RUN_ID: "a1b2c3d4",
    });
    const plan = createPlaywrightCleanupPlan(environment);

    expect(() =>
      assertPlaywrightCleanupPlan({
        ...plan,
        chatFsRoot: plan.chatFsRoot.replace(
          /[a-f0-9]{12}$/,
          "000000000000",
        ),
      }),
    ).toThrow("does not match this run");
  });

  it("rejects a cleanup plan whose blob root is not the exact run authority", () => {
    const environment = resolvePlaywrightEnvironment({
      TEST_DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5433/idream_test",
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_RUN_ID: "a1b2c3d4",
    });
    const plan = createPlaywrightCleanupPlan(environment);

    expect(() =>
      assertPlaywrightCleanupPlan({
        ...plan,
        blobRoot: path.resolve(import.meta.dirname, "../../../..", "data/blob"),
      }),
    ).toThrow("blob root does not match this run");
    expect(() =>
      assertPlaywrightBlobRoot(
        path.resolve(import.meta.dirname, "../../../..", "data/blob/e2e"),
      ),
    ).toThrow("outside the repository data/blob authority");
  });

  it("requires CI, explicit authority, and exact confirmation before dropping a remote owned database", () => {
    const input = {
      TEST_DATABASE_URL:
        "postgresql://postgres:postgres@db.internal:5433/idream_test",
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_RUN_ID: "a1b2c3d4",
    } as const;
    const unsafeEnvironment = resolvePlaywrightEnvironment(input);
    const databaseName = decodeURIComponent(
      new URL(unsafeEnvironment.databaseURL).pathname.slice(1),
    );

    expect(() =>
      assertPlaywrightCleanupPlan(
        createPlaywrightCleanupPlan(unsafeEnvironment),
      ),
    ).toThrow("remote Playwright database cleanup");

    const safeEnvironment = resolvePlaywrightEnvironment({
      ...input,
      CI: "true",
      CHAT_TEST_ALLOW_REMOTE_RESET: "1",
      CHAT_TEST_RESET_CONFIRM: databaseName,
    });
    expect(
      assertPlaywrightCleanupPlan(
        createPlaywrightCleanupPlan(safeEnvironment),
      ),
    ).toEqual(createPlaywrightCleanupPlan(safeEnvironment));
  });

  it("treats an explicit Playwright database URL as an authority base, not a shareable database", () => {
    const first = resolvePlaywrightEnvironment({
      PW_DATABASE_URL:
        "postgresql://postgres:postgres@db.internal:5433/idream_test_playwright_manual",
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_RUN_ID: "a1b2c3d4",
    });
    const second = resolvePlaywrightEnvironment({
      PW_DATABASE_URL:
        "postgresql://postgres:postgres@db.internal:5433/idream_test_playwright_manual",
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_RUN_ID: "d4c3b2a1",
    });

    expect(first.ownsDatabase).toBe(true);
    expect(first.databaseURL).not.toBe(second.databaseURL);
    expect(new URL(first.databaseURL).pathname).toContain(
      "_playwright_3110_a1b2c3d4",
    );
  });

  it("isolates Chat filesystem roots even when two runs share an explicit database and port", () => {
    const input = {
      PW_DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5433/idream_test_playwright_manual",
      PW_BASE_URL: "http://127.0.0.1:3110",
    } as const;
    const first = resolvePlaywrightEnvironment({
      ...input,
      PW_RUN_ID: "11111111",
    });
    const second = resolvePlaywrightEnvironment({
      ...input,
      PW_RUN_ID: "22222222",
    });

    expect(first.databaseURL).not.toBe(second.databaseURL);
    expect(first.chatFsRoot).not.toBe(second.chatFsRoot);
  });

  it("isolates derived resources by port and run id", () => {
    const first = resolvePlaywrightEnvironment({
      TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/idream_test",
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_RUN_ID: "11111111",
    });
    const second = resolvePlaywrightEnvironment({
      TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/idream_test",
      PW_BASE_URL: "http://127.0.0.1:3210",
      PW_RUN_ID: "11111111",
    });
    const third = resolvePlaywrightEnvironment({
      TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/idream_test",
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_RUN_ID: "22222222",
    });

    expect(first.databaseURL).not.toBe(second.databaseURL);
    expect(first.databaseURL).not.toBe(third.databaseURL);
    expect(first.chatDatabaseURL).not.toBe(second.chatDatabaseURL);
    expect(first.chatBaseURL).not.toBe(second.chatBaseURL);
    expect(first.chatFsRoot).not.toBe(second.chatFsRoot);
    expect(first.chatFsRoot).not.toBe(third.chatFsRoot);
    expect(first.blobRoot).not.toBe(second.blobRoot);
    expect(first.blobRoot).not.toBe(third.blobRoot);
    expect(first.bullmqPrefix).not.toBe(third.bullmqPrefix);
    expect(first.mainDistDir).not.toBe(third.mainDistDir);
    expect(first.mainTsconfigPath).not.toBe(third.mainTsconfigPath);
  });

  it("accepts bracketed IPv6 loopback origins and dedicated Redis", () => {
    const environment = resolvePlaywrightEnvironment({
      TEST_DATABASE_URL: "postgresql://postgres:postgres@[::1]:5433/idream_test",
      PW_BASE_URL: "http://[::1]:3110",
      PW_ADMIN_BASE_URL: "http://[::1]:3111",
      PW_REDIS_URL: "redis://[::1]:6379/15",
      PW_RUN_ID: "a1b2c3d4",
    });

    expect(environment.mainBaseURL).toBe("http://[::1]:3110");
    expect(environment.adminBaseURL).toBe("http://[::1]:3111");
    expect(environment.redisURL).toBe("redis://[::1]:6379/15");
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
    expect(assertPlaywrightChatProjectorDatabaseUrl(
      "postgresql://chat_projector:chat_projector_change_me@localhost:5433/idream_test_playwright_manual",
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
    expect(() => assertPlaywrightChatProjectorDatabaseUrl(
      "postgresql://chat_service:chat_service_change_me@localhost:5433/idream_test_playwright_manual",
      authority,
    )).toThrow("chat_projector role");
    expect(() => assertPlaywrightChatProjectorDatabaseUrl(
      "postgresql://chat_projector:chat_projector_change_me@localhost:5433/idream_test_playwright_other",
      authority,
    )).toThrow("same database");
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
    expect(() => resolvePlaywrightEnvironment({
      PW_RUN_ID: "NOT-RUN!",
    })).toThrow("8 lowercase hexadecimal");
  });
});
