"use client";

import { Loader2 } from "lucide-react";
import type { RefObject } from "react";
import type { RuntimeChatMessage as ChatMessage, RuntimeChatSession as ChatSession } from "@/lib/public-api-contracts";
import {
  canRegenerateChatMessage,
  isImmutableOpeningMessage,
} from "../chat-message-actions";
import { ChatMessageItem, type ChatAttachmentContext, type ChatMessageHandlers } from "./ChatMessageItem";
import type { VoiceConfirmation } from "./useVoicePlayback";

export type ChatEditingTarget = { messageId: string; attempt: number; originalContent: string };

export type ChatMessageListProps = {
  readonly messages: readonly ChatMessage[];
  readonly group: ChatSession["group"];
  readonly characterId: string | null;
  readonly readOnly: boolean;
  readonly hasGeneratingReply: boolean;
  readonly latestUserMessageId: string | null;
  readonly latestReplyInProgress: boolean;
  readonly editingTarget: ChatEditingTarget | null;
  readonly editingContent: string;
  readonly editingPending: boolean;
  readonly deleteConfirmMessageId: string | null;
  readonly actionsPending: boolean;
  /** A new message could be sent right now (no reply, write or call in the way). */
  readonly canSendNow: boolean;
  readonly voicePreparingIds: ReadonlySet<string>;
  readonly voicePlayingId: string | null;
  readonly voiceConfirmation: VoiceConfirmation | null;
  readonly attachmentContext: ChatAttachmentContext;
  readonly handlers: ChatMessageHandlers;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly endRef: RefObject<HTMLDivElement | null>;
  readonly earlier?: {
    readonly available: boolean;
    readonly loading: boolean;
    readonly failed: boolean;
    readonly load: () => void | Promise<void>;
  };
};

export function ChatMessageList({
  messages,
  group,
  characterId,
  readOnly,
  hasGeneratingReply,
  latestUserMessageId,
  latestReplyInProgress,
  editingTarget,
  editingContent,
  editingPending,
  deleteConfirmMessageId,
  actionsPending,
  canSendNow,
  voicePreparingIds,
  voicePlayingId,
  voiceConfirmation,
  attachmentContext,
  handlers,
  listRef,
  endRef,
  earlier,
}: ChatMessageListProps) {
  return (
    <div ref={listRef} className="mt-6 flex min-h-[55vh] flex-1 flex-col gap-3 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4">
      {earlier?.available ? (
        <div className="flex flex-col items-center gap-1">
          <button
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 px-4 text-[13px] font-bold text-white/85 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff7ac8] disabled:opacity-60"
            data-testid="chat-load-earlier"
            disabled={earlier.loading}
            onClick={() => void earlier.load()}
            type="button"
          >
            {earlier.loading ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : null}
            {earlier.loading ? "Loading earlier messages…" : "Load earlier messages"}
          </button>
          {earlier.failed ? <p className="text-[12px] text-white/65" role="status">Couldn&apos;t load earlier messages. Try again.</p> : null}
        </div>
      ) : null}
      {/* SPEC: The conversation is a log: assistive tech announces new messages
          politely; a streaming bubble is aria-busy until its reply settles. */}
      <div aria-label="Conversation" aria-live="polite" aria-relevant="additions" className="flex flex-1 flex-col gap-3" role="log">
      {/* 群聊没有开场白：说清楚怎么开始，而不是替角色编一句。 */}
      {group && messages.length === 0 ? (
        <p className="m-auto max-w-md text-center text-sm leading-6 text-white/65" data-testid="group-chat-empty">
          No messages yet. Send a message to {group.members.find(member => member.characterId === characterId)?.name ?? group.members[0].name}, or @mention {group.members.map(member => member.name).join(", ")} to choose who replies.
        </p>
      ) : null}
      {messages.map((message) => {
        const isUser = message.role === "user";
        const immutableOpening = isImmutableOpeningMessage(message);
        const isEditing = editingTarget?.messageId === message.id;
        const canDelete =
          !immutableOpening &&
          !latestReplyInProgress &&
          (message.id === latestUserMessageId ||
            message.replyToMessageId === latestUserMessageId);
        return (
          <ChatMessageItem
            key={message.id}
            message={message}
            groupMode={Boolean(group)}
            canEdit={!readOnly && isUser && message.id === latestUserMessageId && !latestReplyInProgress}
            canRegenerate={!readOnly && !immutableOpening && message.replyToMessageId === latestUserMessageId
              && canRegenerateChatMessage(message, hasGeneratingReply)}
            canDelete={canDelete}
            canContinue={canSendNow && !readOnly && !isUser && message.status === "sent" && message.replyLimitReached === true
              && Boolean(message.replyToMessageId) && message.replyToMessageId === latestUserMessageId
              && (!group || message.characterId === characterId)}
            deleteConfirm={deleteConfirmMessageId === message.id}
            actionsPending={actionsPending}
            voiceState={voicePreparingIds.has(message.id) ? "loading" : voicePlayingId === message.id ? "playing" : undefined}
            voiceConfirmation={voiceConfirmation?.messageId === message.id ? voiceConfirmation : null}
            editing={isEditing && editingTarget
              ? { content: editingContent, originalContent: editingTarget.originalContent, pending: editingPending }
              : null}
            attachmentContext={attachmentContext}
            handlers={handlers}
          />
        );
      })}
      <div ref={endRef} />
      </div>
    </div>
  );
}
