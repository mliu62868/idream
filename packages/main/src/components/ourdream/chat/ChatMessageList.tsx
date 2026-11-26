"use client";

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
  readonly voicePreparingIds: ReadonlySet<string>;
  readonly voicePlayingId: string | null;
  readonly voiceConfirmation: VoiceConfirmation | null;
  readonly attachmentContext: ChatAttachmentContext;
  readonly handlers: ChatMessageHandlers;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly endRef: RefObject<HTMLDivElement | null>;
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
  voicePreparingIds,
  voicePlayingId,
  voiceConfirmation,
  attachmentContext,
  handlers,
  listRef,
  endRef,
}: ChatMessageListProps) {
  return (
    <div ref={listRef} className="mt-6 flex min-h-[55vh] flex-1 flex-col gap-3 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4">
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
  );
}
