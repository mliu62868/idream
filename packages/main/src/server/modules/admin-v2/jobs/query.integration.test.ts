import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generationJobDetailResponseSchema,
  generationJobListResponseSchema,
  retryGenerationRequestResultSchema,
} from "@idream/shared/admin";
import { GET as getJobRoute } from "@/app/api/v2/admin/jobs/[id]/route";
import { POST as retryJobRoute } from "@/app/api/v2/admin/jobs/[id]/commands/retry/route";
import { GET as listJobsRoute } from "@/app/api/v2/admin/jobs/route";
import { prisma } from "@/server/lib/db";

describe("Generation Jobs v2 server query", () => {
  const suffix = randomUUID();
  const actorId = `jobs-admin-${suffix}`;
  const deniedId = `jobs-denied-${suffix}`;
  const customerId = `jobs-customer-${suffix}`;
  const characterId = `jobs-character-${suffix}`;
  const jobIds = ["a", "b", "c", "d", "e"].map((key) => `jobs-${key}-${suffix}`);
  const attemptId = `jobs-attempt-${suffix}`;
  const artifactId = `jobs-artifact-authority-${suffix}`;
  const attemptEventId = `jobs-attempt-event-${suffix}`;
  const deliveryId = `jobs-delivery-${suffix}`;
  const ledgerId = `jobs-ledger-${suffix}`;
  const settlementLinkId = `jobs-settlement-${suffix}`;
  const sameCreatedAt = new Date("2026-07-11T12:00:00.000Z");

  function request(query: string, actor = actorId, role = "admin") {
    return new Request(`http://localhost/api/v2/admin/jobs?${query}`, {
      headers: { "x-idream-user-id": actor, "x-idream-role": role },
    });
  }

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active" },
      { id: deniedId, email: `${deniedId}@example.test`, role: "user", status: "active" },
      { id: customerId, email: `${customerId}@example.test`, role: "user", status: "active" },
    ] });
    await prisma.character.create({ data: {
      id: characterId,
      name: "Jobs Fixture",
      age: 28,
      description: "Generation query fixture",
      appearance: {},
      advancedDetails: {},
    } });
    await prisma.generationJob.createMany({ data: [
      {
        id: jobIds[0], userId: customerId, characterId, mode: "image", status: "failed",
        provider: "provider-alpha", model: "needle-model", sourceType: "generator", sourceId: `source-a-${suffix}`,
        errorCode: "needle-timeout", controls: {}, presetIds: [], outputCount: 2, deliveredOutputCount: 0,
        costDreamcoins: 9, createdAt: sameCreatedAt, updatedAt: sameCreatedAt,
      },
      {
        id: jobIds[1], userId: customerId, characterId, mode: "image", status: "failed",
        provider: "provider-alpha", model: "flux", sourceType: "generator", sourceId: `source-b-${suffix}`,
        errorCode: "provider_timeout", controls: {}, presetIds: [], outputCount: 1, deliveredOutputCount: 0,
        costDreamcoins: 5, createdAt: sameCreatedAt, updatedAt: sameCreatedAt,
      },
      {
        id: jobIds[2], userId: customerId, characterId, mode: "image", status: "failed",
        provider: "provider-beta", model: "flux", sourceType: "creative_run", sourceId: `source-c-${suffix}`,
        errorCode: "provider_timeout", controls: {}, presetIds: [], outputCount: 3, deliveredOutputCount: 1,
        costDreamcoins: 7, createdAt: sameCreatedAt, updatedAt: sameCreatedAt,
      },
      {
        id: jobIds[3], userId: customerId, mode: "video", status: "completed",
        provider: "provider-beta", model: "ltx", sourceType: "generator", sourceId: `source-d-${suffix}`,
        controls: {}, presetIds: [], outputCount: 1, deliveredOutputCount: 1,
        costDreamcoins: 12, createdAt: new Date("2026-07-10T12:00:00.000Z"), updatedAt: sameCreatedAt,
        completedAt: sameCreatedAt,
      },
      {
        id: jobIds[4], userId: customerId, mode: "image", status: "cancelled",
        sourceType: "generator", sourceId: `source-e-${suffix}`, controls: {}, presetIds: [],
        outputCount: 1, deliveredOutputCount: 0, costDreamcoins: 0,
        createdAt: new Date("2026-07-09T12:00:00.000Z"), updatedAt: sameCreatedAt,
      },
    ] });
    await prisma.generationAttempt.create({ data: {
      id: attemptId,
      requestId: jobIds[0],
      attemptNo: 1,
      provider: "provider-alpha",
      status: "failed",
      errorCode: "needle-timeout",
      retryability: "retryable",
      operatorGuidance: "Retry after provider recovery",
      startedAt: sameCreatedAt,
      finishedAt: sameCreatedAt,
    } });
    await prisma.generationAttemptEvent.create({ data: {
      id: attemptEventId,
      attemptId,
      sequence: 1,
      eventType: "generation.attempt.failed.v1",
      outcome: "failed",
      terminalScope: "terminal",
      occurredAt: sameCreatedAt,
      payload: { source: "jobs-v2-integration" },
      payloadHash: `jobs-v2-hash-${suffix}`,
    } });
    await prisma.generationArtifact.create({ data: {
      id: artifactId,
      attemptId,
      ordinal: 0,
      manifestChecksum: `jobs-v2-manifest-${suffix}`,
      validationState: "rejected",
    } });
    await prisma.generationDelivery.create({ data: {
      id: deliveryId,
      requestId: jobIds[2],
      artifactId: `jobs-artifact-${suffix}`,
      targetType: "media_asset",
      targetId: `jobs-target-${suffix}`,
      status: "delivered",
      deliveredAt: sameCreatedAt,
    } });
    await prisma.dreamcoinLedger.create({ data: {
      id: ledgerId,
      userId: customerId,
      delta: -9,
      balanceAfter: 91,
      reason: "generation_spend",
      sourceId: jobIds[0],
    } });
    await prisma.generationSettlementLink.create({ data: {
      id: settlementLinkId,
      requestId: jobIds[0],
      ledgerEntryId: ledgerId,
      kind: "capture",
    } });
  });

  afterAll(async () => {
    const commands = await prisma.controlPlaneCommand.findMany({ where: { targetId: { in: jobIds } }, select: { id: true } });
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: commands.map((command) => command.id) } } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: jobIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: jobIds } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { id: { in: commands.map((command) => command.id) } } });
    await prisma.generationSettlementLink.deleteMany({ where: { id: settlementLinkId } });
    await prisma.dreamcoinLedger.deleteMany({ where: { id: ledgerId } });
    await prisma.generationDelivery.deleteMany({ where: { id: deliveryId } });
    const attempts = await prisma.generationAttempt.findMany({ where: { requestId: { in: jobIds } }, select: { id: true } });
    await prisma.generationArtifact.deleteMany({ where: { attemptId: { in: attempts.map((attempt) => attempt.id) } } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: { in: attempts.map((attempt) => attempt.id) } } });
    await prisma.generationAttempt.deleteMany({ where: { id: { in: attempts.map((attempt) => attempt.id) } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, deniedId, customerId] } } });
    await prisma.$disconnect();
  });

  it("uses an opaque composite cursor without gaps or duplicates when timestamps tie", async () => {
    const firstResponse = await listJobsRoute(request(`mode=image&legacyStatus=failed&userId=${customerId}&sort=created_desc&limit=2`));
    expect(firstResponse.status).toBe(200);
    const first = generationJobListResponseSchema.parse((await firstResponse.json()).data);
    expect(first.items.map((item) => item.id)).toEqual([jobIds[2], jobIds[1]]);
    expect(first.items[0]).toMatchObject({
      requestOutcome: "partially_succeeded",
      legacyStatus: "failed",
      delivery: { expectedOutputCount: 3, deliveredCount: 1 },
      settlement: { view: "not_required" },
    });
    expect(first.pageInfo).toMatchObject({ hasNextPage: true });
    expect(first.summary).toMatchObject({ totalCount: 3, totalCostDreamcoins: 21, totalOutputCount: 6 });
    expect(first.facets.providers).toEqual([
      { value: "provider-alpha", count: 2 },
      { value: "provider-beta", count: 1 },
    ]);

    const secondResponse = await listJobsRoute(request(
      `mode=image&legacyStatus=failed&userId=${customerId}&sort=created_desc&limit=2&cursor=${encodeURIComponent(first.pageInfo.endCursor ?? "")}`,
    ));
    const second = generationJobListResponseSchema.parse((await secondResponse.json()).data);
    expect(second.items.map((item) => item.id)).toEqual([jobIds[0]]);
    expect(second.items[0]).toMatchObject({
      requestOutcome: "failed",
      latestAttempt: { id: attemptId, status: "failed", retryability: "retryable" },
      settlement: { view: "captured", capturedDreamcoins: 9, refundedDreamcoins: 0 },
    });
    expect(second.pageInfo).toEqual({ endCursor: null, hasNextPage: false });
    expect(second.summary.totalCount).toBe(3);
  });

  it("applies search and filters to both rows and complete-query aggregates", async () => {
    const response = await listJobsRoute(request(
      `search=needle&mode=all&userId=${customerId}&characterId=${characterId}&provider=provider-alpha&sourceType=generator&sort=cost_desc&limit=25`,
    ));
    const data = generationJobListResponseSchema.parse((await response.json()).data);
    expect(data.items.map((item) => item.id)).toEqual([jobIds[0]]);
    expect(data.summary).toEqual({
      totalCount: 1,
      totalCostDreamcoins: 9,
      totalOutputCount: 2,
      totalDeliveredOutputCount: 0,
    });

    const cancelled = generationJobListResponseSchema.parse((await (await listJobsRoute(
      request(`mode=all&legacyStatus=cancelled&userId=${customerId}&sort=created_desc&limit=25`),
    )).json()).data);
    expect(cancelled.items.map((item) => item.id)).toEqual([jobIds[4]]);
  });

  it("enforces effective permission and fails closed on unsupported query state", async () => {
    expect((await listJobsRoute(request("mode=all", deniedId, "user"))).status).toBe(403);
    expect((await listJobsRoute(request("mode=all&clientOnly=true"))).status).toBe(400);
    expect((await listJobsRoute(request("mode=all&status=failed"))).status).toBe(400);

    const first = generationJobListResponseSchema.parse((await (await listJobsRoute(
      request(`mode=image&userId=${customerId}&sort=created_desc&limit=1`),
    )).json()).data);
    const mismatch = await listJobsRoute(request(
      `mode=image&userId=${customerId}&sort=cost_desc&limit=1&cursor=${encodeURIComponent(first.pageInfo.endCursor ?? "")}`,
    ));
    expect(mismatch.status).toBe(400);

    const filterMismatch = await listJobsRoute(request(
      `mode=image&userId=${customerId}&provider=provider-alpha&sort=created_desc&limit=1&cursor=${encodeURIComponent(first.pageInfo.endCursor ?? "")}`,
    ));
    expect(filterMismatch.status).toBe(400);
  });

  it("exposes all authority axes in detail and retries through an idempotent v2 command", async () => {
    const detailResponse = await getJobRoute(
      request(""),
      { params: Promise.resolve({ id: jobIds[0] }) },
    );
    expect(detailResponse.status).toBe(200);
    const detail = generationJobDetailResponseSchema.parse((await detailResponse.json()).data);
    expect(detail.request).toMatchObject({
      id: jobIds[0],
      requestOutcome: "failed",
      latestAttempt: { id: attemptId, status: "failed", retryability: "retryable" },
      settlement: { view: "captured", capturedDreamcoins: 9 },
    });
    expect(detail.attempts).toHaveLength(1);
    expect(detail.events).toEqual([expect.objectContaining({ id: attemptEventId, outcome: "failed" })]);
    expect(detail.artifacts).toEqual([expect.objectContaining({ id: artifactId, validationState: "rejected" })]);
    expect(detail.settlementEntries).toEqual([expect.objectContaining({ ledgerEntryId: ledgerId, deltaDreamcoins: -9 })]);

    const idempotencyKey = `jobs-v2-retry-${suffix}`;
    const retryRequest = () => new Request(`http://localhost/api/v2/admin/jobs/${jobIds[0]}/commands/retry`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
      },
      body: JSON.stringify({
        entityVersion: detail.request.version,
        reason: "Provider recovered; retry approved from authority detail",
        confirmation: `${jobIds[0]}:retry`,
      }),
    });
    const firstResponse = await retryJobRoute(retryRequest(), { params: Promise.resolve({ id: jobIds[0] }) });
    expect(firstResponse.status).toBe(200);
    const first = retryGenerationRequestResultSchema.parse((await firstResponse.json()).data);
    const replayResponse = await retryJobRoute(retryRequest(), { params: Promise.resolve({ id: jobIds[0] }) });
    const replay = retryGenerationRequestResultSchema.parse((await replayResponse.json()).data);
    expect(replay).toEqual(first);
    expect(await prisma.generationAttempt.count({ where: { requestId: jobIds[0], attemptNo: 2 } })).toBe(1);
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: jobIds[0], eventType: "generation.retry.dispatch.v2" } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { targetId: jobIds[0], action: "generation.request.retry" } })).toBe(1);
  });
});
