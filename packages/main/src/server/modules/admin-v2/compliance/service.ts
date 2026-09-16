import type { Prisma } from "@prisma/client";
import type {
  COMPLIANCE_ACCOUNT_DELETION_WAITING_ON,
  complianceAccountDeletionListResponseSchema,
  complianceAgeVerificationListResponseSchema,
  complianceAgeVerificationOverrideResponseSchema,
  complianceEraseResponseSchema,
  complianceUserExportResponseSchema,
} from "@idream/shared/admin/contracts";
import type { z } from "zod";
import {
  accountDeletionPublicState,
  requestAccountDeletion,
} from "@/server/account-deletion-authority";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { writeAudit } from "@/server/modules/admin/shared/legacy-primitives";
import {
  actorWithPermission,
  jsonBody,
  queryParams,
  type AdminV2RequestBody,
} from "@/server/modules/admin-v2/shared/authority";

/**
 * SPEC: 合规运营 —— GDPR/DSAR 数据导出 + 账号擦除，以及年龄验证的人工复核/override。
 * INTENT: 导出脱敏（不含明文 prompt/chat，明文仍走 consent/legal hold）；擦除复用
 *         deleteRequest 的 P0-F 跨服务流（chat 擦除 at-least-once 幂等）；override 不触碰
 *         未成年硬底线（仅裁决成年验证争议）。
 * INVARIANTS:
 *   - 读 compliance.read，写 compliance.write，写必 reason(≥3)+typed 确认 + 审计。
 *   - 擦除幂等：已 deleted 用户重复擦除直接幂等返回。
 *   - 审计只记 targetId/元数据，绝不写入导出内容明文。
 */

type ExportResponse = z.infer<typeof complianceUserExportResponseSchema>;
type EraseResponse = z.infer<typeof complianceEraseResponseSchema>;
type AgeVerificationListResponse = z.infer<typeof complianceAgeVerificationListResponseSchema>;
type AccountDeletionListResponse = z.infer<typeof complianceAccountDeletionListResponseSchema>;
type AccountDeletionWaitingOn = (typeof COMPLIANCE_ACCOUNT_DELETION_WAITING_ON)[number];
type AgeOverrideResponse = z.infer<typeof complianceAgeVerificationOverrideResponseSchema>;
type EraseBody = AdminV2RequestBody<"complianceEraseRequestSchema">;
type AgeOverrideBody = AdminV2RequestBody<"complianceAgeVerificationOverrideRequestSchema">;

export async function exportUserData(request: Request, userId: string): Promise<ExportResponse> {
  const actor = await actorWithPermission(request, "compliance.read");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      name: true,
      role: true,
      status: true,
      createdAt: true,
      deletedAt: true,
    },
  });
  if (!user) throw Errors.notFound("User not found");
  const [subscriptions, ledger, jobs, characters, reports, ageVerifications] = await Promise.all([
    prisma.subscription.findMany({
      where: { userId },
      select: { id: true, status: true, currentPeriodEnd: true, createdAt: true, planId: true },
    }),
    prisma.dreamcoinLedger.findMany({
      where: { userId },
      select: { id: true, delta: true, reason: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.generationJob.findMany({
      where: { userId },
      // 不导出明文 prompt/negativePrompt。
      select: { id: true, mode: true, status: true, costDreamcoins: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.character.findMany({
      where: { creatorId: userId },
      select: { id: true, name: true, visibility: true, status: true, createdAt: true },
    }),
    prisma.contentReport.findMany({
      where: { reporterId: userId },
      select: { id: true, targetType: true, category: true, status: true, createdAt: true },
    }),
    prisma.ageVerification.findMany({
      where: { userId },
      select: { id: true, provider: true, status: true, verifiedAt: true, createdAt: true },
    }),
  ]);
  await writeAudit(request, actor, {
    action: "compliance.export",
    targetType: "user",
    targetId: userId,
    after: { counts: { subscriptions: subscriptions.length, ledger: ledger.length, jobs: jobs.length } },
  });
  return {
    export: {
      user: {
        ...user,
        createdAt: user.createdAt.toISOString(),
        deletedAt: user.deletedAt?.toISOString() ?? null,
      },
      subscriptions: subscriptions.map((row) => ({
        ...row,
        currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      ledger: ledger.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      jobs: jobs.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      characters: characters.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      reports: reports.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      ageVerifications: ageVerifications.map((row) => ({
        ...row,
        verifiedAt: row.verifiedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    },
  };
}

export async function eraseUser(request: Request, userId: string): Promise<EraseResponse> {
  const actor = await actorWithPermission(request, "compliance.write");
  const body = await jsonBody(request, "complianceEraseRequestSchema") as EraseBody;
  if (body.confirmation !== userId) {
    throw Errors.badRequest("Confirmation did not match erase target");
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound("User not found");
  const deletion = await prisma.$transaction((tx) =>
    requestAccountDeletion(tx, { userId }),
  );
  await writeAudit(request, actor, {
    action: "compliance.erase",
    targetType: "user",
    targetId: userId,
    reason: body.reason,
    before: { status: user.status },
    after: {
      status: "deleted",
      deletionId: deletion.id,
      graceEndsAt: deletion.graceEndsAt.toISOString(),
    },
  });
  return {
    erased: true,
    idempotent: !deletion.created,
    deletion: accountDeletionPublicState(deletion),
  };
}

/**
 * SPEC: 擦除请求队列 —— 每一条账号擦除承诺的当前阶段与它在等谁。
 * INTENT: `eraseUser` 只是起点：真正的擦除要等宽限期结束，再经 Chat 擦除 → Blob 删除 →
 *         主库硬删四个阶段，中间跨两个服务。完成时不写审计，请求那条审计的 targetId 还会被
 *         改写成不可逆的 subject ref —— 所以「去审计日志里查」这条路事实上是断的，
 *         在这个端点出现之前后台看不到任何一条擦除请求的下落。
 * INVARIANT: 只读。卡住的行需要的下一步（解除 legal hold、把生成请求推到终态）都在别的模块，
 *            这里给出权威写回的 blocker 原文，不摆一个按了没用的按钮。
 */
export async function listAccountDeletions(request: Request): Promise<AccountDeletionListResponse> {
  await actorWithPermission(request, "compliance.read");
  const { scope, limit } = queryParams(
    request,
    "GET /api/v2/admin/compliance/account-deletions",
  );
  const now = new Date();
  const openOnly = { status: { not: "completed" } };
  const [rows, pastDueCount] = await Promise.all([
    prisma.accountDeletion.findMany({
      where: scope === "all" ? {} : openOnly,
      // 最早到期的排最前：运营要先看的是「已经欠着的」，不是最近提交的。
      orderBy: [{ graceEndsAt: "asc" }, { id: "asc" }],
      take: limit,
    }),
    prisma.accountDeletion.count({ where: { ...openOnly, graceEndsAt: { lte: now } } }),
  ]);
  const requestEventIds = rows.flatMap((row) => row.chatRequestEventId ?? []);
  const deliveries = requestEventIds.length === 0 ? [] : await prisma.mainOutboxEvent.findMany({
    where: { id: { in: requestEventIds } },
    select: { id: true, status: true, attempts: true, nextRunAt: true },
  });
  const deliveryById = new Map(deliveries.map((row) => [row.id, row]));
  return {
    pastDueCount,
    items: rows.map((row) => {
      const delivery = row.chatRequestEventId
        ? deliveryById.get(row.chatRequestEventId)
        : undefined;
      return {
        id: row.id,
        userId: row.userId,
        status: row.status,
        waitingOn: accountDeletionWaitingOn(row.status, row.graceEndsAt, now),
        pastDue: row.status !== "completed" && row.graceEndsAt.getTime() <= now.getTime(),
        requestedAt: row.requestedAt.toISOString(),
        graceEndsAt: row.graceEndsAt.toISOString(),
        chatCompletedAt: row.chatCompletedAt?.toISOString() ?? null,
        blobExpectedCount: row.blobExpectedCount,
        blobDeletedCount: row.blobDeletedCount,
        completedAt: row.completedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
        blockedReason: accountDeletionBlocker(row.lastError),
        chatRequestDelivery: delivery
          ? {
            status: delivery.status,
            attempts: delivery.attempts,
            nextRunAt: delivery.nextRunAt.toISOString(),
          }
          : null,
      };
    }),
  };
}

function accountDeletionWaitingOn(
  status: string,
  graceEndsAt: Date,
  now: Date,
): AccountDeletionWaitingOn {
  if (status === "completed") return "nothing";
  if (status === "deleting_blobs") return "blob_deletion";
  if (status === "finalizing") return "main_purge";
  // awaiting_chat 覆盖两件完全不同的事：宽限期内的正常等待，和宽限期已过却还没被擦除。
  // 状态列本身分不开它们，所以运营看到的是这个派生值，不是 status。
  return graceEndsAt.getTime() > now.getTime() ? "grace_period" : "chat_erasure";
}

function accountDeletionBlocker(lastError: Prisma.JsonValue | null): string | null {
  if (!lastError || typeof lastError !== "object" || Array.isArray(lastError)) return null;
  const code = (lastError as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

export async function listAgeVerifications(
  request: Request,
): Promise<AgeVerificationListResponse> {
  await actorWithPermission(request, "compliance.read");
  const { status, userId, limit } = queryParams(
    request,
    "GET /api/v2/admin/compliance/age-verifications",
  );
  const items = await prisma.ageVerification.findMany({
    where: { status, userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      userId: true,
      provider: true,
      status: true,
      jurisdiction: true,
      verifiedAt: true,
      expiresAt: true,
      createdAt: true,
    },
  });
  return {
    items: items.map((row) => ({
      ...row,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export async function overrideAgeVerification(
  request: Request,
  id: string,
): Promise<AgeOverrideResponse> {
  const actor = await actorWithPermission(request, "compliance.write");
  const body = await jsonBody(
    request,
    "complianceAgeVerificationOverrideRequestSchema",
  ) as AgeOverrideBody;
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match override target");
  }
  const before = await prisma.ageVerification.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Age verification not found");
  const after = await prisma.ageVerification.update({
    where: { id },
    data: {
      status: body.status,
      verifiedAt: body.status === "verified" ? new Date() : null,
    },
  });
  await writeAudit(request, actor, {
    action: "compliance.age_override",
    targetType: "age_verification",
    targetId: id,
    reason: body.reason,
    before: { status: before.status },
    after: { status: after.status },
  });
  return {
    ageVerification: {
      id: after.id,
      status: after.status,
      verifiedAt: after.verifiedAt?.toISOString() ?? null,
    },
  };
}
