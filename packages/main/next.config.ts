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
  // SPEC: 全站响应带基础安全头。
  // INTENT: 这些头原本写在包根的 proxy.ts 里，但 app 在 src/ 下，Next 只认与 app 同级的
  //   proxy，自 monorepo 迁移起它从未执行过。静态头放在这里不需要额外的请求期运行时；
  //   年龄门与匿名 id 已由服务端（DB 为权威）负责，不再在边缘重复。
  // INVARIANT: 只有 /internal-preview 可以被嵌入，而且只允许 Admin 源嵌入（角色工作区用
  //   iframe 渲染真实前台）；其余页面一律禁止被 frame。
  async headers() {
    const adminOrigin = process.env.ADMIN_WEB_URL ? new URL(process.env.ADMIN_WEB_URL).origin : "'none'";
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/((?!internal-preview/).*)",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
      {
        source: "/internal-preview/:path*",
        headers: [{ key: "Content-Security-Policy", value: `frame-ancestors ${adminOrigin}` }],
      },
    ];
  },
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
