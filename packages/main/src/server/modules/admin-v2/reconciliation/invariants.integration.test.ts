import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { auditAdminCutoverInvariants } from "./invariants";

describe("Admin cutover invariant report", () => {
  const suffix = randomUUID();
  const characterId = `invariant-character-${suffix}`;
  const reportId = `invariant-report-${suffix}`;

  beforeAll(async () => {
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
    await prisma.$disconnect();
  });

  it("reports concrete violations and blocks certification when an invariant is not provable", async () => {
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
        status: "unavailable",
        violationCount: null,
      }),
    ]));
  });
});
