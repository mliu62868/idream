import { createHash, randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { FREE_DAILY_MESSAGES } from "@idream/shared/chat/limits";
import { verifyBffContext, type BffContext } from "@idream/shared/bff";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { dispatchPendingChatAgentRuns } from "@/server/modules/chat/agent-run-admission";
import { dispatchPendingChatEvents } from "@/processes/chat-outbox";
import {
  beginChatTurn,
  cancelChatTurn,
  chatVoiceAuthority,
  commitChatTerminal,
  createChatSession,
  deleteChatMessage,
  deleteChatSession,
  editChatTurn,
  regenerateChatTurn,
} from "@/server/modules/chat/turn-ledger";
import { applyChatToolEffect } from "@/server/modules/chat/tool-effect";
import { characterReleaseSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";

const USER_ID = "seed-dev-user";
const SECRET = "test-bff-secret-0123456789abcdef";
const CHARACTER_ID = `chat-ledger-character-${randomUUID()}`;
const CONTENT_ID = `chat-ledger-content-${randomUUID()}`;
const CONTENT_V2_ID = `chat-ledger-content-v2-${randomUUID()}`;
const TEST_TERMINAL_EVIDENCE = {
  authority: "test",
  prompt: {
    productPromptVersion: "companion-product-1",
    preparedTurnVersion: 4,
    systemPromptDigest: "a".repeat(64),
    soulFingerprint: "b".repeat(64),
  },
} as const;

describe("Main-owned Chat façade", () => {
  const fetchMock = vi.fn();

  it("allows voice for the session's immutable opening without trusting another session id", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const messageId = `opening:${sessionId}`;
    await prisma.character.update({
      where: { id: CHARACTER_ID },
      data: { currentContentVersionId: CONTENT_V2_ID },
    });

    try {
      await expect(chatVoiceAuthority(USER_ID, sessionId, messageId)).resolves.toMatchObject({
        schemaVersion: 1,
        sessionId,
        messageId,
        characterId: CHARACTER_ID,
        text: "You made it.",
        attempt: 1,
        sceneVersion: 0,
        scene: null,
        characterContentVersionId: CONTENT_ID,
      });
      await expect(chatVoiceAuthority("another-user", sessionId, messageId))
        .rejects.toThrow("Message not found");
      await expect(chatVoiceAuthority(USER_ID, sessionId, "opening:another-session"))
        .rejects.toThrow("Message not found");
    } finally {
      await prisma.character.update({
        where: { id: CHARACTER_ID },
        data: { currentContentVersionId: CONTENT_ID },
      });
    }
  });

  beforeAll(async () => {
    process.env.APP_ENV = "test";
    process.env.CHAT_SERVICE_URL = "http://chat.internal";
    process.env.CHAT_BFF_SIGNING_SECRET = SECRET;
    process.env.MAIN_WEB_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    const compiled = compileCharacterSoul({
      name: "Ledger Companion",
      age: 28,
      gender: "female",
      characterPromise: "A precise and warm companion.",
      detailsMarkdown: "Direct, observant, and emotionally grounded.",
    });
    if (!compiled.ok) throw new Error("fixture Soul did not compile");
    await prisma.character.create({
      data: {
        id: CHARACTER_ID,
        creatorId: USER_ID,
        name: "Ledger Companion",
        age: 28,
        description: "A precise and warm companion.",
        visibility: "private",
        status: "approved",
        appearance: {},
        advancedDetails: { imageToolEnabled: true },
        stats: { create: { chatsCount: 0 } },
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: CONTENT_ID,
        characterId: CHARACTER_ID,
        version: 1,
        contentHash: compiled.snapshot.compiled.fingerprint,
        personaSnapshot: JSON.parse(JSON.stringify(compiled.snapshot)) as Prisma.InputJsonValue,
        openingSnapshot: { firstMessage: "You made it." },
        appearanceSnapshot: {},
        sourceType: "test",
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: CONTENT_V2_ID,
        characterId: CHARACTER_ID,
        version: 2,
        contentHash: `${compiled.snapshot.compiled.fingerprint}-v2`,
        personaSnapshot: JSON.parse(JSON.stringify(compiled.snapshot)) as Prisma.InputJsonValue,
        openingSnapshot: { firstMessage: "Version two." },
        appearanceSnapshot: {},
        sourceType: "test",
      },
    });
    await prisma.character.update({
      where: { id: CHARACTER_ID },
      data: { currentContentVersionId: CONTENT_ID },
    });
  });

  beforeEach(async () => {
    const existingTurnIds = await prisma.chatTurn.findMany({
      where: { session: { characterId: CHARACTER_ID } },
      select: { id: true },
    });
    await prisma.mainOutboxEvent.deleteMany({
      where: {
        OR: [
          {
            eventType: MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1,
            aggregateId: { in: existingTurnIds.map((turn) => turn.id) },
          },
          {
            eventType: { in: [
              MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1,
              MAIN_TO_CHAT_EVENTS.companionMemoryProjectRequestedV1,
              MAIN_TO_CHAT_EVENTS.companionMemoryPurgeRequestedV1,
            ] },
            aggregateId: `${USER_ID}:${CHARACTER_ID}`,
          },
        ],
      },
    });
    await prisma.chatTurnUsageFact.deleteMany({ where: { userId: USER_ID } });
    await prisma.chatTurn.deleteMany({ where: { session: { characterId: CHARACTER_ID } } });
    await prisma.recentChat.deleteMany({ where: { characterId: CHARACTER_ID } });
    await prisma.characterStats.update({
      where: { characterId: CHARACTER_ID },
      data: { chatsCount: 0 },
    });
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(Response.json({ ok: true }, { status: 202 }));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await prisma.moderationEvent.deleteMany({ where: { targetType: "chat_turn" } });
    const existingTurnIds = await prisma.chatTurn.findMany({
      where: { session: { characterId: CHARACTER_ID } },
      select: { id: true },
    });
    await prisma.mainOutboxEvent.deleteMany({
      where: {
        OR: [
          { aggregateId: `${USER_ID}:${CHARACTER_ID}` },
          {
            eventType: MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1,
            aggregateId: { in: existingTurnIds.map((turn) => turn.id) },
          },
        ],
      },
    });
    await prisma.recentChat.deleteMany({ where: { characterId: CHARACTER_ID } });
    await prisma.character.update({
      where: { id: CHARACTER_ID },
      data: { currentContentVersionId: null },
    });
    await prisma.characterContentVersion.deleteMany({
      where: { id: { in: [CONTENT_ID, CONTENT_V2_ID] } },
    });
    await prisma.character.delete({ where: { id: CHARACTER_ID } });
  });

  it("keeps session reads in Main even when Chat execution is unavailable", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const created = await proxyChatRequest(authRequest("/api/v1/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ characterId: CHARACTER_ID }),
    }), ["chat", "sessions"]);
    expect(created.status).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();

    const list = await proxyChatRequest(authRequest("/api/v1/chat/sessions"), ["chat", "sessions"]);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ characterId: CHARACTER_ID, memoryEnabled: true }),
    ]));
  });

  it("rejects a new Product Turn before mutation when AgentRun execution is unconfigured", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const previous = env.CHAT_SERVICE_URL;
    env.CHAT_SERVICE_URL = undefined;
    try {
      const response = await proxyChatRequest(authRequest(
        `/api/v1/chat/sessions/${sessionId}/messages`,
        {
          method: "POST",
          headers: { "idempotency-key": `runtime-preflight-${randomUUID()}` },
          body: JSON.stringify({ content: "This must not create a Turn." }),
        },
      ), ["chat", "sessions", sessionId, "messages"]);
      expect(response.status).toBe(503);
      await expect(prisma.chatTurn.count({ where: { sessionId } })).resolves.toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      env.CHAT_SERVICE_URL = previous;
    }
  });

  it("requires public sessions to pin the live published Release and its visual identity", async () => {
    const rolledBack = new Error("completed public Chat Release fixture");
    await expect(prisma.$transaction(async (tx) => {
      function inFixture<T>(run: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> { return run(tx); }
      // Keep append-only qualification evidence in a rollback fixture. These
      // bindings execute the production reads/writes against real PostgreSQL.
      const bindings = [
        vi.spyOn(prisma.character, "findFirst").mockImplementation(tx.character.findFirst),
        vi.spyOn(prisma.characterContentVersion, "findUnique").mockImplementation(tx.characterContentVersion.findUnique),
        vi.spyOn(prisma.recentChat, "findFirst").mockImplementation(tx.recentChat.findFirst),
        vi.spyOn(prisma.recentChat, "findUnique").mockImplementation(tx.recentChat.findUnique),
        vi.spyOn(prisma.recentChat, "create").mockImplementation(tx.recentChat.create),
        vi.spyOn(prisma.recentChat, "updateMany").mockImplementation(tx.recentChat.updateMany),
        vi.spyOn(prisma.moderationEvent, "create").mockImplementation(tx.moderationEvent.create),
        vi.spyOn(prisma, "$transaction").mockImplementation(inFixture),
      ];
      try {
        const suffix = randomUUID();
        const userId = `public-chat-user-${suffix}`;
        const characterId = `public-chat-character-${suffix}`;
        const contentId = `public-chat-content-${suffix}`;
        const contentV2Id = `public-chat-content-v2-${suffix}`;
        const releaseId = `public-chat-release-${suffix}`;
        const releaseV2Id = `public-chat-release-v2-${suffix}`;
        const visualId = `public-chat-visual-${suffix}`;
        const projectId = `project-${suffix}`;
        const placements = ["avatar", "hero", "chat"].map(slot => ({
          slotKey: `character_${slot}`,
          assetId: `public-chat-${slot}-${suffix}`,
          slotVersion: 1,
        }));
        const assetIds = placements.map(placement => placement.assetId);
        await tx.user.create({
          data: { id: userId, email: `${suffix}@chat.test`, emailVerified: true },
        });
        await tx.character.create({
          data: {
            id: characterId,
            name: "Released Companion",
            age: 26,
            description: "Release-only public fixture.",
            visibility: "public",
            status: "approved",
            appearance: {},
            advancedDetails: {},
          },
        });
        await tx.characterContentVersion.create({
          data: {
            id: contentId,
            characterId,
            version: 1,
            contentHash: createHash("sha256").update(contentId).digest("hex"),
            personaSnapshot: {},
            openingSnapshot: { firstMessage: "Hello." },
            appearanceSnapshot: {},
            sourceType: "test",
          },
        });
        await expect(createChatSession(userId, { characterId })).rejects.toThrow(
          "active Serving Release",
        );
        await tx.mediaAsset.createMany({
          data: assetIds.map(id => ({
            id, ownerId: userId, characterId, type: "image",
            url: `/user-content/${id}/content.webp`, storageKey: `tests/${id}.webp`,
            contentType: "image/webp", visibility: "public_pack", safetyStatus: "passed",
            metadata: { synthetic: false, provider: "pipeline" },
          })),
        });
        await tx.character.update({
          where: { id: characterId },
          data: { imageAssetId: assetIds[0], currentContentVersionId: contentId },
        });
        await tx.characterProject.create({ data: { id: projectId, characterId } });

        async function publishFixtureRelease(id: string, contentVersionId: string, revision: number) {
          const revisionId = `${id}-revision`;
          await tx.characterRevision.create({
            data: { id: revisionId, projectId, revision, characterContentVersionId: contentVersionId, projectSnapshot: {} },
          });
          const releasePlacements = placements.map(placement => ({
            ...placement,
            runId: `${id}:${placement.slotKey}:run`,
            itemId: `${id}:${placement.slotKey}:item`,
            reviewDecisionId: `${id}:${placement.slotKey}:decision`,
            generationJobId: `${id}:${placement.slotKey}:job`,
          }));
          const snapshot = {
            projectId, revisionId, characterContentVersionId: contentVersionId,
            visualProfileId: visualId, visualProfileVersion: 3, referenceSetRevisionId: null,
            generationProvenance: {
              schemaVersion: "character-release-generation-provenance-v2",
              policyVersion: "character-release-policy-v2",
              requiredReleaseRoute: {
                routeFingerprint: `${id}:route`, matrixKey: "chat-session-release-fixture",
                generationProfileKey: "chat-session-image-profile", generationProfileVersion: 1,
                workflowKey: "qwen-image-edit-img2img", workflowVersion: 2,
              },
              placements: releasePlacements.map(placement => ({ ...placement, provider: "pipeline" })),
            },
            releasePlacementManifest: { schemaVersion: 2, placements: releasePlacements },
          };
          const release = await tx.characterRelease.create({
            data: { id, ...snapshot, snapshotHash: characterReleaseSnapshotHash(snapshot),
              readiness: "ready", status: "published", publishedAt: new Date() },
          });
          const validation = await tx.releaseValidationRun.create({
            data: { releaseId: id, snapshotHash: release.snapshotHash,
              policyVersion: "character-release-policy-v2", result: "passed", finishedAt: new Date() },
          });
          await tx.publicCatalogQualification.create({
            data: { releaseId: id, releaseSnapshotHash: release.snapshotHash,
              kind: "generated_release", validationRunId: validation.id,
              evidence: { schemaVersion: "public-catalog-qualification-v1", policyVersion: "character-release-policy-v2" } },
          });
        }
        await tx.characterVisualProfile.create({
          data: {
            id: visualId,
            characterId,
            version: 3,
            status: "active",
            identityPrompt: "exact released identity",
            faceTraits: {},
            hairTraits: {},
            bodyTraits: {},
            signatureTraits: {},
            styleTraits: {},
            anchorAssetIds: [],
            adapterRefs: [],
            createdFrom: "test",
          },
        });
        await publishFixtureRelease(releaseId, contentId, 1);
        await tx.characterServing.create({
          data: { characterId, currentReleaseId: releaseId, state: "live" },
        });

        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
        const session = await createChatSession(userId, { characterId });
        await expect(tx.recentChat.findUniqueOrThrow({ where: { sessionId: session.id } }))
          .resolves.toMatchObject({
            characterContentVersionId: contentId,
            characterReleaseId: releaseId,
            characterVisualProfileId: visualId,
            characterVisualProfileVersion: 3,
          });

        await tx.characterContentVersion.create({
          data: {
            id: contentV2Id,
            characterId,
            version: 2,
            contentHash: createHash("sha256").update(contentV2Id).digest("hex"),
            personaSnapshot: {},
            openingSnapshot: { firstMessage: "Hello from release two." },
            appearanceSnapshot: {},
            sourceType: "test",
          },
        });
        await publishFixtureRelease(releaseV2Id, contentV2Id, 2);
        await tx.character.update({ where: { id: characterId }, data: { currentContentVersionId: contentV2Id } });
        await tx.characterServing.update({
          where: { characterId },
          data: { currentReleaseId: releaseV2Id },
        });

        const replacement = await createChatSession(userId, { characterId });
        expect(replacement.id).not.toBe(session.id);
        await expect(tx.recentChat.findUniqueOrThrow({ where: { sessionId: session.id } }))
          .resolves.toMatchObject({ status: "archived", activeKey: null });
        await expect(tx.recentChat.findUniqueOrThrow({ where: { sessionId: replacement.id } }))
          .resolves.toMatchObject({
            status: "active",
            activeKey: `${userId}:${characterId}`,
            characterContentVersionId: contentV2Id,
            characterReleaseId: releaseV2Id,
          });

        await tx.characterServing.update({
          where: { characterId },
          data: { state: "paused" },
        });
        await expect(beginChatTurn({
          userId,
          sessionId: replacement.id,
          content: "This must not run after Serving is paused.",
          idempotencyKey: `paused-serving-${suffix}`,
        })).rejects.toThrow("active Serving Release");
        await expect(tx.chatTurn.count({ where: { sessionId: replacement.id } })).resolves.toBe(0);

        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
        throw rolledBack;
      } finally {
        bindings.reverse().forEach(binding => binding.mockRestore());
      }
    }, { timeout: 10_000 })).rejects.toBe(rolledBack);
  });

  it("commits one Main Turn before admitting one signed local AgentRun", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `send-${randomUUID()}`;
    const response = await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ content: "Tell me something honest." }),
    }), ["chat", "sessions", sessionId, "messages"]);
    expect(response.status).toBe(202);
    const payload = await response.json() as {
      data: { userMessage: { id: string }; assistant: { id: string }; streamUrl: string };
    };
    expect(payload.data.streamUrl).toContain(payload.data.assistant.id);
    const turn = await prisma.chatTurn.findUniqueOrThrow({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: key } },
    });
    expect(turn).toMatchObject({
      userMessageId: payload.data.userMessage.id,
      assistantMessageId: payload.data.assistant.id,
      assistantStatus: "generating",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers; body: string }];
    expect(url).toMatch(/\/internal\/agent-runs$/u);
    const context = JSON.parse(init.headers.get("x-idream-bff-user")!) as BffContext;
    expect(context.authority?.character?.contentVersion?.contentVersionId).toBe(CONTENT_ID);
    expect(verifyBffContext({
      secret: env.CHAT_BFF_SIGNING_SECRET ?? SECRET,
      signature: init.headers.get("x-idream-bff")!,
      context,
      method: "POST",
      path: "/internal/agent-runs",
      body: String(init.body),
      now: Date.now(),
    })).toEqual({ ok: true });
  });

  it("keeps a committed Turn pending when Chat is unavailable and admits it on retry", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `retry-${randomUUID()}`;
    fetchMock.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));

    const response = await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ content: "Wait for the runtime." }),
    }), ["chat", "sessions", sessionId, "messages"]);

    expect(response.status).toBe(202);
    await expect(prisma.chatTurn.findUniqueOrThrow({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: key } },
    })).resolves.toMatchObject({ assistantStatus: "pending" });

    fetchMock.mockResolvedValue(Response.json({ ok: true }, { status: 202 }));
    await prisma.chatTurn.updateMany({
      where: { sessionId, idempotencyKey: key },
      data: { admissionNextRunAt: new Date(0) },
    });
    await expect(dispatchPendingChatAgentRuns()).resolves.toEqual({ admitted: 1, pending: 0 });
    await expect(prisma.chatTurn.findUniqueOrThrow({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: key } },
    })).resolves.toMatchObject({ assistantStatus: "generating" });
  });

  it("continues a pending admission batch after one frozen snapshot is corrupt", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `valid-after-corrupt-${randomUUID()}`;
    fetchMock.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
    await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ content: "Do not let an earlier bad snapshot starve this Turn." }),
    }), ["chat", "sessions", sessionId, "messages"]);

    const corruptSessionId = `corrupt-session-${randomUUID()}`;
    const corruptTurnId = `corrupt-turn-${randomUUID()}`;
    await prisma.recentChat.create({
      data: {
        sessionId: corruptSessionId,
        userId: USER_ID,
        characterId: CHARACTER_ID,
        status: "active",
        activeKey: null,
        memoryEnabled: true,
        characterContentVersionId: CONTENT_ID,
      },
    });
    await prisma.chatTurn.create({
      data: {
        id: corruptTurnId,
        sessionId: corruptSessionId,
        idempotencyKey: `corrupt-${randomUUID()}`,
        requestHash: "corrupt-snapshot-fixture",
        userMessageId: `corrupt-user-${randomUUID()}`,
        assistantMessageId: `corrupt-assistant-${randomUUID()}`,
        userContent: "corrupt fixture",
        userStatus: "sent",
        assistantContent: "",
        assistantStatus: "pending",
        characterContentVersionId: CONTENT_ID,
        memoryEnabled: true,
        executionSnapshot: { invalid: true },
        admissionNextRunAt: new Date(0),
      },
    });
    await prisma.chatTurn.updateMany({
      where: { sessionId, idempotencyKey: key },
      data: { admissionNextRunAt: new Date(1) },
    });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(Response.json({ ok: true }, { status: 202 }));

    await expect(dispatchPendingChatAgentRuns()).resolves.toEqual({ admitted: 1, pending: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(prisma.chatTurn.findUniqueOrThrow({ where: { id: corruptTurnId } }))
      .resolves.toMatchObject({
        assistantStatus: "pending",
        admissionAttempts: 1,
        admissionLastError: expect.objectContaining({
          message: expect.stringContaining("invalid frozen execution snapshot"),
        }),
      });
    await expect(prisma.chatTurn.findUniqueOrThrow({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: key } },
    })).resolves.toMatchObject({ assistantStatus: "generating" });
  });

  it("sends a durable cancel fence when Main changes during AgentRun admission", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `late-admission-${randomUUID()}`;
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/internal/agent-runs")) {
        const snapshot = JSON.parse(String(init?.body)) as { turnId: string };
        await prisma.chatTurn.update({
          where: { id: snapshot.turnId },
          data: { assistantStatus: "cancelled", terminalAt: new Date() },
        });
        return Response.json({ ok: true }, { status: 202 });
      }
      return Response.json({ ok: true });
    });

    await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ content: "Cancel the late admission." }),
    }), ["chat", "sessions", sessionId, "messages"]);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/internal\/agent-runs$/u),
      expect.stringMatching(/\/internal\/agent-runs\/[^/]+\/1\/cancel$/u),
    ]));
    await expect(prisma.chatTurn.findUniqueOrThrow({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: key } },
    })).resolves.toMatchObject({ assistantStatus: "cancelled" });
  });

  it("does not let an expired admission owner cancel the same run after a newer owner converges", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `stale-admission-${randomUUID()}`;
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/internal/agent-runs")) {
        const snapshot = JSON.parse(String(init?.body)) as { turnId: string };
        await prisma.chatTurn.update({
          where: { id: snapshot.turnId },
          data: {
            assistantStatus: "generating",
            admissionLeaseToken: null,
            admissionLeaseUntil: null,
          },
        });
        return Response.json({ ok: true }, { status: 202 });
      }
      return Response.json({ ok: true });
    });

    const response = await proxyChatRequest(authRequest(
      `/api/v1/chat/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "idempotency-key": key },
        body: JSON.stringify({ content: "Converge the exact admitted run." }),
      },
    ), ["chat", "sessions", sessionId, "messages"]);

    expect(response.status).toBe(202);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringMatching(/\/internal\/agent-runs$/u),
    ]);
    await expect(prisma.chatTurn.findUniqueOrThrow({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: key } },
    })).resolves.toMatchObject({ assistantStatus: "generating" });
  });

  it("retries with the Turn's immutable Character pin after the Session advances", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `pin-${randomUUID()}`;
    fetchMock.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
    await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ content: "Keep the admitted persona exact." }),
    }), ["chat", "sessions", sessionId, "messages"]);
    await prisma.recentChat.update({
      where: { sessionId },
      data: {
        characterContentVersionId: CONTENT_V2_ID,
        contextRevision: { increment: 1 },
      },
    });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(Response.json({ ok: true }, { status: 202 }));
    await prisma.chatTurn.updateMany({
      where: { sessionId, idempotencyKey: key },
      data: { admissionNextRunAt: new Date(0) },
    });

    await dispatchPendingChatAgentRuns();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers; body: string }];
    const context = JSON.parse(init.headers.get("x-idream-bff-user")!) as BffContext;
    expect(context.authority?.character?.contentVersion?.contentVersionId).toBe(CONTENT_ID);
    expect(JSON.parse(String(init.body))).toMatchObject({
      characterContentVersionId: CONTENT_ID,
      characterReleaseId: null,
      characterVisualProfileId: null,
      characterVisualProfileVersion: null,
      contextRevision: 0,
    });
  });

  it("commits without a lock inversion against a concurrent user-first Chat mutation", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const begun = await beginChatTurn({
      userId: USER_ID, sessionId, content: "Stay with me.", idempotencyKey: `lock-order-${randomUUID()}`,
    });
    const userLocked = Promise.withResolvers<number>();
    const continueMutation = Promise.withResolvers<void>();
    const mutation = prisma.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${USER_ID} FOR UPDATE`;
      userLocked.resolve(pid);
      await continueMutation.promise;
      await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${sessionId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "chat_turns" WHERE id = ${begun.snapshot!.turnId} FOR UPDATE`;
    }, { timeout: 10_000 });
    const pid = await userLocked.promise;
    const terminal = commitChatTerminal({
      version: 1, turnId: begun.snapshot!.turnId, sessionId,
      assistantMessageId: begun.assistant.id, attempt: 1, status: "sent",
      content: "I’m here.", model: "test-model", promptTokens: 10, completionTokens: 3,
      sceneVersion: 0, scene: null, terminalEvidence: TEST_TERMINAL_EVIDENCE,
    });
    // Attach rejection handlers before deliberately creating contention.
    const settled = Promise.allSettled([mutation, terminal]);
    try {
      await vi.waitFor(async () => {
        const rows = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))
          ) AS blocked`;
        expect(rows[0]?.blocked).toBe(true);
      }, { timeout: 2_000, interval: 10 });
    } finally {
      continueMutation.resolve();
    }
    const results = await settled;
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(results[1]).toMatchObject({ value: { accepted: true } });
  });

  it("stores only the selected final reply after Main acknowledges the terminal CAS", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `terminal-${randomUUID()}`;
    const sent = await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ content: "Stay with me." }),
    }), ["chat", "sessions", sessionId, "messages"]);
    const body = await sent.json() as { data: { assistant: { id: string } } };
    const turn = await prisma.chatTurn.findUniqueOrThrow({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: key } },
    });
    const committed = await commitChatTerminal({
      version: 1,
      turnId: turn.id,
      sessionId,
      assistantMessageId: turn.assistantMessageId,
      attempt: 1,
      status: "sent",
      content: "I’m here.",
      model: "test-model",
      promptTokens: 10,
      completionTokens: 3,
      sceneVersion: 1,
      scene: {
        schemaVersion: 1,
        version: 1,
        location: null,
        time: null,
        participants: [],
        emotionalBeat: "calm",
        unresolvedThreads: [],
      },
      terminalEvidence: TEST_TERMINAL_EVIDENCE,
    });
    expect(committed.accepted).toBe(true);

    const detail = await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}`), ["chat", "sessions", sessionId]);
    const detailBody = await detail.json() as { data: { session: { messages: Array<{ id: string; content: string }> } } };
    expect(detailBody.data.session.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: body.data.assistant.id, content: "I’m here." }),
    ]));
    expect(await prisma.chatTurn.count({ where: { id: turn.id } })).toBe(1);
    await expect(prisma.characterStats.findUniqueOrThrow({
      where: { characterId: CHARACTER_ID },
    })).resolves.toMatchObject({ chatsCount: 1 });

    await expect(commitChatTerminal({
      version: 1,
      turnId: turn.id,
      sessionId,
      assistantMessageId: turn.assistantMessageId,
      attempt: 1,
      status: "sent",
      content: "I’m here.",
      model: "test-model",
      promptTokens: 10,
      completionTokens: 3,
      sceneVersion: 1,
      scene: {
        schemaVersion: 1,
        version: 1,
        location: null,
        time: null,
        participants: [],
        emotionalBeat: "calm",
        unresolvedThreads: [],
      },
      terminalEvidence: TEST_TERMINAL_EVIDENCE,
    })).resolves.toMatchObject({ duplicate: true });
    await expect(prisma.mainOutboxEvent.findFirst({
      where: {
        eventType: MAIN_TO_CHAT_EVENTS.companionMemoryProjectRequestedV1,
        aggregateId: `${USER_ID}:${CHARACTER_ID}`,
        status: "pending",
      },
    })).resolves.toBeTruthy();
    await expect(commitChatTerminal({
      version: 1,
      turnId: turn.id,
      sessionId,
      assistantMessageId: turn.assistantMessageId,
      attempt: 1,
      status: "sent",
      content: "I’m here.",
      model: "test-model",
      promptTokens: 999,
      completionTokens: 3,
      sceneVersion: 1,
      scene: {
        schemaVersion: 1,
        version: 1,
        location: null,
        time: null,
        participants: [],
        emotionalBeat: "calm",
        unresolvedThreads: [],
      },
      terminalEvidence: TEST_TERMINAL_EVIDENCE,
    })).rejects.toThrow("lost the active attempt CAS");

    fetchMock.mockClear();
    const replay = await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ content: "Stay with me." }),
    }), ["chat", "sessions", sessionId, "messages"]);
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({ data: { streamUrl: null } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("durably delivers user cancellation for the exact AgentRun attempt", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const begun = await beginChatTurn({
      userId: USER_ID,
      sessionId,
      content: "Stop this reply.",
      idempotencyKey: `cancel-${randomUUID()}`,
    });

    await expect(cancelChatTurn(USER_ID, begun.assistant.id)).resolves.toMatchObject({
      turnId: begun.snapshot!.turnId,
      attempt: 1,
      cancelled: true,
    });
    const pending = await prisma.mainOutboxEvent.findFirstOrThrow({
      where: {
        eventType: MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1,
        aggregateId: begun.snapshot!.turnId,
      },
    });
    expect(pending).toMatchObject({ status: "pending" });
    expect(pending.payload).toMatchObject({
      payload: { version: 1, userId: USER_ID, turnId: begun.snapshot!.turnId, attempt: 1 },
    });

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(Response.json({ ok: true, active: false }));
    await expect(dispatchPendingChatEvents()).resolves.toEqual({ delivered: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledWith(
      `${env.CHAT_SERVICE_URL}/internal/agent-runs/${begun.snapshot!.turnId}/1/cancel`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("allows corrections only on the latest Turn and does not truncate descendants", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const first = await sendAndCommit(proxyChatRequest, sessionId, "First", "First reply");
    await sendAndCommit(proxyChatRequest, sessionId, "Second", "Second reply");

    await expect(regenerateChatTurn(USER_ID, first.assistantMessageId))
      .rejects.toThrow("Only the latest chat turn can be changed");
    await expect(editChatTurn(USER_ID, first.userMessageId, "Rewrite first"))
      .rejects.toThrow("Only the latest chat turn can be changed");
    await expect(deleteChatMessage(USER_ID, first.userMessageId))
      .rejects.toThrow("Only the latest chat turn can be changed");
    await expect(prisma.chatTurn.count({ where: { sessionId } })).resolves.toBe(2);
  });

  it("charges quota only for a new product Turn, never edit or regenerate", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const alreadyUsed = await prisma.chatTurnUsageFact.count({
      where: { userId: USER_ID, productDay: start },
    });
    const count = Math.max(1, FREE_DAILY_MESSAGES - alreadyUsed);
    for (let index = 0; index < count; index += 1) {
      const suffix = `${index}-${randomUUID()}`;
      await prisma.chatTurn.create({
        data: {
          id: `quota-${suffix}`,
          sessionId,
          idempotencyKey: `quota-${suffix}`,
          requestHash: `quota-${suffix}`,
          userMessageId: `quota-user-${suffix}`,
          assistantMessageId: `quota-assistant-${suffix}`,
          userContent: `quota message ${index}`,
          userStatus: "sent",
          assistantContent: `quota reply ${index}`,
          assistantStatus: "sent",
          terminalAt: new Date(),
          characterContentVersionId: CONTENT_ID,
          memoryEnabled: true,
        },
      });
      await prisma.chatTurnUsageFact.create({
        data: { turnId: `quota-${suffix}`, userId: USER_ID, productDay: start },
      });
    }
    const latest = await prisma.chatTurn.findFirstOrThrow({
      where: { sessionId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    await expect(editChatTurn(USER_ID, latest.userMessageId, "edited at the quota boundary"))
      .resolves.toMatchObject({ attempt: 2 });
    await settleMemoryRebuildAndTurn(latest.id);
    await expect(regenerateChatTurn(USER_ID, latest.assistantMessageId))
      .resolves.toMatchObject({ attempt: 3 });
    await settleMemoryRebuildAndTurn(latest.id);

    const response = await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": `over-quota-${randomUUID()}` },
      body: JSON.stringify({ content: "This is a new product Turn." }),
    }), ["chat", "sessions", sessionId, "messages"]);
    expect(response.status).toBe(402);
  });

  it("does not refund a daily message when its mutable Turn is deleted", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const turn = await sendAndCommit(proxyChatRequest, sessionId, "Count me once", "Counted.");
    await deleteChatMessage(USER_ID, turn.userMessageId);

    await expect(prisma.chatTurn.findUnique({ where: { id: turn.id } })).resolves.toBeNull();
    await expect(prisma.chatTurnUsageFact.findUnique({ where: { turnId: turn.id } }))
      .resolves.toMatchObject({ userId: USER_ID });
  });

  it("rebuilds companion memory from the remaining committed Main Turns after deletion", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const retained = await sendAndCommit(proxyChatRequest, sessionId, "Retain me", "Retained reply");
    const removed = await sendAndCommit(proxyChatRequest, sessionId, "Remove me", "Removed reply");
    await deleteChatMessage(USER_ID, removed.userMessageId);

    let uploaded = "";
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/internal/companion-memory/rebuild/prepare")) {
        uploaded = await new Response(init?.body).text();
        return Response.json({
          ok: true,
          rebuilt: {
            rebuildId: "11111111-1111-4111-8111-111111111111",
            sessions: 1,
            messages: 2,
          },
        });
      }
      if (target.endsWith("/internal/companion-memory/rebuild/promote")) {
        return Response.json({ ok: true, rebuilt: { sessions: 1, messages: 2 } });
      }
      return Response.json({ ok: true }, { status: 202 });
    });

    await expect(dispatchPendingChatEvents()).resolves.toEqual({ delivered: 1, failed: 0 });
    expect(uploaded).toContain(retained.userMessageId);
    expect(uploaded).toContain("Retain me");
    expect(uploaded).toContain('"mode":"rebuild"');
    expect(uploaded).not.toContain(removed.userMessageId);
    expect(uploaded).not.toContain("Remove me");
  });

  it("physically clears relationship memory and retires its old projection source", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `clear-memory-${randomUUID()}`;
    await beginChatTurn({
      userId: USER_ID,
      sessionId,
      content: "Forget this after memory is cleared.",
      idempotencyKey: key,
    });
    const turn = await prisma.chatTurn.findUniqueOrThrow({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: key } },
    });
    const terminal = {
      version: 1 as const,
      turnId: turn.id,
      sessionId,
      assistantMessageId: turn.assistantMessageId,
      attempt: turn.attempt,
      status: "sent" as const,
      content: "This was remembered before the clear.",
      model: "test-model",
      promptTokens: 3,
      completionTokens: 4,
      sceneVersion: turn.sceneVersion,
      scene: null,
      terminalEvidence: TEST_TERMINAL_EVIDENCE,
    };
    await commitChatTerminal(terminal);
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/internal/companion-memory/purge")) {
        expect(await new Response(init?.body).json()).toEqual({
          scope: "relationship",
          userId: USER_ID,
          characterId: CHARACTER_ID,
        });
        return Response.json({ ok: true, purged: 1 });
      }
      return Response.json({ ok: true }, { status: 202 });
    });

    const response = await proxyChatRequest(
      authRequest(`/api/v1/chat/memory/${CHARACTER_ID}`, { method: "DELETE" }),
      ["chat", "memory", CHARACTER_ID],
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      archived: true,
      purgeQueued: true,
    });
    await expect(dispatchPendingChatEvents()).resolves.toEqual({ delivered: 1, failed: 0 });
    await expect(prisma.recentChat.findUniqueOrThrow({ where: { sessionId } }))
      .resolves.toMatchObject({ status: "archived", activeKey: null, memoryEnabled: false });
    await expect(prisma.chatTurn.findUniqueOrThrow({ where: { id: turn.id } }))
      .resolves.toMatchObject({ memoryEnabled: false });
    await expect(commitChatTerminal(terminal)).resolves.toMatchObject({ duplicate: true });
    await expect(prisma.mainOutboxEvent.count({
      where: {
        aggregateId: `${USER_ID}:${CHARACTER_ID}`,
        eventType: MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1,
      },
    })).resolves.toBe(0);
  });

  it("keeps Chat available without long-term memory while a destructive rebuild is pending", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const original = await sendAndCommit(
      proxyChatRequest,
      sessionId,
      "Remember the blue observatory.",
      "I will remember it.",
    );

    const edited = await editChatTurn(USER_ID, original.userMessageId, "Use the red observatory instead.");
    expect(edited.snapshot?.memoryEnabled).toBe(false);
    await commitChatTerminal({
      version: 1,
      turnId: original.id,
      sessionId,
      assistantMessageId: original.assistantMessageId,
      attempt: original.attempt + 1,
      status: "failed",
      content: "The reply could not be completed.",
      model: "test-model",
      promptTokens: 1,
      completionTokens: 1,
      sceneVersion: original.sceneVersion,
      scene: original.scene,
      terminalEvidence: TEST_TERMINAL_EVIDENCE,
    });
    await expect(prisma.mainOutboxEvent.findFirst({
      where: {
        eventType: MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1,
        aggregateId: `${USER_ID}:${CHARACTER_ID}`,
        status: "pending",
      },
    })).resolves.toBeTruthy();

    const next = await beginChatTurn({
      userId: USER_ID,
      sessionId,
      content: "Can we keep talking now?",
      idempotencyKey: `memory-isolation-${randomUUID()}`,
    });
    expect(next.snapshot?.memoryEnabled).toBe(false);
    expect(next.assistant.status).toBe("pending");
  });

  it("edits against the Scene before the discarded reply", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `scene-edit-${randomUUID()}`;
    const begun = await beginChatTurn({
      userId: USER_ID,
      sessionId,
      content: "We are in Paris.",
      idempotencyKey: key,
    });
    await commitChatTerminal({
      version: 1,
      turnId: begun.snapshot!.turnId,
      sessionId,
      assistantMessageId: begun.assistant.id,
      attempt: 1,
      status: "sent",
      content: "Paris is beautiful tonight.",
      model: "test-model",
      promptTokens: 1,
      completionTokens: 1,
      sceneVersion: 1,
      scene: {
        schemaVersion: 1,
        version: 1,
        location: "Paris",
        time: null,
        participants: [],
        emotionalBeat: null,
        unresolvedThreads: [],
      },
      terminalEvidence: TEST_TERMINAL_EVIDENCE,
    });

    const edited = await editChatTurn(USER_ID, begun.userMessage.id, "We are in Tokyo.");
    expect(edited.snapshot).toMatchObject({
      attempt: 2,
      userContent: "We are in Tokyo.",
      sceneVersion: 0,
      scene: null,
    });
  });

  it("shows attachments only for the selected attempt and never exposes effect metadata", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `attachment-attempt-${randomUUID()}`;
    await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ content: "Send a portrait." }),
    }), ["chat", "sessions", sessionId, "messages"]);
    const turn = await prisma.chatTurn.findUniqueOrThrow({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: key } },
    });
    await commitChatTerminal({
      version: 1,
      turnId: turn.id,
      sessionId,
      assistantMessageId: turn.assistantMessageId,
      attempt: 1,
      status: "sent",
      content: "Here it is.",
      model: "test-model",
      promptTokens: 2,
      completionTokens: 3,
      sceneVersion: 0,
      scene: null,
      terminalEvidence: TEST_TERMINAL_EVIDENCE,
    });
    await prisma.chatTurnAttachment.create({
      data: {
        id: `attachment-${randomUUID()}`,
        turnId: turn.id,
        kind: "generated_image",
        status: "completed",
        promptHint: "private prompt hint",
        metadata: {
          attempt: 1,
          effect: { attempt: 1, requestDigest: "private-digest" },
        },
      },
    });

    const first = await proxyChatRequest(
      authRequest(`/api/v1/chat/sessions/${sessionId}`),
      ["chat", "sessions", sessionId],
    );
    const firstText = await first.text();
    expect(firstText).toContain("generated_image");
    expect(firstText).not.toContain("private-digest");

    await regenerateChatTurn(USER_ID, turn.assistantMessageId);
    const regenerated = await proxyChatRequest(
      authRequest(`/api/v1/chat/sessions/${sessionId}`),
      ["chat", "sessions", sessionId],
    );
    const body = await regenerated.json() as {
      data: { session: { messages: Array<{ id: string; attachments: unknown[] }> } };
    };
    expect(body.data.session.messages.find((message) => message.id === turn.assistantMessageId)?.attachments)
      .toEqual([]);
  });

  it("freezes recent delivered-image context for shorthand edit intent", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const first = await beginChatTurn({
      userId: USER_ID,
      sessionId,
      content: "Send a portrait.",
      idempotencyKey: `image-context-first-${randomUUID()}`,
    });
    if (!first.snapshot) throw new Error("first Chat snapshot was not created");
    await commitChatTerminal({
      version: 1,
      turnId: first.snapshot.turnId,
      sessionId,
      assistantMessageId: first.assistant.id,
      attempt: 1,
      status: "sent",
      content: "For you.",
      model: null,
      promptTokens: null,
      completionTokens: null,
      sceneVersion: 0,
      scene: null,
      terminalEvidence: TEST_TERMINAL_EVIDENCE,
    });
    await prisma.chatTurnAttachment.create({
      data: {
        id: `attachment-${randomUUID()}`,
        turnId: first.snapshot.turnId,
        kind: "generated_image",
        status: "completed",
        mediaAssetId: `media-${randomUUID()}`,
        metadata: { attempt: 1 },
      },
    });

    const second = await beginChatTurn({
      userId: USER_ID,
      sessionId,
      content: "换个姿势",
      idempotencyKey: `image-context-second-${randomUUID()}`,
    });

    expect(second.snapshot?.hasRecentImageContext).toBe(true);
  });

  it("replays an accepted ToolEffect after the Turn is terminal without charging again", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `effect-${randomUUID()}`;
    await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ content: "Send a portrait from the garden." }),
    }), ["chat", "sessions", sessionId, "messages"]);
    const turn = await prisma.chatTurn.findUniqueOrThrow({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: key } },
    });
    await commitChatTerminal({
      version: 1,
      turnId: turn.id,
      sessionId,
      assistantMessageId: turn.assistantMessageId,
      attempt: 1,
      status: "sent",
      content: "I picked the quiet corner for this one.",
      model: "test-model",
      promptTokens: 4,
      completionTokens: 8,
      sceneVersion: 0,
      scene: null,
      terminalEvidence: TEST_TERMINAL_EVIDENCE,
    });
    const callId = "tool-call-1";
    const args = {
      prompt: "A detailed portrait in a quiet garden",
      orientation: "4:5" as const,
      outputCount: 1,
    };
    const attachmentId = `chatfx_${createHash("sha256")
      .update(`${turn.id}:1:${callId}`)
      .digest("hex")
      .slice(0, 48)}`;
    const requestDigest = createHash("sha256")
      .update(JSON.stringify({
        arguments: { orientation: "4:5", outputCount: 1, prompt: args.prompt },
        name: "generate_image_async",
      }))
      .digest("hex");
    await prisma.chatTurnAttachment.create({
      data: {
        id: attachmentId,
        turnId: turn.id,
        kind: "generated_image",
        status: "accepted",
        metadata: {
          effect: { turnId: turn.id, attempt: 1, callId, name: "generate_image_async", requestDigest },
          costDreamcoins: 5,
        },
      },
    });

    await expect(applyChatToolEffect({
      version: 2,
      turnId: turn.id,
      attempt: 1,
      callId,
      name: "generate_image_async",
      effectScope: "attempt",
      intent: { requestedNudity: "unspecified" },
      arguments: args,
    })).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
      attachmentId,
      costDreamcoins: 5,
    });
  });

  it("reuses one required image effect across assistant regenerate attempts", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `required-effect-${randomUUID()}`;
    await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ content: "Send a portrait from the garden." }),
    }), ["chat", "sessions", sessionId, "messages"]);
    const turn = await prisma.chatTurn.findUniqueOrThrow({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: key } },
    });
    const callId = "model-tool-call-1";
    const args = {
      prompt: "A detailed portrait in a quiet garden",
      orientation: "4:5" as const,
      outputCount: 1,
    };
    const attachmentId = `chatfx_${createHash("sha256")
      .update(`${turn.id}:generate_image_async`)
      .digest("hex")
      .slice(0, 48)}`;
    const requestDigest = createHash("sha256")
      .update(JSON.stringify({
        arguments: { orientation: "4:5", outputCount: 1, prompt: args.prompt },
        name: "generate_image_async",
      }))
      .digest("hex");
    await prisma.chatTurnAttachment.create({
      data: {
        id: attachmentId,
        turnId: turn.id,
        kind: "generated_image",
        status: "accepted",
        generationJobId: "existing-job",
        metadata: {
          attempt: 1,
          effect: {
            turnId: turn.id,
            attempt: 1,
            callId,
            name: "generate_image_async",
            effectScope: "turn_action",
            intent: { requestedNudity: "unspecified" },
            requestDigest,
          },
          costDreamcoins: 5,
        },
      },
    });
    await commitChatTerminal({
      version: 1,
      turnId: turn.id,
      sessionId,
      assistantMessageId: turn.assistantMessageId,
      attempt: 1,
      status: "sent",
      content: "For you.",
      model: null,
      promptTokens: null,
      completionTokens: null,
      sceneVersion: 0,
      scene: null,
      terminalEvidence: TEST_TERMINAL_EVIDENCE,
    });
    await regenerateChatTurn(USER_ID, turn.assistantMessageId);

    await expect(applyChatToolEffect({
      version: 2,
      turnId: turn.id,
      attempt: 2,
      callId,
      name: "generate_image_async",
      effectScope: "turn_action",
      intent: { requestedNudity: "unspecified" },
      arguments: {
        ...args,
        prompt: "A differently worded detailed portrait in the same quiet garden",
      },
    })).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
      attachmentId,
      generationJobId: "existing-job",
      costDreamcoins: 5,
    });
    await expect(prisma.chatTurnAttachment.findUniqueOrThrow({
      where: { id: attachmentId },
    })).resolves.toMatchObject({
      metadata: expect.objectContaining({
        attempt: 2,
        effect: expect.objectContaining({ attempt: 2 }),
      }),
    });
  });

  it("rechecks image capability at the Main ToolEffect authority", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `disabled-effect-${randomUUID()}`;
    await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ content: "Send a portrait." }),
    }), ["chat", "sessions", sessionId, "messages"]);
    const turn = await prisma.chatTurn.findUniqueOrThrow({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: key } },
    });
    await prisma.character.update({
      where: { id: CHARACTER_ID },
      data: { advancedDetails: { imageToolEnabled: false } },
    });
    try {
      await expect(applyChatToolEffect({
        version: 2,
        turnId: turn.id,
        attempt: 1,
        callId: "model-tool-call-1",
        name: "generate_image_async",
        effectScope: "turn_action",
        intent: { requestedNudity: "unspecified" },
        arguments: {
          prompt: "A detailed portrait beside a sunlit window",
          orientation: "4:5",
          outputCount: 1,
        },
      })).rejects.toThrow("Image generation is unavailable for this Chat");
      await expect(prisma.chatTurnAttachment.count({ where: { turnId: turn.id } }))
        .resolves.toBe(0);
    } finally {
      await prisma.character.update({
        where: { id: CHARACTER_ID },
        data: { advancedDetails: { imageToolEnabled: true } },
      });
    }
  });

  it("redacts generated-image source text in the same Main mutation that edits or deletes Chat", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const sessionId = await ensureSession(proxyChatRequest);
    const key = `privacy-${randomUUID()}`;
    await proxyChatRequest(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ content: "Keep this private description." }),
    }), ["chat", "sessions", sessionId, "messages"]);
    const turn = await prisma.chatTurn.findUniqueOrThrow({
      where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: key } },
    });
    await commitChatTerminal({
      version: 1,
      turnId: turn.id,
      sessionId,
      assistantMessageId: turn.assistantMessageId,
      attempt: 1,
      status: "sent",
      content: "Understood.",
      model: "test-model",
      promptTokens: 2,
      completionTokens: 2,
      sceneVersion: 0,
      scene: null,
      terminalEvidence: TEST_TERMINAL_EVIDENCE,
    });

    const editedJobId = `chat-privacy-edit-${randomUUID()}`;
    await prisma.generationJob.create({
      data: {
        id: editedJobId,
        userId: USER_ID,
        mode: "image",
        controls: {},
        presetIds: [],
        sourceType: "chat_image",
        sourceId: `chat-privacy-source-${randomUUID()}`,
        sourceMeta: {
          sessionId,
          exchangeId: turn.id,
          messageId: turn.assistantMessageId,
          promptHint: "private prompt",
          conversationContext: "private conversation",
        },
      },
    });
    await editChatTurn(USER_ID, turn.userMessageId, "Use the revised description.");
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: editedJobId } }))
      .toMatchObject({
        sourceMeta: {
          promptHint: null,
          conversationContext: null,
          privacyRedaction: {
            authority: "main_turn_ledger",
            reason: "logical_turn_edited",
          },
        },
      });

    await prisma.mainOutboxEvent.updateMany({
      where: {
        eventType: MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1,
        aggregateId: `${USER_ID}:${CHARACTER_ID}`,
        status: "pending",
      },
      data: { status: "delivered", deliveredAt: new Date() },
    });
    await prisma.chatTurn.update({
      where: { id: turn.id },
      data: { assistantStatus: "failed", terminalAt: new Date() },
    });

    const deletedJobId = `chat-privacy-delete-${randomUUID()}`;
    await prisma.generationJob.create({
      data: {
        id: deletedJobId,
        userId: USER_ID,
        mode: "image",
        controls: {},
        presetIds: [],
        sourceType: "chat_image",
        sourceId: `chat-privacy-source-${randomUUID()}`,
        sourceMeta: {
          sessionId,
          promptHint: "session prompt",
          conversationContext: "session conversation",
        },
      },
    });
    await deleteChatSession(USER_ID, sessionId);
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: deletedJobId } }))
      .toMatchObject({
        sourceMeta: {
          promptHint: null,
          conversationContext: null,
          privacyRedaction: {
            authority: "main_turn_ledger",
            reason: "session_deleted",
          },
        },
      });
    await prisma.generationJob.deleteMany({ where: { id: { in: [editedJobId, deletedJobId] } } });
  });
});

function authRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("x-idream-user-id", USER_ID);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function ensureSession(proxy: typeof import("./chat-proxy").proxyChatRequest): Promise<string> {
  const response = await proxy(authRequest("/api/v1/chat/sessions", {
    method: "POST",
    body: JSON.stringify({ characterId: CHARACTER_ID }),
  }), ["chat", "sessions"]);
  const body = await response.json() as { data: { session: { id: string } } };
  return body.data.session.id;
}

async function sendAndCommit(
  proxy: typeof import("./chat-proxy").proxyChatRequest,
  sessionId: string,
  userContent: string,
  assistantContent: string,
) {
  const idempotencyKey = `fixture-${randomUUID()}`;
  const response = await proxy(authRequest(`/api/v1/chat/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({ content: userContent }),
  }), ["chat", "sessions", sessionId, "messages"]);
  if (response.status !== 202) throw new Error(`fixture Turn returned ${response.status}`);
  const turn = await prisma.chatTurn.findUniqueOrThrow({
    where: { sessionId_idempotencyKey: { sessionId, idempotencyKey } },
  });
  await commitChatTerminal({
    version: 1,
    turnId: turn.id,
    sessionId,
    assistantMessageId: turn.assistantMessageId,
    attempt: turn.attempt,
    status: "sent",
    content: assistantContent,
    model: "test-model",
    promptTokens: 1,
    completionTokens: 1,
    sceneVersion: turn.sceneVersion,
    scene: turn.scene,
    terminalEvidence: TEST_TERMINAL_EVIDENCE,
  });
  return turn;
}

async function settleMemoryRebuildAndTurn(turnId: string): Promise<void> {
  await prisma.mainOutboxEvent.updateMany({
    where: {
      eventType: MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1,
      aggregateId: `${USER_ID}:${CHARACTER_ID}`,
      status: "pending",
    },
    data: { status: "delivered", deliveredAt: new Date() },
  });
  await prisma.chatTurn.update({
    where: { id: turnId },
    data: { assistantStatus: "failed", terminalAt: new Date() },
  });
}
