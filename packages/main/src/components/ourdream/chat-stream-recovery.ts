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
  // A browser transport error has no Chat payload and EventSource reconnects
  // automatically. A provider error is terminal only when Chat explicitly says
  // it will not be retried.
  if (typeof record.code !== "string") return "reconnect";
  return record.retryable === true ? "reconnect" : "terminal";
}

export function chatStreamTerminalErrorMessage(payload: unknown): string {
  const record =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
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
