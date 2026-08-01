import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { renderPrometheusMetrics, resetMetricsForTests } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import {
  acceptControlPlaneCommand,
  canonicalRequestHash,
  claimControlPlaneCommand,
  IdempotencyConflictError,
  reconcileExpiredCommandLeases,
} from "./control-plane-command";
import { ingestProductEvent } from "./product-event-store";
import { canonicalSha256 } from "./canonical-json";
import { transitionControlPlaneCommandAttempt } from "./control-plane-command-attempt";
import { transitionControlPlaneCommand } from "./control-plane-command-transition";

const reliabilityActorIds = ["admin-v2-test", "approval-requester"] as const;

async function cleanupReliabilityFixtures() {
  const [commands, productEvents] = await Promise.all([
    prisma.controlPlaneCommand.findMany({
      where: { actorId: { in: [...reliabilityActorIds] } },
      select: { id: true },
    }),
    prisma.analyticsEvent.findMany({
      where: { sourceService: "admin-test" },
      select: { id: true },
    }),
  ]);
  const commandIds = commands.map((command) => command.id);
  const productEventIds = productEvents.map((event) => event.id);
  if (commandIds.length > 0) {
    await prisma.mainOutboxEvent.deleteMany({
      where: {
        eventType: "admin.command.accepted.v2",
        OR: commandIds.map((commandId) => ({
          payload: { path: ["commandId"], equals: commandId },
        })),
      },
    });
    await prisma.controlPlaneCommandAttempt.deleteMany({
      where: { commandId: { in: commandIds } },
    });
    await prisma.controlPlaneCommand.deleteMany({
      where: { id: { in: commandIds } },
    });
  }
  if (productEventIds.length > 0) {
    await prisma.metricProjectionReceipt.deleteMany({
      where: { canonicalEventId: { in: productEventIds } },
    });
    await prisma.mainOutboxEvent.deleteMany({
      where: {
        eventType: "product.event.persisted.v2",
        aggregateId: { in: productEventIds },
      },
    });
    await prisma.analyticsEvent.deleteMany({
      where: { id: { in: productEventIds } },
    });
  }
  await prisma.inboundEventReceipt.deleteMany({
    where: {
      sourceService: {
        in: ["admin-test", "main.product_projection:admin-test"],
      },
    },
  });
  await prisma.adminAuditLog.deleteMany({
    where: { actorId: { in: [...reliabilityActorIds] } },
  });
  await prisma.adminActionRequest.deleteMany({
    where: { requestedById: "approval-requester" },
  });
}

beforeEach(async () => {
  resetMetricsForTests();
  await cleanupReliabilityFixtures();
});

afterAll(async () => {
  await cleanupReliabilityFixtures();
  await expect(prisma.analyticsEvent.count({
    where: { sourceService: "admin-test" },
  })).resolves.toBe(0);
  await expect(prisma.inboundEventReceipt.count({
    where: {
      sourceService: {
        in: ["admin-test", "main.product_projection:admin-test"],
      },
    },
  })).resolves.toBe(0);
  await prisma.$disconnect();
});

describe("Admin v2 command reliability", () => {
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
    for (const changed of [
      { ...base, commandType: "character.release.schedule" },
      { ...base, target: { ...base.target, id: "release-2" } },
      { ...base, target: { ...base.target, type: "character_serving" } },
      { ...base, expectedVersion: 8 },
      { ...base, approvalId: "approval-2" },
      { ...base, payload: { ...base.payload, reason: "changed" } },
    ]) {
      expect(canonicalRequestHash(changed)).not.toBe(canonicalRequestHash(base));
    }
    expect(canonicalRequestHash({ ...base, retryMode: "idempotent" })).not.toBe(
      canonicalRequestHash(base),
    );
  });

  it("replays the same idempotent command without duplicating command, audit, or outbox effects", async () => {
    const idempotencyKey = randomUUID();
    const input = {
      environment: "test",
      actor: { id: "admin-v2-test", role: "admin" },
      idempotencyKey,
      coordinationKey: "incident:incident-1",
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
    expect(await prisma.controlPlaneCommand.count({
      where: { id: first.commandId },
    })).toBe(1);
    await expect(prisma.controlPlaneCommand.findUnique({ where: { id: first.commandId } }))
      .resolves.toMatchObject({ coordinationKey: "incident:incident-1" });
    expect(await prisma.mainOutboxEvent.count({
      where: {
        eventType: "admin.command.accepted.v2",
        payload: { path: ["commandId"], equals: first.commandId },
      },
    })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { actorId: "admin-v2-test" } })).toBe(1);
    const metrics = renderPrometheusMetrics();
    expect(metrics).toContain('admin_command_total{outcome="accepted",type="incident.resolve"} 1');
    expect(metrics).toContain('admin_command_total{outcome="replayed",type="incident.resolve"} 1');
    expect(metrics).toContain("admin_command_duration_seconds_count");
  });

  it("accepts only one active command for a coordination key across different idempotency keys", async () => {
    const coordinationKey = `character:${randomUUID()}`;
    const base = {
      environment: "test",
      actor: { id: "admin-v2-test", role: "admin" },
      coordinationKey,
      commandType: "character.release.publish",
      target: { type: "character_release", id: "release-coordinated" },
      expectedVersion: 4,
      payload: { reason: "validated launch" },
      reason: "publish coordinated release",
      requestId: randomUUID(),
    } as const;

    const results = await Promise.allSettled([
      acceptControlPlaneCommand(prisma, { ...base, idempotencyKey: randomUUID() }),
      acceptControlPlaneCommand(prisma, { ...base, idempotencyKey: randomUUID() }),
    ]);
    const fulfilled = results.find((result) => result.status === "fulfilled");
    const rejected = results.find((result) => result.status === "rejected");
    if (!fulfilled || fulfilled.status !== "fulfilled") {
      throw new Error("Expected one coordinated command to be accepted");
    }
    if (!rejected || rejected.status !== "rejected") {
      throw new Error("Expected one coordinated command to be rejected");
    }

    expect(rejected.reason).toMatchObject({
      code: "conflict",
      status: 409,
      details: {
        activeCommandId: fulfilled.value.commandId,
        activeCommandType: "character.release.publish",
        activeCommandStatus: "accepted",
      },
    });
    await expect(prisma.controlPlaneCommand.count({ where: { coordinationKey } }))
      .resolves.toBe(1);
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

  it("atomically consumes a canonically bound approval so concurrent commands cannot both pass", async () => {
    const payload = { reason: { code: "verified", summary: "Recovery evidence passed" }, confirmation: "incident-approval:resolve" };
    const approval = await prisma.adminActionRequest.create({ data: {
      requestedById: "approval-requester",
      approvedById: "independent-approver",
      permissionKey: "ops.incident.manage",
      action: "incident.resolve",
      targetType: "ops_incident",
      targetId: "incident-approval",
      status: "approved",
      decidedAt: new Date(),
      payload: {
        commandType: "incident.resolve",
        targetType: "ops_incident",
        targetId: "incident-approval",
        payloadHash: canonicalSha256(payload),
        expectedVersion: 9,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    } });
    const base = {
      environment: "test",
      actor: { id: "approval-requester", role: "admin" },
      commandType: "incident.resolve",
      target: { type: "ops_incident", id: "incident-approval" },
      expectedVersion: 9,
      payload,
      approvalId: approval.id,
      approvalPermissionKey: "ops.incident.manage",
      retryMode: "idempotent" as const,
      reason: "Independent approval granted",
      requestId: randomUUID(),
    };

    const results = await Promise.allSettled([
      acceptControlPlaneCommand(prisma, { ...base, idempotencyKey: randomUUID() }),
      acceptControlPlaneCommand(prisma, { ...base, idempotencyKey: randomUUID() }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(prisma.adminActionRequest.findUnique({ where: { id: approval.id } })).resolves.toMatchObject({ status: "consumed" });
    await expect(prisma.controlPlaneCommand.count({ where: { approvalId: approval.id } })).resolves.toBe(1);
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
      retryMode: "idempotent",
    });
    const exhausted = await acceptControlPlaneCommand(prisma, {
      ...base,
      idempotencyKey: randomUUID(),
      maxAttempts: 1,
      retryMode: "idempotent",
    });
    const nonReplayable = await acceptControlPlaneCommand(prisma, {
      ...base,
      idempotencyKey: randomUUID(),
      maxAttempts: 2,
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
        commandId: nonReplayable.commandId,
        workerId: "worker-c",
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
    expect(
      await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: nonReplayable.commandId } }),
    ).toMatchObject({
      status: "failed",
      needsReconciliation: true,
      leaseOwner: null,
      error: expect.objectContaining({ code: "lease_expired_non_replayable" }),
    });
    const metrics = renderPrometheusMetrics();
    expect(metrics).toContain('admin_command_lease_expired_total{outcome="requeued"} 1');
    expect(metrics).toContain('admin_command_lease_expired_total{outcome="failed"} 2');
  });

  it("keeps a terminal command attempt immutable when a later executor reports another outcome", async () => {
    const accepted = await acceptControlPlaneCommand(prisma, {
      environment: "test",
      actor: { id: "admin-v2-test", role: "admin" },
      idempotencyKey: randomUUID(),
      commandType: "case.close",
      target: { type: "admin_case", id: "case-terminal-attempt" },
      expectedVersion: 1,
      payload: {},
      reason: "exercise terminal attempt authority",
      requestId: randomUUID(),
    });
    const claimed = await claimControlPlaneCommand(prisma, {
      commandId: accepted.commandId,
      workerId: "terminal-attempt-worker",
      leaseMs: 30_000,
    });
    expect(claimed).toMatchObject({ attemptCount: 1 });

    const succeededAt = new Date("2026-07-11T12:00:00.000Z");
    await prisma.$transaction((tx) => transitionControlPlaneCommandAttempt(tx, {
      commandId: accepted.commandId,
      attemptNo: 1,
      to: "succeeded",
      data: { finishedAt: succeededAt },
    }));
    await expect(prisma.$transaction((tx) => transitionControlPlaneCommandAttempt(tx, {
      commandId: accepted.commandId,
      attemptNo: 1,
      to: "failed",
      data: { finishedAt: new Date("2026-07-11T12:00:01.000Z"), error: { code: "late_failure" } },
    }))).rejects.toThrow("succeeded -> failed");
    await expect(prisma.controlPlaneCommandAttempt.findUniqueOrThrow({
      where: { commandId_attemptNo: { commandId: accepted.commandId, attemptNo: 1 } },
    })).resolves.toMatchObject({ status: "succeeded", finishedAt: succeededAt, error: null });
  });

  it("fails closed for illegal or racing ControlPlaneCommand transitions", async () => {
    const illegal = await acceptControlPlaneCommand(prisma, {
      environment: "test",
      actor: { id: "admin-v2-test", role: "admin" },
      idempotencyKey: randomUUID(),
      commandType: "case.close",
      target: { type: "admin_case", id: "case-command-transition-illegal" },
      payload: {},
      reason: "exercise command transition authority",
      requestId: randomUUID(),
    });
    await expect(prisma.$transaction((tx) => transitionControlPlaneCommand(tx, {
      commandId: illegal.commandId,
      to: "succeeded",
    }))).rejects.toThrow("accepted -> succeeded");
    await expect(prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: illegal.commandId } }))
      .resolves.toMatchObject({ status: "accepted" });

    const racing = await acceptControlPlaneCommand(prisma, {
      environment: "test",
      actor: { id: "admin-v2-test", role: "admin" },
      idempotencyKey: randomUUID(),
      commandType: "case.close",
      target: { type: "admin_case", id: "case-command-transition-race" },
      payload: {},
      reason: "exercise command transition CAS",
      requestId: randomUUID(),
    });
    const results = await Promise.allSettled([
      prisma.$transaction((tx) => transitionControlPlaneCommand(tx, {
        commandId: racing.commandId,
        to: "running",
        expected: { from: "accepted", leaseOwner: null, attemptCount: 0 },
        data: { leaseOwner: "worker-a", attemptCount: 1 },
      })),
      prisma.$transaction((tx) => transitionControlPlaneCommand(tx, {
        commandId: racing.commandId,
        to: "running",
        expected: { from: "accepted", leaseOwner: null, attemptCount: 0 },
        data: { leaseOwner: "worker-b", attemptCount: 1 },
      })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: racing.commandId } }))
      .resolves.toMatchObject({ status: "running", attemptCount: 1 });
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
    if (first.status !== "persisted") {
      throw new Error(`Expected a persisted product event, received ${first.status}`);
    }
    expect(replay).toMatchObject({ status: "duplicate", eventId: first.eventId });
    expect(
      await prisma.inboundEventReceipt.count({ where: { sourceService: "admin-test", sourceEventId } }),
    ).toBe(1);
    expect(
      await prisma.analyticsEvent.count({ where: { sourceService: "admin-test", sourceEventId } }),
    ).toBe(1);
    expect(
      await prisma.mainOutboxEvent.count({
        where: {
          eventType: "product.event.persisted.v2",
          aggregateId: first.eventId,
        },
      }),
    ).toBe(1);
    const metrics = renderPrometheusMetrics();
    expect(metrics).toContain('main_inbound_events_total{outcome="persisted",source="admin-test"} 1');
    expect(metrics).toContain('main_inbound_events_total{outcome="duplicate",source="admin-test"} 1');
    expect(metrics).toContain("main_inbound_event_lag_seconds_count");
    expect(metrics).toContain("durable_ingest_ack_latency_seconds_count");
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
    await expect(ingestProductEvent(prisma, event)).resolves.toMatchObject({
      status: "quarantined",
    });
    expect(
      await prisma.inboundEventReceipt.findUniqueOrThrow({
        where: { sourceService_sourceEventId: { sourceService: "admin-test", sourceEventId } },
        select: { processingState: true, quarantinedAt: true },
      }),
    ).toMatchObject({ processingState: "quarantined", quarantinedAt: expect.any(Date) });
    expect(
      await prisma.analyticsEvent.count({ where: { sourceService: "admin-test", sourceEventId } }),
    ).toBe(1);
    const canonical = await prisma.analyticsEvent.findUniqueOrThrow({
      where: {
        sourceService_sourceEventId: {
          sourceService: "admin-test",
          sourceEventId,
        },
      },
      select: { id: true },
    });
    expect(
      await prisma.mainOutboxEvent.count({
        where: {
          eventType: "product.event.persisted.v2",
          aggregateId: canonical.id,
        },
      }),
    ).toBe(1);
  });
});
