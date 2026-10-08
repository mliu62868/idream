import { createHash, randomUUID } from "node:crypto";
import { Prisma, type MediaAsset, type VoiceClipRequest } from "@prisma/client";
import { z } from "zod";
import { chatSceneStateSchema, voiceClipBillingAuthoritySchema, type VoiceClipBillingAuthority, type VoiceClipQuote } from "@idream/shared/contracts";
import { fishAudioDeliverySettingsSchema } from "@idream/shared/admin";
import {
  getAuthCtx,
  requireAgeGate,
  requireAgeVerified,
  requireUser,
} from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { AppError, Errors } from "@/server/lib/errors";
import { jsonBody } from "@/server/lib/request-json";
import { env } from "@/server/lib/env";
import { generationCostFromAuthority, resolveGenerationPricingAuthority } from "@/server/lib/generation-pricing";
import { ok } from "@/server/lib/http";
import { logger } from "@/server/lib/logger";
import { dreamcoinBalance, postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { lockChatScope } from "@/server/modules/chat/turn-scope";
import { canonicalJsonHash } from "@/server/modules/admin-v2/shared/idempotency";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { resolveCharacterVoiceAuthority } from "@/server/modules/voice-defaults";
import { providers } from "@/server/providers";
import type { VoiceClipPort } from "@/server/providers/types";
import { createVoiceClipPortForKey } from "@/server/providers/voice/factory";
import { audioFileExtension, voiceArtifactKey, voiceProviderIdempotencyKey } from "@/server/providers/voice/idempotency";
import { encodeVoiceClipMp3 } from "@/server/providers/voice/transcode";
import { acceptVoiceClipQuote, signVoiceClipQuote } from "./voice-clip-quote";
import {
  fetchChatMessageVoiceAuthority,
  type ChatMessageVoiceAuthority,
} from "@/server/bff/chat-proxy";

// INVARIANT: 只朗读 Main 账本里已发送的回复。sessionId 必填、朗读文本只取 Chat 权威
// 文本；客户端 text 仅作兼容字段，不进入合成——否则这个接口就是任意文本的 TTS，
// 能用他人角色（含克隆声音）说任何话。
const voiceClipSchema = z.object({
  characterId: z.string().min(1),
  messageId: z.string().min(1),
  sessionId: z.string().min(1),
  text: z.string().trim().max(2_000).optional(),
  intent: z.enum(["play", "prewarm"]).default("play"),
  quoteToken: z.string().min(1).max(8192).nullish(),
});

export const voiceClipSynthesisPayloadSchema = z
  .object({
    version: z.literal(1),
    text: z.string().trim().min(1).max(2_000),
    sessionId: z.string().min(1).nullable(),
    intent: z.enum(["play", "prewarm"]),
    sceneVersion: z.number().int().nonnegative().optional(),
    scene: chatSceneStateSchema.nullable().optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const hasSceneVersion = payload.sceneVersion !== undefined;
    const hasScene = payload.scene !== undefined;
    if (hasSceneVersion !== hasScene) {
      ctx.addIssue({
        code: "custom",
        path: hasSceneVersion ? ["scene"] : ["sceneVersion"],
        message: "sceneVersion and scene must be pinned together",
      });
      return;
    }
    if (
      hasSceneVersion &&
      payload.sceneVersion !== (payload.scene?.version ?? 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sceneVersion"],
        message: "sceneVersion must match the pinned scene revision",
      });
    }
  });

export const pinnedVoiceProviderPayloadSchema = z
  .object({
    providerKey: z.enum(["mock", "pocket_tts", "fish_audio"]),
    voiceId: z.string().min(1),
    voiceAuthority: z.enum(["system_default", "character_clone"]),
    systemVoiceSettingVersion: z.number().int().nonnegative().nullable(),
    characterVoiceProfileVersion: z.number().int().positive().nullable().default(null),
    tone: z.string().min(1),
    delivery: fishAudioDeliverySettingsSchema,
  })
  .superRefine((payload, ctx) => {
    const systemAuthority = payload.voiceAuthority === "system_default";
    if (systemAuthority !== (payload.systemVoiceSettingVersion !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["systemVoiceSettingVersion"],
        message: "system voice authority must pin exactly one system setting version",
      });
    }
    if (systemAuthority === (payload.characterVoiceProfileVersion !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["characterVoiceProfileVersion"],
        message: "character clone authority must pin exactly one Character voice profile version",
      });
    }
  });

const VOICE_CLIP_CACHE_VERSION = 8;
const VOICE_CLIP_POLL_MS = 25;

type VoiceCharacter = {
  id: string;
  age: number;
  name: string;
  style: string;
  voiceId: string | null;
  gender: string;
};

export type VoiceClipDependencies = {
  readonly entitlementMap: (
    userId: string,
  ) => Promise<Record<string, Prisma.JsonValue>>;
  readonly readableCharacter: (
    characterId: string,
    userId: string,
  ) => Promise<VoiceCharacter>;
  readonly messageVoiceAuthority?: (
    request: Request,
    input: { sessionId: string; messageId: string; testOnlyText?: string; characterId?: string },
  ) => Promise<ChatMessageVoiceAuthority>;
};

type VoiceRequestClaim =
  | {
      kind: "owner";
      request: VoiceClipRequest;
      leaseOwner: string;
    }
  | {
      kind: "replay";
      asset: MediaAsset;
    };

type VoiceClipSynthesisPayload = z.infer<
  typeof voiceClipSynthesisPayloadSchema
>;

export type VoiceClipSuccessCommit = (
  tx: Prisma.TransactionClient,
  result: {
    readonly requestId: string;
    readonly attemptNo: number;
    readonly mediaAssetId: string;
    readonly provider: string;
  },
) => Promise<void>;

async function resolveVoiceClipInput(
  request: Request,
  deps: VoiceClipDependencies,
) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = voiceClipSchema.parse(await jsonBody(request));
  const messageAuthority = await (deps.messageVoiceAuthority ?? fetchChatMessageVoiceAuthority)(request, {
    sessionId: body.sessionId,
    messageId: body.messageId,
    testOnlyText: body.text,
    characterId: body.characterId,
  }).catch((cause) => {
    if (cause instanceof AppError && cause.status < 500) throw cause;
    throw Errors.unavailable("Chat message authority is unavailable for Voice", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  });
  if (messageAuthority.characterId !== body.characterId) {
    throw Errors.conflict("Voice message belongs to another Character");
  }
  const authoritativeText = messageAuthority.text;
  const authoritativeScene = messageAuthority.scene ?? null;
  const synthesisPayload = voiceClipSynthesisPayloadSchema.parse({
    version: 1,
    text: authoritativeText,
    sessionId: body.sessionId,
    intent: body.intent,
    sceneVersion: messageAuthority.sceneVersion ?? 0,
    scene: authoritativeScene,
  });
  const legacyFingerprintInput = {
    schemaVersion: "voice-clip-request-v1",
    userId: user.id,
    characterId: body.characterId,
    messageId: body.messageId,
    sessionId: body.sessionId,
    text: authoritativeText,
    sceneVersion: messageAuthority.sceneVersion ?? 0,
    scene: authoritativeScene,
  };
  const replyAttempt = z.number().int().positive().parse(messageAuthority.attempt);
  const requestFingerprint = canonicalJsonHash({
    ...legacyFingerprintInput, schemaVersion: "voice-clip-request-v2", replyAttempt,
  });
  return { user, body, synthesisPayload, replyAttempt, requestFingerprint, legacyRequestFingerprint: canonicalJsonHash(legacyFingerprintInput) };
}

async function existingVoiceRequest(input: Awaited<ReturnType<typeof resolveVoiceClipInput>>) {
  const existing = await prisma.voiceClipRequest.findUnique({
    where: { userId_messageId_replyAttempt: { userId: input.user.id, messageId: input.body.messageId, replyAttempt: input.replyAttempt } },
    include: { mediaAsset: true },
  });
  // A proven legacy version keeps its original ID, accepted quote, provider key
  // and immutable fingerprint. New requests always pin the reply attempt.
  const matchesLegacy = existing?.id === legacyVoiceRequestId(input.user.id, input.body.messageId) &&
    existing.requestFingerprint === input.legacyRequestFingerprint;
  if (existing && ((!matchesLegacy && existing.requestFingerprint !== input.requestFingerprint) || existing.characterId !== input.body.characterId)) {
    throw Errors.conflict("Voice message id is bound to a different synthesis request", { requestId: existing.id });
  }
  if (existing?.errorCode === "provider_outcome_unknown") {
    throw Errors.conflict("Voice provider outcome is unknown and automatic replay is forbidden", { requestId: existing.id, errorCode: existing.errorCode });
  }
  return existing;
}

function storedVoiceBilling(request: Pick<VoiceClipRequest, "billingAuthority"> | null) {
  if (request?.billingAuthority === null || request?.billingAuthority === undefined) return null;
  return voiceClipBillingAuthoritySchema.parse(request.billingAuthority);
}

async function newVoiceBilling(input: {
  userId: string;
  requestFingerprint: string;
  intent: "play" | "prewarm";
  entitlements: Record<string, Prisma.JsonValue>;
}): Promise<VoiceClipBillingAuthority> {
  const now = new Date();
  const pricing = await resolveGenerationPricingAuthority("voice");
  const overflowCostDreamcoins = generationCostFromAuthority(pricing, 1);
  return voiceClipBillingAuthoritySchema.parse({
    version: 1, userId: input.userId, requestFingerprint: input.requestFingerprint, intent: input.intent,
    pricingFingerprint: canonicalJsonHash({ ...pricing, effectiveFrom: pricing.effectiveFrom?.toISOString() ?? null, updatedAt: pricing.updatedAt.toISOString() }),
    overflowCostDreamcoins, maxCostDreamcoins: input.intent === "prewarm" ? 0 : overflowCostDreamcoins,
    allowanceMinutes: typeof input.entitlements.voice_minutes === "number" ? input.entitlements.voice_minutes : 0,
    allowanceWindowStartsAt: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
    quotedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  });
}

export async function quoteVoiceClip(request: Request, deps: VoiceClipDependencies) {
  const input = await resolveVoiceClipInput(request, deps);
  const existing = await existingVoiceRequest(input);
  const alreadyDelivered = Boolean(existing && await hasDeliveredVoiceUsage(existing.id));
  const stored = storedVoiceBilling(existing);
  const accepted = alreadyDelivered || stored?.intent === "play";
  const entitlements = accepted
    ? { voice_enabled: true, voice_minutes: stored?.allowanceMinutes ?? 0 }
    : await deps.entitlementMap(input.user.id);
  if (!accepted) {
    if (!(await featureFlagEnabled("voice_gen"))) throw Errors.forbidden("Voice generation is disabled");
    const character = await deps.readableCharacter(input.body.characterId, input.user.id);
    if (character.age < 18) throw Errors.badRequest("Character is not eligible for voice", { policyCode: "UNDERAGE" });
  }
  const terms = accepted ? stored : await newVoiceBilling({
    userId: input.user.id, requestFingerprint: existing?.requestFingerprint ?? input.requestFingerprint, intent: input.body.intent, entitlements,
  });
  const quote: VoiceClipQuote = {
    quoteToken: accepted || !terms ? null : signVoiceClipQuote(terms, env.BETTER_AUTH_SECRET),
    maxCostDreamcoins: alreadyDelivered ? 0 : terms!.maxCostDreamcoins,
    overflowCostDreamcoins: terms?.overflowCostDreamcoins ?? 0,
    allowanceMinutes: terms?.allowanceMinutes ?? 0,
    remainingAllowanceMs: terms ? await voiceMinutesRemainingMs(input.user.id,
      { voice_minutes: terms.allowanceMinutes }, prisma, new Date(terms.allowanceWindowStartsAt)) : 0,
    balance: await dreamcoinBalance(input.user.id), accepted, alreadyDelivered,
  };
  return ok({ quote });
}

// Call consent and voice identity are Main-owned. Public callers cannot supply
// this execution authority; ordinary message playback keeps the quote protocol.
export type VoiceClipExecutionAuthority = {
  callUtteranceId: string;
  providerPayload: z.infer<typeof pinnedVoiceProviderPayloadSchema>;
  billingAuthority: (requestFingerprint: string) => VoiceClipBillingAuthority;
};

export async function createVoiceClip(request: Request, deps: VoiceClipDependencies, authority?: VoiceClipExecutionAuthority) {
  const input = await resolveVoiceClipInput(request, deps);
  const { user, body, synthesisPayload, replyAttempt } = input;
  const existing = await existingVoiceRequest(input);
  const requestFingerprint = existing?.requestFingerprint ?? input.requestFingerprint;
  if (authority && existing && canonicalJsonHash(existing.providerPayload) !== canonicalJsonHash(authority.providerPayload)) {
    throw Errors.conflict("This reply already has a different pinned voice identity");
  }
  // Playback of an already delivered asset survives plan expiry and a disabled
  // new-generation capability. The exact selected reply still owns this clip.
  if (existing?.status === "succeeded" && existing.mediaAsset &&
    existing.mediaAsset.deletedAt === null && isCurrentVoiceClip(existing.mediaAsset)) {
    if (authority && !existing.voiceCallUtteranceId) {
      // The same reply may already have a paid clip. Reuse it without moving
      // its immutable request or attributing its earlier charge to this Call.
      await prisma.voiceCallUtterance.updateMany({ where: { id: authority.callUtteranceId, status: "linked", settledAt: null }, data: {
        status: "delivered", voiceRequestId: existing.id, mediaAssetId: existing.mediaAsset.id, settledAt: new Date(),
      } });
    }
    return ok(voiceClipResponse(existing.mediaAsset));
  }
  if (!authority && await prisma.voiceCallUtterance.findFirst({ where: { assistantMessageId: body.messageId, replyAttempt,
    status: { in: ["transcribing", "linked"] }, call: { status: { in: ["active", "muted"] } } }, select: { id: true } })) {
    throw Errors.conflict("Use the active Call controls for this spoken reply");
  }
  const previouslyDelivered = Boolean(existing && await hasDeliveredVoiceUsage(existing.id));
  const stored = storedVoiceBilling(existing);
  const acceptedBilling = stored?.intent === "play" ? stored : null;
  const prewarming = body.intent === "prewarm";
  // Automatic playback must never resume a previously accepted paid attempt.
  // Only another explicit Play can exercise that saved commercial consent.
  if (prewarming && acceptedBilling) {
    return ok(voicePrewarmSkipped(body.messageId, "play_required"));
  }

  if (!acceptedBilling && !previouslyDelivered && !(await featureFlagEnabled("voice_gen"))) {
    if (prewarming) return ok(voicePrewarmSkipped(body.messageId, "disabled"));
    throw Errors.forbidden("Voice generation is disabled");
  }

  const entitlements = acceptedBilling
    ? { voice_enabled: true, voice_minutes: acceptedBilling.allowanceMinutes }
    : await deps.entitlementMap(user.id);
  // SPEC: a reader without a voice plan may still press Play. They have no
  //   minutes, so every clip is quoted and paid in Dreamcoins (signup bonus
  //   included), and it uses the cheapest voice route (see voiceAuthority).
  // INTENT: automatic prewarm stays plan-only; for them it would be synthesis
  //   nobody asked to pay for.
  if (!previouslyDelivered && entitlements.voice_enabled !== true && prewarming) {
    return ok(voicePrewarmSkipped(body.messageId, "not_entitled"));
  }

  const character = await deps.readableCharacter(body.characterId, user.id);
  if (character.age < 18) {
    throw Errors.badRequest("Character is not eligible for voice", {
      policyCode: "UNDERAGE",
    });
  }

  let billingAuthority = acceptedBilling ?? authority?.billingAuthority(requestFingerprint) ?? null;
  if (!billingAuthority && previouslyDelivered) {
    const now = new Date();
    billingAuthority = {
      version: 1, userId: user.id, requestFingerprint, intent: "play", pricingFingerprint: "previous-delivery",
      overflowCostDreamcoins: 0, maxCostDreamcoins: 0, allowanceMinutes: 0,
      allowanceWindowStartsAt: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
      quotedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    };
  }
  if (!billingAuthority && prewarming) {
    billingAuthority = stored ?? await newVoiceBilling({ userId: user.id, requestFingerprint, intent: "prewarm", entitlements });
  }
  if (!billingAuthority) {
    if (!body.quoteToken) throw Errors.conflict("An exact Voice quote is required before playback", { reason: "voice_quote_required" });
    billingAuthority = acceptVoiceClipQuote({ token: body.quoteToken, secret: env.BETTER_AUTH_SECRET, userId: user.id, requestFingerprint });
    const allowanceMinutes = typeof entitlements.voice_minutes === "number" ? entitlements.voice_minutes : 0;
    if (billingAuthority.intent !== "play" || billingAuthority.allowanceMinutes !== allowanceMinutes) {
      throw Errors.conflict("Voice allowance changed; request another quote", { reason: "voice_quote_stale" });
    }
  }
  const overflowCost = billingAuthority.overflowCostDreamcoins;
  const remainingBeforeSynthesis = await voiceMinutesRemainingMs(
    user.id,
    { voice_minutes: billingAuthority.allowanceMinutes },
    prisma,
    new Date(billingAuthority.allowanceWindowStartsAt),
  );
  const requestId = existing?.id ?? voiceRequestId(user.id, body.messageId, replyAttempt);
  const staleAssets = await prisma.mediaAsset.findMany({
    where: voiceAssetWhere({ id: requestId, userId: user.id, messageId: body.messageId, replyAttempt }),
    orderBy: { createdAt: "desc" },
  });
  const hasStaleCachedClip = staleAssets.length > 0 || await hasDeliveredVoiceUsage(
    requestId,
  );
  if (
    prewarming &&
    !hasStaleCachedClip &&
    remainingBeforeSynthesis <= 0
  ) {
    return ok(voicePrewarmSkipped(body.messageId, "allowance_exhausted"));
  }
  if (
    !prewarming &&
    !hasStaleCachedClip &&
    overflowCost > 0 &&
    remainingBeforeSynthesis <= 0 &&
    (await dreamcoinBalance(user.id)) < overflowCost
  ) {
    throw Errors.paymentRequired("Insufficient dreamcoins", {
      cost: overflowCost,
      required: overflowCost,
    });
  }

  // A retry of an existing request keeps its pinned provider payload (see
  // claimVoiceRequest), so this choice is made once, on the first Play.
  const voiceAuthority = authority ? null : await resolveCharacterVoiceAuthority({
    characterId: character.id,
    systemDefaultOnly: entitlements.voice_enabled !== true,
  });
  const proposedProviderPayload = authority?.providerPayload ?? pinnedVoiceProviderPayloadSchema.parse({
    providerKey: voiceAuthority!.providerKey,
    voiceId: voiceAuthority!.voiceId,
    voiceAuthority: voiceAuthority!.source,
    systemVoiceSettingVersion: voiceAuthority!.settingVersion,
    characterVoiceProfileVersion: voiceAuthority!.characterVoiceProfileVersion,
    tone: characterVoiceTone(character),
    delivery: voiceAuthority!.delivery,
  });
  const claim = await claimVoiceRequest({
    userId: user.id,
    characterId: character.id,
    messageId: body.messageId,
    replyAttempt,
    voiceCallUtteranceId: authority?.callUtteranceId,
    requestFingerprint,
    synthesisPayload,
    billingAuthority,
    providerPayload: proposedProviderPayload,
  });
  if (claim.kind === "replay") {
    return ok(voiceClipResponse(claim.asset));
  }
  if (authority) await prisma.voiceCallUtterance.updateMany({ where: { id: authority.callUtteranceId, settledAt: null }, data: { voiceRequestId: claim.request.id } });
  const claimedSynthesisPayload = voiceClipSynthesisPayloadSchema.parse(
    claim.request.synthesisPayload,
  );

  return executeOwnedVoiceClaim({
    claim,
    user: { id: user.id },
    character,
    body: claimedSynthesisPayload,
    prewarming: claimedSynthesisPayload.intent === "prewarm",
    entitlements,
    overflowCost,
  });
}

export type ReclaimedVoiceClip = {
  readonly requestId: string;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly attemptNo: number;
  readonly mediaAssetId: string | null;
  readonly provider: string | null;
};

// SPEC: An operator reclaim is a takeover of one expired running lease, never
// a new synthesis request. The persisted synthesis/provider payloads and the
// request-scoped provider idempotency key remain authoritative across takeover.
export async function reclaimExpiredVoiceClip(input: {
  readonly characterId: string;
  readonly requestId: string;
  readonly deps: VoiceClipDependencies;
  readonly onSuccessCommit?: VoiceClipSuccessCommit;
}): Promise<ReclaimedVoiceClip> {
  const observedAt = new Date();
  const existing = await prisma.voiceClipRequest.findFirst({
    where: { id: input.requestId, characterId: input.characterId },
  });
  if (!existing) throw Errors.notFound("Voice clip request not found");
  if (existing.status !== "running") {
    throw Errors.conflict("Only a running Voice clip request can be reclaimed", {
      requestId: existing.id,
      status: existing.status,
    });
  }
  if (existing.errorCode === "provider_outcome_unknown") {
    throw Errors.conflict("Voice provider outcome is unknown and replay is forbidden", {
      requestId: existing.id,
      reason: "provider_outcome_unknown",
    });
  }
  if (existing.leaseExpiresAt && existing.leaseExpiresAt > observedAt) {
    throw Errors.conflict("Voice clip request lease is still active", {
      requestId: existing.id,
      leaseExpiresAt: existing.leaseExpiresAt.toISOString(),
    });
  }
  const synthesisPayload = voiceClipSynthesisPayloadSchema.safeParse(
    existing.synthesisPayload,
  );
  if (!synthesisPayload.success) {
    throw Errors.conflict(
      "Voice clip request predates durable synthesis payload authority and cannot be reclaimed",
      { requestId: existing.id, reason: "legacy_synthesis_payload_missing" },
    );
  }
  const providerPayload = pinnedVoiceProviderPayloadSchema.safeParse(
    existing.providerPayload,
  );
  if (!providerPayload.success) {
    throw Errors.conflict("Voice clip request has an invalid pinned provider payload", {
      requestId: existing.id,
    });
  }
  let voiceProvider: VoiceClipPort;
  try {
    voiceProvider = resolvePinnedVoiceProvider(providerPayload.data.providerKey);
  } catch (cause) {
    throw Errors.unavailable("Pinned Voice provider is unavailable", {
      requestId: existing.id,
      pinnedProvider: providerPayload.data.providerKey,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (voiceProvider.providerKey !== providerPayload.data.providerKey) {
    throw Errors.conflict(
      "The pinned Voice adapter does not match the reserved provider",
      {
        requestId: existing.id,
        pinnedProvider: providerPayload.data.providerKey,
        adapterProvider: voiceProvider.providerKey,
        reason: "provider_adapter_mismatch",
      },
    );
  }
  // INVARIANT: an Admin reclaim must not mutate the row — not even to take the
  // lease — when the reservation it would have to reuse is not the one this
  // request owns. Checked here rather than inside executeOwnedVoiceClaim, which
  // only runs after the claiming updateMany below.
  if (
    existing.providerRequestId &&
    existing.providerRequestId !== voiceProviderIdempotencyKey(existing.id)
  ) {
    throw Errors.conflict(
      "Voice provider invocation reservation does not match the request authority",
      {
        requestId: existing.id,
        provider: providerPayload.data.providerKey,
        reason: "provider_reservation_mismatch",
      },
    );
  }
  if (!(await featureFlagEnabled("voice_gen"))) {
    throw Errors.conflict("Voice generation is disabled; the request was not reclaimed");
  }
  const billing = storedVoiceBilling(existing);
  const entitlements = billing?.intent === "play"
    ? { voice_enabled: true, voice_minutes: billing.allowanceMinutes }
    : await input.deps.entitlementMap(existing.userId);
  if (entitlements.voice_enabled !== true) {
    throw Errors.conflict(
      "Voice entitlement is no longer active; the request was not reclaimed",
      { requestId: existing.id, entitlement: "voice_enabled" },
    );
  }
  const character = await input.deps.readableCharacter(
    existing.characterId,
    existing.userId,
  );
  if (character.age < 18) {
    throw Errors.badRequest("Character is not eligible for voice", {
      policyCode: "UNDERAGE",
    });
  }

  const leaseOwner = randomUUID();
  const claimedAt = new Date();
  const claimed = await prisma.$transaction(async tx => {
    if (!await lockUser(tx, existing.userId)) throw Errors.gone("Account is no longer active; the voice request was not reclaimed");
    return tx.voiceClipRequest.updateMany({
    where: {
      id: existing.id,
      characterId: input.characterId,
      status: "running",
      attemptNo: existing.attemptNo,
      leaseOwner: existing.leaseOwner,
      leaseExpiresAt: existing.leaseExpiresAt,
      errorCode: existing.errorCode,
      OR: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { lte: claimedAt } },
      ],
    },
    data: {
      attemptNo: existing.attemptNo + 1,
      leaseOwner,
      leaseExpiresAt: new Date(
        claimedAt.getTime() +
          voiceClipLeaseMs(providerPayload.data.providerKey),
      ),
      mediaAssetId: null,
      errorCode: null,
      error: Prisma.DbNull,
      startedAt: claimedAt,
      completedAt: null,
    },
    });
  });
  if (claimed.count !== 1) {
    throw Errors.conflict(
      "Voice clip request changed while the reclaim was being authorized",
      { requestId: existing.id },
    );
  }
  const request = await prisma.voiceClipRequest.findUniqueOrThrow({
    where: { id: existing.id },
  });
  await executeOwnedVoiceClaim({
    claim: { kind: "owner", request, leaseOwner },
    user: { id: request.userId },
    character,
    body: synthesisPayload.data,
    prewarming: synthesisPayload.data.intent === "prewarm",
    entitlements,
    // A legacy operator reclaim cannot invent consent to a new coin charge.
    overflowCost: billing?.overflowCostDreamcoins ?? 0,
    onSuccessCommit: input.onSuccessCommit,
    voiceProvider,
  });
  const terminal = await prisma.voiceClipRequest.findUniqueOrThrow({
    where: { id: request.id },
  });
  if (!(["succeeded", "failed", "skipped"] as const).includes(
    terminal.status as "succeeded" | "failed" | "skipped",
  )) {
    throw Errors.conflict("Voice clip reclaim did not reach a terminal state", {
      requestId: terminal.id,
      status: terminal.status,
    });
  }
  return {
    requestId: terminal.id,
    status: terminal.status as ReclaimedVoiceClip["status"],
    attemptNo: terminal.attemptNo,
    mediaAssetId: terminal.mediaAssetId,
    provider: terminal.provider,
  };
}

async function executeOwnedVoiceClaim(input: {
  readonly claim: Extract<VoiceRequestClaim, { kind: "owner" }>;
  readonly user: { readonly id: string };
  readonly character: VoiceCharacter;
  readonly body: VoiceClipSynthesisPayload;
  readonly prewarming: boolean;
  readonly entitlements: Record<string, Prisma.JsonValue>;
  readonly overflowCost: number;
  readonly onSuccessCommit?: VoiceClipSuccessCommit;
  readonly voiceProvider?: VoiceClipPort;
}) {
  const {
    claim,
    user,
    character,
    body,
    prewarming,
    onSuccessCommit,
  } = input;
  const billing = storedVoiceBilling(claim.request);
  const entitlements = billing
    ? { voice_enabled: true, voice_minutes: billing.allowanceMinutes }
    : input.entitlements;
  const overflowCost = billing?.overflowCostDreamcoins ?? input.overflowCost;
  const maxCostDreamcoins = billing?.maxCostDreamcoins ?? 0;
  const allowanceWindowStartsAt = billing ? new Date(billing.allowanceWindowStartsAt) : undefined;

  const providerPayload = pinnedVoiceProviderPayloadSchema.parse(
    claim.request.providerPayload,
  );
  let voiceProvider = input.voiceProvider;
  try {
    voiceProvider ??= resolvePinnedVoiceProvider(providerPayload.providerKey);
  } catch (cause) {
    await failOwnedVoiceRequest(
      claim,
      "voice_pinned_provider_unavailable",
      cause,
    );
    throw Errors.unavailable("Pinned Voice provider is unavailable", {
      requestId: claim.request.id,
      pinnedProvider: providerPayload.providerKey,
      configuredProvider: providers.voice.clip.providerKey,
    });
  }
  const budgetDecision = await authorizeVoiceSynthesisTurn({
    claim,
    userId: user.id,
    prewarming,
    entitlements,
    overflowCost,
    maxCostDreamcoins,
    allowanceWindowStartsAt,
    providerKey: providerPayload.providerKey,
    synthesisPayload: body,
  });
  if (budgetDecision.kind === "prewarm_skipped") {
    return ok(
      voicePrewarmSkipped(claim.request.messageId, "allowance_exhausted"),
    );
  }
  if (budgetDecision.kind === "payment_required") {
    throw Errors.paymentRequired("Insufficient dreamcoins", {
      balance: budgetDecision.balance,
      cost: overflowCost,
      required: overflowCost,
    });
  }
  if (budgetDecision.kind === "reply_revoked") {
    throw Errors.gone("This reply changed or its conversation is no longer active; no new synthesis was started");
  }
  if (claim.request.voiceCallUtteranceId) {
    const utterance = await prisma.voiceCallUtterance.findUnique({ where: { id: claim.request.voiceCallUtteranceId }, include: { call: true } });
    const live = utterance && utterance.status !== "cancelled" && utterance.call.status === "active" &&
      utterance.call.deadlineAt > new Date() && utterance.call.leaseExpiresAt > new Date();
    if (!live) {
      await failOwnedVoiceRequest(claim, "voice_call_delivery_revoked", { reason: "call_authority_expired" });
      throw Errors.gone("Call is no longer active; no new synthesis was started");
    }
  }
  // INVARIANT: one logical message keeps one provider key across lease expiry,
  // process restart, and transport ambiguity. attemptNo remains telemetry only.
  const providerIdempotencyKey = voiceProviderIdempotencyKey(claim.request.id);
  await reserveVoiceProviderInvocation({
    claim,
    voiceProvider,
    providerIdempotencyKey,
  });
  // A transport exception propagates as-is: the reservation stays pinned, so
  // re-sending the same provider key returns the original synthesis rather than
  // leaving an outcome nobody can resolve. There used to be a catch here that
  // quarantined the request, because one adapter could not be replayed.
  const result = await voiceProvider.synthesize({
    ownerId: user.id,
    requestId: claim.request.id,
    attemptNo: claim.request.attemptNo,
    idempotencyKey: providerIdempotencyKey,
    text: body.text,
    voiceId: providerPayload.voiceId,
    tone: providerPayload.tone,
    delivery: providerPayload.delivery,
    scene: body.scene ?? null,
  });
  if (!result.ok) {
    await failOwnedVoiceRequest(claim, result.error.code, result.error);
    throw Errors.internal("Voice synthesis failed", result.error);
  }

  // SPEC: naming and persistence of the synthesized audio belong here, not to the
  //   adapter. The key is derived from the provider idempotency key, so a durable
  //   same-key replay lands on the same object instead of orphaning the first one.
  // INVARIANT: the blob exists before the commit transaction opens — a MediaAsset
  //   row may never reference bytes that were never stored. The matching cleanup
  //   for a commit that fails afterwards is deleteUndeliveredVoiceBlob below.
  const artifact = await deliverableVoiceAudio(result.data.body, result.data.contentType);
  const storageKey = voiceArtifactKey(
    providerIdempotencyKey,
    audioFileExtension(artifact.contentType),
  );
  // Persist this I/O owner's lifetime independently of lease/status takeover.
  // Erasure waits even after another owner delivers. No lock spans the upload;
  // a stale HTTP authentication snapshot is not upload permission.
  await authorizeVoiceArtifactWrite(claim);
  try {
    const stored = await providers.blob.putPrivate({
      key: storageKey,
      body: artifact.body,
      contentType: artifact.contentType,
    });
    if (!stored.ok) {
      await failOwnedVoiceRequest(claim, stored.error.code, stored.error);
      throw Errors.internal("Voice artifact could not be stored", stored.error);
    }

    const proposedMediaId = `media_voice_${randomUUID()}`;
    const commit = await prisma.$transaction(async (tx) => {
      // Match Chat mutation's User -> group -> Session -> Turn ladder before
      // taking the VoiceRequest lock. TTS can outlive edit/delete/archive.
      const userActive = await lockUser(tx, user.id);
      const replyDeliverable = userActive && await lockVoiceReplyAuthority(tx, claim.request, body);
      await lockVoiceRequest(tx, claim.request.id);
      const owned = await tx.voiceClipRequest.findUniqueOrThrow({
        where: { id: claim.request.id },
      });
      if (
        owned.status !== "running" ||
        owned.leaseOwner !== claim.leaseOwner ||
        owned.attemptNo !== claim.request.attemptNo
      ) {
        throw Errors.conflict("Voice clip request lease changed during synthesis", {
          requestId: owned.id,
          status: owned.status,
          attemptNo: owned.attemptNo,
        });
      }

      const durationMs = Math.max(0, result.data.durationMs);
      const providerUsageRecorded =
        (await tx.voiceUsageFact.count({ where: { requestId: owned.id } })) > 0;
      if (!replyDeliverable) {
        await tx.voiceClipRequest.update({ where: { id: owned.id }, data: {
          status: "failed", errorCode: userActive ? "voice_reply_delivery_revoked" : "voice_account_revoked", error: toInputJson({ reason: userActive ? "selected_reply_changed" : "account_inactive" }),
          leaseOwner: null, leaseExpiresAt: null, completedAt: new Date(),
        } });
        // Execution happened, but it never became a user delivery or charge.
        if (!providerUsageRecorded) await tx.voiceUsageFact.create({ data: {
          id: `voice_usage_${owned.id}_${owned.attemptNo}`, requestId: owned.id, attemptNo: owned.attemptNo,
          userId: user.id, characterId: character.id, mediaAssetId: null, durationMs, costDreamcoins: 0, intent: body.intent,
        } });
        return { kind: "reply_revoked" } as const;
      }

      const activeStaleAssets = await tx.mediaAsset.findMany({
        where: voiceAssetWhere(owned),
        orderBy: { createdAt: "desc" },
      });
      const staleAssetIds = activeStaleAssets.map((asset) => asset.id);
      const reusableProviderAsset = await tx.mediaAsset.findUnique({
        where: { storageKey: storageKey },
      });
      if (
        reusableProviderAsset &&
        (reusableProviderAsset.ownerId !== user.id ||
          reusableProviderAsset.characterId !== character.id ||
          reusableProviderAsset.type !== "voice")
      ) {
        throw Errors.conflict(
          "Voice provider artifact key is already bound to another authority",
          { requestId: owned.id, storageKey: storageKey },
        );
      }
      const mediaId = reusableProviderAsset?.id ?? proposedMediaId;
      const previouslyDelivered = await hasDeliveredVoiceUsage(owned.id, tx);
      const remainingMs = await voiceMinutesRemainingMs(
        user.id,
        entitlements,
        tx,
        allowanceWindowStartsAt,
      );
      const requiresOverflow = !previouslyDelivered && staleAssetIds.length === 0 && remainingMs < durationMs;
      const cost = requiresOverflow ? overflowCost : 0;
      const callUtterance = owned.voiceCallUtteranceId ? await tx.voiceCallUtterance.findUnique({
        where: { id: owned.voiceCallUtteranceId }, include: { call: true },
      }) : null;
      const callCost = callUtterance ? (await tx.voiceCallUtterance.aggregate({ where: { callId: callUtterance.callId }, _sum: { costDreamcoins: true } }))._sum.costDreamcoins ?? 0 : 0;
      const callLive = callUtterance && callUtterance.status !== "cancelled" && callUtterance.call.status === "active" &&
        callUtterance.call.deadlineAt > new Date() && callUtterance.call.leaseExpiresAt > new Date();
      if (owned.voiceCallUtteranceId && (!callLive || callCost + cost > callUtterance!.call.maxCostDreamcoins)) {
        await tx.voiceClipRequest.update({ where: { id: owned.id }, data: {
          status: "failed", errorCode: "voice_call_delivery_revoked", leaseOwner: null, leaseExpiresAt: null, completedAt: new Date(),
        } });
        if (!providerUsageRecorded) await tx.voiceUsageFact.create({ data: {
          id: `voice_usage_${owned.id}_${owned.attemptNo}`, requestId: owned.id, attemptNo: owned.attemptNo,
          userId: user.id, characterId: character.id, mediaAssetId: null, durationMs, costDreamcoins: 0, intent: body.intent,
        } });
        return { kind: "delivery_revoked" } as const;
      }
      const quoteRequired = !prewarming && !billing && requiresOverflow;
      if (quoteRequired || (prewarming && requiresOverflow)) {
        // INVARIANT: provider execution is an immutable usage fact even when
        // automatic delivery loses the allowance race. It must not become a
        // billable or user-visible clip after that decision.
        await tx.voiceClipRequest.update({
          where: { id: owned.id },
          data: {
            status: quoteRequired ? "failed" : "skipped",
            provider: voiceProvider.providerKey,
            providerRequestId: providerIdempotencyKey,
            errorCode: quoteRequired ? "voice_quote_required" : "allowance_exhausted",
            error: toInputJson({ reason: quoteRequired ? "voice_quote_required" : "allowance_exhausted" }),
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
          },
        });
        if (!providerUsageRecorded) await tx.voiceUsageFact.create({
          data: {
            id: `voice_usage_${owned.id}_${owned.attemptNo}`,
            requestId: owned.id,
            attemptNo: owned.attemptNo,
            userId: user.id,
            characterId: character.id,
            mediaAssetId: null,
            durationMs,
            costDreamcoins: 0,
            intent: body.intent,
          },
        });
        return quoteRequired ? { kind: "quote_required" } as const : { kind: "prewarm_skipped" } as const;
      }
      if (cost > maxCostDreamcoins) {
        throw Errors.conflict("Voice delivery exceeds the accepted cost", { reason: "voice_quote_limit_exceeded", maxCostDreamcoins, required: cost });
      }
      if (cost > 0) {
        const balance = await dreamcoinBalance(user.id, tx);
        if (balance < cost) {
          // INVARIANT: a successful provider call is always an immutable usage
          // fact, even if another wallet writer wins after preflight. The clip
          // is not published and no Dreamcoins are charged.
          await tx.voiceClipRequest.update({
            where: { id: owned.id },
            data: {
              status: "failed",
              provider: voiceProvider.providerKey,
              providerRequestId: providerIdempotencyKey,
              errorCode: "insufficient_dreamcoins_after_synthesis",
              error: toInputJson({
                balance,
                cost,
                required: cost,
                providerKey: storageKey,
                durationMs,
              }),
              leaseOwner: null,
              leaseExpiresAt: null,
              completedAt: new Date(),
            },
          });
          if (!providerUsageRecorded) await tx.voiceUsageFact.create({
            data: {
              id: `voice_usage_${owned.id}_${owned.attemptNo}`,
              requestId: owned.id,
              attemptNo: owned.attemptNo,
              userId: user.id,
              characterId: character.id,
              mediaAssetId: null,
              durationMs,
              costDreamcoins: 0,
              intent: body.intent,
            },
          });
          return { kind: "payment_required", balance } as const;
        }
        await postDreamcoinEntry(tx, {
          kind: "generation_spend",
          userId: user.id,
          amount: cost,
          sourceId: mediaId,
          idempotencyKey:
            `voice:${owned.id}:attempt:${owned.attemptNo}:spend`,
        });
      }
      if (staleAssetIds.length > 0) {
        await tx.mediaAsset.updateMany({
          where: { id: { in: staleAssetIds } },
          data: { deletedAt: new Date() },
        });
      }
      const mediaMetadata = toInputJson({
        cacheVersion: VOICE_CLIP_CACHE_VERSION,
        requestId: owned.id,
        attemptNo: owned.attemptNo,
        messageId: claim.request.messageId,
        replyAttempt: owned.replyAttempt,
        sessionId: body.sessionId ?? null,
        voiceId: providerPayload.voiceId,
        voiceAuthority: providerPayload.voiceAuthority,
        systemVoiceSettingVersion:
          providerPayload.systemVoiceSettingVersion,
        characterVoiceProfileVersion:
          providerPayload.characterVoiceProfileVersion,
        tone: providerPayload.tone,
        delivery: providerPayload.delivery,
        durationMs,
        provider: providerPayload.providerKey,
        providerKey: storageKey,
        sceneVersion: body.sceneVersion ?? 0,
        scene: body.scene ?? null,
        sceneApplied: result.data.sceneApplied ?? !body.scene,
        sceneAdapter: result.data.sceneAdapter ?? "unreported",
        providerIdempotencyKey,
        costDreamcoins: cost,
        billingAuthority: billing,
        generationIntent: prewarming ? "automatic" : "requested",
        replacedAssetIds: staleAssetIds,
      });
      const assetAuthority = {
        url: `/api/v1/media/${mediaId}/content`,
        storageKey: storageKey,
        contentType: voiceContentType(storageKey),
        providerAssetId: storageKey,
        prompt: body.text.slice(0, 500),
        visibility: "private" as const,
        safetyStatus: "passed",
        metadata: mediaMetadata,
        deletedAt: null,
      };
      const created = reusableProviderAsset
        ? await tx.mediaAsset.update({
            where: { id: reusableProviderAsset.id },
            data: assetAuthority,
          })
        : await tx.mediaAsset.create({
            data: {
              id: mediaId,
              ownerId: user.id,
              characterId: character.id,
              type: "voice",
              ...assetAuthority,
            },
          });
      // A deleted clip can be restored from the same provider reservation.
      // Its original delivery receipt survives media deletion; neither its
      // Dreamcoins nor its included minutes belong to this delivery attempt.
      if (!previouslyDelivered) await tx.voiceUsageFact.create({
        data: {
          id: `voice_usage_${owned.id}_${owned.attemptNo}`,
          requestId: owned.id,
          attemptNo: owned.attemptNo,
          userId: user.id,
          characterId: character.id,
          mediaAssetId: created.id,
          // A previously rendered but undelivered clip can settle on this
          // attempt. Record its delivery/cost without counting synthesis twice.
          durationMs: providerUsageRecorded ? 0 : durationMs,
          costDreamcoins: cost,
          intent: body.intent,
        },
      });
      await tx.voiceClipRequest.update({
        where: { id: owned.id },
        data: {
          status: "succeeded",
          mediaAssetId: created.id,
          provider: voiceProvider.providerKey,
          providerRequestId: providerIdempotencyKey,
          errorCode: null,
          error: Prisma.DbNull,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
      if (callUtterance) {
        const usage = await tx.voiceUsageFact.aggregate({ where: { requestId: owned.id }, _sum: { durationMs: true, costDreamcoins: true } });
        await tx.voiceCallUtterance.updateMany({ where: { id: callUtterance.id, settledAt: null }, data: {
          status: "delivered", voiceRequestId: owned.id, mediaAssetId: created.id,
          durationMs: usage._sum.durationMs ?? 0, costDreamcoins: usage._sum.costDreamcoins ?? 0, settledAt: new Date(),
        } });
      }
      await onSuccessCommit?.(tx, {
        requestId: owned.id,
        attemptNo: owned.attemptNo,
        mediaAssetId: created.id,
        provider: voiceProvider.providerKey,
      });
      return { kind: "asset", asset: created } as const;
    });

    if (commit.kind !== "asset") {
      await deleteUndeliveredVoiceBlob(storageKey, claim.request.id);
    }
    if (commit.kind === "prewarm_skipped") {
      return ok(
        voicePrewarmSkipped(claim.request.messageId, "allowance_exhausted"),
      );
    }
    if (commit.kind === "quote_required") {
      throw Errors.conflict("Legacy Voice recovery requires the user's accepted quote before a paid delivery", { reason: "voice_quote_required" });
    }
    if (commit.kind === "payment_required") {
      throw Errors.paymentRequired("Insufficient dreamcoins", {
        balance: commit.balance,
        cost: overflowCost,
        required: overflowCost,
      });
    }
    if (commit.kind === "delivery_revoked") throw Errors.gone("Call ended, was interrupted, or reached its accepted budget before voice delivery");
    if (commit.kind === "reply_revoked") throw Errors.gone("This reply changed or its conversation is no longer active; no audio was delivered or charged");
    return ok(voiceClipResponse(commit.asset), { status: 201 });
  } catch (cause) {
    // INTENT: keep deterministic provider bytes when the transaction result is
    // ambiguous. Deleting here can corrupt a transaction that committed before
    // the connection failed; an unreferenced blob is safe to reap later.
    await failOwnedVoiceRequest(claim, "voice_commit_failed", cause).catch(
      (error) =>
        logger.error(
          { error, voiceClipRequestId: claim.request.id },
          "voice clip request failure could not be persisted",
        ),
    );
    throw cause;
  } finally {
    await releaseVoiceArtifactOwner(claim).catch(error => logger.error(
      { error, voiceClipRequestId: claim.request.id, leaseOwner: claim.leaseOwner },
      "voice artifact owner could not be released; account erasure remains pending",
    ));
  }
}

async function deleteUndeliveredVoiceBlob(key: string, requestId: string) {
  try {
    if (await prisma.mediaAsset.count({ where: { storageKey: key } })) return;
    const result = await providers.blob.delete({ key });
    if (!result.ok) {
      logger.error({ voiceClipRequestId: requestId, storageKey: key, error: result.error }, "undelivered voice blob cleanup failed");
      const request = await prisma.voiceClipRequest.findUnique({ where: { id: requestId }, select: { error: true } });
      if (request) await prisma.voiceClipRequest.updateMany({ where: { id: requestId, status: { in: ["failed", "skipped"] } }, data: {
        error: toInputJson({ ...jsonRecord(request.error), undeliveredBlobCleanup: { ...result.error, storageKey: key } }),
      } });
    }
  } catch (error) {
    logger.error(
      { error, voiceClipRequestId: requestId, storageKey: key },
      "undelivered voice blob cleanup failed",
    );
  }
}

type VoiceSynthesisBudgetDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "prewarm_skipped" }
  | { readonly kind: "payment_required"; readonly balance: number }
  | { readonly kind: "reply_revoked" }
  | { readonly kind: "wait" };

// SPEC: Provider execution is serialized per user until the preceding request
// records its immutable usage and charge. This closes the balance/allowance race
// without holding a database transaction open across a slow TTS call.
async function authorizeVoiceSynthesisTurn(input: {
  claim: Extract<VoiceRequestClaim, { kind: "owner" }>;
  userId: string;
  prewarming: boolean;
  entitlements: Record<string, Prisma.JsonValue>;
  overflowCost: number;
  maxCostDreamcoins: number;
  allowanceWindowStartsAt?: Date;
  providerKey: z.infer<typeof pinnedVoiceProviderPayloadSchema>["providerKey"];
  synthesisPayload: VoiceClipSynthesisPayload;
}): Promise<Exclude<VoiceSynthesisBudgetDecision, { kind: "wait" }>> {
  const deadline = Date.now() + voiceClipWaitMs(input.providerKey);
  while (Date.now() <= deadline) {
    const now = new Date();
    const decision = await prisma.$transaction(async (tx) => {
      const userActive = await lockUser(tx, input.userId);
      const replyDeliverable = userActive && await lockVoiceReplyAuthority(tx, input.claim.request, input.synthesisPayload);
      await lockVoiceRequest(tx, input.claim.request.id);
      const owned = await tx.voiceClipRequest.findUniqueOrThrow({
        where: { id: input.claim.request.id },
      });
      if (
        owned.status !== "running" ||
        owned.leaseOwner !== input.claim.leaseOwner ||
        owned.attemptNo !== input.claim.request.attemptNo
      ) {
        throw Errors.conflict("Voice clip request lease changed before synthesis", {
          requestId: owned.id,
          status: owned.status,
          attemptNo: owned.attemptNo,
        });
      }
      if (!replyDeliverable) {
        await tx.voiceClipRequest.update({ where: { id: owned.id }, data: {
          status: "failed", errorCode: userActive ? "voice_reply_delivery_revoked" : "voice_account_revoked", error: toInputJson({ reason: userActive ? "selected_reply_changed" : "account_inactive" }),
          leaseOwner: null, leaseExpiresAt: null, completedAt: now,
        } });
        return { kind: "reply_revoked" } as const;
      }

      const earlier = await tx.voiceClipRequest.findFirst({
        where: {
          userId: input.userId,
          id: { not: owned.id },
          status: "running",
          leaseOwner: { not: null },
          leaseExpiresAt: { gt: now },
          OR: [
            { startedAt: { lt: owned.startedAt } },
            { startedAt: owned.startedAt, id: { lt: owned.id } },
          ],
        },
        select: { id: true },
        orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      });
      if (earlier) {
        // Waiting for another message must not make this owner's lease appear
        // abandoned and allow a duplicate synthesis takeover.
        await tx.voiceClipRequest.update({
          where: { id: owned.id },
          data: {
            leaseExpiresAt: new Date(
              now.getTime() + voiceClipLeaseMs(input.providerKey),
            ),
          },
        });
        return { kind: "wait" } as const;
      }

      const hasCachedClip =
        (await tx.mediaAsset.count({
          where: voiceAssetWhere(owned),
        })) > 0 || await hasDeliveredVoiceUsage(owned.id, tx);
      const remainingMs = await voiceMinutesRemainingMs(
        input.userId,
        input.entitlements,
        tx,
        input.allowanceWindowStartsAt,
      );
      if (input.prewarming && !hasCachedClip && remainingMs <= 0) {
        await tx.voiceClipRequest.update({
          where: { id: owned.id },
          data: {
            status: "skipped",
            errorCode: "allowance_exhausted",
            error: toInputJson({ reason: "allowance_exhausted" }),
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: now,
          },
        });
        return { kind: "prewarm_skipped" } as const;
      }
      if (
        !input.prewarming &&
        !hasCachedClip &&
        input.overflowCost > 0 &&
        remainingMs <= 0
      ) {
        if (input.maxCostDreamcoins < input.overflowCost) {
          throw Errors.conflict("Voice synthesis exceeds the accepted cost", { reason: "voice_quote_limit_exceeded" });
        }
        const balance = await dreamcoinBalance(input.userId, tx);
        if (balance < input.overflowCost) {
          await tx.voiceClipRequest.update({
            where: { id: owned.id },
            data: {
              status: "failed",
              errorCode: "insufficient_dreamcoins",
              error: toInputJson({
                balance,
                cost: input.overflowCost,
                required: input.overflowCost,
              }),
              leaseOwner: null,
              leaseExpiresAt: null,
              completedAt: now,
            },
          });
          return { kind: "payment_required", balance } as const;
        }
      }
      return { kind: "proceed" } as const;
    });
    if (decision.kind !== "wait") return decision;
    await delay(VOICE_CLIP_POLL_MS);
  }
  await failOwnedVoiceRequest(
    input.claim,
    "voice_budget_turn_timeout",
    "Timed out waiting for an earlier voice request",
  );
  throw Errors.unavailable("Voice clip budget reservation is still in progress", {
    requestId: input.claim.request.id,
  });
}

async function claimVoiceRequest(input: {
  userId: string;
  characterId: string;
  messageId: string;
  replyAttempt: number;
  voiceCallUtteranceId?: string;
  requestFingerprint: string;
  synthesisPayload: VoiceClipSynthesisPayload;
  billingAuthority: VoiceClipBillingAuthority;
  providerPayload: z.infer<typeof pinnedVoiceProviderPayloadSchema>;
}): Promise<VoiceRequestClaim> {
  const requestId = voiceRequestId(input.userId, input.messageId, input.replyAttempt);
  const leaseOwner = randomUUID();
  const now = new Date();
  try {
    const created = await prisma.$transaction(async tx => {
      if (!await lockUser(tx, input.userId)) throw Errors.gone("Account is no longer active; no voice request was started");
      return tx.voiceClipRequest.create({
      data: {
        id: requestId,
        userId: input.userId,
        characterId: input.characterId,
        messageId: input.messageId,
        replyAttempt: input.replyAttempt,
        voiceCallUtteranceId: input.voiceCallUtteranceId,
        requestFingerprint: input.requestFingerprint,
        synthesisPayload: toInputJson(input.synthesisPayload),
        billingAuthority: toInputJson(input.billingAuthority),
        provider: input.providerPayload.providerKey,
        providerPayload: toInputJson(input.providerPayload),
        leaseOwner,
        leaseExpiresAt: new Date(
          now.getTime() + voiceClipLeaseMs(input.providerPayload.providerKey),
        ),
      },
      });
    });
    return { kind: "owner", request: created, leaseOwner };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  const deadline = Date.now() + voiceClipWaitMs(input.providerPayload.providerKey);
  while (Date.now() <= deadline) {
    const existing = await prisma.voiceClipRequest.findUniqueOrThrow({
      where: {
        userId_messageId_replyAttempt: {
          userId: input.userId,
          messageId: input.messageId,
          replyAttempt: input.replyAttempt,
        },
      },
      include: { mediaAsset: true },
    });
    if (
      existing.requestFingerprint !== input.requestFingerprint ||
      existing.characterId !== input.characterId
    ) {
      throw Errors.conflict(
        "Voice message id is bound to a different synthesis request",
        { requestId: existing.id, messageId: input.messageId },
      );
    }
    if (existing.errorCode === "provider_outcome_unknown") {
      throw Errors.conflict(
        "Voice provider outcome is unknown and automatic replay is forbidden",
        { requestId: existing.id, errorCode: existing.errorCode },
      );
    }
    if (
      existing.status === "succeeded" &&
      existing.mediaAsset &&
      existing.mediaAsset.deletedAt === null &&
      isCurrentVoiceClip(existing.mediaAsset)
    ) {
      return { kind: "replay", asset: existing.mediaAsset };
    }
    const claimNow = new Date();
    const hasActiveLease =
      existing.status === "running" &&
      existing.leaseOwner !== null &&
      existing.leaseExpiresAt !== null &&
      existing.leaseExpiresAt > claimNow;
    if (hasActiveLease) {
      await delay(VOICE_CLIP_POLL_MS);
      continue;
    }

    const nextLeaseOwner = randomUUID();
    const pinnedProviderKey = pinnedVoiceProviderPayloadSchema.parse(
      existing.providerPayload,
    ).providerKey;
    const existingBilling = storedVoiceBilling(existing);
    const keepExistingBilling = existingBilling &&
      (existingBilling.intent === "play" || input.synthesisPayload.intent === "prewarm");
    const claimed = await prisma.$transaction(async tx => {
      if (!await lockUser(tx, input.userId)) throw Errors.gone("Account is no longer active; the voice request was not resumed");
      return tx.voiceClipRequest.updateMany({
      where: {
        id: existing.id,
        status: existing.status,
        attemptNo: existing.attemptNo,
        ...(existing.status === "running"
          ? {
              OR: [
                { leaseOwner: null },
                { leaseExpiresAt: null },
                { leaseExpiresAt: { lte: claimNow } },
              ],
            }
          : {}),
      },
      data: {
        status: "running",
        attemptNo: existing.attemptNo + 1,
        synthesisPayload: toInputJson(existingBilling?.intent === "play" && input.synthesisPayload.intent === "prewarm"
          ? existing.synthesisPayload : input.synthesisPayload),
        ...(keepExistingBilling || (!existingBilling && input.synthesisPayload.intent === "prewarm")
          ? {} : { billingAuthority: toInputJson(input.billingAuthority) }),
        leaseOwner: nextLeaseOwner,
        leaseExpiresAt: new Date(
          claimNow.getTime() + voiceClipLeaseMs(pinnedProviderKey),
        ),
        mediaAssetId: null,
        errorCode: null,
        error: Prisma.DbNull,
        startedAt: claimNow,
        completedAt: null,
      },
      });
    });
    if (claimed.count === 1) {
      const request = await prisma.voiceClipRequest.findUniqueOrThrow({
        where: { id: existing.id },
      });
      return { kind: "owner", request, leaseOwner: nextLeaseOwner };
    }
  }
  throw Errors.unavailable("Voice clip generation is still in progress", {
    requestId,
  });
}

// SPEC: providerRequestId is the durable provider-invocation reservation. It is
//   set once, from null to the canonical provider idempotency key, inside the
//   lease check — so a second owner cannot start a parallel synthesis, and a
//   replay of the same key is recognised rather than re-billed.
// INVARIANT: a reservation that does not match the expected key is a conflict,
//   never a takeover.
async function reserveVoiceProviderInvocation(input: {
  readonly claim: Extract<VoiceRequestClaim, { kind: "owner" }>;
  readonly voiceProvider: VoiceClipPort;
  readonly providerIdempotencyKey: string;
}): Promise<"first_invocation" | "durable_replay"> {
  const reservation = await prisma.$transaction(async (tx) => {
    const userActive = await lockUser(tx, input.claim.request.userId);
    await lockVoiceRequest(tx, input.claim.request.id);
    const owned = await tx.voiceClipRequest.findUniqueOrThrow({
      where: { id: input.claim.request.id },
    });
    if (
      owned.status !== "running" ||
      owned.leaseOwner !== input.claim.leaseOwner ||
      owned.attemptNo !== input.claim.request.attemptNo
    ) {
      throw Errors.conflict(
        "Voice clip request lease changed before provider invocation",
        {
          requestId: owned.id,
          status: owned.status,
          attemptNo: owned.attemptNo,
        },
      );
    }
    if (!userActive) {
      await tx.voiceClipRequest.update({ where: { id: owned.id }, data: {
        status: "failed", errorCode: "voice_account_revoked", error: toInputJson({ reason: "account_inactive" }),
        leaseOwner: null, leaseExpiresAt: null, completedAt: new Date(),
      } });
      return "account_revoked" as const;
    }
    if (owned.providerRequestId) {
      if (owned.providerRequestId === input.providerIdempotencyKey) {
        return "durable_replay" as const;
      }
      throw Errors.conflict(
        "Voice provider invocation reservation does not match the request authority",
        { requestId: owned.id },
      );
    }
    await tx.voiceClipRequest.update({
      where: { id: owned.id },
      data: {
        provider: input.voiceProvider.providerKey,
        providerRequestId: input.providerIdempotencyKey,
      },
    });
    return "first_invocation" as const;
  });
  // Throw only after committing this owner's terminal state, otherwise the
  // account eraser would wait forever on a rolled-back running request.
  if (reservation === "account_revoked") throw Errors.gone("Account is no longer active; no voice provider was invoked");
  return reservation;
}

async function authorizeVoiceArtifactWrite(claim: Extract<VoiceRequestClaim, { kind: "owner" }>) {
  const rejection = await prisma.$transaction(async tx => {
    const userActive = await lockUser(tx, claim.request.userId);
    await lockVoiceRequest(tx, claim.request.id);
    const owned = await tx.voiceClipRequest.findUnique({ where: { id: claim.request.id } });
    if (!owned || owned.status !== "running" || owned.leaseOwner !== claim.leaseOwner || owned.attemptNo !== claim.request.attemptNo) {
      return "lease_changed" as const;
    }
    const leaseActive = owned.leaseExpiresAt !== null && owned.leaseExpiresAt > new Date();
    if (userActive && leaseActive) {
      await tx.voiceClipRequest.update({ where: { id: owned.id }, data: {
        activeArtifactOwners: [...new Set([...owned.activeArtifactOwners, claim.leaseOwner])],
      } });
      return null;
    }
    await tx.voiceClipRequest.update({ where: { id: owned.id }, data: {
      status: "failed", errorCode: userActive ? "voice_lease_expired" : "voice_account_revoked",
      error: toInputJson({ reason: userActive ? "lease_expired_before_upload" : "account_inactive" }),
      leaseOwner: null, leaseExpiresAt: null, completedAt: new Date(),
    } });
    return userActive ? "lease_expired" as const : "account_revoked" as const;
  });
  if (rejection === "account_revoked") throw Errors.gone("Account is no longer active; no voice artifact was uploaded or delivered");
  if (rejection) throw Errors.conflict("Voice clip request lease changed before artifact upload", { requestId: claim.request.id, reason: rejection });
}

async function releaseVoiceArtifactOwner(claim: Extract<VoiceRequestClaim, { kind: "owner" }>) {
  await prisma.$transaction(async tx => {
    // Cleanup is allowed for a deleted user: it proves this specific writer has
    // finished, without changing the winning lease owner or its delivery state.
    await lockUser(tx, claim.request.userId);
    await lockVoiceRequest(tx, claim.request.id);
    const request = await tx.voiceClipRequest.findUnique({ where: { id: claim.request.id }, select: { activeArtifactOwners: true } });
    if (!request?.activeArtifactOwners.includes(claim.leaseOwner)) return;
    await tx.voiceClipRequest.update({ where: { id: claim.request.id }, data: {
      activeArtifactOwners: request.activeArtifactOwners.filter(owner => owner !== claim.leaseOwner),
    } });
  });
}

async function failOwnedVoiceRequest(
  claim: Extract<VoiceRequestClaim, { kind: "owner" }>,
  errorCode: string,
  error: unknown,
) {
  await prisma.voiceClipRequest.updateMany({
    where: {
      id: claim.request.id,
      status: "running",
      attemptNo: claim.request.attemptNo,
      leaseOwner: claim.leaseOwner,
    },
    data: {
      status: "failed",
      errorCode,
      error: toInputJson({
        code: errorCode,
        message: error instanceof Error ? error.message : String(error),
      }),
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
    },
  });
}

// INVARIANT: plan minutes count only clips the allowance covered. A clip paid
// in coins (free tier, or overflow) never also consumes plan minutes.
export async function voiceMinutesRemainingMs(
  userId: string,
  entitlements: Record<string, Prisma.JsonValue>,
  db: Prisma.TransactionClient | typeof prisma = prisma,
  windowStartsAt?: Date,
) {
  const allowanceMinutes =
    typeof entitlements.voice_minutes === "number"
      ? entitlements.voice_minutes
      : 0;
  if (allowanceMinutes <= 0) return 0;
  const since = windowStartsAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  // Provider execution and user delivery are different immutable receipts. A
  // failed/prewarm-revoked execution never spends minutes; a later same-key
  // delivery has duration 0 to avoid recounting provider work. Count the
  // request's original duration only when its free delivery is in this window,
  // and exclude the whole request if a later delivery was paid in coins.
  const usage = await db.voiceUsageFact.aggregate({
    where: { userId, request: { AND: [
      { usageFacts: { some: { userId, occurredAt: { gte: since }, mediaAssetId: { not: null }, costDreamcoins: 0 } } },
      { usageFacts: { none: { costDreamcoins: { gt: 0 } } } },
    ] } },
    _sum: { durationMs: true },
  });
  return Math.max(
    0,
    allowanceMinutes * 60_000 - (usage._sum.durationMs ?? 0),
  );
}

async function hasDeliveredVoiceUsage(
  requestId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return (await db.voiceUsageFact.count({
    where: {
      requestId,
      OR: [{ mediaAssetId: { not: null } }, { costDreamcoins: { gt: 0 } }],
    },
  })) > 0;
}

function voiceAssetWhere(request: Pick<VoiceClipRequest, "id" | "userId" | "messageId" | "replyAttempt">): Prisma.MediaAssetWhereInput {
  return {
    ownerId: request.userId,
    type: "voice",
    deletedAt: null,
    OR: [
      { metadata: { path: ["requestId"], equals: request.id } },
      // Pre-ledger clips have no request ID. They can only restore the original
      // reply; never waive payment for a later regenerated or edited version.
      ...(request.replyAttempt === 1 ? [{ AND: [
        { metadata: { path: ["messageId"], equals: request.messageId } },
        { metadata: { path: ["requestId"], equals: Prisma.DbNull } },
      ] }] : []),
    ],
  };
}

// SPEC: selected reply attempt is part of the product request identity.
function voiceRequestId(userId: string, messageId: string, replyAttempt: number) {
  const hash = createHash("sha256")
    .update(`${userId}\u0000${messageId}\u0000${replyAttempt}`)
    .digest("hex");
  return `voice_clip_request_${hash}`;
}

function legacyVoiceRequestId(userId: string, messageId: string) {
  const hash = createHash("sha256")
    .update(`${userId}\u0000${messageId}`)
    .digest("hex");
  return `voice_clip_request_${hash}`;
}

function voiceClipLeaseMs(
  providerKey: z.infer<typeof pinnedVoiceProviderPayloadSchema>["providerKey"],
) {
  const providerTimeout =
    providerKey === "fish_audio"
      ? env.FISH_AUDIO_TIMEOUT_MS
      : providerKey === "pocket_tts"
        ? env.POCKET_TTS_TIMEOUT_MS
        : 30_000;
  return providerTimeout + 30_000;
}

// SPEC: how long a second caller waits for the current lease holder before
//   giving up, derived from that provider's own lease.
// INTENT: this used to be a flat `VOICE_CLIP_WAIT_MS = 220_000`, which was
//   SHORTER than the fish_audio lease (FISH_AUDIO_TIMEOUT_MS=240s + 30s = 270s):
//   a concurrent request on that route always timed out ~50s before the lease it
//   was waiting on could possibly expire. Deriving it removes the pair of
//   literals that had to agree.
// INVARIANT: strictly greater than the lease, so the waiter outlives it.
function voiceClipWaitMs(
  providerKey: z.infer<typeof pinnedVoiceProviderPayloadSchema>["providerKey"],
) {
  return voiceClipLeaseMs(providerKey) + 10_000;
}

function resolvePinnedVoiceProvider(
  providerKey: z.infer<typeof pinnedVoiceProviderPayloadSchema>["providerKey"],
): VoiceClipPort {
  return providers.voice.clip.providerKey === providerKey
    ? providers.voice.clip
    : createVoiceClipPortForKey(providerKey);
}

export function characterVoiceTone(character: {
  name: string;
  style: string;
}) {
  return `Speak as ${character.name}. Warm, expressive ${character.style} delivery consistent with the Character Soul.`;
}

function voiceClipResponse(asset: {
  id: string;
  url: string;
  metadata: Prisma.JsonValue;
}) {
  const metadata = jsonRecord(asset.metadata);
  return {
    assetId: asset.id,
    contentUrl: asset.url,
    durationMs:
      typeof metadata.durationMs === "number" ? metadata.durationMs : 0,
    messageId:
      typeof metadata.messageId === "string" ? metadata.messageId : null,
  };
}

function voicePrewarmSkipped(
  messageId: string,
  reason: "allowance_exhausted" | "disabled" | "not_entitled" | "play_required",
) {
  return { messageId, prewarmed: false as const, reason };
}

async function deliverableVoiceAudio(body: Uint8Array, contentType: string) {
  if (!audioFileExtension(contentType).endsWith(".wav")) return { body, contentType };
  const mp3 = await encodeVoiceClipMp3(body, { ffmpegBin: env.VOICE_FFMPEG_BIN });
  if (mp3) return { body: mp3, contentType: "audio/mpeg" };
  logger.warn({ bytes: body.byteLength }, "Voice clip MP3 encoding failed; delivering WAV");
  return { body, contentType };
}

function voiceContentType(key: string) {
  const ext = key.split(".").pop()?.toLowerCase();
  const byExt: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    webm: "audio/webm",
  };
  return (ext && byExt[ext]) ?? "audio/mpeg";
}

function isCurrentVoiceClip(asset: { metadata: Prisma.JsonValue }) {
  return jsonRecord(asset.metadata).cacheVersion === VOICE_CLIP_CACHE_VERSION;
}

function jsonRecord(value: Prisma.JsonValue) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : {};
}

async function featureFlagEnabled(key: string) {
  const flag = await prisma.featureFlag.findUnique({
    where: { key },
    select: { enabled: true, rolloutPercent: true },
  });
  return flag?.enabled === true && flag.rolloutPercent === 100;
}

async function lockVoiceRequest(
  tx: Prisma.TransactionClient,
  requestId: string,
) {
  await tx.$queryRaw`SELECT id FROM "voice_clip_requests" WHERE id = ${requestId} FOR UPDATE`;
}

async function lockUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true, deletedAt: true } });
  return user?.status === "active" && user.deletedAt === null;
}

// Caller holds User. The shared Chat scope holds the conversation and reply
// locks until settlement, so edit/regenerate/delete and Voice delivery choose
// one ordering. Opening messages are Session snapshots without a ChatTurn row.
async function lockVoiceReplyAuthority(
  tx: Prisma.TransactionClient,
  request: Pick<VoiceClipRequest, "userId" | "characterId" | "messageId" | "replyAttempt">,
  payload: VoiceClipSynthesisPayload,
): Promise<boolean> {
  if (!payload.sessionId) return false;
  const opening = request.messageId === `opening:${payload.sessionId}`;
  const observedTurn = opening ? null : await tx.chatTurn.findFirst({
    where: { sessionId: payload.sessionId, assistantMessageId: request.messageId, session: { userId: request.userId } },
    select: { id: true },
  });
  if (!opening && !observedTurn) return false;
  let scope;
  try {
    scope = await lockChatScope(tx, {
      userId: request.userId,
      at: observedTurn ? { turn: observedTurn.id } : { session: payload.sessionId },
      expect: { characterId: request.characterId },
    });
  } catch (error) {
    if (error instanceof AppError &&
      (error.code === "not_found" || error.code === "gone" || error.code === "conflict")) return false;
    throw error;
  }
  const { session, group, turn } = scope;
  if (session.sessionId !== payload.sessionId || session.status !== "active" || (group && group.status !== "active")) return false;
  if (opening) {
    return request.replyAttempt === 1 && session.openingMessage?.trim() === payload.text &&
      (payload.sceneVersion ?? 0) === 0 && (payload.scene ?? null) === null;
  }
  return Boolean(turn && turn.assistantMessageId === request.messageId &&
    turn.assistantStatus === "sent" && turn.attempt === request.replyAttempt &&
    turn.assistantContent.trim() === payload.text && turn.sceneVersion === (payload.sceneVersion ?? 0) &&
    canonicalJsonHash(turn.scene ?? null) === canonicalJsonHash(payload.scene ?? null));
}

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
