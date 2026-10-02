import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as withdrawPlacement } from "@/app/api/v2/admin/creative/runs/[id]/placements/[placementId]/withdrawal/route";
import { POST as stagePlacement } from "@/app/api/v2/admin/creative/runs/[id]/placements/route";
import { GET as getRun } from "@/app/api/v2/admin/creative/runs/[id]/route";
import { GET as listRuns } from "@/app/api/v2/admin/creative/runs/route";
import { prisma } from "@/server/lib/db";
import { resolveCommunityCampaignPlacements } from "@/server/modules/ourdream/community-campaigns";
import { publishDistributionPlacement, verifyCreativePlacement } from "./placement";

describe("Live campaign withdrawal authority", () => {
  const suffix = randomUUID();
  const actor = { id: `live-withdrawal-admin-${suffix}`, role: "admin" } as const;
  const runIds: string[] = [];
  const assetIds: string[] = [];
  const jobIds: string[] = [];

  const request = (path: string, body?: unknown, key: string = randomUUID()) => new Request(
    `http://localhost${path}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": actor.id,
        "x-idream-role": actor.role,
        "idempotency-key": key,
        "x-request-id": randomUUID(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actor.id, email: `${actor.id}@example.test`, role: actor.role, status: "active" },
    });
  });

  afterAll(async () => {
    await prisma.mediaAssetPlacement.deleteMany({ where: { createdById: actor.id } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: actor.id } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: runIds } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId: actor.id } });
    await prisma.contentProductionItem.deleteMany({ where: { batchId: { in: runIds } } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: { in: runIds } } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: { in: jobIds } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.user.delete({ where: { id: actor.id } });
    await prisma.$disconnect();
  });

  async function liveCampaign(options: { targetId?: string; count?: number; verify?: boolean } = {}) {
    const id = randomUUID();
    const runId = `live-withdrawal-run-${id}`;
    const targetId = options.targetId ?? `live-withdrawal-target-${id}`;
    const jobId = `live-withdrawal-job-${id}`;
    const assetId = `live-withdrawal-asset-${id}`;
    const itemId = `live-withdrawal-item-${id}`;
    runIds.push(runId);
    jobIds.push(jobId);
    await prisma.generationJob.create({
      data: { id: jobId, userId: actor.id, mode: "image", controls: {}, presetIds: [], status: "completed", provider: "comfyui" },
    });
    await prisma.generationAttempt.create({
      data: { id: `${jobId}-attempt`, requestId: jobId, attemptNo: 1, provider: "comfyui", status: "succeeded", finishedAt: new Date() },
    });
    assetIds.push(assetId);
    await prisma.mediaAsset.create({
      data: { id: assetId, ownerId: actor.id, type: "image", url: `memory://${assetId}`, sourceJobId: jobId, safetyStatus: "passed", visibility: "private", metadata: {} },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: runId, title: "Live withdrawal regression", purpose: "campaign", targetType: "campaign", targetId,
        presetIds: [], count: options.count ?? 1, totalItems: options.count ?? 1, completedItems: 1,
        status: "reviewing", lifecycleState: "active", workflowStage: "placement", verificationState: "pending",
        createdById: actor.id,
        items: { create: [
          { id: itemId, itemIndex: 0, jobId, mediaAssetId: assetId, status: "generated", tags: [] },
          ...(options.count === 2 ? [{ id: `${itemId}-pending`, itemIndex: 1, status: "queued", tags: [] }] : []),
        ] },
      },
    });
    const staged = await publishDistributionPlacement({
      runId, itemId, assetId, actor, expectedVersion: 1, slot: "campaign", targetType: "campaign", targetId,
      eyebrow: "Featured", title: "Live campaign", reason: "Stage campaign regression", requestId: randomUUID(),
    });
    if (options.verify !== false) {
      await verifyCreativePlacement({ runId, placementId: staged.placementId, actor, expectedVersion: 2, reason: "Verify live campaign regression", requestId: randomUUID() });
    }
    return { runId, itemId, assetId, targetId, placementId: staged.placementId };
  }

  const withdraw = (fixture: Awaited<ReturnType<typeof liveCampaign>>, key: string, reason = "Remove the finished campaign from customers", entityVersion = 3) => withdrawPlacement(
    request(`/api/v2/admin/creative/runs/${fixture.runId}/placements/${fixture.placementId}/withdrawal`, { entityVersion, reason }, key),
    { params: Promise.resolve({ id: fixture.runId, placementId: fixture.placementId }) },
  );

  it("keeps one pending verification per Run while self-transitions remain available to live withdrawal", async () => {
    const fixture = await liveCampaign({ verify: false });
    const beforeRun = await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: fixture.runId } });
    const beforeItem = await prisma.contentProductionItem.findUniqueOrThrow({ where: { id: fixture.itemId } });
    const body = {
      entityVersion: 2, itemId: fixture.itemId, assetId: fixture.assetId,
      slot: "campaign", targetType: "campaign", targetId: `${fixture.targetId}-another`,
      eyebrow: "Another destination", title: "Another campaign decision",
      reason: "Stage another destination before resolving the pending one",
    };
    const blocked = await stagePlacement(
      request(`/api/v2/admin/creative/runs/${fixture.runId}/placements`, body, `stage-pending-blocked-${suffix}`),
      { params: Promise.resolve({ id: fixture.runId }) },
    );
    expect(blocked.status, JSON.stringify(await blocked.clone().json())).toBe(409);
    expect(await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: fixture.runId } })).toEqual(beforeRun);
    expect(await prisma.contentProductionItem.findUniqueOrThrow({ where: { id: fixture.itemId } })).toEqual(beforeItem);
    expect(await prisma.mediaAssetPlacement.count({ where: { targetId: body.targetId } })).toBe(0);
    expect(await prisma.adminAuditLog.count({ where: { action: "creative.placement.staged", targetId: fixture.placementId } })).toBe(1);
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: fixture.runId } })).toBe(1);
    expect(await prisma.controlPlaneCommand.count({ where: { targetId: fixture.runId, commandType: "creative.placement.publish" } })).toBe(0);

    expect((await withdraw(fixture, `stage-pending-withdraw-${suffix}`, "Cancel the pending destination before staging another", 2)).status).toBe(200);
    const fresh = await stagePlacement(
      request(`/api/v2/admin/creative/runs/${fixture.runId}/placements`, { ...body, entityVersion: 3 }, `stage-pending-fresh-${suffix}`),
      { params: Promise.resolve({ id: fixture.runId }) },
    );
    expect(fresh.status, JSON.stringify(await fresh.clone().json())).toBe(200);
    const staged = (await fresh.json()).data;
    expect((await verifyCreativePlacement({
      runId: fixture.runId, placementId: staged.placementId, actor, expectedVersion: 4,
      reason: "Verify the fresh destination only", requestId: randomUUID(),
    })).verificationState).toBe("passed");
    const runtime = await resolveCommunityCampaignPlacements(prisma, 100);
    expect(runtime.some(placement => placement.id === fixture.placementId)).toBe(false);
    expect(runtime.some(placement => placement.id === staged.placementId)).toBe(true);
  });

  it("withdraws a closed live campaign once, preserves replay, and allows a freshly verified deployment", async () => {
    const fixture = await liveCampaign();
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: fixture.runId } })).resolves.toMatchObject({ lifecycleState: "closed", verificationState: "passed", version: 3 });
    expect((await resolveCommunityCampaignPlacements(prisma, 100)).some((placement) => placement.id === fixture.placementId)).toBe(true);
    const keys = [`live-withdrawal-a-${suffix}`, `live-withdrawal-b-${suffix}`];
    const responses = await Promise.all(keys.map((key) => withdraw(fixture, key)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const index = responses.findIndex((response) => response.status === 200);
    const payload = await responses[index].json();
    expect(payload.data).toMatchObject({ placementId: fixture.placementId, verificationState: "overridden", runVersion: 4 });
    const replays = await Promise.all([withdraw(fixture, keys[index]), withdraw(fixture, keys[index])]);
    for (const response of replays) {
      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual(payload.data);
    }
    expect((await withdraw(fixture, keys[index], "Another payload cannot reuse this key")).status).toBe(409);
    expect((await resolveCommunityCampaignPlacements(prisma, 100)).some((placement) => placement.id === fixture.placementId)).toBe(false);
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: fixture.placementId } })).resolves.toMatchObject({ status: "archived", verificationState: "overridden", version: 3 });
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: fixture.runId } })).resolves.toMatchObject({ lifecycleState: "active", workflowStage: "placement", verificationState: "pending", status: "reviewing", version: 4 });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({ where: { id: fixture.itemId } })).resolves.toMatchObject({ status: "generated", version: 4 });
    await expect(prisma.adminAuditLog.count({ where: { targetId: fixture.placementId, action: "creative.placement.withdrawn" } })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: fixture.runId, eventType: "creative.placement.withdrawn.v2" } })).resolves.toBe(1);
    await expect(prisma.controlPlaneCommand.count({ where: { targetId: fixture.placementId, commandType: "creative.placement.withdraw" } })).resolves.toBe(1);

    const fresh = await publishDistributionPlacement({
      ...fixture, actor, expectedVersion: 4, slot: "campaign", targetType: "campaign", eyebrow: "Featured", title: "New campaign decision", reason: "Explicitly decide to relaunch", requestId: randomUUID(),
    });
    expect(fresh.rollbackPlacementId).toBeNull();
    await verifyCreativePlacement({ runId: fixture.runId, placementId: fresh.placementId, actor, expectedVersion: 5, reason: "Reverify the new deployment", requestId: randomUUID() });
    expect((await resolveCommunityCampaignPlacements(prisma, 100)).some((placement) => placement.id === fresh.placementId)).toBe(true);
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: fixture.runId } })).resolves.toMatchObject({ lifecycleState: "closed", verificationState: "passed", version: 6 });
  });

  it("keeps an independent campaign serving the same asset without contaminating withdrawn Run projections", async () => {
    const fixture = await liveCampaign({ count: 2 });
    const other = await prisma.mediaAssetPlacement.create({
      data: {
        mediaAssetId: fixture.assetId, slot: "campaign", targetType: "campaign", targetId: `independent-campaign-${suffix}`,
        status: "published", verificationState: "passed", publishedAt: new Date(), createdById: actor.id,
        metadata: { eyebrow: "Independent collection", title: "Shared campaign image" },
      },
    });
    const response = await withdraw(fixture, `live-withdrawal-shared-${suffix}`);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const runtime = await resolveCommunityCampaignPlacements(prisma, 100);
    expect(runtime.some((placement) => placement.id === fixture.placementId)).toBe(false);
    expect(runtime.some((placement) => placement.id === other.id)).toBe(true);
    const detailResponse = await getRun(request(`/api/v2/admin/creative/runs/${fixture.runId}`), { params: Promise.resolve({ id: fixture.runId }) });
    expect((await detailResponse.json()).data).toMatchObject({ deploymentState: "unplaced", verificationState: "pending", counts: { placed: 0 }, items: [{ id: fixture.itemId, status: "generated", placement: null }, { placement: null }] });
    const listResponse = await listRuns(request(`/api/v2/admin/creative/runs?search=${fixture.runId}`));
    expect((await listResponse.json()).data.items[0]).toMatchObject({ deploymentState: "unplaced", counts: { placed: 0 }, version: 4 });
  });

  it("never restores an archived superseded source when withdrawing its replacement", async () => {
    const previous = await liveCampaign();
    const current = await liveCampaign({ targetId: previous.targetId });
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: previous.placementId } })).resolves.toMatchObject({ status: "archived", verificationState: "passed" });
    expect((await withdraw(previous, `live-withdrawal-superseded-${suffix}`)).status).toBe(409);
    expect((await withdraw(current, `live-withdrawal-current-${suffix}`)).status).toBe(200);
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: previous.placementId } })).resolves.toMatchObject({ status: "archived", verificationState: "passed" });
    const runtime = await resolveCommunityCampaignPlacements(prisma, 100);
    expect(runtime.some((placement) => placement.targetId === current.targetId)).toBe(false);
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: previous.runId } })).resolves.toMatchObject({ version: 3 });
  });

  it("preserves another staged destination and verifies it after the live destination is withdrawn", async () => {
    const fixture = await liveCampaign({ count: 2 });
    const next = await publishDistributionPlacement({
      ...fixture, actor, expectedVersion: 3, targetId: `${fixture.targetId}-next`, slot: "campaign", targetType: "campaign",
      eyebrow: "Next collection", title: "Next staged campaign", reason: "Move this campaign to a new destination", requestId: randomUUID(),
    });
    const response = await withdraw(fixture, `live-withdrawal-preserve-staged-${suffix}`, "Remove the old destination only", 4);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: fixture.runId } })).resolves.toMatchObject({ lifecycleState: "active", workflowStage: "verification", verificationState: "verifying", version: 5 });
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: next.placementId } })).resolves.toMatchObject({ status: "scheduled", verificationState: "verifying" });
    const result = await verifyCreativePlacement({ runId: fixture.runId, placementId: next.placementId, actor, expectedVersion: 5, reason: "Verify the separately staged destination", requestId: randomUUID() });
    expect(result.verificationState).toBe("passed");
    const runtime = await resolveCommunityCampaignPlacements(prisma, 100);
    expect(runtime.some((placement) => placement.id === fixture.placementId)).toBe(false);
    expect(runtime.some((placement) => placement.id === next.placementId)).toBe(true);
  });
});
