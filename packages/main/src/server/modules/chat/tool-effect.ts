import { createHash } from "node:crypto";
import {
  parseImageAgentToolCall,
  type ImageAgentToolCall,
} from "@idream/shared/chat/image-action";
import {
  chatToolEffectSchema,
  chatExecutionSnapshotSchema,
  type ChatToolEffect,
} from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { compileChatImagePrompt, sanitizeChatImageDirection } from "@/server/modules/ourdream/generation-prompt";
import { createChatImageGenerationJob } from "@/server/modules/ourdream/service";
import { loadChatAuthoritySnapshot } from "./chat-authority-snapshot";
import {
  abandonRequestedToolEffectAttachment,
  createToolEffectAttachment,
  legacyTurnActionAttachmentId,
  reopenUnreservedFailedToolEffectAttachment,
} from "./tool-effect-attachment";
import { chatTurnForEffect } from "./turn-ledger";
import { lockChatScope } from "./turn-scope";

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
  const turn = await chatTurnForEffect(effect.turnId);
  const requestDigest = sha256(JSON.stringify(canonical({
    name: effect.name,
    arguments: effect.arguments,
  })));
  let attachmentId = effectAttachmentId(effect, turn.userContent);
  let prior = await prisma.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
  if (!prior && effect.effectScope === "turn_action") {
    // Existing receipts used a tool-specific identity. Read both old names so
    // regenerating with another Agent choice cannot buy a second image action.
    for (const name of ["generate_image_async", "edit_last_image"] as const) {
      for (const oldId of [
        `chatfx_${sha256(`${effect.turnId}:${name}:${sha256(turn.userContent)}`).slice(0, 48)}`,
        legacyTurnActionAttachmentId(effect.turnId, name),
      ]) {
        const legacy = await prisma.chatTurnAttachment.findUnique({ where: { id: oldId } });
        if (!legacy || record(legacy.metadata)?.turnActionInvalidatedByEdit === true) continue;
        const job = legacy.generationJobId
          ? await prisma.generationJob.findUnique({ where: { id: legacy.generationJobId }, select: { sourceMeta: true } })
          : null;
        if (record(record(job?.sourceMeta)?.privacyRedaction)?.reason === "logical_turn_edited") continue;
        if (name !== effect.name) throw Errors.conflict("This Turn already has a different image action");
        attachmentId = oldId;
        prior = legacy;
        break;
      }
      if (prior) break;
    }
  }
  // An exact historical ACK is a read, with no execution or reattachment.
  if (prior && prior.status !== "requesting" && turn.attempt === effect.attempt && effectAttempt(prior.metadata) === effect.attempt) {
    if (effect.effectScope === "attempt") assertEffectRequest(prior, requestDigest);
    else assertTurnActionIntent(prior, effect);
    return existingEffect(prior, requestDigest, effect.effectScope);
  }
  assertBoundImageEffect(turn, effect);
  // INVARIANT: an accepted effect remains replayable after its Turn becomes
  // terminal. HTTP timeout must not turn a successful reservation into a 409.
  if (prior) {
    if (effect.effectScope === "attempt") assertEffectRequest(prior, requestDigest);
    else assertTurnActionIntent(prior, effect);
    if (effect.effectScope === "turn_action" && record(prior.metadata)?.attempt !== effect.attempt) {
      if (
        turn.attempt !== effect.attempt ||
        !["pending", "generating"].includes(turn.assistantStatus)
      ) {
        throw Errors.conflict("Required effect replay does not belong to the active Chat attempt");
      }
      prior = await rebindTurnActionAttempt(prior, effect, requestDigest, turn);
    }
    // A rebind that reopened a never-reserved failure executes below like a new
    // reservation, with the direction frozen on its first attempt.
    if (prior.status !== "requesting") return existingEffect(prior, requestDigest, effect.effectScope);
  }

  if (effect.effectScope !== "turn_action") {
    throw Errors.forbidden("New image effects must use the Turn image action");
  }
  if (turn.attempt !== effect.attempt || !["pending", "generating"].includes(turn.assistantStatus)) {
    throw Errors.conflict("Tool effect does not belong to the active Chat attempt");
  }
  // Only a durable pre-subject action has the old companion-only meaning.
  // New model output must make its own explicit, validated subject choice.
  const historicalSubject = record(record(prior?.metadata)?.request)?.subject;
  const argumentsToParse = prior && effect.name === "generate_image_async" && effect.arguments.subject === undefined
    ? { ...effect.arguments, subject: historicalSubject ?? "companion" }
    : effect.arguments;
  const parsedCall = parseImageAgentToolCall(effect.name, argumentsToParse);
  if (!parsedCall) throw Errors.badRequest("Invalid image tool arguments");
  if (parsedCall.arguments.requestedNudity !== undefined && parsedCall.arguments.requestedNudity !== effect.intent.requestedNudity) {
    throw Errors.badRequest("Image arguments and effect wardrobe intent differ");
  }
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
    assertTurnActionIntent(prior, effect);
    call = persistedTurnActionCall(prior, call);
  } else {
    // A valid 1200-character argument may exceed the generation direction
    // budget after wardrobe constraints. Reject before a paid reservation
    // rather than silently dropping the Agent's final constraint.
    try {
      compileChatImagePrompt(promptHint(call), call.name === "generate_image_async" && call.arguments.subject === "scene" ? "unspecified" : effect.intent.requestedNudity);
    } catch (error) {
      if (error instanceof RangeError) throw Errors.badRequest(error.message);
      throw error;
    }
    try {
      await createToolEffectAttachment(prisma, {
        id: attachmentId,
        turn,
        kind: "generated_image",
        attempt: effect.attempt,
        promptHint: promptHint(call),
        metadata: {
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
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
      const raced = await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: attachmentId } });
      assertTurnActionIntent(raced, effect);
      call = persistedTurnActionCall(raced, call);
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
    const subject = call.name === "generate_image_async" ? call.arguments.subject
      : (await prisma.mediaAsset.findFirstOrThrow({
          where: { id: sourceImageAssetId, ownerId: turn.session.userId, type: "image", deletedAt: null },
          select: { characterId: true },
        })).characterId === null ? "scene" : "companion";
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
      subject,
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

    // A new action promises this moment. Shared words cannot establish that a
    // curated asset matches its scene or wardrobe; only the prior ACK above is reusable.
    // Existing generation authority performs pricing, balance check, wallet
    // reservation, Request/Attempt creation and dispatch under attachment idempotency.
    const job = await createChatImageGenerationJob(payload, effect.attempt);
    // Generation binds the attachment in its acceptance transaction. Its
    // terminal (or a user retry) may already have advanced this exact pointer;
    // a late reservation ACK must never write it back to the original Job.
    const current = await prisma.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
    return {
      accepted: true,
      duplicate: false,
      attachmentId,
      status: current?.status === "completed" ? "completed" : "accepted",
      generationJobId: current?.generationJobId ?? job.id,
      mediaAssetId: current?.mediaAssetId ?? null,
      costDreamcoins: Number(record(current?.metadata)?.costDreamcoins ?? job.costDreamcoins),
    };
  } catch (error) {
    const failure = publicFailure(error);
    // The attachment keeps only the code; operators need the reason too.
    logger.warn({ event: "chat_tool_effect_rejected", attachmentId, code: failure.code, reason: failure.message }, "chat tool effect rejected");
    const abandoned = await abandonRequestedToolEffectAttachment(prisma, {
      id: attachmentId,
      attempt: effect.attempt,
      errorCode: failure.code,
    });
    if (!abandoned) {
      const current = await prisma.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
      if (current) return existingEffect(current, requestDigest, effect.effectScope);
    }
    return {
      accepted: false,
      duplicate: false,
      attachmentId,
      error: failure,
    };
  }
}

function effectAttachmentId(effect: ChatToolEffect, userContent: string): string {
  // INVARIANT: a product image action survives assistant regenerate,
  // which keeps the user's words; editing them asks for a different picture, so
  // the frozen words are part of the identity. Historical ordinary-call ACKs
  // retain their original attempt identity.
  const identity = effect.effectScope === "turn_action"
    ? `${effect.turnId}:image:${sha256(userContent)}`
    : `${effect.turnId}:${effect.attempt}:${effect.callId}`;
  return `chatfx_${sha256(identity).slice(0, 48)}`;
}

/** The Turn's own frozen context, or null when it is missing or no longer binds. */
function boundSnapshot(
  turn: { id: string; attempt: number; userContent: string; executionSnapshot: Prisma.JsonValue | null },
) {
  const frozen = chatExecutionSnapshotSchema.safeParse(turn.executionSnapshot);
  return frozen.success && frozen.data.turnId === turn.id &&
    frozen.data.attempt === turn.attempt && frozen.data.userContent === turn.userContent
    ? frozen.data
    : null;
}

// The Agent owns interpretation. Main checks the immutable execution identity
// and factual edit capability, then revalidates live permissions before spending.
function assertBoundImageEffect(
  turn: { id: string; attempt: number; userContent: string; executionSnapshot: Prisma.JsonValue | null },
  effect: ChatToolEffect,
) {
  const bound = boundSnapshot(turn);
  if (!bound) throw Errors.forbidden("Image action requires the current frozen Chat attempt");
  if (effect.name === "edit_last_image" && !bound.hasRecentImageContext) {
    throw Errors.conflict("There is no delivered Chat image to edit");
  }
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
        subject: call.arguments.subject,
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
      // Old requesting receipts were accepted under the companion-only contract.
      subject: request?.subject === "scene" ? "scene" : "companion",
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
      kind: "generated_image",
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
  attachment: { id: string; status: string; generationJobId: string | null; metadata: Prisma.JsonValue },
  effect: ChatToolEffect,
  replayRequestDigest: string,
  judged: { attempt: number; userContent: string; session: { userId: string } },
) {
  const attempt = effect.attempt;
  return prisma.$transaction(async (tx) => {
    const scope = await lockChatScope(tx, {
      userId: judged.session.userId,
      at: { attachment: attachment.id },
      expect: {
        attempt,
        assistantStatus: ["pending", "generating"],
        conflictMessage: "Required effect replay does not belong to the active Chat attempt",
      },
    });
    const current = scope.turn;
    const lockedAttachment = scope.attachment;
    if (!current || !lockedAttachment || current.id !== effect.turnId) {
      throw Errors.conflict("Required effect replay does not belong to the active Chat attempt");
    }
    // Recheck the same pinned execution under the Turn lock. This is a
    // structural fence, with no network classifier or text interpretation.
    const bound = boundSnapshot(current);
    if (!bound || bound.attempt !== judged.attempt || bound.userContent !== judged.userContent) {
      throw Errors.forbidden("Image action requires the current frozen Chat attempt");
    }
    assertBoundImageEffect(current, effect);
    if (current.attempt !== attempt || !["pending", "generating"].includes(current.assistantStatus)) {
      throw Errors.conflict("Required effect replay does not belong to the active Chat attempt");
    }
    assertTurnActionIntent(lockedAttachment, effect);
    // A concurrent delivery or paid retry may have changed status, Job and
    // cost since the first read. Rebinding carries only these locked facts.
    const metadata = record(lockedAttachment.metadata) ?? {};
    const previousEffect = record(metadata.effect) ?? {};
    const rebound = { ...metadata, attempt, effect: { ...previousEffect, attempt, replayRequestDigest } };
    if (
      lockedAttachment.status === "failed" && lockedAttachment.generationJobId === null &&
      await reopenUnreservedFailedToolEffectAttachment(tx, { id: attachment.id, metadata: rebound })
    ) {
      return tx.chatTurnAttachment.findUniqueOrThrow({ where: { id: attachment.id } });
    }
    return tx.chatTurnAttachment.update({
      where: { id: attachment.id },
      data: { metadata: toJson(rebound) },
    });
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
  if (attachment.status === "requesting") {
    // No Generation reservation has committed, so there is no durable success
    // ACK to replay. The caller must retry the same action identity.
    throw Errors.unavailable("The image action has not been reserved yet");
  }
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
  expected: ChatToolEffect,
) {
  const effect = record(record(attachment.metadata)?.effect);
  const intent = record(effect?.intent);
  if (
    effect?.effectScope !== "turn_action" ||
    (effect.name !== undefined && effect.name !== expected.name) ||
    intent?.requestedNudity !== expected.intent.requestedNudity
  ) {
    throw Errors.conflict("Turn image action was replayed with a different tool or wardrobe intent");
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
