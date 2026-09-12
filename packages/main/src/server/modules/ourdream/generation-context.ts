import { createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { chatExecutionSnapshotSchema, chatSceneStateSchema, loadCharacterSoulSnapshot } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { hasHydratableMediaBlobAuthority, isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import { canonicalJsonHash } from "@/server/modules/admin-v2/shared/idempotency";
import { characterContentHash } from "@/server/modules/admin-v2/shared/character-content-identity";
import { lockCharacterGenerationAuthority } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { lockChatScope } from "@/server/modules/chat/turn-scope";
import type { GenerationPromptCharacter } from "./generation-character-authority";
import type { GenerationCreateBody, GenerationSource } from "./generation-request-schema";
import { loadReadableComic, comicContentUrl } from "./comic-authority";
import { directCharacterAudienceWhere, publicCharacterAudienceWhere } from "./public-content-audience";
import { collectionMediaViewUrl } from "./public-read-model";
import { jsonRecord } from "./json-values";

const chatSelectorSchema = z.object({
  sessionId: z.string().min(1).max(160),
  turnId: z.string().min(1).max(160),
  attempt: z.coerce.number().int().positive(),
  mediaAssetId: z.string().min(1).max(160).optional(),
}).strict();
export const generationContextSelectorSchema = z.discriminatedUnion("kind", [
  chatSelectorSchema.extend({ kind: z.literal("chat") }).strict(),
  z.object({ kind: z.literal("comic"), comicId: z.string().min(1).max(160),
    comicVersion: z.coerce.number().int().positive(), pageId: z.string().min(1).max(160) }).strict(),
]);
const legacyTokenPayloadSchema = chatSelectorSchema.extend({
  version: z.literal(1), userId: z.string().min(1).max(160), digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const tokenPayloadSchema = z.object({
  version: z.literal(2), userId: z.string().min(1).max(160), digest: z.string().regex(/^[a-f0-9]{64}$/),
  source: generationContextSelectorSchema,
  comicGrant: z.object({ mediaAssetId: z.string().min(1).max(160), allowRemix: z.literal(true) }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.source.kind === "comic") !== Boolean(value.comicGrant)) ctx.addIssue({ code: "custom", path: ["comicGrant"], message: "Comic contexts require their exact signed source grant" });
});
const readableTokenSchema = z.union([legacyTokenPayloadSchema, tokenPayloadSchema]);
export type GenerationContextSelector = z.infer<typeof generationContextSelectorSchema>;
type ContextDatabase = Pick<Prisma.TransactionClient,
  "chatTurn" | "character" | "characterContentVersion" | "characterRelease" |
  "characterProject" | "characterServing" | "characterVisualProfile" |
  "referenceSetRevision" | "generationJob" | "mediaAsset" | "comic">;

// No timestamp or nonce: refreshing an unchanged source must preserve an unknown receipt.
// v1 is read/sign compatible solely for already persisted Chat requests and their tests.
export function signGenerationContext(payload: z.infer<typeof readableTokenSchema>, secret = env.BETTER_AUTH_SECRET) {
  const parsed = readableTokenSchema.parse(payload);
  const encoded = Buffer.from(JSON.stringify(parsed)).toString("base64url");
  const domain = parsed.version === 1 ? "generation-handoff-v1" : "generation-context-v2";
  const signature = createHmac("sha256", secret).update(`${domain}:${encoded}`).digest("base64url");
  return `${encoded}.${signature}`;
}

export function readGenerationContextToken(token: string, userId: string, secret = env.BETTER_AUTH_SECRET) {
  const invalid = () => Errors.badRequest("Generation context is invalid. Open Generate from its original source again.");
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra || token.length > 4096) throw invalid();
  let payload: z.infer<typeof readableTokenSchema>;
  try { payload = readableTokenSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))); }
  catch { throw invalid(); }
  const domain = payload.version === 1 ? "generation-handoff-v1" : "generation-context-v2";
  const expected = createHmac("sha256", secret).update(`${domain}:${encoded}`).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw invalid();
  if (payload.userId !== userId) throw Errors.forbidden("This generation context belongs to another account. Sign in to the original account.");
  return { userId: payload.userId, digest: payload.digest, comicGrant: payload.version === 2 ? payload.comicGrant : undefined, source: payload.version === 2 ? payload.source : {
    kind: "chat" as const, sessionId: payload.sessionId, turnId: payload.turnId, attempt: payload.attempt,
    ...(payload.mediaAssetId ? { mediaAssetId: payload.mediaAssetId } : {}),
  } };
}

export function generationContextToken(body: Pick<GenerationCreateBody, "generationContextToken" | "chatHandoffToken">) {
  return body.generationContextToken ?? body.chatHandoffToken;
}

function attachmentAttempt(metadata: unknown) {
  const root = jsonRecord(metadata);
  const value = root.attempt ?? jsonRecord(root.effect).attempt;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

async function loadChatContext(userId: string, selector: z.infer<typeof chatSelectorSchema>, db: ContextDatabase) {
  const turn = await db.chatTurn.findFirst({
    where: { id: selector.turnId, sessionId: selector.sessionId, session: { userId, status: { not: "deleted" } } },
    include: { session: true, attachments: true },
  });
  if (!turn) throw Errors.notFound("The original chat is no longer available.");
  if (turn.attempt !== selector.attempt || turn.assistantStatus !== "sent") {
    throw Errors.conflict("The original chat reply changed or is still running. Return to the chat and open its current reply.");
  }
  const execution = chatExecutionSnapshotSchema.safeParse(turn.executionSnapshot);
  const parsedScene = chatSceneStateSchema.nullable().safeParse(turn.scene);
  if (!execution.success || !parsedScene.success || (parsedScene.data?.version ?? 0) !== turn.sceneVersion) {
    throw Errors.conflict("The original chat has no complete frozen scene. Return to the chat before generating.");
  }
  const snapshot = execution.data;
  if (snapshot.turnId !== turn.id || snapshot.sessionId !== turn.sessionId || snapshot.attempt !== turn.attempt || snapshot.userId !== userId ||
    snapshot.characterId !== turn.session.characterId || snapshot.characterContentVersionId !== turn.characterContentVersionId ||
    snapshot.characterReleaseId !== turn.characterReleaseId || snapshot.characterVisualProfileId !== turn.characterVisualProfileId ||
    snapshot.characterVisualProfileVersion !== turn.characterVisualProfileVersion) {
    throw Errors.conflict("The original chat identity no longer matches its frozen execution.");
  }
  const liveCharacter = await db.character.findFirst({
    where: { id: snapshot.characterId, deletedAt: null, age: { gte: 18 }, status: "approved", OR: [{ creatorId: userId }, directCharacterAudienceWhere] },
  });
  if (!liveCharacter) throw Errors.notFound("The original character is no longer available to this account.");
  const content = await db.characterContentVersion.findUnique({ where: { id: snapshot.characterContentVersionId } });
  const soul = loadCharacterSoulSnapshot(content?.personaSnapshot);
  if (!content || content.characterId !== snapshot.characterId || !soul.ok) {
    throw Errors.conflict("The original character content is unavailable. Its current version cannot replace the chat version.");
  }
  // The current authoring hash and historical import hashes have different,
  // intentionally frozen formulas. Only v3 rows use this compiler identity.
  if (jsonRecord(content.personaSnapshot).schemaVersion === 3 && content.contentHash !== characterContentHash({
    personaSnapshot: { schemaVersion: 3, soul: soul.snapshot.soul, compiled: soul.snapshot.compiled },
    openingSnapshot: content.openingSnapshot, appearanceSnapshot: content.appearanceSnapshot,
  })) throw Errors.conflict("The original character content is unavailable. Its current version cannot replace the chat version.");
  const appearance = jsonRecord(content.appearanceSnapshot);
  const character: GenerationPromptCharacter = {
    id: liveCharacter.id, imageAssetId: null,
    name: soul.snapshot.soul.name, age: soul.snapshot.soul.age,
    gender: soul.snapshot.soul.gender, description: soul.snapshot.soul.characterPromise,
    style: typeof appearance.style === "string" ? appearance.style : null,
    appearance: content.appearanceSnapshot, advancedDetails: {},
  };
  if (character.age < 18) throw Errors.forbidden("The original character is not eligible for generation.");
  const release = snapshot.characterReleaseId
    ? await db.characterRelease.findUnique({ where: { id: snapshot.characterReleaseId } }) : null;
  if (snapshot.characterReleaseId) {
    const project = release ? await db.characterProject.findUnique({ where: { id: release.projectId }, select: { characterId: true } }) : null;
    if (!release || project?.characterId !== character.id || release.characterContentVersionId !== content.id ||
      !["published", "superseded"].includes(release.status) || release.visualProfileId !== snapshot.characterVisualProfileId ||
      release.visualProfileVersion !== snapshot.characterVisualProfileVersion) {
      throw Errors.gone("The original Character Release is unavailable. Return to the chat to choose an available version.");
    }
  }
  let visualProfileId = snapshot.characterVisualProfileId;
  let visualProfileVersion = snapshot.characterVisualProfileVersion;
  let referenceSetRevisionId = release?.referenceSetRevisionId ?? null;
  // Legacy portraits are qualified only for their live editorial Release. Never
  // substitute a newer portrait when that historical qualification is unavailable.
  if (release?.legacy) {
    const serving = await db.characterServing.findUnique({ where: { characterId: character.id } });
    const sourceAssetId = jsonRecord(release.generationProvenance).sourceAssetId;
    if (serving?.currentReleaseId !== release.id || serving.state !== "live" || typeof sourceAssetId !== "string") {
      throw Errors.gone("This historical editorial portrait is no longer qualified for new generation. Return to the chat to choose an available version.");
    }
    const profile = await db.characterVisualProfile.findFirst({
      where: { characterId: character.id, status: "active", evidenceState: "qualified", adapterRefs: { path: ["sourceAssetId"], equals: sourceAssetId } },
      orderBy: { version: "desc" },
    });
    visualProfileId = profile?.id ?? null;
    visualProfileVersion = profile?.version ?? null;
  }
  if (!visualProfileId || !visualProfileVersion) throw Errors.conflict("The original chat has no qualified visual identity for generation.");
  const visualProfile = await db.characterVisualProfile.findFirst({ where: { id: visualProfileId, characterId: character.id, version: visualProfileVersion } });
  if (!visualProfile) throw Errors.gone("The original visual identity is unavailable.");
  if (!referenceSetRevisionId) {
    const reference = await db.referenceSetRevision.findFirst({
      where: { visualProfileId, ...(release?.legacy ? {} : { createdAt: { lte: turn.createdAt } }) },
      orderBy: { revision: "desc" },
    });
    referenceSetRevisionId = reference?.id ?? null;
  }
  if (!referenceSetRevisionId) throw Errors.conflict("The original visual identity has no frozen reference set.");
  let sourceMedia: { id: string; url: string; thumbnailUrl: string } | null = null;
  let acceptedBrief: string | null = null;
  let sourceGenerationJobId: string | null = null;
  if (selector.mediaAssetId) {
    const attachment = turn.attachments.find(item => item.mediaAssetId === selector.mediaAssetId && item.status === "completed" && attachmentAttempt(item.metadata) === turn.attempt);
    const job = attachment?.generationJobId ? await db.generationJob.findFirst({ where: { id: attachment.generationJobId, userId, characterId: character.id } }) : null;
    const asset = job ? await db.mediaAsset.findFirst({ where: { id: selector.mediaAssetId, sourceJobId: job.id, ownerId: userId, type: "image", deletedAt: null, safetyStatus: "passed" } }) : null;
    if (!attachment || !job || !asset || !isMediaAssetOperationalForAuthority(asset.metadata) || !hasHydratableMediaBlobAuthority(asset)) {
      throw Errors.notFound("The image is no longer an available delivery of this chat reply.");
    }
    if (job.visualProfileId !== visualProfileId || job.visualProfileVersion !== visualProfileVersion || job.referenceSetRevisionId !== referenceSetRevisionId) {
      throw Errors.conflict("The delivered image does not match the original chat identity. It cannot be silently rebound.");
    }
    const rawInput = jsonRecord(job.momentSpec).rawInput;
    acceptedBrief = typeof rawInput === "string" && rawInput.trim() ? rawInput : attachment.promptHint;
    sourceGenerationJobId = job.id;
    const url = collectionMediaViewUrl(asset);
    sourceMedia = { id: asset.id, url, thumbnailUrl: url };
  }
  const scene = parsedScene.data;
  const sceneDirection = scene ? [
    scene.location && `Location: ${scene.location}`, scene.time && `Time: ${scene.time}`,
    scene.participants.length && `Participants: ${scene.participants.join(", ")}`,
    scene.emotionalBeat && `Moment: ${scene.emotionalBeat}`,
    scene.unresolvedThreads.length && `Current situation: ${scene.unresolvedThreads.join("; ")}`,
  ].filter(Boolean).join(". ") : "";
  // A conversation command is not an accepted visual brief. Empty Scene fields
  // require the user to supply image direction; never pretend to infer a scene.
  const prompt = acceptedBrief ?? sceneDirection;
  const pins = { characterContentVersionId: content.id, characterReleaseId: release?.id ?? null,
    releaseSnapshotHash: release?.snapshotHash ?? null, visualProfileId, visualProfileVersion, referenceSetRevisionId };
  const digest = canonicalJsonHash({ version: 1, userId, ...selector, pins, contentHash: content.contentHash,
    contentSnapshotHash: canonicalJsonHash({ persona: content.personaSnapshot, opening: content.openingSnapshot, appearance: content.appearanceSnapshot }),
    visualProfileHash: visualProfile.immutableHash, scene, userContent: turn.userContent, assistantContent: turn.assistantContent,
    acceptedBrief, sourceGenerationJobId });
  return { ...selector, source: { kind: "chat" as const, ...selector }, identityMode: "character" as const,
    digest, pins, character, characterId: character.id, characterName: character.name,
    scene, prompt, sourceMedia, sourceGenerationJobId, legacyRelease: release?.legacy ?? false,
    authorityMediaAssetIds: sourceMedia ? [sourceMedia.id] : [],
    returnHref: `/chat/${encodeURIComponent(selector.sessionId)}`, sourceLabel: "your chat" };
}

async function loadComicIdentity(asset: { characterId: string | null; sourceJobId: string | null; ownerId: string | null }, db: ContextDatabase) {
  if (!asset.characterId || !asset.sourceJobId) return null;
  const publicCharacter = await db.character.findFirst({ where: { AND: [{ id: asset.characterId }, publicCharacterAudienceWhere] } });
  if (!publicCharacter) return null;
  // Read only identity pins from the source job. Its prompt, controls and conversation
  // belong to another author and are never inputs to a Comic remix.
  const job = await db.generationJob.findFirst({ where: { id: asset.sourceJobId, userId: asset.ownerId ?? undefined, characterId: publicCharacter.id, status: "completed" },
    select: { visualProfileId: true, visualProfileVersion: true, referenceSetRevisionId: true } });
  if (!job?.visualProfileId || !job.visualProfileVersion || !job.referenceSetRevisionId) return null;
  const projects = await db.characterProject.findMany({ where: { characterId: publicCharacter.id }, select: { id: true } });
  if (!projects.length) return null;
  const release = await db.characterRelease.findFirst({ where: { projectId: { in: projects.map(project => project.id) },
    visualProfileId: job.visualProfileId, visualProfileVersion: job.visualProfileVersion,
    referenceSetRevisionId: job.referenceSetRevisionId, status: { in: ["published", "superseded"] }, legacy: false },
    orderBy: { publishedAt: "desc" } });
  if (!release) return null;
  // Serial on purpose: `db` may be a transaction adapter that owns one pg client.
  const content = await db.characterContentVersion.findUnique({ where: { id: release.characterContentVersionId } });
  const visual = await db.characterVisualProfile.findFirst({ where: { id: job.visualProfileId, characterId: publicCharacter.id, version: job.visualProfileVersion } });
  const referenceSet = await db.referenceSetRevision.findFirst({ where: { id: job.referenceSetRevisionId, visualProfileId: job.visualProfileId } });
  const soul = loadCharacterSoulSnapshot(content?.personaSnapshot);
  if (!content || content.characterId !== publicCharacter.id || !soul.ok || soul.snapshot.soul.age < 18 || !visual || !referenceSet) return null;
  if (jsonRecord(content.personaSnapshot).schemaVersion === 3 && content.contentHash !== characterContentHash({
    personaSnapshot: { schemaVersion: 3, soul: soul.snapshot.soul, compiled: soul.snapshot.compiled },
    openingSnapshot: content.openingSnapshot, appearanceSnapshot: content.appearanceSnapshot,
  })) throw Errors.conflict("The source Character identity is no longer available.");
  const appearance = jsonRecord(content.appearanceSnapshot);
  const character: GenerationPromptCharacter = { id: publicCharacter.id, imageAssetId: null,
    name: soul.snapshot.soul.name, age: soul.snapshot.soul.age, gender: soul.snapshot.soul.gender,
    description: soul.snapshot.soul.characterPromise, style: typeof appearance.style === "string" ? appearance.style : null,
    appearance: content.appearanceSnapshot, advancedDetails: {} };
  return { character, pins: { characterContentVersionId: content.id, characterReleaseId: release.id,
    releaseSnapshotHash: release.snapshotHash, visualProfileId: visual.id, visualProfileVersion: visual.version, referenceSetRevisionId: referenceSet.id },
    identityHash: canonicalJsonHash({ contentHash: content.contentHash, contentSnapshot: { persona: content.personaSnapshot, opening: content.openingSnapshot, appearance: content.appearanceSnapshot },
      visualProfileHash: visual.immutableHash, referenceSetHash: referenceSet.snapshotHash }) };
}

async function loadComicContext(userId: string, source: Extract<GenerationContextSelector, { kind: "comic" }>, db: ContextDatabase) {
  // Author ownership does not bypass the public remix grant.
  const comic = await loadReadableComic(source.comicId, undefined, false, db);
  if (comic.version !== source.comicVersion) throw Errors.conflict("This Comic version changed. Reopen its current page before remixing.");
  if (!comic.allowRemix) throw Errors.forbidden("The author has not enabled remixing for this Comic.");
  const episode = comic.episodes.find(item => item.pages.some(page => page.id === source.pageId));
  const page = episode?.pages.find(item => item.id === source.pageId);
  if (!episode || !page?.mediaAsset) throw Errors.notFound("The original Comic page is no longer available.");
  const identity = await loadComicIdentity(page.mediaAsset, db);
  const prompt = page.caption;
  const url = comicContentUrl(comic.id, page.id);
  const sourceMedia = { id: page.mediaAsset.id, url, thumbnailUrl: url };
  const pins = identity?.pins ?? null;
  const digest = canonicalJsonHash({ version: 2, userId, source, title: comic.title, description: comic.description,
    chapterTitle: episode.title, caption: page.caption, sourceMediaId: sourceMedia.id, pins, identityHash: identity?.identityHash ?? null });
  return { source, identityMode: identity ? "character" as const : "source_only" as const,
    digest, pins, character: identity?.character ?? null, characterId: identity?.character.id ?? null,
    characterName: identity?.character.name ?? null, scene: null, prompt, sourceMedia,
    sourceGenerationJobId: null, legacyRelease: false,
    authorityMediaAssetIds: comic.episodes.flatMap(item => item.pages.flatMap(item => item.mediaAssetId ? [item.mediaAssetId] : [])),
    returnHref: `/comics/${encodeURIComponent(comic.id)}#chapter-${episode.id}`, sourceLabel: comic.title };
}

export async function loadGenerationContext(userId: string, input: GenerationContextSelector, db: ContextDatabase = prisma) {
  const source = generationContextSelectorSchema.parse(input);
  if (source.kind === "comic") return loadComicContext(userId, source, db);
  const selector = chatSelectorSchema.parse({ sessionId: source.sessionId, turnId: source.turnId, attempt: source.attempt, ...(source.mediaAssetId ? { mediaAssetId: source.mediaAssetId } : {}) });
  return loadChatContext(userId, selector, db);
}
export type GenerationContext = Awaited<ReturnType<typeof loadGenerationContext>>;

export async function resolveGenerationContext(userId: string, token: string, db: ContextDatabase = prisma) {
  const payload = readGenerationContextToken(token, userId);
  const context = await loadGenerationContext(userId, payload.source, db);
  if (payload.source.kind === "comic" && payload.comicGrant?.mediaAssetId !== context.sourceMedia?.id) throw Errors.conflict("The original Comic source image changed.");
  if (context.digest !== payload.digest) throw Errors.conflict("The original generation context changed. Return to its source and review it again.");
  return context;
}

export async function lockGenerationContext(tx: Prisma.TransactionClient, userId: string, token: string) {
  const { source } = readGenerationContextToken(token, userId);
  // Admission owns User first. Both source kinds lock their authority before
  // Character, then the caller locks all source and identity media in sorted order.
  if (source.kind === "chat") {
    // 聊天侧的锁序由产品 Turn 权威回答，本文件不再自带一份 recent_chats → chat_turns。
    const scope = await lockChatScope(tx, {
      userId,
      at: { turn: source.turnId },
      expect: { conflictMessage: "The original chat is no longer available." },
    });
    if (scope.session.sessionId !== source.sessionId) throw Errors.notFound("The original chat is no longer available.");
    await lockCharacterGenerationAuthority(tx, scope.session.characterId);
  } else {
    await tx.$queryRaw`SELECT id FROM comics WHERE id = ${source.comicId} FOR UPDATE`;
    const page = await tx.comicPage.findFirst({ where: { id: source.pageId, episode: { comicId: source.comicId } }, select: { mediaAsset: { select: { characterId: true } } } });
    if (page?.mediaAsset?.characterId) await lockCharacterGenerationAuthority(tx, page.mediaAsset.characterId);
  }
  return resolveGenerationContext(userId, token, tx);
}

export function applyGenerationContext(body: GenerationCreateBody, context: GenerationContext, options: { allowVideo?: boolean } = {}): GenerationCreateBody {
  const validMode = body.mode === "image" || (options.allowVideo && context.source.kind === "chat" && body.mode === "video" && context.sourceMedia);
  const validIdentity = context.characterId ? !body.freeplay && body.characterId === context.characterId : body.freeplay && !body.characterId;
  if (!validMode || !validIdentity || body.remixFeedItemId ||
    (body.visualProfileId && body.visualProfileId !== context.pins?.visualProfileId)) {
    throw Errors.badRequest("Generation context must use its original character or source image and permitted mode. Leave the context before changing the target.");
  }
  const prompt = body.prompt ?? context.prompt;
  if (prompt.trim().length > 900) throw Errors.badRequest("Keep the complete image direction within 900 characters. Shorten it without losing the scene or requested changes.");
  return { ...body, visualProfileId: context.pins?.visualProfileId, prompt,
    controls: { ...body.controls, ...(context.sourceMedia ? { sourceImageAssetId: context.sourceMedia.id } : {}) } };
}

export function generationContextSource(context: GenerationContext, token: string, idempotencyKey: string): GenerationSource {
  return { sourceType: context.source.kind === "chat" ? "chat_handoff" : "comic_remix", sourceId: `${context.digest}:${idempotencyKey}`,
    sourceMeta: { ...(context.source.kind === "chat" ? { sessionId: context.source.sessionId, exchangeId: context.source.turnId, attempt: context.source.attempt } :
      { comicId: context.source.comicId, comicVersion: context.source.comicVersion, comicPageId: context.source.pageId }),
      generationContextToken: token, generationContextDigest: context.digest, identityMode: context.identityMode, ...context.pins,
      sourceMediaId: context.sourceMedia?.id ?? null, sourceGenerationJobId: context.sourceGenerationJobId,
      promptHint: context.prompt, conversationContext: context.scene } };
}

/** New source records use the generic field; persisted Chat jobs retain their v1 field. */
export function generationContextSourceToken(source: { sourceType: string; sourceMeta: unknown }): string | null {
  if (!["chat_handoff", "comic_remix", "chat_video"].includes(source.sourceType)) return null;
  const metadata = jsonRecord(source.sourceMeta);
  const token = metadata.generationContextToken ?? metadata.handoffToken;
  if (typeof token !== "string" || !token) throw Errors.conflict("The original generation context is unavailable for retry.");
  return token;
}
