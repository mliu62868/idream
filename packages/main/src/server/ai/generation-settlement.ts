import type { Prisma } from "@prisma/client";

export async function ensureGenerationSettlementLinks(
  tx: Prisma.TransactionClient,
  requestId: string,
) {
  const entries = await tx.dreamcoinLedger.findMany({
    where: { sourceId: requestId, reason: { in: ["generation_spend", "refund"] } },
    select: { id: true, delta: true, reason: true },
  });
  for (const entry of entries) {
    await tx.generationSettlementLink.upsert({
      where: { ledgerEntryId: entry.id },
      create: { requestId, ledgerEntryId: entry.id, kind: entry.reason },
      update: {},
    });
  }
  const captured = -entries.filter((entry) => entry.reason === "generation_spend" && entry.delta < 0).reduce((sum, entry) => sum + entry.delta, 0);
  const refunded = entries.filter((entry) => entry.reason === "refund" && entry.delta > 0).reduce((sum, entry) => sum + entry.delta, 0);
  return { captured, refunded, refundable: Math.max(0, captured - refunded) };
}

export async function linkGenerationLedgerEntry(
  tx: Prisma.TransactionClient,
  entry: { readonly id: string; readonly sourceId: string | null; readonly reason: string },
) {
  if (!entry.sourceId || !["generation_spend", "refund"].includes(entry.reason)) return;
  await tx.generationSettlementLink.upsert({
    where: { ledgerEntryId: entry.id },
    create: { requestId: entry.sourceId, ledgerEntryId: entry.id, kind: entry.reason },
    update: {},
  });
}
