import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";

type DbClient = Prisma.TransactionClient | typeof prisma;

const REVIEWED_ITEM_STATUSES = new Set(["approved", "rejected", "published", "failed"]);

export type CreativeExecutionOutcome =
  | "pending"
  | "running"
  | "succeeded"
  | "partially_succeeded"
  | "failed"
  | "cancelled";

export type CreativeReviewState = "not_ready" | "pending" | "in_review" | "complete";
export type CreativeDeploymentState = "unplaced" | "partially_placed" | "placed";
export type CreativeVerificationState = "pending" | "verifying" | "passed" | "failed" | "overridden";
export type CreativeSettlementView = "not_required" | "captured" | "partially_refunded" | "refunded";

export interface CreativeRunItemFact {
  id: string;
  status: string;
  job: {
    id: string;
    status: string;
    errorCode?: string | null;
    costDreamcoins?: number;
  } | null;
  asset: {
    id: string;
    safetyStatus: string;
    deletedAt?: Date | null;
  } | null;
  placements?: ReadonlyArray<{
    status: string;
    verificationState?: CreativeVerificationState | null;
  }>;
}

export interface CreativeRunLedgerFact {
  sourceId: string | null;
  reason: string;
  delta: number;
}

export interface CreativeRunState {
  executionOutcome: CreativeExecutionOutcome;
  reviewState: CreativeReviewState;
  deploymentState: CreativeDeploymentState;
  verificationState: CreativeVerificationState;
  settlementView: CreativeSettlementView;
  counts: {
    generated: number;
    failed: number;
    reviewed: number;
    approved: number;
    placed: number;
    total: number;
  };
  retryEligibility: {
    eligibleItemIds: string[];
    eligibleCount: number;
  };
  legacyState: string;
}

const SUCCESSFUL_REVIEW_STATUSES = new Set(["approved", "rejected", "published"]);
const APPROVED_ITEM_STATUSES = new Set(["approved", "published"]);
const TERMINAL_FAILURE_ITEM_STATUSES = new Set(["failed", "cancelled"]);
const TERMINAL_FAILURE_JOB_STATUSES = new Set(["failed", "blocked", "refunded", "cancelled"]);

function hasValidCreativeAsset(item: CreativeRunItemFact) {
  return Boolean(
    item.asset &&
      !item.asset.deletedAt &&
      item.asset.safetyStatus === "passed",
  );
}

function isFailedCreativeItem(item: CreativeRunItemFact) {
  if (hasValidCreativeAsset(item)) return false;
  return (
    TERMINAL_FAILURE_ITEM_STATUSES.has(item.status) ||
    Boolean(item.job && TERMINAL_FAILURE_JOB_STATUSES.has(item.job.status))
  );
}

function publishedPlacement(item: CreativeRunItemFact) {
  return item.placements?.find((placement) => placement.status === "published") ?? null;
}

/**
 * Builds the Creative Run v2 read model exclusively from child facts. The legacy
 * batch status is retained as evidence, but never determines successful execution.
 */
export function deriveCreativeRunState(input: {
  legacyStatus: string;
  expectedItemCount: number;
  items: ReadonlyArray<CreativeRunItemFact>;
  ledgerEntries: ReadonlyArray<CreativeRunLedgerFact>;
}): CreativeRunState {
  const total = Math.max(input.expectedItemCount, input.items.length);
  const successfulItems = input.items.filter(hasValidCreativeAsset);
  const failedItems = input.items.filter(isFailedCreativeItem);
  const terminalCount = successfulItems.length + failedItems.length;
  const activeCount = Math.max(0, total - terminalCount);

  let executionOutcome: CreativeExecutionOutcome;
  if (total === 0) executionOutcome = "pending";
  else if (activeCount > 0) executionOutcome = "running";
  else if (successfulItems.length === total) executionOutcome = "succeeded";
  else if (successfulItems.length > 0) executionOutcome = "partially_succeeded";
  else executionOutcome = "failed";

  const reviewedItems = successfulItems.filter((item) => SUCCESSFUL_REVIEW_STATUSES.has(item.status));
  const approvedItems = successfulItems.filter((item) => APPROVED_ITEM_STATUSES.has(item.status));
  const placedItems = successfulItems.filter((item) => Boolean(publishedPlacement(item)));
  const reviewState: CreativeReviewState =
    successfulItems.length === 0
      ? "not_ready"
      : reviewedItems.length === 0
        ? "pending"
        : reviewedItems.length === successfulItems.length
          ? "complete"
          : "in_review";
  const deploymentState: CreativeDeploymentState =
    placedItems.length === 0
      ? "unplaced"
      : placedItems.length === successfulItems.length
        ? "placed"
        : "partially_placed";

  const placementVerificationStates = placedItems
    .map((item) => publishedPlacement(item)?.verificationState ?? "pending");
  const verificationState: CreativeVerificationState = placementVerificationStates.includes("failed")
    ? "failed"
    : placementVerificationStates.length > 0 && placementVerificationStates.every((state) => state === "passed")
      ? "passed"
      : placementVerificationStates.includes("verifying")
        ? "verifying"
        : placementVerificationStates.length > 0 && placementVerificationStates.every((state) => state === "overridden")
          ? "overridden"
          : "pending";

  const capturedAmount = input.ledgerEntries
    .filter((entry) => entry.reason === "generation_spend")
    .reduce((sum, entry) => sum + Math.max(0, -entry.delta), 0);
  const refundedAmount = input.ledgerEntries
    .filter((entry) => entry.reason === "refund")
    .reduce((sum, entry) => sum + Math.max(0, entry.delta), 0);
  const settlementView: CreativeSettlementView =
    capturedAmount === 0 && refundedAmount === 0
      ? "not_required"
      : capturedAmount > 0 && refundedAmount <= 0
        ? "captured"
        : capturedAmount === 0 || refundedAmount >= capturedAmount
          ? "refunded"
          : "partially_refunded";

  const refundedJobIds = new Set(
    input.ledgerEntries
      .filter((entry) => entry.reason === "refund" && entry.sourceId)
      .map((entry) => entry.sourceId as string),
  );
  const eligibleItemIds = failedItems
    .filter((item) => item.job && !refundedJobIds.has(item.job.id))
    .map((item) => item.id);

  return {
    executionOutcome,
    reviewState,
    deploymentState,
    verificationState,
    settlementView,
    counts: {
      generated: successfulItems.length,
      failed: failedItems.length,
      reviewed: reviewedItems.length,
      approved: approvedItems.length,
      placed: placedItems.length,
      total,
    },
    retryEligibility: {
      eligibleItemIds,
      eligibleCount: eligibleItemIds.length,
    },
    legacyState: input.legacyStatus,
  };
}

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
