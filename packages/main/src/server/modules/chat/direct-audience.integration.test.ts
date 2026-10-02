import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { toInputJson } from "@/server/lib/request-json";
import { characterReleaseSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { generationCharacter, readableCharacter } from "@/server/modules/ourdream/generation-character-authority";
import { api, createCharacter, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";
import { createGroupConversation, getGroupConversation, listGroupCandidates } from "./group-conversations";
import { beginChatTurn, chatVoiceAuthority, commitChatTerminal, createChatSession, executionSnapshot, getChatSession } from "./turn-ledger";

const prefix = `zt-chat-direct-${randomUUID()}-`;
afterAll(async () => {
  await prisma.chatTurnUsageFact.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.groupConversation.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.recentChat.deleteMany({ where: { userId: { startsWith: prefix } } });
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

async function fixture(source: "official" | "user" = "user", visibility = "public") {
  const id = `${prefix}${randomUUID()}`, ownerId = `${id}-owner`, readerId = `${id}-reader`;
  await createUser({ id: ownerId, dataClass: source === "user" ? "customer" : "internal" });
  await createUser({ id: readerId });
  const character = await createCharacter({ id, creatorId: ownerId, source, visibility: "public" });
  const soul = compileCharacterSoul({ name: character.name, age: character.age, gender: character.gender,
    characterPromise: character.description, detailsMarkdown: "An observant adult companion with a consistent voice." });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const content = await prisma.characterContentVersion.create({ data: { characterId: id, version: 1, sourceType: "test",
    contentHash: soul.snapshot.compiled.fingerprint, personaSnapshot: toInputJson(soul.snapshot),
    openingSnapshot: { firstMessage: "The immutable opening." }, appearanceSnapshot: {} } });
  const assetId = `${id}-avatar`;
  await prisma.mediaAsset.create({ data: { id: assetId, characterId: id, ownerId, type: "image", url: `/user-content/${assetId}.webp`,
    storageKey: `${assetId}.webp`, visibility: "public_pack", safetyStatus: "passed",
    metadata: { seedSource: prefix, synthetic: false, platformAsset: { status: "approved" } } } });
  await prisma.character.update({ where: { id }, data: { imageAssetId: assetId, currentContentVersionId: content.id, visibility } });
  const project = await prisma.characterProject.create({ data: { characterId: id } });
  const revision = await prisma.characterRevision.create({ data: { projectId: project.id, revision: 1, characterContentVersionId: content.id, projectSnapshot: {} } });
  const snapshot = { projectId: project.id, revisionId: revision.id, characterContentVersionId: content.id,
    visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null,
    generationProvenance: { schemaVersion: "character-release-editorial-import-v1", recordId: id, dataset: prefix, sourceAssetId: assetId },
    releasePlacementManifest: { schemaVersion: 1, kind: "editorial_import", placements: [{ slotKey: "character_avatar", assetId, slotVersion: 1 }] } };
  const release = await prisma.characterRelease.create({ data: { ...snapshot, snapshotHash: characterReleaseSnapshotHash(snapshot),
    readiness: "ready", legacy: true, status: "published", publishedAt: new Date() } });
  await prisma.publicCatalogQualification.create({ data: { releaseId: release.id, releaseSnapshotHash: release.snapshotHash, kind: "editorial_import",
    evidence: { schemaVersion: "public-catalog-qualification-v1", policyVersion: "public-catalog-editorial-import-v1", characterId: id, sourceAssetId: assetId } } });
  const serving = await prisma.characterServing.create({ data: { characterId: id, currentReleaseId: release.id, state: "live" } });
  return { id, ownerId, readerId, content, release, serving, assetId, soul };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function effects(userId: string) {
  return {
    sessions: await prisma.recentChat.count({ where: { userId } }),
    groups: await prisma.groupConversation.count({ where: { userId } }),
    turns: await prisma.chatTurn.count({ where: { session: { userId } } }),
    usage: await prisma.chatTurnUsageFact.count({ where: { userId } }),
    jobs: await prisma.generationJob.count({ where: { userId } }),
    voiceRequests: await prisma.voiceClipRequest.count({ where: { userId } }),
    ledger: await prisma.dreamcoinLedger.count({ where: { userId } }),
  };
}

async function newMediaQuotes(f: Fixture, sessionId: string) {
  expectError(await api("POST", "generation/voice/quote", { userId: f.readerId, ageGate: true,
    body: { characterId: f.id, sessionId, messageId: `opening:${sessionId}`, intent: "play" } }), 404);
  expectError(await api("POST", "generation/quote", { userId: f.readerId, ageGate: true,
    body: { mode: "image", characterId: f.id, prompt: "A quiet portrait." } }), 404);
}

describe("new Chat direct audience and immutable history", () => {
  it.each(["official", "user"] as const)("keeps qualified %s public and unlisted entry pins aligned with Voice and Gen", async (source) => {
    for (const visibility of ["public", "unlisted"]) {
      const f = await fixture(source, visibility);
      expect(await readableCharacter(f.id, f.readerId)).toMatchObject({ id: f.id });
      expect(await generationCharacter(f.id, f.readerId)).toMatchObject({ id: f.id });
      const session = await createChatSession(f.readerId, { characterId: f.id });
      expect(await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: session.id } })).toMatchObject({
        characterContentVersionId: f.content.id, characterReleaseId: f.release.id, openingMessage: "The immutable opening.",
      });
      expectOk(await api("POST", "generation/voice/quote", { userId: f.readerId, ageGate: true,
        body: { characterId: f.id, sessionId: session.id, messageId: `opening:${session.id}`, intent: "play" } }));
      expect(await createChatSession(f.readerId, { characterId: f.id })).toEqual(session);
      expect(await effects(f.readerId)).toEqual({ sessions: 1, groups: 0, turns: 0, usage: 0, jobs: 0, voiceRequests: 0, ledger: 0 });
    }
  });

  it("keeps the owner private draft usable without public Serving authority", async () => {
    const f = await fixture("user", "private");
    await prisma.characterServing.update({ where: { id: f.serving.id }, data: { state: "paused" } });
    const session = await createChatSession(f.ownerId, { characterId: f.id });
    expect(await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: session.id } })).toMatchObject({
      characterContentVersionId: f.content.id, characterReleaseId: null,
    });
    expect(await readableCharacter(f.id, f.ownerId)).toMatchObject({ id: f.id });
    expect(await generationCharacter(f.id, f.ownerId)).toMatchObject({ id: f.id });
    await expect(createChatSession(f.readerId, { characterId: f.id })).rejects.toMatchObject({ status: 404 });
  });

  it("projects a pause into existing single and selected group views without changing history or usage", async () => {
    const f = await fixture(), other = await fixture();
    const single = await createChatSession(f.readerId, { characterId: f.id });
    const owned = await createChatSession(f.ownerId, { characterId: f.id });
    const group = await createGroupConversation(f.readerId, { title: "Serving changes", characterIds: [f.id, other.id] });
    const original = await getChatSession(f.readerId, single.id);
    expect(original.continuation).toBe("available");
    const before = await effects(f.readerId);
    await prisma.characterServing.update({ where: { id: f.serving.id }, data: { state: "paused" } });
    const paused = await getChatSession(f.readerId, single.id);
    expect(paused.continuation).toBe("character_unavailable");
    expect(paused.messages).toEqual(original.messages);
    expect((await getChatSession(f.ownerId, owned.id)).continuation).toBe("available");
    expect((await getGroupConversation(f.readerId, group.id, f.id)).continuation).toBe("character_unavailable");
    expect((await getGroupConversation(f.readerId, group.id, other.id)).continuation).toBe("available");
    await expect(beginChatTurn({ userId: f.readerId, sessionId: single.id, content: "Continue.", idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 410 });
    expect(await effects(f.readerId)).toEqual(before);
    await prisma.characterServing.update({ where: { id: f.serving.id }, data: { state: "live" } });
    expect((await getChatSession(f.readerId, single.id)).continuation).toBe("available");
    expect(await effects(f.readerId)).toEqual(before);
  });

  it("pins qualified public and unlisted group members to their own immutable Releases", async () => {
    const first = await fixture("user", "public"), second = await fixture("official", "unlisted");
    const group = await createGroupConversation(first.readerId, { title: "Qualified companions", characterIds: [first.id, second.id] });
    const members = await prisma.recentChat.findMany({ where: { groupId: group.id }, orderBy: { groupPosition: "asc" } });
    expect(members).toHaveLength(2);
    for (const [index, character] of [first, second].entries()) expect(members[index]).toMatchObject({
      characterId: character.id, characterContentVersionId: character.content.id, characterReleaseId: character.release.id,
    });
    expect(await effects(first.readerId)).toEqual({ sessions: 2, groups: 1, turns: 0, usage: 0, jobs: 0, voiceRequests: 0, ledger: 0 });
  });

  it.each(["audit", "fixture", "internal", "deleted", "suspended", "non-user", "orphan", "paused", "not-published", "no-published-at", "not-ready", "qualification-revoked", "synthetic-image", "deleted-image", "blocked-image"] as const)("refuses %s at new Chat, Voice and media entry without side effects", async (reason) => {
    const f = await fixture();
    // A retained greeting supplies real immutable Voice message authority; it
    // does not grant eligibility for any new synthesis or conversation.
    const historical = await prisma.recentChat.create({ data: { sessionId: randomUUID(), userId: f.readerId, characterId: f.id,
      characterContentVersionId: f.content.id, characterReleaseId: f.release.id, openingMessage: "The immutable opening." } });
    if (["audit", "fixture", "internal"].includes(reason)) await prisma.user.update({ where: { id: f.ownerId }, data: { dataClass: reason } });
    if (reason === "deleted") await prisma.user.update({ where: { id: f.ownerId }, data: { deletedAt: new Date() } });
    if (reason === "suspended") await prisma.user.update({ where: { id: f.ownerId }, data: { status: "suspended" } });
    if (reason === "non-user") await prisma.user.update({ where: { id: f.ownerId }, data: { role: "admin" } });
    if (reason === "orphan") await prisma.character.update({ where: { id: f.id }, data: { creatorId: null } });
    if (reason === "paused") await prisma.characterServing.update({ where: { id: f.serving.id }, data: { state: "paused" } });
    if (reason === "not-published") await prisma.characterRelease.update({ where: { id: f.release.id }, data: { status: "superseded" } });
    if (reason === "no-published-at") await prisma.characterRelease.update({ where: { id: f.release.id }, data: { publishedAt: null } });
    if (reason === "not-ready") await prisma.characterRelease.update({ where: { id: f.release.id }, data: { readiness: "draft" } });
    if (reason === "qualification-revoked") await prisma.publicCatalogQualification.update({ where: { releaseId: f.release.id }, data: { revokedAt: new Date() } });
    if (reason === "synthetic-image") await prisma.mediaAsset.update({ where: { id: f.assetId }, data: { metadata: { synthetic: true } } });
    if (reason === "deleted-image") await prisma.mediaAsset.update({ where: { id: f.assetId }, data: { deletedAt: new Date() } });
    if (reason === "blocked-image") await prisma.mediaAsset.update({ where: { id: f.assetId }, data: { safetyStatus: "blocked" } });
    const before = await effects(f.readerId);
    await expect(readableCharacter(f.id, f.readerId)).rejects.toMatchObject({ status: 404 });
    await expect(generationCharacter(f.id, f.readerId)).rejects.toMatchObject({ status: 404 });
    await newMediaQuotes(f, historical.sessionId);
    await expect(createChatSession(f.readerId, { characterId: f.id })).rejects.toMatchObject({ status: 404 });
    expect(await effects(f.readerId)).toEqual(before);
    expect((await listGroupCandidates(f.readerId, "Test Character")).items.some(item => item.id === f.id)).toBe(false);
  });

  it.each(["missing", "invalid", "tampered"] as const)("does not open a new Chat with a %s Soul", async (kind) => {
    const f = await fixture();
    if (kind === "missing") {
      await prisma.characterServing.update({ where: { id: f.serving.id }, data: { state: "paused" } });
      await prisma.character.update({ where: { id: f.id }, data: { currentContentVersionId: null } });
    }
    else await prisma.characterContentVersion.update({ where: { id: f.content.id }, data: {
      personaSnapshot: kind === "invalid" ? {} : toInputJson({ ...f.soul.snapshot, compiled: { ...f.soul.snapshot.compiled, fingerprint: "forged" } }),
    } });
    const before = await effects(f.readerId);
    await expect(createChatSession(f.readerId, { characterId: f.id })).rejects.toMatchObject({ status: kind === "missing" ? 404 : 410 });
    await expect(createChatSession(f.ownerId, { characterId: f.id })).rejects.toMatchObject({ status: 410 });
    expect(await effects(f.readerId)).toEqual(before);
    expect(await effects(f.ownerId)).toEqual({ sessions: 0, groups: 0, turns: 0, usage: 0, jobs: 0, voiceRequests: 0, ledger: 0 });
  });

  it("rejects an ineligible group member atomically without disturbing accepted single-character history", async () => {
    const f = await fixture(), other = await fixture();
    const session = await createChatSession(f.readerId, { characterId: f.id });
    const begun = await beginChatTurn({ userId: f.readerId, sessionId: session.id, content: "Keep me company.", idempotencyKey: randomUUID() });
    if (!begun.snapshot) throw new Error("Fixture Turn was not admitted");
    const snapshot = begun.snapshot;
    const terminal = { version: 1 as const, turnId: snapshot.turnId, sessionId: snapshot.sessionId, assistantMessageId: snapshot.assistantMessageId,
      attempt: snapshot.attempt, status: "sent" as const, content: "I am here.", model: "fixture", promptTokens: 2, completionTokens: 3,
      sceneVersion: snapshot.sceneVersion + 1,
      scene: { schemaVersion: 1 as const, version: snapshot.sceneVersion + 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] },
      terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 5, systemPromptDigest: "a".repeat(64), soulFingerprint: f.soul.snapshot.compiled.fingerprint } } };
    await commitChatTerminal(terminal);
    const storedSession = await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: session.id } });
    const storedTurn = await prisma.chatTurn.findUniqueOrThrow({ where: { id: snapshot.turnId } });
    const before = await effects(f.readerId);
    await prisma.user.update({ where: { id: f.ownerId }, data: { dataClass: "audit" } });
    await expect(createChatSession(f.readerId, { characterId: f.id })).rejects.toMatchObject({ status: 404 });
    await expect(createGroupConversation(f.readerId, { title: "Invalid member", characterIds: [other.id, f.id] })).rejects.toMatchObject({ status: 404 });
    expect((await getChatSession(f.readerId, session.id)).messages.some(message => message.id === snapshot.assistantMessageId && message.content === terminal.content)).toBe(true);
    expect(await executionSnapshot(snapshot.turnId)).toEqual(snapshot);
    expect(await chatVoiceAuthority(f.readerId, session.id, snapshot.assistantMessageId)).toMatchObject({
      characterContentVersionId: f.content.id, characterReleaseId: f.release.id, text: terminal.content,
    });
    expect(await commitChatTerminal(terminal)).toMatchObject({ duplicate: true });
    expect(await prisma.recentChat.findUniqueOrThrow({ where: { sessionId: session.id } })).toEqual(storedSession);
    expect(await prisma.chatTurn.findUniqueOrThrow({ where: { id: snapshot.turnId } })).toEqual(storedTurn);
    expect(await effects(f.readerId)).toEqual(before);
  });
});
