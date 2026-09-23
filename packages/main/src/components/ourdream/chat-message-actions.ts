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

// SPEC: Chat only lets the latest Turn be edited, regenerated or deleted.
// INTENT: the latest Turn is not "the newest user bubble". A proactive Turn has
//         no visible user message (its user side is an internal directive), yet
//         it is the newest Turn: the previous exchange is locked behind it and
//         the proactive reply itself is the one the user can still act on.
//         Every reply names its Turn's user message, so the newest message that
//         names one identifies the latest Turn whether or not it is shown.
export function latestTurnUserMessageId(
  messages: readonly (ChatMessageActionAuthority & { id: string })[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return message.id;
    if (message.role === "assistant" && message.replyToMessageId) return message.replyToMessageId;
  }
  return null;
}
