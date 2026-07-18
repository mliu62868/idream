import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import type { Prisma } from "@prisma/client";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  POST as repairImageReadinessRoute,
} from "@/app/api/v2/admin/characters/[id]/image-readiness/repair/route";
import {
  hydratedImageReferenceInputs,
  imageReferenceInputsForGenerationJob,
} from "@/server/ai/reference-images";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import {
  ensureOfficialEditorialCatalogQualification,
} from "@/server/modules/ourdream/public-catalog-qualification";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  prepareCharacterImageReadinessSource,
  repairCharacterImageReadiness,
} from "./image-readiness-repair";
import { getCharacterWorkspace } from "./workspace";

describe("Character image-readiness repair", () => {
  const suffix = randomUUID();
  const actorId = `image-readiness-admin-${suffix}`;
  const characterId = `image-readiness-character-${suffix}`;
  const assetId = `image-readiness-asset-${suffix}`;
  const seedSource = `image-readiness-seed-${suffix}`;
  const idempotencyKey = `image-readiness-repair-${suffix}`;
  let releaseId = "";
  let projectId = "";

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@idream.internal`,
        role: "admin",
        status: "active",
        dataClass: "internal",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        ownerId: actorId,
        type: "image",
        url: "/images/ourdream/card-alexa-reeves.webp",
        thumbnailUrl: "/images/ourdream/card-alexa-reeves.webp",
        contentType: "image/webp",
        visibility: "public_pack",
        safetyStatus: "passed",
        metadata: {
          seedSource,
          ownership: "platform_official",
          synthetic: false,
        },
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: actorId,
        name: "Editorial image readiness fixture",
        age: 29,
        description: "A precise live editorial companion portrait.",
        systemPrompt: "Stay in the editorial persona.",
        source: "official",
        status: "approved",
        visibility: "public",
        style: "realistic",
        gender: "female",
        imageAssetId: assetId,
        appearance: {
          identityAnchor: "Recognizable editorial companion",
          stableTraits: ["warm brown eyes", "dark wavy hair"],
          referenceDirection: "Natural window light",
          style: "realistic",
        },
        advancedDetails: { firstMessage: "Hello." },
      },
    });
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: { characterId },
    });
    const qualified = await ensureOfficialEditorialCatalogQualification(
      prisma,
      {
        characterId,
        expectedAssetId: assetId,
        expectedSeedSource: seedSource,
      },
    );
    releaseId = qualified.releaseId;
    const project = await prisma.characterProject.findFirstOrThrow({
      where: { characterId },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    const materializedAsset = await prisma.mediaAsset.findUnique({
      where: { id: assetId },
      select: { storageKey: true },
    });
    const profiles = await prisma.characterVisualProfile.findMany({
      where: { characterId },
      select: { id: true },
    });
    await prisma.referenceCandidate.deleteMany({
      where: { visualProfileId: { in: profiles.map((profile) => profile.id) } },
    });
    await prisma.characterVisualProfile.deleteMany({ where: { characterId } });
    await prisma.mainOutboxEvent.deleteMany({
      where: {
        OR: [
          { aggregateId: characterId },
          { aggregateId: projectId },
          { aggregateId: releaseId },
        ],
      },
    });
    await prisma.adminCollaborationActivity.deleteMany({
      where: { targetType: "character_project", targetId: projectId },
    });
    await prisma.adminAuditLog.deleteMany({
      where: {
        OR: [
          { targetId: projectId },
          { targetId: releaseId },
        ],
      },
    });
    await prisma.controlPlaneCommand.deleteMany({
      where: {
        actorId,
        commandType: "character.image_readiness.repair",
      },
    });
    await prisma.releaseMonitor.deleteMany({ where: { releaseId } });
    await prisma.characterReleaseEvent.deleteMany({ where: { releaseId } });
    await prisma.publicCatalogQualification.deleteMany({
      where: { releaseId },
    });
    await prisma.characterServing.deleteMany({ where: { characterId } });
    await prisma.characterRelease.deleteMany({ where: { id: releaseId } });
    await prisma.characterRevision.deleteMany({ where: { projectId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: assetId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
    if (materializedAsset?.storageKey) {
      await rm(resolveLocalBlobPath(materializedAsset.storageKey), {
        force: true,
      });
    }
  });

  it("does not advertise automatic repair for a missing bundled portrait", async () => {
    const asset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: assetId },
      select: { url: true, thumbnailUrl: true },
    });
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        url: `/images/ourdream/missing-${suffix}.webp`,
        thumbnailUrl: `/images/ourdream/missing-${suffix}.webp`,
      },
    });
    try {
      const workspace = await getCharacterWorkspace(characterId);
      expect(workspace.visual.imageReadiness).toMatchObject({
        state: "manual_review_required",
        repair: null,
      });
    } finally {
      await prisma.mediaAsset.update({
        where: { id: assetId },
        data: asset,
      });
    }
  });

  it("rejects an old readiness fingerprint when the same MediaAsset changes", async () => {
    const before = await getCharacterWorkspace(characterId);
    const original = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: assetId },
      select: { metadata: true },
    });
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        metadata: {
          ...(original.metadata as Record<string, unknown>),
          authorityRevision: "changed-after-workspace-load",
        },
      },
    });
    try {
      const response = await repairImageReadinessRoute(new Request(
        `http://localhost/api/v2/admin/characters/${characterId}/image-readiness/repair`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `stale-source-${suffix}`,
            "if-match": String(before.project.version),
            "x-idream-user-id": actorId,
            "x-idream-role": "admin",
          },
          body: JSON.stringify({
            entityVersion: before.project.version,
            expectedReadinessFingerprint:
              before.visual.imageReadiness?.fingerprint ?? "",
            reason: "Prove the exact source asset is pinned",
            confirmation: `PREPARE IMAGE PRODUCTION ${characterId}`,
          }),
        },
      ), {
        params: Promise.resolve({ id: characterId }),
      });
      expect(response.status).toBe(409);
      expect(await prisma.mediaAsset.findUniqueOrThrow({
        where: { id: assetId },
        select: { storageKey: true },
      })).toEqual({ storageKey: null });
      expect(await prisma.characterVisualProfile.count({
        where: { characterId },
      })).toBe(0);
      expect(await prisma.characterProject.findUniqueOrThrow({
        where: { id: projectId },
        select: { version: true },
      })).toEqual({ version: before.project.version });
    } finally {
      await prisma.mediaAsset.update({
        where: { id: assetId },
        data: { metadata: toInputJson(original.metadata) },
      });
    }
  });

  it("rejects prepared bytes when source authority changes before the locked transaction", async () => {
    const prepared = await prepareCharacterImageReadinessSource(
      characterId,
    );
    const original = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: assetId },
      select: { metadata: true },
    });
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        metadata: {
          ...(original.metadata as Record<string, unknown>),
          authorityRevision: "changed-after-blob-prepare",
        },
      },
    });
    try {
      const current = await getCharacterWorkspace(characterId);
      await expect(prisma.$transaction((tx) =>
        repairCharacterImageReadiness({
          characterId,
          actor: { id: actorId, role: "admin" },
          requestId: `prepared-source-race-${suffix}`,
          request: {
            entityVersion: current.project.version,
            expectedReadinessFingerprint:
              current.visual.imageReadiness?.fingerprint ?? "",
            reason: "Reject bytes prepared from a different source authority",
            confirmation: `PREPARE IMAGE PRODUCTION ${characterId}`,
          },
          prepared,
          tx,
        })
      )).rejects.toMatchObject({ status: 409 });
      expect(await prisma.mediaAsset.findUniqueOrThrow({
        where: { id: assetId },
        select: { storageKey: true },
      })).toEqual({ storageKey: null });
      expect(await prisma.characterVisualProfile.count({
        where: { characterId },
      })).toBe(0);
    } finally {
      await prisma.mediaAsset.update({
        where: { id: assetId },
        data: { metadata: toInputJson(original.metadata) },
      });
    }
  });

  it("rolls back DB authority when receipt persistence fails while keeping reusable prepared bytes", async () => {
    const before = await getCharacterWorkspace(characterId);
    const prepared = await prepareCharacterImageReadinessSource(
      characterId,
    );
    expect(prepared.storageKey).toMatch(
      /^official-editorial\/.+\/[a-f0-9]{64}\.webp$/,
    );
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_image_readiness_receipt() RETURNS trigger AS $$
      BEGIN
        IF NEW."commandType" = 'character.image_readiness.repair' AND NEW."targetId" = '${characterId}' THEN
          RAISE EXCEPTION 'injected image-readiness receipt failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_image_readiness_receipt_trigger
      BEFORE INSERT ON "control_plane_commands"
      FOR EACH ROW EXECUTE FUNCTION fail_image_readiness_receipt();
    `);
    try {
      await expect(repairImageReadinessRoute(new Request(
        `http://localhost/api/v2/admin/characters/${characterId}/image-readiness/repair`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `receipt-rollback-${suffix}`,
            "if-match": String(before.project.version),
            "x-idream-user-id": actorId,
            "x-idream-role": "admin",
          },
          body: JSON.stringify({
            entityVersion: before.project.version,
            expectedReadinessFingerprint:
              before.visual.imageReadiness?.fingerprint ?? "",
            reason: "Exercise receipt rollback after blob preparation",
            confirmation: `PREPARE IMAGE PRODUCTION ${characterId}`,
          }),
        },
      ), {
        params: Promise.resolve({ id: characterId }),
      })).rejects.toThrow("injected image-readiness receipt failure");
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS fail_image_readiness_receipt_trigger ON "control_plane_commands";
        DROP FUNCTION IF EXISTS fail_image_readiness_receipt();
      `);
    }
    await expect(readFile(resolveLocalBlobPath(
      prepared.storageKey ?? "",
    ))).resolves.not.toHaveLength(0);
    await expect(prisma.mediaAsset.findUniqueOrThrow({
      where: { id: assetId },
      select: { storageKey: true },
    })).resolves.toEqual({ storageKey: null });
    await expect(prisma.characterVisualProfile.count({
      where: { characterId },
    })).resolves.toBe(0);
    await expect(prisma.referenceSetRevision.count({
      where: { visualProfile: { characterId } },
    })).resolves.toBe(0);
    await expect(prisma.characterProject.findUniqueOrThrow({
      where: { id: projectId },
      select: { version: true },
    })).resolves.toEqual({ version: before.project.version });
    await expect(prisma.controlPlaneCommand.count({
      where: {
        actorId,
        idempotencyKey: `receipt-rollback-${suffix}`,
      },
    })).resolves.toBe(0);
  });

  it("fails closed when a standalone draft cover already owns image authority", async () => {
    const before = await getCharacterWorkspace(characterId);
    expect(before.visual.imageReadiness?.repair).toMatchObject({
      kind: "adopt_live_portrait",
      sourceAssetId: assetId,
    });
    await prisma.characterProject.update({
      where: { id: projectId },
      data: { draftImageAssetId: assetId },
    });
    try {
      const current = await getCharacterWorkspace(characterId);
      expect(current.visual.imageReadiness).toMatchObject({
        state: "manual_review_required",
        repair: null,
      });
      expect(current.visual.imageReadiness?.fingerprint).not.toBe(
        before.visual.imageReadiness?.fingerprint,
      );
      const prepared = await prepareCharacterImageReadinessSource(
        characterId,
      );
      await expect(prisma.$transaction((tx) =>
        repairCharacterImageReadiness({
          characterId,
          actor: { id: actorId, role: "admin" },
          requestId: `draft-cover-conflict-${suffix}`,
          request: {
            entityVersion: current.project.version,
            expectedReadinessFingerprint:
              current.visual.imageReadiness?.fingerprint ?? "",
            reason: "Preserve the existing standalone draft cover authority",
            confirmation: `PREPARE IMAGE PRODUCTION ${characterId}`,
          },
          prepared,
          tx,
        })
      )).rejects.toMatchObject({ status: 409 });
      await expect(prisma.characterProject.findUniqueOrThrow({
        where: { id: projectId },
        select: {
          draftImageAssetId: true,
          draftAssetPack: true,
          version: true,
        },
      })).resolves.toEqual({
        draftImageAssetId: assetId,
        draftAssetPack: {},
        version: before.project.version,
      });
      await expect(prisma.characterVisualProfile.count({
        where: { characterId },
      })).resolves.toBe(0);
      await expect(prisma.mediaAsset.findUniqueOrThrow({
        where: { id: assetId },
        select: { storageKey: true },
      })).resolves.toEqual({ storageKey: null });
    } finally {
      await prisma.characterProject.update({
        where: { id: projectId },
        data: { draftImageAssetId: null },
      });
    }
  });

  it("atomically adopts the exact live portrait without changing the live Release", async () => {
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: { contentType: "image/png" },
    });
    const beforeWorkspace = await getCharacterWorkspace(characterId);
    expect(beforeWorkspace.visual.imageReadiness).toMatchObject({
      state: "repairable",
      repair: {
        kind: "adopt_live_portrait",
        sourceAssetId: assetId,
      },
    });
    const beforeRelease = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: releaseId },
    });
    const beforeServing = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId },
    });
    const requestBody = {
      entityVersion: beforeWorkspace.project.version,
      expectedReadinessFingerprint:
        beforeWorkspace.visual.imageReadiness?.fingerprint ?? "",
      reason:
        "Adopt the exact live editorial portrait for future image production",
      confirmation: `PREPARE IMAGE PRODUCTION ${characterId}`,
    };
    const request = () => new Request(
      `http://localhost/api/v2/admin/characters/${characterId}/image-readiness/repair`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "if-match": String(beforeWorkspace.project.version),
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify(requestBody),
      },
    );
    const response = await repairImageReadinessRoute(request(), {
      params: Promise.resolve({ id: characterId }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      data: {
        characterId,
        projectVersion: beforeWorkspace.project.version + 1,
        action: "adopted_live_portrait",
        replayed: false,
      },
    });
    expect(["ready", "route_pending"]).toContain(payload.data.state);

    const profile = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
    });
    expect(profile).toMatchObject({
      evidenceState: "editorial_seed_adopted",
      anchorAssetIds: [assetId],
      referenceAssetIds: [assetId],
    });
    expect(profile.immutableHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(profile.faceTraits as object)).not.toHaveLength(0);
    const referenceSet = await prisma.referenceSetRevision.findFirstOrThrow({
      where: { visualProfileId: profile.id, status: "active" },
      include: { references: true },
    });
    expect(referenceSet.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(referenceSet.references).toMatchObject([
      { mediaAssetId: assetId, role: "primary_face" },
    ]);
    const materializedAsset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: assetId },
      select: { contentType: true, storageKey: true },
    });
    expect(materializedAsset.storageKey).toMatch(
      /^official-editorial\/.+\/[a-f0-9]{64}\.webp$/,
    );
    expect(materializedAsset.contentType).toBe("image/webp");
    await expect(readFile(resolveLocalBlobPath(
      materializedAsset.storageKey ?? "",
    ))).resolves.not.toHaveLength(0);
    const dispatchReferences = await imageReferenceInputsForGenerationJob({
      userId: actorId,
      characterId,
      controls: {},
      referenceAssetIds: [assetId],
      referenceManifest: [{
        mediaAssetId: assetId,
        role: "primary_face",
      }],
    });
    expect(dispatchReferences).toMatchObject([{
      assetId,
      role: "identity_anchor",
      storageKey: materializedAsset.storageKey,
    }]);
    const hydratedReferences = await hydratedImageReferenceInputs(
      dispatchReferences,
      providers.blob,
    );
    expect(hydratedReferences[0]?.b64Json?.length).toBeGreaterThan(0);
    const project = await prisma.characterProject.findUniqueOrThrow({
      where: { id: projectId },
    });
    expect(project.draftAssetPack).toEqual({});
    expect(project.draftImageAssetId).toBeNull();
    expect(await prisma.characterRelease.findUniqueOrThrow({
      where: { id: releaseId },
    })).toEqual(beforeRelease);
    expect(await prisma.characterServing.findUniqueOrThrow({
      where: { characterId },
    })).toEqual(beforeServing);

    const afterWorkspace = await getCharacterWorkspace(characterId);
    expect(afterWorkspace.visual.readiness.blockers.map((blocker) =>
      blocker.code
    )).not.toEqual(expect.arrayContaining([
      "visual_identity_missing",
      "visual_anchor_missing",
      "visual_traits_incomplete",
      "visual_identity_unsealed",
      "reference_set_not_active",
      "reference_set_unsealed",
      "reference_assets_unavailable",
    ]));
    expect(afterWorkspace.visual.imageReadiness?.state).toBe(
      payload.data.state === "ready" ? "ready" : "route_pending",
    );
    await expect(prisma.mainOutboxEvent.findFirstOrThrow({
      where: {
        aggregateId: characterId,
        eventType: "character.image_readiness.repaired.v1",
      },
    })).resolves.toMatchObject({
      status: "delivered",
      deliveredAt: expect.any(Date),
    });

    const replay = await repairImageReadinessRoute(request(), {
      params: Promise.resolve({ id: characterId }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: {
        visualProfileId: profile.id,
        referenceSetRevisionId: referenceSet.id,
        replayed: true,
      },
    });
    expect(await prisma.characterVisualProfile.count({
      where: { characterId },
    })).toBe(1);
  });

  it("fails closed when the portrait changes before the authority lock is acquired", async () => {
    const findUnique = vi.fn()
      .mockResolvedValueOnce({ imageAssetId: "portrait-before-lock" })
      .mockResolvedValueOnce({ imageAssetId: "portrait-after-lock" });
    const findFirst = vi.fn();
    const executeRaw = vi.fn().mockResolvedValue(1);
    const tx = {
      $executeRaw: executeRaw,
      character: { findUnique },
      characterProject: { findFirst },
    } as unknown as Prisma.TransactionClient;

    await expect(repairCharacterImageReadiness({
      characterId: "portrait-race-character",
      actor: { id: actorId, role: "admin" },
      requestId: "portrait-race-request",
      request: {
        entityVersion: 1,
        expectedReadinessFingerprint: "portrait-race-fingerprint",
        reason: "Prove a changed portrait cannot be consumed unlocked",
        confirmation:
          "PREPARE IMAGE PRODUCTION portrait-race-character",
      },
      prepared: {} as never,
      tx,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        expectedAssetId: "portrait-before-lock",
        currentAssetId: "portrait-after-lock",
      },
    });
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
