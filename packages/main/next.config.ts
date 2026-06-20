import type { NextConfig } from "next";
import path from "node:path";

const projectRoot = path.resolve(process.cwd());

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  output: "standalone",
  // @idream/shared ships TypeScript source (no build step); transpile it here.
  transpilePackages: ["@idream/shared"],
  turbopack: {
    // Monorepo: trace workspace root one level up so shared package resolves.
    root: path.resolve(projectRoot, "..", ".."),
  },
};

export default nextConfig;
