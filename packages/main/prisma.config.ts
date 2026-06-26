import "dotenv/config";
import { defineConfig } from "prisma/config";

const defaultPostgresUrl = "postgresql://postgres:postgres@localhost:5433/idream";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? defaultPostgresUrl,
  },
});
