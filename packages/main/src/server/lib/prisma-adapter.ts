import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PrismaClient } from "@prisma/client";
import { env } from "./env";

type PrismaClientOptions = NonNullable<ConstructorParameters<typeof PrismaClient>[0]>;

export function createPrismaClientOptions(): PrismaClientOptions {
  process.env.DATABASE_URL ??= env.DATABASE_URL;

  if (env.DB_PROVIDER === "sqlite") {
    return {
      adapter: new PrismaBetterSqlite3({
        url: env.DATABASE_URL,
      }),
    };
  }

  return {
    adapter: new PrismaPg({
      connectionString: env.DATABASE_URL,
    }),
  };
}
