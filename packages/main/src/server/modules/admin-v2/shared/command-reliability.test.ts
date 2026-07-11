import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  acceptControlPlaneCommand,
  canonicalRequestHash,
  claimControlPlaneCommand,
  IdempotencyConflictError,
  reconcileExpiredCommandLeases,
} from "./control-plane-command";
import { ingestProductEvent } from "./product-event-store";

describe("Admin v2 command reliability", () => {
  beforeEach(async () => {
    await prisma.mainOutboxEvent.deleteMany();
    await prisma.controlPlaneCommandAttempt.deleteMany();
    await prisma.controlPlaneCommand.deleteMany();
    await prisma.inboundEventReceipt.deleteMany();
    await prisma.analyticsEvent.deleteMany({ where: { sourceService: "admin-test" } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: "admin-v2-test" } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("hashes the complete canonical command request independent of object key order", () => {
    const base = {
      commandType: "character.release.publish",
      target: { type: "character_release", id: "release-1" },
      expectedVersion: 7,
      payload: { nested: { b: 2, a: 1 }, reason: "ready" },
      approvalId: "approval-1",
    };

    expect(canonicalRequestHash(base)).toBe(
      canonicalRequestHash({
        approvalId: "approval-1",
        payload: { reason: "ready", nested: { a: 1, b: 2 } },
        expectedVersion: 7,
        target: { id: "release-1", type: "character_release" },
        commandType: "character.release.publish",
      }),
    );
    expect(canonicalRequestHash({ ...base, expectedVersion: 8 })).not.toBe(
      canonicalRequestHash(base),
    );
  });

  it("replays the same idempotent command without duplicating command, audit, or outbox effects", async () => {
    const idempotencyKey = randomUUID();
    const input = {
      environment: "test",
      actor: { id: "admin-v2-test", role: "admin" },
      idempotencyKey,
      commandType: "incident.resolve",
      target: { type: "ops_incident", id: "incident-1" },
      expectedVersion: 3,
      payload: { reason: "recovery window passed" },
      reason: "verified recovery",
      requestId: randomUUID(),
    } as const;

    const first = await acceptControlPlaneCommand(prisma, input);
    const replay = await acceptControlPlaneCommand(prisma, { ...input, requestId: randomUUID() });

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ commandId: first.commandId, replayed: true });
    expect(await prisma.controlPlaneCommand.count()).toBe(1);
    expect(await prisma.mainOutboxEvent.count()).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { actorId: "admin-v2-test" } })).toBe(1);
  });

  it("rejects reuse of an idempotency key for a different canonical request", async () => {
    const idempotencyKey = randomUUID();
    const input = {
      environment: "test",
      actor: { id: "admin-v2-test", role: "admin" },
      idempotencyKey,
      commandType: "creative.run.retry_failed",
      target: { type: "creative_run", id: "run-1" },
      expectedVersion: 2,
      payload: { failedItemIds: ["item-1"] },
      reason: "provider recovered",
      requestId: randomUUID(),
    } as const;

    await acceptControlPlaneCommand(prisma, input);

    await expect(
      acceptControlPlaneCommand(prisma, {
        ...input,
        target: { type: "creative_run", id: "run-2" },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("reclaims an expired lease when retry budget remains and fails closed when exhausted", async () => {
    const base = {
      environment: "test",
      actor: { id: "admin-v2-test", role: "admin" },
      commandType: "case.verify",
      target: { type: "admin_case", id: "case-1" },
      expectedVersion: 1,
      payload: {},
      reason: "verify downstream effect",
      requestId: randomUUID(),
    } as const;
    const retryable = await acceptControlPlaneCommand(prisma, {
      ...base,
      idempotencyKey: randomUUID(),
      maxAttempts: 2,
    });
    const exhausted = await acceptControlPlaneCommand(prisma, {
      ...base,
      idempotencyKey: randomUUID(),
      maxAttempts: 1,
    });

    expect(
      await claimControlPlaneCommand(prisma, {
        commandId: retryable.commandId,
        workerId: "worker-a",
        leaseMs: 1_000,
        now: new Date("2026-07-11T12:00:00.000Z"),
      }),
    ).toMatchObject({ status: "running", attemptCount: 1 });
    expect(
      await claimControlPlaneCommand(prisma, {
        commandId: exhausted.commandId,
        workerId: "worker-b",
        leaseMs: 1_000,
        now: new Date("2026-07-11T12:00:00.000Z"),
      }),
    ).toMatchObject({ status: "running", attemptCount: 1 });

    await reconcileExpiredCommandLeases(prisma, new Date("2026-07-11T12:00:02.000Z"));

    expect(
      await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: retryable.commandId } }),
    ).toMatchObject({ status: "accepted", needsReconciliation: false, leaseOwner: null });
    expect(
      await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: exhausted.commandId } }),
    ).toMatchObject({ status: "failed", needsReconciliation: true, leaseOwner: null });
  });
});

describe("canonical product event durable ingest", () => {
  it("atomically persists a receipt and canonical event and safely acknowledges an exact replay", async () => {
    const sourceEventId = randomUUID();
    const event = {
      sourceService: "admin-test",
      sourceEventId,
      eventType: "admin.command.completed.v2",
      schemaVersion: 2,
      occurredAt: new Date("2026-07-11T12:00:00.000Z"),
      environment: "production",
      dataClass: "audit",
      trustClass: "canonical",
      actor: { userId: "admin-v2-test", isInternal: true },
      context: { commandId: "command-1" },
      payload: { outcome: "succeeded" },
    } as const;

    const first = await ingestProductEvent(prisma, event);
    const replay = await ingestProductEvent(prisma, event);

    expect(first).toMatchObject({ status: "persisted" });
    expect(replay).toMatchObject({ status: "duplicate", eventId: first.eventId });
    expect(
      await prisma.inboundEventReceipt.count({ where: { sourceService: "admin-test", sourceEventId } }),
    ).toBe(1);
    expect(
      await prisma.analyticsEvent.count({ where: { sourceService: "admin-test", sourceEventId } }),
    ).toBe(1);
  });

  it("quarantines the source key when a replay carries a different payload", async () => {
    const sourceEventId = randomUUID();
    const event = {
      sourceService: "admin-test",
      sourceEventId,
      eventType: "generation.attempt.failed.v2",
      schemaVersion: 2,
      occurredAt: new Date("2026-07-11T12:00:00.000Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { isInternal: false },
      context: { generationRequestId: "request-1" },
      payload: { errorCode: "timeout" },
    } as const;

    await ingestProductEvent(prisma, event);
    const conflict = await ingestProductEvent(prisma, {
      ...event,
      payload: { errorCode: "provider_rejected" },
    });

    expect(conflict.status).toBe("quarantined");
    expect(
      await prisma.inboundEventReceipt.findUniqueOrThrow({
        where: { sourceService_sourceEventId: { sourceService: "admin-test", sourceEventId } },
        select: { processingState: true, quarantinedAt: true },
      }),
    ).toMatchObject({ processingState: "quarantined", quarantinedAt: expect.any(Date) });
    expect(
      await prisma.analyticsEvent.count({ where: { sourceService: "admin-test", sourceEventId } }),
    ).toBe(1);
  });
});
