import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { publicCharacterAudienceWhere } from "./public-content-audience";
import {
  api,
  createCharacter,
  createUser,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";

const P = "zt-make-private-";
const userId = `${P}owner`;
const characterId = `${P}character`;
const projectId = `${P}project`;
const releaseId = `${P}release`;
const validationRunId = `${P}validation`;
const characterName = "Make Private Regression";
const assetIds = {
  avatar: `${P}avatar`,
  hero: `${P}hero`,
  chat: `${P}chat`,
};

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: userId, dataClass: "customer" });
  await createCharacter({
    id: characterId,
    creatorId: userId,
    source: "user",
    name: characterName,
    visibility: "public",
    status: "approved",
  });
  await prisma.$transaction(async (tx) => {
    await tx.mediaAsset.createMany({
      data: Object.entries(assetIds).map(([slot, id]) => ({
        id,
        ownerId: userId,
        characterId,
        type: "image",
        url: `/user-content/${id}/content.webp`,
        thumbnailUrl: `/user-content/${id}/thumbnail.webp`,
        storageKey: `tests/${id}/content.webp`,
        visibility: "public_pack",
        safetyStatus: "passed",
        metadata: { slot, synthetic: false, provider: "pipeline" },
      })),
    });
    await tx.character.update({
      where: { id: characterId },
      data: { imageAssetId: assetIds.avatar },
    });
    await tx.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "live_management",
        audience: {},
        successCriteria: [],
      },
    });
    await tx.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `${releaseId}:revision`,
        characterContentVersionId: `${releaseId}:content`,
        generationProvenance: {
          schemaVersion: "character-release-generation-provenance-v2",
          policyVersion: "character-release-policy-v2",
          requiredReleaseRoute: {
            routeFingerprint: `${releaseId}:route`,
            matrixKey: "make-private-test",
            generationProfileKey: "make-private-profile",
            generationProfileVersion: 1,
            workflowKey: "make-private-workflow",
            workflowVersion: 1,
          },
          placements: [
            { slotKey: "character_avatar", assetId: assetIds.avatar, provider: "pipeline" },
            { slotKey: "character_hero", assetId: assetIds.hero, provider: "pipeline" },
            { slotKey: "character_chat", assetId: assetIds.chat, provider: "pipeline" },
          ],
        },
        releasePlacementManifest: {
          schemaVersion: 2,
          placements: Object.entries(assetIds).map(([slot, assetId]) => ({
            slotKey: `character_${slot}`,
            assetId,
            slotVersion: 1,
            runId: `${releaseId}:${slot}:run`,
            itemId: `${releaseId}:${slot}:item`,
            reviewDecisionId: `${releaseId}:${slot}:decision`,
            generationJobId: `${releaseId}:${slot}:job`,
          })),
        },
        snapshotHash: `${releaseId}:snapshot`,
        readiness: "ready",
        status: "published",
        publishedAt: new Date(),
      },
    });
    await tx.releaseValidationRun.create({
      data: {
        id: validationRunId,
        releaseId,
        snapshotHash: `${releaseId}:snapshot`,
        policyVersion: "character-release-policy-v2",
        result: "passed",
        finishedAt: new Date(),
      },
    });
    await tx.publicCatalogQualification.create({
      data: {
        id: `${P}qualification`,
        releaseId,
        releaseSnapshotHash: `${releaseId}:snapshot`,
        kind: "generated_release",
        validationRunId,
        evidence: {
          schemaVersion: "public-catalog-qualification-v1",
          policyVersion: "character-release-policy-v2",
        },
      },
    });
    await tx.characterServing.create({
      data: {
        id: `${P}serving`,
        characterId,
        currentReleaseId: releaseId,
        scheduledReleaseId: null,
        scheduledAt: null,
        state: "live",
      },
    });
  });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("creator makes a live Character private", () => {
  it("deactivates Serving and projects one truthful private state", async () => {
    await expect(
      prisma.character.count({
        where: { AND: [publicCharacterAudienceWhere, { id: characterId }] },
      }),
    ).resolves.toBe(1);
    const before = await api("GET", "characters", {
      ageGate: true,
      query: { q: characterName },
    });
    expectOk(before);
    expect(before.data.items).toEqual([
      expect.objectContaining({
        id: characterId,
        visibility: "public",
        publicationState: "live",
      }),
    ]);

    const updated = await api("PATCH", `characters/${characterId}`, {
      userId,
      ageGate: true,
      body: { visibility: "private" },
    });
    expectOk(updated);
    expect(updated.data.character).toMatchObject({
      id: characterId,
      visibility: "private",
      publicationState: "not_public",
    });
    await expect(
      prisma.characterServing.findUniqueOrThrow({ where: { characterId } }),
    ).resolves.toMatchObject({
      state: "paused",
      currentReleaseId: releaseId,
      scheduledReleaseId: null,
      scheduledAt: null,
      version: 2,
    });

    const created = await api("GET", "library/created", {
      userId,
      ageGate: true,
    });
    expectOk(created);
    expect(created.data.items).toEqual([
      expect.objectContaining({
        id: characterId,
        visibility: "private",
        publicationState: "not_public",
      }),
    ]);

    const after = await api("GET", "characters", {
      ageGate: true,
      query: { q: characterName },
    });
    expectOk(after);
    expect(after.data.items).toEqual([]);
  });

  it("cancels a scheduled first Release before making the Character private", async () => {
    const scheduledAt = new Date(Date.now() + 60_000);
    const servingBefore = await prisma.characterServing.update({
      where: { characterId },
      data: {
        state: "inactive",
        currentReleaseId: null,
        scheduledReleaseId: releaseId,
        scheduledAt,
        version: 7,
      },
    });
    await prisma.character.update({
      where: { id: characterId },
      data: { visibility: "public", status: "approved" },
    });

    const updated = await api("PATCH", `characters/${characterId}`, {
      userId,
      ageGate: true,
      body: { visibility: "private" },
    });
    expectOk(updated);
    expect(updated.data.character).toMatchObject({
      id: characterId,
      visibility: "private",
      publicationState: "not_public",
    });
    await expect(
      prisma.characterServing.findUniqueOrThrow({ where: { characterId } }),
    ).resolves.toMatchObject({
      state: "inactive",
      currentReleaseId: null,
      scheduledReleaseId: null,
      scheduledAt: null,
      version: servingBefore.version + 1,
    });
  });
});
