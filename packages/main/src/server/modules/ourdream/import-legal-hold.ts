import { Prisma } from "@prisma/client";

// The caller holds the User root. This checks existing holds; legal-hold
// creation must itself serialize with erasure for concurrent creation to be
// safe, a contract not currently enforced by the polymorphic target schema.
export async function findActiveAccountDeletionLegalHold(tx: Prisma.TransactionClient, userId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT hold.id FROM legal_holds AS hold
    WHERE hold.status = 'active' AND (
      (hold."targetType" = 'user' AND hold."targetId" = ${userId})
      OR (hold."targetType" = 'media' AND EXISTS (
        SELECT 1 FROM media_assets AS media WHERE media.id = hold."targetId" AND media."ownerId" = ${userId}
      ))
      OR (hold."targetType" = 'generation_job' AND EXISTS (
        SELECT 1 FROM generation_jobs AS job WHERE job.id = hold."targetId" AND job."userId" = ${userId}
      ))
    ) ORDER BY hold."createdAt" ASC, hold.id ASC LIMIT 1
  `);
  return rows[0] ?? null;
}
