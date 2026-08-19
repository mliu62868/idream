import type { AdminBillingCheckoutReconcileRequest } from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import {
  adminRequestId,
  adminRequestIpHash,
  adminRequestUserAgent,
} from "@/server/modules/admin-v2/shared/audit-request";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";

/**
 * SPEC: 关闭一条「已放弃但供应商事后结算」的 checkout 异常 —— 运营已在供应商侧完成退款，
 * 这里只记录既成事实，不发起任何资金动作。
 * INVARIANT: 只接受 provider_unknown + provider_invoice_settled_after_abandonment +
 * needsReconciliation + providerInvoiceStatus=settled 的 checkout，其余一律 409。
 */
export async function resolveCheckoutReconciliation(
  request: Request,
  actor: AdminActor,
  checkoutId: string,
  body: AdminBillingCheckoutReconcileRequest,
  idempotencyKey: string,
) {
  if (body.confirmation !== `${checkoutId}:refund_acknowledged`) {
    throw Errors.badRequest(
      "Confirmation did not match the checkout refund acknowledgement",
    );
  }
  const requestId = adminRequestId(request);
  const result = await executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey,
    requestId,
    commandType: "billing.checkout.reconcile_refund",
    target: { type: "checkout_session", id: checkoutId },
    payload: {
      resolution: body.resolution,
      providerReference: body.providerReference,
      reason: body.reason,
    },
    decorateResult: (value, replayed) => ({
      ...(value as Record<string, unknown>),
      replayed,
    }),
    mutate: async (tx) => {
      await tx.$queryRaw`SELECT id FROM "checkout_sessions" WHERE id = ${checkoutId} FOR UPDATE`;
      const before = await tx.checkoutSession.findUnique({
        where: { id: checkoutId },
        include: { user: { select: { dataClass: true } } },
      });
      if (!before) throw Errors.notFound("Checkout reconciliation not found");
      if (before.user.dataClass !== "customer") {
        throw Errors.conflict(
          "Checkout reconciliation is outside customer billing authority",
        );
      }
      if (
        before.status !== "provider_unknown" ||
        before.failureCode !== "provider_invoice_settled_after_abandonment" ||
        before.needsReconciliation !== true ||
        before.providerInvoiceStatus !== "settled" ||
        !before.providerSessionId
      ) {
        throw Errors.conflict(
          "Checkout is not an unresolved abandoned late settlement",
          {
            checkoutId,
            failureCode: before.failureCode,
            needsReconciliation: before.needsReconciliation,
            providerInvoiceStatus: before.providerInvoiceStatus,
            status: before.status,
          },
        );
      }
      const evidence = isRecord(before.reconciliationEvidence)
        ? before.reconciliationEvidence
        : {};
      const resolution = {
        type: body.resolution,
        providerReference: body.providerReference,
        acknowledgedAt: new Date().toISOString(),
        acknowledgedBy: actor.id,
      };
      const checkout = await tx.checkoutSession.update({
        where: { id: checkoutId },
        data: {
          status: "canceled",
          failureCode: "provider_invoice_refund_acknowledged",
          needsReconciliation: false,
          reconciliationEvidence: toInputJson({ ...evidence, resolution }),
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: "billing.checkout.reconcile_refund",
          targetType: "checkout_session",
          targetId: checkoutId,
          reason: body.reason,
          before: toInputJson({
            status: before.status,
            failureCode: before.failureCode,
            needsReconciliation: before.needsReconciliation,
            providerInvoiceStatus: before.providerInvoiceStatus,
            providerSessionId: before.providerSessionId,
          }),
          after: toInputJson({
            status: checkout.status,
            failureCode: checkout.failureCode,
            needsReconciliation: checkout.needsReconciliation,
            providerInvoiceStatus: checkout.providerInvoiceStatus,
            providerSessionId: checkout.providerSessionId,
            resolution,
          }),
          requestId,
          ipHash: adminRequestIpHash(request),
          userAgent: adminRequestUserAgent(request),
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "billing.checkout.reconciliation_resolved.v1",
          aggregateType: "checkout_session",
          aggregateId: checkoutId,
          payload: toInputJson({
            checkoutId,
            provider: checkout.provider,
            providerInvoiceId: checkout.providerSessionId,
            resolution,
            actorId: actor.id,
            actorRole: actor.role,
            requestId,
          }),
        },
      });
      return {
        checkout: {
          id: checkout.id,
          status: checkout.status,
          failureCode: checkout.failureCode,
          needsReconciliation: checkout.needsReconciliation,
          providerInvoiceStatus: checkout.providerInvoiceStatus,
          providerSessionId: checkout.providerSessionId,
        },
        resolution,
      };
    },
  });
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
