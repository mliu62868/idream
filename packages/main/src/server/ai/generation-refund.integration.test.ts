import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import {
  generationRefundIdempotencyKey,
  refundGenerationRequest,
  type GenerationRefundCause,
} from "./generation-refund";

describe("generation refund causes", () => {
  const suffix = randomUUID();
  const userId = `refund-user-${suffix}`;
  const requestIds: string[] = [];

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@idream.internal`,
        role: "user",
        status: "active",
      },
    });
  });

  afterAll(async () => {
    await prisma.generationSettlementLink.deleteMany({
      where: { requestId: { in: requestIds } },
    });
    await prisma.dreamcoinLedger.deleteMany({ where: { userId } });
    await prisma.generationJob.deleteMany({ where: { id: { in: requestIds } } });
    await prisma.user.delete({ where: { id: userId } });
  });

  async function debitedRequest(label: string, cost = 40) {
    const id = `refund-request-${label}-${suffix}`;
    requestIds.push(id);
    await prisma.generationJob.create({
      data: {
        id,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 2,
        costDreamcoins: cost,
        status: "failed",
        provider: "mock",
      },
    });
    await prisma.$transaction((tx) =>
      postDreamcoinEntry(tx, {
        kind: "generation_spend",
        userId,
        amount: cost,
        sourceId: id,
        idempotencyKey: `generation:${id}:spend`,
      }),
    );
    return id;
  }

  it("gives every cause its own ledger identity", () => {
    const causes: GenerationRefundCause[] = [
      { kind: "cancel" },
      { kind: "partial" },
      { kind: "failed" },
      { kind: "unknown_confirmed" },
      { kind: "operator_manual" },
      { kind: "incident_action", commandId: "command-1" },
    ];
    const keys = causes.map((cause) =>
      generationRefundIdempotencyKey("request-1", cause)
    );

    expect(new Set(keys).size).toBe(causes.length);
    // The operator's manual discard must never share the automatic failure
    // refund's identity — otherwise a replay is indistinguishable from a
    // refund that actually happened on this click.
    expect(generationRefundIdempotencyKey("request-1", { kind: "failed" }))
      .not.toBe(
        generationRefundIdempotencyKey("request-1", { kind: "operator_manual" }),
      );
  });

  it("refunds the captured amount once per cause and gives back nothing on replay", async () => {
    const requestId = await debitedRequest("replay");

    const first = await prisma.$transaction((tx) =>
      refundGenerationRequest(tx, {
        requestId,
        userId,
        cause: { kind: "failed" },
        requested: 40,
      })
    );
    const second = await prisma.$transaction((tx) =>
      refundGenerationRequest(tx, {
        requestId,
        userId,
        cause: { kind: "failed" },
        requested: 40,
      })
    );

    expect(first).toBe(40);
    expect(second).toBe(0);
    await expect(
      prisma.dreamcoinLedger.count({ where: { sourceId: requestId, reason: "refund" } }),
    ).resolves.toBe(1);
  });

  // SPEC: distinct causes are safe to coexist because the settlement clamp —
  // not the idempotency key — bounds what can be credited back.
  it("credits nothing for a second cause once the Request is fully refunded", async () => {
    const requestId = await debitedRequest("second-cause");
    await prisma.$transaction((tx) =>
      refundGenerationRequest(tx, {
        requestId,
        userId,
        cause: { kind: "failed" },
        requested: 40,
      })
    );

    const manual = await prisma.$transaction((tx) =>
      refundGenerationRequest(tx, {
        requestId,
        userId,
        cause: { kind: "operator_manual" },
        requested: 40,
      })
    );

    expect(manual).toBe(0);
    await expect(
      prisma.dreamcoinLedger.aggregate({
        where: { sourceId: requestId, reason: "refund" },
        _sum: { delta: true },
      }),
    ).resolves.toMatchObject({ _sum: { delta: 40 } });
  });

  it("clamps a requested amount to what the Request still has captured", async () => {
    const requestId = await debitedRequest("clamped", 30);

    const refund = await prisma.$transaction((tx) =>
      refundGenerationRequest(tx, {
        requestId,
        userId,
        cause: { kind: "operator_manual" },
        requested: 500,
      })
    );

    expect(refund).toBe(30);
  });

  it("credits nothing for a Request that was never debited", async () => {
    const requestId = `refund-request-undebited-${suffix}`;
    requestIds.push(requestId);
    await prisma.generationJob.create({
      data: {
        id: requestId,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 2,
        costDreamcoins: 40,
        status: "completed",
        provider: "mock",
      },
    });

    const refund = await prisma.$transaction((tx) =>
      refundGenerationRequest(tx, {
        requestId,
        userId,
        cause: { kind: "partial" },
        requested: 20,
      })
    );

    expect(refund).toBe(0);
    await expect(
      prisma.dreamcoinLedger.count({ where: { sourceId: requestId } }),
    ).resolves.toBe(0);
  });
});
