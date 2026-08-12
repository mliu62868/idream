import type { NextConfig } from "next";
import path from "node:path";

const projectRoot = path.resolve(process.cwd());
const workspaceRoot = path.resolve(projectRoot, "..", "..");
const isolatedDistDir = process.env.IDREAM_NEXT_DIST_DIR?.trim();
const isolatedTsconfigPath = process.env.IDREAM_NEXT_TSCONFIG?.trim();
const playwrightRunId = process.env.PW_RUN_ID?.trim();
const sourceDevelopment =
  process.env.IDREAM_NEXT_DEVELOPMENT === "1" &&
  process.env.NODE_ENV !== "production" &&
  isolatedDistDir === ".next-development" &&
  !isolatedTsconfigPath &&
  !playwrightRunId;
const isolatedDistMatch = isolatedDistDir?.match(
  /^\.next\/playwright-main-(\d+)-([a-f0-9]{8})$/,
);
const isolatedTsconfigMatch = isolatedTsconfigPath?.match(
  /^\.next\/playwright-config-main-(\d+)-([a-f0-9]{8})\/tsconfig\.json$/,
);

if (isolatedDistDir && !isolatedDistMatch && !sourceDevelopment) {
  throw new Error(
    "IDREAM_NEXT_DIST_DIR must be a Playwright-owned Main directory",
  );
}
if (
  process.env.IDREAM_NEXT_DEVELOPMENT === "1" &&
  !sourceDevelopment
) {
  throw new Error(
    "Main source development must use its dedicated .next-development directory",
  );
}
if (isolatedTsconfigPath && !isolatedTsconfigMatch) {
  throw new Error(
    "IDREAM_NEXT_TSCONFIG must be a Playwright-owned Main config",
  );
}
if (
  !sourceDevelopment &&
  (Boolean(isolatedDistDir) !== Boolean(isolatedTsconfigPath) ||
    (isolatedDistMatch &&
      isolatedTsconfigMatch &&
      (isolatedDistMatch[1] !== isolatedTsconfigMatch[1] ||
        isolatedDistMatch[2] !== isolatedTsconfigMatch[2] ||
        isolatedDistMatch[2] !== playwrightRunId)))
) {
  throw new Error(
    "Playwright Main distDir, tsconfig, port, and PW_RUN_ID must identify the same run",
  );
}

const nextConfig: NextConfig = {
  ...(isolatedDistDir ? { distDir: isolatedDistDir } : {}),
  ...(isolatedTsconfigPath
    ? { typescript: { tsconfigPath: isolatedTsconfigPath } }
    : {}),
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    // Runtime releases are immutable. Keep ISR/fetch entries in memory instead
    // of allowing Next to rewrite .next/server after publication.
    isrFlushToDisk: false,
  },
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  outputFileTracingExcludes: {
    "/*": [
      "test-results/**/*",
      "playwright-report/**/*",
      "src/e2e/**/*",
      "src/**/*.test.*",
      "../../.playwright-cli/**/*",
    ],
  },
  // @idream/shared ships TypeScript source (no build step); transpile it here.
  transpilePackages: ["@idream/shared"],
  turbopack: {
    // Monorepo: trace workspace root one level up so shared package resolves.
    root: workspaceRoot,
  },
};

export default nextConfig;
