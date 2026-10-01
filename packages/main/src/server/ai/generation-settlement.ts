import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";

// INVARIANT: financial settlement starts at the same user lock as Generation
// admission and Chat mutations. Take it before the Request or any attachment;
// adding it only when the ledger is written would invert those callers' order.
export async function lockGenerationRequestForSettlement(
  tx: Prisma.TransactionClient,
  requestId: string,
) {
  const owner = await tx.generationJob.findUnique({
    where: { id: requestId },
    select: { userId: true },
  });
  if (!owner) throw Errors.notFound("Generation Request not found");
  await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${owner.userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${requestId} FOR UPDATE`;
  const request = await tx.generationJob.findUnique({ where: { id: requestId } });
  if (!request) throw Errors.notFound("Generation Request not found");
  if (request.userId !== owner.userId) {
    throw Errors.conflict("Generation Request owner changed before settlement");
  }
  return request;
}

// SPEC: the settled position of one Generation Request — what it captured, what
// it has already given back, and therefore what is still refundable.
// INVARIANT: `refundable` is the only upper bound on a refund, and distinct
// refund causes deliberately carry distinct ledger identities, so nothing else
// stops two causes from each paying out in full. The ledger's own lock is
// per-user: it serialises the two writes but not the two reads that decided
// them. Taking the user and Request rows here makes the clamp a decision
// instead of a guess. Terminal callers acquire the same locks before changing
// the Request or its attachments; this entry point also protects direct refunds.
export async function ensureGenerationSettlementLinks(
  tx: Prisma.TransactionClient,
  requestId: string,
) {
  await lockGenerationRequestForSettlement(tx, requestId);
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
  // Voice spends use a MediaAsset source under the same ledger reason. Only
  // an actual GenerationJob is a generation settlement authority.
  const request = await tx.generationJob.findUnique({
    where: { id: entry.sourceId },
    select: { id: true },
  });
  if (!request) return;
  await tx.generationSettlementLink.upsert({
    where: { ledgerEntryId: entry.id },
    create: { requestId: entry.sourceId, ledgerEntryId: entry.id, kind: entry.reason },
    update: {},
  });
}
