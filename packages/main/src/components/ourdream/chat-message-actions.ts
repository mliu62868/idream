export type ChatMessageActionAuthority = {
  role: string;
  replyToMessageId?: string | null;
  status?: string | null;
};

// SPEC: An optimistically rendered turn carries a client-minted id until the
//       send response returns the canonical one.
// INTENT: Chat cannot act on an id it has never seen, so every action (edit,
//         delete, report, regenerate) stays hidden until the swap lands.
export const LOCAL_CHAT_MESSAGE_ID_PREFIX = "local:";

export function isLocalChatMessageId(id: string) {
  return id.startsWith(LOCAL_CHAT_MESSAGE_ID_PREFIX);
}

export function canSubmitChatMessage(
  content: string,
  pending: boolean,
  replyInProgress: boolean,
) {
  return Boolean(content.trim()) && !pending && !replyInProgress;
}

export function canRegenerateChatMessage(
  message: ChatMessageActionAuthority,
  replyInProgress: boolean,
) {
  return message.role === "assistant" &&
    Boolean(message.replyToMessageId) &&
    message.status !== "blocked" &&
    !replyInProgress;
}

export function isImmutableOpeningMessage(
  message: ChatMessageActionAuthority,
): boolean {
  // INVARIANT: Chat creates exactly one assistant message without a user
  // parent: the immutable opening. Runtime execution trace stays internal.
  return message.role === "assistant" && message.replyToMessageId === null;
}
