import { randomUUID } from "node:crypto";
import { CHAT_SEND_PROTOCOL_VERSION, MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { compileCharacterSoul } from "@idream/shared";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { companionRelationshipAggregateId } from "./companion-memory-authority";
import { beginChatTurn, createChatSession, deleteChatMessage, editChatTurn, regenerateChatTurn } from "./turn-ledger";

// SPEC: a revision or delete rebuilds relationship memory only when the
// superseded attempt can be in it (sent user message + sent reply + memory on).
const prefix = `zt-conditional-rebuild-${randomUUID()}-`;

afterAll(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await prisma.companionMemoryAuthority.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await prisma.chatTurnUsageFact.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.recentChat.deleteMany({ where: { userId: { startsWith: prefix } } });
  await purgeTestData(prefix);
});

async function fixture() {
  const userId = `${prefix}${randomUUID()}`;
  await createUser({ id: userId });
  const character = await createCharacter({ id: `${userId}-character`, creatorId: userId, source: "user", visibility: "private" });
  const soul = compileCharacterSoul({
    name: "Mira", age: 28, gender: "female", characterPromise: "A warm companion", detailsMarkdown: "Warm and curious.",
  });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const content = await prisma.characterContentVersion.create({ data: {
    characterId: character.id, version: 1, sourceType: "test", contentHash: soul.snapshot.compiled.fingerprint,
    personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: {},
  } });
  await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
  const session = await createChatSession(userId, { characterId: character.id });
  return { userId, characterId: character.id, sessionId: session.id, aggregateId: companionRelationshipAggregateId(userId, character.id) };
}

async function sendAndFinish(f: Awaited<ReturnType<typeof fixture>>, status: "sent" | "failed" | "cancelled") {
  const begun = await beginChatTurn({
    sendProtocolVersion: CHAT_SEND_PROTOCOL_VERSION, userId: f.userId, sessionId: f.sessionId,
    content: "My sister is called Ada.", idempotencyKey: randomUUID(),
  });
  const turnId = begun.snapshot!.turnId;
  await finish(turnId, status);
  return { turnId, assistantId: begun.assistant.id, userMessageId: begun.userMessage.id };
}

/** The terminal commit itself is covered elsewhere; here only its resulting state matters. */
async function finish(turnId: string, status: "sent" | "failed" | "cancelled") {
  await prisma.chatTurn.update({ where: { id: turnId }, data: {
    assistantStatus: status, assistantContent: status === "sent" ? "Ada, got it." : "", terminalAt: new Date(),
  } });
}

function memoryEvents(aggregateId: string) {
  return prisma.mainOutboxEvent.findMany({
    where: { aggregateId, eventType: MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1 },
    select: { status: true, payload: true },
  });
}

function purgeIntents(turnId: string) {
  return prisma.mainOutboxEvent.findMany({
    where: { aggregateId: turnId, eventType: MAIN_TO_CHAT_EVENTS.agentRunPurgeRequestedV1 },
    select: { payload: true },
  });
}

describe("conditional relationship rebuild", () => {
  it("regenerates a failed reply with memory on and no rebuild, only purging its run", async () => {
    const f = await fixture();
    const turn = await sendAndFinish(f, "failed");
    const first = await regenerateChatTurn(f.userId, turn.assistantId);
    expect(first.snapshot.memoryEnabled).toBe(true);
    await expect(memoryEvents(f.aggregateId)).resolves.toEqual([]);
    await expect(purgeIntents(turn.turnId)).resolves.toMatchObject([
      { payload: { payload: { turnId: turn.turnId, throughAttempt: 1, userId: f.userId } } },
    ]);
    // A second quick Retry after another failure is not refused with a 409.
    await finish(turn.turnId, "cancelled");
    const second = await regenerateChatTurn(f.userId, turn.assistantId);
    expect(second).toMatchObject({ attempt: 3, snapshot: { memoryEnabled: true } });
    await expect(memoryEvents(f.aggregateId)).resolves.toEqual([]);
  });

  it("rebuilds and isolates when the superseded reply could be in memory", async () => {
    const f = await fixture();
    const turn = await sendAndFinish(f, "sent");
    const regenerated = await regenerateChatTurn(f.userId, turn.assistantId);
    expect(regenerated.snapshot.memoryEnabled).toBe(false);
    await expect(memoryEvents(f.aggregateId)).resolves.toMatchObject([{
      status: "pending",
      payload: { payload: { purgeRunAttempts: [{ turnId: turn.turnId, throughAttempt: 1 }] } },
    }]);
    await expect(purgeIntents(turn.turnId)).resolves.toEqual([]);

    // Another projectable revision must wait for that rebuild.
    await finish(turn.turnId, "sent");
    const refused = await regenerateChatTurn(f.userId, turn.assistantId).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).status).toBe(409);

    // A failed attempt is not refused, but runs isolated while the rebuild is pending.
    await finish(turn.turnId, "failed");
    const isolated = await regenerateChatTurn(f.userId, turn.assistantId);
    expect(isolated.snapshot.memoryEnabled).toBe(false);
    await expect(memoryEvents(f.aggregateId)).resolves.toHaveLength(1);
  });

  it("edits follow the same rule as regenerate", async () => {
    const f = await fixture();
    const failed = await sendAndFinish(f, "failed");
    const edited = await editChatTurn(f.userId, failed.userMessageId, "My sister is called Eva.", { expectedAttempt: 1 });
    expect(edited.snapshot?.memoryEnabled).toBe(true);
    await expect(memoryEvents(f.aggregateId)).resolves.toEqual([]);
    await expect(purgeIntents(failed.turnId)).resolves.toMatchObject([{ payload: { payload: { throughAttempt: 1 } } }]);

    await finish(failed.turnId, "sent");
    const resent = await editChatTurn(f.userId, failed.userMessageId, "My sister is called Ida.", { expectedAttempt: 2 });
    expect(resent.snapshot?.memoryEnabled).toBe(false);
    await expect(memoryEvents(f.aggregateId)).resolves.toMatchObject([{
      payload: { payload: { purgeRunAttempts: [{ turnId: failed.turnId, throughAttempt: 2 }] } },
    }]);
  });

  it("deletes an unprojected Turn without a rebuild and a projected one with a rebuild", async () => {
    const f = await fixture();
    const failed = await sendAndFinish(f, "failed");
    await deleteChatMessage(f.userId, failed.userMessageId);
    await expect(memoryEvents(f.aggregateId)).resolves.toEqual([]);
    const [intent] = await purgeIntents(failed.turnId);
    expect(intent?.payload).toMatchObject({ payload: { turnId: failed.turnId } });
    expect((intent?.payload as { payload: Record<string, unknown> }).payload).not.toHaveProperty("throughAttempt");

    const sent = await sendAndFinish(f, "sent");
    await deleteChatMessage(f.userId, sent.userMessageId);
    await expect(memoryEvents(f.aggregateId)).resolves.toMatchObject([{ payload: { payload: { purgeTurnIds: [sent.turnId] } } }]);
  });

  it("treats a memory-off Turn as never projected", async () => {
    const f = await fixture();
    await prisma.recentChat.update({ where: { sessionId: f.sessionId }, data: { memoryEnabled: false } });
    const turn = await sendAndFinish(f, "sent");
    const regenerated = await regenerateChatTurn(f.userId, turn.assistantId);
    expect(regenerated.snapshot.memoryEnabled).toBe(false);
    await expect(memoryEvents(f.aggregateId)).resolves.toEqual([]);
    await expect(purgeIntents(turn.turnId)).resolves.toHaveLength(1);
  });
});
