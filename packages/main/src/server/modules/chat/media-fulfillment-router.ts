import { z } from "zod";
import {
  CHAT_MEDIA_FULFILLMENT_ROUTE_BUDGET_MS,
  REQUEST_CHARACTER_MEDIA_TOOL,
  RESEND_SESSION_MEDIA_TOOL,
  requestCharacterMediaArgsSchema,
  resendSessionMediaArgsSchema,
  type RequestCharacterMediaArgs,
  type RequestCharacterMediaResult,
  type ResendSessionMediaResult,
} from "@idream/shared/chat/media-library";
import { chatExecutionSnapshotSchema, type ChatExecutionSnapshot, type ChatToolEffect } from "@idream/shared/contracts";
import type { CharacterMediaLibraryEntry, ChatTurn, ChatTurnAttachment, RecentChat } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { AppError, Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { getAuthCtx, requireAgeGate, requireAgeVerified, requireUser } from "@/server/lib/auth";
import { ok } from "@/server/lib/http";
import { generationCostFromAuthority, resolveGenerationPricingAuthority } from "@/server/lib/generation-pricing";
import { resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import { lockMediaAssetAuthorityShared } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import {
  normalizeLibraryFact,
  searchCharacterMediaLibrary,
  type LibrarySearchCandidate,
} from "@/server/modules/character-media-library/service";
import { createChatImageGenerationJob } from "@/server/modules/ourdream/service";
import { compileChatImagePrompt, sanitizeChatImageDirection } from "@/server/modules/ourdream/generation-prompt";
import { loadChatAuthoritySnapshot } from "./chat-authority-snapshot";
import { deliveredChatMedia } from "./chat-media-history";
import { CuratedMediaUnavailable, schedulePaidCuratedMediaDelivery, type MediaFulfillmentReceipt } from "./delayed-media-reveal";
import { assertToolEffectRequest, createToolEffectAttachment, failedToolEffectReceipt, transitionToolEffectAttachment } from "./tool-effect-attachment";
import { assertChatSessionServingAuthority } from "./turn-ledger";
import { attachmentAttempt, lockChatScope } from "./turn-scope";
import { ACTIVE_ASSISTANT_STATES } from "./turn-ledger-support";

type Turn = ChatTurn & { session: RecentChat };
const imageOrientation = { portrait: "4:5", square: "1:1", landscape: "16:9" } as const;

export const PAID_MEDIA_MIN_RERANK_SCORE = 0.45;
export const PAID_MEDIA_MIN_DENSE_SCORE = 0.55;

const paidMediaQuoteMetadataSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["image", "video"]),
  costDreamcoins: z.number().int().positive(),
  direction: z.string().min(1).max(1_200),
  subject: z.enum(["companion", "scene"]),
  requestedNudity: z.enum(["unspecified", "none", "partial", "full"]),
  mode: z.enum(["auto", "force_new", "existing_only"]),
  orientation: z.enum(["portrait", "landscape", "square"]).optional(),
  matchedEntryId: z.string().min(1).nullable(),
  matchedEntryRevision: z.number().int().positive().optional(),
  visualProfileId: z.string().min(1).nullable(),
  visualProfileVersion: z.number().int().positive().nullable(),
}).strict();

type PaidMediaQuoteMetadata = z.infer<typeof paidMediaQuoteMetadataSchema>;
type MediaPlan = Omit<PaidMediaQuoteMetadata, "version" | "costDreamcoins">;
type AuthorizedMedia = {
  readonly turn: Turn;
  readonly attempt: number;
  readonly attachmentId: string;
  readonly plan: MediaPlan;
  readonly effectMetadata: Record<string, unknown>;
  readonly requestMetadata: Record<string, unknown>;
  readonly confirmedQuoteCost?: number;
};

export type RouteCuratedMediaDecision =
  | { readonly route: "delayed_library"; readonly entry: CharacterMediaLibraryEntry; readonly score: number }
  | { readonly route: "live_gen"; readonly reason: string }
  | { readonly route: "no_delivery"; readonly reason: string };

/**
 * Deterministic Gate A verification for paid curated media delivery.
 * In paid mode, false sends cost real customer trust and refunds:
 * - Explicit wardrobe level must match exactly.
 * - Explicit video technical bounds (duration, audio) must match exactly.
 * - Every explicit exclusion (`mustExclude`) must be confirmed in `absentFacts`
 *   (closed-world strict: absence from description never proves exclusion).
 * - Explicit `mustHave` terms must appear in observed description or facts.
 */
export function passesPaidCuratedGateA(
  entry: Pick<CharacterMediaLibraryEntry, "kind" | "description" | "facts" | "absentFacts" | "nudity" | "durationSeconds" | "hasAudio" | "distributionScope" | "width" | "height">,
  args: Pick<RequestCharacterMediaArgs, "kind" | "requestedNudity" | "mustHave" | "mustExclude" | "minDurationSeconds" | "maxDurationSeconds" | "hasAudio" | "orientation">,
): boolean {
  if (entry.kind !== args.kind) return false;
  if (entry.distributionScope !== "chat_library") return false;
  if (args.orientation) {
    if (!entry.width || !entry.height) return false;
    const orientation = entry.width === entry.height ? "square" : entry.width > entry.height ? "landscape" : "portrait";
    if (orientation !== args.orientation) return false;
  }
  if (args.requestedNudity !== "unspecified" && entry.nudity !== args.requestedNudity) {
    return false;
  }
  if (args.kind === "video") {
    if (args.minDurationSeconds !== undefined && (entry.durationSeconds === null || entry.durationSeconds < args.minDurationSeconds)) {
      return false;
    }
    if (args.maxDurationSeconds !== undefined && (entry.durationSeconds === null || entry.durationSeconds > args.maxDurationSeconds)) {
      return false;
    }
    if (args.hasAudio !== undefined && entry.hasAudio !== args.hasAudio) {
      return false;
    }
  }
  if (args.mustExclude.length > 0) {
    const absentSet = new Set(entry.absentFacts.map(normalizeLibraryFact));
    for (const excluded of args.mustExclude) {
      if (!absentSet.has(normalizeLibraryFact(excluded))) return false;
    }
  }
  if (args.mustHave.length > 0) {
    const haystack = normalizeLibraryFact([entry.description, ...entry.facts].join(" "));
    for (const required of args.mustHave) {
      const needle = normalizeLibraryFact(required);
      if (needle && !haystack.includes(needle)) return false;
    }
  }
  return true;
}

/**
 * Step 1: Lockless read-only fulfillment routing (0 DB locks, 0 coin debit).
 * Bounded by a hard 1.5s budget so retrieval/model jitter never blocks paid
 * image generation fallback.
 */
export async function routeCuratedMediaReadOnly(input: {
  readonly userId: string;
  readonly characterId: string;
  readonly characterSource: string;
  readonly visualProfileId: string | null;
  readonly visualProfileVersion: number | null;
  readonly args: RequestCharacterMediaArgs;
  readonly signal?: AbortSignal;
  readonly minRerankScore?: number;
  readonly minDenseScore?: number;
  readonly searchImpl?: typeof searchCharacterMediaLibrary;
}): Promise<RouteCuratedMediaDecision> {
  const { args } = input;
  const fallback = (reason: string): RouteCuratedMediaDecision =>
    args.kind === "video" || args.mode === "existing_only" || args.mode === "availability"
      ? { route: "no_delivery", reason }
      : { route: "live_gen", reason };

  input.signal?.throwIfAborted();
  if (args.mode === "force_new") return fallback("force_new_requested");
  if (args.subject === "scene") return fallback("scene_subject");
  if (input.characterSource !== "official") return fallback("non_official_character");
  if (!input.visualProfileId || !input.visualProfileVersion) return fallback("missing_visual_identity");

  const budget = AbortSignal.timeout(CHAT_MEDIA_FULFILLMENT_ROUTE_BUDGET_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, budget]) : budget;
  const searchFn = input.searchImpl ?? searchCharacterMediaLibrary;
  const deadline = Promise.withResolvers<never>();
  const abort = () => deadline.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });

  let candidates: LibrarySearchCandidate[];
  try {
    const query = [
      args.direction,
      ...(args.mustHave.length > 0 ? [`Must include: ${args.mustHave.join(", ")}`] : []),
    ].join(". ");
    candidates = await Promise.race([searchFn(
      {
        userId: input.userId,
        characterId: input.characterId,
        visualProfileId: input.visualProfileId,
        visualProfileVersion: input.visualProfileVersion,
        kind: args.kind,
        query,
        requestedNudity: args.requestedNudity,
        excludedFacts: args.mustExclude.length > 0 ? args.mustExclude : undefined,
        distributionScope: "chat_library",
        minRerankScore: input.minRerankScore ?? PAID_MEDIA_MIN_RERANK_SCORE,
        unseenOnly: true,
        minDurationSeconds: args.minDurationSeconds,
        maxDurationSeconds: args.maxDurationSeconds,
        hasAudio: args.hasAudio,
      },
      signal,
    ), deadline.promise]);
  } catch (error) {
    input.signal?.throwIfAborted();
    logger.warn(
      { err: error, characterId: input.characterId, kind: args.kind },
      "Curated media read-only route failed or timed out; falling back safely",
    );
    return fallback("lookup_unavailable_or_timeout");
  } finally {
    signal.removeEventListener("abort", abort);
  }

  for (const candidate of candidates) {
    if (candidate.alreadySent) continue;
    const minScore = candidate.scoreSource === "rerank"
      ? input.minRerankScore ?? PAID_MEDIA_MIN_RERANK_SCORE
      : input.minDenseScore ?? PAID_MEDIA_MIN_DENSE_SCORE;
    if (candidate.score < minScore) {
      continue;
    }
    if (passesPaidCuratedGateA(candidate.entry, args)) {
      return { route: "delayed_library", entry: candidate.entry, score: candidate.score };
    }
  }
  return fallback("no_verified_match");
}

function frozenSnapshot(turn: ChatTurn, session: RecentChat, effect: ChatToolEffect): ChatExecutionSnapshot {
  const parsed = chatExecutionSnapshotSchema.safeParse(turn.executionSnapshot);
  if (
    !parsed.success
    || parsed.data.turnId !== turn.id
    || parsed.data.attempt !== effect.attempt
    || turn.attempt !== effect.attempt
    || parsed.data.userContent !== turn.userContent
    || parsed.data.userId !== session.userId
    || parsed.data.sessionId !== session.sessionId
    || parsed.data.characterId !== session.characterId
  ) {
    throw Errors.forbidden("Media tools require the current frozen Chat attempt");
  }
  return parsed.data;
}

/**
 * Step 2: Unified Main-side paid media fulfillment entry (`request_character_media`).
 * - Lockless Step 1 routing runs BEFORE any coin debit or lock.
 * - For videos: Step 1 runs even before emitting a quote card so we never show
 *   a 30-coin confirmation card when no official video matches.
 * - For images: authorized (`paid`) hits schedule 3-6s delayed library delivery
 *   (5 coins); misses seamlessly delegate to existing `createChatImageGenerationJob`
 *   (same 5 coins, native GenerationJob ledger). Unauthorized (`chat`) emits a
 *   5-coin `paid_media_quote` confirmation card.
 */
export async function fulfillCharacterMediaRequest(input: {
  readonly effect: ChatToolEffect;
  readonly judged: Turn;
  readonly attachmentId: string;
  readonly requestDigest: string;
  readonly signal?: AbortSignal;
}): Promise<RequestCharacterMediaResult | NonNullable<ReturnType<typeof failedToolEffectReceipt>>> {
  const { effect, judged, attachmentId, requestDigest } = input;
  const parsedArgs = requestCharacterMediaArgsSchema.safeParse(effect.arguments);
  if (!parsedArgs.success) throw Errors.badRequest("Invalid character media request arguments");
  const args = parsedArgs.data;
  if (args.requestedNudity !== effect.intent.requestedNudity) {
    throw Errors.badRequest("Media arguments and effect wardrobe intent differ");
  }

  const snapshot = frozenSnapshot(judged, judged.session, effect);
  if (judged.imageActionMode === "library") throw Errors.conflict("This message cannot start a new paid media action");
  const prior = await prisma.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
  if (prior) {
    assertToolEffectRequest(prior, effect.name, requestDigest);
    if (attachmentAttempt(prior.metadata) !== effect.attempt) throw Errors.conflict("This media action belongs to another Chat attempt");
    if (prior.status !== "requesting") {
      const current = await readMediaAttachment(judged.session.userId, attachmentId, effect.attempt, { name: effect.name, requestDigest });
      if (current.status !== "requesting") return requestMediaReceipt(current, true);
    }
  }

  if (!judged.characterContentVersionId) {
    throw Errors.gone("Chat Turn has no immutable Character content pin");
  }
  const character = await prisma.character.findFirst({
    where: { id: snapshot.characterId, deletedAt: null },
    select: { id: true, source: true, age: true, status: true },
  });
  if (!character || character.age < 18 || ["removed", "archived", "rejected"].includes(character.status)) {
    throw Errors.conflict("Character is not available for media requests");
  }

  const authority = await loadChatAuthoritySnapshot(snapshot.userId, {
    characterId: snapshot.characterId,
    contentVersionId: judged.characterContentVersionId,
    releaseId: judged.characterReleaseId,
    visualProfileId: judged.characterVisualProfileId,
    visualProfileVersion: judged.characterVisualProfileVersion,
  });

  // Step 1: Lockless read-only route decision (0 DB locks, 0 coin debit).
  const decision = prior ? { route: "live_gen" as const, reason: "resume_live_image" } : await routeCuratedMediaReadOnly({
    userId: snapshot.userId,
    characterId: snapshot.characterId,
    characterSource: character.source,
    visualProfileId: snapshot.characterVisualProfileId,
    visualProfileVersion: snapshot.characterVisualProfileVersion,
    args,
    signal: input.signal,
  });

  if (decision.route === "no_delivery" || args.mode === "availability") {
    const status = decision.route === "delayed_library" ? "available"
      : decision.reason === "lookup_unavailable_or_timeout" ? "unavailable" : "no_match";
    return {
      accepted: true, duplicate: false, status, kind: args.kind, costDreamcoins: 0,
      ...(status === "no_match" && args.kind === "video" && ["auto", "force_new"].includes(args.mode)
        ? { suggestedAction: authority.entitlement.modelTier === "deluxe" ? "custom_video_quote" : "photo_instead" }
        : {}),
    };
  }

  const canGenerateImage = authority.entitlement.imageToolEnabled && authority.character?.imageToolEnabled === true;
  if (decision.route === "live_gen" && !canGenerateImage) throw Errors.forbidden("Image generation is unavailable for this Chat");
  const direction = sanitizeChatImageDirection([
    args.direction,
    ...(args.mustHave.length ? [`Must include: ${args.mustHave.join(", ")}.`] : []),
    ...(args.mustExclude.length ? [`Exclude: ${args.mustExclude.join(", ")}.`] : []),
  ].join(" "));
  if (direction.length > 1_200) throw Errors.badRequest("Shorten the media direction while keeping its required details.");
  const plan: MediaPlan = {
    kind: args.kind,
    direction,
    subject: args.subject,
    requestedNudity: args.requestedNudity,
    mode: args.mode,
    ...(args.orientation ? { orientation: args.orientation } : {}),
    matchedEntryId: decision.route === "delayed_library" ? decision.entry.id : null,
    ...(decision.route === "delayed_library" ? { matchedEntryRevision: decision.entry.revision } : {}),
    visualProfileId: snapshot.characterVisualProfileId,
    visualProfileVersion: snapshot.characterVisualProfileVersion,
  };
  const effectMetadata = {
    turnId: effect.turnId,
    attempt: effect.attempt,
    callId: effect.callId,
    name: REQUEST_CHARACTER_MEDIA_TOOL,
    effectScope: effect.effectScope,
    intent: effect.intent,
    requestDigest,
  };
  const requestMetadata = {
    name: REQUEST_CHARACTER_MEDIA_TOOL,
    kind: args.kind,
    direction,
    subject: args.subject,
    requestedNudity: args.requestedNudity,
    mode: args.mode,
    ...(args.orientation ? { orientation: args.orientation } : {}),
  };

  // Unauthorized direct spend (`chat` mode) -> emit transparent paid quote confirmation card (0 debit).
  if (args.kind === "video" || judged.imageActionMode !== "paid") {
    if (decision.route === "live_gen") validateLiveImageDirection(plan, judged);
    const pricingMode = args.kind === "video" ? "chat_curated_video" : "image";
    const pricing = await resolveGenerationPricingAuthority(pricingMode);
    const costDreamcoins = generationCostFromAuthority(pricing, 1, 1);
    const quotePayload: PaidMediaQuoteMetadata = { ...plan, version: 1, costDreamcoins };
    return prisma.$transaction(async (tx) => {
      const scope = await lockChatScope(tx, {
        userId: snapshot.userId,
        at: { turn: effect.turnId },
        expect: { attempt: effect.attempt },
      });
      const raced = await tx.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
      if (raced) {
        assertToolEffectRequest(raced, effect.name, requestDigest);
        return requestMediaReceipt(raced, true);
      }
      if (!ACTIVE_ASSISTANT_STATES.includes(scope.turn!.assistantStatus)) {
        throw Errors.conflict("Media quote does not belong to an active Chat attempt");
      }
      if (scope.session.status !== "active") throw Errors.gone("Chat session is archived");
      await assertChatSessionServingAuthority(tx, snapshot.userId, scope.session);

      const created = await createToolEffectAttachment(tx, {
        id: attachmentId,
        turn: scope.turn!,
        kind: args.kind === "video" ? "generated_video" : "generated_image",
        attempt: effect.attempt,
        promptHint: direction,
        metadata: {
          confirmationKind: "paid_media_quote",
          costDreamcoins,
          paidMediaQuote: quotePayload,
          effect: effectMetadata,
          request: requestMetadata,
        },
      });
      const awaiting = await transitionToolEffectAttachment(tx, created, {
        to: "awaiting_confirmation",
        generationJobId: null,
        mediaAssetId: null,
      });
      return requestMediaReceipt(awaiting, false);
    });
  }

  const receipt = await fulfillAuthorizedMedia({
    turn: judged, attempt: effect.attempt, attachmentId, plan, effectMetadata, requestMetadata,
  }, authority);
  return requestMediaReceipt(receipt.attachment, receipt.duplicate);
}

function liveImageNudity(plan: MediaPlan) {
  return plan.requestedNudity === "partial" ? "unspecified" : plan.requestedNudity;
}

function validateLiveImageDirection(plan: MediaPlan, turn: Turn) {
  try {
    compileChatImagePrompt(plan.direction, plan.subject === "scene" ? "unspecified" : liveImageNudity(plan),
      { userInstruction: plan.subject === "scene" ? undefined : turn.userContent });
  } catch (error) {
    if (error instanceof RangeError) throw Errors.badRequest(error.message);
    throw error;
  }
}

function assertMediaEffect(attachment: ChatTurnAttachment, effect: Record<string, unknown>) {
  if (typeof effect.requestDigest === "string") {
    assertToolEffectRequest(attachment, String(effect.name), effect.requestDigest);
  }
}

async function readMediaAttachment(userId: string, attachmentId: string, attempt: number, effect: Record<string, unknown>) {
  return prisma.$transaction(async (tx) => {
    const scope = await lockChatScope(tx, { userId, at: { attachment: attachmentId },
      expect: { attempt, attachmentAttemptMatchesTurn: true } });
    if (scope.session.status !== "active") throw Errors.gone("Chat session is archived");
    const attachment = scope.attachment!;
    assertMediaEffect(attachment, effect);
    return attachment;
  });
}

async function fulfillAuthorizedMedia(
  input: AuthorizedMedia,
  authority?: Awaited<ReturnType<typeof loadChatAuthoritySnapshot>>,
): Promise<MediaFulfillmentReceipt> {
  const { turn, attempt, attachmentId, plan, effectMetadata, requestMetadata, confirmedQuoteCost } = input;
  const userId = turn.session.userId;
  if (plan.matchedEntryId && plan.visualProfileId && plan.visualProfileVersion) {
    try {
      const receipt = await schedulePaidCuratedMediaDelivery({
        userId,
        turnId: turn.id,
        attempt,
        attachmentId,
        entryId: plan.matchedEntryId,
        kind: plan.kind,
        entryRevision: plan.matchedEntryRevision,
        visualProfileId: plan.visualProfileId,
        visualProfileVersion: plan.visualProfileVersion,
        confirmedQuoteCost,
        effectMetadata,
        requestMetadata,
      });
      if (receipt.attachment.status !== "requesting") return receipt;
      // The exact action had already reserved the live branch before this read.
    } catch (error) {
      if (!(error instanceof CuratedMediaUnavailable) || plan.kind !== "image" || plan.mode !== "auto") throw error;
      logger.info({ attachmentId }, "Curated image is unavailable for this authorized action");
    }
  }

  if (plan.kind !== "image" || plan.mode === "existing_only") {
    throw Errors.conflict("This curated media is no longer available");
  }
  if (!turn.characterContentVersionId) throw Errors.gone("Chat Turn has no immutable Character content pin");
  authority ??= await loadChatAuthoritySnapshot(userId, {
    characterId: turn.session.characterId,
    contentVersionId: turn.characterContentVersionId,
    releaseId: turn.characterReleaseId,
    visualProfileId: turn.characterVisualProfileId,
    visualProfileVersion: turn.characterVisualProfileVersion,
  });
  if (!authority.entitlement.imageToolEnabled || authority.character?.imageToolEnabled !== true) {
    throw Errors.forbidden("Image generation is unavailable for this Chat");
  }
  validateLiveImageDirection(plan, turn);

  if (confirmedQuoteCost === undefined) {
    const existing = await prisma.$transaction(async (tx) => {
      const scope = await lockChatScope(tx, {
        userId,
        at: { turn: turn.id },
        expect: { attempt, assistantStatus: ACTIVE_ASSISTANT_STATES },
      });
      if (scope.session.status !== "active") throw Errors.gone("Chat session is archived");
      const existing = await tx.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
      if (existing) {
        assertMediaEffect(existing, effectMetadata);
        if (existing.turnId !== turn.id || attachmentAttempt(existing.metadata) !== attempt) {
          throw Errors.conflict("This media action belongs to another Chat attempt");
        }
        return existing.status === "requesting" ? null : existing;
      }
      await assertChatSessionServingAuthority(tx, userId, scope.session);
      await createToolEffectAttachment(tx, {
        id: attachmentId, turn: scope.turn!, kind: "generated_image", attempt,
        promptHint: plan.direction, metadata: { effect: effectMetadata, request: requestMetadata },
      });
      return null;
    });
    if (existing) return { attachment: existing, duplicate: true };
  }

  let duplicate: boolean;
  try {
    ({ duplicate } = await createChatImageGenerationJob({
      version: 1,
      kind: "chat.image.requested",
      requestId: (confirmedQuoteCost === undefined ? "chat-tool:" : "chat-quote:") + attachmentId,
      attachmentId,
      sessionId: turn.sessionId,
      exchangeId: turn.id,
      messageId: turn.assistantMessageId,
      userId,
      characterId: turn.session.characterId,
      subject: plan.subject,
      ...(turn.characterReleaseId ? { characterReleaseId: turn.characterReleaseId } : {}),
      promptHint: plan.direction,
      conversationContext: turn.userContent,
      intent: { requestedNudity: liveImageNudity(plan) },
      controls: { orientation: imageOrientation[plan.orientation ?? "portrait"], outputCount: 1 },
      ...(turn.characterVisualProfileId && turn.characterVisualProfileVersion ? {
        visualProfileId: turn.characterVisualProfileId,
        visualProfileVersion: turn.characterVisualProfileVersion,
      } : {}),
      ...(authority.character?.release ? {
        releaseSnapshotHash: authority.character.release.snapshotHash,
        referenceSetRevisionId: authority.character.release.referenceSetRevisionId ?? undefined,
      } : {}),
    }, attempt, confirmedQuoteCost));
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "conflict") throw error;
    // If a concurrent confirmation delivered stock while generation was being
    // prepared, generation's lock rejects the spend. Replay the actual receipt.
    const attachment = await readMediaAttachment(userId, attachmentId, attempt, effectMetadata);
    if (attachment.generationJobId || record(attachment.metadata).paidCuratedDelivery === true) {
      return { attachment, duplicate: true };
    }
    throw error;
  }

  return { attachment: await readMediaAttachment(userId, attachmentId, attempt, effectMetadata), duplicate };
}

/**
 * Free, instant resend of a previously delivered asset in this chat session.
 * Zero search, zero delay, zero DreamCoin charge, zero large-file blob I/O.
 */
export async function resendSessionMediaRequest(input: {
  readonly effect: ChatToolEffect;
  readonly judged: Turn;
  readonly attachmentId: string;
  readonly requestDigest: string;
}): Promise<ResendSessionMediaResult> {
  const { effect, judged, attachmentId, requestDigest } = input;
  const parsed = resendSessionMediaArgsSchema.safeParse(effect.arguments);
  if (!parsed.success) throw Errors.badRequest("Invalid resend media arguments");
  const { previousMediaAssetId } = parsed.data;
  const snapshot = frozenSnapshot(judged, judged.session, effect);
  if (!snapshot.recentMedia?.some((item) => item.mediaAssetId === previousMediaAssetId)) {
    throw Errors.forbidden("The previous media is not a delivered result in this Chat context");
  }

  return prisma.$transaction(async (tx) => {
    const scope = await lockChatScope(tx, {
      userId: snapshot.userId,
      at: { turn: effect.turnId },
      expect: { attempt: effect.attempt },
    });
    const raced = await tx.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
    if (raced) {
      assertToolEffectRequest(raced, effect.name, requestDigest);
      return resendMediaReceipt(raced, true);
    }
    if (!ACTIVE_ASSISTANT_STATES.includes(scope.turn!.assistantStatus)) {
      throw Errors.conflict("Media resend does not belong to an active Chat attempt");
    }
    if (scope.session.status !== "active") throw Errors.gone("Chat session is archived");
    await assertChatSessionServingAuthority(tx, snapshot.userId, scope.session);
    await lockMediaAssetAuthorityShared(tx, previousMediaAssetId);

    const previous = (await deliveredChatMedia(tx, {
      userId: snapshot.userId,
      characterId: snapshot.characterId,
      sessionId: snapshot.sessionId,
      before: scope.turn!.createdAt,
      mediaAssetId: previousMediaAssetId,
    }))[0];
    if (!previous || !resolveMediaAssetBlobLocator(previous.asset)) {
      throw Errors.notFound("The previous media is no longer available in this Chat");
    }

    const created = await createToolEffectAttachment(tx, {
      id: attachmentId,
      turn: scope.turn!,
      attempt: effect.attempt,
      kind: previous.asset.type === "video" ? "generated_video" : "generated_image",
      promptHint: null,
      metadata: {
        source: "previous_media",
        description: previous.description,
        costDreamcoins: 0,
        effect: {
          turnId: effect.turnId,
          attempt: effect.attempt,
          callId: effect.callId,
          name: RESEND_SESSION_MEDIA_TOOL,
          effectScope: effect.effectScope,
          intent: effect.intent,
          requestDigest,
        },
        request: {
          name: RESEND_SESSION_MEDIA_TOOL,
          previousMediaAssetId,
          subject: previous.asset.characterId === null ? "scene" : "companion",
        },
      },
    });
    const completed = await transitionToolEffectAttachment(tx, created, {
      to: "completed",
      generationJobId: null,
      mediaAssetId: previous.asset.id,
      width: previous.asset.width,
      height: previous.asset.height,
    });
    return resendMediaReceipt(completed, false);
  }, { timeout: 15_000 });
}

function readPaidMediaQuote(attachment: ChatTurnAttachment): PaidMediaQuoteMetadata {
  const metadata = record(attachment.metadata);
  if (metadata.confirmationKind !== "paid_media_quote") throw Errors.conflict("This attachment is not a paid media quote");
  const quote = paidMediaQuoteMetadataSchema.safeParse(metadata.paidMediaQuote);
  if (!quote.success) throw Errors.conflict("This media quote is invalid");
  return quote.data;
}

function paidMediaQuoteReceipt({ attachment, duplicate }: MediaFulfillmentReceipt, quote: PaidMediaQuoteMetadata) {
  if (!["accepted", "completed"].includes(attachment.status) &&
      !attachment.generationJobId && record(attachment.metadata).paidCuratedDelivery !== true) {
    throw Errors.conflict("This media quote can no longer be confirmed");
  }
  return {
    attachmentId: attachment.id,
    status: attachment.status,
    kind: quote.kind,
    costDreamcoins: quote.costDreamcoins,
    generationJobId: attachment.generationJobId,
    duplicate,
  };
}

export async function confirmChatMediaQuote(userId: string, attachmentId: string) {
  const { attachment, turn, attempt, quote } = await prisma.$transaction(async (tx) => {
    const scope = await lockChatScope(tx, { userId, at: { attachment: attachmentId }, allowDeletedSession: true });
    if (scope.session.status !== "active") throw Errors.notFound("Media quote not found");
    const attachment = scope.attachment!;
    const turn = { ...scope.turn!, session: scope.session };
    const attempt = attachmentAttempt(attachment.metadata);
    if (turn.attempt !== attempt) throw Errors.conflict("This media quote belongs to another Chat attempt");
    return { attachment, turn, attempt, quote: readPaidMediaQuote(attachment) };
  });
  if (attachment.status !== "awaiting_confirmation") return paidMediaQuoteReceipt({ attachment, duplicate: true }, quote);
  const metadata = record(attachment.metadata);
  const receipt = await fulfillAuthorizedMedia({
    turn, attempt, attachmentId, plan: quote,
    effectMetadata: record(metadata.effect), requestMetadata: record(metadata.request),
    confirmedQuoteCost: quote.costDreamcoins,
  });
  return paidMediaQuoteReceipt(receipt, quote);
}

export async function cancelChatMediaQuote(userId: string, attachmentId: string) {
  return prisma.$transaction(async (tx) => {
    const scope = await lockChatScope(tx, { userId, at: { attachment: attachmentId } });
    const current = scope.attachment!;
    if (record(current.metadata).confirmationKind !== "paid_media_quote") {
      throw Errors.conflict("This attachment is not a paid media quote");
    }
    if (current.status === "cancelled") {
      return { attachmentId: current.id, status: "cancelled" as const, costDreamcoins: 0 };
    }
    if (current.status !== "awaiting_confirmation") {
      throw Errors.conflict("This media quote can no longer be cancelled");
    }
    await transitionToolEffectAttachment(tx, current, {
      to: "cancelled",
      errorCode: "quote_cancelled",
    });
    return { attachmentId: current.id, status: "cancelled" as const, costDreamcoins: 0 };
  });
}

/**
 * `/api/v1/chat/attachments/:attachmentId/media-quote/(confirm|cancel)`
 */
export async function dispatchChatMediaQuote(request: Request, segments: string[]) {
  if (
    segments[0] !== "chat"
    || segments[1] !== "attachments"
    || !segments[2]
    || segments[3] !== "media-quote"
    || !["confirm", "cancel"].includes(segments[4] ?? "")
    || segments.length !== 5
  ) {
    return null;
  }
  if (request.method !== "POST") return null;
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const attachmentId = decodeURIComponent(segments[2]);
  const action = segments[4];
  if (action === "cancel") {
    return ok(await cancelChatMediaQuote(user.id, attachmentId));
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw Errors.badRequest("An Idempotency-Key header is required to confirm a paid media quote");
  }
  return ok(await confirmChatMediaQuote(user.id, attachmentId), { status: 202 });
}

export function requestMediaReceipt(
  attachment: ChatTurnAttachment,
  duplicate: boolean,
): RequestCharacterMediaResult | NonNullable<ReturnType<typeof failedToolEffectReceipt>> {
  const failure = failedToolEffectReceipt(attachment, duplicate);
  if (failure) return failure;
  const meta = record(attachment.metadata);
  const kind = attachment.kind === "generated_video" ? "video" : "image";
  const costDreamcoins = typeof meta.costDreamcoins === "number" ? meta.costDreamcoins : 0;
  if (attachment.status === "awaiting_confirmation") {
    return {
      accepted: true,
      duplicate,
      status: "awaiting_confirmation",
      confirmationKind: "paid_media_quote",
      attachmentId: attachment.id,
      kind,
      generationJobId: null,
      mediaAssetId: null,
      costDreamcoins,
    };
  }
  if (attachment.status === "completed" && attachment.mediaAssetId) {
    return {
      accepted: true, duplicate, status: "completed", attachmentId: attachment.id, kind,
      generationJobId: attachment.generationJobId, mediaAssetId: attachment.mediaAssetId, costDreamcoins,
    } satisfies RequestCharacterMediaResult;
  }
  if (attachment.status !== "accepted") {
    throw Errors.conflict("The paid media action has not been accepted");
  }
  return {
    accepted: true,
    duplicate,
    status: "accepted",
    attachmentId: attachment.id,
    kind,
    generationJobId: attachment.generationJobId,
    mediaAssetId: null,
    costDreamcoins,
  };
}

export function resendMediaReceipt(attachment: ChatTurnAttachment, duplicate: boolean): ResendSessionMediaResult {
  const metadata = record(attachment.metadata);
  if (attachment.status !== "completed" || !attachment.mediaAssetId || attachment.generationJobId !== null
    || metadata.source !== "previous_media" || metadata.costDreamcoins !== 0) {
    throw Errors.conflict("This previous media has no completed resend receipt");
  }
  return {
    accepted: true, duplicate, status: "completed", attachmentId: attachment.id,
    kind: attachment.kind === "generated_video" ? "video" : "image",
    mediaAssetId: attachment.mediaAssetId, generationJobId: null, costDreamcoins: 0, source: "previous_media",
    description: typeof metadata.description === "string" ? metadata.description : null,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
