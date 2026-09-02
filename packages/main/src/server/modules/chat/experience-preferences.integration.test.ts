import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { proxyChatRequest } from "@/server/bff/chat-proxy";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { beginChatTurn, commitChatTerminal, createChatSession, editChatTurn, regenerateChatTurn, setChatMemory } from "./turn-ledger";
import { clearCompanionMemory } from "./companion-memory-authority";

const prefix = `zt-chat-experience-${randomUUID()}-`;
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
  const call = async (method: string, body?: unknown, actorId = userId, sessionId = session.id) => {
    const segments = ["chat", "sessions", sessionId, "experience"];
    const response = await proxyChatRequest(new Request(`http://localhost/api/v1/${segments.join("/")}`, {
      method, headers: { "x-idream-user-id": actorId, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), segments);
    return { status: response.status, json: await response.json() };
  };
  const begin = (key = randomUUID()) => beginChatTurn({ userId, sessionId: session.id, content: "Keep me company.", idempotencyKey: key });
  return { userId, characterId: character.id, sessionId: session.id, call, begin };
}

async function finish(snapshot: NonNullable<Awaited<ReturnType<typeof beginChatTurn>>["snapshot"]>) {
  await commitChatTerminal({
    version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt, status: "sent", content: "I'm here.", model: "fixture", promptTokens: 2, completionTokens: 2,
    sceneVersion: snapshot.sceneVersion + 1,
    scene: { schemaVersion: 1, version: snapshot.sceneVersion + 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] },
    terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } },
  });
}

describe("versioned conversation preferences", () => {
  it("persists owned choices with exact retries, rejects stale concurrent changes and cleans up with the account", async () => {
    const f = await fixture();
    const other = await fixture();
    expect((await f.call("GET")).json).toMatchObject({ settings: { responseLength: "auto", interactionIntensity: "balanced", version: 0 }, editable: true });
    expect((await f.call("GET", undefined, other.userId)).status).toBe(404);
    expect((await f.call("PUT", { responseLength: "endless", interactionIntensity: "balanced", version: 0 })).status).toBe(400);
    const choices = { responseLength: "short", interactionIntensity: "gentle", version: 0 };
    expect((await f.call("PUT", choices, other.userId)).status).toBe(404);
    const first = await f.call("PUT", choices);
    expect(first.status).toBe(200);
    expect((await f.call("PUT", choices)).json).toEqual(first.json);
    const concurrent = await Promise.all([
      f.call("PUT", { responseLength: "long", interactionIntensity: "expressive", version: 1 }),
      f.call("PUT", { responseLength: "auto", interactionIntensity: "balanced", version: 1 }),
    ]);
    expect(concurrent.map(row => row.status).sort()).toEqual([200, 409]);
    const saved = (await f.call("GET")).json.settings;
    expect(saved.version).toBe(2);
    expect(await prisma.chatExperiencePreference.count({ where: { sessionId: f.sessionId } })).toBe(1);
    await prisma.user.delete({ where: { id: f.userId } });
    expect(await prisma.chatExperiencePreference.count({ where: { sessionId: f.sessionId } })).toBe(0);
  });

  it("freezes preferences for replay/edit/regenerate and only applies changed choices to a new Turn", async () => {
    const f = await fixture();
    const original = { responseLength: "short", interactionIntensity: "gentle", version: 1 };
    expect((await f.call("PUT", { ...original, version: 0 })).status).toBe(200);
    const key = randomUUID();
    const first = await f.begin(key);
    expect(first.snapshot?.experience).toEqual(original);
    await f.call("PUT", { responseLength: "long", interactionIntensity: "expressive", version: 1 });
    expect((await f.begin(key)).snapshot?.experience).toEqual(original);
    await finish(first.snapshot!);
    const regenerated = await regenerateChatTurn(f.userId, first.snapshot!.assistantMessageId);
    expect(regenerated.snapshot.experience).toEqual(original);
    await prisma.mainOutboxEvent.updateMany({ where: { aggregateId: `${f.userId}:${f.characterId}` }, data: { status: "delivered", deliveredAt: new Date() } });
    await finish(regenerated.snapshot);
    const edited = await editChatTurn(f.userId, first.snapshot!.userMessageId, "Tell me a little more.");
    expect(edited.snapshot?.experience).toEqual(original);
    await finish(edited.snapshot!);
    await setChatMemory(f.userId, f.sessionId, false);
    const next = await f.begin();
    expect(next.snapshot?.experience).toEqual({ responseLength: "long", interactionIntensity: "expressive", version: 2 });
    expect(next.snapshot?.memoryEnabled).toBe(false);
  });

  it("keeps historical missing preferences unchanged and starts a new chat at defaults after Clear", async () => {
    const f = await fixture();
    const first = await f.begin();
    expect(first.snapshot).not.toHaveProperty("experience");
    await finish(first.snapshot!);
    await f.call("PUT", { responseLength: "long", interactionIntensity: "expressive", version: 0 });
    const regenerated = await regenerateChatTurn(f.userId, first.snapshot!.assistantMessageId);
    expect(regenerated.snapshot).not.toHaveProperty("experience");
    await finish(regenerated.snapshot);
    await clearCompanionMemory(f.userId, f.characterId);
    expect((await f.call("GET")).json.editable).toBe(false);
    expect((await f.call("PUT", { responseLength: "short", interactionIntensity: "gentle", version: 1 })).status).toBe(410);
    const fresh = await createChatSession(f.userId, { characterId: f.characterId });
    expect((await f.call("GET", undefined, f.userId, fresh.id)).json.settings).toEqual({ responseLength: "auto", interactionIntensity: "balanced", version: 0 });
  });
});
