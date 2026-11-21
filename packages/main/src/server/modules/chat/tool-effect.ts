import { createHash } from "node:crypto";
import {
  editLastImageArgsSchema,
  imageEditScopeSchema,
  type EditLastImageArgs,
} from "@idream/shared/chat/image-action";
import {
  REQUEST_CHARACTER_MEDIA_TOOL,
  RESEND_SESSION_MEDIA_TOOL,
  type RequestCharacterMediaResult,
  type ResendSessionMediaResult,
} from "@idream/shared/chat/media-library";
import {
  chatToolEffectSchema,
  chatExecutionSnapshotSchema,
  type ChatImageRequestedPayload,
  type ChatToolEffect,
} from "@idream/shared/contracts";
import { Prisma, type ChatTurnAttachment } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { compileChatImagePrompt, sanitizeChatImageDirection } from "@/server/modules/ourdream/generation-prompt";
import { createChatImageGenerationJob } from "@/server/modules/ourdream/service";
import { loadChatAuthoritySnapshot } from "./chat-authority-snapshot";
import {
  abandonRequestedToolEffectAttachment,
  assertToolEffectRequest,
  createToolEffectAttachment,
  failedToolEffectReceipt,
  legacyTurnActionAttachmentId,
  reopenUnreservedFailedToolEffectAttachment,
} from "./tool-effect-attachment";
import { chatTurnForEffect } from "./turn-ledger";
import { assertChatImageActionAllowed, attachmentAttempt, lockChatScope } from "./turn-scope";
import { fulfillCharacterMediaRequest, requestMediaReceipt, resendMediaReceipt, resendSessionMediaRequest } from "./media-fulfillment-router";
import { frozenChatImageEditSource, isReadableChatMedia, readableDeliveredChatMediaWhere } from "./chat-media-history";
import { lockCharacterGenerationAuthority, lockMediaAssetAuthority } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { createChatImageEditDraft } from "./image-edit-review";

export type ChatToolEffectResult =
  | {
      accepted: true;
      duplicate: boolean;
      attachmentId: string;
      status: "accepted" | "completed" | "awaiting_confirmation";
      generationJobId: string | null;
      mediaAssetId: string | null;
      costDreamcoins: number;
      source?: "library" | "previous_media";
      description?: string | null;
    }
  | {
      accepted: false;
      duplicate: boolean;
      attachmentId: string;
      error: { code: string; message: string; retryable: boolean };
    }
  | (RequestCharacterMediaResult & {
      attachmentId?: string; generationJobId?: string | null; mediaAssetId?: string | null;
    })
  | ResendSessionMediaResult;

/**
 * Main-owned product effect. Reserving generation and debiting its wallet are
 * one existing Generation Request operation; Chat only receives the durable ACK.
 */
export async function applyChatToolEffect(raw: unknown, requestSignal?: AbortSignal): Promise<ChatToolEffectResult> {
  const effect = chatToolEffectSchema.parse(raw);
  const turn = await chatTurnForEffect(effect.turnId);
  const requestDigest = sha256(JSON.stringify(canonical({
    name: effect.name,
    arguments: effect.arguments,
  })));
  const snapshot = boundSnapshot(turn);
  const revision = snapshot?.userMessageRevision;
  let attachmentId = effectAttachmentId(effect, turn.userContent, revision);
  let prior = await prisma.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
  if (revision === undefined && record(prior?.metadata)?.turnActionInvalidatedByEdit === true) {
    // A pre-revision snapshot can already have returned to its earlier words.
    attachmentId = effectAttachmentId(effect, turn.userContent, "historical-edit");
    prior = await prisma.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
  } else if (!prior && revision === undefined) {
    // Existing receipts used a tool-specific identity. Read both old names so
    // regenerating with another Agent choice cannot buy a second image action.
    const contentDigest = sha256(turn.userContent);
    for (const name of ["generate_image_async", "edit_last_image"] as const) {
      for (const oldId of [
        legacyTurnActionAttachmentId(effect.turnId, name, contentDigest),
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
  if (prior && prior.status !== "requesting" && turn.attempt === effect.attempt && attachmentAttempt(prior.metadata) === effect.attempt) {
    const receiptId = prior.id;
    return prisma.$transaction(async tx => {
      const scope = await lockChatScope(tx, { userId: turn.session.userId, at: { attachment: receiptId }, expect: {
        attempt: effect.attempt, attachmentAttemptMatchesTurn: true,
      } });
      const current = scope.attachment!;
      assertTurnActionIntent(current, effect, requestDigest);
      // A paid retry can replace this pointer after the initial unlocked read.
      // The ACK always describes the locked, current product receipt.
      return existingEffect(current, effect.name);
    });
  }
  if (!snapshot) throw Errors.forbidden("Image action requires the current frozen Chat attempt");
  // INVARIANT: an accepted effect remains replayable after its Turn becomes
  // terminal. HTTP timeout must not turn a successful reservation into a 409.
  if (prior) {
    assertTurnActionIntent(prior, effect, requestDigest);
    if (attachmentAttempt(prior.metadata) !== effect.attempt) {
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
    if (prior.status !== "requesting") return existingEffect(prior, effect.name);
  }

  if (turn.attempt !== effect.attempt || !["pending", "generating"].includes(turn.assistantStatus)) {
    throw Errors.conflict("Tool effect does not belong to the active Chat attempt");
  }
  if (effect.name === REQUEST_CHARACTER_MEDIA_TOOL) {
    try {
      return await fulfillCharacterMediaRequest({ effect, judged: turn, attachmentId, requestDigest, signal: requestSignal });
    } catch (error) {
      // Only a reservation this action created can be marked failed.
      return settleReservationFailure(error, effect, attachmentId, requestDigest);
    }
  }
  if (effect.name === RESEND_SESSION_MEDIA_TOOL) {
    return resendSessionMediaRequest({ effect, judged: turn, attachmentId, requestDigest });
  }
  const sourceImageAssetId = frozenChatImageEditSource(snapshot);
  if (!sourceImageAssetId) throw Errors.conflict("There is no delivered Chat image to edit");
  const parsed = editLastImageArgsSchema.safeParse(effect.arguments);
  if (!parsed.success) throw Errors.badRequest("Invalid image edit arguments");
  if (!prior && !parsed.data.editScope) {
    throw Errors.badRequest("Choose the local target or explicitly request a whole-image edit before editing");
  }
  if (parsed.data.requestedNudity !== undefined && parsed.data.requestedNudity !== effect.intent.requestedNudity) {
    throw Errors.badRequest("Image arguments and effect wardrobe intent differ");
  }
  let edit = { ...parsed.data, instruction: sanitizeChatImageDirection(parsed.data.instruction) };
  if (prior) edit = persistedEdit(prior, edit);
  const localEdit = edit.editScope?.mode === "local";
  assertChatImageActionAllowed(turn, localEdit);
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

  const liveIntentNudity = effect.intent.requestedNudity === "partial" ? "unspecified" as const : effect.intent.requestedNudity;
  if (!prior) {
    // A valid 1200-character argument may exceed the generation direction
    // budget after wardrobe constraints. Reject before a paid reservation
    // rather than silently dropping required scene or clothing constraints.
    try {
      compileChatImagePrompt(edit.instruction, liveIntentNudity, { userInstruction: turn.userContent });
    } catch (error) {
      if (error instanceof RangeError) throw Errors.badRequest(error.message);
      throw error;
    }
    try {
      await prisma.$transaction(async tx => {
        const scope = await lockChatScope(tx, { userId: turn.session.userId, at: { turn: effect.turnId },
          expect: { attempt: effect.attempt, assistantStatus: ["pending", "generating"] } });
        if (scope.session.status !== "active") throw Errors.gone("Chat session is archived");
        assertChatImageActionAllowed(scope.turn!, localEdit);
        await createToolEffectAttachment(tx, {
          id: attachmentId,
          turn: scope.turn!,
          kind: "generated_image",
          attempt: effect.attempt,
          promptHint: edit.instruction,
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
            request: { name: effect.name, ...(edit.editScope ? { editScope: edit.editScope } : {}) },
          },
        });
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
      const raced = await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: attachmentId } });
      assertTurnActionIntent(raced, effect, requestDigest);
      edit = persistedEdit(raced, edit);
      if (raced.status !== "requesting") {
        return existingEffect(raced, effect.name);
      }
      prior = raced;
    }
  }

  try {
    const source = await prisma.mediaAsset.findFirst({
      where: { ...readableDeliveredChatMediaWhere(turn.session.userId, turn.session.characterId), id: sourceImageAssetId, type: "image" },
      select: { characterId: true, metadata: true, storageKey: true, url: true },
    });
    if (!source || !isReadableChatMedia(source)) throw Errors.gone("The delivered Chat image is no longer available to edit");
    const subject = source.characterId === null ? "scene" : "companion";
    const payload: ChatImageRequestedPayload = {
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
      promptHint: edit.instruction,
      conversationContext: turn.userContent,
      intent: { requestedNudity: liveIntentNudity },
      controls: {
        orientation: "original",
        outputCount: 1,
        sourceImageAssetId,
        ...(edit.editScope ? { editScope: edit.editScope } : {}),
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
    if (edit.editScope?.mode === "local") {
      await createChatImageEditDraft(payload, effect.attempt);
    } else {
      await createChatImageGenerationJob(payload, effect.attempt);
    }
    // Generation binds the attachment in its acceptance transaction. Its
    // terminal (or a user retry) may already have advanced this exact pointer;
    // a late reservation ACK must never write it back to the original Job.
    const current = await prisma.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
    if (!current) throw Errors.gone("The image action is no longer available");
    // A fast terminal can also be a failure. Initial and replay receipts must
    // describe the same durable attachment instead of promising a pending image.
    return existingEffect(current, effect.name, false);
  } catch (error) {
    return settleReservationFailure(error, effect, attachmentId, requestDigest);
  }
}

async function settleReservationFailure(error: unknown, effect: ChatToolEffect, attachmentId: string, requestDigest: string): Promise<ChatToolEffectResult> {
  const attachment = await prisma.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
  if (!attachment || attachmentAttempt(attachment.metadata) !== effect.attempt) throw error;
  assertTurnActionIntent(attachment, effect, requestDigest);
  const failure = publicFailure(error);
  logger.warn({ event: "chat_tool_effect_rejected", attachmentId, code: failure.code, reason: failure.message }, "chat tool effect rejected");
  const abandoned = await abandonRequestedToolEffectAttachment(prisma, {
    id: attachmentId, attempt: effect.attempt, errorCode: failure.code,
  });
  if (!abandoned) {
    const current = await prisma.chatTurnAttachment.findUniqueOrThrow({ where: { id: attachmentId } });
    if (attachmentAttempt(current.metadata) !== effect.attempt) throw error;
    assertTurnActionIntent(current, effect, requestDigest);
    return existingEffect(current, effect.name);
  }
  return { accepted: false, duplicate: false, attachmentId, error: failure };
}

function effectAttachmentId(effect: ChatToolEffect, userContent: string, revision?: number | "historical-edit"): string {
  // Only editing the user message creates a new action identity.
  const identity = `${effect.turnId}:image:${sha256(userContent)}${revision === undefined ? "" : `:${revision}`}`;
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

function persistedEdit(
  attachment: { promptHint: string | null; metadata: Prisma.JsonValue },
  fallback: EditLastImageArgs,
): EditLastImageArgs {
  const hint = attachment.promptHint?.trim();
  if (!hint) return fallback;
  const request = record(record(attachment.metadata)?.request);
  return {
    ...fallback,
    instruction: hint,
    editScope: imageEditScopeSchema.parse(request?.editScope ?? { mode: "whole_image" }),
  };
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
    if (current.attempt !== attempt || !["pending", "generating"].includes(current.assistantStatus)) {
      throw Errors.conflict("Required effect replay does not belong to the active Chat attempt");
    }
    assertTurnActionIntent(lockedAttachment, effect, replayRequestDigest);
    if (lockedAttachment.status === "completed" && lockedAttachment.mediaAssetId) {
      await lockCharacterGenerationAuthority(tx, scope.session.characterId);
      if (lockedAttachment.mediaAssetId) await lockMediaAssetAuthority(tx, lockedAttachment.mediaAssetId);
      const asset = lockedAttachment.mediaAssetId ? await tx.mediaAsset.findFirst({ where: {
        id: lockedAttachment.mediaAssetId, ...readableDeliveredChatMediaWhere(scope.userId, scope.session.characterId),
      } }) : null;
      if (!asset || !isReadableChatMedia(asset)) throw Errors.gone("The previously delivered media is no longer available");
    }
    // A concurrent delivery or paid retry may have changed status, Job and
    // cost since the first read. Rebinding carries only these locked facts.
    const metadata = record(lockedAttachment.metadata) ?? {};
    const previousEffect = record(metadata.effect) ?? {};
    const rebound = { ...metadata, attempt, effect: { ...previousEffect, attempt, replayRequestDigest } };
    if (lockedAttachment.kind === "generated_image" && !lockedAttachment.generationJobId
      && ["requesting", "failed"].includes(lockedAttachment.status)) {
      assertChatImageActionAllowed(current, effect.name === "edit_last_image"
        && record(record(metadata.request)?.editScope)?.mode === "local");
      if (effect.name === "edit_last_image" && !frozenChatImageEditSource(bound)) {
        throw Errors.conflict("There is no delivered Chat image to edit");
      }
    }
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

function existingEffect(attachment: ChatTurnAttachment, name: ChatToolEffect["name"], duplicate = true): ChatToolEffectResult {
  if (attachment.status === "requesting") throw Errors.unavailable("The media action has not been reserved yet");
  const failure = failedToolEffectReceipt(attachment, duplicate);
  if (failure) return failure;
  if (name === REQUEST_CHARACTER_MEDIA_TOOL) return requestMediaReceipt(attachment, duplicate);
  if (name === RESEND_SESSION_MEDIA_TOOL) return resendMediaReceipt(attachment, duplicate);
  return {
    accepted: true,
    duplicate,
    attachmentId: attachment.id,
    status: attachment.status === "awaiting_confirmation" ? "awaiting_confirmation" : attachment.status === "completed" ? "completed" : "accepted",
    generationJobId: attachment.generationJobId,
    mediaAssetId: attachment.mediaAssetId,
    costDreamcoins: Number(record(attachment.metadata)?.costDreamcoins ?? 0),
  };
}

function assertTurnActionIntent(attachment: ChatTurnAttachment, expected: ChatToolEffect, requestDigest: string) {
  if (expected.name !== "edit_last_image") {
    assertToolEffectRequest(attachment, expected.name, requestDigest);
    return;
  }
  const metadata = record(attachment.metadata);
  const effect = record(metadata?.effect);
  const intent = record(effect?.intent);
  if (metadata?.turnActionInvalidatedByEdit === true || effect?.effectScope !== "turn_action" ||
    (effect.name !== undefined && effect.name !== expected.name) || intent?.requestedNudity !== expected.intent.requestedNudity) {
    throw Errors.conflict("Turn image edit was replayed with a different tool or wardrobe intent");
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
