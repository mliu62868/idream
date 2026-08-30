type ChatStreamMessage = {
  readonly content: string;
  readonly role: string;
  readonly status?: string | null;
};

type IdentifiedChatStreamMessage = ChatStreamMessage & {
  readonly id: string;
};

export type ChatStreamAuthorityOutcome =
  | "in_progress"
  | "terminal_content"
  | "terminal_empty";

export function chatStreamErrorDisposition(
  payload: unknown,
): "reconnect" | "terminal" {
  const record =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  // INVARIANT: an explicit Chat error is downstream of Main's durable terminal
  // commit. Transport loss has no Chat payload and EventSource may reconnect;
  // a new model attempt is a separate, user-authorized regenerate action.
  if (typeof record.code !== "string") return "reconnect";
  return "terminal";
}

export function chatStreamTerminalErrorMessage(payload: unknown): string {
  const record =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  if (record.code === "reply_cancelled") {
    return "Reply stopped. Regenerate for a new one.";
  }
  if (record.code === "igrep_memory_failed") {
    return "Memory is temporarily unavailable. Please try again.";
  }
  return record.code === "provider_output_limit"
    ? "Reply was cut short. Regenerate to try again."
    : "Reply failed to load. Please try again.";
}

export function chatStreamMessageIsTerminal(message: ChatStreamMessage) {
  if (message.role !== "assistant") return false;
  if (chatStreamMessageIsInProgress(message)) return false;
  if (message.status) return true;
  // Legacy session rows may not carry status. Content is the only terminal
  // evidence in that shape, but it must never override an explicit generating
  // status on current rows.
  return Boolean(message.content.trim());
}

export function chatStreamMessageIsInProgress(message: ChatStreamMessage) {
  return message.role === "assistant" &&
    (message.status === "generating" || message.status === "pending");
}

export function chatStreamMessagesNeedReconciliation(
  messages: readonly ChatStreamMessage[],
) {
  return messages.some(chatStreamMessageIsInProgress);
}

/**
 * SPEC: 只有「当前这一轮」失败才提示重试。
 * INTENT: 判据必须锚在最后一条消息上 —— 历史上任何一次失败的空回复都会永久留在
 *         会话里，扫描整个 messages 会让一条正常会话被那条旧记录永远钉上错误提示。
 */
export function chatStreamLatestReplyFailed(
  messages: readonly ChatStreamMessage[],
) {
  const latest = messages.at(-1);
  if (!latest) return false;
  if (latest.status === "cancelled") return false;
  return chatStreamMessageIsTerminal(latest) && !latest.content.trim();
}

// A stream terminal frame is transport evidence, not the canonical message
// state. Retry transient read failures and stop only when Chat reports a
// terminal row; partial text must never be mistaken for terminal authority.
export async function reconcileChatStreamAuthority<TSession>({
  apply,
  assistantId,
  attempts = 6,
  messages,
  read,
  wait,
}: {
  readonly apply: (session: TSession) => void;
  readonly assistantId: string;
  readonly attempts?: number;
  readonly messages: (session: TSession) => readonly IdentifiedChatStreamMessage[];
  readonly read: () => Promise<TSession>;
  readonly wait: () => Promise<void>;
}): Promise<ChatStreamAuthorityOutcome> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait();
    let session: TSession;
    try {
      session = await read();
    } catch {
      continue;
    }
    apply(session);
    const assistant = messages(session).find(({ id }) => id === assistantId);
    if (!assistant || !chatStreamMessageIsTerminal(assistant)) continue;
    return assistant.content.trim() ? "terminal_content" : "terminal_empty";
  }
  return "in_progress";
}
