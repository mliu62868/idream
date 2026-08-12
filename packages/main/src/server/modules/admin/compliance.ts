// SPEC: 合规运营服务层（ADMIN_PHASE3_DESIGN §4）。GDPR/DSAR 数据导出 + 账号擦除，
//       以及年龄验证人工复核/override。零迁移：复用 User/AgeVerification + 既有擦除流。
// INTENT: 导出脱敏（不含明文 prompt/chat，明文仍走 consent/legal hold）；擦除复用
//         deleteRequest 的 P0-F 跨服务流（chat 擦除 at-least-once 幂等）；override 不触碰
//         未成年硬底线（仅裁决成年验证争议）。
// INVARIANTS:
//   - 读 compliance.read，写 compliance.write（admin only），写必 reason(≥3)+typed + 审计。
//   - 擦除幂等：已 deleted 用户重复擦除直接幂等返回。
//   - 审计只记 targetId/元数据，绝不写入导出内容明文。
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission, clampInt, jsonBody, writeAudit } from "@/server/modules/admin/shared/legacy-primitives";
import {
  accountDeletionPublicState,
  requestAccountDeletion,
} from "@/server/account-deletion-authority";

const COMPLIANCE_READ = "compliance.read" as const;
const COMPLIANCE_WRITE = "compliance.write" as const;

const eraseSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const ageOverrideSchema = z.object({
  status: z.enum(["verified", "failed"]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

// DSAR 导出：聚合该用户的结构化数据（不含明文 prompt/chat）。
export async function exportUserData(request: Request, userId: string): Promise<Response> {
  const actor = await actorWithPermission(request, COMPLIANCE_READ);
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
  return ok({
    export: { user, subscriptions, ledger, jobs, characters, reports, ageVerifications },
  });
}

// 账号擦除：复用 deleteRequest 的 P0-F 流（target 版），强制 reason+typed，幂等。
export async function eraseUser(request: Request, userId: string): Promise<Response> {
  const actor = await actorWithPermission(request, COMPLIANCE_WRITE);
  const body = eraseSchema.parse(await jsonBody(request));
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
  return ok({
    erased: true,
    idempotent: !deletion.created,
    deletion: accountDeletionPublicState(deletion),
  });
}

export async function listAgeVerifications(request: Request): Promise<Response> {
  await actorWithPermission(request, COMPLIANCE_READ);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const userId = url.searchParams.get("userId") ?? undefined;
  const items = await prisma.ageVerification.findMany({
    where: { status, userId },
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 200, 100),
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
  return ok({ items });
}

// 人工裁决成年验证（webhook 失败/申诉兜底）。不触碰未成年硬底线。
export async function overrideAgeVerification(request: Request, id: string): Promise<Response> {
  const actor = await actorWithPermission(request, COMPLIANCE_WRITE);
  const body = ageOverrideSchema.parse(await jsonBody(request));
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
  return ok({ ageVerification: { id: after.id, status: after.status, verifiedAt: after.verifiedAt } });
}
