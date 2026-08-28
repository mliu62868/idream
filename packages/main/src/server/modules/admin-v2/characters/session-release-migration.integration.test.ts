import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/v2/admin/chat/sessions/[sessionId]/commands/migrate-release/route";
import { prisma } from "@/server/lib/db";

describe("explicit Chat Session Release migration command", () => {
  const suffix = randomUUID();
  const adminId = `session-migrate-admin-${suffix}`;
  const userId = `session-migrate-user-${suffix}`;
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
    await prisma.user.create({
      data: { id: userId, email: `${userId}@example.test`, role: "user", status: "active" },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: userId,
        name: "Migration Character",
        age: 24,
        description: "fixture",
        appearance: {},
        advancedDetails: {},
      },
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
    await prisma.recentChat.create({
      data: {
        sessionId,
        userId,
        characterId,
        characterContentVersionId: `old-content-${suffix}`,
        characterReleaseId: `old-release-${suffix}`,
        contextRevision: 4,
      },
    });
  });

  afterAll(async () => {
    await prisma.recentChat.deleteMany({ where: { sessionId } });
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
    await prisma.character.delete({ where: { id: characterId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.user.delete({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  // SPEC: 目标 Release 不是已发布态时，命令必须当场拒绝。
  // INTENT: 此前只校归属与 pin 关系，不校状态。chat 侧 `released-knowledge.ts:26` 只接受
  //         published|superseded，其余在 `buildReleasedKnowledgeSnapshot` 里抛
  //         `character release ... is not released` —— 而那是在**每一轮对话**里抛。
  //         于是把会话迁到 draft/approved/scheduled 上，命令返回成功，会话此后每说一句话都炸，
  //         且那个 pin 只有删除会话时才清（chat/src/privacy.ts:321）——运营无从撤销。
  //         实测生产库里就有一条 `approved` 的 Release 能触发它。
  it("refuses to migrate a session onto a Release Chat would reject", async () => {
    const draftContentId = `${contentId}-draft`;
    const draftReleaseId = `${releaseId}-draft`;
    await prisma.characterContentVersion.create({
      data: {
        id: draftContentId,
        characterId,
        version: 3,
        contentHash: `hash-draft-${suffix}`,
        personaSnapshot: { systemPrompt: "compatible" },
        openingSnapshot: { firstMessage: "hello" },
        appearanceSnapshot: {},
        sourceType: "test",
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: draftReleaseId,
        projectId,
        revisionId: `revision-draft-${suffix}`,
        characterContentVersionId: draftContentId,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `snapshot-draft-${suffix}`,
        // `approved` 是「审过了但还没发布」，chat 不认；这正是库里那条真实存在的状态。
        status: "approved",
        version: 1,
      },
    });

    const response = await POST(
      new Request(`http://localhost/api/v2/admin/chat/sessions/${sessionId}/commands/migrate-release`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": adminId,
          "x-idream-role": "admin",
          "x-request-id": randomUUID(),
          "idempotency-key": randomUUID(),
          "if-match": '"1"',
        },
        body: JSON.stringify({
          entityVersion: 1,
          characterId,
          fromCharacterContentVersionId: contentId,
          fromCharacterReleaseId: releaseId,
          toCharacterContentVersionId: draftContentId,
          toCharacterReleaseId: draftReleaseId,
          reason: { code: "compatibility_repair", summary: "Should not be accepted" },
          confirmation: `${sessionId}:${draftReleaseId}:migrate`,
          compatibilityCheck: {
            status: "passed",
            policyVersion: "chat-compat-v1",
            evidence: { transcriptId: `qa-draft-${suffix}` },
          },
        }),
      }),
      { params: Promise.resolve({ sessionId }) },
    );

    // 422 + blockers 是 InvariantFailedError 的响应形状（authoritative.ts:332）。
    expect(response.status).toBe(422);
    const body = await response.json() as {
      error?: { code?: string; blockers?: { code: string; message: string }[] };
    };
    expect(body.error?.code).toBe("invariant_failed");
    const blockers = body.error?.blockers ?? [];
    expect(blockers.map((entry) => entry.code)).toContain("release_not_published");
    // 报错要说清「它现在是什么状态」，否则运营不知道该去把它发布还是换一个。
    expect(blockers.find((entry) => entry.code === "release_not_published")?.message)
      .toContain("approved");

    // INVARIANT: 拒绝必须发生在**接受命令之前** —— 落了命令再失败，运营看到的是一条已受理的迁移。
    const accepted = await prisma.controlPlaneCommand.findMany({
      where: { actorId: adminId, targetId: sessionId },
      select: { requestPayload: true },
    });
    expect(accepted.some((row) => JSON.stringify(row.requestPayload).includes(draftReleaseId))).toBe(false);

    await prisma.characterRelease.delete({ where: { id: draftReleaseId } });
    await prisma.characterContentVersion.delete({ where: { id: draftContentId } });
  });

  it("updates the Main-owned session pin and closes the command atomically", async () => {
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
          compatibilityCheck: {
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
    expect(command.status).toBe("succeeded");
    await expect(prisma.recentChat.findUniqueOrThrow({
      where: { sessionId },
    })).resolves.toMatchObject({
      characterContentVersionId: contentId,
      characterReleaseId: releaseId,
      contextRevision: 5,
      releasePinnedAt: expect.any(Date),
    });
    await expect(prisma.mainOutboxEvent.count({
      where: {
        aggregateId: sessionId,
        eventType: "chat.session_release_migration.requested.v2",
      },
    })).resolves.toBe(0);

    expect(await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: commandId } })).toMatchObject({
      status: "succeeded",
      needsReconciliation: false,
    });
    expect(await prisma.controlPlaneCommandAttempt.findFirstOrThrow({ where: { commandId } })).toMatchObject({
      status: "succeeded",
    });
  });
});
