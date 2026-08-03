import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { postDreamcoinEntry } from "./ledger";

type LedgerRow = {
  id: string;
  userId: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  sourceId: string | null;
  idempotencyKey: string | null;
};

function inMemoryLedger() {
  const rows: LedgerRow[] = [];
  const settlementLinks: Array<{ requestId: string; ledgerEntryId: string; kind: string }> = [];
  let creates = 0;
  const tx = {
    $queryRaw: async () => [],
    dreamcoinLedger: {
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
        rows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null,
      aggregate: async ({ where }: { where: { userId: string } }) => ({
        _sum: {
          delta: rows
            .filter((row) => row.userId === where.userId)
            .reduce((sum, row) => sum + row.delta, 0),
        },
      }),
      create: async ({ data }: { data: Omit<LedgerRow, "id"> }) => {
        creates += 1;
        const row = { id: `ledger-${creates}`, ...data };
        rows.push(row);
        return row;
      },
    },
    generationSettlementLink: {
      upsert: async ({ create }: { create: { requestId: string; ledgerEntryId: string; kind: string } }) => {
        if (!settlementLinks.some((link) => link.ledgerEntryId === create.ledgerEntryId)) {
          settlementLinks.push(create);
        }
        return create;
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, rows, settlementLinks, creates: () => creates };
}

describe("postDreamcoinEntry", () => {
  it("derives the stored sign and only links generation settlement intents", async () => {
    const ledger = inMemoryLedger();

    await postDreamcoinEntry(ledger.tx, {
      kind: "signup_bonus",
      userId: "user-1",
      amount: 250,
      sourceId: "signup:user-1",
      idempotencyKey: "signup_bonus:user-1",
    });
    await postDreamcoinEntry(ledger.tx, {
      kind: "generation_spend",
      userId: "user-1",
      amount: 40,
      sourceId: "request-1",
      idempotencyKey: "generation:request-1:reserve",
    });
    await postDreamcoinEntry(ledger.tx, {
      kind: "refund",
      userId: "user-1",
      amount: 10,
      sourceId: "request-1",
      idempotencyKey: "generation:request-1:partial-refund",
    });

    expect(ledger.rows.map(({ delta, reason, balanceAfter }) => ({ delta, reason, balanceAfter }))).toEqual([
      { delta: 250, reason: "signup_bonus", balanceAfter: 250 },
      { delta: -40, reason: "generation_spend", balanceAfter: 210 },
      { delta: 10, reason: "refund", balanceAfter: 220 },
    ]);
    expect(ledger.settlementLinks).toEqual([
      { requestId: "request-1", ledgerEntryId: "ledger-2", kind: "generation_spend" },
      { requestId: "request-1", ledgerEntryId: "ledger-3", kind: "refund" },
    ]);
  });

  it("returns the same entry for an identical idempotency key and intent", async () => {
    const ledger = inMemoryLedger();
    const intent = {
      kind: "redeem" as const,
      userId: "user-1",
      amount: 100,
      sourceId: "redemption-1",
      idempotencyKey: "redeem:redemption-1",
    };

    const first = await postDreamcoinEntry(ledger.tx, intent);
    const replay = await postDreamcoinEntry(ledger.tx, intent);

    expect(replay).toEqual(first);
    expect(ledger.creates()).toBe(1);
  });

  it("canonicalizes referral and admin-adjustment identities", async () => {
    const ledger = inMemoryLedger();
    await postDreamcoinEntry(ledger.tx, {
      kind: "referral",
      beneficiary: "inviter",
      userId: "user-1",
      amount: 150,
      sourceId: "invitee-1",
      idempotencyKey: "referral_inviter:invitee-1",
    });
    await postDreamcoinEntry(ledger.tx, {
      kind: "admin_adjust",
      userId: "user-1",
      delta: -25,
      actorId: "admin-1",
      adjustmentReason: "Reverse duplicate grant",
      sourceId: "case-1",
      idempotencyKey: "admin-adjustment-1",
    });

    expect(ledger.rows[0]).toMatchObject({
      delta: 150,
      reason: "referral",
      sourceId: "referral:inviter:invitee-1",
    });
    expect(ledger.rows[1]).toMatchObject({
      delta: -25,
      reason: "admin_adjust",
      sourceId: "admin-adjust:admin-1:case-1",
    });
    expect(ledger.settlementLinks).toEqual([]);
  });

  it("rejects a reused idempotency key bound to a different canonical intent", async () => {
    const ledger = inMemoryLedger();
    await postDreamcoinEntry(ledger.tx, {
      kind: "subscription_grant",
      userId: "user-1",
      amount: 500,
      sourceId: "subscription-1",
      idempotencyKey: "subscription:provider:sub-1",
    });

    await expect(postDreamcoinEntry(ledger.tx, {
      kind: "subscription_grant",
      userId: "user-1",
      amount: 600,
      sourceId: "subscription-1",
      idempotencyKey: "subscription:provider:sub-1",
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects zero, negative, or non-integer business amounts", async () => {
    const ledger = inMemoryLedger();
    for (const amount of [0, -1, 1.5]) {
      await expect(postDreamcoinEntry(ledger.tx, {
        kind: "refund",
        userId: "user-1",
        amount,
        sourceId: "request-1",
        idempotencyKey: `refund:${amount}`,
      })).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(ledger.creates()).toBe(0);
  });
});
