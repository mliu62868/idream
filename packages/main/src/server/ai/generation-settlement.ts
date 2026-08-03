import type { Prisma } from "@prisma/client";

// SPEC: the settled position of one Generation Request — what it captured, what
// it has already given back, and therefore what is still refundable.
// INVARIANT: `refundable` is the only upper bound on a refund, and distinct
// refund causes deliberately carry distinct ledger identities, so nothing else
// stops two causes from each paying out in full. The ledger's own lock is
// per-user: it serialises the two writes but not the two reads that decided
// them. Taking the Request row here makes the clamp a decision instead of a
// guess. Every refund caller happened to hold this lock except the partial
// refund on the completion path — which is exactly the shape that has to stop
// depending on caller discipline.
// INTENT: lock order is always generation_jobs -> users, because this read
// always precedes `postDreamcoinEntry`.
export async function ensureGenerationSettlementLinks(
  tx: Prisma.TransactionClient,
  requestId: string,
) {
  await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${requestId} FOR UPDATE`;
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
