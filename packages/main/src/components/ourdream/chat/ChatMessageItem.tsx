"use client";

import { Check, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { RuntimeChatAttachment as ChatAttachment, RuntimeChatMessage as ChatMessage } from "@/lib/public-api-contracts";
import type { GenerationQuoteAuthority } from "@/lib/generation-write-client";
import { chatGenerationHref } from "@/lib/chat-generation-link";
import { chatStreamMessageIsInProgress } from "../chat-reply-delivery";
import { isLocalChatMessageId } from "../chat-message-actions";
import { ChatImageAttachmentCard } from "./ChatImageAttachmentCard";
import { ChatImageEditReviewCard } from "./ChatImageEditReviewCard";
import { ChatMediaQuoteCard } from "./ChatMediaQuoteCard";
import { ChatVideoAttachmentCard } from "./ChatVideoAttachmentCard";
import { MessageActions } from "./MessageActions";
import type { VoiceConfirmation } from "./useVoicePlayback";
import { ChatMessageText } from "./chat-message-text";

const BLOCKED_ASSISTANT_NOTICE = "I can’t help with that request.";

// SPEC: Every callback a message needs, keyed by message id. The object is
//       stable for the conversation's lifetime so a streaming token re-renders
//       only the bubble whose text changed.
export type ChatMessageHandlers = {
  readonly beginEdit: (messageId: string) => void;
  readonly cancelEdit: () => void;
  readonly saveEdit: (allowPaidImage: boolean) => void;
  readonly changeEdit: (value: string) => void;
  readonly report: (messageId: string) => void;
  readonly remove: (messageId: string) => void;
  readonly regenerate: (messageId: string) => void;
  /** Make an earlier version of the latest reply current (observed attempt fences it). */
  readonly selectVersion: (messageId: string, ordinal: number, attempt: number) => void;
  readonly play: (messageId: string, text: string) => void;
  readonly confirmVoice: (confirmation: VoiceConfirmation) => void;
  readonly dismissVoice: () => void;
  readonly retryAttachment: (attachment: ChatAttachment, authority?: GenerationQuoteAuthority) => Promise<void>;
  readonly refreshAttachments: () => Promise<void>;
  readonly addToIdentity: (mediaAssetId: string, characterId: string | null) => void;
  readonly identityFeedback: (mediaAssetId: string, feedback: "identity_match" | "identity_mismatch") => void;
  readonly moreLikeThis: (mediaAssetId: string) => void;
  readonly animate: (mediaAssetId: string, characterId: string | null) => void;
  readonly continueReply: () => void;
};

// Conversation-wide inputs of attachment cards; memoized by the list.
export type ChatAttachmentContext = {
  readonly conversationId: string;
  readonly executionSessionId: string;
  readonly characterId: string | null;
  readonly canUpdateIdentity: boolean;
  readonly receiptOwnerScope: string | null;
  readonly retryingImageIds: ReadonlySet<string>;
  readonly variationPendingMediaId: string | null;
  readonly videoEnabled: boolean;
  readonly paymentHref: string;
  readonly fetchForViewer: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export type ChatMessageEditing = {
  readonly content: string;
  readonly originalContent: string;
  readonly pending: boolean;
};

export type ChatMessageItemProps = {
  readonly message: ChatMessage;
  readonly groupMode: boolean;
  readonly canEdit: boolean;
  readonly canRegenerate: boolean;
  readonly canDelete: boolean;
  /** The reply hit the length limit and a plain "Continue" can be sent now. */
  readonly canContinue: boolean;
  readonly deleteConfirm: boolean;
  readonly actionsPending: boolean;
  readonly voiceState?: "loading" | "playing";
  readonly voiceConfirmation: VoiceConfirmation | null;
  readonly editing: ChatMessageEditing | null;
  readonly attachmentContext: ChatAttachmentContext;
  readonly handlers: ChatMessageHandlers;
};

export const ChatMessageItem = memo(function ChatMessageItem({
  message,
  groupMode,
  canEdit,
  canRegenerate,
  canDelete,
  canContinue,
  deleteConfirm,
  actionsPending,
  voiceState,
  voiceConfirmation,
  editing,
  attachmentContext,
  handlers,
}: ChatMessageItemProps) {
  const isUser = message.role === "user";
  const replyInProgress = chatStreamMessageIsInProgress(message);
  const isEditing = editing !== null;
  const showMessageActions = !isEditing && !replyInProgress && !isLocalChatMessageId(message.id);
  const versions = !isUser && canRegenerate && !replyInProgress && !isEditing ? message.replyVersions ?? [] : [];
  // Browsing versions is local; only "Use this reply" changes the conversation.
  // The preview belongs to the attempt it was opened on.
  const [preview, setPreview] = useState<{ attempt: number | undefined; ordinal: number } | null>(null);
  const previewVersion = preview && preview.attempt === message.attempt
    ? versions.find((version) => version.ordinal === preview.ordinal && !version.current) ?? null
    : null;
  const shownContent = previewVersion?.content ?? message.content;
  const canPlayMessage = !isUser && message.status === "sent" && !previewVersion && Boolean(message.content.trim());
  return (
    <div
      aria-busy={!isUser && replyInProgress}
      aria-label={isUser ? "Your message" : "Assistant message"}
      className={`group relative min-w-0 max-w-full break-words rounded-[16px] px-4 py-3 text-[15px] leading-6 md:max-w-[78%] md:text-[14px] ${
        isUser
          ? "ml-auto bg-white text-[rgb(13,13,13)]"
          : "bg-[rgb(36,36,36)] text-white"
      }`}
      data-message-id={message.id}
      data-testid={`chat-message-${message.role}`}
    >
      {groupMode && message.speakerName ? <p className="mb-1 text-xs font-bold opacity-75">{isUser ? `You → ${message.speakerName}` : message.speakerName}</p> : null}
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            handlers.saveEdit(false);
          }}
        >
          <label className="sr-only" htmlFor={`edit-${message.id}`}>
            Edit message
          </label>
          <ChatEditTextarea id={`edit-${message.id}`} editing={editing} handlers={handlers} />
          <div className="flex flex-wrap gap-2">
            <button
              className="inline-flex h-9 items-center gap-2 rounded-full bg-[rgb(13,13,13)] px-3 text-[12px] font-black uppercase text-white disabled:opacity-50"
              data-testid="chat-save-edit"
              disabled={editing.pending || !editing.content.trim()}
              type="submit"
            >
              {editing.pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Save
            </button>
            {editing.content.trim() && editing.content.trim() !== editing.originalContent ? (
              <button
                aria-label="Save edit as paid image request"
                className="inline-flex h-9 items-center gap-2 rounded-full bg-black/10 px-3 text-[12px] font-black text-[rgb(13,13,13)] disabled:opacity-50"
                disabled={editing.pending}
                onClick={() => handlers.saveEdit(true)}
                title="Save edit as paid image request (uses Dreamcoins)"
                type="button"
              >
                Paid image
              </button>
            ) : null}
            <button
              className="inline-flex h-9 items-center gap-2 rounded-full bg-black/10 px-3 text-[12px] font-black uppercase text-[rgb(13,13,13)]"
              data-testid="chat-cancel-edit"
              disabled={editing.pending}
              onClick={handlers.cancelEdit}
              type="button"
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </button>
          </div>
        </form>
      ) : !isUser && message.status === "blocked" && !message.content.trim() ? (
        BLOCKED_ASSISTANT_NOTICE
      ) : !isUser && replyInProgress ? (
        <>
          {message.content ? <MessageText text={message.content} /> : null}
          <span
            aria-label="Assistant is typing"
            className={`inline-flex items-center gap-1 py-0.5 ${message.content.trim() ? "ml-2" : ""}`}
            role="status"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/60 [animation-delay:-0.3s] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/60 [animation-delay:-0.15s] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/60 [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none" />
          </span>
        </>
      ) : !isUser && !previewVersion && !message.content.trim() && !(message.attachments ?? []).length ? (
        <span aria-label="Assistant reply unavailable" role="status">
          {message.status === "cancelled"
            ? "Reply stopped."
            : message.status === "failed" && replyFailureCode(message) === "admission_expired"
              ? "This reply didn't start in time. Your message is saved — regenerate to try again."
              : message.status === "failed" && message.replyInterrupted
                ? "Reply interrupted. Your message is saved. Regenerate to try again."
                : "Reply unavailable."}
        </span>
      ) : (
        <MessageText text={shownContent} />
      )}
      {versions.length + (versions.some((version) => version.current) ? 0 : 1) > 1 ? (
        <ReplyVersionSwitcher
          versions={versions}
          shownOrdinal={previewVersion?.ordinal ?? versions.find((version) => version.current)?.ordinal ?? null}
          pending={actionsPending}
          onShow={(ordinal) => setPreview(ordinal === null ? null : { attempt: message.attempt, ordinal })}
          onUse={previewVersion && typeof message.attempt === "number"
            ? () => handlers.selectVersion(message.id, previewVersion.ordinal, message.attempt!)
            : undefined}
        />
      ) : null}
      {!isUser && message.memoryEnabled === false ? (
        <p className="mt-2 text-[11px] leading-4 text-white/60" data-testid="chat-private-turn">
          Not saved to long-term memory. This turn stays in chat history.
        </p>
      ) : null}
      {!isUser && message.status === "sent" && message.replyLimitReached === true ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px] leading-4 text-white/60" data-testid="chat-reply-limit" role="status">
          {canContinue ? "Reply reached the length limit." : "Reply reached the length limit. Ask the character to continue."}
          {canContinue ? (
            <button
              className="inline-flex min-h-9 items-center rounded-full bg-white px-3 text-[12px] font-bold text-[rgb(13,13,13)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff7ac8] disabled:opacity-50"
              data-testid="chat-continue-reply"
              disabled={actionsPending}
              onClick={handlers.continueReply}
              type="button"
            >
              Continue
            </button>
          ) : null}
        </p>
      ) : null}
      {(message.attachments ?? []).length > 0 ? (
        <ChatMessageAttachments message={message} context={attachmentContext} handlers={handlers} />
      ) : null}
      {showMessageActions ? (
        <MessageActions
          isUser={isUser}
          pending={actionsPending}
          prominent={canEdit || canRegenerate || canDelete}
          voiceState={voiceState}
          onEdit={canEdit ? () => handlers.beginEdit(message.id) : undefined}
          onReport={() => handlers.report(message.id)}
          onDelete={canDelete ? () => handlers.remove(message.id) : undefined}
          deleteConfirm={canDelete && deleteConfirm}
          onRegenerate={canRegenerate ? () => handlers.regenerate(message.id) : undefined}
          onPlay={canPlayMessage ? () => handlers.play(message.id, message.content) : undefined}
        />
      ) : null}
      {voiceConfirmation ? (
        <div role="group" aria-label="Voice playback price" className="mt-3 border-t border-white/15 pt-3 text-sm leading-6">
          <p className="font-semibold">{voiceConfirmation.quote.maxCostDreamcoins === 0
            ? "Play using your included voice minutes · no coin charge"
            : `Play voice · up to ${voiceConfirmation.quote.maxCostDreamcoins} Dreamcoins`}</p>
          <p className="mt-1 text-white/80">{voiceConfirmation.quote.allowanceMinutes > 0
            ? "Included minutes are used first. If they do not cover this clip, the charge will not exceed this amount."
            : "Paid per clip with the standard voice. Premium adds monthly voice minutes and the Character's own voice."} Your balance: {voiceConfirmation.quote.balance} coins.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" data-testid="chat-confirm-voice" className="min-h-11 rounded-full bg-white px-4 py-2 font-bold text-[rgb(13,13,13)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              onClick={() => handlers.confirmVoice(voiceConfirmation)}>Confirm and play</button>
            <button type="button" className="min-h-11 rounded-full bg-white/10 px-4 py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" onClick={handlers.dismissVoice}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
});

// SPEC: The edit box takes focus with the caret at the end. Enter saves,
//       Shift+Enter adds a line, Escape cancels; IME composition is left alone.
function ChatEditTextarea({ id, editing, handlers }: Readonly<{
  id: string;
  editing: ChatMessageEditing;
  handlers: ChatMessageHandlers;
}>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);
  return (
    <textarea
      className="min-h-24 w-full resize-y rounded-[12px] border border-black/10 bg-white/80 p-3 text-[14px] font-medium text-[rgb(13,13,13)] outline-none focus:border-[rgb(253,95,194)]"
      data-testid="chat-edit-input"
      disabled={editing.pending}
      id={id}
      onChange={(event) => handlers.changeEdit(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          handlers.cancelEdit();
          return;
        }
        if (event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        if (editing.content.trim() && !editing.pending) handlers.saveEdit(false);
      }}
      ref={ref}
      value={editing.content}
    />
  );
}

// SPEC: browse the latest reply's versions (oldest first) and adopt one.
function ReplyVersionSwitcher({ versions, shownOrdinal, pending, onShow, onUse }: Readonly<{
  versions: ReadonlyArray<{ ordinal: number; content: string; current: boolean }>;
  /** null: the current reply has no text version (it failed or was stopped). */
  shownOrdinal: number | null;
  pending: boolean;
  onShow: (ordinal: number | null) => void;
  onUse?: () => void;
}>) {
  // A reply that failed after a regenerate is the last, text-less slot.
  const slots: Array<number | null> = versions.some((version) => version.current)
    ? versions.map((version) => version.ordinal)
    : [...versions.map((version) => version.ordinal), null];
  const index = Math.max(0, slots.indexOf(shownOrdinal));
  const go = (step: number) => {
    const next = Math.min(slots.length - 1, Math.max(0, index + step));
    const ordinal = slots[next] ?? null;
    const current = versions.find((version) => version.current)?.ordinal ?? null;
    onShow(ordinal === current ? null : ordinal);
  };
  const position = index + 1;
  const button = "inline-flex h-9 w-9 items-center justify-center rounded-full text-white/80 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-40";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1 text-[12px] text-white/70" data-testid="chat-reply-versions" role="group" aria-label="Reply versions">
      <button aria-label="Previous version" className={button} disabled={pending || position <= 1} onClick={() => go(-1)} type="button">
        <ChevronLeft aria-hidden className="h-4 w-4" />
      </button>
      <span aria-live="polite" className="min-w-10 text-center tabular-nums">{position} / {slots.length}</span>
      <button aria-label="Next version" className={button} disabled={pending || position >= slots.length} onClick={() => go(1)} type="button">
        <ChevronRight aria-hidden className="h-4 w-4" />
      </button>
      {onUse ? (
        <button
          className="ml-1 inline-flex min-h-9 items-center rounded-full bg-white px-3 text-[12px] font-bold text-[rgb(13,13,13)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff7ac8] disabled:opacity-50"
          data-testid="chat-use-reply-version"
          disabled={pending}
          onClick={onUse}
          type="button"
        >
          Use this reply
        </button>
      ) : null}
    </div>
  );
}

// Main may name why a reply failed; only known codes change the copy.
function replyFailureCode(message: ChatMessage): string | null {
  return message.failureCode ?? null;
}

// Paragraphs and line breaks the character wrote are part of the reply.
function MessageText({ text }: Readonly<{ text: string }>) {
  return (
    <span className="whitespace-pre-wrap [overflow-wrap:anywhere]" data-chat-text="">
      <ChatMessageText text={text} />
    </span>
  );
}

function ChatMessageAttachments({ message, context, handlers }: Readonly<{
  message: ChatMessage;
  context: ChatAttachmentContext;
  handlers: ChatMessageHandlers;
}>) {
  const characterId = message.characterId ?? context.characterId;
  return (
    <div className="mt-3 space-y-2">
      {message.attachments?.map((attachment) => attachment.status === "awaiting_confirmation" ? (
        attachment.confirmationKind === "paid_media_quote" ? (
          <ChatMediaQuoteCard
            key={attachment.id}
            attachmentId={attachment.id}
            kind={attachment.kind === "generated_video" ? "generated_video" : "generated_image"}
            costDreamcoins={typeof attachment.costDreamcoins === "number" && attachment.costDreamcoins > 0 ? attachment.costDreamcoins : null}
            ownerScope={context.receiptOwnerScope}
            paymentHref={context.paymentHref}
            fetchForViewer={context.fetchForViewer}
            onChanged={handlers.refreshAttachments}
          />
        ) : (
          <ChatImageEditReviewCard
            key={attachment.id} attachmentId={attachment.id} ownerScope={context.receiptOwnerScope}
            fetchForViewer={context.fetchForViewer} onChanged={handlers.refreshAttachments}
          />
        )
      ) : attachment.kind === "generated_video" ? <ChatVideoAttachmentCard
          attachment={attachment} key={attachment.id} ownerScope={context.receiptOwnerScope}
          retryPending={context.retryingImageIds.has(attachment.id)} onRetry={authority => handlers.retryAttachment(attachment, authority)} onCancelled={handlers.refreshAttachments}
        /> : (
        <ChatImageAttachmentCard
          attachment={attachment}
          canAddToIdentity={context.canUpdateIdentity}
          characterId={characterId}
          generateHref={chatGenerationHref({ characterId, sessionId: message.sessionId ?? context.executionSessionId, message, mediaAssetId: attachment.mediaAssetId })}
          key={attachment.id}
          paymentHref={context.paymentHref}
          onAddToIdentity={
            attachment.mediaAssetId
              ? () => handlers.addToIdentity(attachment.mediaAssetId as string, characterId)
              : undefined
          }
          onRetry={() => void handlers.retryAttachment(attachment)}
          onAnimate={context.videoEnabled && attachment.status === "completed" && attachment.mediaAssetId && context.receiptOwnerScope
            ? () => handlers.animate(attachment.mediaAssetId!, characterId) : undefined}
          retryPending={context.retryingImageIds.has(attachment.id)}
          onIdentityMatch={
            attachment.mediaAssetId
              ? () => handlers.identityFeedback(attachment.mediaAssetId as string, "identity_match")
              : undefined
          }
          onIdentityMismatch={
            attachment.mediaAssetId
              ? () => handlers.identityFeedback(attachment.mediaAssetId as string, "identity_mismatch")
              : undefined
          }
          onMoreLikeThis={
            attachment.mediaAssetId
              ? () => handlers.moreLikeThis(attachment.mediaAssetId as string)
              : undefined
          }
          moreLikeThisPending={attachment.mediaAssetId === context.variationPendingMediaId}
        />
      ))}
    </div>
  );
}
