import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  api,
  completeQueuedCharacterPreview,
  createCharacter,
  createMedia,
  createUser,
  expectError,
  expectOk,
  grantCoins,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";

// SPEC (highest-priority risk list, docs/architecture/11-testing.md §4):
// - age gate must precede adult content / gated routes (403 otherwise)
// - character age < 18 is rejected at the API boundary
// - underage / deepfake / prohibited keywords are blocked in input AND output
//   moderation and every hit writes a moderation_event
// - jurisdiction age-verification, when required, blocks gated routes
// - reports land in the queue, reporter identity is never disclosed to others,
//   underage reports are priority 1 and immediately hide the target

const P = "zt-safe-";
const SYS = `${P}sys`;
const CHAR = `${P}char`;

async function freshUser(suffix: string, role: "user" | "admin" = "user") {
  const id = `${P}u-${suffix}`;
  await createUser({ id, role });
  return id;
}

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: SYS, dataClass: "customer" });
  await createCharacter({ id: CHAR, creatorId: SYS, visibility: "public", status: "approved" });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("age gate enforcement", () => {
  it("blocks the public catalog until the age gate is accepted", async () => {
    const blocked = await api("GET", "characters");
    expectError(blocked, 403, "forbidden");
    expect(blocked.error?.details).toMatchObject({ reason: "age_gate_required" });

    const allowed = await api("GET", "characters", { ageGate: true });
    expectOk(allowed);
  });

  it("blocks adult workspace APIs until the age gate is accepted", async () => {
    const userId = await freshUser("adult-api-gate");
    const mediaId = `${P}media-gate`;
    await createMedia({ id: mediaId, ownerId: userId });

    const blocked = [
      await api("GET", "generation/config", { userId }),
      await api("GET", "generation/jobs", { userId }),
      await api("GET", "generation/presets", { userId }),
      await api("GET", "media", { userId }),
      await api("GET", `media/${mediaId}/download`, { userId }),
      await api("GET", "library/recent", { userId }),
      await api("POST", "character-drafts", {
        userId,
        body: { gender: "female", style: "realistic", name: "Gate Test" },
      }),
    ];

    for (const result of blocked) {
      expectError(result, 403, "forbidden");
      expect(result.error?.details).toMatchObject({ reason: "age_gate_required" });
    }

    const allowed = await api("GET", "generation/config", { userId, ageGate: true });
    expectOk(allowed);
  });
});

describe("character age hard rule (>= 18)", () => {
  it("rejects a draft submitted with age < 18", async () => {
    const userId = await freshUser("minor-age");
    const draft = await prisma.characterDraft.create({
      data: {
        ownerId: userId,
        name: "Aria",
        appearance: {},
        hair: {},
        body: {},
        advancedDetails: {},
        tags: [],
      },
    });
    const result = await api("POST", `character-drafts/${draft.id}/submit`, {
      userId,
      ageGate: true,
      body: { age: 17, visibility: "private" },
    });
    expectError(result, 400, "bad_request");
  });

  it("accepts a draft with age >= 18 and creates the character", async () => {
    const userId = await freshUser("adult-age");
    const draft = await prisma.characterDraft.create({
      data: {
        ownerId: userId,
        name: "Nova",
        appearance: {},
        hair: {},
        body: {},
        advancedDetails: {},
        tags: [],
      },
    });
    const preview = await api("POST", `character-drafts/${draft.id}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(preview);
    await completeQueuedCharacterPreview({
      previewJobId: preview.data.previewJob.id as string,
      draftId: draft.id,
      userId,
    });
    const selected = await api("POST", `character-drafts/${draft.id}/preview-anchor`, {
      userId,
      ageGate: true,
      body: { previewJobId: preview.data.previewJob.id },
    });
    expectOk(selected);
    const result = await api("POST", `character-drafts/${draft.id}/submit`, {
      userId,
      ageGate: true,
      body: { age: 21, visibility: "private" },
    });
    expectOk(result);
    expect(result.data.character).toMatchObject({ age: 21, status: "approved" });
  });
});

describe("content moderation — input + output", () => {
  it("blocks a draft whose content hits the underage policy and records an event", async () => {
    const userId = await freshUser("mod-draft");
    const draft = await prisma.characterDraft.create({
      data: {
        ownerId: userId,
        name: "Underage Cutie",
        appearance: {},
        hair: {},
        body: {},
        advancedDetails: {},
        tags: [],
      },
    });
    const result = await api("POST", `character-drafts/${draft.id}/submit`, {
      userId,
      ageGate: true,
      body: { age: 21, visibility: "private" },
    });
    expectError(result, 403, "forbidden");

    const event = await prisma.moderationEvent.findFirst({
      where: { targetType: "character_draft", targetId: draft.id, status: "blocked" },
    });
    expect(event).not.toBeNull();
    expect(event?.policyCode).toBe("age_under_18");
  });

  it("blocks an unsafe generation prompt and refunds the reserved dreamcoins", async () => {
    const userId = await freshUser("mod-gen");
    const characterId = `${P}char-mod-gen`;
    await createCharacter({
      id: characterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    await grantCoins(userId, 500, "seed");
    // Premium controls entitlement required to send a custom prompt at all.
    await prisma.entitlement.create({
      data: { userId, key: "premium_controls", value: true, source: "test" },
    });
    const before = await prisma.dreamcoinLedger.aggregate({
      where: { userId },
      _sum: { delta: true },
    });

    const result = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId,
        prompt: "csam content",
        outputCount: 1,
      },
    });
    expectOk(result, 202);
    expect(result.data.job.status).toBe("queued");
    await runQueuedGenerationJobs(8);
    const poll = await api("GET", `generation/jobs/${result.data.job.id}`, {
      userId,
      ageGate: true,
    });
    expectOk(poll);
    expect(poll.data.job.status).toBe("blocked");

    const after = await prisma.dreamcoinLedger.aggregate({
      where: { userId },
      _sum: { delta: true },
    });
    // reserve then refund nets to zero — balance unchanged.
    expect(after._sum.delta).toBe(before._sum.delta);

    const event = await prisma.moderationEvent.findFirst({
      where: { targetType: "generation_job", targetId: result.data.job.id, status: "blocked" },
    });
    expect(event).not.toBeNull();
  });
});

describe("jurisdiction age verification gate", () => {
  it("blocks gated routes when verification is required and unmet", async () => {
    const userId = await freshUser("verify-required");
    await grantCoins(userId, 100, "seed");
    await prisma.ageVerification.create({
      data: { userId, provider: "mock", status: "required", metadata: {} },
    });
    const result = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectError(result, 403, "forbidden");
    expect(result.error?.message).toMatch(/verification/i);
  });

  it("allows gated routes when verification status is verified", async () => {
    const userId = await freshUser("verify-ok");
    const characterId = `${P}char-verify-ok`;
    await createCharacter({
      id: characterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    await grantCoins(userId, 100, "seed");
    await prisma.ageVerification.create({
      data: { userId, provider: "mock", status: "verified", metadata: {} },
    });
    const result = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId, outputCount: 1 },
    });
    expectOk(result, 202);
    expect(result.data.job.status).toBe("queued");
    await runQueuedGenerationJobs(8);
  });
});

describe("reports, queue, and reporter anonymity", () => {
  it("files a report at default priority and writes a moderation event", async () => {
    const reporter = await freshUser("reporter-1");
    const result = await api("POST", `characters/${CHAR}/report`, {
      userId: reporter,
      ageGate: true,
      body: { category: "spam", description: "noise" },
    });
    expectOk(result);
    const reportId = result.data.report.id as string;

    // Triage priority lives on the contentReport row (the admin review queue reads it).
    const report = await prisma.contentReport.findUnique({ where: { id: reportId } });
    expect(report?.priority).toBe(3);

    const event = await prisma.moderationEvent.findFirst({
      where: { targetType: "character", targetId: CHAR, layer: "community_report" },
    });
    expect(event).not.toBeNull();
    const evidence = await prisma.caseEvidence.findFirstOrThrow({
      where: { sourceType: "content_report", sourceId: reportId },
    });
    expect(await prisma.adminCase.findUniqueOrThrow({ where: { id: evidence.caseId } })).toMatchObject({
      type: "content_report",
      targetType: "character",
      targetId: CHAR,
      status: "new",
    });
  });

  it("does not disclose a report to anyone other than its reporter", async () => {
    const reporter = await freshUser("reporter-2");
    const other = await freshUser("reporter-other");
    const filed = await api("POST", `characters/${CHAR}/report`, {
      userId: reporter,
      ageGate: true,
      body: { category: "spam" },
    });
    const reportId = filed.data.report.id as string;

    const asReporter = await api("GET", `reports/${reportId}`, { userId: reporter });
    expectOk(asReporter);

    const asOther = await api("GET", `reports/${reportId}`, { userId: other });
    expectError(asOther, 404, "not_found");
  });

  it("treats underage reports as priority 1 and immediately hides the target", async () => {
    const reporter = await freshUser("reporter-underage");
    const target = `${P}char-underage`;
    await createCharacter({ id: target, creatorId: SYS, visibility: "public", status: "approved" });

    const result = await api("POST", `characters/${target}/report`, {
      userId: reporter,
      ageGate: true,
      body: { category: "underage_content", description: "looks underage" },
    });
    expectOk(result);
    const reportId = result.data.report.id as string;

    const report = await prisma.contentReport.findUnique({ where: { id: reportId } });
    expect(report?.priority).toBe(1);

    // Immediate hide (compliance, roadmap M9): target is no longer approved.
    const hidden = await prisma.character.findUnique({ where: { id: target } });
    expect(hidden?.status).not.toBe("approved");
  });

  it("serializes automatic media takedown with every MediaAsset authority consumer", async () => {
    const reporter = await freshUser("reporter-underage-media");
    const owner = await freshUser("underage-media-owner");
    const mediaId = `${P}underage-media`;
    await createMedia({ id: mediaId, ownerId: owner });

    let reportRequest: ReturnType<typeof api> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${mediaId}`}))`;
      const pendingReport = api("POST", "reports", {
        userId: reporter,
        ageGate: true,
        body: {
          targetType: "media",
          targetId: mediaId,
          category: "underage_content",
        },
      });
      reportRequest = pendingReport;
      const state = await Promise.race([
        pendingReport.then(() => "settled" as const),
        new Promise<"waiting">((resolve) => {
          setTimeout(() => resolve("waiting"), 75);
        }),
      ]);
      expect(state).toBe("waiting");
    });

    expect(reportRequest).toBeDefined();
    expectOk(await reportRequest!);
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } }),
    ).resolves.toMatchObject({ safetyStatus: "blocked" });
  });
});

describe("admin moderation queue + audit", () => {
  it("keeps fresh reports visible when the queue has more than one page", async () => {
    const admin = await freshUser("admin-fresh-report", "admin");
    const targetType = `${P}report-order`;
    const oldCreatedAt = new Date("2025-01-01T00:00:00.000Z");
    const freshReportId = `${P}fresh-report`;

    await prisma.contentReport.createMany({
      data: Array.from({ length: 101 }, (_, index) => ({
        id: `${P}old-report-${index}`,
        targetType,
        targetId: `${P}old-target-${index}`,
        category: "other_prohibited_content",
        status: "open",
        priority: 3,
        createdAt: oldCreatedAt,
      })),
    });
    await prisma.contentReport.create({
      data: {
        id: freshReportId,
        targetType,
        targetId: `${P}fresh-target`,
        category: "other_prohibited_content",
        status: "open",
        priority: 3,
      },
    });

    const queue = await api("GET", "admin/moderation/queue", {
      userId: admin,
      role: "admin",
      query: { targetType },
    });
    expectOk(queue);
    const reportIds = (queue.data.reports as Array<{ id: string }>).map((report) => report.id);
    expect(reportIds[0]).toBe(freshReportId);
    expect(reportIds).toContain(freshReportId);
    expect(reportIds).toHaveLength(100);
  });

  it("requires admin and records an audited decision that actions the target", async () => {
    const reporter = `${P}u-admin-reporter`;
    await createUser({ id: reporter, dataClass: "customer" });
    const admin = await freshUser("admin-1", "admin");
    const target = `${P}char-actioned`;
    await createCharacter({ id: target, creatorId: SYS, visibility: "public", status: "approved" });

    const filed = await api("POST", `characters/${target}/report`, {
      userId: reporter,
      ageGate: true,
      body: { category: "prohibited", description: "bad" },
    });
    const reportId = filed.data.report.id as string;

    // Non-admin cannot see the queue.
    const forbidden = await api("GET", "admin/moderation/queue", { userId: reporter });
    expectError(forbidden, 403, "forbidden");

    const queue = await api("GET", "admin/moderation/queue", { userId: admin, role: "admin" });
    expectOk(queue);
    expect((queue.data.reports as Array<{ id: string }>).some((r) => r.id === reportId)).toBe(true);
    const filteredQueue = await api("GET", "admin/moderation/queue", {
      userId: admin,
      role: "admin",
      query: { id: reportId },
    });
    expectOk(filteredQueue);
    expect(filteredQueue.data.reports as Array<{ id: string }>).toEqual([
      expect.objectContaining({ id: reportId }),
    ]);

    const decision = await api("POST", `admin/moderation/${reportId}/decision`, {
      userId: admin,
      role: "admin",
      body: {
        decision: "actioned",
        policyCode: "prohibited_content",
        notes: "removed",
        reason: "policy violation confirmed",
        confirmation: "TAKEDOWN",
      },
    });
    expectOk(decision);
    expect(decision.data.review).toMatchObject({ policyCode: "prohibited_content" });
    expect(decision.data.review.reviewerId).toBe(admin);

    const removed = await prisma.character.findUnique({ where: { id: target } });
    expect(removed?.status).toBe("removed");
    const evidence = await prisma.caseEvidence.findFirstOrThrow({
      where: { sourceType: "content_report", sourceId: reportId },
    });
    expect(await prisma.adminCase.findUniqueOrThrow({ where: { id: evidence.caseId } })).toMatchObject({
      status: "resolved",
      verificationState: "passed",
    });
    expect(
      await prisma.decisionRecord.findFirst({
        where: { sourceType: "admin_case", sourceId: evidence.caseId, decision: "actioned" },
      }),
    ).not.toBeNull();
  });

  it("serializes an audited media decision with the shared MediaAsset authority lock", async () => {
    const reporter = await freshUser("admin-media-reporter");
    const owner = await freshUser("admin-media-owner");
    const admin = await freshUser("admin-media-lock", "admin");
    const mediaId = `${P}admin-actioned-media`;
    await createMedia({ id: mediaId, ownerId: owner });
    const report = await prisma.contentReport.create({
      data: {
        reporterId: reporter,
        targetType: "media",
        targetId: mediaId,
        category: "prohibited",
        status: "open",
        priority: 3,
      },
    });

    let decisionRequest: ReturnType<typeof api> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${mediaId}`}))`;
      const pendingDecision = api(
        "POST",
        `admin/moderation/${report.id}/decision`,
        {
          userId: admin,
          role: "admin",
          body: {
            decision: "actioned",
            policyCode: "prohibited_content",
            notes: "removed",
            reason: "policy violation confirmed",
            confirmation: "TAKEDOWN",
          },
        },
      );
      decisionRequest = pendingDecision;
      const state = await Promise.race([
        pendingDecision.then(() => "settled" as const),
        new Promise<"waiting">((resolve) => {
          setTimeout(() => resolve("waiting"), 75);
        }),
      ]);
      expect(state).toBe("waiting");
    });

    expect(decisionRequest).toBeDefined();
    expectOk(await decisionRequest!);
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } }),
    ).resolves.toMatchObject({
      safetyStatus: "blocked",
      visibility: "private",
    });
  });
});
