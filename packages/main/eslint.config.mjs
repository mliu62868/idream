import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/app/api/**/route.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              message: "Route handlers must call services/jobs/lib boundaries, not Prisma directly.",
            },
            {
              name: "@/server/lib/db",
              message: "Route handlers must call services/jobs/lib boundaries, not Prisma directly.",
            },
          ],
          patterns: [
            {
              group: ["@/server/modules/**/**.repository"],
              message: "Route handlers must not import repositories directly.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/server/lib/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/modules/**"],
              message: "Shared lib code must not depend on feature modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/server/**/*.ts", "src/app/api/**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // `const { secret: _, ...rest } = obj` 是省略字段的标准写法，被省略的绑定按定义就不会被读。
    // 这是 @typescript-eslint 推荐配置的默认值，只影响 rest 兄弟绑定，不会放过真正的未用变量。
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { ignoreRestSiblings: true, argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-development/**",
    ".next-runtime/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
