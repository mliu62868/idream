import { randomUUID } from "node:crypto";
import { CHAT_SEND_PROTOCOL_VERSION, type ChatExecutionSnapshot } from "@idream/shared/contracts";
import { compileCharacterSoul, renderPrometheusMetrics } from "@idream/shared";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { getGroupConversation } from "./group-conversations";
import { parseChatTranscriptPage } from "./chat-read-model";
import { beginChatTurn, commitChatTerminal, createChatSession, getChatSession, regenerateChatTurn } from "./turn-ledger";

const prefix = `zt-session-read-${randomUUID()}-`;

afterAll(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await prisma.companionMemoryAuthority.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await prisma.chatTurnUsageFact.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.recentChat.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.groupConversation.deleteMany({ where: { userId: { startsWith: prefix } } });
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
    personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: { firstMessage: "Hello there." }, appearanceSnapshot: {},
  } });
  await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
  const session = await createChatSession(userId, { characterId: character.id });
  return { userId, characterId: character.id, sessionId: session.id };
}

/** Five settled Turns one second apart; ids sort opposite to time to prove ordering uses createdAt. */
async function transcript(sessionId: string, count = 5) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}${randomUUID()}-${String.fromCharCode(122 - index)}`;
    await prisma.chatTurn.create({ data: {
      id, sessionId, idempotencyKey: randomUUID(), requestHash: "a".repeat(64),
      userMessageId: `${id}-u`, assistantMessageId: `${id}-a`, userContent: `question ${index}`, assistantContent: `answer ${index}`,
      userStatus: "sent", assistantStatus: "sent", memoryEnabled: true,
      createdAt: new Date(1_800_000_000_000 + index * 1_000), terminalAt: new Date(1_800_000_000_500 + index * 1_000),
      executionSnapshot: { large: "x".repeat(10_000) },
    } });
    ids.push(id);
  }
  return ids;
}

function contents(messages: Array<Record<string, unknown>>) {
  return messages.map((message) => message.content);
}

async function sendAndCommit(f: Awaited<ReturnType<typeof fixture>>, content: string) {
  const begun = await beginChatTurn({
    sendProtocolVersion: CHAT_SEND_PROTOCOL_VERSION, userId: f.userId, sessionId: f.sessionId, content, idempotencyKey: randomUUID(),
  });
  const snapshot = begun.snapshot as ChatExecutionSnapshot;
  await commitChatTerminal({
    version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt, status: "sent", content: `reply to ${content}`, model: "fixture", promptTokens: 2, completionTokens: 2,
    sceneVersion: snapshot.sceneVersion + 1,
    scene: { schemaVersion: 1, version: snapshot.sceneVersion + 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] },
    terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } },
  });
  return { snapshot, begun };
}

describe("paged session reads", () => {
  it("returns the latest page in ascending order and walks back with beforeTurnId", async () => {
    const f = await fixture();
    const ids = await transcript(f.sessionId);

    const latest = await getChatSession(f.userId, f.sessionId, { limit: 2 });
    expect(contents(latest.messages)).toEqual(["question 3", "answer 3", "question 4", "answer 4"]);
    expect(latest.page).toEqual({ hasEarlier: true, earliestTurnId: ids[3] });

    const middle = await getChatSession(f.userId, f.sessionId, { limit: 2, beforeTurnId: latest.page.earliestTurnId! });
    expect(contents(middle.messages)).toEqual(["question 1", "answer 1", "question 2", "answer 2"]);
    expect(middle.page).toEqual({ hasEarlier: true, earliestTurnId: ids[1] });

    // The greeting precedes every Turn, so only the earliest page carries it.
    const first = await getChatSession(f.userId, f.sessionId, { limit: 2, beforeTurnId: middle.page.earliestTurnId! });
    expect(contents(first.messages)).toEqual(["Hello there.", "question 0", "answer 0"]);
    expect(first.page).toEqual({ hasEarlier: false, earliestTurnId: ids[0] });

    const all = await getChatSession(f.userId, f.sessionId);
    expect(all.messages).toHaveLength(11);
    expect(all.page).toEqual({ hasEarlier: false, earliestTurnId: ids[0] });
    expect(all.messages.some((message) => "executionSnapshot" in message)).toBe(false);
  });

  it("returns an empty page with the greeting for a new chat and rejects foreign anchors and bad limits", async () => {
    const f = await fixture();
    const empty = await getChatSession(f.userId, f.sessionId);
    expect(contents(empty.messages)).toEqual(["Hello there."]);
    expect(empty.page).toEqual({ hasEarlier: false, earliestTurnId: null });

    const other = await fixture();
    const [foreign] = await transcript(other.sessionId, 1);
    await expect(getChatSession(f.userId, f.sessionId, { beforeTurnId: foreign })).rejects.toMatchObject({ status: 400 });

    expect(parseChatTranscriptPage(new URLSearchParams("limit=200&beforeTurnId=t1"))).toEqual({ limit: 200, beforeTurnId: "t1" });
    expect(parseChatTranscriptPage(new URLSearchParams(""))).toEqual({ beforeTurnId: undefined });
    for (const bad of ["0", "201", "-1", "1.5", "abc"]) {
      expect(() => parseChatTranscriptPage(new URLSearchParams(`limit=${bad}`))).toThrow(AppError);
    }
  });

  it("pages a group transcript by ordinal with the same contract", async () => {
    const f = await fixture();
    const second = await createCharacter({ id: `${f.userId}-second`, creatorId: f.userId, source: "user", visibility: "private" });
    const groupId = `${prefix}${randomUUID()}`;
    await prisma.groupConversation.create({ data: { id: groupId, userId: f.userId, title: "Pair", nextOrdinal: 4 } });
    const sessions = [];
    for (const [position, characterId] of [f.characterId, second.id].entries()) {
      const sessionId = `${prefix}${randomUUID()}`;
      await prisma.recentChat.create({ data: { sessionId, userId: f.userId, characterId, groupId, groupPosition: position, title: `Member ${position}` } });
      sessions.push(sessionId);
    }
    const ids: string[] = [];
    for (let ordinal = 0; ordinal < 4; ordinal += 1) {
      const id = `${prefix}${randomUUID()}`;
      await prisma.chatTurn.create({ data: {
        id, sessionId: sessions[ordinal % 2], idempotencyKey: randomUUID(), requestHash: "a".repeat(64),
        userMessageId: `${id}-u`, assistantMessageId: `${id}-a`, userContent: `g${ordinal}`, assistantContent: `r${ordinal}`,
        userStatus: "sent", assistantStatus: "sent", memoryEnabled: true,
      } });
      await prisma.groupChatTurn.create({ data: { groupId, ordinal, turnId: id } });
      ids.push(id);
    }
    const latest = await getGroupConversation(f.userId, groupId, undefined, { limit: 3 });
    expect(contents(latest.messages)).toEqual(["g1", "r1", "g2", "r2", "g3", "r3"]);
    expect(latest.page).toEqual({ hasEarlier: true, earliestTurnId: ids[1] });
    expect(latest.messages[0]).toMatchObject({ speakerName: "Member 1" });
    const earlier = await getGroupConversation(f.userId, groupId, undefined, { limit: 3, beforeTurnId: ids[1] });
    expect(contents(earlier.messages)).toEqual(["g0", "r0"]);
    expect(earlier.page).toEqual({ hasEarlier: false, earliestTurnId: ids[0] });
  });
});

describe("terminal snapshot retention", () => {
  it("drops the copied transcript after terminal while a revision still freezes a full snapshot", async () => {
    const f = await fixture();
    await sendAndCommit(f, "first");
    const { snapshot, begun } = await sendAndCommit(f, "second");
    expect(snapshot.recentTurns.map((turn) => turn.userContent)).toEqual(["first"]);

    const stored = await prisma.chatTurn.findUniqueOrThrow({ where: { id: snapshot.turnId }, select: { executionSnapshot: true } });
    expect(stored.executionSnapshot).toMatchObject({
      turnId: snapshot.turnId, attempt: 1, userContent: "second", recentTurns: [],
      contextDirectives: snapshot.contextDirectives, sceneVersion: snapshot.sceneVersion,
    });
    expect(renderPrometheusMetrics()).toMatch(/chat_terminal_commit_duration_seconds_count\{outcome="committed",status="sent"\} [1-9]/u);

    const regenerated = await regenerateChatTurn(f.userId, begun.assistant.id);
    expect(regenerated.snapshot.recentTurns.map((turn) => turn.userContent)).toEqual(["first"]);
    expect(regenerated.snapshot).toMatchObject({ attempt: 2, userContent: "second" });
  });
});
