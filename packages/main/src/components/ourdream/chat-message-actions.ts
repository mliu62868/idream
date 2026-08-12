export type ChatMessageActionAuthority = {
  role: string;
  replyToMessageId?: string | null;
  runtimeTrace?: unknown;
  status?: string | null;
};

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
  const trace = message.runtimeTrace;
  return Boolean(
    message.role === "assistant" &&
      message.replyToMessageId === null &&
      trace &&
      typeof trace === "object" &&
      !Array.isArray(trace) &&
      (trace as Record<string, unknown>).schemaVersion === 1 &&
      (trace as Record<string, unknown>).messageKind === "opening" &&
      (trace as Record<string, unknown>).outputAuthority ===
        "immutable_opening",
  );
}

export function chatMessageActionPaddingClass(
  actionCount: number,
  deleteConfirm: boolean,
): string {
  // SPEC: 28px controls + 4px gaps + 8px right inset + 8px content clearance.
  // Delete confirmation replaces one 28px icon with a text control, so reserve
  // another 36px without coupling the message bubble to button labels.
  const count = Math.max(0, Math.min(4, Math.trunc(actionCount)));
  const regular = [
    "pr-4",
    "pr-[44px]",
    "pr-[76px]",
    "pr-[108px]",
    "pr-[140px]",
  ] as const;
  const confirming = [
    "pr-4",
    "pr-[80px]",
    "pr-[112px]",
    "pr-[144px]",
    "pr-[176px]",
  ] as const;
  return (deleteConfirm ? confirming : regular)[count];
}
