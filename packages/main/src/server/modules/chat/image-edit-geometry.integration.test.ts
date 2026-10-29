import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { compileCharacterSoul } from "@idream/shared";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { createCharacter, createUser, dreamcoinBalance, grantCoins, purgeTestData } from "@/server/test/helpers";
import { createReferenceSetRevision } from "../ourdream/generation-reference-set";
import { applyChatToolEffect } from "./tool-effect";
import { beginChatTurn, commitChatTerminal, createChatSession } from "./turn-ledger";

const prefix = `zt-chat-edit-size-${randomUUID()}-`;
const sourceKeys: string[] = [];
afterAll(async () => {
  await purgeTestData(prefix);
  for (const key of sourceKeys) await providers.blob.delete({ key });
  await prisma.$disconnect();
});

async function fixture(subject: "companion" | "scene", width: number, height: number) {
  const userId = `${prefix}${randomUUID()}`;
  await createUser({ id: userId });
  await grantCoins(userId, 40);
  const character = await createCharacter({ id: `${userId}-character`, creatorId: userId, source: "user", visibility: "private", advancedDetails: { imageToolEnabled: true } });
  const soul = compileCharacterSoul({ name: "Avery", age: 28, gender: "female", characterPromise: "A warm photographer", detailsMarkdown: "Warm and curious." });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const content = await prisma.characterContentVersion.create({ data: { characterId: character.id, version: 1, sourceType: "test", contentHash: soul.snapshot.compiled.fingerprint, personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)), openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: {} } });
  await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
  const key = `${userId}-source.png`;
  sourceKeys.push(key);
  const pixels = await sharp({ create: { width, height, channels: 3, background: "#7296b0" } }).png().toBuffer();
  await providers.blob.putPrivate({ key, body: pixels, contentType: "image/png" });
  // Deliberately stale row dimensions: the admitted bytes must own geometry.
  const source = await prisma.mediaAsset.create({ data: { id: `${userId}-source`, ownerId: userId, characterId: subject === "companion" ? character.id : null, type: "image", url: `/api/media/${userId}-source/content.png`, storageKey: key, contentType: "image/png", visibility: "private", safetyStatus: "passed", width: 64, height: 64, metadata: {} } });
  if (subject === "companion") {
    const visual = await prisma.characterVisualProfile.create({ data: { characterId: character.id, status: "active", identityPrompt: "Avery", faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {}, anchorAssetIds: [source.id], adapterRefs: {}, createdFrom: "test" } });
    await prisma.$transaction(tx => createReferenceSetRevision(tx, visual, "test", [{ mediaAssetId: source.id, position: 0, role: "primary_face", weight: 1, selectionReason: "primary_identity_anchor" }]));
  }
  const session = await createChatSession(userId, { characterId: character.id });
  await prisma.recentChat.update({ where: { sessionId: session.id }, data: { memoryEnabled: false } });
  const begin = (text: string) => beginChatTurn({ userId, sessionId: session.id, content: text, idempotencyKey: randomUUID() });
  const first = (await begin("Send me the existing green mug photo.")).snapshot;
  if (!first) throw new Error("Missing source Turn");
  await prisma.chatTurnAttachment.create({ data: { id: `${userId}-attachment`, turnId: first.turnId, kind: "generated_image", status: "completed", mediaAssetId: source.id, metadata: { attempt: first.attempt } } });
  await commitChatTerminal({ version: 1, turnId: first.turnId, sessionId: first.sessionId, assistantMessageId: first.assistantMessageId, attempt: first.attempt, status: "sent", content: "Here is the photo.", model: "test", promptTokens: 1, completionTokens: 1, sceneVersion: first.sceneVersion + 1,
    scene: { schemaVersion: 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [], ...first.scene, version: first.sceneVersion + 1 },
    terminalEvidence: { authority: "test", prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 4, systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64) } } });
  const next = (await begin("Change only the mug to red. Keep everything else unchanged.")).snapshot;
  if (!next) throw new Error("Missing edit Turn");
  const effect = { version: 2 as const, turnId: next.turnId, attempt: next.attempt, callId: randomUUID(), name: "edit_last_image" as const, effectScope: "turn_action" as const, intent: { requestedNudity: "unspecified" as const }, arguments: { instruction: "Change only the mug to red. Preserve the composition, subject, clothing, pose and background." } };
  return { userId, source, effect };
}

describe("Chat source image geometry", () => {
  it.each([
    { subject: "companion" as const, width: 832, height: 832 },
    { subject: "scene" as const, width: 640, height: 960 },
  ])("preserves decoded $width × $height pixels for a $subject edit", async ({ subject, width, height }) => {
    const { userId, source, effect } = await fixture(subject, width, height);
    const accepted = await applyChatToolEffect(effect);
    expect(accepted).toMatchObject({ accepted: true, status: "accepted" });
    const job = await prisma.generationJob.findFirstOrThrow({ where: { userId } });
    expect(job).toMatchObject({ orientation: "original", controls: expect.objectContaining({ orientation: "original", width, height, sourceImageAssetId: source.id }) });
    expect(job.controls).toMatchObject({ referenceSnapshots: expect.arrayContaining([expect.objectContaining({ assetId: source.id, role: "source_image", sha256: expect.any(String) })]) });
    expect(await applyChatToolEffect({ ...effect, callId: randomUUID() })).toMatchObject({ accepted: true, duplicate: true, generationJobId: job.id });
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
    expect(await dreamcoinBalance(userId)).toBe(40 - job.costDreamcoins);
  });

  it.each([{ width: 831, height: 832 }, { width: 2048, height: 2048 }])("rejects unsupported $width × $height source geometry before charging", async ({ width, height }) => {
    const { userId, effect } = await fixture("companion", width, height);
    expect(await applyChatToolEffect(effect)).toMatchObject({ accepted: false, error: { code: "conflict", retryable: false } });
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(40);
  });
});
