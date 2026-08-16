import type { AdminBillingLedgerAdjustmentRequest } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import {
  adminRequestId,
  adminRequestIpHash,
} from "@/server/modules/admin-v2/shared/audit-request";
import {
  enforceApproval,
  LEDGER_APPROVAL_THRESHOLD,
} from "@/server/modules/admin-v2/shared/dual-approval";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";

/**
 * SPEC: 按 Idempotency-Key 记一笔管理员账本调整；同一把钥匙重放返回同一条分录。
 *
 * INTENT: 幂等**不**走 controlPlaneCommand，而是继续由 DreamcoinLedger 的
 * `idempotencyKey` 唯一约束承担 —— 这是刻意保留的 v1 语义。controlPlaneCommand 的
 * requestHash 覆盖整个请求体，于是「同一把钥匙、同样的 userId/delta、只改了 reason 措辞」
 * 会被判成 409；而账本的判等只看 canonical intent（userId/delta/reason kind/sourceId），
 * 重放照样成功、金额只记一次。资金语义以账本为准，不为形式统一而改。
 *
 * INVARIANT: |delta| ≥ LEDGER_APPROVAL_THRESHOLD 时必须先消费一条已批准的双人复核请求。
 */
export async function billingAdjustment(
  request: Request,
  actor: AdminActor,
  body: AdminBillingLedgerAdjustmentRequest,
  idempotencyKey: string,
) {
  if (body.confirmation !== `${body.userId}:${body.delta}`) {
    throw Errors.badRequest("Confirmation did not match ledger adjustment target");
  }
  const result = await prisma.$transaction(async (tx) => {
    const replay = await tx.dreamcoinLedger.findUnique({ where: { idempotencyKey } });
    if (replay) {
      const entry = await postDreamcoinEntry(tx, {
        kind: "admin_adjust",
        userId: body.userId,
        delta: body.delta,
        actorId: actor.id,
        adjustmentReason: body.reason,
        sourceId: body.sourceId ?? idempotencyKey,
        idempotencyKey,
      });
      return { entry, replayed: true };
    }
    const user = await tx.user.findUnique({ where: { id: body.userId } });
    if (!user) throw Errors.notFound("User not found");
    if (Math.abs(body.delta) >= LEDGER_APPROVAL_THRESHOLD) {
      await enforceApproval("billing.ledger.adjust", body.userId, tx);
    }
    const entry = await postDreamcoinEntry(tx, {
      kind: "admin_adjust",
      userId: body.userId,
      delta: body.delta,
      actorId: actor.id,
      adjustmentReason: body.reason,
      sourceId: body.sourceId ?? idempotencyKey,
      idempotencyKey,
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "billing.ledger.adjust",
        targetType: "user",
        targetId: body.userId,
        reason: body.reason,
        after: toInputJson({
          ledgerEntryId: entry.id,
          delta: entry.delta,
          balanceAfter: entry.balanceAfter,
          sourceId: entry.sourceId,
          idempotencyKey,
        }),
        requestId: adminRequestId(request),
        ipHash: adminRequestIpHash(request),
      },
    });
    return { entry, replayed: false };
  });
  return {
    ledgerEntry: {
      id: result.entry.id,
      userId: result.entry.userId,
      delta: result.entry.delta,
      balanceAfter: result.entry.balanceAfter,
      reason: result.entry.reason,
      sourceId: result.entry.sourceId,
      createdAt: result.entry.createdAt.toISOString(),
    },
    replayed: result.replayed,
  };
}
