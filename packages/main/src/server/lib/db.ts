import { PrismaClient, type Prisma } from "@prisma/client";
import { createPrismaClientOptions } from "./prisma-adapter";

const prismaClientOptions = createPrismaClientOptions();

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient(prismaClientOptions);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * SPEC: runs `execute` inside one transaction, joining the caller's if it already
 * opened one, and opening a new one otherwise.
 *
 * INTENT: two spellings of this are scattered through the modules and they read
 * as opposite tests — `db ? execute(db) : prisma.$transaction(execute)` branches
 * on whether a client was passed, `"$transaction" in db ? ... : ...` branches on
 * which kind it is. They agree only because the first form's parameter happens
 * to exclude a full client. Branching on the capability is the form that stays
 * correct either way, so it is the only one here.
 *
 * INVARIANT: never nests. A TransactionClient has no `$transaction` to call, so
 * an inner scope always joins the outer one rather than opening a second
 * connection that would wait on locks the outer scope is still holding.
 */
export function inTransaction<T>(
  db: Prisma.TransactionClient | typeof prisma | undefined,
  execute: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const client = db ?? prisma;
  return "$transaction" in client ? client.$transaction(execute) : execute(client);
}
