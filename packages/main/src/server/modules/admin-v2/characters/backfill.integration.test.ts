import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { createMedia, createUser } from "@/server/test/helpers";
import { runCharacterReleaseBackfillBatch } from "./backfill";

describe("Character / Release / Visual Identity historical backfill", () => {
  const suffix = randomUUID();
  const prefix = `zz-backfill-${suffix}`;
  const actorId = `${prefix}-actor`;
  const completeId = `${prefix}-complete`;
  const incompleteId = `${prefix}-incomplete`;
  const ambiguousId = `${prefix}-ambiguous`;
  const userCharacterId = `${prefix}-user`;
  const mediaId = `${prefix}-media`;

  beforeAll(async () => {
    await createUser({ id: actorId, role: "admin" });
    await createMedia({ id: mediaId, ownerId: actorId, visibility: "public" });
    await prisma.character.createMany({
      data: [
        {
          id: completeId,
          name: "Complete legacy live",
          age: 28,
          description: "A complete historical character.",
          systemPrompt: "Stay in persona.",
          source: "official",
          status: "approved",
          visibility: "public",
          imageAssetId: mediaId,
          appearance: { face: { eyes: "amber" } },
          advancedDetails: { firstMessage: "Welcome back.", personality: "warm" },
        },
        {
          id: incompleteId,
          name: "Incomplete legacy live",
          age: 31,
          description: "Still live while remediation is queued.",
          source: "official",
          status: "approved",
          visibility: "public",
          appearance: {},
          advancedDetails: {},
        },
        {
          id: ambiguousId,
          name: "Ambiguous private official",
          age: 29,
          description: "No trustworthy paused versus retired evidence.",
          source: "official",
          status: "approved",
          visibility: "private",
          appearance: {},
          advancedDetails: {},
        },
        {
          id: userCharacterId,
          name: "User character",
          age: 26,
          description: "Needs content attribution but no Admin Release.",
          source: "user",
          status: "approved",
          visibility: "public",
          appearance: {},
          advancedDetails: { firstMessage: "Hello." },
          creatorId: actorId,
        },
      ],
    });
    await prisma.characterVisualProfile.create({
      data: {
        characterId: completeId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "amber eyes, stable face",
        faceTraits: { eyes: "amber" },
        hairTraits: { color: "black" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [mediaId],
        adapterRefs: {},
        createdFrom: "legacy",
      },
    });
  });

  afterAll(async () => {
    await prisma.adminBackfillItem.deleteMany({ where: { entityId: { startsWith: prefix } } });
    await prisma.adminBackfillRun.deleteMany({ where: { domain: "character_release_visual_v1" } });
    await prisma.releaseCheckResult.deleteMany({
      where: { validationRunId: { startsWith: prefix } },
    });
    const releases = await prisma.characterRelease.findMany({
      where: { projectId: { startsWith: `legacy-project:${prefix}` } },
      select: { id: true },
    });
    await prisma.releaseValidationRun.deleteMany({
      where: { releaseId: { in: releases.map((item) => item.id) } },
    });
    await prisma.characterServing.deleteMany({ where: { characterId: { startsWith: prefix } } });
    await prisma.characterRelease.deleteMany({ where: { id: { startsWith: `legacy-release:${prefix}` } } });
    await prisma.characterRevision.deleteMany({ where: { id: { startsWith: `legacy-revision:${prefix}` } } });
    await prisma.characterProject.deleteMany({ where: { id: { startsWith: `legacy-project:${prefix}` } } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId: { startsWith: prefix } } });
    await prisma.characterVisualReferenceSnapshot.deleteMany({ where: { mediaAssetId: mediaId } });
    await prisma.referenceSetRevision.deleteMany({
      where: { visualProfile: { characterId: { startsWith: prefix } } },
    });
    await prisma.referenceCandidate.deleteMany({
      where: { visualProfile: { characterId: { startsWith: prefix } } },
    });
    await prisma.characterVisualProfile.deleteMany({ where: { characterId: { startsWith: prefix } } });
    await prisma.character.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.mediaAsset.deleteMany({ where: { id: mediaId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("supports dry-run, keyset resume, apply, and idempotent reruns without changing visibility", async () => {
    const firstDryRun = await runCharacterReleaseBackfillBatch(prisma, {
      dryRun: true,
      batchSize: 2,
      initialCursor: `${prefix}-`,
      stopAtId: `${prefix}-user`,
    });
    expect(firstDryRun.status).toBe("paused");
    expect(firstDryRun.nextCursor).not.toBeNull();
    expect(await prisma.characterProject.count({ where: { characterId: { startsWith: prefix } } })).toBe(0);

    let dryRun = firstDryRun;
    while (dryRun.status === "paused") {
      dryRun = await runCharacterReleaseBackfillBatch(prisma, { runId: dryRun.runId });
    }
    expect(dryRun.status).toBe("completed");
    expect(dryRun.summary.scanned).toBe(4);
    expect(dryRun.summary.manualReconciliation).toBe(1);

    let apply = await runCharacterReleaseBackfillBatch(prisma, {
      dryRun: false,
      batchSize: 1,
      initialCursor: `${prefix}-`,
      stopAtId: `${prefix}-user`,
    });
    while (apply.status === "paused") {
      apply = await runCharacterReleaseBackfillBatch(prisma, { runId: apply.runId });
    }
    expect(apply.status).toBe("completed");

    const states = await prisma.character.findMany({
      where: { id: { in: [completeId, incompleteId, ambiguousId] } },
      select: { id: true, status: true, visibility: true },
      orderBy: { id: "asc" },
    });
    expect(states).toEqual([
      { id: ambiguousId, status: "approved", visibility: "private" },
      { id: completeId, status: "approved", visibility: "public" },
      { id: incompleteId, status: "approved", visibility: "public" },
    ]);
    expect(await prisma.characterContentVersion.count({ where: { characterId: { startsWith: prefix } } })).toBe(4);
    expect(await prisma.characterProject.count({ where: { characterId: { startsWith: prefix } } })).toBe(3);
    expect(await prisma.characterServing.count({ where: { characterId: { startsWith: prefix } } })).toBe(3);

    const live = await prisma.characterServing.findMany({
      where: { characterId: { in: [completeId, incompleteId] } },
      orderBy: { characterId: "asc" },
    });
    expect(live.map((item) => [item.characterId, item.state, item.currentReleaseId !== null])).toEqual([
      [completeId, "live", true],
      [incompleteId, "live", true],
    ]);
    const legacyReleases = await prisma.characterRelease.findMany({
      where: { id: { startsWith: `legacy-release:${prefix}` } },
      select: { readiness: true, legacy: true },
    });
    expect(legacyReleases).toHaveLength(2);
    expect(legacyReleases.every((item) => item.legacy && item.readiness === "blocked")).toBe(true);

    const invariantCodes = apply.report.mismatches.map((item) => item.code);
    expect(invariantCodes).toContain("live_release_route_unqualified");
    expect(invariantCodes).toContain("live_release_visual_incomplete");
    expect(apply.report.reportHash).toMatch(/^[a-f0-9]{64}$/);

    let rerun = await runCharacterReleaseBackfillBatch(prisma, {
      dryRun: false,
      batchSize: 50,
      initialCursor: `${prefix}-`,
      stopAtId: `${prefix}-user`,
    });
    while (rerun.status === "paused") rerun = await runCharacterReleaseBackfillBatch(prisma, { runId: rerun.runId });
    expect(await prisma.characterContentVersion.count({ where: { characterId: { startsWith: prefix } } })).toBe(4);
    expect(await prisma.characterRelease.count({ where: { id: { startsWith: `legacy-release:${prefix}` } } })).toBe(2);
  });
});
