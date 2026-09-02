import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { proxyChatRequest } from "@/server/bff/chat-proxy";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { beginChatTurn, commitChatTerminal, createChatSession, editChatTurn, regenerateChatTurn, setChatMemory } from "./turn-ledger";
import { clearCompanionMemory } from "./companion-memory-authority";

const prefix = `zt-chat-context-${randomUUID()}-`;
afterAll(async () => {
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.recentChat.deleteMany({ where: { userId: { startsWith: prefix } } });
  await purgeTestData(prefix);
  await prisma.$disconnect();
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
  const call = async (method: string, body?: unknown, id?: string, actorId = userId, key = randomUUID(), sessionId = session.id) => {
    const segments = ["chat", "sessions", sessionId, "context-directives", ...(id ? [id] : [])];
    const response = await proxyChatRequest(new Request(`http://localhost/api/v1/${segments.join("/")}`, {
      method, headers: { "x-idream-user-id": actorId, "content-type": "application/json", "idempotency-key": key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), segments);
    return { status: response.status, json: await response.json() };
  };
  const begin = (key = randomUUID()) => beginChatTurn({ userId, sessionId: session.id, content: "Keep me company.", idempotencyKey: key });
  return { userId, characterId: character.id, sessionId: session.id, call, begin };
}

async function finish(turn: Awaited<ReturnType<typeof beginChatTurn>>) {
  const snapshot = turn.snapshot!;
  await commitChatTerminal({
    version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt, status: "sent", content: "I'm here.", model: "fixture", promptTokens: 2, completionTokens: 2,
    sceneVersion: snapshot.sceneVersion + 1,
    scene: { schemaVersion: 1, version: snapshot.sceneVersion + 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] },
    terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } },
  });
}

describe("explicit user Chat context", () => {
  it("persists owned settings, handles exact retries and rejects conflicting revisions and invalid content", async () => {
    const f = await fixture();
    const other = await fixture();
    expect((await f.call("GET", undefined, undefined, other.userId)).status).toBe(404);
    expect((await f.call("POST", { kind: "pinned_memory", content: "x".repeat(501) })).status).toBe(400);
    const key = randomUUID();
    const created = await f.call("POST", { kind: "pinned_memory", content: "My notebook is Harbor Finch." }, undefined, f.userId, key);
    expect(created.status).toBe(201);
    expect((await f.call("POST", { kind: "pinned_memory", content: "My notebook is Harbor Finch." }, undefined, f.userId, key)).json).toEqual(created.json);
    const pin = created.json.item;
    expect((await f.call("PATCH", { content: "Changed by another user", version: 1 }, pin.id, other.userId)).status).toBe(404);
    expect((await f.call("PATCH", { content: "My notebook is Blue Harbor.", version: 1 }, pin.id)).json.item).toMatchObject({ version: 2, content: "My notebook is Blue Harbor." });
    expect((await f.call("PATCH", { content: "Stale edit", version: 1 }, pin.id)).status).toBe(409);
    expect((await f.call("DELETE", { version: 1 }, pin.id)).status).toBe(409);
    expect((await f.call("GET")).json.items).toEqual([expect.objectContaining({ id: pin.id, version: 2 })]);
    expect((await f.call("DELETE", { version: 2 }, pin.id)).status).toBe(200);
    expect((await f.call("DELETE", { version: 2 }, pin.id)).status).toBe(200);
    expect((await f.call("GET")).json.items).toEqual([]);
    expect(await prisma.chatContextDirective.findUnique({ where: { id: pin.id } })).toMatchObject({ status: "archived", content: "", version: 3 });
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: `${f.userId}:${f.characterId}` } })).toBe(0);
  });

  it("enforces per-kind limits under concurrent writes", async () => {
    const f = await fixture();
    const pins = await Promise.all(Array.from({ length: 9 }, (_, index) => f.call("POST", { kind: "pinned_memory", content: `Fact ${index}` })));
    expect(pins.filter((result) => result.status === 201)).toHaveLength(8);
    expect(pins.filter((result) => result.status === 409)).toHaveLength(1);
    const instructions = await Promise.all(["Be brief.", "Be descriptive."].map((content) => f.call("POST", { kind: "custom_instruction", content })));
    expect(instructions.map((result) => result.status).sort()).toEqual([201, 409]);
    expect((await f.call("GET")).json.items).toHaveLength(9);
  });

  it("freezes settings on acceptance and preserves them through replay, regeneration and edit", async () => {
    const f = await fixture();
    const pin = (await f.call("POST", { kind: "pinned_memory", content: "My notebook is Harbor Finch." })).json.item;
    const custom = (await f.call("POST", { kind: "custom_instruction", content: "Call me Robin." })).json.item;
    const key = randomUUID();
    const first = await f.begin(key);
    expect(first.snapshot?.contextDirectives).toEqual([pin, custom]);
    await f.call("PATCH", { content: "Call me Riley.", version: 1 }, custom.id);
    await f.call("DELETE", { version: 1 }, pin.id);
    expect((await f.begin(key)).snapshot?.contextDirectives).toEqual([pin, custom]);
    await finish(first);
    const regenerated = await regenerateChatTurn(f.userId, first.snapshot!.assistantMessageId);
    expect(regenerated.snapshot.contextDirectives).toEqual([pin, custom]);
    // Simulate the acknowledged rebuild before the next revision; no provider is invoked here.
    await prisma.mainOutboxEvent.updateMany({ where: { aggregateId: `${f.userId}:${f.characterId}` }, data: { status: "delivered", deliveredAt: new Date() } });
    await finish({ ...first, snapshot: regenerated.snapshot });
    const edited = await editChatTurn(f.userId, first.snapshot!.userMessageId, "Stay by the window.");
    expect(edited.snapshot?.contextDirectives).toEqual([pin, custom]);
    await finish({ ...first, snapshot: edited.snapshot });
    const next = await f.begin();
    expect(next.snapshot?.contextDirectives).toEqual([{ ...custom, content: "Call me Riley.", version: 2 }]);
  });

  it("pauses pins for private messages, clears them durably and cascades settings with account erasure", async () => {
    const f = await fixture();
    const pin = (await f.call("POST", { kind: "pinned_memory", content: "My notebook is Harbor Finch." })).json.item;
    const custom = (await f.call("POST", { kind: "custom_instruction", content: "Call me Robin." })).json.item;
    await setChatMemory(f.userId, f.sessionId, false);
    const privateTurn = await f.begin();
    expect(privateTurn.snapshot?.contextDirectives).toEqual([custom]);
    await finish(privateTurn);
    await setChatMemory(f.userId, f.sessionId, true);
    const normalTurn = await f.begin();
    expect(normalTurn.snapshot?.contextDirectives).toEqual([pin, custom]);
    await finish(normalTurn);
    await clearCompanionMemory(f.userId, f.characterId);
    expect((await f.call("GET")).json.items).toEqual([custom]);
    expect(await prisma.chatContextDirective.findUnique({ where: { id: pin.id } })).toMatchObject({ status: "archived", content: "" });
    // Requests sent before Clear may arrive after it; archived sessions cannot
    // repopulate the relationship or mutate its retained custom instructions.
    const lateWrites = [
      await f.call("POST", { kind: "pinned_memory", content: "A delayed old-session fact." }),
      await f.call("PATCH", { content: "A delayed preference change.", version: 1 }, custom.id),
      await f.call("DELETE", { version: 1 }, custom.id),
    ];
    expect(lateWrites.map((result) => result.status)).toEqual([410, 410, 410]);
    expect((await f.call("GET")).json.items).toEqual([custom]);
    // A completed purge acknowledgement cannot make the old Turn's pinned facts reappear.
    await prisma.mainOutboxEvent.updateMany({ where: { aggregateId: `${f.userId}:${f.characterId}` }, data: { status: "delivered", deliveredAt: new Date() } });
    const regenerated = await regenerateChatTurn(f.userId, normalTurn.snapshot!.assistantMessageId);
    expect(regenerated.snapshot.contextDirectives).toEqual([custom]);
    const freshSession = await createChatSession(f.userId, { characterId: f.characterId });
    const fresh = await beginChatTurn({ userId: f.userId, sessionId: freshSession.id, content: "Hello again.", idempotencyKey: randomUUID() });
    expect(fresh.snapshot?.contextDirectives).toEqual([custom]);
    const freshPin = await f.call("POST", { kind: "pinned_memory", content: "A newly saved fact." }, undefined, f.userId, randomUUID(), freshSession.id);
    expect(freshPin.status).toBe(201);
    expect((await f.call("PATCH", { content: "Call me Riley.", version: 1 }, custom.id, f.userId, randomUUID(), freshSession.id)).status).toBe(200);
    expect((await f.call("DELETE", { version: 1 }, freshPin.json.item.id, f.userId, randomUUID(), freshSession.id)).status).toBe(200);
    expect((await f.call("GET", undefined, undefined, f.userId, randomUUID(), freshSession.id)).json.items).toEqual([{ ...custom, content: "Call me Riley.", version: 2 }]);
    await prisma.user.delete({ where: { id: f.userId } });
    expect(await prisma.chatContextDirective.count({ where: { userId: f.userId } })).toBe(0);
  });
});
