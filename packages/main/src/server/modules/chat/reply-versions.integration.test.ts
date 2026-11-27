import { CHAT_SEND_PROTOCOL_VERSION } from "@idream/shared/contracts";
import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import type { ChatExecutionSnapshot, ChatTerminalCommit } from "@idream/shared/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import {
  beginChatTurn, commitChatTerminal, createChatSession, editChatTurn, getChatSession, regenerateChatTurn,
  selectChatReplyVersion, setChatMemory,
} from "./turn-ledger";

const prefix = `zt-reply-versions-${randomUUID()}-`;
afterAll(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await prisma.companionMemoryAuthority.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.recentChat.deleteMany({ where: { userId: { startsWith: prefix } } });
  await purgeTestData(prefix);
});

async function fixture(options: { memory?: boolean } = {}) {
  const userId = `${prefix}${randomUUID()}`;
  await createUser({ id: userId });
  const character = await createCharacter({ id: `${userId}-character`, creatorId: userId, source: "user", visibility: "private" });
  const soul = compileCharacterSoul({ name: "Mira", age: 28, gender: "female", characterPromise: "A warm companion", detailsMarkdown: "Warm and curious." });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const content = await prisma.characterContentVersion.create({ data: {
    characterId: character.id, version: 1, sourceType: "test", contentHash: soul.snapshot.compiled.fingerprint,
    personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: {},
  } });
  await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
  const session = await createChatSession(userId, { characterId: character.id });
  if (options.memory === false) await setChatMemory(userId, session.id, false);
  const send = async (text = "Tell me a story.") => {
    const result = await beginChatTurn({ sendProtocolVersion: CHAT_SEND_PROTOCOL_VERSION, userId, sessionId: session.id, content: text, idempotencyKey: randomUUID() });
    if (!result.snapshot) throw new Error("Fixture Turn was not admitted");
    return result.snapshot;
  };
  return { userId, characterId: character.id, sessionId: session.id, send };
}

function sent(snapshot: ChatExecutionSnapshot, content: string): ChatTerminalCommit {
  return {
    version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt, status: "sent", content, model: "fixture", promptTokens: 2, completionTokens: 2,
    sceneVersion: snapshot.sceneVersion + 1,
    scene: { schemaVersion: 1, version: snapshot.sceneVersion + 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] },
    terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 5, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } },
  };
}

async function regenerate(userId: string, assistantMessageId: string, content: string) {
  const result = await regenerateChatTurn(userId, assistantMessageId);
  if (!result.snapshot) throw new Error("Regenerate was not admitted");
  await commitChatTerminal(sent(result.snapshot, content));
  return result.snapshot;
}

async function versionsOf(userId: string, sessionId: string, assistantMessageId: string) {
  const session = await getChatSession(userId, sessionId);
  const reply = (session.messages as Array<Record<string, unknown>>).find((message) => message.id === assistantMessageId);
  return reply as { content: string; attempt: number; replyVersions?: Array<{ ordinal: number; content: string; current: boolean }> };
}

describe("reply versions", () => {
  it("keeps regenerated text replies and switches back without a Chat execution or charge", async () => {
    const f = await fixture({ memory: false });
    const first = await f.send();
    await commitChatTerminal(sent(first, "Version one."));
    await regenerate(f.userId, first.assistantMessageId, "Version two.");
    await regenerate(f.userId, first.assistantMessageId, "Version three.");

    let reply = await versionsOf(f.userId, f.sessionId, first.assistantMessageId);
    expect(reply.content).toBe("Version three.");
    expect(reply.replyVersions?.map((version) => [version.content, version.current])).toEqual([
      ["Version one.", false], ["Version two.", false], ["Version three.", true],
    ]);
    const factsBefore = await prisma.chatTurnUsageFact.count({ where: { turnId: first.turnId } });

    const ordinal = reply.replyVersions![0]!.ordinal;
    const selected = await selectChatReplyVersion(f.userId, first.assistantMessageId, { ordinal, expectedAttempt: reply.attempt });
    expect(selected).toMatchObject({ status: "sent", attempt: reply.attempt + 1 });

    reply = await versionsOf(f.userId, f.sessionId, first.assistantMessageId);
    expect(reply.content).toBe("Version one.");
    // Generation order is stable: selecting does not move a version to the end.
    expect(reply.replyVersions?.map((version) => [version.content, version.current])).toEqual([
      ["Version one.", true], ["Version two.", false], ["Version three.", false],
    ]);
    const turn = await prisma.chatTurn.findUniqueOrThrow({ where: { id: first.turnId } });
    expect(turn).toMatchObject({ assistantStatus: "sent", sceneVersion: first.sceneVersion + 1 });
    expect(await prisma.chatTurnUsageFact.count({ where: { turnId: first.turnId } })).toBe(factsBefore);
    // Metrics count the adopted reply, not the regenerated one the user rejected.
    const correction = await prisma.analyticsEvent.findUnique({ where: { sourceService_sourceEventId: {
      sourceService: "main", sourceEventId: `chat_exchange_correction:${first.turnId}:selected:${selected.attempt}`,
    } }, select: { props: true } });
    expect(correction?.props).toMatchObject({ correctionType: "selected", selectedAssistantMessageId: first.assistantMessageId });
  });

  it("rejects a selection made against a stale attempt", async () => {
    const f = await fixture({ memory: false });
    const first = await f.send();
    await commitChatTerminal(sent(first, "Version one."));
    await regenerate(f.userId, first.assistantMessageId, "Version two.");
    const reply = await versionsOf(f.userId, f.sessionId, first.assistantMessageId);
    await expect(selectChatReplyVersion(f.userId, first.assistantMessageId, {
      ordinal: reply.replyVersions![0]!.ordinal, expectedAttempt: reply.attempt - 1,
    })).rejects.toMatchObject({ details: expect.objectContaining({ reason: "version_mismatch" }) });
  });

  it("retires versions when the user message is edited or a newer Turn starts", async () => {
    const f = await fixture({ memory: false });
    const first = await f.send();
    await commitChatTerminal(sent(first, "Version one."));
    const second = await regenerate(f.userId, first.assistantMessageId, "Version two.");
    expect(await prisma.chatTurnAlternative.count({ where: { turnId: first.turnId } })).toBe(1);

    await editChatTurn(f.userId, first.userMessageId, "Tell me a different story.", { expectedAttempt: second.attempt });
    expect(await prisma.chatTurnAlternative.count({ where: { turnId: first.turnId } })).toBe(0);

    const other = await fixture({ memory: false });
    const a = await other.send();
    await commitChatTerminal(sent(a, "Version one."));
    await regenerate(other.userId, a.assistantMessageId, "Version two.");
    expect(await prisma.chatTurnAlternative.count({ where: { turnId: a.turnId } })).toBe(1);
    // The earlier Turn's reply is no longer the latest; its versions go away.
    await other.send("Next message.");
    expect(await prisma.chatTurnAlternative.count({ where: { turnId: a.turnId } })).toBe(0);
  });

  it("does not keep media replies as versions", async () => {
    const f = await fixture({ memory: false });
    const first = await f.send();
    await commitChatTerminal(sent(first, "Here you go."));
    await prisma.chatTurnAttachment.create({ data: {
      id: `${first.turnId}-image`, turnId: first.turnId, kind: "generated_image", status: "failed",
      metadata: { attempt: first.attempt },
    } });
    await regenerateChatTurn(f.userId, first.assistantMessageId);
    expect(await prisma.chatTurnAlternative.count({ where: { turnId: first.turnId } })).toBe(0);
  });

  it("switches a memory-enabled reply while its rebuild is pending by widening that rebuild", async () => {
    const f = await fixture();
    const first = await f.send();
    await commitChatTerminal(sent(first, "Version one."));
    // The memory-enabled first reply is projectable, so regenerate rebuilds.
    const second = await regenerateChatTurn(f.userId, first.assistantMessageId);
    expect(second.snapshot?.memoryEnabled).toBe(false);
    await commitChatTerminal(sent(second.snapshot!, "Version two."));
    const reply = await versionsOf(f.userId, f.sessionId, first.assistantMessageId);
    // No 409 while the first rebuild is still pending.
    await selectChatReplyVersion(f.userId, first.assistantMessageId, {
      ordinal: reply.replyVersions![0]!.ordinal, expectedAttempt: reply.attempt,
    });
    expect((await versionsOf(f.userId, f.sessionId, first.assistantMessageId)).content).toBe("Version one.");
    const rebuilds = await prisma.mainOutboxEvent.findMany({
      where: { aggregateId: `${f.userId}:${f.characterId}`,
        eventType: "chat.companion_memory.rebuild_requested.v1", status: "pending" },
      select: { payload: true },
    });
    // The unclaimed rebuild absorbed the second purge fence instead of queueing another.
    expect(rebuilds).toHaveLength(1);
    const payload = (rebuilds[0]!.payload as { payload: { purgeRunAttempts: Array<{ turnId: string; throughAttempt: number }> } }).payload;
    expect(payload.purgeRunAttempts).toEqual([{ turnId: first.turnId, throughAttempt: reply.attempt }]);
  });
});
