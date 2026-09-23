import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";
import { beginChatTurn, commitChatTerminal, createChatSession } from "@/server/modules/chat/turn-ledger";

const prefix = `zt-character-edit-${randomUUID()}-`;
const tagSlug = `zt-edit-${randomUUID().slice(0, 8)}`;
afterAll(async () => {
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.recentChat.deleteMany({ where: { userId: { startsWith: prefix } } });
  await purgeTestData(prefix);
  await prisma.tag.deleteMany({ where: { slug: tagSlug } });
  await prisma.$disconnect();
});

async function recordPreviewInput(draftId: string, previewId: string, userId: string) {
  const draft = await prisma.characterDraft.findUniqueOrThrow({ where: { id: draftId } });
  const recipe = await prisma.generationRecipe.upsert({
    where: { id: `${prefix}recipe` }, update: {},
    create: { id: `${prefix}recipe`, recipeKey: `${prefix}recipe`, label: "Preview recipe", body: "Identity portrait", presetOrder: [], safetyHints: {}, sampleMatrix: [] },
  });
  await prisma.generationJob.create({ data: {
    id: `${prefix}${previewId}`, userId, mode: "image", controls: {}, presetIds: [],
    sourceType: "character_preview", sourceId: previewId, recipeId: recipe.recipeKey, recipeVersion: recipe.version,
    prompt: [recipe.body, `${draft.style ?? "realistic"} portrait of an adult ${draft.gender ?? "female"} character`,
      draft.name ? `Character name: ${draft.name}` : null, `Appearance: ${JSON.stringify(draft.appearance ?? {})}`,
      `Hair: ${JSON.stringify(draft.hair ?? {})}`, `Body: ${JSON.stringify(draft.body ?? {})}`,
      `Details: ${JSON.stringify(draft.advancedDetails ?? {})}`, "single subject, clear face, identity reference portrait"].filter(Boolean).join(". "),
  } });
}

async function confirmNewIdentity(userId: string, draftId: string, label: string) {
  const anchor = await prisma.mediaAsset.create({ data: {
    id: `${prefix}${label}`, ownerId: userId, type: "image", url: `/user-content/${prefix}${label}.png`,
    storageKey: `${prefix}${label}.png`, visibility: "private", safetyStatus: "passed", metadata: { synthetic: false },
  } });
  const preview = await prisma.characterPreviewJob.create({ data: {
    draftId, status: "completed", provider: "test", resultAssetId: anchor.id, completedAt: new Date(),
  } });
  await recordPreviewInput(draftId, preview.id, userId);
  expectOk(await api("POST", `character-drafts/${draftId}/preview-anchor`, {
    userId, ageGate: true, body: { previewJobId: preview.id },
  }));
  return anchor.id;
}

// The wizard writes the flat form projection on every step.
const form = {
  appearance: { prompt: "Freckles", eyes: "Hazel" },
  hair: { prompt: "Long dark waves" },
  body: { type: "" },
};

async function createOwnedCharacter(userId: string) {
  const tag = await prisma.tag.upsert({
    where: { slug: tagSlug }, update: {},
    create: { slug: tagSlug, label: "Slow Burn", category: "relationship" },
  });
  const created = await api("POST", "character-drafts", { userId, ageGate: true, body: { name: "Avery", age: 25, gender: "female", style: "realistic" } });
  expectOk(created);
  const draftId = created.data.draft.id as string;
  expectOk(await api("PATCH", `character-drafts/${draftId}`, { userId, ageGate: true, body: {
    ...form,
    tags: [tag.slug],
    advancedDetails: { description: "A warm radio host", firstMessage: "Welcome back.", detailsMarkdown: "## Occupation\nRadio host" },
  } }));
  const anchorId = await confirmNewIdentity(userId, draftId, `${userId}-original-anchor`);
  const submitted = await api("POST", `character-drafts/${draftId}/submit`, { userId, ageGate: true, body: { visibility: "private" } });
  expectOk(submitted);
  return { characterId: submitted.data.character.id as string, anchorId, tagSlug: tag.slug };
}

describe("Character edit (CR-06 / CR-08)", () => {
  it("derives an edit draft, appends versions on submit and keeps earlier Turns on their pin", async () => {
    const userId = `${prefix}owner`;
    await createUser({ id: userId });
    const { characterId, anchorId, tagSlug } = await createOwnedCharacter(userId);
    const original = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const originalContent = await prisma.characterContentVersion.findUniqueOrThrow({ where: { id: original.currentContentVersionId! } });

    const session = await createChatSession(userId, { characterId });
    const first = await beginChatTurn({ userId, sessionId: session.id, content: "Hi.", idempotencyKey: randomUUID() });
    await commitChatTerminal({
      version: 1, turnId: first.snapshot!.turnId, sessionId: first.snapshot!.sessionId, assistantMessageId: first.snapshot!.assistantMessageId,
      attempt: first.snapshot!.attempt, status: "sent", content: "Hello.", model: "fixture", promptTokens: 1, completionTokens: 1,
      sceneVersion: first.snapshot!.sceneVersion + 1,
      scene: { schemaVersion: 1, version: first.snapshot!.sceneVersion + 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] },
      terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } },
    });

    const opened = await api("POST", `characters/${characterId}/edit-draft`, { userId, ageGate: true });
    expectOk(opened);
    const draftId = opened.data.draft.id as string;
    expect(opened.data.draft).toMatchObject({
      name: "Avery", gender: "female", style: "realistic", previewJobId: null, tags: [tagSlug],
      appearance: form.appearance, hair: form.hair, body: {},
      advancedDetails: { age: 25, description: "A warm radio host", firstMessage: "Welcome back.", detailsMarkdown: "## Occupation\nRadio host" },
    });
    expect(opened.data.character).toMatchObject({ id: characterId, visibility: "private" });
    // Re-opening resumes the same draft; Create resume never sees it.
    const reopened = await api("POST", `characters/${characterId}/edit-draft`, { userId, ageGate: true });
    expectOk(reopened);
    expect(reopened.data.draft.id).toBe(draftId);
    const createResume = await api("GET", "character-drafts/current", { userId, ageGate: true });
    expectOk(createResume);
    expect(createResume.data.draft).toBeNull();
    const stranger = `${prefix}stranger`;
    await createUser({ id: stranger });
    expectError(await api("POST", `characters/${characterId}/edit-draft`, { userId: stranger, ageGate: true }), 404, "not_found");

    expectOk(await api("PATCH", `character-drafts/${draftId}`, { userId, ageGate: true, body: {
      ...form,
      name: "Avery Vale",
      tags: [],
      advancedDetails: { description: "A late-night radio host", firstMessage: "You're up late again.", detailsMarkdown: "## Occupation\nNight-shift radio host" },
    } }));
    const submitted = await api("POST", `character-drafts/${draftId}/submit`, { userId, ageGate: true, body: { visibility: "private" } });
    expectOk(submitted);
    expect(submitted.data.character.id).toBe(characterId);

    const edited = await prisma.character.findUniqueOrThrow({ where: { id: characterId }, include: { tags: true } });
    expect(edited.name).toBe("Avery Vale");
    expect(edited.systemPrompt).toContain("Night-shift radio host");
    expect(edited.imageAssetId).toBe(anchorId);
    expect(edited.appearance).toEqual(original.appearance);
    expect(edited.tags).toHaveLength(0);
    expect(edited.currentContentVersionId).not.toBe(originalContent.id);
    const newContent = await prisma.characterContentVersion.findUniqueOrThrow({ where: { id: edited.currentContentVersionId! } });
    expect(newContent.version).toBe(originalContent.version + 1);
    expect(newContent.openingSnapshot).toEqual({ firstMessage: "You're up late again." });
    // CR-08: the earlier version row is untouched.
    expect(await prisma.characterContentVersion.findUniqueOrThrow({ where: { id: originalContent.id } })).toEqual(originalContent);
    const visual = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
      include: { referenceSetRevisions: { where: { status: "active" }, include: { references: true } } },
    });
    expect(visual.version).toBe(2);
    expect(visual.referenceSetRevisions[0]?.references.map((reference) => reference.mediaAssetId)).toEqual([anchorId]);

    const firstTurn = await prisma.chatTurn.findUniqueOrThrow({ where: { id: first.snapshot!.turnId } });
    expect(firstTurn.characterContentVersionId).toBe(originalContent.id);
    const second = await beginChatTurn({ userId, sessionId: session.id, content: "Still there?", idempotencyKey: randomUUID() });
    const secondTurn = await prisma.chatTurn.findUniqueOrThrow({ where: { id: second.snapshot!.turnId } });
    expect(secondTurn.characterContentVersionId).toBe(newContent.id);
    expect(secondTurn.characterVisualProfileId).toBe(visual.id);

    // A replayed submit returns the edited Character without appending again.
    const replay = await api("POST", `character-drafts/${draftId}/submit`, { userId, ageGate: true, body: { visibility: "private" } });
    expectOk(replay);
    expect(await prisma.characterContentVersion.count({ where: { characterId } })).toBe(2);
  });

  it("requires a newly confirmed identity when appearance changes, then replaces the Reference Set", async () => {
    const userId = `${prefix}visual-owner`;
    await createUser({ id: userId });
    const { characterId, anchorId } = await createOwnedCharacter(userId);
    const opened = await api("POST", `characters/${characterId}/edit-draft`, { userId, ageGate: true });
    expectOk(opened);
    const draftId = opened.data.draft.id as string;
    expectOk(await api("PATCH", `character-drafts/${draftId}`, { userId, ageGate: true, body: {
      ...form, hair: { prompt: "Short silver bob" },
    } }));
    const refused = await api("POST", `character-drafts/${draftId}/submit`, { userId, ageGate: true, body: { visibility: "private" } });
    expectError(refused, 400, "bad_request");
    expect((await prisma.character.findUniqueOrThrow({ where: { id: characterId } })).imageAssetId).toBe(anchorId);

    const newAnchorId = await confirmNewIdentity(userId, draftId, `${userId}-edited-anchor`);
    expectOk(await api("POST", `character-drafts/${draftId}/submit`, { userId, ageGate: true, body: { visibility: "private" } }));
    const edited = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    expect(edited.imageAssetId).toBe(newAnchorId);
    expect(edited.appearance).toMatchObject({ hair: { prompt: "Short silver bob" } });
    const visual = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
      include: { referenceSetRevisions: { where: { status: "active" }, include: { references: true } } },
    });
    expect(visual.referenceSetRevisions[0]?.references.map((reference) => reference.mediaAssetId)).toEqual([newAnchorId]);
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: newAnchorId } })).characterId).toBe(characterId);
  });
});
