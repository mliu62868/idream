import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { CHAT_MEDIA_LOOKUP_BUDGET_MS, characterMediaCandidateSchema, searchCharacterMediaArgsSchema, searchCharacterMediaResultSchema, sendCharacterMediaArgsSchema, type SearchCharacterMediaArgs, type SearchCharacterMediaResult, type SendCharacterMediaResult } from "@idream/shared/chat/media-library";
import { canonicalJson, chatExecutionSnapshotSchema, type ChatExecutionSnapshot, type ChatToolEffect } from "@idream/shared/contracts";
import type { Prisma, CharacterMediaLibraryEntry, ChatTurn, ChatTurnAttachment, RecentChat } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { AppError, Errors } from "@/server/lib/errors";
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
const legacyLookupSchema = z.object({
  version: z.literal(1), attempt: z.number().int().positive(), lookupId: z.string().uuid(),
  status: z.enum(["pending", "ready", "failed"]), args: searchCharacterMediaArgsSchema,
}).strict();
const lookupFailureSchema = z.object({
  code: z.enum(["bad_request", "unauthorized", "forbidden", "payment_required", "not_found", "gone", "conflict", "rate_limited", "unavailable", "internal"]),
  message: z.string().max(400),
}).strict();
const candidateReferenceSchema = candidateSchema.pick({ source: true, id: true, revision: true }).extend({
  evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
const [matchesResult, noMatchResult, videoReviewResult] = searchCharacterMediaResultSchema.options;
const lookupObservationSchema = z.discriminatedUnion("status", [
  matchesResult.extend({ matches: z.array(characterMediaCandidateSchema.omit({ candidateToken: true })
    .extend({ reference: candidateReferenceSchema })).min(1).max(10) }),
  noMatchResult,
  videoReviewResult,
]);
const orderedLookupSchema = legacyLookupSchema.extend({
  version: z.literal(2), order: z.number().int().positive(), callId: z.string().min(1),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/), deadlineMs: z.number().int().nonnegative(),
  status: z.enum(["pending", "resolved", "ready", "failed"]),
  args: searchCharacterMediaArgsSchema.nullable(), result: z.union([lookupObservationSchema, searchCharacterMediaResultSchema]).optional(),
  failure: lookupFailureSchema.optional(),
});
const lookupSchema = z.discriminatedUnion("version", [legacyLookupSchema, orderedLookupSchema]);
type Candidate = z.infer<typeof candidateSchema>;
type CandidateReference = z.infer<typeof candidateReferenceSchema>;
type LookupObservation = z.infer<typeof lookupObservationSchema>;
type OrderedLookup = z.infer<typeof orderedLookupSchema>;
type Lookup = { lookupId: string; args: SearchCharacterMediaArgs; resolved: boolean };
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

export async function searchChatCharacterMedia(effect: ChatToolEffect, requestSignal?: AbortSignal): Promise<SearchCharacterMediaResult> {
  const { lookupOrder, lookupDeadlineAt } = effect;
  if (lookupOrder === undefined || lookupDeadlineAt === undefined) throw Errors.badRequest("Media lookup requires an order and deadline");
  const deadlineMs = Math.max(0, Math.min(Date.parse(lookupDeadlineAt), Date.now() + CHAT_MEDIA_LOOKUP_BUDGET_MS));
  const parsed = searchCharacterMediaArgsSchema.safeParse(effect.arguments);
  const intentMatches = parsed.success && (parsed.data.requestedNudity === undefined || parsed.data.requestedNudity === effect.intent.requestedNudity);
  const args = parsed.success && intentMatches
    ? searchCharacterMediaArgsSchema.parse({ ...parsed.data, requestedNudity: effect.intent.requestedNudity }) : null;
  const requestDigest = hash(canonicalJson({ arguments: effect.arguments, intent: effect.intent, deadlineAt: lookupDeadlineAt }));
  const claim = await withinLookupBudget(deadlineMs, () => lookupTransaction(deadlineMs, async tx => {
    const owner = await tx.chatTurn.findUnique({ where: { id: effect.turnId },
      select: { session: { select: { userId: true } } } });
    if (!owner) throw Errors.notFound("Chat turn not found");
    const scope = await lockChatScope(tx, { userId: owner.session.userId, at: { turn: effect.turnId },
      expect: { attempt: effect.attempt, assistantStatus: ["pending", "generating"] } });
    if (scope.session.status !== "active") throw Errors.gone("Chat session is archived");
    const current = scope.turn!;
    const turn = { ...current, session: scope.session };
    const snapshot = frozen(current, scope.session, effect);
    await assertChatSessionServingAuthority(tx, scope.userId, scope.session);
    const saved = lookupSchema.safeParse(current.mediaLookup);
    if (!saved.success && record(current.mediaLookup).version === 2) throw Errors.conflict("The current media lookup is invalid");
    if (saved.success && saved.data.version === 2 && saved.data.attempt === effect.attempt) {
      const previous = saved.data;
      if (lookupOrder < previous.order) throw supersededLookup();
      if (lookupOrder === previous.order) {
        if (previous.callId !== effect.callId || previous.requestDigest !== requestDigest) {
          throw Errors.conflict("This media lookup order belongs to a different request");
        }
        return { lookup: previous, snapshot, turn, replay: true };
      }
      if (previous.callId === effect.callId) throw Errors.conflict("A media lookup call cannot change its order");
    }
    if (current.imageActionMode !== "library") {
      const imageAction = await tx.chatTurnAttachment.findFirst({
        where: { turnId: current.id, kind: "generated_image", metadata: { path: ["attempt"], equals: effect.attempt } },
        select: { id: true },
      });
      if (imageAction) throw Errors.conflict("This message already has an image action");
    }
    // Replacing the lookup before any model or blob I/O immediately revokes all
    // earlier candidates, even if this lookup misses, fails or finishes late.
    const lookup: OrderedLookup = {
      version: 2, attempt: effect.attempt, lookupId: randomUUID(), order: lookupOrder, callId: effect.callId, requestDigest,
      deadlineMs: Math.min(deadlineMs, current.executionDeadlineAt?.getTime() ?? deadlineMs),
      status: args ? "pending" : "failed", args,
    };
    remainingLookupMs(lookup.deadlineMs);
    await tx.chatTurn.update({ where: { id: current.id }, data: { imageActionMode: "library", mediaLookup: json(lookup) } });
    remainingLookupMs(lookup.deadlineMs);
    return { lookup, snapshot, turn, replay: false };
  }));
  if (!parsed.success) throw parsed.error;
  if (!args) throw Errors.badRequest("Media lookup and wardrobe intent differ");
  const { snapshot, lookup, turn } = claim;
  // Main owns the lookup once claimed. Losing the first HTTP connection must
  // not cancel a computation that the exact retry may still observe.
  return withinLookupBudget(lookup.deadlineMs, async signal => {
    if (claim.replay) return replayLookup(snapshot, lookup, signal);
    let result: LookupObservation;
    try {
      result = args.previousMediaAssetId
        ? await searchPreviousMedia(turn, effect, args, signal)
        : await searchLibraryMedia(snapshot, args, signal);
    } catch (error) {
      // An expired pending claim already replays as a timeout. Do not prolong
      // the request to write a redundant failure or start more database work.
      remainingLookupMs(lookup.deadlineMs);
      await settleLookup(snapshot, lookup, {
        failure: error instanceof AppError
          ? { code: error.code, message: error.message.slice(0, 400) }
          : { code: "unavailable", message: "Prepared media search did not complete" },
      });
      throw error;
    }
    remainingLookupMs(lookup.deadlineMs);
    if (!await settleLookup(snapshot, lookup, { result })) throw supersededLookup();
    return issueLookupResult(snapshot, lookup, result);
  }, claim.replay ? requestSignal : undefined);
}

function lookupTimedOut() { return Errors.unavailable("Prepared media lookup exceeded its time budget"); }
function supersededLookup() { return Errors.conflict("A newer media lookup replaced this result; search again"); }

function remainingLookupMs(deadlineMs: number) {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw lookupTimedOut();
  return remaining;
}

function lookupTransaction<T>(deadlineMs: number, run: (tx: Prisma.TransactionClient) => Promise<T>) {
  const timeout = remainingLookupMs(deadlineMs);
  return prisma.$transaction(async tx => {
    const remaining = remainingLookupMs(deadlineMs);
    await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(remaining)}, true)`;
    remainingLookupMs(deadlineMs);
    const result = await run(tx);
    remainingLookupMs(deadlineMs);
    return result;
  }, { maxWait: timeout, timeout });
}

async function withinLookupBudget<T>(deadlineMs: number, run: (signal: AbortSignal) => Promise<T>,
  requestSignal?: AbortSignal): Promise<T> {
  const deadline = AbortSignal.timeout(remainingLookupMs(deadlineMs));
  const signal = requestSignal ? AbortSignal.any([deadline, requestSignal]) : deadline;
  signal.throwIfAborted();
  let onAbort: () => void;
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(deadline.aborted ? lookupTimedOut() : signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([run(signal), expired]);
    remainingLookupMs(deadlineMs);
    return result;
  } catch (error) {
    remainingLookupMs(deadlineMs);
    throw error;
  }
  finally { signal.removeEventListener("abort", onAbort!); }
}

async function replayLookup(snapshot: ChatExecutionSnapshot, initial: OrderedLookup, signal: AbortSignal) {
  let lookup = initial;
  let pollMs = 50;
  while (lookup.status === "pending") {
    await delay(Math.min(pollMs, remainingLookupMs(lookup.deadlineMs)), undefined, { signal });
    pollMs = Math.min(pollMs * 2, 300);
    remainingLookupMs(lookup.deadlineMs);
    const turn = await prisma.chatTurn.findUnique({ where: { id: snapshot.turnId },
      select: { attempt: true, mediaLookup: true, assistantStatus: true } });
    remainingLookupMs(lookup.deadlineMs);
    signal.throwIfAborted();
    const saved = orderedLookupSchema.safeParse(turn?.mediaLookup);
    if (!turn || turn.attempt !== snapshot.attempt || !["pending", "generating"].includes(turn.assistantStatus)
      || !saved.success || saved.data.lookupId !== initial.lookupId) throw supersededLookup();
    lookup = saved.data;
  }
  remainingLookupMs(lookup.deadlineMs);
  if (lookup.status === "resolved" && lookup.result) {
    return issueLookupResult(snapshot, lookup, lookupObservationSchema.parse(lookup.result));
  }
  if (lookup.status === "ready" && lookup.result) return searchCharacterMediaResultSchema.parse(lookup.result);
  if (lookup.failure) throw new AppError(lookup.failure.code, lookup.failure.message);
  throw Errors.unavailable("Prepared media search did not complete");
}

async function settleLookup(snapshot: ChatExecutionSnapshot, lookup: OrderedLookup,
  outcome: { result: LookupObservation } | { failure: z.infer<typeof lookupFailureSchema> }) {
  return lookupTransaction(lookup.deadlineMs, async tx => {
    const scope = await lockChatScope(tx, { userId: snapshot.userId, at: { turn: snapshot.turnId }, allowDeletedSession: true });
    const current = scope.turn!;
    const saved = orderedLookupSchema.safeParse(current.mediaLookup);
    if (current.attempt !== snapshot.attempt || !saved.success || saved.data.lookupId !== lookup.lookupId
      || saved.data.status !== "pending" || scope.session.status !== "active"
      || !["pending", "generating"].includes(current.assistantStatus)) return false;
    remainingLookupMs(lookup.deadlineMs);
    const receipt = "failure" in outcome ? { status: "failed" as const, failure: outcome.failure }
      : { status: "resolved" as const, result: outcome.result };
    await tx.chatTurn.update({ where: { id: current.id }, data: { mediaLookup: json({ ...lookup, ...receipt }) } });
    return true;
  });
}

async function searchLibraryMedia(snapshot: ChatExecutionSnapshot, args: SearchCharacterMediaArgs, signal: AbortSignal): Promise<LookupObservation> {
  if (!snapshot.characterVisualProfileId || !snapshot.characterVisualProfileVersion) return { accepted: true, status: "no_match", matches: [] };
  const { minDurationSeconds, maxDurationSeconds, hasAudio, previousMediaAssetId: _previous, ...discovery } = args;
  const search = { ...discovery, userId: snapshot.userId, characterId: snapshot.characterId,
    visualProfileId: snapshot.characterVisualProfileId, visualProfileVersion: snapshot.characterVisualProfileVersion };
  const matches = await searchCharacterMediaLibrary({ ...search, minDurationSeconds, maxDurationSeconds, hasAudio }, signal);
  signal.throwIfAborted();
  if (matches.length) return lookupObservationSchema.parse({
    accepted: true, status: "matches", matches: matches.map(candidate => ({ ...candidateFacts(candidate),
      reference: candidateReference(libraryIdentity(candidate.entry)) })),
  });
  if (minDurationSeconds !== undefined || maxDurationSeconds !== undefined || hasAudio !== undefined) {
    const observed = await searchCharacterMediaLibrary(search, signal);
    signal.throwIfAborted();
    if (observed.length) return lookupObservationSchema.parse({
      accepted: true, status: "review_video_filters", matches: [], observedVideos: observed.map(candidateFacts),
    });
  }
  return { accepted: true, status: "no_match", matches: [] };
}

async function searchPreviousMedia(turn: Turn, effect: ChatToolEffect, args: SearchCharacterMediaArgs, signal: AbortSignal): Promise<LookupObservation> {
  const checked = await checkPreviousMediaBlob(turn, effect, args.previousMediaAssetId!, signal);
  signal.throwIfAborted();
  const facts = previousFacts(checked.previous);
  if (!matchesPolicy(facts, args, false) || args.unseenOnly === true) return { accepted: true, status: "no_match", matches: [] };
  if (!matchesPolicy(facts, args)) return lookupObservationSchema.parse({
    accepted: true, status: "review_video_filters", matches: [], observedVideos: [facts],
  });
  return lookupObservationSchema.parse({ accepted: true, status: "matches", matches: [{ ...facts,
    reference: candidateReference(previousIdentity(checked)) }] });
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
    const lookup = currentLookup(turn, checked.value.candidate, effect.lookupOrder);

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
  const lookup = currentLookup(turn, candidate, effect.lookupOrder);
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

async function checkPreviousMediaBlob(turn: Turn, effect: ChatToolEffect, mediaAssetId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
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
  signal?.throwIfAborted();
  const verifiedDigest = await assertBlobReadable(locator.key, digest, previous.asset.type, signal);
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

async function assertBlobReadable(key: string, digest: string | undefined, kind: string, signal?: AbortSignal) {
  if (!providers.blob.getPrivate) throw Errors.unavailable("Prepared media storage cannot verify delivery");
  const timeout = AbortSignal.timeout(10_000);
  const result = await providers.blob.getPrivate({ key, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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

function candidateReference(identity: CandidateIdentity): CandidateReference {
  return { source: identity.source, id: identity.id, revision: identity.revision,
    evidenceDigest: hash(canonicalJson(identity)) };
}

// The durable result contains observations, not bearer credentials. A late
// commit or lost commit acknowledgement cannot grant a candidate after cutoff.
function issueLookupResult(snapshot: ChatExecutionSnapshot, lookup: OrderedLookup, observation: LookupObservation): SearchCharacterMediaResult {
  remainingLookupMs(lookup.deadlineMs);
  if (observation.status !== "matches") return observation;
  if (!lookup.args) throw Errors.conflict("Prepared media lookup has no issuing context");
  const signingContext = { lookupId: lookup.lookupId, args: lookup.args, resolved: true };
  return { ...observation, matches: observation.matches.map(({ reference, ...facts }) => ({
    ...facts, candidateToken: signCandidate(snapshot, signingContext, reference),
  })) };
}

function currentLookup(turn: ChatTurn, candidate: Candidate, order: number | undefined): Lookup {
  const result = lookupSchema.safeParse(turn.mediaLookup);
  if (!result.success || !["ready", "resolved"].includes(result.data.status) || result.data.attempt !== turn.attempt
    || result.data.lookupId !== candidate.lookupId || !result.data.args
    || (result.data.version === 2 ? result.data.order !== order : order !== undefined)) {
    throw Errors.conflict("This media candidate was replaced by a newer lookup; search again");
  }
  const { args, lookupId } = result.data;
  if (candidate.source === "previous_media" ? args.previousMediaAssetId !== candidate.id : args.previousMediaAssetId !== undefined) {
    throw Errors.forbidden("This media candidate does not belong to the latest lookup");
  }
  return { lookupId, args, resolved: result.data.status === "resolved" };
}

function signCandidate(snapshot: ChatExecutionSnapshot, lookup: Lookup, identity: CandidateReference) {
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

function candidateSignature(snapshot: ChatExecutionSnapshot, lookup: Lookup, identity: CandidateIdentity | CandidateReference) {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(JSON.stringify({
    domain: lookup.resolved ? "chat-media-candidate-issued-v3" : "chat-media-candidate-v3",
    userId: snapshot.userId, sessionId: snapshot.sessionId,
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
  const expected = candidateSignature(snapshot, lookup, lookup.resolved ? candidateReference(identity) : identity);
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
