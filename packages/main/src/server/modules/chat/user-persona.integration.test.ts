import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { beginChatTurn, commitChatTerminal, createChatSession, editChatTurn, executionSnapshot, regenerateChatTurn, setChatMemory } from "./turn-ledger";
import { clearCompanionMemory } from "./companion-memory-authority";

const prefix = `zt-chat-persona-${randomUUID()}-`;
afterAll(async () => {
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.recentChat.deleteMany({ where: { userId: { startsWith: prefix } } });
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

const robin = { name: "Robin", description: "A botanist with a blue notebook.", enabled: true };
const call = (userId: string, method: string, body?: unknown) => api(method, "profile/chat-persona", { userId, body });

async function fixture(existingUserId?: string) {
  const userId = existingUserId ?? `${prefix}${randomUUID()}`;
  if (!existingUserId) await createUser({ id: userId });
  const character = await createCharacter({ id: `${prefix}character-${randomUUID()}`, creatorId: userId, source: "user", visibility: "private" });
  const soul = compileCharacterSoul({ name: "Mira", age: 28, gender: "female", characterPromise: "A warm companion", detailsMarkdown: "Warm and curious." });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const content = await prisma.characterContentVersion.create({ data: {
    characterId: character.id, version: 1, sourceType: "test", contentHash: soul.snapshot.compiled.fingerprint,
    personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: {},
  } });
  await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
  const session = await createChatSession(userId, { characterId: character.id });
  await setChatMemory(userId, session.id, false);
  const begin = (key = randomUUID()) => beginChatTurn({ userId, sessionId: session.id, content: "Keep me company.", idempotencyKey: key });
  return { userId, characterId: character.id, sessionId: session.id, begin };
}

async function finish(snapshot: NonNullable<Awaited<ReturnType<typeof beginChatTurn>>["snapshot"]>) {
  await commitChatTerminal({
    version: 1, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
    attempt: snapshot.attempt, status: "sent", content: "I'm here.", model: "fixture", promptTokens: 2, completionTokens: 2,
    sceneVersion: snapshot.sceneVersion + 1,
    scene: { schemaVersion: 1, version: snapshot.sceneVersion + 1, location: "the cafe", time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] },
    terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } },
  });
  // This fixture exercises Main's frozen settings, not the separate igrep worker.
  await prisma.mainOutboxEvent.updateMany({
    where: { aggregateId: `${snapshot.userId}:${snapshot.characterId}`, status: { in: ["pending", "processing"] } },
    data: { status: "delivered", deliveredAt: new Date() },
  });
}

describe("global user chat persona", () => {
  it("isolates accounts, preserves other preferences and uses versioned writes and clearing without stale resurrection", async () => {
    const f = await fixture();
    const other = await fixture();
    await prisma.userPreferences.upsert({ where: { userId: f.userId },
      update: { locale: "fr", notificationSettings: { emailUpdates: true } },
      create: { userId: f.userId, locale: "fr", mutedTags: [], safeModeFlags: {}, notificationSettings: { emailUpdates: true } },
    });
    expect((await api("GET", "profile/chat-persona")).status).toBe(401);
    expect((await call(f.userId, "GET")).data).toEqual({ persona: null, version: 0 });
    for (const invalid of [
      { ...robin, name: "x".repeat(81) }, { ...robin, description: "x".repeat(1_501) },
      { ...robin, name: " ", description: " " }, { ...robin, userId: other.userId },
    ]) expect((await call(f.userId, "PUT", { ...invalid, version: 0 })).status).toBe(400);
    const beforeEvents = await prisma.mainOutboxEvent.count({ where: { aggregateId: { startsWith: f.userId } } });
    const saved = await call(f.userId, "PUT", { ...robin, version: 0 });
    expect(saved.status).toBe(200);
    expect(saved.data).toEqual({ persona: { ...robin, version: 1 }, version: 1 });
    expect((await call(f.userId, "PUT", { ...robin, version: 0 })).data).toEqual(saved.data);
    expect((await call(other.userId, "GET")).data).toEqual({ persona: null, version: 0 });
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: { startsWith: f.userId } } })).toBe(beforeEvents);
    expect(await prisma.userPreferences.findUnique({ where: { userId: f.userId } })).toMatchObject({ locale: "fr", notificationSettings: { emailUpdates: true } });
    const concurrent = await Promise.all([
      call(f.userId, "PUT", { ...robin, name: "Juniper", version: 1 }),
      call(f.userId, "PUT", { ...robin, name: "Cedar", version: 1 }),
    ]);
    expect(concurrent.map(result => result.status).sort()).toEqual([200, 409]);
    const cleared = await call(f.userId, "DELETE", { version: 2 });
    expect(cleared.data).toEqual({ persona: null, version: 3 });
    expect((await call(f.userId, "DELETE", { version: 2 })).data).toEqual(cleared.data);
    expect((await call(f.userId, "PUT", { ...robin, version: 1 })).status).toBe(409);
    expect((await call(f.userId, "GET")).data).toEqual(cleared.data);
    await prisma.user.delete({ where: { id: f.userId } });
    expect(await prisma.userPreferences.count({ where: { userId: f.userId } })).toBe(0);
  });

  it("freezes the same global persona across characters and keeps edit/regenerate history while new Turns observe changes", async () => {
    const f = await fixture();
    const otherCharacter = await fixture(f.userId);
    await call(f.userId, "PUT", { ...robin, version: 0 });
    const key = randomUUID();
    const first = await f.begin(key);
    expect(first.snapshot?.userPersona).toEqual({ ...robin, version: 1 });
    expect(first.snapshot?.memoryEnabled).toBe(false);
    const across = await otherCharacter.begin();
    expect(across.snapshot?.userPersona).toEqual(first.snapshot?.userPersona);
    await finish(across.snapshot!);
    const changed = { ...robin, name: "Juniper", description: "A ceramic artist." };
    await call(f.userId, "PUT", { ...changed, version: 1 });
    expect((await f.begin(key)).snapshot?.userPersona).toEqual(first.snapshot?.userPersona);
    await finish(first.snapshot!);
    const regenerated = await regenerateChatTurn(f.userId, first.snapshot!.assistantMessageId);
    expect(regenerated.snapshot.userPersona).toEqual(first.snapshot?.userPersona);
    await finish(regenerated.snapshot);
    const edited = await editChatTurn(f.userId, first.snapshot!.userMessageId, "Tell me a little more.");
    expect(edited.snapshot?.userPersona).toEqual(first.snapshot?.userPersona);
    await finish(edited.snapshot!);
    const next = await f.begin();
    expect(next.snapshot?.userPersona).toEqual({ ...changed, version: 2 });
    expect(next.snapshot?.characterContentVersionId).toBe(first.snapshot?.characterContentVersionId);
    await finish(next.snapshot!);
    await call(f.userId, "PUT", { ...changed, enabled: false, version: 2 });
    const disabled = await f.begin();
    expect(disabled.snapshot?.userPersona).toEqual({ ...changed, enabled: false, version: 3 });
    await finish(disabled.snapshot!);
    await clearCompanionMemory(f.userId, f.characterId);
    expect((await call(f.userId, "GET")).data.persona).toEqual(disabled.snapshot?.userPersona);
    await call(f.userId, "DELETE", { version: 3 });
    const withoutPersona = await otherCharacter.begin();
    expect(withoutPersona.snapshot?.userPersona).toBeNull();
    expect((await prisma.chatTurn.findUniqueOrThrow({ where: { id: first.snapshot!.turnId } })).executionSnapshot).toMatchObject({ userPersona: { ...robin, version: 1 } });
  });

  it("does not introduce today's persona into a historical Turn that predates the field", async () => {
    const f = await fixture();
    const first = await f.begin();
    const historical = JSON.parse(JSON.stringify(first.snapshot));
    delete historical.userPersona;
    await prisma.chatTurn.update({ where: { id: first.snapshot!.turnId }, data: { executionSnapshot: historical } });
    await finish(first.snapshot!);
    await call(f.userId, "PUT", { ...robin, version: 0 });
    const regenerated = await regenerateChatTurn(f.userId, first.snapshot!.assistantMessageId);
    expect(regenerated.snapshot.userPersona).toBeNull();
    await finish(regenerated.snapshot);
    const edited = await editChatTurn(f.userId, first.snapshot!.userMessageId, "Keep the original context.");
    expect(edited.snapshot?.userPersona).toBeNull();
  });

  it("does not read today's persona while recovering a legacy Turn without a stored snapshot", async () => {
    const f = await fixture();
    const key = randomUUID();
    const first = await f.begin(key);
    await call(f.userId, "PUT", { ...robin, version: 0 });
    await prisma.chatTurn.update({ where: { id: first.snapshot!.turnId }, data: { executionSnapshot: Prisma.JsonNull } });
    expect((await executionSnapshot(first.snapshot!.turnId)).userPersona).toBeNull();
    await prisma.chatTurn.update({ where: { id: first.snapshot!.turnId }, data: { executionSnapshot: Prisma.JsonNull } });
    expect((await f.begin(key)).snapshot?.userPersona).toBeNull();
  });
});
