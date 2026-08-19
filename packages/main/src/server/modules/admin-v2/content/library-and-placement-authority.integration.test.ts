import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  publishDistributionPlacement,
  verifyCreativePlacement,
} from "@/server/modules/admin-v2/creative/placement";
import { adminV2 as adminV2Api } from "@/server/test/admin-v2-http";
import { createUser } from "@/server/test/helpers";
import { GET as listAssetsRoute } from "@/app/api/v2/admin/assets/route";
import {
  GET as getAssetRoute,
  PATCH as patchAssetRoute,
} from "@/app/api/v2/admin/assets/[id]/route";
import { POST as bulkPatchAssetsRoute } from "@/app/api/v2/admin/assets/bulk/route";
import { POST as createPlacementRoute } from "@/app/api/v2/admin/content/placements/route";
import { PATCH as patchPlacementRoute } from "@/app/api/v2/admin/content/placements/[id]/route";

/**
 * SPEC: drive the real Route Handlers, but keep the throw-on-failure shape the assertions
 * in this file are written against.
 * INTENT: a Route Handler answers a 4xx envelope where the v1 handler threw an AppError. The
 * behaviour under test is the authority decision, not which of the two shapes carries it, so
 * the seam is re-thrown here rather than restated at ~40 assertion sites.
 */
async function viaRoute(pending: Promise<Response> | Response): Promise<Response> {
  const response = await pending;
  if (response.ok) return response;
  const payload = await response.clone().json() as {
    error?: { code?: string; message?: string; details?: unknown };
  };
  throw Object.assign(new Error(payload.error?.message ?? "Admin v2 request failed"), {
    status: response.status,
    code: payload.error?.code,
    details: payload.error?.details,
  });
}

const listContentAssets = (request: Request) => viaRoute(listAssetsRoute(request));
const getContentAsset = (request: Request, id: string) =>
  viaRoute(getAssetRoute(request, { params: Promise.resolve({ id }) }));
const patchContentAsset = (request: Request, id: string) =>
  viaRoute(patchAssetRoute(request, { params: Promise.resolve({ id }) }));
const bulkPatchContentAssets = (request: Request) => viaRoute(bulkPatchAssetsRoute(request));
const createPlacement = (request: Request) => viaRoute(createPlacementRoute(request));
const patchPlacement = (request: Request, id: string) =>
  viaRoute(patchPlacementRoute(request, { params: Promise.resolve({ id }) }));

describe("Image Library and legacy Placement authority", () => {
  const suffix = randomUUID();
  const actorId = `content-authority-actor-${suffix}`;
  const characterId = `content-authority-character-${suffix}`;
  const projectId = `content-authority-project-${suffix}`;
  const contentVersionId = `content-authority-content-${suffix}`;
  const releaseId = `content-authority-release-${suffix}`;
  const scheduledReleaseId = `content-authority-scheduled-release-${suffix}`;
  const releaseAssetId = `content-authority-release-asset-${suffix}`;
  const scheduledReleaseAssetId = `content-authority-scheduled-release-asset-${suffix}`;
  const campaignAssetId = `content-authority-campaign-asset-${suffix}`;
  const standaloneAssetId = `content-authority-standalone-asset-${suffix}`;
  const freeAssetId = `content-authority-free-asset-${suffix}`;
  const bulkFreeAssetId = `content-authority-bulk-free-asset-${suffix}`;
  const primaryImageAssetId = `content-authority-primary-image-asset-${suffix}`;
  const primaryImageCharacterId = `content-authority-primary-image-character-${suffix}`;
  const auditRunId = `content-authority-audit-run-${suffix}`;
  const auditItemId = `content-authority-audit-item-${suffix}`;
  const approvedAssetId = `content-authority-approved-asset-${suffix}`;
  const placementId = `content-authority-v2-placement-${suffix}`;
  const approvedRunId = `content-authority-approved-run-${suffix}`;
  const approvedItemId = `content-authority-approved-item-${suffix}`;
  const approvedDecisionId = `content-authority-approved-decision-${suffix}`;
  const approvedJobId = `content-authority-approved-job-${suffix}`;
  const approvedAttemptId = `content-authority-approved-attempt-${suffix}`;
  const concurrentAssetId = `content-authority-concurrent-asset-${suffix}`;
  const concurrentJobId = `content-authority-concurrent-job-${suffix}`;
  const concurrentAttemptId = `content-authority-concurrent-attempt-${suffix}`;
  const concurrentRunId = `content-authority-concurrent-run-${suffix}`;
  const concurrentItemId = `content-authority-concurrent-item-${suffix}`;
  const concurrentDecisionId = `content-authority-concurrent-decision-${suffix}`;
  const concurrentPlacementId = `content-authority-concurrent-placement-${suffix}`;
  const auditFailureRequestPrefix = `content-authority-audit-failure-${suffix}`;

  function request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    requestId: string = randomUUID(),
    extraHeaders: Record<string, string> = {},
  ) {
    const write = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
    const placementPatch = method === "PATCH" &&
      path.startsWith("api/v2/admin/content/placements/");
    return new Request(`http://localhost/${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": requestId,
        ...(write ? { "idempotency-key": requestId } : {}),
        ...(placementPatch ? { "if-match": "\"1\"" } : {}),
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  beforeAll(async () => {
    await createUser({
      id: actorId,
      role: "admin",
      dataClass: "internal",
    });
    await prisma.generationJob.create({
      data: {
        id: approvedJobId,
        userId: actorId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        provider: "comfyui",
      },
    });
    await prisma.generationAttempt.create({
      data: {
        id: approvedAttemptId,
        requestId: approvedJobId,
        attemptNo: 1,
        provider: "comfyui",
        status: "succeeded",
        finishedAt: new Date(),
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: actorId,
        name: "Library authority character",
        age: 24,
        description: "Character Release dependency fixture.",
        source: "official",
        status: "approved",
        visibility: "public",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.mediaAsset.createMany({
      data: [
        releaseAssetId,
        scheduledReleaseAssetId,
        campaignAssetId,
        standaloneAssetId,
        freeAssetId,
        bulkFreeAssetId,
        primaryImageAssetId,
        approvedAssetId,
      ].map((id) => ({
        id,
        ownerId: actorId,
        type: "image",
        url: `memory://${id}`,
        safetyStatus: "passed",
        metadata: id === standaloneAssetId
          ? {
              platformAsset: {
                status: "approved",
                purpose: "character_chat",
                tags: ["standalone-authority"],
                description: "Platform-managed standalone Image Library asset.",
              },
            }
          : {},
        sourceJobId: id === approvedAssetId ? approvedJobId : null,
      })),
    });
    await prisma.character.create({
      data: {
        id: primaryImageCharacterId,
        creatorId: actorId,
        imageAssetId: primaryImageAssetId,
        name: "Direct primary image authority",
        age: 24,
        description: "No Project, Profile, or Release; the Character pointer is still authority.",
        source: "official",
        status: "approved",
        visibility: "private",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.generationJob.create({
      data: {
        id: concurrentJobId,
        userId: actorId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        provider: "comfyui",
      },
    });
    await prisma.generationAttempt.create({
      data: {
        id: concurrentAttemptId,
        requestId: concurrentJobId,
        attemptNo: 1,
        provider: "comfyui",
        status: "succeeded",
        finishedAt: new Date(),
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: concurrentAssetId,
        ownerId: actorId,
        sourceJobId: concurrentJobId,
        type: "image",
        url: `memory://${concurrentAssetId}`,
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "live_management",
        audience: {},
        successCriteria: [],
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentVersionId,
        characterId,
        version: 1,
        contentHash: `content-authority-hash-${suffix}`,
        personaSnapshot: { name: "Library authority character" },
        openingSnapshot: { firstMessage: "Hello" },
        appearanceSnapshot: {},
        sourceType: "content_ops_authority_test",
        createdById: actorId,
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `content-authority-revision-${suffix}`,
        characterContentVersionId: contentVersionId,
        generationProvenance: {},
        releasePlacementManifest: {
          schemaVersion: 2,
          placements: [
            {
              slotKey: "character_avatar",
              assetId: releaseAssetId,
              slotVersion: 1,
              runId: `release-avatar-run-${suffix}`,
              itemId: `release-avatar-item-${suffix}`,
              reviewDecisionId: `release-avatar-decision-${suffix}`,
              generationJobId: `release-avatar-job-${suffix}`,
            },
            {
              slotKey: "character_hero",
              assetId: releaseAssetId,
              slotVersion: 1,
              runId: `release-hero-run-${suffix}`,
              itemId: `release-hero-item-${suffix}`,
              reviewDecisionId: `release-hero-decision-${suffix}`,
              generationJobId: `release-hero-job-${suffix}`,
            },
            {
              slotKey: "character_chat",
              assetId: releaseAssetId,
              slotVersion: 1,
              runId: `release-chat-run-${suffix}`,
              itemId: `release-chat-item-${suffix}`,
              reviewDecisionId: `release-chat-decision-${suffix}`,
              generationJobId: `release-chat-job-${suffix}`,
            },
          ],
        },
        snapshotHash: `content-authority-snapshot-${suffix}`,
        readiness: "ready",
        status: "published",
        publishedAt: new Date(),
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: scheduledReleaseId,
        projectId,
        revisionId: `content-authority-scheduled-revision-${suffix}`,
        characterContentVersionId: contentVersionId,
        generationProvenance: {},
        releasePlacementManifest: {
          schemaVersion: 2,
          placements: [
            {
              slotKey: "character_avatar",
              assetId: scheduledReleaseAssetId,
              slotVersion: 1,
              runId: `scheduled-avatar-run-${suffix}`,
              itemId: `scheduled-avatar-item-${suffix}`,
              reviewDecisionId: `scheduled-avatar-decision-${suffix}`,
              generationJobId: `scheduled-avatar-job-${suffix}`,
            },
            {
              slotKey: "character_hero",
              assetId: scheduledReleaseAssetId,
              slotVersion: 1,
              runId: `scheduled-hero-run-${suffix}`,
              itemId: `scheduled-hero-item-${suffix}`,
              reviewDecisionId: `scheduled-hero-decision-${suffix}`,
              generationJobId: `scheduled-hero-job-${suffix}`,
            },
            {
              slotKey: "character_chat",
              assetId: scheduledReleaseAssetId,
              slotVersion: 1,
              runId: `scheduled-chat-run-${suffix}`,
              itemId: `scheduled-chat-item-${suffix}`,
              reviewDecisionId: `scheduled-chat-decision-${suffix}`,
              generationJobId: `scheduled-chat-job-${suffix}`,
            },
          ],
        },
        snapshotHash: `content-authority-scheduled-snapshot-${suffix}`,
        readiness: "ready",
        status: "scheduled",
      },
    });
    await prisma.characterServing.create({
      data: {
        id: `content-authority-serving-${suffix}`,
        characterId,
        currentReleaseId: releaseId,
        scheduledReleaseId,
        scheduledAt: new Date(Date.now() + 60_000),
        state: "live",
      },
    });
    await prisma.mediaAssetPlacement.create({
      data: {
        id: placementId,
        mediaAssetId: campaignAssetId,
        slot: "campaign",
        targetType: "campaign",
        targetId: `content-authority-campaign-${suffix}`,
        status: "published",
        verificationState: "passed",
        verifiedAt: new Date(),
        publishedAt: new Date(),
        createdById: actorId,
        metadata: {
          creativeRunId: `content-authority-run-${suffix}`,
          creativeRunItemId: `content-authority-item-${suffix}`,
          customerMediaAuthority: {
            sourceJobId: null,
            jobProvider: null,
            latestAttemptProvider: null,
          },
        },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: approvedRunId,
        title: "Approved placement authority fixture",
        purpose: "campaign",
        targetType: "campaign",
        targetId: `approved-campaign-${suffix}`,
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "placement",
        verificationState: "pending",
        createdById: actorId,
        items: {
          create: {
            id: approvedItemId,
            itemIndex: 0,
            mediaAssetId: approvedAssetId,
            status: "approved",
            tags: [],
          },
        },
      },
    });
    await prisma.creativeReviewDecision.create({
      data: {
        id: approvedDecisionId,
        runItemId: approvedItemId,
        artifactId: approvedAssetId,
        decision: "approved",
        identityConsistency: "unscored",
        score: 90,
        reason: "Immutable approval fixture",
        reviewerId: actorId,
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: auditRunId,
        title: "Library atomic Audit fixture",
        purpose: "feed",
        targetType: "none",
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "review",
        verificationState: "pending",
        createdById: actorId,
        items: {
          create: {
            id: auditItemId,
            itemIndex: 0,
            mediaAssetId: freeAssetId,
            status: "generated",
            tags: [],
          },
        },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: concurrentRunId,
        title: "Archive versus verification serialization fixture",
        purpose: "campaign",
        targetType: "campaign",
        targetId: `concurrent-campaign-${suffix}`,
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "verification",
        verificationState: "verifying",
        version: 1,
        createdById: actorId,
        items: {
          create: {
            id: concurrentItemId,
            jobId: concurrentJobId,
            itemIndex: 0,
            mediaAssetId: concurrentAssetId,
            status: "approved",
            tags: [],
          },
        },
      },
    });
    await prisma.creativeReviewDecision.create({
      data: {
        id: concurrentDecisionId,
        runItemId: concurrentItemId,
        artifactId: concurrentAssetId,
        decision: "approved",
        identityConsistency: "unscored",
        score: 92,
        reason: "Approved before placement verification",
        reviewerId: actorId,
      },
    });
    await prisma.mediaAssetPlacement.create({
      data: {
        id: concurrentPlacementId,
        mediaAssetId: concurrentAssetId,
        slot: "campaign",
        targetType: "campaign",
        targetId: `concurrent-campaign-${suffix}`,
        status: "scheduled",
        verificationState: "verifying",
        createdById: actorId,
        metadata: {
          eyebrow: "Featured",
          title: "Concurrent authority campaign",
          creativeRunId: concurrentRunId,
          creativeRunItemId: concurrentItemId,
          customerMediaAuthority: {
            sourceJobId: concurrentJobId,
            jobProvider: "comfyui",
            latestAttemptProvider: "comfyui",
          },
        },
      },
    });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION zt_content_ops_authority_fail_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."requestId" LIKE '${auditFailureRequestPrefix}%' THEN
          RAISE EXCEPTION 'injected content asset audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS zt_content_ops_authority_fail_audit ON "admin_audit_logs";
      CREATE TRIGGER zt_content_ops_authority_fail_audit
      BEFORE INSERT ON "admin_audit_logs"
      FOR EACH ROW EXECUTE FUNCTION zt_content_ops_authority_fail_audit();
    `);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS zt_content_ops_authority_fail_audit ON "admin_audit_logs"`,
    );
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS zt_content_ops_authority_fail_audit()`,
    );
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.controlPlaneCommand.deleteMany({
      where: {
        actorId,
        commandType: { in: ["content.placement.create", "content.placement.patch"] },
      },
    });
    await prisma.mediaAssetPlacement.deleteMany({
      where: {
        OR: [
          { id: placementId },
          { id: concurrentPlacementId },
          { mediaAssetId: approvedAssetId },
          { mediaAssetId: concurrentAssetId },
        ],
      },
    });
    await prisma.creativeReviewDecision.deleteMany({
      where: { runItemId: { in: [approvedItemId, concurrentItemId] } },
    });
    await prisma.contentProductionItem.deleteMany({
      where: { id: { in: [approvedItemId, concurrentItemId, auditItemId] } },
    });
    await prisma.contentProductionBatch.deleteMany({
      where: { id: { in: [approvedRunId, concurrentRunId, auditRunId] } },
    });
    await prisma.characterServing.deleteMany({ where: { characterId } });
    await prisma.characterRelease.deleteMany({
      where: { id: { in: [releaseId, scheduledReleaseId] } },
    });
    await prisma.characterContentVersion.deleteMany({
      where: { id: contentVersionId },
    });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({
      where: { id: { in: [characterId, primaryImageCharacterId] } },
    });
    await prisma.mediaAsset.deleteMany({
      where: {
        id: {
          in: [
            releaseAssetId,
            scheduledReleaseAssetId,
            campaignAssetId,
            standaloneAssetId,
            freeAssetId,
            bulkFreeAssetId,
            primaryImageAssetId,
            approvedAssetId,
            concurrentAssetId,
          ],
        },
      },
    });
    await prisma.generationAttempt.deleteMany({
      where: { requestId: { in: [approvedJobId, concurrentJobId] } },
    });
    await prisma.generationJob.deleteMany({
      where: { id: { in: [approvedJobId, concurrentJobId] } },
    });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("lists platform-managed standalone assets without inventing Creative Run lineage", async () => {
    const response = await listContentAssets(
      request(
        "GET",
        `api/v2/admin/assets?status=approved&purpose=character_chat&search=${standaloneAssetId}`,
      ),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        items: [
          {
            id: standaloneAssetId,
            platformStatus: "approved",
            purpose: "character_chat",
            tags: ["standalone-authority"],
            description: "Platform-managed standalone Image Library asset.",
            sourceBatch: null,
          },
        ],
      },
    });

    const wrongStatus = await listContentAssets(
      request(
        "GET",
        `api/v2/admin/assets?status=generated&search=${standaloneAssetId}`,
      ),
    );
    await expect(wrongStatus.json()).resolves.toMatchObject({
      data: { items: [] },
    });

    const ungovernedOperationalMedia = await listContentAssets(
      request(
        "GET",
        `api/v2/admin/assets?search=${bulkFreeAssetId}`,
      ),
    );
    await expect(ungovernedOperationalMedia.json()).resolves.toMatchObject({
      data: { items: [] },
    });
  });

  it("projects live Character Release dependencies and blocks Library review or archive", async () => {
    const response = await getContentAsset(
      request("GET", `api/v2/admin/assets/${releaseAssetId}`),
      releaseAssetId,
    );
    const payload = await response.json();
    expect(payload.data.asset.authorityDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "character_release",
          characterId,
          releaseId,
          releaseState: "current",
          repairPath: `/admin/characters/${characterId}?tab=release`,
        }),
      ]),
    );

    await expect(patchContentAsset(
      request("PATCH", `api/v2/admin/assets/${releaseAssetId}`, {
        status: "archived",
        reason: "attempt to archive a live Release asset",
        confirmation: releaseAssetId,
      }),
      releaseAssetId,
    )).rejects.toMatchObject({
      status: 409,
      details: {
        code: "asset_authority_dependency_active",
        assetId: releaseAssetId,
      },
    });
    await expect(patchContentAsset(
      request("PATCH", `api/v2/admin/assets/${releaseAssetId}`, {
        status: "rejected",
        reason: "attempt to replace Creative review authority",
        confirmation: releaseAssetId,
      }),
      releaseAssetId,
    )).rejects.toMatchObject({
      status: 409,
      details: {
        code: "creative_run_review_required",
      },
    });
    await expect(prisma.characterServing.findUniqueOrThrow({
      where: { characterId },
    })).resolves.toMatchObject({
      state: "live",
      currentReleaseId: releaseId,
    });
    await expect(prisma.mediaAsset.findUniqueOrThrow({
      where: { id: releaseAssetId },
    })).resolves.toMatchObject({ metadata: {} });
  });

  it("blocks Library archive for a direct Character primary image without other authority records", async () => {
    const response = await getContentAsset(
      request("GET", `api/v2/admin/assets/${primaryImageAssetId}`),
      primaryImageAssetId,
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        asset: {
          authorityDependencies: expect.arrayContaining([
            expect.objectContaining({
              kind: "character_primary_image",
              characterId: primaryImageCharacterId,
              repairPath: `/admin/characters/${primaryImageCharacterId}?tab=assets`,
            }),
          ]),
        },
      },
    });

    await expect(patchContentAsset(
      request("PATCH", `api/v2/admin/assets/${primaryImageAssetId}`, {
        status: "archived",
        reason: "Attempt to archive a Character primary image",
        confirmation: primaryImageAssetId,
      }),
      primaryImageAssetId,
    )).rejects.toMatchObject({
      status: 409,
      details: {
        code: "asset_authority_dependency_active",
        assetId: primaryImageAssetId,
      },
    });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: primaryImageAssetId } }),
    ).resolves.toMatchObject({ deletedAt: null });
  });

  it("keeps Library metadata separate from Creative purpose, review evidence, and tags", async () => {
    await prisma.contentProductionItem.update({
      where: { id: auditItemId },
      data: {
        reviewNote: "Immutable Creative Run review evidence",
        tags: ["creative-review-tag"],
      },
    });
    const rejected = await adminV2Api(
      "PATCH",
      `api/v2/admin/assets/${freeAssetId}`,
      {
        userId: actorId,
        role: "admin",
        body: {
          purpose: "campaign",
          reviewNote: "Library-authored replacement evidence",
          tags: ["searchable"],
          reason: "attempt to bypass immutable Creative review authority",
          confirmation: freeAssetId,
        },
      },
    );
    expect(rejected).toMatchObject({
      status: 400,
      error: { code: "bad_request" },
    });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({
      where: { id: auditItemId },
    })).resolves.toMatchObject({
      reviewNote: "Immutable Creative Run review evidence",
      tags: ["creative-review-tag"],
    });
    await expect(prisma.mediaAsset.findUniqueOrThrow({
      where: { id: freeAssetId },
    })).resolves.toMatchObject({ metadata: {} });

    const descriptionOnly = await adminV2Api(
      "PATCH",
      `api/v2/admin/assets/${freeAssetId}`,
      {
        userId: actorId,
        role: "admin",
        body: {
          description: "Library-authored retrieval description",
          reason: "curate retrieval metadata without taking over review tags",
          confirmation: freeAssetId,
        },
      },
    );
    expect(descriptionOnly).toMatchObject({ status: 200 });
    expect(descriptionOnly.data.asset).toMatchObject({
      description: "Library-authored retrieval description",
      tags: ["creative-review-tag"],
    });

    const libraryTags = await adminV2Api(
      "PATCH",
      `api/v2/admin/assets/${freeAssetId}`,
      {
        userId: actorId,
        role: "admin",
        body: {
          tags: ["library-search-tag"],
          reason: "author explicit Image Library search metadata",
          confirmation: freeAssetId,
        },
      },
    );
    expect(libraryTags).toMatchObject({ status: 200 });
    expect(libraryTags.data.asset).toMatchObject({
      tags: ["library-search-tag"],
    });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({
      where: { id: auditItemId },
    })).resolves.toMatchObject({
      reviewNote: "Immutable Creative Run review evidence",
      tags: ["creative-review-tag"],
    });

    await prisma.contentProductionItem.update({
      where: { id: auditItemId },
      data: { reviewNote: null, tags: [] },
    });
    await prisma.mediaAsset.update({
      where: { id: freeAssetId },
      data: { metadata: {} },
    });
  });

  it("projects scheduled Character Release dependencies and blocks single or bulk archive", async () => {
    const scheduledBulkAssetIds = [
      scheduledReleaseAssetId,
      bulkFreeAssetId,
    ].sort();
    const response = await getContentAsset(
      request("GET", `api/v2/admin/assets/${scheduledReleaseAssetId}`),
      scheduledReleaseAssetId,
    );
    const payload = await response.json();
    expect(payload.data.asset.authorityDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "character_release",
          characterId,
          releaseId: scheduledReleaseId,
          releaseState: "scheduled",
          repairPath: `/admin/characters/${characterId}?tab=release`,
        }),
      ]),
    );
    await expect(patchContentAsset(
      request("PATCH", `api/v2/admin/assets/${scheduledReleaseAssetId}`, {
        status: "archived",
        reason: "attempt to archive a scheduled Release asset",
        confirmation: scheduledReleaseAssetId,
      }),
      scheduledReleaseAssetId,
    )).rejects.toMatchObject({
      status: 409,
      details: {
        code: "asset_authority_dependency_active",
        assetId: scheduledReleaseAssetId,
      },
    });
    await expect(bulkPatchContentAssets(
      request("POST", "api/v2/admin/assets/bulk", {
        assetIds: scheduledBulkAssetIds,
        status: "archived",
        reason: "scheduled Release must make the whole selection fail",
        confirmation: scheduledBulkAssetIds.join(","),
      }),
    )).rejects.toMatchObject({
      status: 409,
      details: {
        code: "asset_authority_dependency_active",
        assetId: scheduledReleaseAssetId,
      },
    });
    await expect(prisma.mediaAsset.findUniqueOrThrow({
      where: { id: bulkFreeAssetId },
    })).resolves.toMatchObject({ metadata: {} });
  });

  it("protects paused current Releases but does not keep retired current pointers active", async () => {
    await prisma.characterServing.update({
      where: { characterId },
      data: { state: "paused" },
    });
    const pausedResponse = await getContentAsset(
      request("GET", `api/v2/admin/assets/${releaseAssetId}`),
      releaseAssetId,
    );
    await expect(pausedResponse.json()).resolves.toMatchObject({
      data: {
        asset: {
          authorityDependencies: expect.arrayContaining([
            expect.objectContaining({
              kind: "character_release",
              releaseId,
              releaseState: "current",
            }),
          ]),
        },
      },
    });
    await expect(patchContentAsset(
      request("PATCH", `api/v2/admin/assets/${releaseAssetId}`, {
        status: "archived",
        reason: "paused serving can still resume this Release",
        confirmation: releaseAssetId,
      }),
      releaseAssetId,
    )).rejects.toMatchObject({
      status: 409,
      details: { code: "asset_authority_dependency_active" },
    });

    await prisma.characterServing.update({
      where: { characterId },
      data: { state: "retired" },
    });
    const retiredResponse = await getContentAsset(
      request("GET", `api/v2/admin/assets/${releaseAssetId}`),
      releaseAssetId,
    );
    const retiredPayload = await retiredResponse.json();
    expect(retiredPayload.data.asset.authorityDependencies).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "character_release",
          releaseId,
          releaseState: "current",
        }),
      ]),
    );
    await expect(patchContentAsset(
      request("PATCH", `api/v2/admin/assets/${releaseAssetId}`, {
        status: "archived",
        reason: "retired current pointer is no longer active serving authority",
        confirmation: releaseAssetId,
      }),
      releaseAssetId,
    )).resolves.toBeInstanceOf(Response);
    await prisma.mediaAsset.update({
      where: { id: releaseAssetId },
      data: { metadata: {} },
    });
    await prisma.characterServing.update({
      where: { characterId },
      data: { state: "live" },
    });
  });

  it("protects Serving Release assets independently from a retired Project", async () => {
    await prisma.characterProject.update({
      where: { id: projectId },
      data: { phase: "retired", activeKey: null },
    });
    try {
      const response = await getContentAsset(
        request("GET", `api/v2/admin/assets/${releaseAssetId}`),
        releaseAssetId,
      );
      await expect(response.json()).resolves.toMatchObject({
        data: {
          asset: {
            authorityDependencies: expect.arrayContaining([
              expect.objectContaining({
                kind: "character_release",
                releaseId,
                releaseState: "current",
              }),
            ]),
          },
        },
      });
    } finally {
      await prisma.characterProject.update({
        where: { id: projectId },
        data: { phase: "live_management" },
      });
    }
  });

  it("protects legacy raw-array Release manifests through the canonical parser", async () => {
    const original = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: releaseId },
      select: { releasePlacementManifest: true },
    });
    await prisma.characterRelease.update({
      where: { id: releaseId },
      data: {
        releasePlacementManifest: [
          {
            placementId: "legacy_character_avatar",
            assetId: releaseAssetId,
          },
        ],
      },
    });
    try {
      const response = await getContentAsset(
        request("GET", `api/v2/admin/assets/${releaseAssetId}`),
        releaseAssetId,
      );
      await expect(response.json()).resolves.toMatchObject({
        data: {
          asset: {
            authorityDependencies: expect.arrayContaining([
              expect.objectContaining({
                kind: "character_release",
                releaseId,
                slot: "legacy_character_avatar",
              }),
            ]),
          },
        },
      });
    } finally {
      await prisma.characterRelease.update({
        where: { id: releaseId },
        data: {
          releasePlacementManifest: original.releasePlacementManifest as never,
        },
      });
    }
  });

  it("ignores deleted Character image authorities and retired or inactive Project drafts", async () => {
    const staleAssetId = `content-authority-deleted-character-asset-${suffix}`;
    const deletedCharacterId = `content-authority-deleted-character-${suffix}`;
    const profileId = `content-authority-deleted-profile-${suffix}`;
    const revisionId = `content-authority-deleted-reference-${suffix}`;
    const lookId = `content-authority-deleted-look-${suffix}`;
    const historicalActiveProjectId = `content-authority-deleted-active-project-${suffix}`;
    const retiredProjectId = `content-authority-retired-project-${suffix}`;
    const inactiveProjectId = `content-authority-inactive-project-${suffix}`;
    const historicalContentVersionId = `content-authority-deleted-content-${suffix}`;
    const historicalReleaseId = `content-authority-deleted-release-${suffix}`;
    await prisma.mediaAsset.create({
      data: {
        id: staleAssetId,
        ownerId: actorId,
        type: "image",
        url: `memory://${staleAssetId}`,
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.character.create({
      data: {
        id: deletedCharacterId,
        creatorId: actorId,
        imageAssetId: staleAssetId,
        name: "Deleted authority fixture",
        age: 24,
        description: "Soft-deleted Character authority must not pin media.",
        source: "official",
        status: "archived",
        visibility: "private",
        appearance: {},
        advancedDetails: {},
        deletedAt: new Date(),
      },
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: profileId,
        characterId: deletedCharacterId,
        version: 1,
        status: "active",
        identityPrompt: "Deleted Character visual profile",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [staleAssetId],
        adapterRefs: [],
        createdFrom: "content_ops_deleted_character_test",
        referenceSetRevisions: {
          create: {
            id: revisionId,
            revision: 1,
            status: "active",
            createdFrom: "content_ops_deleted_character_test",
            references: {
              create: {
                mediaAssetId: staleAssetId,
                position: 0,
                role: "primary_face",
                selectionReason: "Historical reference",
              },
            },
          },
        },
      },
    });
    await prisma.characterLook.create({
      data: {
        id: lookId,
        characterId: deletedCharacterId,
        visualProfileId: profileId,
        ownerId: actorId,
        label: "Historical look",
        appearanceDelta: {},
        referenceAssetId: staleAssetId,
        status: "active",
        activeKey: `deleted-character-look:${suffix}`,
      },
    });
    await prisma.characterProject.createMany({
      data: [
        {
          id: historicalActiveProjectId,
          characterId: deletedCharacterId,
          phase: "producing",
          activeKey: `legacy-deleted-active:${suffix}`,
          audience: {},
          successCriteria: [],
          draftImageAssetId: staleAssetId,
        },
        {
          id: retiredProjectId,
          characterId: deletedCharacterId,
          phase: "retired",
          activeKey: `legacy-retired:${suffix}`,
          audience: {},
          successCriteria: [],
          draftImageAssetId: staleAssetId,
        },
        {
          id: inactiveProjectId,
          characterId: deletedCharacterId,
          phase: "producing",
          activeKey: null,
          audience: {},
          successCriteria: [],
          draftImageAssetId: staleAssetId,
        },
      ],
    });
    await prisma.characterContentVersion.create({
      data: {
        id: historicalContentVersionId,
        characterId: deletedCharacterId,
        version: 1,
        contentHash: `content-authority-deleted-hash-${suffix}`,
        personaSnapshot: {},
        openingSnapshot: {},
        appearanceSnapshot: {},
        sourceType: "content_ops_deleted_character_test",
        createdById: actorId,
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: historicalReleaseId,
        projectId: historicalActiveProjectId,
        revisionId: `content-authority-deleted-revision-${suffix}`,
        characterContentVersionId: historicalContentVersionId,
        generationProvenance: {},
        releasePlacementManifest: {
          placements: [{
            slotKey: "character_avatar",
            assetId: staleAssetId,
          }],
        },
        snapshotHash: `content-authority-deleted-release-hash-${suffix}`,
        readiness: "ready",
        status: "published",
        publishedAt: new Date(),
      },
    });
    await prisma.characterServing.create({
      data: {
        characterId: deletedCharacterId,
        currentReleaseId: historicalReleaseId,
        state: "live",
      },
    });
    try {
      const response = await getContentAsset(
        request("GET", `api/v2/admin/assets/${staleAssetId}`),
        staleAssetId,
      );
      expect(await response.json()).toMatchObject({
        data: {
          asset: {
            authorityDependencies: [],
          },
        },
      });
      await expect(
        patchContentAsset(
          request("PATCH", `api/v2/admin/assets/${staleAssetId}`, {
            status: "archived",
            reason: "Historical authorities no longer pin the media asset",
            confirmation: staleAssetId,
          }),
          staleAssetId,
        ),
      ).resolves.toBeInstanceOf(Response);
    } finally {
      await prisma.characterServing.deleteMany({
        where: { characterId: deletedCharacterId },
      });
      await prisma.characterRelease.deleteMany({
        where: { id: historicalReleaseId },
      });
      await prisma.characterContentVersion.deleteMany({
        where: { id: historicalContentVersionId },
      });
      await prisma.characterLook.deleteMany({ where: { id: lookId } });
      await prisma.characterVisualReferenceSnapshot.deleteMany({
        where: { referenceSetRevisionId: revisionId },
      });
      await prisma.referenceSetRevision.deleteMany({ where: { id: revisionId } });
      await prisma.characterVisualProfile.deleteMany({ where: { id: profileId } });
      await prisma.characterProject.deleteMany({
        where: {
          id: {
            in: [
              historicalActiveProjectId,
              retiredProjectId,
              inactiveProjectId,
            ],
          },
        },
      });
      await prisma.character.deleteMany({ where: { id: deletedCharacterId } });
      await prisma.mediaAsset.deleteMany({ where: { id: staleAssetId } });
    }
  });

  it("projects verified Campaign dependencies and makes v2 placements read-only to legacy PATCH", async () => {
    const response = await getContentAsset(
      request("GET", `api/v2/admin/assets/${campaignAssetId}`),
      campaignAssetId,
    );
    const payload = await response.json();
    expect(payload.data.asset).toMatchObject({
      customerPublishable: false,
      publishabilityReasons: expect.arrayContaining([
        "job_provider_missing",
        "latest_successful_attempt_provider_missing",
      ]),
    });
    expect(payload.data.asset.authorityDependencies).toContainEqual(
      expect.objectContaining({
        kind: "verified_campaign",
        placementId,
        runId: `content-authority-run-${suffix}`,
        repairPath: `/admin/creative/runs/content-authority-run-${suffix}`,
      }),
    );
    await expect(patchContentAsset(
      request("PATCH", `api/v2/admin/assets/${campaignAssetId}`, {
        status: "archived",
        reason: "attempt to archive a verified campaign asset",
        confirmation: campaignAssetId,
      }),
      campaignAssetId,
    )).rejects.toMatchObject({
      status: 409,
      details: {
        code: "asset_authority_dependency_active",
        assetId: campaignAssetId,
      },
    });

    const attempts = [{
      status: "paused",
      metadata: {},
    }, {
      status: "paused",
      metadata: {
        creativeRunId: `content-authority-run-${suffix}`,
        creativeRunItemId: `content-authority-item-${suffix}`,
        customerMediaAuthority: {
          sourceJobId: null,
          jobProvider: "tampered",
          latestAttemptProvider: null,
        },
      },
    }, {
      status: "archived",
    }] satisfies Array<Record<string, unknown>>;
    for (const patch of attempts) {
      await expect(patchPlacement(
        request("PATCH", `api/v2/admin/content/placements/${placementId}`, {
          ...patch,
          reason: "attempt to mutate Creative Run placement through legacy editor",
          confirmation: placementId,
        }),
        placementId,
      )).rejects.toMatchObject({
        status: 409,
        details: {
          code: "creative_run_placement_required",
          repairPath: `/admin/creative/runs/content-authority-run-${suffix}`,
        },
      });
    }
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({
      where: { id: placementId },
    })).resolves.toMatchObject({
      status: "published",
      verificationState: "passed",
      version: 1,
      metadata: {
        creativeRunId: `content-authority-run-${suffix}`,
        creativeRunItemId: `content-authority-item-${suffix}`,
        customerMediaAuthority: {
          sourceJobId: null,
          jobProvider: null,
          latestAttemptProvider: null,
        },
      },
    });
  });

  it("treats published Run items as history after their Campaign placement is replaced", async () => {
    const oldAssetId = `content-authority-replaced-campaign-asset-${suffix}`;
    const currentAssetId = `content-authority-current-campaign-asset-${suffix}`;
    const oldRunId = `content-authority-replaced-campaign-run-${suffix}`;
    const currentRunId = `content-authority-current-campaign-run-${suffix}`;
    const oldItemId = `content-authority-replaced-campaign-item-${suffix}`;
    const currentItemId = `content-authority-current-campaign-item-${suffix}`;
    const oldPlacementId = `content-authority-replaced-campaign-placement-${suffix}`;
    const currentPlacementId = `content-authority-current-campaign-placement-${suffix}`;
    const targetId = `content-authority-replaced-campaign-${suffix}`;
    await prisma.mediaAsset.createMany({
      data: [oldAssetId, currentAssetId].map((id) => ({
        id,
        ownerId: actorId,
        type: "image",
        url: `memory://${id}`,
        safetyStatus: "passed",
        metadata: {},
      })),
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: oldRunId,
        title: "Replaced Campaign asset",
        purpose: "campaign",
        targetType: "none",
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "completed",
        lifecycleState: "closed",
        workflowStage: "verification",
        verificationState: "passed",
        createdById: actorId,
        items: {
          create: {
            id: oldItemId,
            itemIndex: 0,
            mediaAssetId: oldAssetId,
            status: "published",
            tags: [],
          },
        },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: currentRunId,
        title: "Current Campaign asset",
        purpose: "campaign",
        targetType: "none",
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "completed",
        lifecycleState: "closed",
        workflowStage: "verification",
        verificationState: "passed",
        createdById: actorId,
        items: {
          create: {
            id: currentItemId,
            itemIndex: 0,
            mediaAssetId: currentAssetId,
            status: "published",
            tags: [],
          },
        },
      },
    });
    await prisma.mediaAssetPlacement.create({
      data: {
        id: oldPlacementId,
        mediaAssetId: oldAssetId,
        slot: "campaign",
        targetType: "campaign",
        targetId,
        status: "archived",
        verificationState: "passed",
        verifiedAt: new Date(Date.now() - 1_000),
        publishedAt: new Date(Date.now() - 1_000),
        archivedAt: new Date(),
        createdById: actorId,
        metadata: {
          creativeRunId: oldRunId,
          creativeRunItemId: oldItemId,
        },
      },
    });
    await prisma.mediaAssetPlacement.create({
      data: {
        id: currentPlacementId,
        mediaAssetId: currentAssetId,
        slot: "campaign",
        targetType: "campaign",
        targetId,
        status: "published",
        verificationState: "passed",
        verifiedAt: new Date(),
        publishedAt: new Date(),
        rollbackPlacementId: oldPlacementId,
        createdById: actorId,
        metadata: {
          creativeRunId: currentRunId,
          creativeRunItemId: currentItemId,
        },
      },
    });

    try {
      const oldDetail = await getContentAsset(
        request("GET", `api/v2/admin/assets/${oldAssetId}`),
        oldAssetId,
      );
      const oldBody = await oldDetail.json();
      expect(oldBody.data.asset.authorityDependencies).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "creative_run_asset",
            itemId: oldItemId,
          }),
        ]),
      );
      await expect(
        patchContentAsset(
          request("PATCH", `api/v2/admin/assets/${oldAssetId}`, {
            status: "archived",
            reason: "The replacement is live and the old Campaign placement is archived",
            confirmation: oldAssetId,
          }),
          oldAssetId,
        ),
      ).resolves.toBeInstanceOf(Response);

      const currentDetail = await getContentAsset(
        request("GET", `api/v2/admin/assets/${currentAssetId}`),
        currentAssetId,
      );
      const currentBody = await currentDetail.json();
      expect(currentBody.data.asset.authorityDependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "verified_campaign",
            placementId: currentPlacementId,
            runId: currentRunId,
          }),
        ]),
      );
      await expect(
        patchContentAsset(
          request("PATCH", `api/v2/admin/assets/${currentAssetId}`, {
            status: "archived",
            reason: "The current Campaign placement still serves this asset",
            confirmation: currentAssetId,
          }),
          currentAssetId,
        ),
      ).rejects.toMatchObject({
        status: 409,
        details: {
          code: "asset_authority_dependency_active",
          dependencies: expect.arrayContaining([
            expect.objectContaining({
              kind: "verified_campaign",
              placementId: currentPlacementId,
            }),
          ]),
        },
      });
    } finally {
      await prisma.mediaAssetPlacement.deleteMany({
        where: { id: { in: [oldPlacementId, currentPlacementId] } },
      });
      await prisma.contentProductionItem.deleteMany({
        where: { id: { in: [oldItemId, currentItemId] } },
      });
      await prisma.contentProductionBatch.deleteMany({
        where: { id: { in: [oldRunId, currentRunId] } },
      });
      await prisma.mediaAsset.deleteMany({
        where: { id: { in: [oldAssetId, currentAssetId] } },
      });
    }
  });

  it("preflights bulk archive atomically before changing any asset", async () => {
    const bulkAssetIds = [releaseAssetId, bulkFreeAssetId].sort();
    await expect(bulkPatchContentAssets(
      request("POST", "api/v2/admin/assets/bulk", {
        assetIds: bulkAssetIds,
        status: "archived",
        reason: "archive an operator selection",
        confirmation: bulkAssetIds.join(","),
      }),
    )).rejects.toMatchObject({
      status: 409,
      details: {
        code: "asset_authority_dependency_active",
        assetId: releaseAssetId,
      },
    });
    const assets = await prisma.mediaAsset.findMany({
      where: { id: { in: bulkAssetIds } },
      orderBy: { id: "asc" },
    });
    expect(assets.map((asset) => asset.metadata)).toEqual([{}, {}]);
    await expect(prisma.adminAuditLog.count({
      where: { actorId, action: "content.asset.bulk_update" },
    })).resolves.toBe(0);
  });

  it("dispatches the documented POST bulk route and the single batch preflight route", async () => {
    const routeRequestId = `content-authority-route-request-${suffix}`;
    const routeAssetIds = [
      `content-authority-route-a-${suffix}`,
      `content-authority-route-b-${suffix}`,
    ].sort();
    await prisma.mediaAsset.createMany({
      data: routeAssetIds.map((id) => ({
        id,
        ownerId: actorId,
        type: "image",
        url: `memory://${id}`,
        safetyStatus: "passed",
        metadata: {},
      })),
    });
    try {
      const preflight = await adminV2Api(
        "POST",
        "api/v2/admin/assets/bulk/preflight",
        {
          userId: actorId,
          role: "admin",
          body: { assetIds: routeAssetIds },
        },
      );
      expect(preflight).toMatchObject({
        status: 200,
        data: {
          assetIds: routeAssetIds,
          blockers: [],
        },
      });

      const archived = await adminV2Api("POST", "/api/v2/admin/assets/bulk", {
        userId: actorId,
        role: "admin",
        headers: { "x-request-id": routeRequestId },
        body: {
          assetIds: routeAssetIds,
          status: "archived",
          reason: "Exercise the real dispatcher route",
          confirmation: routeAssetIds.join(","),
        },
      });
      expect(archived).toMatchObject({
        status: 200,
        data: { updatedIds: routeAssetIds },
      });
      const saved = await prisma.mediaAsset.findMany({
        where: { id: { in: routeAssetIds } },
        orderBy: { id: "asc" },
      });
      expect(saved.map((asset) => asset.metadata)).toEqual([
        expect.objectContaining({
          platformAsset: expect.objectContaining({ status: "archived" }),
        }),
        expect.objectContaining({
          platformAsset: expect.objectContaining({ status: "archived" }),
        }),
      ]);
    } finally {
      await prisma.adminAuditLog.deleteMany({ where: { requestId: routeRequestId } });
      await prisma.mediaAsset.deleteMany({ where: { id: { in: routeAssetIds } } });
    }
  });

  it("rejects unsorted or duplicate bulk mutation targets before any lookup or lock", async () => {
    const lowAssetId = `a-content-authority-canonical-${suffix}`;
    const highAssetId = `z-content-authority-canonical-${suffix}`;
    const unsorted = await adminV2Api("POST", "/api/v2/admin/assets/bulk", {
      userId: actorId,
      role: "admin",
      body: {
        assetIds: [highAssetId, lowAssetId],
        status: "archived",
        reason: "Reject an ambiguous target order",
        confirmation: `${highAssetId},${lowAssetId}`,
      },
    });
    expect(unsorted).toMatchObject({
      status: 400,
      error: {
        code: "bad_request",
        details: {
          expectedAssetIds: [lowAssetId, highAssetId],
        },
      },
    });

    const duplicate = await adminV2Api("POST", "/api/v2/admin/assets/bulk", {
      userId: actorId,
      role: "admin",
      body: {
        assetIds: [lowAssetId, lowAssetId],
        status: "archived",
        reason: "Reject a duplicate target",
        confirmation: `${lowAssetId},${lowAssetId}`,
      },
    });
    expect(duplicate).toMatchObject({
      status: 400,
      error: {
        code: "bad_request",
        details: {
          expectedAssetIds: [lowAssetId],
        },
      },
    });
  });

  it("returns exact asset IDs from one dispatcher preflight without mutating the selection", async () => {
    const preflight = await adminV2Api(
      "POST",
      "api/v2/admin/assets/bulk/preflight",
      {
        userId: actorId,
        role: "admin",
        body: { assetIds: [freeAssetId, releaseAssetId] },
      },
    );
    expect(preflight).toMatchObject({
      status: 200,
      data: {
        assetIds: [freeAssetId, releaseAssetId].sort(),
        blockers: expect.arrayContaining([
          expect.objectContaining({
            assetId: releaseAssetId,
            dependencies: expect.arrayContaining([
              expect.objectContaining({
                kind: "character_release",
                releaseId,
              }),
            ]),
          }),
        ]),
      },
    });
    await expect(prisma.mediaAsset.findUniqueOrThrow({
      where: { id: freeAssetId },
    })).resolves.toMatchObject({ metadata: {} });
  });

  it("re-reads every target after authority locks and rejects an asset deleted while waiting", async () => {
    const raceAssetId = `content-authority-lock-reread-${suffix}`;
    const raceRequestId = `content-authority-lock-reread-request-${suffix}`;
    await prisma.mediaAsset.create({
      data: {
        id: raceAssetId,
        ownerId: actorId,
        type: "image",
        url: `memory://${raceAssetId}`,
        safetyStatus: "passed",
        metadata: {},
      },
    });
    let pendingArchive: Promise<Awaited<ReturnType<typeof adminV2Api>>> | null = null;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${raceAssetId}`}))`;
        pendingArchive = adminV2Api("POST", "/api/v2/admin/assets/bulk", {
          userId: actorId,
          role: "admin",
          headers: { "x-request-id": raceRequestId },
          body: {
            assetIds: [raceAssetId],
            status: "archived",
            reason: "Race a delete against lock acquisition",
            confirmation: raceAssetId,
          },
        });
        await delay(50);
        await tx.mediaAsset.update({
          where: { id: raceAssetId },
          data: { deletedAt: new Date() },
        });
      });
      expect(pendingArchive).not.toBeNull();
      const result = await pendingArchive!;
      expect(result).toMatchObject({
        status: 404,
        error: {
          details: { missingAssetIds: [raceAssetId] },
        },
      });
      await expect(prisma.adminAuditLog.count({
        where: { requestId: raceRequestId },
      })).resolves.toBe(0);
    } finally {
      await prisma.mediaAsset.deleteMany({ where: { id: raceAssetId } });
    }
  });

  it("archives lifecycle state without replaying stale tags or description", async () => {
    const metadataAssetId = `content-authority-stale-metadata-${suffix}`;
    await prisma.mediaAsset.create({
      data: {
        id: metadataAssetId,
        ownerId: actorId,
        type: "image",
        url: `memory://${metadataAssetId}`,
        safetyStatus: "passed",
        metadata: {
          platformAsset: {
            status: "approved",
            tags: ["newer-tag"],
            description: "Newer curator description",
          },
        },
      },
    });
    try {
      const response = await patchContentAsset(
        request("PATCH", `api/v2/admin/assets/${metadataAssetId}`, {
          status: "archived",
          tags: ["stale-tag"],
          description: "Stale page description",
          reason: "Archive without replaying a stale draft",
          confirmation: metadataAssetId,
        }),
        metadataAssetId,
      );
      expect(response.status).toBe(200);
      const saved = await prisma.mediaAsset.findUniqueOrThrow({
        where: { id: metadataAssetId },
      });
      expect(saved.metadata).toMatchObject({
        platformAsset: {
          status: "archived",
          tags: ["newer-tag"],
          description: "Newer curator description",
        },
      });
    } finally {
      await prisma.mediaAsset.deleteMany({ where: { id: metadataAssetId } });
    }
  });

  it("blocks archive while a queued generation job pins an image only through controls", async () => {
    const sourceOnlyJobId = `content-authority-source-only-job-${suffix}`;
    await prisma.generationJob.create({
      data: {
        id: sourceOnlyJobId,
        userId: actorId,
        characterId: null,
        mode: "image",
        controls: { sourceImageAssetId: freeAssetId },
        presetIds: [],
        status: "queued",
      },
    });
    try {
      const detail = await getContentAsset(
        request("GET", `api/v2/admin/assets/${freeAssetId}`),
        freeAssetId,
      );
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        data: {
          asset: {
            authorityDependencies: expect.arrayContaining([
              expect.objectContaining({
                kind: "character_generation_job",
                characterId: null,
                generationJobId: sourceOnlyJobId,
              }),
            ]),
          },
        },
      });
      await expect(
        patchContentAsset(
          request("PATCH", `api/v2/admin/assets/${freeAssetId}`, {
            status: "archived",
            reason: "A source-only queued job must retain its pinned image",
            confirmation: freeAssetId,
          }),
          freeAssetId,
        ),
      ).rejects.toMatchObject({
        status: 409,
        details: {
          code: "asset_authority_dependency_active",
          dependencies: expect.arrayContaining([
            expect.objectContaining({
              generationJobId: sourceOnlyJobId,
            }),
          ]),
        },
      });
      await expect(
        prisma.mediaAsset.findUniqueOrThrow({ where: { id: freeAssetId } }),
      ).resolves.toMatchObject({ metadata: {} });
    } finally {
      await prisma.generationJob.deleteMany({ where: { id: sourceOnlyJobId } });
    }
    const after = await getContentAsset(
      request("GET", `api/v2/admin/assets/${freeAssetId}`),
      freeAssetId,
    );
    const afterBody = await after.json();
    expect(afterBody.data.asset.authorityDependencies).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ generationJobId: sourceOnlyJobId }),
      ]),
    );
  });

  it("protects a Look-only generation input from single and bulk archive until the job is terminal", async () => {
    const lookAssetId = `content-authority-look-only-${suffix}`;
    const lookJobId = `content-authority-look-only-job-${suffix}`;
    await prisma.mediaAsset.create({
      data: {
        id: lookAssetId,
        ownerId: actorId,
        type: "image",
        url: `memory://${lookAssetId}`,
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.generationJob.create({
      data: {
        id: lookJobId,
        userId: actorId,
        characterId: null,
        mode: "image",
        controls: { lookReferenceAssetId: lookAssetId },
        presetIds: [],
        status: "running",
      },
    });
    try {
      const detail = await getContentAsset(
        request("GET", `api/v2/admin/assets/${lookAssetId}`),
        lookAssetId,
      );
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        data: {
          asset: {
            authorityDependencies: expect.arrayContaining([
              expect.objectContaining({
                kind: "character_generation_job",
                generationJobId: lookJobId,
              }),
            ]),
          },
        },
      });

      await expect(
        patchContentAsset(
          request("PATCH", `api/v2/admin/assets/${lookAssetId}`, {
            status: "archived",
            reason: "A running Look input must remain hydratable",
            confirmation: lookAssetId,
          }),
          lookAssetId,
        ),
      ).rejects.toMatchObject({
        status: 409,
        details: {
          code: "asset_authority_dependency_active",
          assetId: lookAssetId,
        },
      });
      await expect(
        bulkPatchContentAssets(
          request("POST", "api/v2/admin/assets/bulk", {
            assetIds: [lookAssetId],
            status: "archived",
            reason: "Bulk archive must preserve the running Look input",
            confirmation: lookAssetId,
          }),
        ),
      ).rejects.toMatchObject({
        status: 409,
        details: {
          code: "asset_authority_dependency_active",
          assetId: lookAssetId,
        },
      });

      await prisma.generationJob.update({
        where: { id: lookJobId },
        data: { status: "completed", completedAt: new Date() },
      });
      const archived = await bulkPatchContentAssets(
        request("POST", "api/v2/admin/assets/bulk", {
          assetIds: [lookAssetId],
          status: "archived",
          reason: "The terminal job no longer pins its Look input",
          confirmation: lookAssetId,
        }),
      );
      expect(archived.status).toBe(200);
      await expect(
        prisma.mediaAsset.findUniqueOrThrow({ where: { id: lookAssetId } }),
      ).resolves.toMatchObject({
        metadata: {
          platformAsset: expect.objectContaining({ status: "archived" }),
        },
      });
    } finally {
      await prisma.generationJob.deleteMany({ where: { id: lookJobId } });
      await prisma.mediaAsset.deleteMany({ where: { id: lookAssetId } });
    }
  });

  it("ignores stale active Reference Sets from archived Visual Profiles", async () => {
    const oldOnlyAssetId = `content-authority-old-reference-${suffix}`;
    const currentAssetId = `content-authority-current-reference-${suffix}`;
    const archivedProfileId = `content-authority-archived-profile-${suffix}`;
    const activeProfileId = `content-authority-active-profile-${suffix}`;
    const archivedProfileRevisionId = `content-authority-archived-profile-r1-${suffix}`;
    const activeProfileRevisionId = `content-authority-active-profile-r1-${suffix}`;
    await prisma.mediaAsset.createMany({
      data: [oldOnlyAssetId, currentAssetId].map((id) => ({
        id,
        ownerId: actorId,
        characterId,
        type: "image",
        url: `memory://${id}`,
        safetyStatus: "passed",
        metadata: {},
      })),
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: archivedProfileId,
        characterId,
        version: 1001,
        status: "archived",
        identityPrompt: "Archived visual identity",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [],
        adapterRefs: [],
        createdFrom: "content_ops_authority_test",
        referenceSetRevisions: {
          create: {
            id: archivedProfileRevisionId,
            revision: 1,
            status: "active",
            createdFrom: "content_ops_authority_test",
            references: {
              create: [
                {
                  mediaAssetId: currentAssetId,
                  position: 0,
                  role: "primary_face",
                  selectionReason: "Archived V1 reference",
                },
                {
                  mediaAssetId: oldOnlyAssetId,
                  position: 1,
                  role: "identity_reference",
                  selectionReason: "Archived V1-only reference",
                },
              ],
            },
          },
        },
      },
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: activeProfileId,
        characterId,
        version: 1002,
        status: "active",
        identityPrompt: "Current visual identity",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [],
        adapterRefs: [],
        createdFrom: "content_ops_authority_test",
        referenceSetRevisions: {
          create: {
            id: activeProfileRevisionId,
            revision: 1,
            status: "active",
            createdFrom: "content_ops_authority_test",
            references: {
              create: {
                mediaAssetId: currentAssetId,
                position: 0,
                role: "primary_face",
                selectionReason: "Current V2 reference",
              },
            },
          },
        },
      },
    });

    try {
      const oldOnlyDetail = await getContentAsset(
        request("GET", `api/v2/admin/assets/${oldOnlyAssetId}`),
        oldOnlyAssetId,
      );
      expect(await oldOnlyDetail.json()).toMatchObject({
        data: {
          asset: {
            authorityDependencies: expect.not.arrayContaining([
              expect.objectContaining({
                kind: "character_reference_set",
                referenceSetRevisionId: archivedProfileRevisionId,
              }),
            ]),
          },
        },
      });
      await expect(
        patchContentAsset(
          request("PATCH", `api/v2/admin/assets/${oldOnlyAssetId}`, {
            status: "archived",
            reason: "Archived Visual Profile references are no longer operational authority",
            confirmation: oldOnlyAssetId,
          }),
          oldOnlyAssetId,
        ),
      ).resolves.toBeInstanceOf(Response);

      const currentDetail = await getContentAsset(
        request("GET", `api/v2/admin/assets/${currentAssetId}`),
        currentAssetId,
      );
      expect(await currentDetail.json()).toMatchObject({
        data: {
          asset: {
            authorityDependencies: expect.arrayContaining([
              expect.objectContaining({
                kind: "character_reference_set",
                visualProfileId: activeProfileId,
                referenceSetRevisionId: activeProfileRevisionId,
              }),
            ]),
          },
        },
      });
      await expect(
        patchContentAsset(
          request("PATCH", `api/v2/admin/assets/${currentAssetId}`, {
            status: "archived",
            reason: "Current Visual Profile reference must remain available",
            confirmation: currentAssetId,
          }),
          currentAssetId,
        ),
      ).rejects.toMatchObject({
        status: 409,
        details: {
          code: "asset_authority_dependency_active",
          dependencies: expect.arrayContaining([
            expect.objectContaining({
              referenceSetRevisionId: activeProfileRevisionId,
            }),
          ]),
        },
      });

      // 原本这里还有一段：一张图「只在 profile 影子列、不在参考集里」也必须算权威依赖。
      // 参考图归一后每个 identity 版本都带 active Reference Set、参考图只来自该集合，
      // 那个状态不可能再产生，被测对象已消失，故随影子列读点一并移除。
    } finally {
      await prisma.characterVisualReferenceSnapshot.deleteMany({
        where: {
          referenceSetRevisionId: {
            in: [archivedProfileRevisionId, activeProfileRevisionId],
          },
        },
      });
      await prisma.referenceSetRevision.deleteMany({
        where: {
          id: { in: [archivedProfileRevisionId, activeProfileRevisionId] },
        },
      });
      await prisma.characterVisualProfile.deleteMany({
        where: { id: { in: [archivedProfileId, activeProfileId] } },
      });
      await prisma.mediaAsset.deleteMany({
        where: {
          id: {
            in: [oldOnlyAssetId, currentAssetId],
          },
        },
      });
    }
  });

  it("rejects a bulk selection containing a non-operational asset before changing any asset", async () => {
    const missingAssetId = `content-authority-missing-${suffix}`;
    const bulkAssetIds = [freeAssetId, missingAssetId].sort();
    const auditCountBefore = await prisma.adminAuditLog.count({
      where: { actorId, action: "content.asset.bulk_update" },
    });
    await expect(bulkPatchContentAssets(
      request("POST", "api/v2/admin/assets/bulk", {
        assetIds: bulkAssetIds,
        status: "archived",
        reason: "reject partial bulk success",
        confirmation: bulkAssetIds.join(","),
      }),
    )).rejects.toMatchObject({
      status: 404,
      details: {
        missingAssetIds: [missingAssetId],
      },
    });
    await expect(prisma.mediaAsset.findUniqueOrThrow({
      where: { id: freeAssetId },
    })).resolves.toMatchObject({ metadata: {} });
    await expect(prisma.adminAuditLog.count({
      where: { actorId, action: "content.asset.bulk_update" },
    })).resolves.toBe(auditCountBefore);
  });

  it("rolls back a single Library mutation when its Audit row cannot commit", async () => {
    const requestId = `${auditFailureRequestPrefix}-single`;
    await prisma.contentProductionItem.update({
      where: { id: auditItemId },
      data: { status: "rejected" },
    });
    await expect(patchContentAsset(
      request("PATCH", `api/v2/admin/assets/${freeAssetId}`, {
        status: "archived",
        tags: ["should-rollback"],
        reason: "prove asset and Audit atomicity",
        confirmation: freeAssetId,
      }, requestId),
      freeAssetId,
    )).rejects.toThrow("injected content asset audit failure");
    await expect(prisma.mediaAsset.findUniqueOrThrow({
      where: { id: freeAssetId },
    })).resolves.toMatchObject({ metadata: {} });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({
      where: { id: auditItemId },
    })).resolves.toMatchObject({ tags: [] });
    await expect(prisma.adminAuditLog.count({ where: { requestId } })).resolves.toBe(0);
  });

  it("rolls back every selected Library asset when the bulk Audit row cannot commit", async () => {
    const requestId = `${auditFailureRequestPrefix}-bulk`;
    const bulkAssetIds = [freeAssetId, bulkFreeAssetId].sort();
    await expect(bulkPatchContentAssets(
      request("POST", "api/v2/admin/assets/bulk", {
        assetIds: bulkAssetIds,
        status: "archived",
        tags: ["should-rollback"],
        reason: "prove bulk assets and Audit atomicity",
        confirmation: bulkAssetIds.join(","),
      }, requestId),
    )).rejects.toThrow("injected content asset audit failure");
    const assets = await prisma.mediaAsset.findMany({
      where: { id: { in: [freeAssetId, bulkFreeAssetId] } },
      orderBy: { id: "asc" },
    });
    expect(assets.map((asset) => asset.metadata)).toEqual([{}, {}]);
    await expect(prisma.contentProductionItem.findUniqueOrThrow({
      where: { id: auditItemId },
    })).resolves.toMatchObject({ tags: [] });
    await expect(prisma.adminAuditLog.count({ where: { requestId } })).resolves.toBe(0);
  });

  it("serializes Library archive against placement staging", async () => {
    const targetId = `content-authority-stage-race-${suffix}`;
    const results = await Promise.allSettled([
      patchContentAsset(
        request("PATCH", `api/v2/admin/assets/${approvedAssetId}`, {
          status: "archived",
          reason: "archive only when no placement is being staged",
          confirmation: approvedAssetId,
        }),
        approvedAssetId,
      ),
      publishDistributionPlacement({
        runId: approvedRunId,
        itemId: approvedItemId,
        assetId: approvedAssetId,
        actor: { id: actorId, role: "admin" },
        expectedVersion: 1,
        slot: "campaign",
        targetType: "campaign",
        targetId,
        eyebrow: "Featured",
        title: "Content authority campaign",
        reason: "stage only while the approved asset remains publishable",
        requestId: `content-authority-stage-race-${suffix}`,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const [asset, placements] = await Promise.all([
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: approvedAssetId } }),
      prisma.mediaAssetPlacement.findMany({
        where: { mediaAssetId: approvedAssetId, targetId },
      }),
    ]);
    const archived = Boolean(asset.metadata && typeof asset.metadata === "object" &&
      !Array.isArray(asset.metadata) &&
      (asset.metadata as Record<string, unknown>).platformAsset &&
      typeof (asset.metadata as Record<string, unknown>).platformAsset === "object" &&
      ((asset.metadata as Record<string, Record<string, unknown>>).platformAsset.status === "archived"));
    const rejected = results.find((result) => result.status === "rejected");
    if (placements.length === 1) {
      expect(archived).toBe(false);
      expect(placements[0]).toMatchObject({
        status: "scheduled",
        verificationState: "verifying",
      });
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: {
          status: 409,
          details: { code: "asset_authority_dependency_active" },
        },
      });
    } else {
      expect(placements).toHaveLength(0);
      expect(archived).toBe(true);
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: {
          status: 400,
          details: { code: "creative_asset_not_customer_publishable" },
        },
      });
    }
  });

  it("replays standalone draft Placement creation by idempotency key", async () => {
    const targetId = `content-authority-idempotent-placement-${suffix}`;
    const idempotencyKey = `content-authority-placement-create-${suffix}`;
    const createRequest = () => new Request(
      "http://localhost/api/v2/admin/content/placements",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "x-request-id": `content-authority-placement-create-${randomUUID()}`,
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          mediaAssetId: concurrentAssetId,
          slot: "feed_card",
          targetType: "route_page",
          targetId,
          reason: "create one replay-safe standalone draft placement",
        }),
      },
    );

    const first = await createPlacement(createRequest());
    const second = await createPlacement(createRequest());
    const firstPayload = await first.json();
    const secondPayload = await second.json();
    expect(firstPayload.data.placement.status).toBe("draft");
    expect(secondPayload.data).toMatchObject({
      replayed: true,
      placement: { id: firstPayload.data.placement.id, status: "draft" },
    });
    await expect(prisma.mediaAssetPlacement.count({
      where: { mediaAssetId: concurrentAssetId, targetId },
    })).resolves.toBe(1);
    await expect(prisma.adminAuditLog.count({
      where: {
        actorId,
        action: "content.placement.create",
        targetId: firstPayload.data.placement.id,
      },
    })).resolves.toBe(1);
    await expect(prisma.controlPlaneCommand.count({
      where: {
        actorId,
        commandType: "content.placement.create",
        idempotencyKey,
      },
    })).resolves.toBe(1);
  });

  it("requires Placement transport headers and replays PATCH after response loss", async () => {
    const missingCreateKey = new Request(
      "http://localhost/api/v2/admin/content/placements",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify({
          mediaAssetId: concurrentAssetId,
          slot: "feed_card",
          targetType: "route_page",
          targetId: `content-authority-missing-create-key-${suffix}`,
          reason: "prove the create transport requires idempotency",
        }),
      },
    );
    await expect(createPlacement(missingCreateKey)).rejects.toMatchObject({
      status: 400,
      message: "Idempotency-Key header is required",
    });

    const created = await adminV2Api("POST", "/api/v2/admin/content/placements", {
      userId: actorId,
      role: "admin",
      body: {
        mediaAssetId: concurrentAssetId,
        slot: "feed_card",
        targetType: "route_page",
        targetId: `content-authority-patch-replay-${suffix}`,
        reason: "create a draft for response-loss replay",
      },
    });
    const placementId = created.data.placement.id as string;
    const patchKey = `content-authority-placement-patch-${suffix}`;
    const patchBody = {
      status: "paused",
      reason: "pause exactly once even if the response is lost",
      confirmation: placementId,
    };
    const patchRequest = (ifMatch: string | null, idempotencyKey = patchKey) =>
      new Request(`http://localhost/api/v2/admin/content/placements/${placementId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "x-request-id": randomUUID(),
          "idempotency-key": idempotencyKey,
          ...(ifMatch ? { "if-match": ifMatch } : {}),
        },
        body: JSON.stringify(patchBody),
      });

    await expect(patchPlacement(
      patchRequest(null, `${patchKey}-missing-if-match`),
      placementId,
    )).rejects.toMatchObject({
      status: 400,
      message: "If-Match must contain an authority version",
    });
    const first = await patchPlacement(patchRequest("\"1\""), placementId);
    const replay = await patchPlacement(patchRequest("\"1\""), placementId);
    await expect(first.json()).resolves.toMatchObject({
      data: {
        replayed: false,
        placement: { id: placementId, status: "paused", version: 2 },
      },
    });
    await expect(replay.json()).resolves.toMatchObject({
      data: {
        replayed: true,
        placement: { id: placementId, status: "paused", version: 2 },
      },
    });
    await expect(prisma.adminAuditLog.count({
      where: {
        actorId,
        action: "content.placement.paused",
        targetId: placementId,
      },
    })).resolves.toBe(1);
    await expect(prisma.controlPlaneCommand.count({
      where: {
        actorId,
        commandType: "content.placement.patch",
        idempotencyKey: patchKey,
      },
    })).resolves.toBe(1);
    await expect(patchPlacement(
      new Request(`http://localhost/api/v2/admin/content/placements/${placementId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "idempotency-key": `${patchKey}-stale`,
          "if-match": "\"1\"",
        },
        body: JSON.stringify({
          status: "archived",
          reason: "stale operator intent must not archive a newer projection",
          confirmation: placementId,
        }),
      }),
      placementId,
    )).rejects.toMatchObject({
      status: 409,
      details: {
        code: "legacy_placement_version_mismatch",
        expectedVersion: 1,
        currentVersion: 2,
      },
    });
  });

  it("keeps standalone legacy Placement PATCH actions explicit and archive terminal", async () => {
    const targetId = `content-authority-patch-placement-${suffix}`;
    const created = await adminV2Api("POST", "/api/v2/admin/content/placements", {
      userId: actorId,
      role: "admin",
      body: {
        mediaAssetId: concurrentAssetId,
        slot: "feed_card",
        targetType: "route_page",
        targetId,
        reason: "create a standalone draft for the patch transition matrix",
      },
    });
    expect(created).toMatchObject({
      status: 200,
      data: { placement: { status: "draft", version: 1 } },
    });
    const legacyPlacementId = created.data.placement.id as string;

    for (const status of ["draft", "scheduled", "published"] as const) {
      const rejected = await adminV2Api(
        "PATCH",
        `api/v2/admin/content/placements/${legacyPlacementId}`,
        {
          userId: actorId,
          role: "admin",
          body: {
            status,
            reason: `reject unsupported ${status} legacy patch`,
            confirmation: legacyPlacementId,
          },
        },
      );
      expect(rejected).toMatchObject({
        status: 400,
        error: { code: "bad_request" },
      });
    }
    const metadataOnly = await adminV2Api(
      "PATCH",
      `api/v2/admin/content/placements/${legacyPlacementId}`,
      {
        userId: actorId,
        role: "admin",
        body: {
          metadata: { attempted: true },
          reason: "metadata alone is not a placement state action",
          confirmation: legacyPlacementId,
        },
      },
    );
    expect(metadataOnly).toMatchObject({
      status: 400,
      error: { code: "bad_request" },
    });
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({
      where: { id: legacyPlacementId },
    })).resolves.toMatchObject({ status: "draft" });

    const paused = await adminV2Api(
      "PATCH",
      `api/v2/admin/content/placements/${legacyPlacementId}`,
      {
        userId: actorId,
        role: "admin",
        headers: { "if-match": "\"1\"" },
        body: {
          status: "paused",
          reason: "pause the standalone draft after operator review",
          confirmation: legacyPlacementId,
        },
      },
    );
    expect(paused).toMatchObject({
      status: 200,
      data: { placement: { status: "paused" } },
    });
    const repeatedPause = await adminV2Api(
      "PATCH",
      `api/v2/admin/content/placements/${legacyPlacementId}`,
      {
        userId: actorId,
        role: "admin",
        headers: { "if-match": "\"2\"" },
        body: {
          status: "paused",
          reason: "do not record a duplicate pause transition",
          confirmation: legacyPlacementId,
        },
      },
    );
    expect(repeatedPause).toMatchObject({
      status: 409,
      error: {
        code: "conflict",
        details: { code: "legacy_placement_transition_invalid" },
      },
    });

    const archived = await adminV2Api(
      "PATCH",
      `api/v2/admin/content/placements/${legacyPlacementId}`,
      {
        userId: actorId,
        role: "admin",
        headers: { "if-match": "\"2\"" },
        body: {
          status: "archived",
          reason: "archive the paused standalone placement",
          confirmation: legacyPlacementId,
        },
      },
    );
    expect(archived).toMatchObject({
      status: 200,
      data: { placement: { status: "archived" } },
    });
    for (const status of ["paused", "archived"] as const) {
      const terminal = await adminV2Api(
        "PATCH",
        `api/v2/admin/content/placements/${legacyPlacementId}`,
        {
          userId: actorId,
          role: "admin",
          headers: { "if-match": "\"3\"" },
          body: {
            status,
            reason: "archived is the terminal legacy placement state",
            confirmation: legacyPlacementId,
          },
        },
      );
      expect(terminal).toMatchObject({
        status: 409,
        error: {
          code: "conflict",
          details: { code: "legacy_placement_transition_invalid" },
        },
      });
    }
  });

  it("serializes concurrent legacy pause/archive so archive remains terminal", async () => {
    const targetId = `content-authority-concurrent-patch-${suffix}`;
    const created = await adminV2Api("POST", "/api/v2/admin/content/placements", {
      userId: actorId,
      role: "admin",
      body: {
        mediaAssetId: concurrentAssetId,
        slot: "feed_card",
        targetType: "route_page",
        targetId,
        reason: "create a standalone draft for concurrent transition authority",
      },
    });
    expect(created).toMatchObject({
      status: 200,
      data: { placement: { status: "draft" } },
    });
    const legacyPlacementId = created.data.placement.id as string;
    let archivePromise: Promise<Response> | null = null;
    let pausePromise: Promise<Response> | null = null;

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "media_asset_placements"
        WHERE "id" = ${legacyPlacementId}
        FOR UPDATE
      `;
      archivePromise = patchPlacement(
        request(
          "PATCH",
          `api/v2/admin/content/placements/${legacyPlacementId}`,
          {
            status: "archived",
            reason: "archive must win the concurrent terminal transition",
            confirmation: legacyPlacementId,
          },
          `content-authority-concurrent-archive-${suffix}`,
        ),
        legacyPlacementId,
      );
      await delay(25);
      pausePromise = patchPlacement(
        request(
          "PATCH",
          `api/v2/admin/content/placements/${legacyPlacementId}`,
          {
            status: "paused",
            reason: "a stale pause must not reopen an archived placement",
            confirmation: legacyPlacementId,
          },
          `content-authority-concurrent-pause-${suffix}`,
        ),
        legacyPlacementId,
      );
      await delay(75);
    });

    if (!archivePromise || !pausePromise) {
      throw new Error("Concurrent Placement mutations were not started");
    }
    const [archiveResult, pauseResult] = await Promise.allSettled([
      archivePromise,
      pausePromise,
    ]);
    expect(archiveResult).toMatchObject({ status: "fulfilled" });
    expect(pauseResult).toMatchObject({
      status: "rejected",
      reason: {
        status: 409,
        details: {
          code: "legacy_placement_version_mismatch",
          expectedVersion: 1,
          currentVersion: 2,
        },
      },
    });
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({
      where: { id: legacyPlacementId },
    })).resolves.toMatchObject({
      status: "archived",
      version: 2,
    });
    await expect(prisma.adminAuditLog.count({
      where: {
        targetId: legacyPlacementId,
        action: "content.placement.archived",
      },
    })).resolves.toBe(1);
    await expect(prisma.adminAuditLog.count({
      where: {
        targetId: legacyPlacementId,
        action: "content.placement.paused",
      },
    })).resolves.toBe(0);
  });

  it("serializes Library archive against placement verification", async () => {
    const results = await Promise.allSettled([
      patchContentAsset(
        request("PATCH", `api/v2/admin/assets/${concurrentAssetId}`, {
          status: "archived",
          reason: "attempt to archive while verification is active",
          confirmation: concurrentAssetId,
        }),
        concurrentAssetId,
      ),
      verifyCreativePlacement({
        runId: concurrentRunId,
        placementId: concurrentPlacementId,
        actor: { id: actorId, role: "admin" },
        expectedVersion: 1,
        reason: "verify the staged campaign without an archive race",
        requestId: `content-authority-concurrent-verify-${suffix}`,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: {
        status: 409,
        details: {
          code: "asset_authority_dependency_active",
        },
      },
    });
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({
      where: { id: concurrentPlacementId },
    })).resolves.toMatchObject({
      mediaAssetId: concurrentAssetId,
      status: "published",
      verificationState: "passed",
    });
    const asset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: concurrentAssetId },
    });
    expect(asset.metadata).not.toMatchObject({
      platformAsset: { status: "archived" },
    });
  });

  it.each(["scheduled", "published", "paused", "archived"] as const)(
    "rejects legacy Placement create status %s at the HTTP schema boundary",
    async (status) => {
      const targetId = `legacy-status-${status}-${suffix}`;
      const result = await adminV2Api("POST", "/api/v2/admin/content/placements", {
        userId: actorId,
        role: "admin",
        body: {
          mediaAssetId: approvedAssetId,
          slot: "feed_card",
          targetType: "route_page",
          targetId,
          status,
          reason: "attempt unsupported standalone placement state",
        },
      });
      expect(result).toMatchObject({
        status: 400,
        error: { code: "bad_request" },
      });
      await expect(prisma.mediaAssetPlacement.count({
        where: { mediaAssetId: approvedAssetId, targetId },
      })).resolves.toBe(0);
    },
  );

  it.each(["character_avatar", "character_hero", "character_chat"] as const)(
    "keeps %s owned by Character Release even for draft records",
    async (slot) => {
      const targetId = `legacy-release-slot-${slot}-${suffix}`;
      const result = await adminV2Api("POST", "/api/v2/admin/content/placements", {
        userId: actorId,
        role: "admin",
        body: {
          mediaAssetId: approvedAssetId,
          slot,
          targetType: "character",
          targetId,
          status: "draft",
          reason: "attempt to bypass Character Release ownership",
        },
      });
      expect(result).toMatchObject({
        status: 409,
        error: {
          code: "conflict",
          details: { code: "character_release_authority_required" },
        },
      });
      await expect(prisma.mediaAssetPlacement.count({
        where: {
          mediaAssetId: approvedAssetId,
          slot,
          targetId,
        },
      })).resolves.toBe(0);
    },
  );
});
