import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { appendLedger } from "./ledger";
import { enforceApproval, LEDGER_APPROVAL_THRESHOLD } from "@/server/modules/admin/shared/legacy-approval";
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
      if (replay.userId !== body.userId || replay.delta !== body.delta || replay.reason !== "admin_adjust") {
        throw Errors.conflict("Idempotency-Key was already used for a different ledger adjustment");
      }
      return { entry: replay, replayed: true };
    }
    const user = await tx.user.findUnique({ where: { id: body.userId } });
    if (!user) throw Errors.notFound("User not found");
    if (Math.abs(body.delta) >= LEDGER_APPROVAL_THRESHOLD) {
      await enforceApproval("billing.ledger.adjust", body.userId, tx);
    }
    const entry = await appendLedger(
      tx,
      body.userId,
      body.delta,
      "admin_adjust",
      body.sourceId ?? `admin-adjust:${actor.id}:${idempotencyKey}`,
      idempotencyKey,
    );
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
