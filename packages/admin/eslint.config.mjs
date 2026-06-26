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
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
