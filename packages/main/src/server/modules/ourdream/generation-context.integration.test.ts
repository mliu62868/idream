import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileCharacterSoul } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { api, createCharacter, createMedia, createUser, dreamcoinBalance, expectError, expectOk, grantCoins, purgeTestData, publishCharacterForPublicAudience } from "@/server/test/helpers";
import { characterContentHash } from "@/server/modules/admin-v2/shared/character-content-identity";
import { characterVisualProfileSnapshotHash, referenceSetSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { editChatTurn } from "@/server/modules/chat/turn-ledger";
import { parseGenerationContextResponse } from "@/lib/public-api-contracts";
import { comicDetailSchema } from "@idream/shared/comics";
import { signGenerationContext, resolveGenerationContext } from "./generation-context";
import { quoteAuthorityFor } from "./generation-quote";

const prefix = "zt-handoff-";
beforeAll(() => purgeTestData(prefix));
afterAll(async () => {
  await prisma.comic.deleteMany({ where: { creatorId: { startsWith: prefix } } });
  await purgeTestData(prefix);
});

async function fixture() {
  const id = `${prefix}${randomUUID()}`;
  const userId = `${id}-user`;
  await createUser({ id: userId });
  await grantCoins(userId, 500);
  await prisma.entitlement.createMany({ data: ["premium_controls", "premium_models"].map(key => ({ userId, key, value: true, source: "test" })) });
  const character = await createCharacter({ id: `${id}-character`, creatorId: userId, source: "user", visibility: "private", name: "Original Mira" });
  const soul = compileCharacterSoul({ name: character.name, age: 25, gender: "female", characterPromise: "A curious companion", detailsMarkdown: "Calm and thoughtful." });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const values = { personaSnapshot: soul.snapshot, openingSnapshot: { firstMessage: "Hello." }, appearanceSnapshot: { style: "realistic", identityAnchor: "short auburn hair" } };
  const content = await prisma.characterContentVersion.create({ data: { id: `${id}-content`, characterId: character.id, version: 1, sourceType: "test", contentHash: characterContentHash(values), ...JSON.parse(JSON.stringify(values)) } });
  await prisma.character.update({ where: { id: character.id }, data: { currentContentVersionId: content.id } });
  const anchor = await prisma.mediaAsset.create({ data: { id: `${id}-anchor`, ownerId: userId, characterId: character.id, type: "image", url: `/user-content/${id}/anchor.webp`, storageKey: `${id}/anchor.webp`, contentType: "image/webp", safetyStatus: "passed", metadata: { synthetic: false } } });
  const profileValues = { characterId: character.id, version: 1, status: "active", style: "realistic", identityPrompt: "Adult with short auburn hair", negativeIdentityPrompt: null, faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {}, anchorAssetIds: [anchor.id], adapterRefs: {}, createdFrom: "test", evidenceState: "qualified" };
  const visual = await prisma.characterVisualProfile.create({ data: { id: `${id}-visual`, ...profileValues, immutableHash: characterVisualProfileSnapshotHash(profileValues) } });
  const references = [{ mediaAssetId: anchor.id, position: 0, role: "identity_anchor", weight: 1 }];
  const referenceSet = await prisma.referenceSetRevision.create({ data: { id: `${id}-references`, visualProfileId: visual.id, revision: 1, status: "active", createdFrom: "test", snapshotHash: referenceSetSnapshotHash({ visualProfileId: visual.id, revision: 1, selectorVersion: "v1", references }), references: { create: references.map(value => ({ ...value, selectionReason: "original identity" })) } } });
  const project = await prisma.characterProject.create({ data: { id: `${id}-project`, characterId: character.id } });
  const release = await prisma.characterRelease.create({ data: { id: `${id}-release`, projectId: project.id, revisionId: `${id}-revision`, characterContentVersionId: content.id, visualProfileId: visual.id, visualProfileVersion: visual.version, referenceSetRevisionId: referenceSet.id, generationProvenance: {}, releasePlacementManifest: {}, snapshotHash: `${id}-release-hash`, legacy: false, status: "published", publishedAt: new Date() } });
  const sessionId = `${id}-session`;
  await prisma.recentChat.create({ data: { sessionId, userId, characterId: character.id, characterContentVersionId: content.id, characterReleaseId: release.id, characterVisualProfileId: visual.id, characterVisualProfileVersion: visual.version } });
  const turnId = `${id}-turn`;
  const userMessageId = `${id}-user-message`;
  const scene = { schemaVersion: 1, version: 1, location: "the blue kitchen window", time: "morning", participants: ["Mira"], emotionalBeat: "a quiet conversation", unresolvedThreads: [] };
  await prisma.chatTurn.create({ data: { id: turnId, sessionId, attempt: 1, idempotencyKey: `${id}-chat`, requestHash: `${id}-chat-hash`, userMessageId, assistantMessageId: `${id}-reply`, userContent: "Stay beside the blue kitchen window.", assistantContent: "I stay beside the window.", assistantStatus: "sent", memoryEnabled: true, characterContentVersionId: content.id, characterReleaseId: release.id, characterVisualProfileId: visual.id, characterVisualProfileVersion: visual.version, scene, sceneVersion: 1, terminalAt: new Date(),
    executionSnapshot: { version: 1, turnId, sessionId, userId, characterId: character.id, userMessageId, assistantMessageId: `${id}-reply`, attempt: 1, characterContentVersionId: content.id, characterReleaseId: release.id, characterVisualProfileId: visual.id, characterVisualProfileVersion: visual.version, memoryEnabled: true, contextRevision: 0, userContent: "Stay beside the blue kitchen window.", recentTurns: [], sceneVersion: 0, scene: null } } });
  const sourceJob = await prisma.generationJob.create({ data: { id: `${id}-source-job`, userId, characterId: character.id, mode: "image", status: "completed", visualProfileId: visual.id, visualProfileVersion: visual.version, referenceSetRevisionId: referenceSet.id, controls: {}, presetIds: [], sourceType: "chat_image", sourceId: `${id}-attachment`, sourceMeta: { sessionId, exchangeId: turnId }, momentSpec: { rawInput: "Mira by the blue window holding a green cup." } } });
  const source = await createMedia({ id: `${id}-source-image`, ownerId: userId, sourceJobId: sourceJob.id });
  await prisma.chatTurnAttachment.create({ data: { id: `${id}-attachment`, turnId, kind: "generated_image", status: "completed", mediaAssetId: source.id, generationJobId: sourceJob.id, promptHint: "Earlier wording", metadata: { attempt: 1 } } });
  const query = { kind: "chat", sessionId, turnId, attempt: "1" };
  return { id, userId, characterId: character.id, userMessageId, turnId, sessionId, visual, referenceSet, release, source, query };
}

async function context(f: Awaited<ReturnType<typeof fixture>>, image = false) {
  const response = await api("GET", "generation/context", { userId: f.userId, ageGate: true, query: { ...f.query, ...(image ? { mediaAssetId: f.source.id } : {}) }, headers: { "x-idream-viewer-scope": `user:${f.userId}` } });
  expectOk(response);
  return parseGenerationContextResponse(response.json);
}

async function quotedBody(f: Awaited<ReturnType<typeof fixture>>, token: string, prompt?: string) {
  const body = { mode: "image", characterId: f.characterId, freeplay: false, consistencyMode: "strict", generationContextToken: token, ...(prompt ? { prompt } : {}), controls: {}, outputCount: 1 };
  const response = await api("POST", "generation/quote", { userId: f.userId, ageGate: true, body });
  expectOk(response);
  return { ...body, quoteAuthority: quoteAuthorityFor(response.data.quote, 1)! };
}

describe("Chat generation handoff admission", () => {
  it("can price an empty Scene but cannot reserve or charge until the user supplies image direction", async () => {
    const f = await fixture();
    await prisma.chatTurn.update({ where: { id: f.turnId }, data: { scene: { schemaVersion: 1, version: 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] } } });
    const handoff = await context(f);
    expect(handoff.prompt).toBe("");
    const body = await quotedBody(f, handoff.token);
    const result = await api("POST", "generation/jobs", { userId: f.userId, ageGate: true, body, autoGenerationQuote: false });
    expectError(result, 400);
    expect(result.error?.message).toContain("Describe the image");
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.userId, reason: "generation_spend" } })).toBe(0);
  });

  it("quotes and reserves the original scene/pins after publication and mutable profile changes, with one charge on replay", async () => {
    const f = await fixture();
    const handoff = await context(f);
    const body = await quotedBody(f, handoff.token);
    await prisma.characterRelease.update({ where: { id: f.release.id }, data: { status: "superseded" } });
    await prisma.characterVisualProfile.update({ where: { id: f.visual.id }, data: { status: "archived" } });
    await prisma.character.update({ where: { id: f.characterId }, data: { name: "A different current name", description: "changed after the chat" } });
    expect((await context(f)).token).toBe(handoff.token);
    const balance = await dreamcoinBalance(f.userId);
    const headers = { "Idempotency-Key": `${f.id}-create`, "x-idream-viewer-scope": `user:${f.userId}` };
    const first = await api("POST", "generation/jobs", { userId: f.userId, ageGate: true, headers, body, autoGenerationQuote: false });
    expectOk(first, 202);
    const replay = await api("POST", "generation/jobs", { userId: f.userId, ageGate: true, headers, body, autoGenerationQuote: false });
    expectOk(replay, 202);
    expect(replay.data.job.id).toBe(first.data.job.id);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: first.data.job.id } });
    expect(job).toMatchObject({ sourceType: "chat_handoff", visualProfileId: f.visual.id, visualProfileVersion: f.visual.version, referenceSetRevisionId: f.referenceSet.id });
    expect(job.prompt).toContain("Original Mira");
    expect(job.prompt).toContain("blue kitchen window");
    expect(job.prompt).not.toContain("different current name");
    expect(job.sourceMeta).toMatchObject({ exchangeId: f.turnId, characterReleaseId: f.release.id });
    expect(await prisma.generationAttempt.count({ where: { requestId: job.id } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: job.id, reason: "generation_spend" } })).toBe(1);
    expect(await dreamcoinBalance(f.userId)).toBe(balance - body.quoteAuthority.costDreamcoins);
  });

  it("pins the selected delivered image and explicit edit into the actual request", async () => {
    const f = await fixture();
    const handoff = await context(f, true);
    expect(handoff.prompt).toBe("Mira by the blue window holding a green cup.");
    const body = await quotedBody(f, handoff.token, "Raise the green cup only.");
    const accepted = await api("POST", "generation/jobs", { userId: f.userId, ageGate: true, body, autoGenerationQuote: false });
    expectOk(accepted, 202);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: accepted.data.job.id } });
    expect(job.controls).toMatchObject({ sourceImageAssetId: f.source.id, visualIdentity: { referenceSetRevisionId: f.referenceSet.id } });
    expect(job.prompt).toContain("Preserve its composition");
    expect(job.prompt).toContain("Raise the green cup only.");
    expect(job.sourceMeta).toMatchObject({ sourceMediaId: f.source.id, exchangeId: f.turnId, attempt: 1 });
  });

  it("rejects cross-account reads, tokens and source substitution without creating a job or charge", async () => {
    const f = await fixture();
    const handoff = await context(f, true);
    const other = `${f.id}-other`;
    await createUser({ id: other });
    const read = await api("GET", "generation/context", { userId: other, ageGate: true, query: f.query });
    expectError(read, 404);
    expect(JSON.stringify(read.json)).not.toContain("blue kitchen");
    const quoted = await api("POST", "generation/quote", { userId: other, ageGate: true, body: { mode: "image", characterId: f.characterId, generationContextToken: handoff.token } });
    expectError(quoted, 403);
    const source = await api("GET", "generation/context", { userId: f.userId, ageGate: true, query: { ...f.query, mediaAssetId: `${f.id}-anchor` } });
    expectError(source, 404);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: { in: [f.userId, other] }, reason: "generation_spend" } })).toBe(0);
  });

  it("redacts source text after an actual Turn edit, rejects stale new requests, and can still recover an already accepted receipt", async () => {
    const f = await fixture();
    const handoff = await context(f);
    const body = await quotedBody(f, handoff.token);
    const headers = { "Idempotency-Key": `${f.id}-accepted` };
    const accepted = await api("POST", "generation/jobs", { userId: f.userId, ageGate: true, headers, body, autoGenerationQuote: false });
    expectOk(accepted, 202);
    await editChatTurn(f.userId, f.userMessageId, "We have moved to the garden.");
    const stale = await api("POST", "generation/jobs", { userId: f.userId, ageGate: true, headers: { "Idempotency-Key": `${f.id}-new` }, body, autoGenerationQuote: false });
    expectError(stale, 409);
    const replay = await api("POST", "generation/jobs", { userId: f.userId, ageGate: true, headers, body, autoGenerationQuote: false });
    expectOk(replay, 202);
    expect(replay.data.job.id).toBe(accepted.data.job.id);
    const alteredReplay = await api("POST", "generation/jobs", { userId: f.userId, ageGate: true, headers, body: { ...body, prompt: "A different paid intent" }, autoGenerationQuote: false });
    expectError(alteredReplay, 409);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: accepted.data.job.id } });
    expect(job.sourceMeta).toMatchObject({ promptHint: null, conversationContext: null, privacyRedaction: { reason: "logical_turn_edited" } });
    expect(job.momentSpec).toBeNull();
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.userId, reason: "generation_spend" } })).toBe(1);
  });
});

async function comicFixture(publicIdentity = false) {
  const f = await fixture();
  await prisma.user.update({ where: { id: f.userId }, data: { dataClass: "customer" } });
  await prisma.mediaAsset.update({ where: { id: f.source.id }, data: { characterId: f.characterId, prompt: "PRIVATE_AUTHOR_PROMPT_MUST_NOT_ESCAPE" } });
  if (publicIdentity) {
    await prisma.character.update({ where: { id: f.characterId }, data: { source: "official", visibility: "public" } });
    await publishCharacterForPublicAudience({ characterId: f.characterId, ownerId: f.userId });
  }
  const readerId = `${f.id}-reader`;
  await createUser({ id: readerId, dataClass: "customer" });
  await grantCoins(readerId, 500);
  await prisma.entitlement.createMany({ data: ["premium_controls", "premium_models"].map(key => ({ userId: readerId, key, value: true, source: "test" })) });
  const comic = await prisma.comic.create({ data: { id: `${f.id}-comic`, creatorId: f.userId,
    title: "A blue evening", description: "An authored story.", visibility: "public", allowRemix: true,
    status: "published", version: 3, publishedAt: new Date(), episodes: { create: { ordinal: 0, title: "At the window",
      pages: { create: { ordinal: 0, mediaAssetId: f.source.id, caption: "Keep the blue window. Change the cup to yellow.", sourceProvenance: {} } } } } },
    include: { episodes: { include: { pages: true } } } });
  const comicQuery = { kind: "comic", comicId: comic.id, comicVersion: String(comic.version), pageId: comic.episodes[0]!.pages[0]!.id };
  const readContext = () => api("GET", "generation/context", { userId: readerId, ageGate: true, query: comicQuery });
  return { ...f, readerId, comic, comicQuery, readContext };
}

async function comicQuote(f: Awaited<ReturnType<typeof comicFixture>>) {
  const response = await f.readContext(); expectOk(response);
  const context = parseGenerationContextResponse(response.json);
  const body = { mode: "image", generationContextToken: context.token, freeplay: context.identityMode === "source_only",
    ...(context.characterId ? { characterId: context.characterId } : {}), prompt: context.prompt, controls: {}, outputCount: 1 };
  const quoted = await api("POST", "generation/quote", { userId: f.readerId, ageGate: true, body }); expectOk(quoted);
  return { context, body: { ...body, quoteAuthority: quoteAuthorityFor(quoted.data.quote, 1)! } };
}

describe("Comic remix context and source grant", () => {
  it("allows source-only editing of a published page without reading a private Character Soul or author prompt", async () => {
    const f = await comicFixture();
    const { context, body } = await comicQuote(f);
    expect(context).toMatchObject({ source: { kind: "comic", comicId: f.comic.id, comicVersion: 3 }, identityMode: "source_only", characterId: null, characterName: null, pins: null, scene: null, prompt: "Keep the blue window. Change the cup to yellow." });
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE_AUTHOR_PROMPT|Original Mira|curious companion|chat-session|source-job/);
    const reader = await api("GET", `comics/${f.comic.id}`, { userId: f.readerId, ageGate: true }); expectOk(reader);
    expect(comicDetailSchema.parse(reader.data).episodes[0]!.pages[0]!.remixHref).toContain(`comicPageId=${f.comicQuery.pageId}`);
    const headers = { "Idempotency-Key": `${f.id}-comic-remix` };
    const first = await api("POST", "generation/jobs", { userId: f.readerId, ageGate: true, headers, body, autoGenerationQuote: false }); expectOk(first, 202);
    const replay = await api("POST", "generation/jobs", { userId: f.readerId, ageGate: true, headers, body, autoGenerationQuote: false }); expectOk(replay, 202);
    expect(replay.data.job.id).toBe(first.data.job.id);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: first.data.job.id } });
    expect(job).toMatchObject({ characterId: null, visualProfileId: null, referenceSetRevisionId: null, sourceType: "comic_remix", controls: { sourceImageAssetId: f.source.id }, sourceMeta: { comicId: f.comic.id, comicVersion: 3, comicPageId: f.comicQuery.pageId, identityMode: "source_only" } });
    expect(job.prompt).toContain("Change the cup to yellow");
    expect(JSON.stringify(job)).not.toContain("PRIVATE_AUTHOR_PROMPT");
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.readerId, reason: "generation_spend" } })).toBe(1);
    await prisma.generationJob.update({ where: { id: job.id }, data: { status: "failed" } });
    const retryHeaders = { "Idempotency-Key": `${f.id}-valid-retry` };
    const retried = await api("POST", `generation/jobs/${job.id}/retry`, { userId: f.readerId, ageGate: true, headers: retryHeaders }); expectOk(retried, 202);
    const retryReplay = await api("POST", `generation/jobs/${job.id}/retry`, { userId: f.readerId, ageGate: true, headers: retryHeaders, autoGenerationQuote: false }); expectOk(retryReplay, 202);
    expect(retryReplay.data.job.id).toBe(retried.data.job.id);
    expect(await prisma.generationJob.findUnique({ where: { id: retried.data.job.id } })).toMatchObject({ sourceType: "comic_remix", sourceId: null, derivedFromJobId: job.id, controls: { sourceImageAssetId: f.source.id } });
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.readerId, reason: "generation_spend" } })).toBe(2);

  });

  it("freezes a public source Character's original Release and references while using only the published page direction", async () => {
    const f = await comicFixture(true);
    const { context, body } = await comicQuote(f);
    expect(context).toMatchObject({ identityMode: "character", characterId: f.characterId, pins: { characterReleaseId: f.release.id, visualProfileId: f.visual.id, visualProfileVersion: f.visual.version, referenceSetRevisionId: f.referenceSet.id } });
    await prisma.character.update({ where: { id: f.characterId }, data: { name: "A later public name", description: "Later description" } });
    const created = await api("POST", "generation/jobs", { userId: f.readerId, ageGate: true, body, autoGenerationQuote: false }); expectOk(created, 202);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: created.data.job.id } });
    expect(job).toMatchObject({ characterId: f.characterId, visualProfileId: f.visual.id, referenceSetRevisionId: f.referenceSet.id, sourceType: "comic_remix", controls: { sourceImageAssetId: f.source.id } });
    expect(job.controls).toMatchObject({ visualIdentity: { referenceSetRevisionId: f.referenceSet.id } });
    expect(job.referenceManifest).toEqual(expect.arrayContaining([expect.objectContaining({ mediaAssetId: `${f.id}-anchor` })]));
    expect(job.prompt).toContain("Change the cup to yellow");
    expect(job.prompt).not.toMatch(/PRIVATE_AUTHOR_PROMPT|Later description|holding a green cup/);
  });

  it("requires the current explicit remix grant and never uses Comic ownership to bypass publication", async () => {
    const f = await comicFixture();
    await prisma.comic.update({ where: { id: f.comic.id }, data: { allowRemix: false } });
    expectError(await f.readContext(), 403);
    await prisma.comic.update({ where: { id: f.comic.id }, data: { allowRemix: true } });
    expectError(await api("GET", "generation/context", { userId: f.readerId, ageGate: true, query: { ...f.comicQuery, comicVersion: "2" } }), 409);
    expectError(await api("GET", "generation/context", { userId: f.readerId, ageGate: true, query: { ...f.comicQuery, pageId: "another-page" } }), 404);
    await prisma.comic.update({ where: { id: f.comic.id }, data: { status: "draft" } });
    expectError(await api("GET", "generation/context", { userId: f.userId, ageGate: true, query: f.comicQuery }), 404);
  });

  it("rejects tokens from another viewer and blocks quotes, new admission and retries after withdrawal while recovering the accepted receipt", async () => {
    const f = await comicFixture();
    const { body } = await comicQuote(f);
    expectError(await api("POST", "generation/quote", { userId: f.userId, ageGate: true, body }), 403);
    const headers = { "Idempotency-Key": `${f.id}-recover` };
    const accepted = await api("POST", "generation/jobs", { userId: f.readerId, ageGate: true, body, headers, autoGenerationQuote: false }); expectOk(accepted, 202);
    const withdrawal = await api("POST", `comics/${f.comic.id}/withdraw`, { userId: f.userId, ageGate: true, body: { version: 3 } }); expectOk(withdrawal);
    expectError(await api("POST", "generation/quote", { userId: f.readerId, ageGate: true, body }), 404);
    expectError(await api("POST", "generation/jobs", { userId: f.readerId, ageGate: true, body, autoGenerationQuote: false }), 404);
    const recovered = await api("POST", "generation/jobs", { userId: f.readerId, ageGate: true, body, headers, autoGenerationQuote: false }); expectOk(recovered, 202);
    expect(recovered.data.job.id).toBe(accepted.data.job.id);
    await prisma.generationJob.update({ where: { id: accepted.data.job.id }, data: { status: "failed" } });
    const retryQuote = await api("POST", `generation/jobs/${accepted.data.job.id}/retry/quote`, { userId: f.readerId, ageGate: true });
    expectError(retryQuote, 404);
    expect(retryQuote.error?.message).toContain("Comic");
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.readerId, reason: "generation_spend" } })).toBe(1);
  });

  it("replays a persisted v1 Chat request without normalizing its original token field", async () => {
    const f = await fixture();
    const current = await context(f);
    const loaded = await resolveGenerationContext(f.userId, current.token);
    const legacyToken = signGenerationContext({ version: 1, userId: f.userId, sessionId: f.sessionId, turnId: f.turnId, attempt: 1, digest: loaded.digest });
    const body = { mode: "image", characterId: f.characterId, chatHandoffToken: legacyToken, prompt: "At the original blue window." };
    const quote = await api("POST", "generation/quote", { userId: f.userId, ageGate: true, body }); expectOk(quote);
    const completeBody = { ...body, quoteAuthority: quoteAuthorityFor(quote.data.quote, 1)! };
    const headers = { "Idempotency-Key": `${f.id}-legacy-receipt` };
    const first = await api("POST", "generation/jobs", { userId: f.userId, ageGate: true, body: completeBody, headers, autoGenerationQuote: false }); expectOk(first, 202);
    const again = await api("POST", "generation/jobs", { userId: f.userId, ageGate: true, body: completeBody, headers, autoGenerationQuote: false }); expectOk(again, 202);
    expect(again.data.job.id).toBe(first.data.job.id);
    expect(await prisma.dreamcoinLedger.count({ where: { userId: f.userId, reason: "generation_spend" } })).toBe(1);
  });
});
