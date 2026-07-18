import { randomBytes } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import IORedis from "ioredis";
import { describe, expect, it } from "vitest";
import { resolvePlaywrightEnvironment } from "../../playwright-environment";
import {
  cleanupPlaywrightResources,
  createPlaywrightCleanupPlan,
  preparePlaywrightResources,
} from "./playwright-cleanup";
import {
  createPlaywrightLifecycleVerifier,
  writePlaywrightLifecycleReceipt,
} from "./playwright-lifecycle-receipt";
import { acquirePlaywrightWorkspaceLease } from "./playwright-workspace-lease";

describe("Playwright resource lifecycle", () => {
  it("removes only the current run's Redis prefix", async () => {
    const runId = randomBytes(4).toString("hex");
    const environment = resolvePlaywrightEnvironment({
      PW_BASE_URL: "http://127.0.0.1:3510",
      PW_DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5433/idream_test_playwright_manual",
      PW_REDIS_URL: "redis://127.0.0.1:6379/15",
      PW_RUN_ID: runId,
    });
    const plan = createPlaywrightCleanupPlan(environment);
    const lifecycleVerifier = createPlaywrightLifecycleVerifier(plan);
    const redis = new IORedis(environment.redisURL);
    const sentinelKey = `idream:e2e:sentinel:${runId}`;
    const ownedKey = `${environment.bullmqPrefix}:stale`;
    const mainPackageRoot = path.resolve(import.meta.dirname, "../..");
    const adminPackageRoot = path.resolve(mainPackageRoot, "../admin");
    const mainTsconfigPath = path.resolve(
      mainPackageRoot,
      environment.mainTsconfigPath,
    );
    const adminTsconfigPath = path.resolve(
      adminPackageRoot,
      environment.adminTsconfigPath,
    );

    try {
      await lifecycleVerifier.setup();
      await redis.mset(sentinelKey, "preserved", ownedKey, "stale");
      await preparePlaywrightResources(plan);
      expect(await redis.get(sentinelKey)).toBe("preserved");
      expect(await redis.get(ownedKey)).toBeNull();
      expect(JSON.parse(await readFile(mainTsconfigPath, "utf8"))).toEqual({
        extends: "../../tsconfig.json",
      });
      expect(JSON.parse(await readFile(adminTsconfigPath, "utf8"))).toEqual({
        extends: "../../tsconfig.json",
      });

      await redis.set(ownedKey, "runtime");
      await cleanupPlaywrightResources(plan);
      expect(await redis.get(sentinelKey)).toBe("preserved");
      expect(await redis.get(ownedKey)).toBeNull();
      await expect(access(mainTsconfigPath)).rejects.toThrow();
      await expect(access(adminTsconfigPath)).rejects.toThrow();
      await writePlaywrightLifecycleReceipt(plan, {
        status: "passed",
        phase: "teardown",
        message: null,
      });
      await expect(lifecycleVerifier.teardown()).resolves.toBeUndefined();
    } finally {
      await redis.del(sentinelKey, ownedKey);
      await cleanupPlaywrightResources(plan).catch(() => undefined);
      await lifecycleVerifier.setup();
      await redis.quit();
    }
  });

  it("rejects missing and failed lifecycle cleanup proof", async () => {
    const runId = randomBytes(4).toString("hex");
    const environment = resolvePlaywrightEnvironment({
      PW_BASE_URL: "http://127.0.0.1:3520",
      PW_DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5433/idream_test_playwright_manual",
      PW_REDIS_URL: "redis://127.0.0.1:6379/15",
      PW_RUN_ID: runId,
    });
    const plan = createPlaywrightCleanupPlan(environment);
    const lifecycleVerifier = createPlaywrightLifecycleVerifier(plan);

    await lifecycleVerifier.setup();
    await expect(lifecycleVerifier.teardown()).rejects.toThrow(
      "cleanup proof is missing or invalid",
    );
    await lifecycleVerifier.setup();
    await writePlaywrightLifecycleReceipt(plan, {
      status: "failed",
      phase: "teardown",
      message: "injected cleanup failure",
    });
    await expect(lifecycleVerifier.teardown()).rejects.toThrow(
      "injected cleanup failure",
    );
  });

  it("serializes workspace runs and restores both Next environment declarations", async () => {
    const mainPackageRoot = path.resolve(import.meta.dirname, "../..");
    const adminPackageRoot = path.resolve(mainPackageRoot, "../admin");
    const mainNextEnvPath = path.resolve(mainPackageRoot, "next-env.d.ts");
    const adminNextEnvPath = path.resolve(adminPackageRoot, "next-env.d.ts");
    const originalMain = await readFile(mainNextEnvPath);
    const originalAdmin = await readFile(adminNextEnvPath);
    const lease = await acquirePlaywrightWorkspaceLease("a1b2c3d4");

    try {
      await expect(
        acquirePlaywrightWorkspaceLease("d4c3b2a1"),
      ).rejects.toThrow("already owns this workspace");
      await writeFile(mainNextEnvPath, "injected Main declaration\n");
      await writeFile(adminNextEnvPath, "injected Admin declaration\n");
    } finally {
      await lease.release();
    }

    expect(await readFile(mainNextEnvPath)).toEqual(originalMain);
    expect(await readFile(adminNextEnvPath)).toEqual(originalAdmin);
  });

});
