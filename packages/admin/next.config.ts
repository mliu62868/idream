import type { NextConfig } from "next";
import path from "node:path";

const projectRoot = path.resolve(process.cwd());
const workspaceRoot = path.resolve(projectRoot, "..", "..");
const mainWebURL = (process.env.MAIN_WEB_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const isolatedDistDir = process.env.IDREAM_NEXT_DIST_DIR?.trim();
const isolatedTsconfigPath = process.env.IDREAM_NEXT_TSCONFIG?.trim();
const playwrightRunId = process.env.PW_RUN_ID?.trim();
const isolatedDistMatch = isolatedDistDir?.match(
  /^\.next\/playwright-admin-(\d+)-([a-f0-9]{8})$/,
);
const isolatedTsconfigMatch = isolatedTsconfigPath?.match(
  /^\.next\/playwright-config-admin-(\d+)-([a-f0-9]{8})\/tsconfig\.json$/,
);

if (isolatedDistDir && !isolatedDistMatch) {
  throw new Error(
    "IDREAM_NEXT_DIST_DIR must be a Playwright-owned Admin directory",
  );
}
if (isolatedTsconfigPath && !isolatedTsconfigMatch) {
  throw new Error(
    "IDREAM_NEXT_TSCONFIG must be a Playwright-owned Admin config",
  );
}
if (
  Boolean(isolatedDistDir) !== Boolean(isolatedTsconfigPath) ||
  (isolatedDistMatch &&
    isolatedTsconfigMatch &&
    (isolatedDistMatch[1] !== isolatedTsconfigMatch[1] ||
      isolatedDistMatch[2] !== isolatedTsconfigMatch[2] ||
      isolatedDistMatch[2] !== playwrightRunId))
) {
  throw new Error(
    "Playwright Admin distDir, tsconfig, port, and PW_RUN_ID must identify the same run",
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
      "../../.playwright-cli/**/*",
    ],
  },
  // Shared contracts are the only compile-time dependency on another workspace package.
  transpilePackages: ["@idream/shared"],
  turbopack: {
    root: workspaceRoot,
  },
  async rewrites() {
    return [
      {
        source: "/images/:path*",
        destination: `${mainWebURL}/images/:path*`,
      },
    ];
  },
};

export default nextConfig;
