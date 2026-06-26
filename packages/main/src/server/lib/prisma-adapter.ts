import { PrismaPg } from "@prisma/adapter-pg";
import type { PrismaClient } from "@prisma/client";
import { env } from "./env";

type PrismaClientOptions = NonNullable<ConstructorParameters<typeof PrismaClient>[0]>;

export function createPrismaClientOptions(): PrismaClientOptions {
  process.env.DATABASE_URL ??= env.DATABASE_URL;

  return {
    adapter: new PrismaPg({
      connectionString: env.DATABASE_URL,
    }),
  };
}
