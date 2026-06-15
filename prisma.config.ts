import "dotenv/config";
import { defineConfig } from "prisma/config";

const dbProvider = process.env.DB_PROVIDER ?? "sqlite";
const defaultSqliteUrl = "file:./dev.db";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      (dbProvider === "sqlite" ? defaultSqliteUrl : undefined),
  },
});
