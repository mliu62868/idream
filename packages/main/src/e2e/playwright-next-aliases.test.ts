import { randomBytes } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import loadJsConfig from "next/dist/build/load-jsconfig";
import loadConfig from "next/dist/server/config";
import { describe, expect, it, vi } from "vitest";
import { resolvePlaywrightEnvironment } from "../../playwright-environment";
import {
  createPlaywrightCleanupPlan,
  preparePlaywrightResources,
} from "./playwright-cleanup";

// This regression exercises the real generated files and installed Next loader.
// Redis has no bearing on path resolution and must stay outside this pure test.
vi.mock("ioredis", () => ({
  default: class {
    async scan() {
      return ["0", []];
    }
    disconnect() {}
  },
}));

describe("Playwright Next.js aliases", () => {
  it.each([
    ["main", "components/ourdream/AffiliateClickTracker.tsx"],
    ["admin", "lib/admin-v2-api.ts"],
  ] as const)("resolves %s aliases from its package root with an isolated tsconfig", async (packageName, sourceFile) => {
    const environment = resolvePlaywrightEnvironment({
      PW_BASE_URL: "http://127.0.0.1:3998",
      PW_ADMIN_BASE_URL: "http://127.0.0.1:3999",
      PW_DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5433/idream_test_playwright_aliases",
      PW_REDIS_URL: "redis://127.0.0.1:6379/15",
      PW_RUN_ID: randomBytes(4).toString("hex"),
    });
    const plan = createPlaywrightCleanupPlan(environment);
    const mainPackageRoot = path.resolve(import.meta.dirname, "../..");
    const packageRoot = path.resolve(mainPackageRoot, `../${packageName}`);
    const protectedPaths = ["main", "admin"].map((name) =>
      path.resolve(mainPackageRoot, `../${name}`, "tsconfig.json"),
    );
    const originalFiles = await Promise.all(protectedPaths.map((file) => readFile(file)));
    const originalEnvironment = { ...process.env };

    try {
      await preparePlaywrightResources(plan);
      const isolatedTsconfig = packageName === "main"
        ? environment.mainTsconfigPath
        : environment.adminTsconfigPath;
      const nextConfig = await loadConfig(PHASE_DEVELOPMENT_SERVER, packageRoot, {
        customConfig: { typescript: { tsconfigPath: isolatedTsconfig } },
        silent: true,
      });
      const loaded = await loadJsConfig(packageRoot, nextConfig);

      expect(loaded.useTypeScript).toBe(true);
      expect(loaded.jsConfigPath).toBe(path.resolve(packageRoot, isolatedTsconfig));
      expect(loaded.resolvedBaseUrl?.baseUrl).toBe(packageRoot);
      const aliases = loaded.jsConfig?.compilerOptions.paths;
      expect(aliases?.["@/*"]).toEqual(["./src/*"]);
      expect(aliases?.["@idream/shared/admin/contracts"]).toEqual([
        "../shared/src/admin/contracts/index.ts",
      ]);
      const baseUrl = loaded.resolvedBaseUrl!.baseUrl;
      await expect(access(path.resolve(baseUrl, aliases["@/*"][0].replace("*", sourceFile))))
        .resolves.toBeUndefined();
      await expect(access(path.resolve(baseUrl, aliases["@idream/shared/admin/contracts"][0])))
        .resolves.toBeUndefined();
    } finally {
      process.env = originalEnvironment;
      await Promise.all([
        plan.chatFsRoot,
        plan.blobRoot,
        path.dirname(path.resolve(mainPackageRoot, plan.mainTsconfigPath)),
        path.dirname(path.resolve(mainPackageRoot, "../admin", plan.adminTsconfigPath)),
      ].map((directory) => rm(directory, { recursive: true, force: true })));
      expect(await Promise.all(protectedPaths.map((file) => readFile(file))))
        .toEqual(originalFiles);
    }
  });
});
