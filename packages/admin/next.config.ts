import type { NextConfig } from "next";
import path from "node:path";

const projectRoot = path.resolve(process.cwd());
const workspaceRoot = path.resolve(projectRoot, "..", "..");
const mainWebURL = (process.env.MAIN_WEB_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  outputFileTracingExcludes: {
    "/*": [
      "test-results/**/*",
      "../main/test-results/**/*",
      "../main/playwright-report/**/*",
      "../main/src/e2e/**/*",
      "../main/src/**/*.test.*",
      "../../.playwright-cli/**/*",
    ],
  },
  // Admin reuses TS source from packages/main and @idream/shared.
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
