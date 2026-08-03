import type { Prisma } from "@prisma/client";
import { postDreamcoinEntry } from "@/server/modules/admin/billing/ledger";
import { ensureGenerationSettlementLinks } from "./generation-settlement";

// SPEC: why a Generation Request is being refunded. The cause — not the call
// site — owns the ledger idempotency identity, so two different business
// intents can never share one.
// INTENT: `partial` is deliberately one cause for both the normal completion
// path and late unknown-success adoption: both mean "fewer outputs delivered
// than purchased", and sharing one identity is what stops a Request from being
// partially refunded twice.
export type GenerationRefundCause =
  | { readonly kind: "cancel" }
  | { readonly kind: "partial" }
  | { readonly kind: "failed" }
  | { readonly kind: "unknown_confirmed" }
  | { readonly kind: "operator_manual" }
  | { readonly kind: "incident_action"; readonly commandId: string };

export function generationRefundIdempotencyKey(
  requestId: string,
  cause: GenerationRefundCause,
): string {
  switch (cause.kind) {
    case "cancel":
      return `generation:${requestId}:cancel-refund`;
    case "partial":
      return `generation:${requestId}:partial-refund`;
    case "failed":
      return `generation:${requestId}:refund`;
    case "unknown_confirmed":
      return `generation:${requestId}:unknown-confirmed-failed-refund`;
    // INTENT: an operator discard must be distinguishable from the automatic
    // failure refund. Sharing `:refund` made a replay look like a success and
    // left the operator unable to tell whether their click did anything.
    case "operator_manual":
      return `generation:${requestId}:operator-manual-refund`;
    case "incident_action":
      return `incident:${cause.commandId}:refund:${requestId}`;
  }
}

// SPEC: the single refund entry point for a Generation Request; returns the
// Dreamcoins actually credited, 0 when nothing was left to give back. Callers
// own the business policy for how much they would like back; this module owns
// the ledger identity and the settlement clamp.
// INVARIANT: never credits more than the Request still has captured but
// unrefunded, whatever the requested amount or the cause. That clamp — not the
// idempotency key — is what makes distinct causes safe to coexist on one
// Request, and what makes a replay of one cause return 0 instead of paying
// twice.
export async function refundGenerationRequest(
  tx: Prisma.TransactionClient,
  input: {
    readonly requestId: string;
    readonly userId: string;
    readonly cause: GenerationRefundCause;
    /** Omit to return the whole unrefunded remainder. */
    readonly requested?: number;
  },
): Promise<number> {
  const settlement = await ensureGenerationSettlementLinks(tx, input.requestId);
  const amount = Math.min(
    input.requested ?? settlement.refundable,
    settlement.refundable,
  );
  if (amount <= 0) return 0;

  const entry = await postDreamcoinEntry(tx, {
    kind: "refund",
    userId: input.userId,
    amount,
    sourceId: input.requestId,
    idempotencyKey: generationRefundIdempotencyKey(input.requestId, input.cause),
  });
  return entry.delta;
}
