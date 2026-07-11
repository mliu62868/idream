import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/v2/admin/chat/sessions/[sessionId]/commands/migrate-release/route";
import { prisma } from "@/server/lib/db";
import { applyChatEvent } from "@/processes/event-consumer";
import { CHAT_TO_MAIN_EVENTS, MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";

describe("explicit Chat Session Release migration command", () => {
  const suffix = randomUUID();
  const adminId = `session-migrate-admin-${suffix}`;
  const characterId = `session-migrate-character-${suffix}`;
  const projectId = `session-migrate-project-${suffix}`;
  const contentId = `session-migrate-content-${suffix}`;
  const releaseId = `session-migrate-release-${suffix}`;
  const sessionId = `session-migrate-session-${suffix}`;
  let commandId = "";

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active" },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 2,
        contentHash: `hash-${suffix}`,
        personaSnapshot: { systemPrompt: "compatible" },
        openingSnapshot: { firstMessage: "hello" },
        appearanceSnapshot: {},
        sourceType: "test",
      },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "live_management",
        audience: {},
        successCriteria: [],
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `revision-${suffix}`,
        characterContentVersionId: contentId,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `snapshot-${suffix}`,
        status: "superseded",
        version: 7,
      },
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: sessionId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: adminId } });
    const commandIds = (await prisma.controlPlaneCommand.findMany({
      where: { actorId: adminId },
      select: { id: true },
    })).map((row) => row.id);
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: commandIds } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { id: { in: commandIds } } });
    await prisma.characterRelease.delete({ where: { id: releaseId } });
    await prisma.characterProject.delete({ where: { id: projectId } });
    await prisma.characterContentVersion.delete({ where: { id: contentId } });
    await prisma.user.delete({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  it("dispatches to Chat, waits for next-turn verification, then closes the command", async () => {
    const response = await POST(
      new Request(`http://localhost/api/v2/admin/chat/sessions/${sessionId}/commands/migrate-release`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": adminId,
          "x-idream-role": "admin",
          "x-request-id": randomUUID(),
          "idempotency-key": randomUUID(),
          "if-match": '"7"',
        },
        body: JSON.stringify({
          entityVersion: 7,
          characterId,
          fromCharacterContentVersionId: `old-content-${suffix}`,
          fromCharacterReleaseId: `old-release-${suffix}`,
          toCharacterContentVersionId: contentId,
          toCharacterReleaseId: releaseId,
          reason: { code: "compatibility_repair", summary: "Fix incompatible persona injection" },
          confirmation: `${sessionId}:${releaseId}:migrate`,
          compatibilityQa: {
            status: "passed",
            policyVersion: "chat-compat-v1",
            evidence: { transcriptId: `qa-${suffix}` },
          },
        }),
      }),
      { params: Promise.resolve({ sessionId }) },
    );
    expect(response.status).toBe(202);
    commandId = (await response.json()).data.commandId;

    const command = await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: commandId } });
    expect(command.status).toBe("verifying");
    const dispatch = await prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: `session-release-migration:${commandId}` },
    });
    expect(dispatch.eventType).toBe(MAIN_TO_CHAT_EVENTS.sessionReleaseMigrationRequested);
    expect(dispatch.payload).toMatchObject({
      payload: {
        commandId,
        sessionId,
        toCharacterContentVersionId: contentId,
        toCharacterReleaseId: releaseId,
      },
    });

    await expect(applyChatEvent({
      eventId: `chat-tampered-${commandId}`,
      eventType: CHAT_TO_MAIN_EVENTS.sessionReleaseMigrationApplied,
      aggregateId: commandId,
      payload: {
        commandId,
        sessionId,
        characterId,
        fromCharacterContentVersionId: `old-content-${suffix}`,
        fromCharacterReleaseId: `old-release-${suffix}`,
        toCharacterContentVersionId: contentId,
        toCharacterReleaseId: `different-release-${suffix}`,
        appliedAt: new Date().toISOString(),
      },
    })).rejects.toThrow("verification payload changed");
    expect(await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: commandId } })).toMatchObject({
      status: "verifying",
    });

    await applyChatEvent({
      eventId: `chat-applied-${commandId}`,
      eventType: CHAT_TO_MAIN_EVENTS.sessionReleaseMigrationApplied,
      aggregateId: commandId,
      payload: {
        commandId,
        sessionId,
        characterId,
        fromCharacterContentVersionId: `old-content-${suffix}`,
        fromCharacterReleaseId: `old-release-${suffix}`,
        toCharacterContentVersionId: contentId,
        toCharacterReleaseId: releaseId,
        appliedAt: new Date().toISOString(),
      },
    });

    expect(await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: commandId } })).toMatchObject({
      status: "succeeded",
      needsReconciliation: false,
    });
    expect(await prisma.controlPlaneCommandAttempt.findFirstOrThrow({ where: { commandId } })).toMatchObject({
      status: "succeeded",
    });
  });
});
