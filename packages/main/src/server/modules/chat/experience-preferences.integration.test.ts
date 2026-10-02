import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { proxyChatRequest } from "@/server/bff/chat-proxy";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { beginChatTurn, commitChatTerminal, createChatSession, editChatTurn, regenerateChatTurn, setChatMemory } from "./turn-ledger";
import { clearCompanionMemory } from "./companion-memory-authority";
import { DEFAULT_PROFILE_EXPERIENCE } from "./conversation-profiles";

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
  it("publishes explicit profile capabilities and costs, rejects obsolete selections, and freezes the selected version", async () => {
    const f = await fixture();
    const catalog = (await f.call("GET")).json.catalog;
    expect(catalog).toMatchObject({ version: 1 });
    expect(catalog.items).toHaveLength(5);
    expect(new Set(catalog.items.map((item: { id: string }) => item.id)).size).toBe(5);
    for (const profile of catalog.items) {
      expect(profile).toMatchObject({ version: 1, costDreamcoins: 0, messageUnits: 1 });
      expect(profile.description.length).toBeGreaterThan(10);
    }
    const quick = catalog.items.find((item: { id: string }) => item.id === "quick");
    const choose = { ...quick.preferences, conversationProfile: { id: quick.id, version: quick.version }, version: 0 };
    expect((await f.call("PUT", { ...choose, conversationProfile: { id: "quick", version: 0 } })).status).toBe(409);
    expect((await f.call("PUT", { ...choose, conversationProfile: { ...choose.conversationProfile, answerMaxOutputTokens: 999999 } })).status).toBe(400);
    const saved = await f.call("PUT", choose);
    expect(saved.status).toBe(200);
    expect(saved.json.settings.conversationProfile).toMatchObject({ id: "quick", version: 1, answerMaxOutputTokens: 256 });
    expect((await f.call("PUT", choose)).json).toEqual(saved.json);
    const original = await f.begin();
    expect(original.snapshot?.experience?.conversationProfile).toEqual(saved.json.settings.conversationProfile);
    await finish(original.snapshot!);
    const story = catalog.items.find((item: { id: string }) => item.id === "story");
    expect((await f.call("PUT", { ...story.preferences, conversationProfile: { id: story.id, version: 1 }, version: 1 })).status).toBe(200);
    const regenerated = await regenerateChatTurn(f.userId, original.snapshot!.assistantMessageId);
    expect(regenerated.snapshot.experience?.conversationProfile?.id).toBe("quick");
    await finish(regenerated.snapshot);
    const next = await f.begin();
    expect(next.snapshot?.experience?.conversationProfile).toMatchObject({ id: "story", version: 1, answerMaxOutputTokens: 2048 });
    expect(next.snapshot?.characterContentVersionId).toBe(original.snapshot?.characterContentVersionId);
    expect(next.snapshot?.characterReleaseId).toBe(original.snapshot?.characterReleaseId);
  });

  it("persists owned choices with exact retries, rejects stale concurrent changes and cleans up with the account", async () => {
    const f = await fixture();
    const other = await fixture();
    expect((await f.call("GET")).json).toMatchObject({ settings: { responseLength: "auto", interactionIntensity: "balanced", sceneGeneration: "follow", version: 0 }, editable: true });
    expect((await f.call("GET", undefined, other.userId)).status).toBe(404);
    expect((await f.call("PUT", { responseLength: "endless", interactionIntensity: "balanced", version: 0 })).status).toBe(400);
    expect((await f.call("PUT", { responseLength: "auto", interactionIntensity: "balanced", sceneGeneration: "control-user", version: 0 })).status).toBe(400);
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
    const original = { responseLength: "short", interactionIntensity: "gentle", sceneGeneration: "follow", version: 1 };
    expect((await f.call("PUT", { ...original, version: 0 })).status).toBe(200);
    const key = randomUUID();
    const first = await f.begin(key);
    expect(first.snapshot?.experience).toEqual(original);
    await f.call("PUT", { responseLength: "long", interactionIntensity: "expressive", sceneGeneration: "advance", version: 1 });
    expect((await f.begin(key)).snapshot?.experience).toEqual(original);
    await finish(first.snapshot!);
    const regenerated = await regenerateChatTurn(f.userId, first.snapshot!.assistantMessageId);
    expect(regenerated.snapshot.experience).toEqual(original);
    expect(regenerated.snapshot.sceneVersion).toBe(first.snapshot?.sceneVersion);
    await prisma.mainOutboxEvent.updateMany({ where: { aggregateId: `${f.userId}:${f.characterId}` }, data: { status: "delivered", deliveredAt: new Date() } });
    await finish(regenerated.snapshot);
    const edited = await editChatTurn(f.userId, first.snapshot!.userMessageId, "Tell me a little more.");
    expect(edited.snapshot?.experience).toEqual(original);
    expect(edited.snapshot?.sceneVersion).toBe(first.snapshot?.sceneVersion);
    await finish(edited.snapshot!);
    await setChatMemory(f.userId, f.sessionId, false);
    const next = await f.begin();
    expect(next.snapshot?.experience).toEqual({ responseLength: "long", interactionIntensity: "expressive", sceneGeneration: "advance", version: 2 });
    expect(next.snapshot?.memoryEnabled).toBe(false);
    expect(next.snapshot?.sceneVersion).toBe(1);
    expect(next.snapshot?.scene).toMatchObject({ version: 1 });
  });

  it("keeps historical missing preferences unchanged and starts a new chat at defaults after Clear", async () => {
    const f = await fixture();
    const first = await f.begin();
    expect(first.snapshot?.experience).toEqual(DEFAULT_PROFILE_EXPERIENCE);
    const historical = JSON.parse(JSON.stringify(first.snapshot));
    delete historical.experience;
    await prisma.chatTurn.update({ where: { id: first.snapshot!.turnId }, data: { executionSnapshot: historical } });
    await finish(first.snapshot!);
    await f.call("PUT", { responseLength: "long", interactionIntensity: "expressive", version: 0 });
    const regenerated = await regenerateChatTurn(f.userId, first.snapshot!.assistantMessageId);
    expect(regenerated.snapshot).not.toHaveProperty("experience");
    await finish(regenerated.snapshot);
    await clearCompanionMemory(f.userId, f.characterId);
    expect((await f.call("GET")).json.editable).toBe(false);
    expect((await f.call("PUT", { responseLength: "short", interactionIntensity: "gentle", version: 1 })).status).toBe(410);
    const fresh = await createChatSession(f.userId, { characterId: f.characterId });
    expect((await f.call("GET", undefined, f.userId, fresh.id)).json.settings).toEqual(DEFAULT_PROFILE_EXPERIENCE);
  });

  it("does not backfill the new Scene preference into an accepted historical snapshot", async () => {
    const f = await fixture();
    await setChatMemory(f.userId, f.sessionId, false);
    await f.call("PUT", { responseLength: "short", interactionIntensity: "gentle", sceneGeneration: "follow", version: 0 });
    const first = await f.begin();
    const historical = JSON.parse(JSON.stringify(first.snapshot));
    delete historical.experience.sceneGeneration;
    await prisma.chatTurn.update({ where: { id: first.snapshot!.turnId }, data: { executionSnapshot: historical } });
    await finish(first.snapshot!);
    await f.call("PUT", { responseLength: "long", interactionIntensity: "expressive", sceneGeneration: "advance", version: 1 });
    const regenerated = await regenerateChatTurn(f.userId, first.snapshot!.assistantMessageId);
    expect(regenerated.snapshot.experience).toEqual({ responseLength: "short", interactionIntensity: "gentle", version: 1 });
    await finish(regenerated.snapshot);
    await prisma.mainOutboxEvent.updateMany({ where: { aggregateId: `${f.userId}:${f.characterId}` }, data: { status: "delivered", deliveredAt: new Date() } });
    const edited = await editChatTurn(f.userId, first.snapshot!.userMessageId, "Stay in this scene.");
    expect(edited.snapshot?.experience).toEqual(historical.experience);
  });
});
