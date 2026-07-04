import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";

type DbClient = Prisma.TransactionClient | typeof prisma;

const REVIEWED_ITEM_STATUSES = new Set(["approved", "rejected", "published", "failed"]);

export async function refreshContentProductionBatchStats(
  db: DbClient,
  batchId: string,
) {
  const items = await db.contentProductionItem.findMany({
    where: { batchId },
    select: { status: true },
  });
  const totalItems = items.length;
  const completedItems = items.filter((item) =>
    ["generated", "approved", "published"].includes(item.status),
  ).length;
  const failedItems = items.filter((item) => item.status === "failed").length;
  const approvedItems = items.filter((item) =>
    ["approved", "published"].includes(item.status),
  ).length;
  const reviewedItems = items.filter((item) => REVIEWED_ITEM_STATUSES.has(item.status)).length;
  const activeItems = items.filter((item) =>
    ["queued", "regenerate_requested"].includes(item.status),
  ).length;
  const generatedItems = items.filter((item) => item.status === "generated").length;
  const status =
    totalItems > 0 && reviewedItems === totalItems
      ? "completed"
      : generatedItems > 0 || reviewedItems > 0
        ? "reviewing"
        : activeItems > 0
          ? "queued"
          : "draft";

  await db.contentProductionBatch.update({
    where: { id: batchId },
    data: {
      totalItems,
      completedItems,
      failedItems,
      approvedItems,
      status,
    },
  });
}

export async function markProductionItemGenerated(
  db: DbClient,
  input: { jobId: string; mediaAssetId: string },
) {
  await db.contentProductionItem.updateMany({
    where: {
      jobId: input.jobId,
      status: { notIn: ["approved", "rejected", "published"] },
    },
    data: {
      mediaAssetId: input.mediaAssetId,
      status: "generated",
    },
  });
  const item = await db.contentProductionItem.findFirst({
    where: { jobId: input.jobId },
    select: { batchId: true },
  });
  if (item) await refreshContentProductionBatchStats(db, item.batchId);
}

export async function markProductionItemFailed(db: DbClient, jobId: string) {
  await db.contentProductionItem.updateMany({
    where: {
      jobId,
      status: { notIn: ["approved", "rejected", "published"] },
    },
    data: { status: "failed" },
  });
  const item = await db.contentProductionItem.findFirst({
    where: { jobId },
    select: { batchId: true },
  });
  if (item) await refreshContentProductionBatchStats(db, item.batchId);
}
