import type {
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
