import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { dispatchV1 } from "./service";
import { jobQueue } from "@/server/jobs/queue";
import { drainLocalAiPipeline } from "@/server/ai/local-pipeline";
import {
  api,
  createCharacter,
  createUser,
  expectOk,
  grantCoins,
  purgeTestData,
} from "@/server/test/helpers";

const P = "zt-pipe-";
const SYS = `${P}sys`;
const CHAR = `${P}char`;
const cleanupJobDedupeKeys: string[] = [];
const cleanupModerationTargetIds: string[] = [];

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: SYS });
  await createCharacter({
    id: CHAR,
    creatorId: SYS,
    visibility: "public",
    status: "approved",
    systemPrompt: "Stay warm and concise.",
  });
});

afterAll(async () => {
  for (const dedupeKey of cleanupJobDedupeKeys) {
    await jobQueue.removeByDedupePrefix(dedupeKey, [
      "ai.chat.generate",
      "ai.memory.sync",
      "ai.memory.forget",
      "ai.memory.rebuild",
      "ai.image.generate",
      "ai.video.generate",
      "app.ai.finalize",
    ]);
  }
  await prisma.moderationEvent.deleteMany({
    where: { targetId: { in: cleanupModerationTargetIds } },
  });
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("local AI service pipeline", () => {
  it("queues chat generation, finalizes the assistant message, and exposes SSE replay", async () => {
    const userId = `${P}chat-user`;
    await createUser({ id: userId, displayName: "Kai" });

    const session = await api("POST", "chat/sessions", {
      userId,
      ageGate: true,
      body: { characterId: CHAR },
    });
    expectOk(session);
    const sessionId = session.data.session.id as string;
    cleanupModerationTargetIds.push(sessionId);

    const send = await api("POST", `chat/sessions/${sessionId}/messages`, {
      userId,
      ageGate: true,
      body: { content: "hello, call me Kai" },
    });
    expectOk(send);
    const assistantId = send.data.assistantMessageId as string;
    cleanupJobDedupeKeys.push(
      `chat:${assistantId}`,
      `chat-finalize:${assistantId}`,
      `memory-sync:${assistantId}`,
    );
    cleanupModerationTargetIds.push(assistantId);

    expect(send.data.streamUrl).toBe(`/api/v1/chat/streams/${assistantId}`);
    expect(send.data.assistant).toMatchObject({
      id: assistantId,
      role: "assistant",
      status: "sent",
    });
    expect(String(send.data.assistant.content)).toContain("Mock");

    const chatJob = await jobQueue.getByDedupeKey("ai.chat.generate", `chat:${assistantId}`);
    const finalizeJob = await jobQueue.getByDedupeKey(
      "app.ai.finalize",
      `chat-finalize:${assistantId}`,
    );
    expect(chatJob).toMatchObject({ queue: "ai.chat.generate", state: "completed" });
    expect(finalizeJob).toMatchObject({ queue: "app.ai.finalize", state: "completed" });
    const memorySyncJob = await jobQueue.getByDedupeKey(
      "ai.memory.sync",
      `memory-sync:${assistantId}`,
    );
    expect(memorySyncJob).toMatchObject({ queue: "ai.memory.sync", state: "completed" });

    const streamResponse = await dispatchV1(
      new Request(`http://localhost/api/v1/chat/streams/${assistantId}`, {
        method: "GET",
        headers: { "x-idream-user-id": userId },
      }),
      ["chat", "streams", assistantId],
    );
    expect(streamResponse.status).toBe(200);
    const streamText = await streamResponse.text();
    expect(streamText).toContain("event: delta");
    expect(streamText).toContain("event: done");

    const reloaded = await api("GET", `chat/sessions/${sessionId}`, { userId });
    expect(reloaded.data.session.memorySummary).toContain("call me Kai");

    const memory = await prisma.companionMemory.findFirstOrThrow({
      where: { userId, characterId: CHAR, status: "active" },
    });
    expect(memory.text).toContain("Kai");
    expect(memory.sourceMessageIds).toContain(userMessageId(send));

    const relationship = await prisma.relationshipState.findUnique({
      where: { userId_characterId: { userId, characterId: CHAR } },
    });
    expect(relationship?.signals).toMatchObject({ turns: 1, warmth: 1 });

    const relationshipApi = await api("GET", `chat/relationships/${CHAR}`, { userId });
    expectOk(relationshipApi);
    expect(relationshipApi.data.relationship.stage).toBe("new");

    const patchedRelationship = await api("PATCH", `chat/relationships/${CHAR}`, {
      userId,
      body: { stage: "close", boundaries: ["no spoilers"] },
    });
    expectOk(patchedRelationship);
    expect(patchedRelationship.data.relationship).toMatchObject({ stage: "close" });
    expect(patchedRelationship.data.relationship.boundaries).toEqual(["no spoilers"]);

    const memories = await api("GET", "chat/memories", {
      userId,
      query: { characterId: CHAR },
    });
    expectOk(memories);
    expect((memories.data.items as Array<{ id: string }>).map((item) => item.id)).toContain(
      memory.id,
    );

    const edited = await api("PATCH", `chat/memories/${memory.id}`, {
      userId,
      body: { text: "User prefers the nickname Kai." },
    });
    expectOk(edited);
    expect(edited.data.memory.text).toBe("User prefers the nickname Kai.");

    const deleted = await api("DELETE", `chat/memories/${memory.id}`, { userId });
    expectOk(deleted);
    cleanupJobDedupeKeys.push(`memory-forget:memory_delete:${userId}:${memory.id}`);
    expect(await prisma.companionMemory.count({ where: { id: memory.id, status: "active" } })).toBe(0);

    const forgottenEvent = await prisma.analyticsEvent.findFirst({
      where: { userId, name: "memory_forgotten" },
    });
    expect(forgottenEvent).not.toBeNull();

    const deletedRelationship = await api("DELETE", `chat/relationships/${CHAR}`, { userId });
    expectOk(deletedRelationship);
    cleanupJobDedupeKeys.push(`memory-forget:runtime_rebuild:${userId}:${CHAR}`);
    expect(
      await prisma.relationshipState.count({ where: { userId, characterId: CHAR } }),
    ).toBe(0);
  });

  it("injects saved memories into later chat payloads and honors no-memory mode", async () => {
    const userId = `${P}memory-user`;
    await createUser({ id: userId, displayName: "Memory User" });

    const firstSession = await api("POST", "chat/sessions", {
      userId,
      ageGate: true,
      body: { characterId: CHAR },
    });
    expectOk(firstSession);
    const firstSessionId = firstSession.data.session.id as string;
    cleanupModerationTargetIds.push(firstSessionId);

    const firstSend = await api("POST", `chat/sessions/${firstSessionId}/messages`, {
      userId,
      ageGate: true,
      body: { content: "i like stargazing" },
    });
    expectOk(firstSend);
    const firstAssistantId = firstSend.data.assistantMessageId as string;
    cleanupJobDedupeKeys.push(`chat:${firstAssistantId}`, `chat-finalize:${firstAssistantId}`);
    cleanupModerationTargetIds.push(firstAssistantId);

    const saved = await prisma.companionMemory.findFirstOrThrow({
      where: { userId, characterId: CHAR, status: "active" },
    });
    expect(saved.text).toContain("stargazing");

    const archive = await api("DELETE", `chat/sessions/${firstSessionId}`, { userId });
    expectOk(archive);

    const secondSession = await api("POST", "chat/sessions", {
      userId,
      ageGate: true,
      body: { characterId: CHAR },
    });
    expectOk(secondSession);
    const secondSessionId = secondSession.data.session.id as string;
    cleanupModerationTargetIds.push(secondSessionId);

    const secondSend = await api("POST", `chat/sessions/${secondSessionId}/messages`, {
      userId,
      ageGate: true,
      body: { content: "what do you remember?" },
    });
    expectOk(secondSend);
    const secondAssistantId = secondSend.data.assistantMessageId as string;
    cleanupJobDedupeKeys.push(`chat:${secondAssistantId}`, `chat-finalize:${secondAssistantId}`);
    cleanupModerationTargetIds.push(secondAssistantId);

    const secondJob = await jobQueue.getByDedupeKey("ai.chat.generate", `chat:${secondAssistantId}`);
    if (!secondJob) throw new Error("Expected second chat job");
    const secondPayload = secondJob.payload as {
      context?: { longTermMemories?: Array<{ text?: string }> };
      mode?: string;
    };
    expect(secondPayload.mode).toBe("normal");
    expect(secondPayload.context?.longTermMemories?.map((memory) => memory.text)).toContain(
      saved.text,
    );

    const noMemory = await api("POST", `chat/sessions/${secondSessionId}/no-memory`, { userId });
    expectOk(noMemory);
    cleanupJobDedupeKeys.push(
      `memory-forget:session_no_memory:${userId}:${secondSessionId}`,
    );

    const thirdSend = await api("POST", `chat/sessions/${secondSessionId}/messages`, {
      userId,
      ageGate: true,
      body: { content: "i like ramen" },
    });
    expectOk(thirdSend);
    const thirdAssistantId = thirdSend.data.assistantMessageId as string;
    cleanupJobDedupeKeys.push(`chat:${thirdAssistantId}`, `chat-finalize:${thirdAssistantId}`);
    cleanupModerationTargetIds.push(thirdAssistantId);

    const thirdJob = await jobQueue.getByDedupeKey("ai.chat.generate", `chat:${thirdAssistantId}`);
    if (!thirdJob) throw new Error("Expected third chat job");
    const thirdPayload = thirdJob.payload as {
      context?: { longTermMemories?: Array<{ text?: string }> };
      mode?: string;
      policy?: { allowMemoryWrite?: boolean };
    };
    expect(thirdPayload.mode).toBe("no_memory");
    expect(thirdPayload.policy?.allowMemoryWrite).toBe(false);
    expect(thirdPayload.context?.longTermMemories).toEqual([]);
    expect(
      await prisma.companionMemory.count({
        where: { userId, text: { contains: "ramen" }, status: "active" },
      }),
    ).toBe(0);
  });

  it("queues image generation and creates media through the finalize queue", async () => {
    const userId = `${P}gen-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 2 },
    });
    expectOk(gen);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(
      `generation:${jobId}`,
      `generation-finalize:${jobId}:completed`,
    );
    cleanupModerationTargetIds.push(jobId);

    expect(gen.data.job.status).toBe("completed");
    expect(gen.data.assets).toHaveLength(2);

    const generateJob = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`);
    const finalizeJob = await jobQueue.getByDedupeKey(
      "app.ai.finalize",
      `generation-finalize:${jobId}:completed`,
    );
    expect(generateJob).toMatchObject({ queue: "ai.image.generate", state: "completed" });
    expect(finalizeJob).toMatchObject({ queue: "app.ai.finalize", state: "completed" });

    const asset = await prisma.mediaAsset.findFirstOrThrow({
      where: { sourceJobId: jobId },
    });
    expect(asset.metadata).toMatchObject({
      provider: "mock-pipeline",
      contentType: "image/webp",
    });
  });

  it("rebuilds memory runtime state from an authoritative snapshot", async () => {
    const userId = `${P}rebuild-user`;
    await createUser({ id: userId });
    const oldMemory = await prisma.companionMemory.create({
      data: {
        id: `${P}old-memory`,
        userId,
        characterId: CHAR,
        scope: "character",
        type: "preference",
        text: "User likes stale context.",
        confidence: 0.9,
        status: "active",
        sourceMessageIds: [],
      },
    });

    await jobQueue.enqueue({
      queue: "ai.memory.rebuild",
      payload: {
        version: 1,
        kind: "memory.rebuild",
        requestId: `${P}memory-rebuild`,
        userId,
        characterId: CHAR,
        source: {
          memorySnapshotVersion: 2,
          memories: [
            {
              id: `${P}new-memory`,
              scope: "character",
              type: "preference",
              text: "User likes fresh context.",
              confidence: 0.92,
              sourceMessageIds: [],
            },
          ],
        },
      },
      dedupeKey: `${P}memory-rebuild`,
    });
    cleanupJobDedupeKeys.push(`${P}memory-rebuild`);

    const drained = await drainLocalAiPipeline({
      queues: ["ai.memory.rebuild"],
      limit: 1,
    });
    expect(drained.processed).toBe(1);

    const stale = await prisma.companionMemory.findUnique({ where: { id: oldMemory.id } });
    const fresh = await prisma.companionMemory.findUnique({ where: { id: `${P}new-memory` } });
    expect(stale?.status).toBe("deleted");
    expect(fresh).toMatchObject({
      userId,
      characterId: CHAR,
      text: "User likes fresh context.",
      status: "active",
    });
  });
});

function userMessageId(result: { data: { userMessage?: { id?: string } } }) {
  const id = result.data.userMessage?.id;
  expect(typeof id).toBe("string");
  return id as string;
}
