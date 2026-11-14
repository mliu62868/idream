import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { searchCharacterMediaArgsSchema, searchCharacterMediaResultSchema, sendCharacterMediaArgsSchema, type SearchCharacterMediaArgs, type SearchCharacterMediaResult, type SendCharacterMediaResult } from "@idream/shared/chat/media-library";
import { chatExecutionSnapshotSchema, type ChatExecutionSnapshot, type ChatToolEffect } from "@idream/shared/contracts";
import { Prisma, type CharacterMediaLibraryEntry, type ChatTurn, type ChatTurnAttachment, type RecentChat } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { resolveMediaAssetBlobLocator, SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA } from "@/server/lib/media-asset-authority";
import { providers } from "@/server/providers";
import { lockCharacterGenerationAuthority, lockMediaAssetAuthority } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { assertLibraryEntryAvailable, deliveredLibraryMedia, searchCharacterMediaLibrary, type LibrarySearchCandidate } from "@/server/modules/character-media-library/service";
import { mediaLibraryPosterViewUrl, mediaViewUrl } from "@/server/modules/ourdream/public-read-model";
import { deliveredChatMedia } from "./chat-media-history";
import { createToolEffectAttachment, transitionToolEffectAttachment } from "./tool-effect-attachment";
import { assertChatSessionServingAuthority } from "./turn-ledger";
import { attachmentAttempt, lockChatScope } from "./turn-scope";

const candidateSchema = z.object({
  lookupId: z.string().uuid(), source: z.enum(["library", "previous_media"]),
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/), revision: z.number().int().nonnegative(),
  signature: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
}).strict();
const lookupSchema = z.object({
  version: z.literal(1), attempt: z.number().int().positive(), lookupId: z.string().uuid(),
  status: z.enum(["pending", "ready", "failed"]), args: searchCharacterMediaArgsSchema,
}).strict();
type Candidate = z.infer<typeof candidateSchema>;
type Lookup = z.infer<typeof lookupSchema>;
type Turn = ChatTurn & { session: RecentChat };
type MediaFacts = { kind: string; nudity: string; durationSeconds: number | null; hasAudio: boolean | null };

function frozen(turn: ChatTurn, session: RecentChat, effect: ChatToolEffect) {
  const parsed = chatExecutionSnapshotSchema.safeParse(turn.executionSnapshot);
  if (!parsed.success || parsed.data.turnId !== turn.id || parsed.data.attempt !== effect.attempt
    || turn.attempt !== effect.attempt || parsed.data.userContent !== turn.userContent
    || parsed.data.userId !== session.userId || parsed.data.sessionId !== session.sessionId
    || parsed.data.characterId !== session.characterId) {
    throw Errors.forbidden("Media tools require the current frozen Chat attempt");
  }
  return parsed.data;
}

export async function searchChatCharacterMedia(effect: ChatToolEffect, turn: Turn): Promise<SearchCharacterMediaResult> {
  const parsed = searchCharacterMediaArgsSchema.safeParse(effect.arguments);
  const intentMatches = parsed.success && (parsed.data.requestedNudity === undefined || parsed.data.requestedNudity === effect.intent.requestedNudity);
  const lookup: Lookup | null = parsed.success && intentMatches
    ? { version: 1, attempt: effect.attempt, lookupId: randomUUID(), status: "pending",
      args: searchCharacterMediaArgsSchema.parse({ ...parsed.data, requestedNudity: effect.intent.requestedNudity }) } : null;
  const snapshot = await prisma.$transaction(async tx => {
    const scope = await lockChatScope(tx, { userId: turn.session.userId, at: { turn: effect.turnId },
      expect: { attempt: effect.attempt, assistantStatus: ["pending", "generating"] } });
    if (scope.session.status !== "active") throw Errors.gone("Chat session is archived");
    const current = scope.turn!;
    const snapshot = frozen(current, scope.session, effect);
    await assertChatSessionServingAuthority(tx, scope.userId, scope.session);
    if (current.imageActionMode !== "library") {
      const imageAction = await tx.chatTurnAttachment.findFirst({
        where: { turnId: current.id, kind: "generated_image", metadata: { path: ["attempt"], equals: effect.attempt } },
        select: { id: true },
      });
      if (imageAction) throw Errors.conflict("This message already has an image action");
    }
    // Replacing the lookup before any model or blob I/O immediately revokes all
    // earlier candidates, even if this lookup misses, fails or finishes late.
    await tx.chatTurn.update({ where: { id: current.id }, data: { imageActionMode: "library", mediaLookup: lookup ? json(lookup) : Prisma.JsonNull } });
    return snapshot;
  });
  if (!parsed.success) throw parsed.error;
  if (!lookup) throw Errors.badRequest("Media lookup and wardrobe intent differ");
  try {
    const result = lookup.args.previousMediaAssetId
      ? await searchPreviousMedia(snapshot, turn, effect, lookup)
      : await searchLibraryMedia(snapshot, lookup);
    if (!await settleLookup(snapshot, lookup, "ready")) throw Errors.conflict("A newer media lookup replaced this result; search again");
    return result;
  } catch (error) {
    await settleLookup(snapshot, lookup, "failed");
    throw error;
  }
}

async function settleLookup(snapshot: ChatExecutionSnapshot, lookup: Lookup, status: "ready" | "failed") {
  return prisma.$transaction(async tx => {
    const scope = await lockChatScope(tx, { userId: snapshot.userId, at: { turn: snapshot.turnId }, allowDeletedSession: true });
    const current = scope.turn!;
    const saved = lookupSchema.safeParse(current.mediaLookup);
    if (current.attempt !== snapshot.attempt || !saved.success || saved.data.lookupId !== lookup.lookupId
      || !["pending", "generating"].includes(current.assistantStatus)) return false;
    await tx.chatTurn.update({ where: { id: current.id }, data: { mediaLookup: json({ ...lookup, status }) } });
    return true;
  });
}

async function searchLibraryMedia(snapshot: ChatExecutionSnapshot, lookup: Lookup): Promise<SearchCharacterMediaResult> {
  if (!snapshot.characterVisualProfileId || !snapshot.characterVisualProfileVersion) return { accepted: true, status: "no_match", matches: [] };
  const { minDurationSeconds, maxDurationSeconds, hasAudio, previousMediaAssetId: _previous, ...discovery } = lookup.args;
  const search = { ...discovery, userId: snapshot.userId, characterId: snapshot.characterId,
    visualProfileId: snapshot.characterVisualProfileId, visualProfileVersion: snapshot.characterVisualProfileVersion };
  const matches = await searchCharacterMediaLibrary({ ...search, minDurationSeconds, maxDurationSeconds, hasAudio });
  if (matches.length) return searchCharacterMediaResultSchema.parse({
    accepted: true, status: "matches", matches: matches.map(candidate => ({ ...candidateFacts(candidate),
      candidateToken: signCandidate(snapshot, lookup, libraryIdentity(candidate.entry)) })),
  });
  if (minDurationSeconds !== undefined || maxDurationSeconds !== undefined || hasAudio !== undefined) {
    const observed = await searchCharacterMediaLibrary(search);
    if (observed.length) return searchCharacterMediaResultSchema.parse({
      accepted: true, status: "review_video_filters", matches: [], observedVideos: observed.map(candidateFacts),
    });
  }
  return { accepted: true, status: "no_match", matches: [] };
}

async function searchPreviousMedia(snapshot: ChatExecutionSnapshot, turn: Turn, effect: ChatToolEffect, lookup: Lookup): Promise<SearchCharacterMediaResult> {
  const checked = await checkPreviousMediaBlob(turn, effect, lookup.args.previousMediaAssetId!);
  const facts = previousFacts(checked.previous);
  if (!matchesPolicy(facts, lookup.args, false) || lookup.args.unseenOnly === true) return { accepted: true, status: "no_match", matches: [] };
  if (!matchesPolicy(facts, lookup.args)) return searchCharacterMediaResultSchema.parse({
    accepted: true, status: "review_video_filters", matches: [], observedVideos: [facts],
  });
  return searchCharacterMediaResultSchema.parse({ accepted: true, status: "matches", matches: [{ ...facts,
    candidateToken: signCandidate(snapshot, lookup, previousIdentity(checked)) }] });
}

function candidateFacts({ entry, score, alreadySent }: LibrarySearchCandidate) {
  return { kind: entry.kind, description: entry.description, facts: entry.facts, nudity: entry.nudity,
    absentFacts: entry.absentFacts, durationSeconds: entry.durationSeconds, hasAudio: entry.hasAudio, score, alreadySent };
}

function previousFacts(previous: Awaited<ReturnType<typeof deliveredChatMedia>>[number]) {
  return { kind: previous.asset.type === "video" ? "video" as const : "image" as const,
    description: previous.description ?? "Previously delivered media whose visible contents have not been described.",
    facts: previous.facts, absentFacts: previous.absentFacts, nudity: previous.nudity,
    durationSeconds: previous.durationSeconds, hasAudio: previous.hasAudio, alreadySent: true, score: 1 };
}

function matchesPolicy(facts: MediaFacts, args: SearchCharacterMediaArgs, technical = true) {
  return facts.kind === args.kind && (args.requestedNudity === undefined || args.requestedNudity === "unspecified" || facts.nudity === args.requestedNudity)
    && (!technical || ((args.minDurationSeconds === undefined || (facts.durationSeconds !== null && facts.durationSeconds >= args.minDurationSeconds))
      && (args.maxDurationSeconds === undefined || (facts.durationSeconds !== null && facts.durationSeconds <= args.maxDurationSeconds))
      && (args.hasAudio === undefined || facts.hasAudio === args.hasAudio)));
}

/** A free delivery and its owned MediaAsset commit together, without a Generation Request. */
export async function deliverChatCharacterMedia(input: {
  effect: ChatToolEffect; judged: Turn; attachmentId: string; requestDigest: string;
}): Promise<SendCharacterMediaResult> {
  const { effect, judged, attachmentId, requestDigest } = input;
  const args = sendCharacterMediaArgsSchema.parse(effect.arguments);
  // A concurrent commit can win even if this check fails. Consult the locked
  // receipt before surfacing the failure or attempting a new delivery.
  const checked = await ("candidateToken" in args
    ? checkCandidateBlob(judged, effect, readCandidate(args.candidateToken))
    : Promise.reject(Errors.conflict("A new media delivery requires a candidateToken from the latest lookup"))).then(
    value => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return prisma.$transaction(async tx => {
    const scope = await lockChatScope(tx, { userId: judged.session.userId, at: { turn: effect.turnId },
      expect: { attempt: effect.attempt } });
    const turn = scope.turn!;
    const raced = await tx.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
    if (raced) {
      const receipt = record(record(raced.metadata).effect);
      if (receipt.name !== effect.name || receipt.effectScope !== "turn_action"
        || attachmentAttempt(raced.metadata) !== effect.attempt) throw Errors.conflict("This Turn already has a different media action");
      return characterMediaReceipt(raced, true);
    }
    if (!("candidateToken" in args)) throw Errors.conflict("A new media delivery requires a candidateToken from the latest lookup");
    if (!["pending", "generating"].includes(turn.assistantStatus)) {
      throw Errors.conflict("Media delivery does not belong to an active Chat attempt");
    }
    if (scope.session.status !== "active") throw Errors.gone("Chat session is archived");
    const snapshot = frozen(turn, scope.session, effect);
    await lockCharacterGenerationAuthority(tx, snapshot.characterId);
    await assertChatSessionServingAuthority(tx, snapshot.userId, scope.session);
    if (!checked.ok) throw checked.error;
    const lookup = currentLookup(turn, checked.value.candidate);

    let asset: Awaited<ReturnType<typeof tx.mediaAsset.findUniqueOrThrow>>;
    const source = checked.value.source;
    let description: string | null;
    if (checked.value.source === "library") {
      const { candidate, entry: beforeLock } = checked.value;
      if (!snapshot.characterVisualProfileId || !snapshot.characterVisualProfileVersion) {
        throw Errors.forbidden("Prepared media requires a frozen Character visual identity");
      }
      if (beforeLock.sourceAssetId) await lockMediaAssetAuthority(tx, beforeLock.sourceAssetId);
      await tx.$queryRaw`SELECT id FROM "character_media_library_entries" WHERE id = ${candidate.id} FOR UPDATE`;
      const entry = await tx.characterMediaLibraryEntry.findUnique({ where: { id: candidate.id } });
      if (!entry) throw Errors.notFound("Prepared media is no longer available");
      if (entry.sourceAssetId !== beforeLock.sourceAssetId || entry.storageKey !== beforeLock.storageKey
        || entry.contentHash !== beforeLock.contentHash || entry.kind !== beforeLock.kind) {
        throw Errors.conflict("Prepared media changed after the lookup; search again");
      }
      assertCandidate(candidate, snapshot, lookup, libraryIdentity(entry));
      await assertLibraryEntryAvailable(tx, entry, { characterId: snapshot.characterId,
        visualProfileId: snapshot.characterVisualProfileId, visualProfileVersion: snapshot.characterVisualProfileVersion });
      if (!matchesPolicy(entry, lookup.args)) throw Errors.conflict("Prepared media no longer matches the latest lookup requirements");
      if (lookup.args.unseenOnly !== false) {
        const delivered = await deliveredLibraryMedia(tx, { userId: snapshot.userId, characterId: snapshot.characterId, entries: [entry] });
        if (delivered.has(entry.id)) throw Errors.conflict("This prepared media has already been delivered; search for another result");
      }
      const sourceAssetId = entry.sourceAssetId ?? record(entry.sourceSnapshot).assetId;
      if (typeof sourceAssetId !== "string" || !sourceAssetId) throw Errors.conflict("Prepared media has no immutable source identity");
      const id = `chatmedia_${hash(attachmentId).slice(0, 40)}`;
      const url = mediaViewUrl({ id, type: entry.kind, contentType: entry.contentType, storageKey: null, url: "" });
      const posterKey = entry.kind === "video" ? entry.thumbnailKey : null;
      asset = await tx.mediaAsset.create({ data: {
        id, ownerId: snapshot.userId, characterId: snapshot.characterId, type: entry.kind,
        url, thumbnailUrl: posterKey ? mediaLibraryPosterViewUrl({ id }) : entry.kind === "image" ? url : null,
        storageKey: null, contentType: entry.contentType,
        width: entry.width, height: entry.height, sourceJobId: null, prompt: null,
        visibility: "private", safetyStatus: "passed", metadata: json({
          source: "character_media_library", synthetic: false, sha256: entry.contentHash,
          blobLocator: { schemaVersion: SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA, kind: "shared_immutable", key: entry.storageKey, sourceAssetId },
          duplicateLineage: { schemaVersion: 1, sourceAssetId, sourceCharacterId: snapshot.characterId },
          libraryDelivery: { schemaVersion: 1, entryId: entry.id, revision: entry.revision, contentHash: entry.contentHash,
            description: entry.description, facts: entry.facts, absentFacts: entry.absentFacts, nudity: entry.nudity,
            visualProfileId: entry.visualProfileId, visualProfileVersion: entry.visualProfileVersion,
            durationSeconds: entry.durationSeconds, hasAudio: entry.hasAudio, ...(posterKey ? { posterKey } : {}) },
        }),
      } });
      description = entry.description;
    } else {
      const { previous: beforeLock, locator: checkedLocator, recordedDigest: checkedDigest } = checked.value;
      const previousMediaAssetId = beforeLock.asset.id;
      if (!snapshot.recentMedia?.some(item => item.mediaAssetId === previousMediaAssetId)) {
        throw Errors.forbidden("The previous media is not a delivered result in this Chat context");
      }
      await lockMediaAssetAuthority(tx, previousMediaAssetId);
      const previous = (await deliveredChatMedia(tx, { userId: snapshot.userId, characterId: snapshot.characterId,
        sessionId: snapshot.sessionId, before: turn.createdAt, mediaAssetId: previousMediaAssetId }))[0];
      if (!previous) throw Errors.notFound("The previous media is no longer available in this Chat");
      const locator = resolveMediaAssetBlobLocator(previous.asset);
      if (!locator) throw Errors.notFound("The previous media has no readable immutable bytes");
      const digest = record(previous.asset.metadata).sha256;
      if (previous.asset.type !== beforeLock.asset.type || previous.asset.characterId !== beforeLock.asset.characterId
        || previous.attachment.id !== beforeLock.attachment.id
        || attachmentAttempt(previous.attachment.metadata) !== attachmentAttempt(beforeLock.attachment.metadata)
        || JSON.stringify(locator) !== JSON.stringify(checkedLocator)
        || (typeof digest === "string" ? digest : undefined) !== checkedDigest) {
        throw Errors.conflict("The previous media changed while its bytes were checked; retry the request");
      }
      assertCandidate(checked.value.candidate, snapshot, lookup, previousIdentity({ ...checked.value, previous, locator }));
      if (!matchesPolicy(previousFacts(previous), lookup.args) || lookup.args.unseenOnly === true) {
        throw Errors.conflict("The previous media does not match the latest lookup requirements");
      }
      asset = previous.asset;
      description = previous.description;
    }
    const created = await createToolEffectAttachment(tx, { id: attachmentId, turn, attempt: effect.attempt,
      kind: asset.type === "image" ? "generated_image" : "generated_video", promptHint: null,
      metadata: { source, description, costDreamcoins: 0,
        effect: { turnId: effect.turnId, attempt: effect.attempt, callId: effect.callId, name: effect.name,
          effectScope: effect.effectScope, intent: effect.intent, requestDigest },
        request: { name: effect.name, subject: asset.characterId ? "companion" : "scene",
          requestedNudity: lookup.args.requestedNudity ?? "unspecified" },
      },
    });
    const completed = await transitionToolEffectAttachment(tx, created, { to: "completed", generationJobId: null,
      mediaAssetId: asset.id, width: asset.width, height: asset.height });
    return characterMediaReceipt(completed, false);
  }, { timeout: 20_000 });
}

async function checkCandidateBlob(turn: Turn, effect: ChatToolEffect, candidate: Candidate) {
  const snapshot = frozen(turn, turn.session, effect);
  const lookup = currentLookup(turn, candidate);
  if (candidate.source === "previous_media") {
    const checked = await checkPreviousMediaBlob(turn, effect, candidate.id);
    assertCandidate(candidate, snapshot, lookup, previousIdentity(checked));
    if (!matchesPolicy(previousFacts(checked.previous), lookup.args) || lookup.args.unseenOnly === true) {
      throw Errors.conflict("The previous media does not match the latest lookup requirements");
    }
    return { ...checked, candidate };
  }
  const entry = await prisma.characterMediaLibraryEntry.findUnique({ where: { id: candidate.id } });
  if (!entry) throw Errors.notFound("Prepared media is no longer available");
  assertCandidate(candidate, snapshot, lookup, libraryIdentity(entry));
  if (entry.status !== "published") throw Errors.conflict("Prepared media is no longer published");
  if (!matchesPolicy(entry, lookup.args)) throw Errors.conflict("Prepared media no longer matches the latest lookup requirements");
  // Byte I/O stays outside the user/Character transaction; the locked write
  // rechecks the latest lookup and the exact immutable source afterwards.
  await assertBlobReadable(entry.storageKey, entry.contentHash, entry.kind);
  return { source: "library" as const, candidate, entry };
}

async function checkPreviousMediaBlob(turn: Turn, effect: ChatToolEffect, mediaAssetId: string) {
  const snapshot = frozen(turn, turn.session, effect);
  if (!snapshot.recentMedia?.some(item => item.mediaAssetId === mediaAssetId)) {
    throw Errors.forbidden("The previous media is not a delivered result in this Chat context");
  }
  const previous = (await deliveredChatMedia(prisma, { userId: snapshot.userId, characterId: snapshot.characterId,
    sessionId: snapshot.sessionId, before: turn.createdAt, mediaAssetId }))[0];
  if (!previous) throw Errors.notFound("The previous media is no longer available in this Chat");
  const locator = resolveMediaAssetBlobLocator(previous.asset);
  if (!locator) throw Errors.notFound("The previous media has no readable immutable bytes");
  const recordedDigest = record(previous.asset.metadata).sha256;
  const digest = typeof recordedDigest === "string" ? recordedDigest : undefined;
  // The final transaction rechecks this delivered owner/attempt grant and its
  // exact locator. Large-file I/O must not hold the user or Character locks.
  const verifiedDigest = await assertBlobReadable(locator.key, digest, previous.asset.type);
  return { source: "previous_media" as const, previous, locator, recordedDigest: digest, digest: verifiedDigest };
}

export function characterMediaReceipt(attachment: Pick<ChatTurnAttachment, "id" | "status" | "mediaAssetId" | "generationJobId" | "metadata">, duplicate: boolean): SendCharacterMediaResult {
  const metadata = record(attachment.metadata);
  if (attachment.status !== "completed" || !attachment.mediaAssetId || attachment.generationJobId !== null
    || metadata.costDreamcoins !== 0 || !["library", "previous_media"].includes(String(metadata.source))) {
    throw Errors.conflict("The existing media action has no completed delivery receipt");
  }
  return { accepted: true, duplicate, status: "completed", attachmentId: attachment.id,
    mediaAssetId: attachment.mediaAssetId, generationJobId: null, costDreamcoins: 0,
    source: metadata.source as "library" | "previous_media",
    description: typeof metadata.description === "string" ? metadata.description : null };
}

async function assertBlobReadable(key: string, digest: string | undefined, kind: string) {
  if (!providers.blob.getPrivate) throw Errors.unavailable("Prepared media storage cannot verify delivery");
  const result = await providers.blob.getPrivate({ key, signal: AbortSignal.timeout(10_000),
    maxBytes: (kind === "video" ? 256 : 64) * 1024 * 1024 });
  if (!result.ok && result.error.code !== "not_found" && result.error.code !== "too_large") {
    throw Errors.unavailable("The media bytes could not be verified");
  }
  if (!result.ok || result.data.body.byteLength === 0) throw Errors.gone("The media bytes are no longer available or have changed");
  const actualDigest = hash(result.data.body);
  if (digest && actualDigest !== digest) throw Errors.gone("The media bytes are no longer available or have changed");
  return actualDigest;
}

function libraryIdentity(entry: CharacterMediaLibraryEntry) {
  return { source: "library" as const, id: entry.id, revision: entry.revision,
    proof: { contentHash: entry.contentHash, characterId: entry.characterId,
      visualProfileId: entry.visualProfileId, visualProfileVersion: entry.visualProfileVersion,
      kind: entry.kind, description: entry.description, facts: entry.facts, absentFacts: entry.absentFacts,
      nudity: entry.nudity, durationSeconds: entry.durationSeconds, hasAudio: entry.hasAudio } };
}

function previousIdentity(checked: Awaited<ReturnType<typeof checkPreviousMediaBlob>>) {
  return { source: "previous_media" as const, id: checked.previous.asset.id, revision: 0,
    proof: { digest: checked.digest, locator: checked.locator, attachmentId: checked.previous.attachment.id,
      attachmentAttempt: attachmentAttempt(checked.previous.attachment.metadata), facts: previousFacts(checked.previous) } };
}
type CandidateIdentity = ReturnType<typeof libraryIdentity> | ReturnType<typeof previousIdentity>;

function currentLookup(turn: ChatTurn, candidate: Candidate) {
  const result = lookupSchema.safeParse(turn.mediaLookup);
  if (!result.success || result.data.status !== "ready" || result.data.attempt !== turn.attempt
    || result.data.lookupId !== candidate.lookupId) throw Errors.conflict("This media candidate was replaced by a newer lookup; search again");
  const lookup = result.data;
  if (candidate.source === "previous_media" ? lookup.args.previousMediaAssetId !== candidate.id : lookup.args.previousMediaAssetId !== undefined) {
    throw Errors.forbidden("This media candidate does not belong to the latest lookup");
  }
  return lookup;
}

function signCandidate(snapshot: ChatExecutionSnapshot, lookup: Lookup, identity: CandidateIdentity) {
  return ["3", lookup.lookupId, identity.source === "library" ? "l" : "p", identity.id, identity.revision,
    candidateSignature(snapshot, lookup, identity).toString("base64url")].join(".");
}

function readCandidate(token: string): Candidate {
  const invalid = () => Errors.badRequest("Media candidate is invalid; search again");
  if (token.length > 256) throw invalid();
  const parts = token.split(".");
  const [version, lookupId, source, id, revision, signature] = parts;
  if (parts.length !== 6 || version !== "3") throw invalid();
  const parsed = candidateSchema.safeParse({ lookupId, source: source === "l" ? "library" : source === "p" ? "previous_media" : undefined,
    id, revision: Number(revision), signature });
  if (!parsed.success || String(parsed.data.revision) !== revision) throw invalid();
  return parsed.data;
}

function candidateSignature(snapshot: ChatExecutionSnapshot, lookup: Lookup, identity: CandidateIdentity) {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(JSON.stringify({
    domain: "chat-media-candidate-v3", userId: snapshot.userId, sessionId: snapshot.sessionId,
    turnId: snapshot.turnId, attempt: snapshot.attempt, userContentHash: hash(snapshot.userContent),
    characterId: snapshot.characterId, contentVersionId: snapshot.characterContentVersionId,
    releaseId: snapshot.characterReleaseId, visualProfileId: snapshot.characterVisualProfileId,
    visualProfileVersion: snapshot.characterVisualProfileVersion,
    lookupId: lookup.lookupId, args: lookup.args, identity,
  })).digest();
}

function assertCandidate(candidate: Candidate, snapshot: ChatExecutionSnapshot, lookup: Lookup, identity: CandidateIdentity) {
  if (identity.id !== candidate.id || identity.revision !== candidate.revision || identity.source !== candidate.source) {
    throw Errors.conflict("Prepared media changed after the lookup; search again");
  }
  const expected = candidateSignature(snapshot, lookup, identity);
  const supplied = Buffer.from(candidate.signature, "base64url");
  if (supplied.toString("base64url") !== candidate.signature || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw Errors.forbidden("This media candidate does not belong to the current Chat attempt or content");
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function hash(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
