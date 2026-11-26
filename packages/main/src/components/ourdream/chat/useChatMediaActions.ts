"use client";

import { useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  parseGenerationRetryQuoteResponse,
  type RuntimeChatAttachment as ChatAttachment,
  type RuntimeChatMessage as ChatMessage,
} from "@/lib/public-api-contracts";
import {
  GenerationRequestError,
  apiPayloadErrorMessage,
  hasUnconfirmedGenerationRetry,
  requestChatVideoWithExactAuthority,
  requestGenerationRetryWithExactAuthority,
  requestMediaVariationWithExactQuote,
  type GenerationQuoteAuthority,
  type GenerationReceipt,
} from "@/lib/generation-write-client";
import type { useGenerationReceipts } from "@/hooks/useGenerationReceipts";
import type { useChatReplyDelivery } from "../chat-reply-delivery";
import type { ChatVideoSubmission } from "./ChatVideoComposer";

export type ChatVideoForm = {
  conversationId: string;
  ownerScope: string;
  sourceId?: string;
  prompt?: string;
  characterId: string | null;
};

type Receipts = ReturnType<typeof useGenerationReceipts>;

type MediaActionOptions = {
  readonly conversationId: string;
  readonly characterId: string | null;
  readonly receiptOwnerScope: string | null;
  readonly delivery: ReturnType<typeof useChatReplyDelivery>;
  readonly fetchForSession: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly receiptContext: Receipts["context"];
  readonly refreshReceipts: Receipts["refresh"];
  readonly recoverReceipt: Receipts["recover"];
  readonly setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  readonly onStatus: (status: string | null) => void;
  readonly onInsufficientBalance: () => void;
  readonly onClearDeleteConfirm: () => void;
  readonly onVideoRequested: () => void;
};

// SPEC: Paid media from a chat — retries, variations, videos and identity
//       feedback — always runs against an exact quote and the conversation's
//       current owner. A response for a revoked conversation is dropped.
export function useChatMediaActions(options: MediaActionOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const [retryingImageIds, setRetryingImageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [variationPendingMediaId, setVariationPendingMediaId] = useState<string | null>(null);
  const [videoForm, setVideoForm] = useState<ChatVideoForm | null>(null);
  const imageRetryPendingRef = useRef(new Set<string>());

  function reset() {
    imageRetryPendingRef.current.clear();
    setRetryingImageIds(new Set());
    setVariationPendingMediaId(null);
  }

  async function retryImageAttachment(attachment: ChatAttachment, confirmedQuote?: GenerationQuoteAuthority) {
    const { delivery, fetchForSession, onStatus } = latest.current;
    const jobId = attachment.generationJobId;
    if (!jobId || imageRetryPendingRef.current.has(attachment.id)) return;
    imageRetryPendingRef.current.add(attachment.id);
    setRetryingImageIds(new Set(imageRetryPendingRef.current));
    onStatus(null);
    latest.current.onClearDeleteConfirm();
    const read = delivery.context({ invalidate: true });
    let receiptContext: ReturnType<Receipts["context"]> | undefined;
    try {
      receiptContext = latest.current.receiptContext();
      const current = () => read.isCurrent() && receiptContext!.isCurrent();
      let quoteAuthority = confirmedQuote;
      if (!quoteAuthority && !hasUnconfirmedGenerationRetry(jobId, receiptContext.keys.retry)) {
        const response = await fetchForSession(`/api/v1/generation/jobs/${encodeURIComponent(jobId)}/retry/quote`, { method: "POST", cache: "no-store", headers: { "x-idream-viewer-scope": receiptContext.persistence.ownerScope } });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new GenerationRequestError(apiPayloadErrorMessage(payload) ?? "Couldn't check the media retry price.", response.status);
        const { quote } = parseGenerationRetryQuoteResponse(payload);
        quoteAuthority = { profileId: quote.profileId, profileVersion: quote.profileVersion, routeFingerprint: quote.routeFingerprint, pricingFingerprint: quote.pricing.fingerprint, outputCount: quote.outputCount, costDreamcoins: quote.costDreamcoins };
      }
      if (!current()) return;
      const job = await requestGenerationRetryWithExactAuthority({ jobId, quoteAuthority, idempotencyKeys: receiptContext.keys.retry, persistence: receiptContext.persistence, isCurrent: current });
      if (!current()) return;
      latest.current.setMessages(messages => messages.map(message => ({ ...message, attachments: message.attachments?.map(item => item.id === attachment.id
        ? { ...item, generationJobId: job.id, status: "accepted", errorCode: null, costDreamcoins: job.costDreamcoins }
        : item) })));
      await delivery.context({ isCurrent: current }).refresh();
    } catch (error) {
      if (!read.isCurrent()) return;
      if (error instanceof GenerationRequestError && error.status === 402) latest.current.onInsufficientBalance();
      latest.current.onStatus(error instanceof GenerationRequestError ? error.message : "Couldn't confirm the media request. Try again to check the same request.");
    } finally {
      if (receiptContext?.isCurrent()) latest.current.refreshReceipts();
      imageRetryPendingRef.current.delete(attachment.id);
      setRetryingImageIds(new Set(imageRetryPendingRef.current));
    }
  }

  function openVideoRequest(sourceId?: string, prompt?: string, sourceCharacterId = latest.current.characterId) {
    const { receiptOwnerScope, conversationId } = latest.current;
    if (!receiptOwnerScope) return;
    setVideoForm({ conversationId, ownerScope: receiptOwnerScope, sourceId, prompt, characterId: sourceCharacterId });
    latest.current.onStatus(null);
  }

  async function submitVideoRequest(submission: ChatVideoSubmission) {
    const context = latest.current.receiptContext();
    const read = latest.current.delivery.context({ isCurrent: context.isCurrent });
    const current = read.isCurrent;
    try {
      await requestChatVideoWithExactAuthority({ ...submission, idempotencyKeys: context.keys.generation, persistence: context.persistence, isCurrent: current });
      if (!current()) return false;
      if (!await read.refresh()) return false;
      latest.current.onVideoRequested();
      latest.current.onStatus("Video requested. You can keep chatting while it finishes.");
      return true;
    } catch (error) {
      if (!current()) return false;
      latest.current.onStatus(error instanceof GenerationRequestError ? error.message : "The video request is unconfirmed. Check the original request below before creating another.");
      return false;
    } finally { if (context.isCurrent()) latest.current.refreshReceipts(); }
  }

  async function refreshAfterAttachmentChange() {
    const context = latest.current.receiptContext();
    await latest.current.delivery.context({ isCurrent: context.isCurrent }).refresh();
  }

  async function addAttachmentToIdentity(mediaAssetId: string, sourceCharacterId = latest.current.characterId) {
    const { fetchForSession, onStatus } = latest.current;
    onStatus(null);
    latest.current.onClearDeleteConfirm();
    try {
      const response = await fetchForSession(`/api/v1/media/${encodeURIComponent(mediaAssetId)}/add-to-identity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sourceCharacterId ? { characterId: sourceCharacterId } : {}),
      });
      onStatus(response.ok ? "Added image to this character's identity." : "Couldn't update identity.");
    } catch {
      onStatus("Couldn't update identity.");
    }
  }

  async function recordAttachmentIdentityFeedback(
    mediaAssetId: string,
    feedbackType: "identity_match" | "identity_mismatch",
  ) {
    const { fetchForSession, onStatus } = latest.current;
    onStatus(null);
    try {
      const response = await fetchForSession(`/api/v1/media/${encodeURIComponent(mediaAssetId)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedbackType, sourceSurface: "chat" }),
      });
      onStatus(
        response.ok
          ? feedbackType === "identity_match"
            ? "Thanks — this image looks like the character."
            : "Identity mismatch recorded. Use More like this for a corrected retry."
          : "Couldn't save image feedback.",
      );
    } catch {
      onStatus("Couldn't save image feedback.");
    }
  }

  async function createAttachmentVariation(mediaAssetId: string) {
    if (variationPendingMediaId === mediaAssetId) return;
    setVariationPendingMediaId(mediaAssetId);
    latest.current.onStatus("Checking the exact variation price…");
    latest.current.onClearDeleteConfirm();
    let receiptContext: ReturnType<Receipts["context"]> | undefined;
    try {
      receiptContext = latest.current.receiptContext();
      await requestMediaVariationWithExactQuote({
        mediaId: mediaAssetId,
        outputCount: 1,
        consistencyMode: "balanced",
        idempotencyKeys: receiptContext.keys.variation,
        persistence: receiptContext.persistence,
        isCurrent: receiptContext.isCurrent,
      });
      if (!receiptContext.isCurrent()) return;
      latest.current.onStatus("Variation queued. It will appear in Generate and Gallery.");
    } catch (error) {
      if (receiptContext && !receiptContext.isCurrent()) return;
      latest.current.onStatus(
        error instanceof GenerationRequestError
          ? error.message
          : "Couldn't queue variation. Check your connection and try again.",
      );
    } finally {
      if (receiptContext?.isCurrent()) latest.current.refreshReceipts();
      setVariationPendingMediaId((current) =>
        current === mediaAssetId ? null : current,
      );
    }
  }

  async function checkGenerationReceipt(receipt: GenerationReceipt) {
    const read = latest.current.delivery.context();
    try {
      const result = await latest.current.recoverReceipt(receipt);
      if (!result || !read.isCurrent()) return;
      latest.current.onStatus("Original request confirmed. Its progress is available in Generate and Gallery.");
      await read.refresh();
    } catch (error) {
      if (!read.isCurrent()) return;
      latest.current.onStatus(`${error instanceof Error ? error.message : "The request could not be confirmed."} Your original request is kept; check again or contact support.`);
    }
  }

  return {
    retryingImageIds,
    variationPendingMediaId,
    videoForm,
    closeVideoForm: () => setVideoForm(null),
    reset,
    retryImageAttachment,
    openVideoRequest,
    submitVideoRequest,
    refreshAfterAttachmentChange,
    addAttachmentToIdentity,
    recordAttachmentIdentityFeedback,
    createAttachmentVariation,
    checkGenerationReceipt,
  };
}
