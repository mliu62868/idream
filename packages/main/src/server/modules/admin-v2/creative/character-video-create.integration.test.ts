import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterVideoProductionRecipe, compileCharacterSoul } from "@idream/shared";
import { POST as createCreativeRun } from "@/app/api/v2/admin/creative/runs/route";
import { createDeliveredGenerationAsset } from "@/server/ai/generation-asset-delivery";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import { prisma } from "@/server/lib/db";
import { OPERATOR_UPLOAD_AUTHORITY_SCHEMA } from "@/server/lib/media-asset-authority";
import { providers } from "@/server/providers";
import { characterReleaseSnapshotHash, characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { getCharacterWorkspace } from "@/server/modules/admin-v2/characters/workspace";
import { createCharacterMediaLibraryEntry } from "@/server/modules/character-media-library/admin-service";
import * as libraryModels from "@/server/modules/character-media-library/media-models";
import { markProductionItemGenerated } from "@/server/modules/content-production-state";
import { isDefaultProductionVideoProfile } from "@/server/modules/generation/production-video-profile";
import { createReferenceSetRevision } from "@/server/modules/ourdream/generation-reference-set";
import { purgeQueuedGenerationJobs } from "@/server/test/helpers";
import { toInputJson } from "../shared/prisma-json";

describe("Character video Creative Run authority", () => {
  const suffix = randomUUID();
  const actorId = `character-video-actor-${suffix}`;
  const characterId = `character-video-character-${suffix}`;
  const projectId = `character-video-project-${suffix}`;
  const contentId = `character-video-content-${suffix}`;
  const revisionId = `character-video-revision-${suffix}`;
  const otherCharacterId = `character-video-other-${suffix}`;
  const publishedPrimaryAssetId = `character-video-primary-${suffix}`;
  const sourceAssetId = `character-video-source-${suffix}`;
  const otherSourceAssetId = `character-video-other-source-${suffix}`;
  const batchIds: string[] = [];
  const deliveredVideos: Array<{ id: string; key: string }> = [];

  function request(
    overrides: Record<string, unknown> = {},
    key = `character-video-create-${suffix}`,
  ) {
    return new Request("http://localhost/api/v2/admin/creative/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify({
        title: "Mara motion portrait",
        purpose: "character_video",
        targetType: "character",
        targetId: characterId,
        profileId: characterVideoProductionRecipe.profileKey,
        referenceAssetIds: [sourceAssetId],
        orientation: characterVideoProductionRecipe.orientation,
        count: 1,
        brief: "A subtle natural smile with direct eye contact and a steady camera.",
        consistencyMode: "balanced",
        priority: "normal",
        reason: "Create one reviewable Character video candidate",
        ...overrides,
      }),
    });
  }

  async function completeVideoFromSource(referenceAssetId: string, name: string) {
    const response = await createCreativeRun(request({ referenceAssetIds: [referenceAssetId] }, `character-video-${name}-${suffix}`));
    expect(response.status).toBe(202);
    const batchId = (await response.json()).data.batch.id as string;
    batchIds.push(batchId);
    const item = await prisma.contentProductionItem.findFirstOrThrow({ where: { batchId }, include: { job: true } });
    const job = item.job!;
    const attempt = await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: job.id } });
    const provider = attempt.provider;
    if (!provider) throw new Error("Video attempt did not pin its provider");
    const id = `character-video-delivered-${name}-${suffix}`;
    const key = `tests/${id}.mp4`;
    deliveredVideos.push({ id, key });
    const bytes = await readFile(new URL("../../../../e2e/fixtures/collection-playback.mp4", import.meta.url));
    expect(await providers.blob.putPrivate({ key, body: bytes, contentType: "video/mp4" })).toMatchObject({ ok: true });
    // Only the provider output is a fixture. Use the real asset writer and Run terminal transition.
    await prisma.$transaction(async tx => {
      await createDeliveredGenerationAsset(tx, { id, request: job,
        payload: { mode: "video", usage: {} }, provider,
        asset: { key, contentType: "video/mp4", width: 48, height: 48, providerKey: null },
        ordinal: 0, safetyStatus: "passed" });
      const completedAt = new Date();
      await recordGenerationAttemptEvent(tx, { eventId: `${attempt.id}:terminal`, attemptId: attempt.id,
        eventType: "generation.attempt.succeeded.v1", outcome: "succeeded", occurredAt: completedAt, payload: { requestId: job.id } });
      await tx.generationJob.update({ where: { id: job.id }, data: { status: "completed", completedAt } });
      await markProductionItemGenerated(tx, { jobId: job.id, mediaAssetId: id });
    });
    return { batchId, job, mediaAssetId: id };
  }

  beforeAll(async () => {
    const fixture = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#643a2b" } }).webp().toBuffer();
    for (const id of [publishedPrimaryAssetId, sourceAssetId, otherSourceAssetId]) {
      await providers.blob.putPrivate({ key: `tests/${id}.webp`, body: fixture, contentType: "image/webp" });
    }
    const profile = await prisma.generationModelProfile.findFirst({
      where: {
        profileKey: characterVideoProductionRecipe.profileKey,
        version: characterVideoProductionRecipe.recipeVersion,
      },
    });
    expect(profile && isDefaultProductionVideoProfile(profile)).toBe(true);
    expect(await prisma.generationRecipe.count({
      where: {
        mode: "video",
        useCase: "character",
        status: "active",
      },
    })).toBeGreaterThan(0);

    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@idream.internal`,
        role: "admin",
        status: "active",
      },
    });
    await prisma.character.createMany({
      data: [
        {
          id: characterId,
          creatorId: actorId,
          name: "Mara",
          age: 27,
          description: "A warm, self-assured companion.",
          visibility: "public",
          status: "approved",
          source: "official",
          appearance: {},
          advancedDetails: {},
        },
        {
          id: otherCharacterId,
          creatorId: actorId,
          name: "Other",
          age: 28,
          description: "A separate Character.",
          status: "approved",
          source: "official",
          appearance: {},
          advancedDetails: {},
        },
      ],
    });
    const compiledSoul = compileCharacterSoul({
      name: "Mara",
      age: 27,
      gender: "female",
      characterPromise: "A warm, self-assured companion.",
      detailsMarkdown: "Observant, direct, and emotionally grounded. Warm and concise. She works with local community groups.",
    });
    if (!compiledSoul.ok || compiledSoul.diagnostics.length > 0) {
      throw new Error("video workspace fixture Soul must be release-complete");
    }
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: compiledSoul.snapshot.compiled.fingerprint,
        personaSnapshot: toInputJson(compiledSoul.snapshot),
        openingSnapshot: { firstMessage: "Tell me what happened." },
        appearanceSnapshot: { style: "realistic" },
        sourceType: "test",
        createdById: actorId,
      },
    });
    await prisma.character.update({
      where: { id: characterId },
      data: { currentContentVersionId: contentId },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        activeKey: `character-video:${characterId}`,
      },
    });
    await prisma.characterRevision.create({
      data: {
        id: revisionId,
        projectId,
        revision: 1,
        characterContentVersionId: contentId,
        projectSnapshot: {},
        createdById: actorId,
      },
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: publishedPrimaryAssetId,
          ownerId: actorId,
          characterId,
          type: "image",
          url: `https://assets.example/${publishedPrimaryAssetId}.webp`,
          storageKey: `tests/${publishedPrimaryAssetId}.webp`,
          contentType: "image/webp",
          width: 768,
          height: 1152,
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: sourceAssetId,
          ownerId: actorId,
          characterId,
          type: "image",
          url: `https://assets.example/${sourceAssetId}.webp`,
          storageKey: `tests/${sourceAssetId}.webp`,
          contentType: "image/webp",
          width: 768,
          height: 1152,
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: otherSourceAssetId,
          ownerId: actorId,
          characterId: otherCharacterId,
          type: "image",
          url: `https://assets.example/${otherSourceAssetId}.webp`,
          storageKey: `tests/${otherSourceAssetId}.webp`,
          contentType: "image/webp",
          width: 768,
          height: 1152,
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });
    await prisma.character.update({
      where: { id: characterId },
      data: { imageAssetId: publishedPrimaryAssetId },
    });
  });

  afterAll(async () => {
    const entries = await prisma.characterMediaLibraryEntry.findMany({ where: { characterId } });
    await prisma.characterMediaLibraryEntry.deleteMany({ where: { characterId } });
    for (const entry of entries) {
      await providers.blob.delete({ key: entry.storageKey });
      if (entry.thumbnailKey) await providers.blob.delete({ key: entry.thumbnailKey });
    }
    for (const video of deliveredVideos) await providers.blob.delete({ key: video.key });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: deliveredVideos.map(video => video.id) } } });
    for (const id of [publishedPrimaryAssetId, sourceAssetId, otherSourceAssetId]) {
      await providers.blob.delete({ key: `tests/${id}.webp` });
    }
    const items = await prisma.contentProductionItem.findMany({
      where: { batchId: { in: batchIds } },
      select: { jobId: true },
    });
    const jobIds = items.flatMap((item) => item.jobId ? [item.jobId] : []);
    await purgeQueuedGenerationJobs(jobIds);
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: batchIds } },
    });
    await prisma.generationAttemptEvent.deleteMany({
      where: { attempt: { requestId: { in: jobIds } } },
    });
    await prisma.generationAttempt.deleteMany({
      where: { requestId: { in: jobIds } },
    });
    await prisma.contentProductionBatch.deleteMany({
      where: { id: { in: batchIds } },
    });
    await prisma.generationJob.deleteMany({
      where: { id: { in: jobIds } },
    });
    await prisma.controlPlaneCommand.deleteMany({
      where: { actorId },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.characterServing.deleteMany({ where: { characterId } });
    await prisma.characterRelease.deleteMany({ where: { projectId } });
    await prisma.characterVisualProfile.deleteMany({ where: { characterId } });
    await prisma.mediaAsset.deleteMany({
      where: {
        id: {
          in: [
            publishedPrimaryAssetId,
            sourceAssetId,
            otherSourceAssetId,
          ],
        },
      },
    });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({
      where: { id: { in: [characterId, otherCharacterId] } },
    });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("exposes every operational Character image as a video source", async () => {
    const workspace = await getCharacterWorkspace(characterId);
    expect(workspace.visual.videoSources).toContainEqual(
      expect.objectContaining({
        mediaAssetId: sourceAssetId,
        available: true,
      }),
    );
  });

  it("dispatches an exact default-recipe job from an operational image that is not the published primary", async () => {
    const response = await createCreativeRun(request());
    expect(response.status).toBe(202);
    const payload = await response.json();
    const batchId = payload.data.batch.id as string;
    batchIds.push(batchId);

    const item = await prisma.contentProductionItem.findFirstOrThrow({
      where: { batchId },
      include: { job: true },
    });
    const attempts = await prisma.generationAttempt.findMany({
      where: { requestId: item.jobId ?? "" },
    });
    expect(item.job).toMatchObject({
      mode: "video",
      characterId,
      profileId: characterVideoProductionRecipe.profileKey,
      profileVersion: characterVideoProductionRecipe.recipeVersion,
      recipeId: "template_video_character_default",
      orientation: characterVideoProductionRecipe.orientation,
      outputCount: 1,
      model: characterVideoProductionRecipe.workflowKey,
      provider: "comfyui",
    });
    expect(item.job?.controls).toMatchObject({
      sourceImageAssetId: sourceAssetId,
      seconds: characterVideoProductionRecipe.durationSeconds,
      width: characterVideoProductionRecipe.width,
      height: characterVideoProductionRecipe.height,
    });
    expect(item.job?.referenceAssetIds).toEqual([sourceAssetId]);
    expect(item.job?.referenceManifest).toEqual([
      expect.objectContaining({
        mediaAssetId: sourceAssetId,
        role: "source_image",
      }),
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      profileKey: characterVideoProductionRecipe.profileKey,
      profileVersion: characterVideoProductionRecipe.recipeVersion,
      workflowKey: characterVideoProductionRecipe.workflowKey,
      workflowVersion: characterVideoProductionRecipe.workflowVersion,
    });
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({
      where: {
        id: `creative_initial_${batchId}_${item.id}`,
      },
    })).toMatchObject({
      status: "delivered",
      lastError: null,
    });
  });

  it("rejects a source image owned by another Character without creating a Run", async () => {
    const response = await createCreativeRun(request(
      { referenceAssetIds: [otherSourceAssetId] },
      `character-video-other-source-${suffix}`,
    ));
    expect(response.status).toBe(400);
    expect(await prisma.contentProductionBatch.count({
      where: {
        targetId: characterId,
        purpose: "character_video",
        id: { notIn: batchIds },
      },
    })).toBe(0);
  });

  it("pins the live Release anchor before video generation with a newer production identity, and rejects ambiguous or unsealed anchors", async () => {
    const anchor = await providers.blob.getPrivate!({ key: `tests/${publishedPrimaryAssetId}.webp` });
    if (!anchor.ok) throw new Error("Video identity fixture is missing its source bytes");
    const sha256 = createHash("sha256").update(anchor.data.body).digest("hex");
    const values = { characterId, version: 1, status: "active", style: "realistic", identityPrompt: "Mara",
      negativeIdentityPrompt: null, faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {},
      anchorAssetIds: [publishedPrimaryAssetId], adapterRefs: {}, createdFrom: "test" };
    const { visual, references } = await prisma.$transaction(async tx => {
      for (const assetId of [publishedPrimaryAssetId, sourceAssetId]) {
        await tx.mediaAsset.update({ where: { id: assetId }, data: { metadata: {
          source: "admin_asset_upload", synthetic: false, sha256, purpose: "character_library",
          uploadAuthority: { schemaVersion: OPERATOR_UPLOAD_AUTHORITY_SCHEMA, kind: "operator_upload", assetId, uploadedById: actorId, sha256 },
        } } });
      }
      const profile = await tx.characterVisualProfile.create({ data: { ...values, immutableHash: characterVisualProfileSnapshotHash(values) } });
      const referenceSet = await createReferenceSetRevision(tx, profile, "test", [
        { mediaAssetId: publishedPrimaryAssetId, position: 0, role: "identity_anchor", weight: 1, selectionReason: "fixture" },
      ]);
      return { visual: profile, references: referenceSet };
    });
    const snapshot = {
      projectId, revisionId, characterContentVersionId: contentId,
      visualProfileId: visual.id, visualProfileVersion: visual.version, referenceSetRevisionId: references.id,
      generationProvenance: { visualAuthority: { visualProfileHash: visual.immutableHash, referenceSetHash: references.snapshotHash } },
      releasePlacementManifest: {},
    };
    const release = await prisma.characterRelease.create({ data: {
      ...snapshot, snapshotHash: characterReleaseSnapshotHash(snapshot), status: "published", readiness: "ready", publishedAt: new Date(),
    } });
    await prisma.characterServing.create({ data: { characterId, state: "live", currentReleaseId: release.id } });
    const nextVisual = await prisma.$transaction(async tx => {
      await tx.characterVisualProfile.update({ where: { id: visual.id }, data: { status: "archived" } });
      const next = { ...values, version: 2, anchorAssetIds: [sourceAssetId], identityPrompt: "A distinct Mara appearance" };
      const production = await tx.characterVisualProfile.create({ data: { ...next, immutableHash: characterVisualProfileSnapshotHash(next) } });
      await createReferenceSetRevision(tx, production, "test", [
        { mediaAssetId: sourceAssetId, position: 0, role: "identity_anchor", weight: 1, selectionReason: "production v2" },
      ]);
      // The live Release keeps its sealed revision even after a later revision replaces it.
      await createReferenceSetRevision(tx, visual, "test", [
        { mediaAssetId: sourceAssetId, position: 0, role: "identity_anchor", weight: 1, selectionReason: "later revision" },
      ]);
      return production;
    });

    const { batchId, job, mediaAssetId } = await completeVideoFromSource(publishedPrimaryAssetId, "live-v1");
    expect(job.referenceAssetIds).toEqual([publishedPrimaryAssetId]);
    expect(job.sourceMeta).toMatchObject({ videoSourceIdentity: { visualProfileId: visual.id, visualProfileVersion: visual.version, sourceSha256: sha256 } });

    vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_URL", "http://embedding.test.invalid/v1");
    vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_MODEL", "fixture-embedding");
    vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_DIMENSIONS", "2");
    const embedding = vi.spyOn(libraryModels, "embedMediaText").mockResolvedValue({ model: "fixture-embedding", dimensions: 2, vector: [1, 0] });
    try {
      await expect(createCharacterMediaLibraryEntry({ characterId, actor: { id: actorId, role: "admin" },
        idempotencyKey: randomUUID(), requestId: randomUUID(), body: { sourceAssetId: mediaAssetId,
          expectedVisualProfileId: visual.id, expectedVisualProfileVersion: visual.version,
          description: "A reviewable short video", facts: [], absentFacts: [], nudity: "none", status: "published" },
      })).resolves.toMatchObject({ entry: { mediaType: "video", sourceAssetId: mediaAssetId, status: "published", visualProfileId: visual.id } });
      expect(await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: batchId } })).toMatchObject({ lifecycleState: "closed", status: "completed" });
      await expect(createCharacterMediaLibraryEntry({ characterId, actor: { id: actorId, role: "admin" },
        idempotencyKey: randomUUID(), requestId: randomUUID(), body: { sourceAssetId: mediaAssetId,
          expectedVisualProfileId: nextVisual.id, expectedVisualProfileVersion: nextVisual.version,
          description: "The original short video", facts: [], absentFacts: [], nudity: "none", status: "published" },
      })).rejects.toMatchObject({ code: "forbidden" });

      for (const authority of ["ambiguous", "missing anchor", "unsealed reference", "unsealed Release"] as const) {
        await prisma.$transaction(async tx => {
          await createReferenceSetRevision(tx, nextVisual, "test", [{
            mediaAssetId: authority === "ambiguous" ? publishedPrimaryAssetId : sourceAssetId,
            position: 0, role: "identity_anchor", weight: 1, selectionReason: authority,
          }]);
          await tx.referenceSetRevision.update({ where: { id: references.id }, data: {
            snapshotHash: authority === "unsealed reference" ? "invalid" : references.snapshotHash,
          } });
          await tx.characterRelease.update({ where: { id: release.id }, data: {
            snapshotHash: authority === "unsealed Release" ? "invalid" : release.snapshotHash,
            status: authority === "missing anchor" ? "withdrawn" : "published",
          } });
        });
        const result = await completeVideoFromSource(publishedPrimaryAssetId, authority.replaceAll(" ", "-"));
        expect(result.job.sourceMeta, authority).not.toHaveProperty("videoSourceIdentity");
        for (const identity of [visual, nextVisual]) {
          await expect(createCharacterMediaLibraryEntry({ characterId, actor: { id: actorId, role: "admin" },
            idempotencyKey: randomUUID(), requestId: randomUUID(), body: { sourceAssetId: result.mediaAssetId,
              expectedVisualProfileId: identity.id, expectedVisualProfileVersion: identity.version,
              description: "An unqualified video preview", facts: [], absentFacts: [], nudity: "none", status: "published" },
          })).rejects.toMatchObject({ code: authority === "missing anchor" && identity.id === visual.id ? "conflict" : "forbidden" });
        }
      }
    } finally {
      embedding.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
