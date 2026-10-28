import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

describe("Playwright resource lifecycle", () => {
  it("removes only the current run's Redis prefix", async () => {
    const runId = randomBytes(4).toString("hex");
    const environment = resolvePlaywrightEnvironment({
      PW_BASE_URL: "http://127.0.0.1:3510",
      PW_DATABASE_URL: process.env.DATABASE_URL,
      PW_REDIS_URL: process.env.REDIS_URL,
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
    const ownedBlobPath = path.join(environment.blobRoot, "owned.bin");
    const staleBlobPath = path.join(environment.blobRoot, "stale.bin");
    const unownedSiblingRoot = path.resolve(
      tmpdir(),
      "idream-playwright-blobs",
      `playwright-blob-sentinel-${runId}`,
    );
    const unownedSiblingPath = path.join(unownedSiblingRoot, "preserved.bin");
    const ownedBuildPath = path.resolve(mainPackageRoot, environment.mainDistDir, "server/owned.js");
    const foreignBuildRoot = path.resolve(mainPackageRoot, `.next-playwright/playwright-main-3510-${randomBytes(4).toString("hex")}`);
    const foreignBuildPath = path.join(foreignBuildRoot, "server/preserved.js");

    try {
      await lifecycleVerifier.setup();
      await redis.mset(sentinelKey, "preserved", ownedKey, "stale");
      await mkdir(environment.blobRoot, { recursive: true });
      await writeFile(staleBlobPath, "stale");
      await mkdir(unownedSiblingRoot, { recursive: true });
      await writeFile(unownedSiblingPath, "preserved");
      await preparePlaywrightResources(plan);
      expect(await redis.get(sentinelKey)).toBe("preserved");
      expect(await redis.get(ownedKey)).toBeNull();
      await expect(access(environment.blobRoot)).resolves.toBeUndefined();
      await expect(access(staleBlobPath)).rejects.toThrow();
      expect(JSON.parse(await readFile(mainTsconfigPath, "utf8"))).toEqual({
        extends: "../../tsconfig.json",
        compilerOptions: { baseUrl: "../.." },
        include: ["../../idream-next-env.d.ts", "../../**/*.ts", "../../**/*.tsx", "../../**/*.mts", `../../${environment.mainDistDir}/types/**/*.ts`],
      });
      expect(JSON.parse(await readFile(adminTsconfigPath, "utf8"))).toEqual({
        extends: "../../tsconfig.json",
        compilerOptions: { baseUrl: "../.." },
        include: ["../../idream-next-env.d.ts", "../../**/*.ts", "../../**/*.tsx", "../../**/*.mts", `../../${environment.adminDistDir}/types/**/*.ts`],
      });
      await writeFile(ownedBlobPath, "owned");
      await mkdir(path.dirname(ownedBuildPath), { recursive: true });
      await mkdir(path.dirname(foreignBuildPath), { recursive: true });
      await writeFile(ownedBuildPath, "owned");
      await writeFile(foreignBuildPath, "preserved");

      await redis.set(ownedKey, "runtime");
      await cleanupPlaywrightResources(plan);
      expect(await redis.get(sentinelKey)).toBe("preserved");
      expect(await redis.get(ownedKey)).toBeNull();
      await expect(access(mainTsconfigPath)).rejects.toThrow();
      await expect(access(adminTsconfigPath)).rejects.toThrow();
      await expect(access(environment.blobRoot)).rejects.toThrow();
      await expect(access(ownedBuildPath)).rejects.toThrow();
      await expect(readFile(foreignBuildPath, "utf8")).resolves.toBe("preserved");
      await expect(readFile(unownedSiblingPath, "utf8")).resolves.toBe(
        "preserved",
      );
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
      await rm(unownedSiblingRoot, { recursive: true, force: true });
      await rm(foreignBuildRoot, { recursive: true, force: true });
      await redis.quit();
    }
  });

  it("rejects missing and failed lifecycle cleanup proof", async () => {
    const runId = randomBytes(4).toString("hex");
    const environment = resolvePlaywrightEnvironment({
      PW_BASE_URL: "http://127.0.0.1:3520",
      PW_DATABASE_URL: process.env.DATABASE_URL,
      PW_REDIS_URL: process.env.REDIS_URL,
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

  it("rejects and removes a run-owned blob root left behind after cleanup", async () => {
    const runId = randomBytes(4).toString("hex");
    const environment = resolvePlaywrightEnvironment({
      PW_BASE_URL: "http://127.0.0.1:3530",
      PW_DATABASE_URL: process.env.DATABASE_URL,
      PW_REDIS_URL: process.env.REDIS_URL,
      PW_RUN_ID: runId,
    });
    const plan = createPlaywrightCleanupPlan(environment);
    const lifecycleVerifier = createPlaywrightLifecycleVerifier(plan);

    await lifecycleVerifier.setup();
    await writePlaywrightLifecycleReceipt(plan, {
      status: "passed",
      phase: "teardown",
      message: null,
    });
    await mkdir(environment.blobRoot, { recursive: true });
    await writeFile(path.join(environment.blobRoot, "late-writer.bin"), "late");

    await expect(lifecycleVerifier.teardown()).rejects.toThrow(
      "run-owned blob root still exists",
    );
    await expect(access(environment.blobRoot)).rejects.toThrow();
  });

});
