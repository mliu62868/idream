import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { auditAdminCutoverInvariants } from "./invariants";

describe("Admin cutover invariant report", () => {
  const suffix = randomUUID();
  const characterId = `invariant-character-${suffix}`;
  const reportId = `invariant-report-${suffix}`;
  const userId = `invariant-user-${suffix}`;
  const jobId = `invariant-job-${suffix}`;
  const attemptId = `invariant-attempt-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test` } });
    await prisma.generationJob.create({
      data: { id: jobId, userId, mode: "image", controls: {}, presetIds: [] },
    });
    await prisma.generationAttempt.create({
      data: {
        id: attemptId,
        requestId: jobId,
        attemptNo: 1,
        status: "failed",
        errorCode: "fixture_failure",
        finishedAt: new Date("2026-07-11T11:00:00.000Z"),
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        name: "Unserved official fixture",
        age: 25,
        description: "Intentionally violates the serving invariant",
        visibility: "public",
        status: "approved",
        source: "official",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.contentReport.create({
      data: {
        id: reportId,
        targetType: "character",
        targetId: characterId,
        category: "fixture",
        status: "open",
      },
    });
  });

  afterAll(async () => {
    await prisma.contentReport.deleteMany({ where: { id: reportId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
    await prisma.generationJob.deleteMany({ where: { id: jobId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("reports concrete violations, including real-time missing terminal event counts", async () => {
    const report = await auditAdminCutoverInvariants(prisma, new Date("2026-07-11T12:00:00.000Z"));
    expect(report).toMatchObject({ qualityState: "invalid", decisionUse: "blocked" });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "official_public_character_without_current_serving_release",
        status: "failed",
        sampleIds: expect.arrayContaining([characterId]),
      }),
      expect.objectContaining({
        key: "open_source_without_case",
        status: "failed",
        sampleIds: expect.arrayContaining([`report:${reportId}`]),
      }),
      expect.objectContaining({
        key: "terminal_attempt_without_unique_terminal_event",
        status: "failed",
        sampleIds: expect.arrayContaining([attemptId]),
      }),
    ]));
  });
});
