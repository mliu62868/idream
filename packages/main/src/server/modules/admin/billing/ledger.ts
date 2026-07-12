import type { Prisma } from "@prisma/client";
import { linkGenerationLedgerEntry } from "@/server/ai/generation-settlement";
import { prisma } from "@/server/lib/db";

export async function appendLedger(
  tx: Prisma.TransactionClient,
  userId: string,
  delta: number,
  reason: string,
  sourceId?: string,
  idempotencyKey?: string,
) {
  if (idempotencyKey) {
    const existing = await tx.dreamcoinLedger.findUnique({ where: { idempotencyKey } });
    if (existing) {
      await linkGenerationLedgerEntry(tx, existing);
      return existing;
    }
  }
  await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
  const aggregate = await tx.dreamcoinLedger.aggregate({ where: { userId }, _sum: { delta: true } });
  const balance = aggregate._sum.delta ?? 0;
  const created = await tx.dreamcoinLedger.create({
    data: { userId, delta, balanceAfter: balance + delta, reason, sourceId, idempotencyKey },
  });
  await linkGenerationLedgerEntry(tx, created);
  return created;
}

export async function dreamcoinBalance(
  userId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const aggregate = await tx.dreamcoinLedger.aggregate({ where: { userId }, _sum: { delta: true } });
  return aggregate._sum.delta ?? 0;
}
