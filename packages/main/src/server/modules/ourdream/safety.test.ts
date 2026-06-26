import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import {
  api,
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
  await createUser({ id: SYS });
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
      body: { mode: "image", characterId: CHAR, prompt: "csam content", outputCount: 1 },
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
    await grantCoins(userId, 100, "seed");
    await prisma.ageVerification.create({
      data: { userId, provider: "mock", status: "verified", metadata: {} },
    });
    const result = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(result, 202);
    expect(result.data.job.status).toBe("queued");
    await runQueuedGenerationJobs(8);
  });
});

describe("reports, queue, and reporter anonymity", () => {
  it("files a report, enqueues triage, and writes a moderation event", async () => {
    const reporter = await freshUser("reporter-1");
    const result = await api("POST", `characters/${CHAR}/report`, {
      userId: reporter,
      ageGate: true,
      body: { category: "spam", description: "noise" },
    });
    expectOk(result);
    const reportId = result.data.report.id as string;

    const job = await jobQueue.getByDedupeKey("report.triage", `report.triage:${reportId}`);
    expect(job).not.toBeNull();
    expect(job?.priority).toBe(3);

    const event = await prisma.moderationEvent.findFirst({
      where: { targetType: "character", targetId: CHAR, layer: "community_report" },
    });
    expect(event).not.toBeNull();
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

    const job = await jobQueue.getByDedupeKey("report.triage", `report.triage:${reportId}`);
    expect(job?.priority).toBe(1);

    // Immediate hide (compliance, roadmap M9): target is no longer approved.
    const hidden = await prisma.character.findUnique({ where: { id: target } });
    expect(hidden?.status).not.toBe("approved");
  });
});

describe("admin moderation queue + audit", () => {
  it("requires admin and records an audited decision that actions the target", async () => {
    const reporter = await freshUser("admin-reporter");
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
  });
});
