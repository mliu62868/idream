import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { proxyChatRequest } from "@/server/bff/chat-proxy";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { createGroupConversation, getGroupConversation, groupSpeakerSession, listGroupCandidates, listGroupConversations, updateGroupConversation } from "./group-conversations";
import { beginChatTurn, cancelChatTurn, commitChatTerminal, createChatSession, deleteChatMessage, deleteChatSession, deleteGroupChatConversation, editChatTurn, listChatSessions, regenerateChatTurn, setChatMemory } from "./turn-ledger";
import { clearCompanionMemory } from "./companion-memory-authority";

const prefix = `zt-group-${randomUUID()}-`;
afterAll(async () => {
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.groupConversation.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.recentChat.deleteMany({ where: { userId: { startsWith: prefix } } });
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

async function fixture(count = 2) {
  const userId = `${prefix}${randomUUID()}`;
  await createUser({ id: userId });
  const characters = [];
  for (let index = 0; index < count; index++) {
    const name = `Group companion ${index + 1}`;
    const character = await createCharacter({ id: `${userId}-c${index}`, creatorId: userId, name, source: "user", visibility: "private" });
    const soul = compileCharacterSoul({ name, age: 28, gender: "female", characterPromise: `I am companion ${index + 1}.`, detailsMarkdown: "A warm and curious adult companion." });
    if (!soul.ok) throw new Error("Invalid fixture Soul");
    const content = await prisma.characterContentVersion.create({ data: {
      characterId: character.id, version: 1, sourceType: "test", contentHash: soul.snapshot.compiled.fingerprint,
      personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: { firstMessage: `Private opening for ${name}` }, appearanceSnapshot: {},
    } });
    await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
    characters.push({ id: character.id, name, contentId: content.id });
  }
  const group = await createGroupConversation(userId, { title: "Controlled group", characterIds: characters.map(character => character.id) });
  const members = await prisma.recentChat.findMany({ where: { groupId: group.id }, orderBy: { groupPosition: "asc" } });
  const begin = (index: number, content = `Message for companion ${index + 1}`, idempotencyKey = randomUUID()) => beginChatTurn({ userId, sessionId: members[index].sessionId, content, idempotencyKey });
  return { userId, characters, group, members, begin };
}

async function finish(snapshot: NonNullable<Awaited<ReturnType<typeof beginChatTurn>>["snapshot"]>, content = "I am here as myself.") {
  return commitChatTerminal({
    version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt, status: "sent", content, model: "group-fixture", promptTokens: 3, completionTokens: 4,
    sceneVersion: snapshot.sceneVersion + 1,
    scene: { schemaVersion: 1, version: snapshot.sceneVersion + 1, location: "shared garden", time: null, participants: snapshot.group?.members.map(member => member.name) ?? [], emotionalBeat: null, unresolvedThreads: [] },
    terminalEvidence: { authority: "controlled-test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 5, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } },
  });
}

async function acknowledgeMemory(userId: string) {
  await prisma.mainOutboxEvent.updateMany({ where: { aggregateId: { startsWith: `${userId}:` } }, data: { status: "delivered", deliveredAt: new Date() } });
}

describe("Main group conversation authority", () => {
  it("creates separate immutable member sessions without replacing existing single-character conversations", async () => {
    const f = await fixture();
    const single = await createChatSession(f.userId, { characterId: f.characters[0].id });
    expect(await listChatSessions(f.userId)).toEqual([expect.objectContaining({ id: single.id })]);
    expect(f.members).toHaveLength(2);
    for (const [index, member] of f.members.entries()) expect(member).toMatchObject({
      characterId: f.characters[index].id, characterContentVersionId: f.characters[index].contentId,
      activeKey: null, groupPosition: index, openingMessage: null,
    });
    expect((await getGroupConversation(f.userId, f.group.id)).messages).toEqual([]);
    expect((await listGroupConversations(f.userId))[0]).toMatchObject({ id: f.group.id, members: [{ name: f.characters[0].name }, { name: f.characters[1].name }] });
    await expect(deleteChatSession(f.userId, f.members[0].sessionId)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.recentChat.count({ where: { groupId: f.group.id } })).toBe(2);
  });

  it("admits twelve distinct eligible Characters and rejects overflow, duplicates, other owners' private Characters and underage Characters atomically", async () => {
    const f = await fixture(12);
    for (const [index, character] of f.characters.entries()) expect(await groupSpeakerSession(f.userId, f.group.id, character.id)).toMatchObject({ sessionId: f.members[index].sessionId, characterId: character.id });
    const selected = await f.begin(11);
    expect(selected.snapshot).toMatchObject({ characterId: f.characters[11].id, characterContentVersionId: f.characters[11].contentId, group: { ordinal: 1 } });
    expect(selected.snapshot!.group!.members).toHaveLength(12);
    const other = await fixture();
    for (const characterIds of [[f.characters[0].id], Array(13).fill(f.characters[0].id), [f.characters[0].id, f.characters[0].id]]) {
      await expect(createGroupConversation(f.userId, { title: "Invalid", characterIds })).rejects.toMatchObject({ status: 400 });
    }
    await expect(createGroupConversation(f.userId, { title: "Private", characterIds: [f.characters[0].id, other.characters[0].id] })).rejects.toMatchObject({ status: 404 });
    await prisma.character.update({ where: { id: f.characters[0].id }, data: { age: 17 } });
    await expect(createGroupConversation(f.userId, { title: "Underage", characterIds: [f.characters[0].id, f.characters[1].id] })).rejects.toMatchObject({ status: 404 });
    expect(await prisma.groupConversation.count({ where: { userId: f.userId } })).toBe(1);
    expect((await listGroupCandidates(f.userId, "Group companion")).items.some(item => item.id === other.characters[0].id || item.id === f.characters[0].id)).toBe(false);
    await expect(groupSpeakerSession(f.userId, f.group.id, other.characters[0].id)).rejects.toMatchObject({ status: 404 });
  });

  it("freezes the shared transcript with speaker provenance while keeping each Character's explicit memory and Soul separate", async () => {
    const f = await fixture();
    await prisma.chatContextDirective.createMany({ data: f.characters.map((character, index) => ({ id: randomUUID(), userId: f.userId, characterId: character.id, kind: "pinned_memory", content: `Private relationship fact ${index}` })) });
    const solo = await createChatSession(f.userId, { characterId: f.characters[0].id });
    const privateTurn = await beginChatTurn({ userId: f.userId, sessionId: solo.id, content: "Private solo transcript", idempotencyKey: randomUUID() });
    await finish(privateTurn.snapshot!, "Private solo response");
    const a = await f.begin(0, "The shared notebook is blue.");
    expect(a.snapshot!.recentTurns).toEqual([]);
    expect(a.snapshot!.contextDirectives?.map(item => item.content)).toEqual(["Private relationship fact 0"]);
    await finish(a.snapshot!, "I, companion one, will bring it.");
    const b = await f.begin(1, "What did the other companion offer?");
    expect(b.snapshot!.contextDirectives?.map(item => item.content)).toEqual(["Private relationship fact 1"]);
    expect(b.snapshot!.userContent).toBe("What did the other companion offer?");
    expect(b.snapshot!.recentTurns).toEqual([expect.objectContaining({ turnId: a.snapshot!.turnId, userContent: "The shared notebook is blue.", assistantContent: "I, companion one, will bring it.", speaker: { sessionId: f.members[0].sessionId, characterId: f.characters[0].id, name: f.characters[0].name } })]);
    expect(b.snapshot).toMatchObject({ characterId: f.characters[1].id, sceneVersion: 1, group: { ordinal: 2 } });
    await finish(b.snapshot!, "Companion one offered to bring the blue notebook.");
    const restored = await getGroupConversation(f.userId, f.group.id, f.characters[1].id);
    expect(restored.messages.map(message => message.content)).toEqual([a.snapshot!.userContent, "I, companion one, will bring it.", b.snapshot!.userContent, "Companion one offered to bring the blue notebook."]);
    expect(restored.messages.map(message => message.characterId)).toEqual([f.characters[0].id, f.characters[0].id, f.characters[1].id, f.characters[1].id]);
    expect(restored.group.selectedSessionId).toBe(f.members[1].sessionId);
  });

  it("does not discover another creator's unlisted Character but preserves access by a known Character identifier", async () => {
    const f = await fixture();
    const published = await prisma.character.findFirstOrThrow({ where: { visibility: "public", status: "approved", serving: { state: "live", currentRelease: { status: "published" } } } });
    expect(published.creatorId).not.toBe(f.userId);
    expect((await listGroupCandidates(f.userId, published.name)).items.some(item => item.id === published.id)).toBe(true);
    try {
      await prisma.character.update({ where: { id: published.id }, data: { visibility: "unlisted" } });
      expect((await listGroupCandidates(f.userId, published.name)).items.some(item => item.id === published.id)).toBe(false);
      const direct = await createGroupConversation(f.userId, { title: "Known shared Character", characterIds: [f.characters[0].id, published.id] });
      expect((await getGroupConversation(f.userId, direct.id)).group.members.some(member => member.characterId === published.id)).toBe(true);
    } finally { await prisma.character.update({ where: { id: published.id }, data: { visibility: "public" } }); }
  });

  it("serializes different speakers, replays the same command once, and consumes one allowance for one accepted Turn", async () => {
    const f = await fixture();
    const key = randomUUID();
    const results = await Promise.allSettled([f.begin(0, "First speaker", key), f.begin(1, "Second speaker")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    const winner = results.find(result => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("No admitted Turn");
    const snapshot = winner.value.snapshot!;
    const saved = await prisma.chatTurn.findUniqueOrThrow({ where: { id: snapshot.turnId } });
    const replay = await beginChatTurn({ userId: f.userId, sessionId: saved.sessionId, content: saved.userContent, idempotencyKey: saved.idempotencyKey });
    expect(replay.duplicate).toBe(true);
    expect(replay.snapshot?.turnId).toBe(snapshot.turnId);
    const other = f.members.find(member => member.sessionId !== snapshot.sessionId)!;
    await expect(beginChatTurn({ userId: f.userId, sessionId: other.sessionId, content: saved.userContent, idempotencyKey: saved.idempotencyKey })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.groupChatTurn.count({ where: { groupId: f.group.id } })).toBe(1);
    expect(await prisma.chatTurnUsageFact.count({ where: { userId: f.userId } })).toBe(1);
  });

  it("permits revisions only on the latest group Turn and rolls its Scene back across speakers", async () => {
    const f = await fixture();
    const a = await f.begin(0); await finish(a.snapshot!);
    const b = await f.begin(1); await finish(b.snapshot!);
    await expect(regenerateChatTurn(f.userId, a.assistant.id)).rejects.toMatchObject({ status: 409 });
    await expect(editChatTurn(f.userId, a.userMessage.id, "Old edit")).rejects.toMatchObject({ status: 409 });
    await expect(deleteChatMessage(f.userId, a.userMessage.id)).rejects.toMatchObject({ status: 409 });
    const regenerated = await regenerateChatTurn(f.userId, b.assistant.id);
    expect(regenerated.snapshot).toMatchObject({ attempt: 2, characterId: f.characters[1].id, sceneVersion: 1, group: { ordinal: 2 } });
    await finish(regenerated.snapshot);
    await acknowledgeMemory(f.userId);
    await deleteChatMessage(f.userId, b.userMessage.id);
    await acknowledgeMemory(f.userId);
    const next = await f.begin(0);
    expect(next.snapshot).toMatchObject({ sceneVersion: 1, group: { ordinal: 3 } });
    expect(await prisma.chatTurnUsageFact.count({ where: { userId: f.userId } })).toBe(3);
  });

  it.each(["archive", "clear_memory"] as const)("rejects revisions after %s without replacing the saved reply, while allowing history deletion", async (ending) => {
    const f = await fixture();
    const original = await f.begin(0);
    await finish(original.snapshot!, "A saved group reply.");
    await acknowledgeMemory(f.userId);
    if (ending === "archive") {
      await updateGroupConversation(f.userId, f.group.id, { status: "archived" });
    } else {
      await clearCompanionMemory(f.userId, f.characters[0].id);
      await acknowledgeMemory(f.userId);
    }
    const before = await prisma.chatTurn.findUniqueOrThrow({ where: { id: original.snapshot!.turnId } });
    const fetcher = vi.spyOn(globalThis, "fetch");
    try {
      const regenerate = await proxyChatRequest(new Request(`http://localhost/api/v1/messages/${original.assistant.id}/regenerate`, {
        method: "POST", headers: { "x-idream-user-id": f.userId },
      }), ["messages", original.assistant.id, "regenerate"]);
      const edit = await proxyChatRequest(new Request(`http://localhost/api/v1/messages/${original.userMessage.id}`, {
        method: "PATCH", headers: { "x-idream-user-id": f.userId, "content-type": "application/json" }, body: JSON.stringify({ content: "A replacement that must not be accepted" }),
      }), ["messages", original.userMessage.id]);
      const send = await proxyChatRequest(new Request(`http://localhost/api/v1/chat/groups/${f.group.id}/messages`, {
        method: "POST", headers: { "x-idream-user-id": f.userId, "content-type": "application/json", "idempotency-key": `ended-group-send-${ending}-${f.group.id}` },
        body: JSON.stringify({ content: "A message to an ended group", characterId: f.characters[0].id }),
      }), ["chat", "groups", f.group.id, "messages"]);
      expect([regenerate.status, edit.status, send.status]).toEqual([410, 410, 410]);
      expect(fetcher).not.toHaveBeenCalled();
      expect(await prisma.chatTurn.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
      expect((await getGroupConversation(f.userId, f.group.id)).messages.map(message => message.content)).toEqual([original.userMessage.content, "A saved group reply."]);
      expect(await prisma.chatTurnUsageFact.count({ where: { userId: f.userId } })).toBe(1);
      await deleteChatMessage(f.userId, original.userMessage.id);
      expect((await getGroupConversation(f.userId, f.group.id)).messages).toEqual([]);
      expect(await prisma.chatTurnUsageFact.count({ where: { userId: f.userId } })).toBe(1);
    } finally { fetcher.mockRestore(); }
  });

  it("deletes the group atomically, preserves unrelated solo history and never refunds used Turn allowances", async () => {
    const f = await fixture();
    const solo = await createChatSession(f.userId, { characterId: f.characters[0].id });
    const active = await f.begin(0);
    await expect(deleteGroupChatConversation(f.userId, f.group.id)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.recentChat.count({ where: { groupId: f.group.id } })).toBe(2);
    await cancelChatTurn(f.userId, active.assistant.id);
    await deleteGroupChatConversation(f.userId, f.group.id);
    expect(await prisma.groupConversation.findUnique({ where: { id: f.group.id } })).toBeNull();
    expect(await prisma.groupChatTurn.count({ where: { groupId: f.group.id } })).toBe(0);
    expect(await prisma.recentChat.findUnique({ where: { sessionId: solo.id } })).not.toBeNull();
    expect(await prisma.chatTurnUsageFact.count({ where: { userId: f.userId } })).toBe(1);
  });

  it("keeps no-memory scoped to one member and ends the whole conversation when that Character's memory is cleared", async () => {
    const f = await fixture();
    await setChatMemory(f.userId, f.members[0].sessionId, false);
    const a = await f.begin(0);
    expect(a.snapshot!.memoryEnabled).toBe(false); await finish(a.snapshot!);
    const b = await f.begin(1);
    expect(b.snapshot!.memoryEnabled).toBe(true);
    const transport = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
    try { await clearCompanionMemory(f.userId, f.characters[0].id); } finally { transport.mockRestore(); }
    expect(await prisma.groupConversation.findUnique({ where: { id: f.group.id } })).toMatchObject({ status: "archived" });
    expect(await prisma.chatTurn.findUnique({ where: { id: b.snapshot!.turnId } })).toMatchObject({ assistantStatus: "cancelled", memoryEnabled: true });
    const members = await prisma.recentChat.findMany({ where: { groupId: f.group.id }, orderBy: { groupPosition: "asc" } });
    expect(members.map(member => ({ status: member.status, memoryEnabled: member.memoryEnabled }))).toEqual([{ status: "archived", memoryEnabled: false }, { status: "archived", memoryEnabled: true }]);
    await expect(f.begin(1)).rejects.toMatchObject({ status: 410 });
    expect((await getGroupConversation(f.userId, f.group.id)).messages).toHaveLength(4);
  });

  it("binds public group reads and writes to the current owner and rejects invalid creation fields with a client error", async () => {
    const f = await fixture(); const other = await fixture();
    const call = async (method: string, path: string, actorId = f.userId, body?: unknown, scope = `user:${actorId}`) => {
      const segments = ["chat", "groups", ...path.split("/").filter(Boolean)];
      return proxyChatRequest(new Request(`http://localhost/api/v1/${segments.join("/")}`, { method, headers: { "x-idream-user-id": actorId, "x-idream-viewer-scope": scope, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), segments);
    };
    expect((await call("GET", f.group.id, other.userId)).status).toBe(404);
    expect((await call("DELETE", f.group.id, other.userId)).status).toBe(404);
    expect((await call("POST", "", f.userId, { title: "X", characterIds: f.characters.map(character => character.id) }, `user:${other.userId}`)).status).toBe(409);
    expect((await call("POST", "", f.userId, { title: "X", characterIds: [f.characters[0].id] })).status).toBe(400);
    const list = await call("GET", "");
    expect(await list.json()).toMatchObject({ ownerScope: `user:${f.userId}`, groups: [{ id: f.group.id }] });
    await updateGroupConversation(f.userId, f.group.id, { status: "archived" });
    await expect(f.begin(0)).rejects.toMatchObject({ status: 410 });
    expect((await getGroupConversation(f.userId, f.group.id)).status).toBe("archived");
  });
});
