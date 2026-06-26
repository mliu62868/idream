import type { NextConfig } from "next";
import path from "node:path";

const projectRoot = path.resolve(process.cwd());
const workspaceRoot = path.resolve(projectRoot, "..", "..");

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  // Admin reuses TS source from packages/main and @idream/shared.
  transpilePackages: ["@idream/shared"],
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
