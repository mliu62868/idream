import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { characterQaCheckKeySchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { POST as createQaRunRoute } from "@/app/api/v2/admin/characters/[id]/qa-runs/route";

describe("Character QA evidence authority", () => {
  const suffix = randomUUID();
  const actorId = `character-qa-admin-${suffix}`;
  const deniedActorId = `character-qa-denied-${suffix}`;
  const characterId = `character-qa-character-${suffix}`;
  const projectId = `character-qa-project-${suffix}`;
  const contentId = `character-qa-content-${suffix}`;

  function checks(result: "passed" | "failed" = "passed") {
    return characterQaCheckKeySchema.options.map((key, index) => ({
      key,
      result: index === 0 ? result : "passed" as const,
      evidenceRef: `qa://evidence/${suffix}/${key}`,
      comment: `Verified ${key} against the signed renderer snapshot`,
      fixDeepLink: `/admin/characters/${characterId}?tab=preview`,
    }));
  }

  function request(userId: string, body: unknown) {
    return new Request(`http://localhost/api/v2/admin/characters/${characterId}/qa-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": userId,
        "x-idream-role": userId === actorId ? "admin" : "user",
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: actorId, email: `${actorId}@example.test`, role: "admin" },
      { id: deniedActorId, email: `${deniedActorId}@example.test`, role: "user" },
    ] });
    await prisma.character.create({ data: {
      id: characterId,
      name: "QA authority character",
      age: 28,
      description: "QA fixture",
      appearance: {},
      advancedDetails: {},
    } });
    await prisma.characterProject.create({ data: {
      id: projectId,
      characterId,
      phase: "qa",
      audience: {},
      successCriteria: ["complete_qa"],
    } });
    await prisma.characterContentVersion.create({ data: {
      id: contentId,
      characterId,
      version: 1,
      contentHash: `character-qa-content-hash-${suffix}`,
      personaSnapshot: { description: "QA fixture" },
      openingSnapshot: { firstMessage: "Hello" },
      appearanceSnapshot: {},
      sourceType: "test",
    } });
    await prisma.characterRevision.create({ data: {
      id: `character-qa-revision-${suffix}`,
      projectId,
      revision: 1,
      characterContentVersionId: contentId,
      projectSnapshot: {},
    } });
  });

  afterAll(async () => {
    const qaRunIds = (await prisma.characterQaRun.findMany({ where: { characterId }, select: { id: true } })).map((run) => run.id);
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: qaRunIds } } });
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: projectId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.characterQaRun.deleteMany({ where: { characterId } });
    await prisma.characterRevision.deleteMany({ where: { projectId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, deniedActorId] } } });
    await prisma.$disconnect();
  });

  it("records all seven checks as immutable evidence and derives the result", async () => {
    const response = await createQaRunRoute(request(actorId, {
      entityVersion: 1,
      checks: checks(),
      reason: "Complete renderer and conversation QA",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(response.status).toBe(201);
    const data = (await response.json()).data;
    expect(data).toMatchObject({
      characterId,
      projectId,
      characterContentVersionId: contentId,
      ownerId: actorId,
      status: "passed",
      checks: expect.arrayContaining([expect.objectContaining({ key: "five_turn_conversation" })]),
    });
    await expect(prisma.characterQaRun.findUnique({ where: { id: data.id } })).resolves.toMatchObject({
      status: "passed",
      evidenceHash: data.evidenceHash,
    });
  });

  it("derives failed, rejects incomplete evidence, stale versions, and missing permission", async () => {
    const failed = await createQaRunRoute(request(actorId, {
      entityVersion: 1,
      checks: checks("failed"),
      reason: "Record a failed renderer check",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(failed.status).toBe(201);
    await expect(failed.json()).resolves.toMatchObject({ data: { status: "failed" } });

    const incomplete = await createQaRunRoute(request(actorId, {
      entityVersion: 1,
      checks: checks().slice(0, 6),
      reason: "Incomplete evidence must fail",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(incomplete.status).toBe(400);

    const stale = await createQaRunRoute(request(actorId, {
      entityVersion: 2,
      checks: checks(),
      reason: "Stale project version must fail",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(stale.status).toBe(409);

    const denied = await createQaRunRoute(request(deniedActorId, {
      entityVersion: 1,
      checks: checks(),
      reason: "Permission must be enforced",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(denied.status).toBe(403);
  });
});
