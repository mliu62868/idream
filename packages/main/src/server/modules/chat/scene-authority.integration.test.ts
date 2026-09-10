import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import type { ChatExecutionSnapshot, ChatTerminalCommit } from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { beginChatTurn, chatVoiceAuthority, commitChatTerminal, createChatSession, editChatTurn, regenerateChatTurn } from "./turn-ledger";

const prefix = `zt-scene-authority-${randomUUID()}-`;
afterAll(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await prisma.companionMemoryAuthority.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.recentChat.deleteMany({ where: { userId: { startsWith: prefix } } });
  await purgeTestData(prefix);
});

async function fixture() {
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
  const begin = async () => {
    const result = await beginChatTurn({ userId, sessionId: session.id, content: "Keep me company.", idempotencyKey: randomUUID() });
    if (!result.snapshot) throw new Error("Fixture Turn was not admitted");
    return result.snapshot;
  };
  return { userId, characterId: character.id, sessionId: session.id, begin };
}

function terminal(snapshot: ChatExecutionSnapshot): ChatTerminalCommit {
  return {
    version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt, status: "sent", content: "I'm here.", model: "fixture", promptTokens: 2, completionTokens: 2,
    sceneVersion: snapshot.sceneVersion + 1,
    scene: { schemaVersion: 1, version: snapshot.sceneVersion + 1, location: "the cafe", time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] },
    terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 5, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } },
  };
}

describe("Main Scene terminal authority", () => {
  it("rejects a missing Scene at a positive revision before selecting the reply", async () => {
    const f = await fixture();
    const snapshot = await f.begin();
    await expect(commitChatTerminal({ ...terminal(snapshot), sceneVersion: 999, scene: null })).rejects.toThrow();
    await expect(chatVoiceAuthority(f.userId, f.sessionId, snapshot.assistantMessageId)).rejects.toThrow("Message not found");
  });

  it("requires a fresh sent reply to advance exactly once from its frozen Scene", async () => {
    const f = await fixture();
    const first = await f.begin();
    await expect(commitChatTerminal({ ...terminal(first), sceneVersion: 0, scene: null })).rejects.toThrow("Scene");
    await commitChatTerminal(terminal(first));
    const snapshot = await f.begin();
    expect(snapshot.sceneVersion).toBe(1);
    const next = terminal(snapshot);
    for (const version of [0, 1, 3]) {
      await expect(commitChatTerminal({ ...next, sceneVersion: version, scene: { ...next.scene!, version } })).rejects.toThrow("Scene");
    }
    await expect(prisma.chatTurn.findUniqueOrThrow({ where: { id: snapshot.turnId } })).resolves.toMatchObject({ assistantStatus: "pending", sceneVersion: 1, scene: snapshot.scene });
    await commitChatTerminal(next);
    await expect(chatVoiceAuthority(f.userId, f.sessionId, snapshot.assistantMessageId)).resolves.toMatchObject({ sceneVersion: 2, scene: next.scene });
  });

  it.each(["failed", "blocked", "cancelled"] as const)("requires %s to preserve the complete frozen Scene", async (status) => {
    const f = await fixture();
    const first = await f.begin();
    await commitChatTerminal(terminal(first));
    const snapshot = await f.begin();
    const failed = { ...terminal(snapshot), status, content: "", promptTokens: null, completionTokens: null, sceneVersion: snapshot.sceneVersion, scene: snapshot.scene };
    await expect(commitChatTerminal({ ...failed, scene: { ...snapshot.scene!, location: "a forged location" } })).rejects.toThrow("Scene");
    await expect(commitChatTerminal(failed)).resolves.toMatchObject({ duplicate: false });
    await expect(prisma.chatTurn.findUniqueOrThrow({ where: { id: snapshot.turnId } })).resolves.toMatchObject({ assistantStatus: status, sceneVersion: snapshot.sceneVersion, scene: snapshot.scene });
    await expect(chatVoiceAuthority(f.userId, f.sessionId, snapshot.assistantMessageId)).rejects.toThrow("Message not found");
  });

  it("uses the frozen execution anchor, never a subsequently altered active row", async () => {
    const f = await fixture();
    const snapshot = await f.begin();
    const next = terminal(snapshot);
    await prisma.chatTurn.update({ where: { id: snapshot.turnId }, data: { sceneVersion: 50, scene: { ...next.scene!, version: 50 } } });
    await expect(commitChatTerminal({ ...next, sceneVersion: 51, scene: { ...next.scene!, version: 51 } })).rejects.toThrow("Scene");
    await expect(commitChatTerminal(next)).resolves.toMatchObject({ duplicate: false });
  });

  it.each(["missing", "another-attempt", "malformed-scene"] as const)("rejects a %s frozen anchor instead of inventing one at commit", async (corruption) => {
    const f = await fixture();
    const snapshot = await f.begin();
    const corrupted = corruption === "missing" ? null : {
      ...snapshot,
      ...(corruption === "another-attempt" ? { attempt: snapshot.attempt + 1 } : { sceneVersion: 999, scene: null }),
    };
    await prisma.chatTurn.update({ where: { id: snapshot.turnId }, data: {
      executionSnapshot: corrupted === null ? Prisma.JsonNull : JSON.parse(JSON.stringify(corrupted)),
    } });
    await expect(commitChatTerminal(terminal(snapshot))).rejects.toThrow("frozen Scene anchor");
    await expect(prisma.chatTurn.findUniqueOrThrow({ where: { id: snapshot.turnId } })).resolves.toMatchObject({ assistantStatus: "pending", sceneVersion: 0, scene: null });
  });

  it("acknowledges exact terminal replays once, including a legal historical null Scene", async () => {
    const f = await fixture();
    const snapshot = await f.begin();
    const selected = terminal(snapshot);
    const first = await commitChatTerminal(selected);
    const revision = (await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.sessionId } })).contextRevision;
    await expect(commitChatTerminal(selected)).resolves.toEqual({ ...first, duplicate: true });
    await expect(prisma.recentChat.findUniqueOrThrow({ where: { sessionId: f.sessionId } })).resolves.toMatchObject({ contextRevision: revision });
    await expect(prisma.characterStats.findUniqueOrThrow({ where: { characterId: f.characterId } })).resolves.toMatchObject({ chatsCount: 1 });
    await expect(commitChatTerminal({ ...selected, scene: { ...selected.scene!, location: "changed replay" } })).rejects.toThrow("CAS");

    // Imported historical sent rows can have no Scene. Replay is not a new selection.
    await prisma.chatTurn.update({ where: { id: snapshot.turnId }, data: { sceneVersion: 0, scene: Prisma.JsonNull, executionSnapshot: Prisma.JsonNull } });
    await expect(commitChatTerminal({ ...selected, sceneVersion: 0, scene: null })).resolves.toEqual({ ...first, duplicate: true });
  });

  it.each(["regenerate", "edit"] as const)("replaces a %s reply from before the discarded Scene", async (operation) => {
    const f = await fixture();
    const first = await f.begin();
    await commitChatTerminal(terminal(first));
    const second = await f.begin();
    const discarded = terminal(second);
    await commitChatTerminal(discarded);

    const revised = operation === "regenerate"
      ? await regenerateChatTurn(f.userId, second.assistantMessageId)
      : await editChatTurn(f.userId, second.userMessageId, "Let's stay at the station.");
    expect(revised.snapshot).toMatchObject({ attempt: 2, sceneVersion: 1, scene: second.scene });
    if (!revised.snapshot) throw new Error("Revised Turn was not admitted");
    await expect(commitChatTerminal(discarded)).rejects.toThrow("CAS");
    const replacement = terminal(revised.snapshot);
    await expect(commitChatTerminal({ ...replacement, sceneVersion: 3, scene: { ...replacement.scene!, version: 3 } })).rejects.toThrow("Scene");
    await commitChatTerminal(replacement);

    await expect(chatVoiceAuthority(f.userId, f.sessionId, second.assistantMessageId)).resolves.toMatchObject({ attempt: 2, sceneVersion: 2 });
    await expect(prisma.characterStats.findUniqueOrThrow({ where: { characterId: f.characterId } })).resolves.toMatchObject({ chatsCount: 2 });
  });
});
