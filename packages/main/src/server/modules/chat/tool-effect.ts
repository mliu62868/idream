import { createHash } from "node:crypto";
import {
  parseImageAgentToolCall,
  type ImageAgentToolCall,
} from "@idream/shared/chat/image-action";
import {
  chatToolEffectSchema,
  type ChatToolEffect,
} from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { findReusableChatImage } from "@/server/modules/ourdream/chat-image-reuse";
import { sanitizeChatImageDirection } from "@/server/modules/ourdream/generation-prompt";
import { createChatImageGenerationJob } from "@/server/modules/ourdream/service";
import { loadChatAuthoritySnapshot } from "./chat-authority-snapshot";
import { chatTurnForEffect } from "./turn-ledger";

export type ChatToolEffectResult =
  | {
      accepted: true;
      duplicate: boolean;
      attachmentId: string;
      status: "accepted" | "completed";
      generationJobId: string | null;
      mediaAssetId: string | null;
      costDreamcoins: number;
    }
  | {
      accepted: false;
      duplicate: boolean;
      attachmentId: string;
      error: { code: string; message: string; retryable: boolean };
    };

/**
 * Main-owned product effect. Reserving generation and debiting its wallet are
 * one existing Generation Request operation; Chat only receives the durable ACK.
 */
export async function applyChatToolEffect(raw: unknown): Promise<ChatToolEffectResult> {
  const effect = chatToolEffectSchema.parse(raw);
  const requestDigest = sha256(JSON.stringify(canonical({
    name: effect.name,
    arguments: effect.arguments,
  })));
  const attachmentId = effectAttachmentId(effect);
  let prior = await prisma.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
  // INVARIANT: an accepted effect remains replayable after its Turn becomes
  // terminal. HTTP timeout must not turn a successful reservation into a 409.
  if (prior && prior.status !== "requesting") {
    if (effect.effectScope === "attempt") assertEffectRequest(prior, requestDigest);
    else assertTurnActionIntent(prior, effect.intent);
    if (effect.effectScope === "turn_action" && effectAttempt(prior.metadata) !== effect.attempt) {
      const current = await chatTurnForEffect(effect.turnId);
      if (
        current.attempt !== effect.attempt ||
        !["pending", "generating"].includes(current.assistantStatus)
      ) {
        throw Errors.conflict("Required effect replay does not belong to the active Chat attempt");
      }
      prior = await rebindTurnActionAttempt(prior, effect.attempt, requestDigest);
    }
    return existingEffect(prior, requestDigest, effect.effectScope);
  }

  const turn = await chatTurnForEffect(effect.turnId);
  if (turn.attempt !== effect.attempt || !["pending", "generating"].includes(turn.assistantStatus)) {
    throw Errors.conflict("Tool effect does not belong to the active Chat attempt");
  }
  const parsedCall = parseImageAgentToolCall(effect.name, effect.arguments);
  if (!parsedCall) throw Errors.badRequest("Invalid image tool arguments");
  let call = sceneOwnedCall(parsedCall);
  if (!turn.characterContentVersionId) {
    throw Errors.gone("Chat Turn has no immutable Character content pin");
  }
  const authority = await loadChatAuthoritySnapshot(turn.session.userId, {
    characterId: turn.session.characterId,
    contentVersionId: turn.characterContentVersionId,
    releaseId: turn.characterReleaseId,
    visualProfileId: turn.characterVisualProfileId,
    visualProfileVersion: turn.characterVisualProfileVersion,
  });
  if (
    !authority.entitlement.imageToolEnabled ||
    authority.character?.imageToolEnabled !== true
  ) {
    throw Errors.forbidden("Image generation is unavailable for this Chat");
  }

  if (prior) {
    if (effect.effectScope === "attempt") assertEffectRequest(prior, requestDigest);
    else {
      assertTurnActionIntent(prior, effect.intent);
      call = persistedTurnActionCall(prior, call);
    }
  } else {
    try {
      await prisma.chatTurnAttachment.create({
        data: {
          id: attachmentId,
          turnId: turn.id,
          kind: "generated_image",
          status: "requesting",
          promptHint: promptHint(call),
          metadata: toJson({
            attempt: effect.attempt,
            effect: {
              turnId: effect.turnId,
              attempt: effect.attempt,
              callId: effect.callId,
              name: effect.name,
              effectScope: effect.effectScope,
              intent: effect.intent,
              requestDigest,
            },
            request: effectRequestSnapshot(call),
          }),
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
      const raced = await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: attachmentId } });
      if (effect.effectScope === "attempt") assertEffectRequest(raced, requestDigest);
      else {
        assertTurnActionIntent(raced, effect.intent);
        call = persistedTurnActionCall(raced, call);
      }
      if (raced.status !== "requesting") {
        return existingEffect(raced, requestDigest, effect.effectScope);
      }
      prior = raced;
    }
  }

  try {
    const sourceImageAssetId = call.name === "edit_last_image"
      ? await lastDeliveredImage(turn.sessionId, turn.createdAt)
      : undefined;
    if (call.name === "edit_last_image" && !sourceImageAssetId) {
      throw Errors.conflict("There is no delivered Chat image to edit");
    }
    const payload = {
      version: 1 as const,
      kind: "chat.image.requested" as const,
      requestId: `chat-tool:${attachmentId}`,
      attachmentId,
      sessionId: turn.sessionId,
      exchangeId: turn.id,
      messageId: turn.assistantMessageId,
      userId: turn.session.userId,
      characterId: turn.session.characterId,
      ...(turn.characterReleaseId ? { characterReleaseId: turn.characterReleaseId } : {}),
      promptHint: promptHint(call),
      conversationContext: turn.userContent.slice(0, 1_200),
      intent: effect.intent,
      controls: {
        orientation: call.name === "generate_image_async" ? call.arguments.orientation : "4:5",
        outputCount: call.name === "generate_image_async" ? call.arguments.outputCount : 1,
        ...(sourceImageAssetId ? { sourceImageAssetId } : {}),
      },
      ...(turn.characterVisualProfileId && turn.characterVisualProfileVersion
        ? {
            visualProfileId: turn.characterVisualProfileId,
            visualProfileVersion: turn.characterVisualProfileVersion,
          }
        : {}),
      ...(authority.character?.release
        ? {
            releaseSnapshotHash: authority.character.release.snapshotHash,
            referenceSetRevisionId:
              authority.character.release.referenceSetRevisionId ?? undefined,
          }
        : {}),
    };

    const reusable = await findReusableChatImage(payload);
    if (reusable) {
      const completed = await prisma.chatTurnAttachment.update({
        where: { id: attachmentId },
        data: {
          status: "completed",
          mediaAssetId: reusable.asset.id,
          width: reusable.asset.width,
          height: reusable.asset.height,
          metadata: toJson({
            attempt: effect.attempt,
            effect: { turnId: effect.turnId, attempt: effect.attempt, callId: effect.callId, name: effect.name, effectScope: effect.effectScope, intent: effect.intent, requestDigest },
            reused: true,
            reuseScore: reusable.score,
          }),
        },
      });
      return {
        accepted: true,
        duplicate: false,
        attachmentId,
        status: "completed",
        generationJobId: null,
        mediaAssetId: completed.mediaAssetId,
        costDreamcoins: 0,
      };
    }

    // Existing generation authority performs pricing, balance check, wallet
    // reservation, Request/Attempt creation and dispatch under attachment idempotency.
    const job = await createChatImageGenerationJob(payload);
    await prisma.chatTurnAttachment.update({
      where: { id: attachmentId },
      data: {
        status: "accepted",
        generationJobId: job.id,
        metadata: toJson({
          attempt: effect.attempt,
          effect: { turnId: effect.turnId, attempt: effect.attempt, callId: effect.callId, name: effect.name, effectScope: effect.effectScope, intent: effect.intent, requestDigest },
          costDreamcoins: job.costDreamcoins,
        }),
      },
    });
    return {
      accepted: true,
      duplicate: false,
      attachmentId,
      status: "accepted",
      generationJobId: job.id,
      mediaAssetId: null,
      costDreamcoins: job.costDreamcoins,
    };
  } catch (error) {
    const failure = publicFailure(error);
    await prisma.chatTurnAttachment.update({
      where: { id: attachmentId },
      data: { status: "failed", errorCode: failure.code },
    });
    return {
      accepted: false,
      duplicate: false,
      attachmentId,
      error: failure,
    };
  }
}

function effectAttachmentId(effect: ChatToolEffect): string {
  // INVARIANT: a deterministic product action survives assistant regenerate.
  // Ordinary model tool calls remain scoped to their exact attempt.
  const identity = effect.effectScope === "turn_action"
    ? `${effect.turnId}:${effect.name}`
    : `${effect.turnId}:${effect.attempt}:${effect.callId}`;
  return `chatfx_${sha256(identity).slice(0, 48)}`;
}

function promptHint(call: ImageAgentToolCall): string {
  return call.name === "generate_image_async" ? call.arguments.prompt : call.arguments.instruction;
}

function sceneOwnedCall(call: ImageAgentToolCall): ImageAgentToolCall {
  return call.name === "generate_image_async"
    ? {
        ...call,
        arguments: {
          ...call.arguments,
          prompt: sanitizeChatImageDirection(call.arguments.prompt),
        },
      }
    : {
        ...call,
        arguments: {
          ...call.arguments,
          instruction: sanitizeChatImageDirection(call.arguments.instruction),
        },
      };
}

function effectRequestSnapshot(call: ImageAgentToolCall) {
  return call.name === "generate_image_async"
    ? {
        name: call.name,
        orientation: call.arguments.orientation,
        outputCount: call.arguments.outputCount,
      }
    : { name: call.name };
}

function persistedTurnActionCall(
  attachment: { promptHint: string | null; metadata: Prisma.JsonValue },
  fallback: ImageAgentToolCall,
): ImageAgentToolCall {
  const hint = attachment.promptHint?.trim();
  if (!hint) return fallback;
  const request = record(record(attachment.metadata)?.request);
  if (fallback.name === "edit_last_image") {
    return {
      name: "edit_last_image",
      arguments: {
        ...fallback.arguments,
        instruction: hint,
      },
    };
  }
  const orientation = request?.orientation;
  const outputCount = request?.outputCount;
  return {
    name: "generate_image_async",
    arguments: {
      ...fallback.arguments,
      prompt: hint,
      orientation:
        orientation === "4:5" || orientation === "1:1" || orientation === "16:9"
          ? orientation
          : fallback.arguments.orientation,
      outputCount:
        typeof outputCount === "number" && Number.isInteger(outputCount) &&
          outputCount >= 1 && outputCount <= 4
          ? outputCount
          : fallback.arguments.outputCount,
    },
  };
}

async function lastDeliveredImage(sessionId: string, before: Date): Promise<string | undefined> {
  const attachments = await prisma.chatTurnAttachment.findMany({
    where: {
      status: "completed",
      mediaAssetId: { not: null },
      turn: { sessionId, createdAt: { lt: before } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      mediaAssetId: true,
      metadata: true,
      turn: { select: { attempt: true } },
    },
  });
  return attachments.find((attachment) =>
    effectAttempt(attachment.metadata) === attachment.turn.attempt
  )?.mediaAssetId ?? undefined;
}

function effectAttempt(metadata: Prisma.JsonValue): number {
  const root = record(metadata);
  const direct = root?.attempt;
  const nested = record(root?.effect)?.attempt;
  const value = typeof direct === "number" ? direct : nested;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

async function rebindTurnActionAttempt(
  attachment: { id: string; metadata: Prisma.JsonValue },
  attempt: number,
  replayRequestDigest: string,
) {
  const metadata = record(attachment.metadata) ?? {};
  const effect = record(metadata.effect) ?? {};
  return prisma.chatTurnAttachment.update({
    where: { id: attachment.id },
    data: {
      metadata: toJson({
        ...metadata,
        attempt,
        effect: { ...effect, attempt, replayRequestDigest },
      }),
    },
  });
}

function existingEffect(
  attachment: {
    id: string;
    status: string;
    generationJobId: string | null;
    mediaAssetId: string | null;
    errorCode: string | null;
    metadata: Prisma.JsonValue;
  },
  expectedRequestDigest: string,
  effectScope: ChatToolEffect["effectScope"],
): ChatToolEffectResult {
  if (effectScope === "attempt") assertEffectRequest(attachment, expectedRequestDigest);
  if (attachment.status === "failed") {
    return {
      accepted: false,
      duplicate: true,
      attachmentId: attachment.id,
      error: {
        code: attachment.errorCode ?? "tool_effect_failed",
        message: "The image request was not accepted",
        retryable: true,
      },
    };
  }
  return {
    accepted: true,
    duplicate: true,
    attachmentId: attachment.id,
    status: attachment.status === "completed" ? "completed" : "accepted",
    generationJobId: attachment.generationJobId,
    mediaAssetId: attachment.mediaAssetId,
    costDreamcoins: Number(record(attachment.metadata)?.costDreamcoins ?? 0),
  };
}

function assertEffectRequest(
  attachment: { metadata: Prisma.JsonValue },
  expectedRequestDigest: string,
) {
  const effect = record(record(attachment.metadata)?.effect);
  if (effect?.requestDigest !== expectedRequestDigest) {
    throw Errors.conflict("Tool call identity was reused with different arguments");
  }
}

function assertTurnActionIntent(
  attachment: { metadata: Prisma.JsonValue },
  expectedIntent: ChatToolEffect["intent"],
) {
  const effect = record(record(attachment.metadata)?.effect);
  const intent = record(effect?.intent);
  if (
    effect?.effectScope !== "turn_action" ||
    intent?.requestedNudity !== expectedIntent.requestedNudity
  ) {
    throw Errors.conflict("Turn-scoped image action was replayed with different user intent");
  }
}

function publicFailure(error: unknown) {
  const value = record(error);
  const code = typeof value?.code === "string" ? value.code : "tool_effect_failed";
  const message = error instanceof Error ? error.message : "The image request failed";
  return {
    code,
    message: message.slice(0, 300),
    retryable: !["bad_request", "forbidden", "not_found", "conflict"].includes(code),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
