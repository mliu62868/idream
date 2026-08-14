import { createHash, randomUUID } from "node:crypto";
import { Prisma, type MediaAsset, type VoiceClipRequest } from "@prisma/client";
import { z } from "zod";
import { fishAudioDeliverySettingsSchema } from "@idream/shared/admin";
import {
  getAuthCtx,
  requireAgeGate,
  requireAgeVerified,
  requireUser,
} from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { env } from "@/server/lib/env";
import { generationCostDreamcoins } from "@/server/lib/generation-pricing";
import { ok } from "@/server/lib/http";
import { logger } from "@/server/lib/logger";
import { dreamcoinBalance, postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { canonicalJsonHash } from "@/server/modules/admin-v2/shared/idempotency";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { resolveCharacterVoiceAuthority } from "@/server/modules/voice-defaults";
import { providers } from "@/server/providers";
import {
  VOICE_PROVIDER_REPLAY,
  type VoiceClipPort,
} from "@/server/providers/types";
import { createVoiceClipPortForKey } from "@/server/providers/voice/factory";
import {
  fetchChatMessageVoiceAuthority,
  type ChatMessageVoiceAuthority,
} from "@/server/bff/chat-proxy";

const voiceClipSchema = z.object({
  characterId: z.string().min(1),
  messageId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  text: z.string().trim().min(1).max(2_000),
  intent: z.enum(["play", "prewarm"]).default("play"),
});

export const voiceClipSynthesisPayloadSchema = z
  .object({
    version: z.literal(1),
    text: z.string().trim().min(1).max(2_000),
    sessionId: z.string().min(1).nullable(),
    intent: z.enum(["play", "prewarm"]),
    sceneVersion: z.number().int().nonnegative().optional(),
    scene: z.object({
      schemaVersion: z.literal(1),
      version: z.number().int().nonnegative(),
      location: z.string().nullable(),
      time: z.string().nullable(),
      participants: z.array(z.string()),
      emotionalBeat: z.string().nullable(),
      unresolvedThreads: z.array(z.string()),
    }).strict().nullable().optional(),
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
    providerKey: z.enum(["mock", "pipeline", "pocket_tts", "fish_audio"]),
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
const VOICE_CLIP_WAIT_MS = 220_000;
const VOICE_CLIP_POLL_MS = 25;

type VoiceCharacter = {
  id: string;
  age: number;
  name: string;
  style: string;
  relationship: string | null;
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

export async function createVoiceClip(
  request: Request,
  deps: VoiceClipDependencies,
) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = voiceClipSchema.parse(await request.json());
  const messageAuthority = body.sessionId
    ? await (deps.messageVoiceAuthority ?? fetchChatMessageVoiceAuthority)(request, {
        sessionId: body.sessionId,
        messageId: body.messageId,
        testOnlyText: body.text,
        characterId: body.characterId,
      }).catch((cause) => {
        throw Errors.unavailable("Chat message authority is unavailable for Voice", {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      })
    : null;
  if (messageAuthority && messageAuthority.characterId !== body.characterId) {
    throw Errors.conflict("Voice message belongs to another Character");
  }
  const authoritativeText = messageAuthority?.text ?? body.text;
  const authoritativeScene = messageAuthority?.scene ?? null;
  const synthesisPayload = voiceClipSynthesisPayloadSchema.parse({
    version: 1,
    text: authoritativeText,
    sessionId: body.sessionId ?? null,
    intent: body.intent,
    sceneVersion: messageAuthority?.sceneVersion ?? 0,
    scene: authoritativeScene,
  });
  const prewarming = body.intent === "prewarm";

  if (!(await featureFlagEnabled("voice_gen"))) {
    if (prewarming) return ok(voicePrewarmSkipped(body.messageId, "disabled"));
    throw Errors.forbidden("Voice generation is disabled");
  }

  const entitlements = await deps.entitlementMap(user.id);
  if (entitlements.voice_enabled !== true) {
    if (prewarming) return ok(voicePrewarmSkipped(body.messageId, "not_entitled"));
    throw Errors.paymentRequired(
      "Voice playback requires a plan with voice enabled",
      { entitlement: "voice_enabled" },
    );
  }

  const character = await deps.readableCharacter(body.characterId, user.id);
  if (character.age < 18) {
    throw Errors.badRequest("Character is not eligible for voice", {
      policyCode: "UNDERAGE",
    });
  }

  const overflowCost = await generationCostDreamcoins("voice", 1, 1);
  const remainingBeforeSynthesis = await voiceMinutesRemainingMs(
    user.id,
    entitlements,
  );
  const staleAssets = await voiceAssetsForMessage(user.id, body.messageId);
  const hasStaleCachedClip = staleAssets.length > 0;
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

  const voiceAuthority = await resolveCharacterVoiceAuthority({
    characterId: character.id,
    voiceId: character.voiceId,
    gender: character.gender,
  });
  const proposedProviderPayload = pinnedVoiceProviderPayloadSchema.parse({
    providerKey: providers.voice.clip.providerKey,
    voiceId: voiceAuthority.voiceId,
    voiceAuthority: voiceAuthority.source,
    systemVoiceSettingVersion: voiceAuthority.settingVersion,
    characterVoiceProfileVersion: voiceAuthority.characterVoiceProfileVersion,
    tone: characterVoiceTone(character),
    delivery: voiceAuthority.delivery,
  });
  const requestFingerprint = canonicalJsonHash({
    schemaVersion: "voice-clip-request-v1",
    userId: user.id,
    characterId: character.id,
    messageId: body.messageId,
    sessionId: body.sessionId ?? null,
    text: authoritativeText,
    sceneVersion: messageAuthority?.sceneVersion ?? 0,
    scene: authoritativeScene,
  });
  const claim = await claimVoiceRequest({
    userId: user.id,
    characterId: character.id,
    messageId: body.messageId,
    requestFingerprint,
    synthesisPayload,
    providerPayload: proposedProviderPayload,
  });
  if (claim.kind === "replay") {
    return ok(voiceClipResponse(claim.asset));
  }
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
  if (
    VOICE_PROVIDER_REPLAY[providerPayload.data.providerKey] !==
    "durable_same_key"
  ) {
    throw Errors.conflict(
      "Voice clip provider cannot safely replay an expired operator reclaim",
      {
        requestId: existing.id,
        provider: providerPayload.data.providerKey,
        reason: "provider_not_durably_replayable",
      },
    );
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
  if (
    voiceProvider.providerKey !== providerPayload.data.providerKey ||
    voiceProvider.providerReplay !== "durable_same_key"
  ) {
    throw Errors.conflict(
      "The pinned Voice adapter does not provide durable same-key replay",
      {
        requestId: existing.id,
        pinnedProvider: providerPayload.data.providerKey,
        adapterProvider: voiceProvider.providerKey,
        adapterReplay: voiceProvider.providerReplay,
        reason: "provider_adapter_not_durably_replayable",
      },
    );
  }
  if (!(await featureFlagEnabled("voice_gen"))) {
    throw Errors.conflict("Voice generation is disabled; the request was not reclaimed");
  }
  const entitlements = await input.deps.entitlementMap(existing.userId);
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
  const claimed = await prisma.voiceClipRequest.updateMany({
    where: {
      id: existing.id,
      characterId: input.characterId,
      status: "running",
      attemptNo: existing.attemptNo,
      leaseOwner: existing.leaseOwner,
      leaseExpiresAt: existing.leaseExpiresAt,
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
    overflowCost: await generationCostDreamcoins("voice", 1, 1),
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
    entitlements,
    overflowCost,
    onSuccessCommit,
  } = input;

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
    messageId: claim.request.messageId,
    prewarming,
    entitlements,
    overflowCost,
    providerKey: providerPayload.providerKey,
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
  // INVARIANT: one logical message keeps one provider key across lease expiry,
  // process restart, and transport ambiguity. attemptNo remains telemetry only.
  const providerIdempotencyKey =
    voiceProvider.providerReplay === "durable_same_key"
      ? `voice:${claim.request.id}:provider`
      : `voice:${claim.request.id}:attempt:${claim.request.attemptNo}:provider`;
  const invocation = await reserveVoiceProviderInvocation({
    claim,
    voiceProvider,
    providerIdempotencyKey,
  });
  if (invocation === "blocked_non_replayable") {
    throw Errors.conflict(
      "Voice provider outcome is unknown and this provider cannot be replayed",
      {
        requestId: claim.request.id,
        provider: voiceProvider.providerKey,
        errorCode: "provider_outcome_unknown",
      },
    );
  }
  let result: Awaited<ReturnType<VoiceClipPort["synthesize"]>>;
  try {
    result = await voiceProvider.synthesize({
      requestId: claim.request.id,
      attemptNo: claim.request.attemptNo,
      idempotencyKey: providerIdempotencyKey,
      text: body.text,
      voiceId: providerPayload.voiceId,
      tone: providerPayload.tone,
      delivery: providerPayload.delivery,
      scene: body.scene ?? null,
    });
  } catch (cause) {
    if (voiceProvider.providerReplay === "non_replayable") {
      await failOwnedVoiceRequest(
        claim,
        "provider_outcome_unknown",
        cause,
      );
      throw Errors.unavailable(
        "Voice provider connection ended after invocation; outcome is unknown",
        {
          requestId: claim.request.id,
          provider: voiceProvider.providerKey,
          errorCode: "provider_outcome_unknown",
        },
      );
    }
    throw cause;
  }
  if (!result.ok) {
    const ambiguousProviderOutcome =
      voiceProvider.providerReplay === "non_replayable" &&
      result.error.retryable &&
      result.error.code !== "voice_rate_limited";
    const errorCode = ambiguousProviderOutcome
      ? "provider_outcome_unknown"
      : result.error.code;
    await failOwnedVoiceRequest(claim, errorCode, result.error, {
      releaseProviderReservation:
        voiceProvider.providerReplay === "non_replayable" &&
        !ambiguousProviderOutcome,
    });
    throw Errors.internal("Voice synthesis failed", result.error);
  }

  const proposedMediaId = `media_voice_${randomUUID()}`;
  try {
    const commit = await prisma.$transaction(async (tx) => {
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

      await lockUser(tx, user.id);
      const activeStaleAssets = await tx.mediaAsset.findMany({
        where: voiceAssetWhere(user.id, claim.request.messageId),
        orderBy: { createdAt: "desc" },
      });
      const staleAssetIds = activeStaleAssets.map((asset) => asset.id);
      const reusableProviderAsset = await tx.mediaAsset.findUnique({
        where: { storageKey: result.data.key },
      });
      if (
        reusableProviderAsset &&
        (reusableProviderAsset.ownerId !== user.id ||
          reusableProviderAsset.characterId !== character.id ||
          reusableProviderAsset.type !== "voice")
      ) {
        throw Errors.conflict(
          "Voice provider artifact key is already bound to another authority",
          { requestId: owned.id, storageKey: result.data.key },
        );
      }
      const mediaId = reusableProviderAsset?.id ?? proposedMediaId;
      const durationMs = Math.max(0, result.data.durationMs);
      const remainingMs = await voiceMinutesRemainingMs(
        user.id,
        entitlements,
        tx,
      );
      const cost =
        staleAssetIds.length > 0 || remainingMs >= durationMs
          ? 0
          : overflowCost;
      if (prewarming && cost > 0) {
        // INVARIANT: provider execution is an immutable usage fact even when
        // automatic delivery loses the allowance race. It must not become a
        // billable or user-visible clip after that decision.
        await tx.voiceClipRequest.update({
          where: { id: owned.id },
          data: {
            status: "skipped",
            provider: voiceProvider.providerKey,
            providerRequestId: providerIdempotencyKey,
            errorCode: "allowance_exhausted",
            error: toInputJson({ reason: "allowance_exhausted" }),
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
          },
        });
        await tx.voiceUsageFact.create({
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
        return { kind: "prewarm_skipped" } as const;
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
                providerKey: result.data.key,
                durationMs,
              }),
              leaseOwner: null,
              leaseExpiresAt: null,
              completedAt: new Date(),
            },
          });
          await tx.voiceUsageFact.create({
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
        providerKey: result.data.key,
        sceneVersion: body.sceneVersion ?? 0,
        scene: body.scene ?? null,
        sceneApplied: result.data.sceneApplied ?? !body.scene,
        sceneAdapter: result.data.sceneAdapter ?? "unreported",
        providerIdempotencyKey,
        costDreamcoins: cost,
        generationIntent: prewarming ? "automatic" : "requested",
        replacedAssetIds: staleAssetIds,
      });
      const assetAuthority = {
        url: `/api/v1/media/${mediaId}/content`,
        storageKey: result.data.key,
        contentType: voiceContentType(result.data.key),
        providerAssetId: result.data.key,
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
      await tx.voiceUsageFact.create({
        data: {
          id: `voice_usage_${owned.id}_${owned.attemptNo}`,
          requestId: owned.id,
          attemptNo: owned.attemptNo,
          userId: user.id,
          characterId: character.id,
          mediaAssetId: created.id,
          durationMs,
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
      await onSuccessCommit?.(tx, {
        requestId: owned.id,
        attemptNo: owned.attemptNo,
        mediaAssetId: created.id,
        provider: voiceProvider.providerKey,
      });
      return { kind: "asset", asset: created } as const;
    });

    if (commit.kind !== "asset") {
      await deleteUndeliveredVoiceBlob(result.data.key, claim.request.id);
    }
    if (commit.kind === "prewarm_skipped") {
      return ok(
        voicePrewarmSkipped(claim.request.messageId, "allowance_exhausted"),
      );
    }
    if (commit.kind === "payment_required") {
      throw Errors.paymentRequired("Insufficient dreamcoins", {
        balance: commit.balance,
        cost: overflowCost,
        required: overflowCost,
      });
    }
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
  }
}

async function deleteUndeliveredVoiceBlob(key: string, requestId: string) {
  try {
    if (await prisma.mediaAsset.count({ where: { storageKey: key } })) return;
    await providers.blob.delete({ key });
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
  | { readonly kind: "wait" };

// SPEC: Provider execution is serialized per user until the preceding request
// records its immutable usage and charge. This closes the balance/allowance race
// without holding a database transaction open across a slow TTS call.
async function authorizeVoiceSynthesisTurn(input: {
  claim: Extract<VoiceRequestClaim, { kind: "owner" }>;
  userId: string;
  messageId: string;
  prewarming: boolean;
  entitlements: Record<string, Prisma.JsonValue>;
  overflowCost: number;
  providerKey: z.infer<typeof pinnedVoiceProviderPayloadSchema>["providerKey"];
}): Promise<Exclude<VoiceSynthesisBudgetDecision, { kind: "wait" }>> {
  const deadline = Date.now() + VOICE_CLIP_WAIT_MS;
  while (Date.now() <= deadline) {
    const now = new Date();
    const decision = await prisma.$transaction(async (tx) => {
      await lockUser(tx, input.userId);
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
          where: voiceAssetWhere(input.userId, input.messageId),
        })) > 0;
      const remainingMs = await voiceMinutesRemainingMs(
        input.userId,
        input.entitlements,
        tx,
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
  requestFingerprint: string;
  synthesisPayload: VoiceClipSynthesisPayload;
  providerPayload: z.infer<typeof pinnedVoiceProviderPayloadSchema>;
}): Promise<VoiceRequestClaim> {
  const requestId = voiceRequestId(input.userId, input.messageId);
  const leaseOwner = randomUUID();
  const now = new Date();
  try {
    const created = await prisma.voiceClipRequest.create({
      data: {
        id: requestId,
        userId: input.userId,
        characterId: input.characterId,
        messageId: input.messageId,
        requestFingerprint: input.requestFingerprint,
        synthesisPayload: toInputJson(input.synthesisPayload),
        provider: input.providerPayload.providerKey,
        providerPayload: toInputJson(input.providerPayload),
        leaseOwner,
        leaseExpiresAt: new Date(
          now.getTime() + voiceClipLeaseMs(input.providerPayload.providerKey),
        ),
      },
    });
    return { kind: "owner", request: created, leaseOwner };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  const deadline = Date.now() + VOICE_CLIP_WAIT_MS;
  while (Date.now() <= deadline) {
    const existing = await prisma.voiceClipRequest.findUniqueOrThrow({
      where: {
        userId_messageId: {
          userId: input.userId,
          messageId: input.messageId,
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
    const existingPinnedProvider = pinnedVoiceProviderPayloadSchema.safeParse(
      existing.providerPayload,
    );
    if (
      existing.status !== "running" &&
      existing.providerRequestId &&
      existingPinnedProvider.success &&
      VOICE_PROVIDER_REPLAY[existingPinnedProvider.data.providerKey] ===
        "non_replayable"
    ) {
      throw Errors.conflict(
        "The pinned Voice provider does not permit automatic replay",
        {
          requestId: existing.id,
          provider: existingPinnedProvider.data.providerKey,
          errorCode: existing.errorCode,
        },
      );
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
    const claimed = await prisma.voiceClipRequest.updateMany({
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
        synthesisPayload: toInputJson(input.synthesisPayload),
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

// INVARIANT: providerRequestId is the durable provider-invocation reservation.
// A non-replayable adapter may cross the network only when this transaction
// changes it from null to the canonical provider idempotency key.
async function reserveVoiceProviderInvocation(input: {
  readonly claim: Extract<VoiceRequestClaim, { kind: "owner" }>;
  readonly voiceProvider: VoiceClipPort;
  readonly providerIdempotencyKey: string;
}): Promise<"first_invocation" | "durable_replay" | "blocked_non_replayable"> {
  return prisma.$transaction(async (tx) => {
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
    if (owned.providerRequestId) {
      if (
        input.voiceProvider.providerReplay === "durable_same_key" &&
        owned.providerRequestId === input.providerIdempotencyKey
      ) {
        return "durable_replay" as const;
      }
      if (input.voiceProvider.providerReplay === "durable_same_key") {
        throw Errors.conflict(
          "Voice provider invocation reservation does not match the request authority",
          { requestId: owned.id },
        );
      }
      await tx.voiceClipRequest.update({
        where: { id: owned.id },
        data: {
          status: "failed",
          errorCode: "provider_outcome_unknown",
          error: toInputJson({
            code: "provider_outcome_unknown",
            provider: input.voiceProvider.providerKey,
            providerIdempotencyKey: owned.providerRequestId,
            blockedTakeoverKey: input.providerIdempotencyKey,
            reason: "non_replayable_provider_invocation_already_reserved",
          }),
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
      return "blocked_non_replayable" as const;
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
}

async function failOwnedVoiceRequest(
  claim: Extract<VoiceRequestClaim, { kind: "owner" }>,
  errorCode: string,
  error: unknown,
  options: { readonly releaseProviderReservation?: boolean } = {},
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
      ...(options.releaseProviderReservation
        ? { providerRequestId: null }
        : {}),
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

async function voiceMinutesRemainingMs(
  userId: string,
  entitlements: Record<string, Prisma.JsonValue>,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const allowanceMinutes =
    typeof entitlements.voice_minutes === "number"
      ? entitlements.voice_minutes
      : 0;
  if (allowanceMinutes <= 0) return 0;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  const usage = await db.voiceUsageFact.aggregate({
    where: { userId, occurredAt: { gte: since } },
    _sum: { durationMs: true },
  });
  return Math.max(
    0,
    allowanceMinutes * 60_000 - (usage._sum.durationMs ?? 0),
  );
}

function voiceAssetsForMessage(userId: string, messageId: string) {
  return prisma.mediaAsset.findMany({
    where: voiceAssetWhere(userId, messageId),
    orderBy: { createdAt: "desc" },
  });
}

function voiceAssetWhere(
  userId: string,
  messageId: string,
): Prisma.MediaAssetWhereInput {
  return {
    ownerId: userId,
    type: "voice",
    deletedAt: null,
    metadata: { path: ["messageId"], equals: messageId },
  };
}

function voiceRequestId(userId: string, messageId: string) {
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
        : providerKey === "pipeline"
          ? env.PIPELINE_VOICE_TIMEOUT_MS
          : 30_000;
  return providerTimeout + 30_000;
}

function resolvePinnedVoiceProvider(
  providerKey: z.infer<typeof pinnedVoiceProviderPayloadSchema>["providerKey"],
): VoiceClipPort {
  return providers.voice.clip.providerKey === providerKey
    ? providers.voice.clip
    : createVoiceClipPortForKey(providerKey, providers.blob);
}

function characterVoiceTone(character: {
  name: string;
  style: string;
  relationship: string | null;
}) {
  const relationship = character.relationship?.trim();
  const persona = relationship
    ? `the user's ${relationship}`
    : "a close companion";
  return `Speak as ${character.name}, ${persona}. Warm, intimate, expressive ${character.style} delivery.`;
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
  reason: "allowance_exhausted" | "disabled" | "not_entitled",
) {
  return { messageId, prewarmed: false as const, reason };
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
