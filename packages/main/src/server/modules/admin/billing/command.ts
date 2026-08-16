import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { executeIdempotentDomainCommand } from "@/server/modules/admin/shared/domain-command";
import { persistTransactionalAdminMutation } from "@/server/modules/admin/shared/transactional-mutation";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { enforceApproval, LEDGER_APPROVAL_THRESHOLD } from "@/server/modules/admin-v2/approvals/enforcement";
import {
  actorWithPermission,
  hashHeader,
  jsonBody,
  toInputJson,
} from "@/server/modules/admin/shared/legacy-primitives";

const ledgerAdjustmentSchema = z.object({
  userId: z.string().trim().min(1),
  delta: z.number().int().refine((value) => value !== 0),
  reason: z.string().trim().min(3).max(2_000),
  sourceId: z.string().trim().max(160).optional(),
  confirmation: z.string().trim().min(1).max(160),
});

const checkoutReconciliationSchema = z
  .object({
    resolution: z.literal("refund_acknowledged"),
    providerReference: z.string().trim().min(3).max(240),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(240),
  })
  .strict();

export async function billingAdjustment(request: Request) {
  const actor = await actorWithPermission(request, "billing.ledger.adjust");
  const body = ledgerAdjustmentSchema.parse(await jsonBody(request));
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) throw Errors.badRequest("Idempotency-Key is required for ledger adjustments");
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
        requestId: request.headers.get("x-request-id") ?? randomUUID(),
        ipHash: hashHeader(request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip")),
      },
    });
    return { entry, replayed: false };
  });
  return ok({ ledgerEntry: result.entry, replayed: result.replayed });
}

export async function resolveCheckoutReconciliation(
  request: Request,
  checkoutId: string,
) {
  const actor = await actorWithPermission(
    request,
    "billing.checkout.reconcile",
  );
  const body = checkoutReconciliationSchema.parse(await jsonBody(request));
  const confirmation = `${checkoutId}:refund_acknowledged`;
  if (body.confirmation !== confirmation) {
    throw Errors.badRequest(
      "Confirmation did not match the checkout refund acknowledgement",
    );
  }
  const result = await executeIdempotentDomainCommand({
    request,
    actor,
    commandType: "billing.checkout.reconcile_refund",
    targetType: "checkout_session",
    targetId: checkoutId,
    payload: {
      resolution: body.resolution,
      providerReference: body.providerReference,
      reason: body.reason,
    },
    execute: async (tx) => {
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
        before.failureCode !==
          "provider_invoice_settled_after_abandonment" ||
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
      const acknowledgedAt = new Date();
      const evidence = isRecord(before.reconciliationEvidence)
        ? before.reconciliationEvidence
        : {};
      const resolution = {
        type: body.resolution,
        providerReference: body.providerReference,
        acknowledgedAt: acknowledgedAt.toISOString(),
        acknowledgedBy: actor.id,
      };
      const checkout = await tx.checkoutSession.update({
        where: { id: checkoutId },
        data: {
          status: "canceled",
          failureCode: "provider_invoice_refund_acknowledged",
          needsReconciliation: false,
          reconciliationEvidence: toInputJson({
            ...evidence,
            resolution,
          }),
        },
      });
      await persistTransactionalAdminMutation(tx, request, actor, {
        audit: {
          action: "billing.checkout.reconcile_refund",
          targetType: "checkout_session",
          targetId: checkoutId,
          reason: body.reason,
          before: {
            status: before.status,
            failureCode: before.failureCode,
            needsReconciliation: before.needsReconciliation,
            providerInvoiceStatus: before.providerInvoiceStatus,
            providerSessionId: before.providerSessionId,
          },
          after: {
            status: checkout.status,
            failureCode: checkout.failureCode,
            needsReconciliation: checkout.needsReconciliation,
            providerInvoiceStatus: checkout.providerInvoiceStatus,
            providerSessionId: checkout.providerSessionId,
            resolution,
          },
        },
        event: {
          eventType: "billing.checkout.reconciliation_resolved.v1",
          aggregateType: "checkout_session",
          aggregateId: checkoutId,
          payload: {
            checkoutId,
            provider: checkout.provider,
            providerInvoiceId: checkout.providerSessionId,
            resolution,
          },
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
  return ok(result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
