import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ESLint } from "eslint";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import loadJsConfig from "next/dist/build/load-jsconfig";
import loadConfig from "next/dist/server/config";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
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
  it.each(["main", "admin"] as const)("ignores generated %s output but still lints its source", async (name) => {
    const root = path.resolve(import.meta.dirname, `../../../${name}`);
    const eslint = new ESLint({ cwd: root });
    expect(await eslint.isPathIgnored(path.join(root, ".next-playwright/playwright-foreign/server/chunk.js"))).toBe(true);
    expect(await eslint.isPathIgnored(path.join(root, "src/app/layout.tsx"))).toBe(false);
  });

  it.each(["main", "admin"] as const)("typechecks %s against its own route types without importing the shared Next declaration", async (name) => {
    const env = resolvePlaywrightEnvironment({ PW_BASE_URL: "http://127.0.0.1:3998", PW_RUN_ID: randomBytes(4).toString("hex") });
    const foreign = resolvePlaywrightEnvironment({ PW_BASE_URL: "http://127.0.0.1:3998", PW_RUN_ID: randomBytes(4).toString("hex") });
    const plan = createPlaywrightCleanupPlan(env);
    const mainRoot = path.resolve(import.meta.dirname, "../..");
    const root = path.resolve(mainRoot, `../${name}`);
    const dist = name === "main" ? env.mainDistDir : env.adminDistDir;
    const foreignDist = name === "main" ? foreign.mainDistDir : foreign.adminDistDir;
    const config = name === "main" ? env.mainTsconfigPath : env.adminTsconfigPath;
    const ownRoute = path.resolve(root, dist, "types/routes.d.ts");
    const foreignRoute = path.resolve(root, foreignDist, "types/routes.d.ts");
    const parse = (file: string) => {
      const read = ts.readConfigFile(file, ts.sys.readFile);
      expect(read.error).toBeUndefined();
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(file));
      expect(parsed.errors).toEqual([]);
      return parsed.fileNames;
    };
    try {
      await preparePlaywrightResources(plan);
      for (const route of [ownRoute, foreignRoute]) {
        await mkdir(path.dirname(route), { recursive: true });
        await writeFile(route, "export {};\n");
      }
      const defaults = parse(path.join(root, "tsconfig.json"));
      const isolated = parse(path.resolve(root, config));
      for (const files of [defaults, isolated]) {
        expect(files).toContain(path.join(root, "idream-next-env.d.ts"));
        expect(files).not.toContain(path.join(root, "next-env.d.ts"));
        expect(files).not.toContain(foreignRoute);
      }
      expect(defaults).not.toContain(ownRoute);
      expect(isolated).toContain(ownRoute);
    } finally {
      await Promise.all([
        env.chatFsRoot, env.blobRoot,
        path.resolve(mainRoot, env.mainDistDir), path.resolve(mainRoot, "../admin", env.adminDistDir),
        path.resolve(root, foreignDist),
        path.dirname(path.resolve(mainRoot, env.mainTsconfigPath)),
        path.dirname(path.resolve(mainRoot, "../admin", env.adminTsconfigPath)),
      ].map(directory => rm(directory, { recursive: true, force: true })));
    }
  });

  it.each(["main", "admin"] as const)("accepts only the new run-owned %s build and config paths", async (name) => {
    const root = path.resolve(import.meta.dirname, `../../../${name}`);
    const originalCwd = process.cwd();
    const port = name === "main" ? "3998" : "3999";
    const load = () => name === "main" ? import("../../next.config") : import("../../../admin/next.config");
    try {
      process.chdir(root);
      vi.stubEnv("PW_RUN_ID", "a1b2c3d4");
      vi.stubEnv("IDREAM_NEXT_DEVELOPMENT", "0");
      vi.stubEnv("IDREAM_NEXT_DIST_DIR", `.next-playwright/playwright-${name}-${port}-a1b2c3d4`);
      vi.stubEnv("IDREAM_NEXT_TSCONFIG", `.next-playwright/playwright-config-${name}-${port}-a1b2c3d4/tsconfig.json`);
      vi.resetModules();
      const config = (await load()).default;
      expect(config.distDir).toBe(process.env.IDREAM_NEXT_DIST_DIR);
      expect(config.typescript?.tsconfigPath).toBe(process.env.IDREAM_NEXT_TSCONFIG);
      vi.stubEnv("IDREAM_NEXT_DIST_DIR", `.next/playwright-${name}-${port}-a1b2c3d4`);
      vi.resetModules();
      await expect(load()).rejects.toThrow("Playwright-owned");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      process.chdir(originalCwd);
    }
  });

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
