import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { adminV2 } from "@/server/test/admin-v2-http";
import { api, AGE_GATE_COOKIE_HEADER } from "@/server/test/helpers";
import { dispatchV1 } from "@/server/modules/ourdream/service";
import { resolveCommunityCampaignPlacements } from "@/server/modules/ourdream/community-campaigns";
import { publishDistributionPlacement, verifyCreativePlacement } from "../creative/placement";

const actorId = "seed-admin-user";
const suffix = randomUUID();
const assetIds: string[] = [];
const placementIds: string[] = [];
const keys: string[] = [];
const runIds: string[] = [];
const jobIds: string[] = [];

async function managedCampaign(targetId: string, live: boolean) {
  const id = randomUUID();
  const runId = `upload-replacement-run-${id}`;
  const jobId = `upload-replacement-job-${id}`;
  const assetId = `upload-replacement-asset-${id}`;
  const itemId = `upload-replacement-item-${id}`;
  runIds.push(runId);
  jobIds.push(jobId);
  assetIds.push(assetId);
  await prisma.generationJob.create({ data: {
    id: jobId, userId: actorId, mode: "image", controls: {}, presetIds: [], status: "completed", provider: "comfyui",
  } });
  await prisma.generationAttempt.create({ data: {
    id: `${jobId}-attempt`, requestId: jobId, attemptNo: 1, provider: "comfyui", status: "succeeded", finishedAt: new Date(),
  } });
  await prisma.mediaAsset.create({ data: {
    id: assetId, ownerId: actorId, type: "image", url: `memory://${assetId}`, sourceJobId: jobId,
    safetyStatus: "passed", visibility: "private", metadata: {},
  } });
  await prisma.contentProductionBatch.create({ data: {
    id: runId, title: "Managed replacement regression", purpose: "campaign", targetType: "campaign", targetId,
    presetIds: [], count: 1, totalItems: 1, completedItems: 1, status: "reviewing", lifecycleState: "active",
    workflowStage: "placement", verificationState: "pending", createdById: actorId,
    items: { create: { id: itemId, itemIndex: 0, jobId, mediaAssetId: assetId, status: "generated", tags: [] } },
  } });
  const staged = await publishDistributionPlacement({
    runId, itemId, assetId, actor: { id: actorId, role: "admin" }, expectedVersion: 1,
    slot: "campaign", targetType: "campaign", targetId, eyebrow: "Managed campaign", title: "Creative artwork",
    reason: "Stage managed campaign regression", requestId: randomUUID(),
  });
  placementIds.push(staged.placementId);
  if (live) {
    const verified = await verifyCreativePlacement({
      runId, placementId: staged.placementId, actor: { id: actorId, role: "admin" }, expectedVersion: 2,
      reason: "Verify managed campaign regression", requestId: randomUUID(),
    });
    expect(verified.verificationState).toBe("passed");
  }
  return { runId, itemId, placementId: staged.placementId };
}

async function upload() {
  const pixels = Buffer.alloc(128 * 128 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 31 + (i >>> 7)) % 256;
  const image = await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
  const form = new FormData();
  form.set("image", new File([new Uint8Array(image)], `audit-${suffix}.png`, { type: "image/png" }));
  form.set("purpose", "campaign");
  const result = await adminV2("POST", "assets", { userId: actorId, role: "admin", form });
  expect(result.status, JSON.stringify(result.error)).toBe(200);
  const asset = result.data.asset;
  assetIds.push(asset.id);
  const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
  keys.push(row.storageKey!);
  return { assetId: asset.id, image };
}

async function draft(assetId: string, metadata: Record<string, unknown> = { eyebrow: "Audit artwork", title: "Controlled campaign", ctaLabel: "Explore", href: "/explore" }, targetId = `audit-${suffix}-${placementIds.length}`) {
  const result = await adminV2("POST", "content/placements", { userId: actorId, role: "admin", body: {
    mediaAssetId: assetId, slot: "campaign", targetType: "campaign", targetId,
    reason: "Verify uploaded operational campaign", metadata,
  } });
  expect(result.status, JSON.stringify(result.error)).toBe(200);
  placementIds.push(result.data.placement.id);
  return result.data.placement;
}

function publish(id: string, version: number, idempotencyKey = randomUUID(), userId = actorId, role = "admin") {
  return adminV2("POST", `content/placements/${id}/publish`, { userId, role, ifMatch: version, idempotencyKey, body: {
    reason: "Verify uploaded campaign publication", confirmation: id,
  } });
}

afterAll(async () => {
  await prisma.mediaAssetPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: runIds } } });
  await prisma.contentProductionItem.deleteMany({ where: { batchId: { in: runIds } } });
  await prisma.contentProductionBatch.deleteMany({ where: { id: { in: runIds } } });
  await prisma.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
  await prisma.generationAttempt.deleteMany({ where: { requestId: { in: jobIds } } });
  await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
  for (const key of keys) await providers.blob.delete({ key });
  await prisma.$disconnect();
});

describe("uploaded artwork to verified customer campaign", () => {
  it.each([false, true])("does not replace a Creative-managed destination (live=%s) or mutate its aggregate", async (live) => {
    const { assetId } = await upload();
    const targetId = `managed-destination-${suffix}-${live}`;
    const managed = await managedCampaign(targetId, live);
    const uploaded = await draft(assetId, { eyebrow: "Upload", title: "Independent artwork" }, targetId);
    const beforeRun = await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: managed.runId } });
    const beforeItem = await prisma.contentProductionItem.findUniqueOrThrow({ where: { id: managed.itemId } });
    const beforePlacement = await prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: managed.placementId } });
    const beforeOutbox = await prisma.mainOutboxEvent.count({ where: { aggregateId: managed.runId } });
    const blocked = await publish(uploaded.id, uploaded.version);
    expect(blocked.status, JSON.stringify(blocked.error)).toBe(409);
    if (live) expect(blocked.error?.details).toMatchObject({
      code: "creative_placement_withdrawal_required", placementIds: [managed.placementId],
      repairPath: `/admin/creative/runs/${managed.runId}`,
    });
    expect(await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: managed.runId } })).toEqual(beforeRun);
    expect(await prisma.contentProductionItem.findUniqueOrThrow({ where: { id: managed.itemId } })).toEqual(beforeItem);
    expect(await prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: managed.placementId } })).toEqual(beforePlacement);
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: managed.runId } })).toBe(beforeOutbox);
    expect(await prisma.adminAuditLog.count({ where: { targetId: uploaded.id, action: "content.placement.publish" } })).toBe(0);
    expect(await prisma.controlPlaneCommand.count({ where: { targetId: uploaded.id, commandType: "content.placement.publish" } })).toBe(0);
    expect(await prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: uploaded.id } })).toMatchObject({ status: "draft", version: uploaded.version });
    const runtime = (await resolveCommunityCampaignPlacements(prisma, 100)).filter(p => p.targetId === targetId);
    expect(runtime.map(p => p.id)).toEqual(live ? [managed.placementId] : []);

    const withdrawn = await adminV2("POST", `creative/runs/${managed.runId}/placements/${managed.placementId}/withdrawal`, {
      userId: actorId, role: "admin", body: { entityVersion: beforeRun.version, reason: "Withdraw through the Creative aggregate before upload replacement" },
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.error)).toBe(200);
    expect((await publish(uploaded.id, uploaded.version)).status).toBe(200);
    expect((await resolveCommunityCampaignPlacements(prisma, 100)).filter(p => p.targetId === targetId).map(p => p.id)).toEqual([uploaded.id]);
  });

  it.each(["verification", "withdrawal"] as const)("serializes upload publication against Creative %s for the same destination", async (operation) => {
    const { assetId } = await upload();
    const targetId = `managed-race-${suffix}-${operation}`;
    const managed = await managedCampaign(targetId, operation === "withdrawal");
    const uploaded = await draft(assetId, { eyebrow: "Upload", title: "Concurrent artwork" }, targetId);
    const [publication, creative] = await Promise.all([
      publish(uploaded.id, uploaded.version),
      adminV2("POST", `creative/runs/${managed.runId}/placements/${managed.placementId}/${operation}`, {
        userId: actorId, role: "admin", body: {
          entityVersion: operation === "withdrawal" ? 3 : 2,
          reason: "Serialize the same campaign destination through its owner",
        },
      }),
    ]);
    expect(creative.status, JSON.stringify(creative.error)).toBe(200);
    if (operation === "verification") {
      expect(publication.status, JSON.stringify(publication.error)).toBe(409);
      expect(await prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: managed.placementId } })).toMatchObject({ status: "published", verificationState: "passed" });
      expect(await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: managed.runId } })).toMatchObject({ version: 3, lifecycleState: "closed", verificationState: "passed" });
      expect(await prisma.contentProductionItem.findUniqueOrThrow({ where: { id: managed.itemId } })).toMatchObject({ status: "published" });
      expect(await prisma.adminAuditLog.count({ where: { targetId: uploaded.id, action: "content.placement.publish" } })).toBe(0);
      expect((await resolveCommunityCampaignPlacements(prisma, 100)).filter(p => p.targetId === targetId).map(p => p.id)).toEqual([managed.placementId]);
    } else {
      expect([200, 409]).toContain(publication.status);
      expect(await prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: managed.placementId } })).toMatchObject({ status: "archived", verificationState: "overridden" });
      expect(await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: managed.runId } })).toMatchObject({ version: 4, lifecycleState: "active", workflowStage: "placement", verificationState: "pending" });
      expect(await prisma.contentProductionItem.findUniqueOrThrow({ where: { id: managed.itemId } })).toMatchObject({ status: "generated" });
      if (publication.status === 409) expect((await publish(uploaded.id, uploaded.version)).status).toBe(200);
      expect(await prisma.adminAuditLog.count({ where: { targetId: uploaded.id, action: "content.placement.publish" } })).toBe(1);
      expect((await resolveCommunityCampaignPlacements(prisma, 100)).filter(p => p.targetId === targetId).map(p => p.id)).toEqual([uploaded.id]);
    }
  });

  it("publishes actual uploaded bytes without a generated Run and recovers the same command on replay", async () => {
    const { assetId, image } = await upload();
    const placement = await draft(assetId);
    expect((await resolveCommunityCampaignPlacements(prisma, 100)).some(p => p.id === placement.id)).toBe(false);
    const key = randomUUID();
    const result = await publish(placement.id, placement.version, key);
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    expect(result.data.placement).toMatchObject({ status: "published", verificationState: "passed", managedRunId: null });
    expect((await resolveCommunityCampaignPlacements(prisma, 100)).some(p => p.id === placement.id)).toBe(true);
    const anonymousId = `uploaded-placement-visitor-${suffix}`;
    await api("GET", "community/campaigns", { ageGate: true, anonymousId });
    const publicRead = await dispatchV1(new Request(`http://localhost/api/v1/media/${assetId}/content`, { headers: { cookie: AGE_GATE_COOKIE_HEADER, "x-idream-anonymous-id": anonymousId } }), ["media", assetId, "content"]);
    expect(publicRead.status).toBe(200);
    expect(Buffer.from(await publicRead.arrayBuffer())).toEqual(image);
    const replay = await publish(placement.id, placement.version, key);
    expect(replay.status, JSON.stringify(replay.error)).toBe(200);
    expect(replay.data.replayed).toBe(true);
    expect(await prisma.contentProductionItem.count({ where: { mediaAssetId: assetId } })).toBe(0);
    expect(await prisma.adminAuditLog.count({ where: { targetId: placement.id, action: "content.placement.publish" } })).toBe(1);
    const paused = await adminV2("PATCH", `content/placements/${placement.id}`, { userId: actorId, role: "admin", ifMatch: result.data.placement.version, body: {
      status: "paused", reason: "Finish controlled campaign verification", confirmation: placement.id,
    } });
    expect(paused.status).toBe(200);
    expect((await resolveCommunityCampaignPlacements(prisma, 100)).some(p => p.id === placement.id)).toBe(false);
    expect((await api("GET", `media/${assetId}/content`, { ageGate: true, anonymousId })).status).toBe(401);
    expect((await publish(placement.id, placement.version)).status).toBe(409);
  });

  it("rejects missing/corrupted bytes and unprivileged publication with no public side effect", async () => {
    const { assetId } = await upload();
    const placement = await draft(assetId);
    expect((await publish(placement.id, placement.version, randomUUID(), "seed-support-user", "support")).status).toBe(403);
    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
    await providers.blob.putPrivate({ key: row.storageKey!, body: new Uint8Array([1, 2, 3]), contentType: "image/png" });
    expect((await publish(placement.id, placement.version)).status).toBe(409);
    expect(await prisma.mediaAssetPlacement.findUnique({ where: { id: placement.id } })).toMatchObject({ status: "draft", verificationState: "pending", version: 1 });
    expect((await resolveCommunityCampaignPlacements(prisma, 100)).some(p => p.id === placement.id)).toBe(false);
  });

  it("refuses invalid campaign copy before admitting a publish command", async () => {
    const { assetId } = await upload();
    const placement = await draft(assetId, { eyebrow: "Audit", title: "Audit", ctaLabel: "Unsafe", href: "javascript:alert(1)" });
    expect((await publish(placement.id, placement.version)).status).toBe(400);
    expect((await resolveCommunityCampaignPlacements(prisma, 100)).some(p => p.id === placement.id)).toBe(false);
  });

  it("keeps generated-placement markers outside the upload authority even when empty", async () => {
    const { assetId } = await upload();
    const result = await adminV2("POST", "content/placements", { userId: actorId, role: "admin", body: {
      mediaAssetId: assetId, slot: "campaign", targetType: "campaign", targetId: `mixed-authority-${suffix}`,
      metadata: { eyebrow: "Audit", title: "Mixed authority", creativeRunId: "" }, reason: "Reject mixed placement authority",
    } });
    expect(result.status).toBe(400);
    expect(await prisma.mediaAssetPlacement.count({ where: { targetId: `mixed-authority-${suffix}` } })).toBe(0);
  });

  it("can correct draft copy without a status transition and preserves immutable upload provenance", async () => {
    const { assetId } = await upload();
    const placement = await draft(assetId);
    const changed = await adminV2("PATCH", `content/placements/${placement.id}`, { userId: actorId, role: "admin", ifMatch: placement.version, body: {
      metadata: { eyebrow: "Updated collection", title: "Corrected artwork", ctaLabel: null, href: null }, reason: "Correct campaign copy before publication", confirmation: placement.id,
    } });
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    expect(changed.data.placement).toMatchObject({ status: "draft", version: 2, canPublish: true });
    expect(changed.data.placement.metadata).not.toHaveProperty("ctaLabel");
    expect(changed.data.placement.metadata).not.toHaveProperty("href");
    const published = await publish(placement.id, changed.data.placement.version);
    expect(published.status).toBe(200);
    const forbidden = await adminV2("PATCH", `content/placements/${placement.id}`, { userId: actorId, role: "admin", ifMatch: published.data.placement.version, body: {
      metadata: { title: "Unverified change" }, reason: "Attempt to modify live copy", confirmation: placement.id,
    } });
    expect(forbidden.status).toBe(409);
  });

  it("replaces only the same campaign destination and does not restore it after a pause", async () => {
    const { assetId } = await upload();
    const target = `replacement-${suffix}`;
    const first = await draft(assetId, { eyebrow: "Before", title: "Original campaign" }, target);
    const second = await draft(assetId, { eyebrow: "After", title: "Replacement campaign" }, target);
    const one = await publish(first.id, first.version);
    expect(one.status).toBe(200);
    const two = await publish(second.id, second.version);
    expect(two.status).toBe(200);
    const runtime = await resolveCommunityCampaignPlacements(prisma, 100);
    expect(runtime.filter(p => p.targetId === target).map(p => p.id)).toEqual([second.id]);
    expect(await prisma.mediaAssetPlacement.findUnique({ where: { id: first.id } })).toMatchObject({ status: "paused", version: 3 });
    const paused = await adminV2("PATCH", `content/placements/${second.id}`, { userId: actorId, role: "admin", ifMatch: two.data.placement.version, body: {
      status: "paused", reason: "Stop this campaign destination", confirmation: second.id,
    } });
    expect(paused.status).toBe(200);
    expect((await resolveCommunityCampaignPlacements(prisma, 100)).filter(p => p.targetId === target)).toHaveLength(0);
    expect((await publish(first.id, 3)).status).toBe(200);
    const archived = await adminV2("PATCH", `content/placements/${first.id}`, { userId: actorId, role: "admin", ifMatch: 4, body: {
      status: "archived", reason: "Retire this campaign fixture", confirmation: first.id,
    } });
    expect(archived.status).toBe(200);
    expect((await publish(first.id, archived.data.placement.version)).status).toBe(409);
  });
});
