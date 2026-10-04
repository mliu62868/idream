import { readFileSync } from "node:fs";
import { ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertPlaywrightBlobRoot,
  assertPlaywrightDatabaseUrl,
  managedPlaywrightWebServers,
  resolvePlaywrightEnvironment,
} from "../../playwright-environment";
import {
  assertPlaywrightCleanupPlan,
  createPlaywrightCleanupPlan,
} from "./playwright-cleanup";
import { runPlaywrightNextServer } from "./start-playwright-next-server.mjs";

const sourceAuthority = vi.hoisted(() => ({
  computeSourceRevision: vi.fn(() => `idream-worktree-${"a".repeat(64)}`),
}));

vi.mock("../../../../scripts/source-revision.cjs", () => sourceAuthority);

describe("managed Playwright environment", () => {
  it.each([
    ["main", 2, "3110"],
    ["admin", 3, "3111"],
  ] as const)("builds the run-owned %s before serving browser requests", (name, index, port) => {
    const environment = resolvePlaywrightEnvironment({
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_RUN_ID: "a1b2c3d4",
    });
    const server = managedPlaywrightWebServers(environment)[index];

    expect(server.command).toBe(`node src/e2e/start-playwright-next-server.mjs ${name} ${port}`);
    expect(server.env.APP_ENV).toBe("test");
    expect(server.env.NODE_ENV).toBe("production");
    expect(server.gracefulShutdown).toEqual({ signal: "SIGTERM", timeout: 30_000 });
    expect(server.timeout).toBe(120_000);
  });

  it("binds all eight services to current source instead of an ambient deployment stamp", async () => {
    const previousEnv = { ...process.env };
    try {
      process.env.PW_RUN_ID = "a1b2c3d4";
      process.env.IDREAM_SOURCE_REVISION = `idream-worktree-${"b".repeat(64)}`;
      sourceAuthority.computeSourceRevision.mockClear();
      vi.resetModules();

      const config = (await import("../../playwright.config")).default;
      const servers = config.webServer;
      if (!Array.isArray(servers)) throw new Error("Expected managed Playwright services");

      expect(process.env.IDREAM_SOURCE_REVISION).toBe(`idream-worktree-${"a".repeat(64)}`);
      expect(servers).toHaveLength(8);
      expect(servers.map((server) => server.env?.IDREAM_SOURCE_REVISION)).toEqual(
        Array.from({ length: 8 }, () => `idream-worktree-${"a".repeat(64)}`),
      );
      expect(sourceAuthority.computeSourceRevision).toHaveBeenCalledExactlyOnceWith();
    } finally {
      process.env = previousEnv;
      vi.resetModules();
    }
  });

  it("binds authority lifecycle to the first-started and last-stopped managed server", () => {
    const configSource = readFileSync(
      new URL("../../playwright.config.ts", import.meta.url),
      "utf8",
    );

    expect(configSource).not.toContain("globalSetup:");
    expect(configSource).not.toContain("playwright-cleanup-reporter");
    expect(configSource).toContain("createPlaywrightLifecycleVerifier");
  });

  it("derives one Playwright-only authority database and eight non-reused managed processes", () => {
    const first = resolvePlaywrightEnvironment({
      TEST_DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5433/idream_test_workspace",
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_ADMIN_BASE_URL: "http://127.0.0.1:3111",
      CHAT_SERVICE_URL: "http://127.0.0.1:3100",
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
    const servers = managedPlaywrightWebServers(first);

    expect(first.databaseURL).toBe(second.databaseURL);
    expect(new URL(first.databaseURL).pathname).not.toBe("/idream_test_workspace");
    expect(databaseName).toMatch(/(^|[_-])test([_-]|$)/i);
    expect(databaseName).toMatch(/(^|[_-])playwright([_-]|$)/i);
    expect(databaseName.length).toBeLessThanOrEqual(63);
    expect(first.chatBaseURL).toBe("http://127.0.0.1:3113");
    expect(first.chatBaseURL).not.toBe("http://127.0.0.1:3100");
    expect(servers).toHaveLength(8);
    expect(servers.every((server) => server.reuseExistingServer === false)).toBe(true);
    expect(servers.map((server) => server.url)).toEqual([
      `${first.pipelineBaseURL}/health`,
      `${first.chatBaseURL}/readyz`,
      first.mainBaseURL,
      first.adminBaseURL,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(servers.filter((server) => server.url)).toHaveLength(4);
    expect(servers[1]?.command).toContain("start-playwright-chat-service");
    expect(servers[1]?.gracefulShutdown).toEqual({
      signal: "SIGTERM",
      timeout: 30_000,
    });
    expect(servers[1]?.env.CHAT_REDIS_URL).toBe(first.redisURL);
    expect(servers[1]?.env.CHAT_FS_ROOT).toBe(first.chatFsRoot);
    expect(servers[1]?.env.BLOB_ROOT).toBe(first.blobRoot);
    expect(servers[2]?.env.CHAT_SERVICE_URL).toBe(first.chatBaseURL);
    expect(servers[2]?.env.BLOB_ROOT).toBe(first.blobRoot);
    expect(servers[2]?.env.IDREAM_NEXT_DIST_DIR).toBe(
      ".next/playwright-main-3110-a1b2c3d4",
    );
    expect(servers[2]?.env.IDREAM_NEXT_TSCONFIG).toBe(
      ".next/playwright-config-main-3110-a1b2c3d4/tsconfig.json",
    );
    expect(servers[3]?.env.IDREAM_NEXT_DIST_DIR).toBe(
      ".next/playwright-admin-3111-a1b2c3d4",
    );
    expect(servers[3]?.env.IDREAM_NEXT_TSCONFIG).toBe(
      ".next/playwright-config-admin-3111-a1b2c3d4/tsconfig.json",
    );
    expect(servers[3]?.env.BLOB_ROOT).toBe(first.blobRoot);
    for (const [index, mode] of [[4, "image"], [5, "video"]] as const) {
      const worker = servers[index];
      expect(worker?.command).toBe(`bun src/e2e/start-playwright-gen-worker.ts ${mode}`);
      expect(worker?.wait).toEqual({ stdout: new RegExp(`Playwright ${mode} worker started`) });
      expect(worker?.gracefulShutdown).toEqual({ signal: "SIGTERM", timeout: 30_000 });
      expect(worker?.env.REDIS_URL).toBe(first.redisURL);
      expect(worker?.env.GEN_REDIS_URL).toBe(first.redisURL);
      expect(worker?.env.BULLMQ_PREFIX).toBe(first.bullmqPrefix);
      // Seeded profiles pin runner `comfyui`, which Gen accepts only on the
      // backend adapter; provider I/O stays mock inside the worker script.
      expect(worker?.env.GEN_IMAGE_PROVIDER).toBe("backend");
      expect(worker?.env.GEN_VIDEO_PROVIDER).toBe("backend");
      expect(worker?.env.GEN_MODERATION_PROVIDER).toBe("mock");
      expect(worker?.env.GEN_BLOB_PROVIDER).toBe("mock");
      expect(worker?.env.BLOB_ROOT).toBe(first.blobRoot);
      expect(worker?.env.MAIN_WEB_URL).toBe(first.mainBaseURL);
      expect(worker?.env.INTERNAL_TOKEN).toBe(first.serviceEnv.INTERNAL_TOKEN);
      expect(worker?.env.LOG_LEVEL).toBe("info");
    }
    expect(servers[6]?.command).toBe("bun src/processes/finalizer.ts");
    expect(servers[6]?.wait).toEqual({
      stdout: /gen-finalizer started/,
    });
    expect(servers[6]?.gracefulShutdown).toEqual({
      signal: "SIGTERM",
      timeout: 30_000,
    });
    expect(servers[6]?.env.REDIS_URL).toBe(first.redisURL);
    expect(servers[6]?.env.BULLMQ_PREFIX).toBe(first.bullmqPrefix);
    expect(servers[6]?.env.GEN_FINALIZER_QUEUES).toBe("app.ai.finalize");
    expect(servers[6]?.env.INTERNAL_TOKEN).toBe(
      first.serviceEnv.INTERNAL_TOKEN,
    );
    expect(servers[6]?.env.BLOB_ROOT).toBe(first.blobRoot);
    expect(servers[6]?.env.LOG_LEVEL).toBe("info");
    expect(servers[7]?.command).toBe("bun src/processes/event-consumer.ts");
    expect(servers[7]?.wait).toEqual({ stdout: /main durable event projector ready/ });
    expect(servers[7]?.gracefulShutdown).toEqual({ signal: "SIGTERM", timeout: 30_000 });
    expect(servers[7]?.env.DATABASE_URL).toBe(first.databaseURL);
    expect(servers[7]?.env.CHAT_SERVICE_URL).toBe(first.chatBaseURL);
    expect(servers[7]?.env.BLOB_ROOT).toBe(first.blobRoot);
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

  it("isolates the actual Chat runtime model and memory from ambient live settings", () => {
    const environment = resolvePlaywrightEnvironment({
      PW_RUN_ID: "a1b2c3d4",
      CHAT_MODEL_PROVIDER: "openai",
      CHAT_MODEL_BASE_URL: "https://live-model.invalid/v1",
      CHAT_MODEL_API_KEY: "live-secret",
      CHAT_MODEL_NAME: "live-model",
      DSH_IGREP_CANONICAL_ROOT: "/live/companion-memory",
      DSH_IGREP_PRIVATE_ROOT: "/live/companion-private",
      IGREP_LLM_URL: "https://live-maintenance.invalid/v1",
      IGREP_LLM_MODEL: "live-maintenance",
      IGREP_LLM_API_KEY: "live-maintenance-secret",
    });
    expect(environment.serviceEnv).toMatchObject({
      CHAT_MODEL_PROVIDER: "openai",
      CHAT_MODEL_BASE_URL: `${environment.pipelineBaseURL}/v1`,
      CHAT_MODEL_NAME: "playwright-companion",
      CHAT_MODEL_API_KEY: "playwright-model-key",
      DSH_IGREP_CANONICAL_ROOT: path.join(environment.chatFsRoot, "companion-memory"),
      DSH_IGREP_PRIVATE_ROOT: path.join(environment.chatFsRoot, "companion-private"),
      IGREP_LLM_URL: `${environment.pipelineBaseURL}/v1`,
      IGREP_LLM_MODEL: "playwright-maintenance",
      IGREP_LLM_API_KEY: "playwright-model-key",
    });
    const servers = managedPlaywrightWebServers(environment);
    expect(servers[1]?.url).toBe(`${environment.chatBaseURL}/readyz`);
    expect(servers[1]?.env.CHAT_MODEL_BASE_URL).toBe(servers[2]?.env.CHAT_MODEL_BASE_URL);
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
    expect(() => assertPlaywrightDatabaseUrl(
      "postgresql://postgres:postgres@localhost:5433/idream_test",
    )).toThrow("both test and playwright");
    expect(() => assertPlaywrightDatabaseUrl(
      "postgresql://postgres:postgres@localhost:5433/idream",
    )).toThrow("both test and playwright");
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
    })).toThrow("retired");
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

describe("Playwright built Next lifecycle", () => {
  function harness(name = "main", port = "3110") {
    const environment = resolvePlaywrightEnvironment({
      PW_BASE_URL: "http://127.0.0.1:3110",
      PW_RUN_ID: "a1b2c3d4",
      IDREAM_SOURCE_REVISION: `idream-worktree-${"c".repeat(64)}`,
    });
    const managed = managedPlaywrightWebServers(environment)[name === "main" ? 2 : 3];
    const env = Object.freeze({
      ...managed.env,
      NODE_ENV: "development",
      IDREAM_NEXT_DEVELOPMENT: "1",
    });
    const build = new ChildProcess();
    const server = new ChildProcess();
    const buildKill = vi.spyOn(build, "kill").mockReturnValue(true);
    const serverKill = vi.spyOn(server, "kill").mockReturnValue(true);
    const spawn = vi.fn<(command: string, args: string[], options: SpawnOptions) => ChildProcess>()
      .mockReturnValueOnce(build)
      .mockReturnValueOnce(server);
    const signals = new EventEmitter();
    const options = { env, spawn, signals };
    return { environment, name, port, env, build, server, buildKill, serverKill, spawn, signals, options };
  }

  function expectSignalHandlersRemoved(signals: EventEmitter) {
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  }

  it.each([
    ["main", "3110"],
    ["admin", "3111"],
  ])("uses %s's installed Node CLI and the same run-owned authority for build and start", async (name, port) => {
    const h = harness(name, port);
    const running = runPlaywrightNextServer(name, port, h.options);
    const cwd = path.resolve(import.meta.dirname, `../../../${name}`);
    const nextCli = createRequire(path.join(cwd, "package.json")).resolve("next/dist/bin/next");
    const childEnv: NodeJS.ProcessEnv = { ...h.env, NODE_ENV: "production" };
    delete childEnv.IDREAM_NEXT_DEVELOPMENT;

    expect(h.spawn).toHaveBeenCalledExactlyOnceWith("node", [nextCli, "build"], {
      cwd, env: childEnv, stdio: "inherit",
    });
    expect(h.serverKill).not.toHaveBeenCalled();
    h.build.emit("close", 0, null);
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2));
    expect(h.spawn).toHaveBeenLastCalledWith("node", [nextCli, "start", "--port", port], {
      cwd, env: childEnv, stdio: "inherit",
    });
    expect(childEnv).toMatchObject({
      APP_ENV: "test",
      DATABASE_URL: h.environment.databaseURL,
      REDIS_URL: h.environment.redisURL,
      BULLMQ_PREFIX: h.environment.bullmqPrefix,
      PW_RUN_ID: h.environment.runId,
      IDREAM_SOURCE_REVISION: `idream-worktree-${"c".repeat(64)}`,
      IDREAM_NEXT_DIST_DIR: `.next/playwright-${name}-${port}-a1b2c3d4`,
      IDREAM_NEXT_TSCONFIG: `.next/playwright-config-${name}-${port}-a1b2c3d4/tsconfig.json`,
    });
    expect(h.env.NODE_ENV).toBe("development");
    expect(h.env.IDREAM_NEXT_DEVELOPMENT).toBe("1");
    h.server.emit("close", 9, null);
    await expect(running).resolves.toBe(9);
    expectSignalHandlersRemoved(h.signals);
  });

  it.each([
    [7, null, 7],
    [null, "SIGKILL", 1],
  ])("does not start after build exit %s / %s", async (code, signal, expected) => {
    const h = harness();
    const running = runPlaywrightNextServer(h.name, h.port, h.options);
    h.build.emit("close", code, signal);

    await expect(running).resolves.toBe(expected);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.serverKill).not.toHaveBeenCalled();
    expectSignalHandlersRemoved(h.signals);
  });

  it("does not start or leave signal handlers when Node cannot spawn", async () => {
    const h = harness();
    const error = new Error("Node executable unavailable");
    h.spawn.mockReset().mockImplementationOnce(() => { throw error; });

    await expect(runPlaywrightNextServer(h.name, h.port, h.options)).rejects.toBe(error);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expectSignalHandlersRemoved(h.signals);
  });

  it("does not start after an asynchronous build error", async () => {
    const h = harness();
    const running = runPlaywrightNextServer(h.name, h.port, h.options);
    const error = new Error("Node child failed");
    h.build.emit("error", error);

    await expect(running).rejects.toBe(error);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expectSignalHandlersRemoved(h.signals);
  });

  it.each(["SIGINT", "SIGTERM"])("forwards %s only to the active build and never starts afterward", async (signal) => {
    const h = harness();
    const running = runPlaywrightNextServer(h.name, h.port, h.options);
    h.signals.emit(signal);

    expect(h.buildKill).toHaveBeenCalledExactlyOnceWith(signal);
    expect(h.serverKill).not.toHaveBeenCalled();
    h.build.emit("close", null, signal);
    await expect(running).resolves.toBe(0);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expectSignalHandlersRemoved(h.signals);
  });

  it("does not start when shutdown arrives between build completion and server launch", async () => {
    const h = harness();
    const running = runPlaywrightNextServer(h.name, h.port, h.options);
    h.build.emit("close", 0, null);
    h.signals.emit("SIGTERM");

    await expect(running).resolves.toBe(0);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.buildKill).not.toHaveBeenCalled();
    expectSignalHandlersRemoved(h.signals);
  });

  it.each(["SIGINT", "SIGTERM"])("forwards %s only to the built server and waits for its exit", async (signal) => {
    const h = harness();
    const running = runPlaywrightNextServer(h.name, h.port, h.options);
    h.build.emit("close", 0, null);
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2));
    let exited = false;
    void running.then(() => { exited = true; });
    h.signals.emit(signal);

    expect(h.buildKill).not.toHaveBeenCalled();
    expect(h.serverKill).toHaveBeenCalledExactlyOnceWith(signal);
    await Promise.resolve();
    expect(exited).toBe(false);
    h.server.emit("close", null, signal);
    await expect(running).resolves.toBe(0);
    expectSignalHandlersRemoved(h.signals);
  });

  it("preserves a server error during requested shutdown", async () => {
    const h = harness();
    const running = runPlaywrightNextServer(h.name, h.port, h.options);
    h.build.emit("close", 0, null);
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2));
    h.signals.emit("SIGTERM");
    h.server.emit("close", 5, null);

    await expect(running).resolves.toBe(5);
    expectSignalHandlersRemoved(h.signals);
  });

  it.each([
    { APP_ENV: "production" },
    { PLAYWRIGHT_E2E: "0" },
    { PW_RUN_ID: "ffffffff" },
    { IDREAM_SOURCE_REVISION: "" },
    { IDREAM_NEXT_DIST_DIR: ".next" },
    { IDREAM_NEXT_TSCONFIG: "tsconfig.json" },
    { IDREAM_NEXT_DIST_DIR: ".next/playwright-admin-3111-a1b2c3d4" },
  ])("rejects foreign authority %j before any build", async (override) => {
    const h = harness();
    await expect(runPlaywrightNextServer(h.name, h.port, {
      ...h.options, env: { ...h.env, ...override },
    })).rejects.toThrow("this test run's source, distDir, and tsconfig authority");

    expect(h.spawn).not.toHaveBeenCalled();
    expectSignalHandlersRemoved(h.signals);
  });

  it.each([
    ["gen", "3110"],
    ["main", "0"],
    ["main", "65536"],
    ["main", "3110; exit 0"],
  ])("rejects invalid target %s / %s before any build", async (name, port) => {
    const h = harness();
    await expect(runPlaywrightNextServer(name, port, h.options)).rejects.toThrow("Usage:");
    expect(h.spawn).not.toHaveBeenCalled();
    expectSignalHandlersRemoved(h.signals);
  });
});
