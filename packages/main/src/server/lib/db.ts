import { PrismaClient } from "@prisma/client";
import { createPrismaClientOptions } from "./prisma-adapter";

const prismaClientOptions = createPrismaClientOptions();

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient(prismaClientOptions);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
