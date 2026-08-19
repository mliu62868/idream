import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAIN_TO_CHAT_EVENTS,
  characterModerationRemovalEventId,
  characterModerationRestorationEventId,
} from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import {
  api,
  createCharacter,
  createMedia,
  createUser,
  expectError,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";
import { adminV2 } from "@/server/test/admin-v2-http";

const P = "zt-moderation-restoration-";

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

async function setupActionedMedia(
  suffix: string,
  visibility: "private" | "public_pack" | "unlisted",
) {
  const reporterId = `${P}reporter-${suffix}`;
  const ownerId = `${P}owner-${suffix}`;
  const adminId = `${P}admin-${suffix}`;
  const mediaId = `${P}media-${suffix}`;
  await createUser({ id: reporterId, dataClass: "customer" });
  await createUser({ id: ownerId, dataClass: "customer" });
  await createUser({ id: adminId, role: "admin", dataClass: "internal" });
  await createMedia({ id: mediaId, ownerId, visibility });
  const report = await prisma.contentReport.create({
    data: {
      reporterId,
      targetType: "media",
      targetId: mediaId,
      category: "other_prohibited_content",
      status: "open",
      priority: 3,
    },
  });
  const decision = await adminV2(
    "POST",
    `moderation/reports/${report.id}/decision`,
    {
      userId: adminId,
      role: "admin",
      body: {
        decision: "actioned",
        policyCode: "other_prohibited_content",
        reason: "The report was confirmed after review",
        confirmation: "TAKEDOWN",
      },
    },
  );
  expectOk(decision);
  const decisionId = decision.data.review.id as string;
  await expect(
    prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } }),
  ).resolves.toMatchObject({ safetyStatus: "blocked", visibility: "private" });

  const appeal = await api("POST", "appeals", {
    userId: ownerId,
    ageGate: true,
    body: {
      targetType: "media",
      targetId: mediaId,
      originalDecisionId: decisionId,
      appealText: "Please reverse this exact media decision.",
    },
  });
  expectOk(appeal);
  return {
    adminId,
    appealId: appeal.data.appeal.id as string,
    decisionId,
    mediaId,
    ownerId,
    reporterId,
  };
}

async function overturnMediaAppeal(input: {
  adminId: string;
  appealId: string;
}) {
  return adminV2("POST", `moderation/appeals/${input.appealId}/decision`, {
    userId: input.adminId,
    role: "admin",
    body: {
      outcome: "overturned",
      reason: "The original media decision was incorrect",
      confirmation: "OVERTURN",
    },
  });
}

async function actionTarget(input: {
  adminId: string;
  reporterId: string;
  targetType: "character" | "media";
  targetId: string;
}) {
  const report = await prisma.contentReport.create({
    data: {
      reporterId: input.reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      category: "other_prohibited_content",
      status: "open",
    },
  });
  const response = await adminV2(
    "POST",
    `moderation/reports/${report.id}/decision`,
    {
      userId: input.adminId,
      role: "admin",
      body: {
        decision: "actioned",
        policyCode: "other_prohibited_content",
        reason: "The report was confirmed after review",
        confirmation: "TAKEDOWN",
      },
    },
  );
  expectOk(response);
  return response.data.review.id as string;
}

describe("moderation appeal exact restoration authority", () => {
  it("rejects Character appeal A after decision B became the current effect owner", async () => {
    const ownerId = `${P}owner-character-a-b`;
    const adminId = `${P}admin-character-a-b`;
    const characterId = `${P}character-a-b`;
    await createUser({ id: ownerId, dataClass: "customer" });
    await createUser({ id: adminId, role: "admin", dataClass: "internal" });
    await createCharacter({
      id: characterId,
      creatorId: ownerId,
      visibility: "public",
      status: "approved",
    });
    const decisionA = await actionTarget({
      adminId,
      reporterId: ownerId,
      targetType: "character",
      targetId: characterId,
    });
    const appeal = await api("POST", "appeals", {
      userId: ownerId,
      ageGate: true,
      body: {
        targetType: "character",
        targetId: characterId,
        originalDecisionId: decisionA,
        appealText: "Please reverse decision A only.",
      },
    });
    expectOk(appeal);
    await actionTarget({
      adminId,
      reporterId: ownerId,
      targetType: "character",
      targetId: characterId,
    });

    const appealId = appeal.data.appeal.id as string;
    const response = await adminV2(
      "POST",
      `moderation/appeals/${appealId}/decision`,
      {
        userId: adminId,
        role: "admin",
        body: {
          outcome: "overturned",
          reason: "Decision A was incorrect",
          confirmation: "OVERTURN",
        },
      },
    );

    expectError(response, 409, "conflict");
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({ status: "removed" });
    await expect(
      prisma.appeal.findUniqueOrThrow({ where: { id: appealId } }),
    ).resolves.toMatchObject({
      status: "open",
      reviewerId: null,
      resolvedAt: null,
    });
    expect(
      await prisma.mainOutboxEvent.count({
        where: {
          id: characterModerationRestorationEventId(appealId),
        },
      }),
    ).toBe(0);
  });

  it("keeps a Character archived by its owner after moderation action A", async () => {
    const ownerId = `${P}owner-character-archive`;
    const adminId = `${P}admin-character-archive`;
    const characterId = `${P}character-archive`;
    await createUser({ id: ownerId, dataClass: "customer" });
    await createUser({ id: adminId, role: "admin", dataClass: "internal" });
    await createCharacter({
      id: characterId,
      creatorId: ownerId,
      visibility: "public",
      status: "approved",
    });
    const decisionId = await actionTarget({
      adminId,
      reporterId: ownerId,
      targetType: "character",
      targetId: characterId,
    });
    const appeal = await api("POST", "appeals", {
      userId: ownerId,
      ageGate: true,
      body: {
        targetType: "character",
        targetId: characterId,
        originalDecisionId: decisionId,
        appealText: "Please reverse this Character decision.",
      },
    });
    expectOk(appeal);
    expectOk(
      await api("DELETE", `characters/${characterId}`, {
        userId: ownerId,
        ageGate: true,
      }),
    );

    const appealId = appeal.data.appeal.id as string;
    const response = await adminV2(
      "POST",
      `moderation/appeals/${appealId}/decision`,
      {
        userId: adminId,
        role: "admin",
        body: {
          outcome: "overturned",
          reason: "The moderation action was incorrect",
          confirmation: "OVERTURN",
        },
      },
    );

    expectError(response, 409, "conflict");
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({
      status: "archived",
      deletedAt: expect.any(Date),
    });
    await expect(
      prisma.appeal.findUniqueOrThrow({ where: { id: appealId } }),
    ).resolves.toMatchObject({ status: "open", reviewerId: null });
    expect(
      await prisma.mainOutboxEvent.count({
        where: { id: characterModerationRestorationEventId(appealId) },
      }),
    ).toBe(0);
  });

  it("keeps a legacy Character appeal open without deterministic removal authority", async () => {
    const ownerId = `${P}owner-character-legacy`;
    const adminId = `${P}admin-character-legacy`;
    const characterId = `${P}character-legacy`;
    await createUser({ id: ownerId, dataClass: "customer" });
    await createUser({ id: adminId, role: "admin", dataClass: "internal" });
    await createCharacter({
      id: characterId,
      creatorId: ownerId,
      visibility: "public",
      status: "removed",
    });
    const report = await prisma.contentReport.create({
      data: {
        reporterId: ownerId,
        targetType: "character",
        targetId: characterId,
        category: "other_prohibited_content",
        status: "actioned",
      },
    });
    const decision = await prisma.moderationReview.create({
      data: {
        reportId: report.id,
        reviewerId: adminId,
        decision: "actioned",
      },
    });
    await prisma.mainOutboxEvent.create({
      data: {
        id: `${P}legacy-random-removal`,
        eventType: MAIN_TO_CHAT_EVENTS.characterRemoved,
        aggregateType: "character",
        aggregateId: characterId,
        payload: { characterId },
      },
    });
    const appeal = await api("POST", "appeals", {
      userId: ownerId,
      ageGate: true,
      body: {
        targetType: "character",
        targetId: characterId,
        originalDecisionId: decision.id,
        appealText: "Please reverse this legacy decision.",
      },
    });
    expectOk(appeal);
    const appealId = appeal.data.appeal.id as string;

    expectError(
      await adminV2("POST", `moderation/appeals/${appealId}/decision`, {
        userId: adminId,
        role: "admin",
        body: {
          outcome: "overturned",
          reason: "The legacy decision was incorrect",
          confirmation: "OVERTURN",
        },
      }),
      409,
      "conflict",
    );
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({ status: "removed" });
    await expect(
      prisma.appeal.findUniqueOrThrow({ where: { id: appealId } }),
    ).resolves.toMatchObject({
      status: "open",
      reviewerId: null,
      resolvedAt: null,
    });
    const evidence = await prisma.caseEvidence.findUniqueOrThrow({
      where: {
        caseId_sourceType_sourceId: {
          caseId: (
            await prisma.caseEvidence.findFirstOrThrow({
              where: { sourceType: "appeal", sourceId: appealId },
              select: { caseId: true },
            })
          ).caseId,
          sourceType: "appeal",
          sourceId: appealId,
        },
      },
    });
    await expect(
      prisma.adminCase.findUniqueOrThrow({ where: { id: evidence.caseId } }),
    ).resolves.toMatchObject({ verificationState: "pending" });
    expect(
      await prisma.decisionRecord.count({
        where: {
          sourceType: "admin_case",
          sourceId: evidence.caseId,
          decision: "overturned",
        },
      }),
    ).toBe(0);
  });

  it("commits exact Character removal and restoration events with the appeal", async () => {
    const ownerId = `${P}owner-character`;
    const adminId = `${P}admin-character`;
    const characterId = `${P}character`;
    await createUser({ id: ownerId, dataClass: "customer" });
    await createUser({ id: adminId, role: "admin", dataClass: "internal" });
    await createCharacter({
      id: characterId,
      creatorId: ownerId,
      visibility: "public",
      status: "approved",
    });
    const report = await prisma.contentReport.create({
      data: {
        reporterId: ownerId,
        targetType: "character",
        targetId: characterId,
        category: "other_prohibited_content",
        status: "open",
      },
    });
    const decision = await adminV2(
      "POST",
      `moderation/reports/${report.id}/decision`,
      {
        userId: adminId,
        role: "admin",
        body: {
          decision: "actioned",
          policyCode: "other_prohibited_content",
          reason: "The character report was confirmed after review",
          confirmation: "TAKEDOWN",
        },
      },
    );
    expectOk(decision);
    const moderationDecisionId = decision.data.review.id as string;
    const removalEventId = characterModerationRemovalEventId(
      moderationDecisionId,
    );
    await expect(
      prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: removalEventId },
      }),
    ).resolves.toMatchObject({
      eventType: MAIN_TO_CHAT_EVENTS.characterRemoved,
      aggregateType: "character",
      aggregateId: characterId,
      payload: {
        sourceEventId: removalEventId,
        payload: {
          version: 1,
          binding: "moderation_decision",
          characterId,
          moderationDecisionId,
          previousRemovalEventId: null,
        },
      },
    });

    const appeal = await api("POST", "appeals", {
      userId: ownerId,
      ageGate: true,
      body: {
        targetType: "character",
        targetId: characterId,
        originalDecisionId: moderationDecisionId,
        appealText: "Please reverse this exact character decision.",
      },
    });
    expectOk(appeal);
    const appealId = appeal.data.appeal.id as string;
    expectOk(await adminV2("POST", `moderation/appeals/${appealId}/decision`, {
      userId: adminId,
      role: "admin",
      body: {
        outcome: "overturned",
        reason: "The original character decision was incorrect",
        confirmation: "OVERTURN",
      },
    }));
    const restorationEventId = characterModerationRestorationEventId(appealId);
    await expect(
      prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: restorationEventId },
      }),
    ).resolves.toMatchObject({
      eventType:
        MAIN_TO_CHAT_EVENTS.characterModerationRestorationRequested,
      aggregateType: "character",
      aggregateId: characterId,
      payload: {
        sourceEventId: restorationEventId,
        payload: {
          version: 1,
          binding: "removal_event",
          appealId,
          characterId,
          moderationDecisionId,
          removalEventId,
        },
      },
    });
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({ status: "approved" });
  });

  it("restores the exact public visibility captured before the action", async () => {
    const authority = await setupActionedMedia("public", "public_pack");

    expectOk(await overturnMediaAppeal(authority));

    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: authority.mediaId } }),
    ).resolves.toMatchObject({
      safetyStatus: "passed",
      visibility: "public_pack",
    });
    await expect(
      prisma.moderationEvent.findUniqueOrThrow({
        where: { id: `moderation_action_snapshot_${authority.decisionId}` },
      }),
    ).resolves.toMatchObject({
      targetType: "media",
      targetId: authority.mediaId,
      layer: "admin_decision_effect",
      status: "actioned",
      details: {
        version: 1,
        moderationDecisionId: authority.decisionId,
        before: { safetyStatus: "passed", visibility: "public_pack" },
        after: { safetyStatus: "blocked", visibility: "private" },
      },
    });
  });

  it("rejects Media appeal A after decision B became the current effect owner", async () => {
    const authority = await setupActionedMedia("a-b", "public_pack");
    await actionTarget({
      adminId: authority.adminId,
      reporterId: authority.reporterId,
      targetType: "media",
      targetId: authority.mediaId,
    });

    expectError(await overturnMediaAppeal(authority), 409, "conflict");
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: authority.mediaId } }),
    ).resolves.toMatchObject({
      safetyStatus: "blocked",
      visibility: "private",
    });
    await expect(
      prisma.appeal.findUniqueOrThrow({ where: { id: authority.appealId } }),
    ).resolves.toMatchObject({
      status: "open",
      reviewerId: null,
      resolvedAt: null,
    });
  });

  it("keeps originally private media private after overturn", async () => {
    const authority = await setupActionedMedia("private", "private");

    expectOk(await overturnMediaAppeal(authority));

    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: authority.mediaId } }),
    ).resolves.toMatchObject({
      safetyStatus: "passed",
      visibility: "private",
    });
  });

  it("conflicts and rolls back when media drifts after the action", async () => {
    const authority = await setupActionedMedia("drift", "public_pack");
    let pendingAppeal: ReturnType<typeof overturnMediaAppeal> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${authority.mediaId}`}))`;
      await tx.mediaAsset.update({
        where: { id: authority.mediaId },
        data: { visibility: "unlisted" },
      });
      const request = overturnMediaAppeal(authority);
      pendingAppeal = request;
      const state = await Promise.race([
        request.then(() => "settled" as const),
        new Promise<"waiting">((resolve) => {
          setTimeout(() => resolve("waiting"), 75);
        }),
      ]);
      expect(state).toBe("waiting");
    });

    expect(pendingAppeal).toBeDefined();
    expectError(await pendingAppeal!, 409, "conflict");
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: authority.mediaId } }),
    ).resolves.toMatchObject({
      safetyStatus: "blocked",
      visibility: "unlisted",
    });
    await expect(
      prisma.appeal.findUniqueOrThrow({ where: { id: authority.appealId } }),
    ).resolves.toMatchObject({
      status: "open",
      reviewerId: null,
      resolvedAt: null,
    });
    expect(
      await prisma.mainOutboxEvent.count({
        where: {
          eventType: "admin.moderation.appeal_decided.v2",
          aggregateId: authority.appealId,
        },
      }),
    ).toBe(0);
  });
});
