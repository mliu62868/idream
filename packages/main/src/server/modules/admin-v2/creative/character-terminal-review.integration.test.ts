import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { recordCreativeReviewDecision } from "./workflow";
import {
  createCharacter,
  createUser,
  purgeTestData,
} from "@/server/test/helpers";

const prefix = "character-terminal-review-";
const actorId = `${prefix}admin`;
const characterId = `${prefix}character`;
const profileId = `${prefix}profile`;
const profileAnchorId = `${prefix}profile-anchor`;

async function createApprovedCandidate(label: string) {
  const runId = `${prefix}${label}-run`;
  const itemId = `${prefix}${label}-item`;
  const assetId = `${prefix}${label}-asset`;
  await prisma.mediaAsset.create({
    data: {
      id: assetId,
      ownerId: actorId,
      characterId,
      type: "image",
      url: `/assets/${assetId}.webp`,
      visibility: "private",
      safetyStatus: "passed",
      metadata: {},
    },
  });
  await prisma.contentProductionBatch.create({
    data: {
      id: runId,
      title: `Unused approved ${label}`,
      purpose: "character_hero",
      targetType: "character",
      targetId: characterId,
      presetIds: [],
      count: 1,
      totalItems: 1,
      completedItems: 1,
      approvedItems: 1,
      status: "completed",
      lifecycleState: "closed",
      workflowStage: "review",
      verificationState: "pending",
      version: 1,
      createdById: actorId,
      items: {
        create: {
          id: itemId,
          itemIndex: 0,
          mediaAssetId: assetId,
          status: "approved",
          tags: [],
        },
      },
    },
  });
  const decision = await prisma.creativeReviewDecision.create({
    data: {
      id: `${prefix}${label}-approval`,
      runItemId: itemId,
      artifactId: assetId,
      decision: "approved",
      identityConsistency: "passed",
      score: 94,
      reason: "Visible review approved this candidate",
      evidence: {
        quality: {
          artifactFree: true,
          singleSubject: true,
          intentMatch: true,
          noVisibleText: true,
        },
      },
      reviewerId: actorId,
    },
  });
  return { runId, itemId, assetId, decision };
}

beforeAll(async () => {
  await purgeTestData(prefix);
  await createUser({ id: actorId, role: "admin", dataClass: "internal" });
  await createCharacter({
    id: characterId,
    creatorId: actorId,
    source: "official",
    visibility: "private",
    status: "approved",
  });
  await prisma.mediaAsset.create({
    data: {
      id: profileAnchorId,
      ownerId: actorId,
      characterId,
      type: "image",
      url: `/assets/${profileAnchorId}.webp`,
      visibility: "private",
      safetyStatus: "passed",
      metadata: {},
    },
  });
  await prisma.characterVisualProfile.create({
    data: {
      id: profileId,
      characterId,
      version: 1,
      status: "active",
      style: "realistic",
      identityPrompt: "same adult character",
      faceTraits: {},
      hairTraits: {},
      bodyTraits: {},
      signatureTraits: {},
      styleTraits: {},
      anchorAssetIds: [profileAnchorId],
      referenceAssetIds: [],
      adapterRefs: {},
      createdFrom: "test",
    },
  });
});

afterAll(async () => {
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

describe("unused approved Character candidate terminal review", () => {
  it("records a CAS-linked superseding rejection for an unused closed candidate", async () => {
    const fixture = await createApprovedCandidate("unused");
    const quality = {
      artifactFree: true,
      singleSubject: true,
      intentMatch: true,
      noVisibleText: true,
    };
    await expect(
      recordCreativeReviewDecision({
        runId: fixture.runId,
        itemId: fixture.itemId,
        actor: { id: actorId, role: "admin" },
        expectedVersion: 1,
        supersedesDecisionId: fixture.decision.id,
        decision: "rejected",
        identityConsistency: "passed",
        score: 94,
        quality,
        reason: "Approved visual evidence remains valid, but this candidate will not be used",
        requestId: `${prefix}unused-terminal`,
      }),
    ).resolves.toMatchObject({ version: 2 });
    const latest = await prisma.creativeReviewDecision.findFirstOrThrow({
      where: { runItemId: fixture.itemId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(latest).toMatchObject({
      decision: "rejected",
      supersedesDecisionId: fixture.decision.id,
      identityConsistency: "passed",
      score: 94,
    });
    expect(latest.evidence).toMatchObject({ quality });
    await expect(
      prisma.contentProductionItem.findUniqueOrThrow({
        where: { id: fixture.itemId },
      }),
    ).resolves.toMatchObject({ status: "rejected" });
  });

  it("blocks the correction while an active Character Look still references the asset", async () => {
    const fixture = await createApprovedCandidate("look-dependent");
    await prisma.characterLook.create({
      data: {
        id: `${prefix}active-look`,
        characterId,
        visualProfileId: profileId,
        ownerId: actorId,
        label: "Dependent Look",
        appearanceDelta: { outfit: "silver dress" },
        referenceAssetId: fixture.assetId,
        status: "active",
        activeKey: `${prefix}active-look-key`,
      },
    });

    await expect(
      recordCreativeReviewDecision({
        runId: fixture.runId,
        itemId: fixture.itemId,
        actor: { id: actorId, role: "admin" },
        expectedVersion: 1,
        supersedesDecisionId: fixture.decision.id,
        decision: "rejected",
        identityConsistency: "passed",
        score: 94,
        quality: {
          artifactFree: true,
          singleSubject: true,
          intentMatch: true,
          noVisibleText: true,
        },
        reason: "Attempt terminal correction before archiving the active Look",
        requestId: `${prefix}look-blocked-terminal`,
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        dependencies: expect.arrayContaining(["active_character_look"]),
      },
    });
  });
});
