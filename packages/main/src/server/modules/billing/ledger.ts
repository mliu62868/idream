import { Prisma } from "@prisma/client";
import { linkGenerationLedgerEntry } from "@/server/ai/generation-settlement";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";

type PositiveLedgerIntentKind =
  | "signup_bonus"
  | "subscription_grant"
  | "generation_spend"
  | "refund"
  | "redeem";

type PositiveLedgerIntent = {
  readonly kind: PositiveLedgerIntentKind;
  readonly userId: string;
  readonly amount: number;
  readonly sourceId: string;
  readonly idempotencyKey: string;
};

export type LedgerIntent =
  | PositiveLedgerIntent
  | {
      readonly kind: "subscription_refund" | "subscription_refund_restore";
      readonly userId: string;
      readonly amount: number;
      readonly sourceId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: "referral";
      readonly beneficiary: "invitee" | "inviter";
      readonly userId: string;
      readonly amount: number;
      readonly sourceId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: "admin_adjust";
      readonly userId: string;
      readonly delta: number;
      readonly actorId: string;
      readonly adjustmentReason: string;
      readonly sourceId: string;
      readonly idempotencyKey: string;
    };

type CanonicalLedgerIntent = {
  readonly userId: string;
  readonly delta: number;
  readonly reason: string;
  readonly sourceId: string;
  readonly idempotencyKey: string;
};

// SPEC: This is the sole production writer for DreamcoinLedger.
// INVARIANT: Callers state business intent; this module owns signs, locking,
// balanceAfter, replay conflict detection, and generation settlement linkage.
export async function postDreamcoinEntry(
  tx: Prisma.TransactionClient,
  intent: LedgerIntent,
) {
  const canonical = canonicalizeLedgerIntent(intent);
  const replay = await tx.dreamcoinLedger.findUnique({
    where: { idempotencyKey: canonical.idempotencyKey },
  });
  if (replay) return acceptReplay(tx, replay, canonical);

  await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${canonical.userId} FOR UPDATE`;
  const afterLock = await tx.dreamcoinLedger.findUnique({
    where: { idempotencyKey: canonical.idempotencyKey },
  });
  if (afterLock) return acceptReplay(tx, afterLock, canonical);

  const aggregate = await tx.dreamcoinLedger.aggregate({
    where: { userId: canonical.userId },
    _sum: { delta: true },
  });
  const balance = aggregate._sum.delta ?? 0;
  try {
    const created = await tx.dreamcoinLedger.create({
      data: { ...canonical, balanceAfter: balance + canonical.delta },
    });
    await linkGenerationLedgerEntry(tx, created);
    return created;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await tx.dreamcoinLedger.findUnique({
      where: { idempotencyKey: canonical.idempotencyKey },
    });
    if (!raced) throw error;
    return acceptReplay(tx, raced, canonical);
  }
}

export async function dreamcoinBalance(
  userId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const aggregate = await tx.dreamcoinLedger.aggregate({
    where: { userId },
    _sum: { delta: true },
  });
  return aggregate._sum.delta ?? 0;
}

function canonicalizeLedgerIntent(intent: LedgerIntent): CanonicalLedgerIntent {
  const userId = requiredIdentity("userId", intent.userId);
  const idempotencyKey = requiredIdentity("idempotencyKey", intent.idempotencyKey);
  const sourceId = requiredIdentity("sourceId", intent.sourceId);

  if (intent.kind === "admin_adjust") {
    if (!Number.isSafeInteger(intent.delta) || intent.delta === 0) {
      throw Errors.badRequest("Admin ledger adjustment must be a non-zero integer");
    }
    const actorId = requiredIdentity("actorId", intent.actorId);
    requiredIdentity("adjustmentReason", intent.adjustmentReason);
    return {
      userId,
      delta: intent.delta,
      reason: "admin_adjust",
      sourceId: `admin-adjust:${actorId}:${sourceId}`,
      idempotencyKey,
    };
  }

  if (!Number.isSafeInteger(intent.amount) || intent.amount <= 0) {
    throw Errors.badRequest(`${intent.kind} amount must be a positive integer`);
  }
  if (intent.kind === "referral") {
    return {
      userId,
      delta: intent.amount,
      reason: "referral",
      sourceId: `referral:${intent.beneficiary}:${sourceId}`,
      idempotencyKey,
    };
  }
  return {
    userId,
    delta:
      intent.kind === "generation_spend" ||
      intent.kind === "subscription_refund"
        ? -intent.amount
        : intent.amount,
    reason: intent.kind,
    sourceId,
    idempotencyKey,
  };
}

async function acceptReplay<T extends {
  readonly id: string;
  readonly userId: string;
  readonly delta: number;
  readonly reason: string;
  readonly sourceId: string | null;
  readonly idempotencyKey: string | null;
}>(
  tx: Prisma.TransactionClient,
  existing: T,
  canonical: CanonicalLedgerIntent,
): Promise<T> {
  if (
    existing.userId !== canonical.userId ||
    existing.delta !== canonical.delta ||
    existing.reason !== canonical.reason ||
    existing.sourceId !== canonical.sourceId ||
    existing.idempotencyKey !== canonical.idempotencyKey
  ) {
    throw Errors.conflict("Idempotency key is bound to a different ledger intent");
  }
  await linkGenerationLedgerEntry(tx, existing);
  return existing;
}

function requiredIdentity(field: string, value: string) {
  const normalized = value.trim();
  if (!normalized) throw Errors.badRequest(`${field} is required for ledger intent`);
  return normalized;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
