"use client";

import { useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { RuntimeChatMessage as ChatMessage, RuntimeChatSession as ChatSession } from "@/lib/public-api-contracts";
import { chatFailureCopy } from "@/lib/chat-failure-copy";
import { isLocalChatMessageId } from "./chat-message-actions";

type ChatStreamMessage = {
  readonly content: string;
  readonly role: string;
  readonly status?: string | null;
};
type ChatStreamAuthorityOutcome = "in_progress" | "terminal_content" | "terminal_empty";
type LocalStreamState = { readonly attempt?: number; readonly content: string; readonly stopped: boolean };
const STOPPED_REPLY_STATUS = "cancelled";

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
  if (record.code === "agent_run_interrupted") {
    return "Reply interrupted. Your message is saved. Regenerate to try again.";
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
  messages: readonly (ChatStreamMessage & { readonly attachments?: readonly unknown[] | null })[],
) {
  const latest = messages.at(-1);
  if (!latest) return false;
  if (latest.status === "cancelled") return false;
  // An attachment card already states why this turn has no text.
  if (latest.attachments?.length) return false;
  return chatStreamMessageIsTerminal(latest) && !latest.content.trim();
}

function mergeCanonicalMessages(
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const replacements = new Map(incoming.map((message) => [message.id, message]));
  const merged = current.map((message) => replacements.get(message.id) ?? message);
  const existingIds = new Set(current.map((message) => message.id));
  return [
    ...merged,
    ...incoming.filter((message) => !existingIds.has(message.id)),
  ];
}

// SPEC: Main's in-progress snapshot can contain less text than this browser
//       has already streamed. Reapply that text until Main commits the terminal
//       reply, so polling and Call receipts cannot blank a visible bubble.
// INVARIANT: a row Main reports as terminal always wins — including a shorter
//            moderated rewrite of what streamed. Only the mid-stream hole is
//            filled locally.
function applyLocalStreamState(
  messages: ChatMessage[],
  localState: ReadonlyMap<string, LocalStreamState>,
): ChatMessage[] {
  if (localState.size === 0) return messages;
  return messages.map((message) => {
    const local = localState.get(message.id);
    if (!local || local.attempt !== message.attempt) return message;
    if (chatStreamMessageIsTerminal(message) && message.status !== STOPPED_REPLY_STATUS) {
      return message;
    }
    if (local.stopped) {
      return { ...message, content: local.content, status: STOPPED_REPLY_STATUS };
    }
    if (chatStreamMessageIsTerminal(message)) return message;
    return local.content.length > message.content.length
      ? { ...message, content: local.content }
      : message;
  });
}


type DeliveryOptions = {
  conversationId: string;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  readSession: (signal?: AbortSignal) => Promise<ChatSession>;
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  onSession: (session: ChatSession) => void;
  onRepliesInvalidated: (messageIds: readonly string[]) => void;
  onStatus: (status: string | null) => void;
};

// Main owns durable replies. This module owns only their browser delivery:
// attempt identity, provisional text, stream identity and read validity travel
// together so callers cannot accidentally reconnect or stop an obsolete attempt.
export function useChatReplyDelivery(options: DeliveryOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const mountedRef = useRef(true);
  const lifecycleRef = useRef(0);
  const sessionMutationEpochRef = useRef(0);
  const localStreamStateRef = useRef(new Map<string, LocalStreamState>());
  const observedRepliesRef = useRef(new Map<string, { attempt: number; terminal: boolean }>());
  const streamSources = useRef(new Map<string, EventSource>());
  const stoppingRef = useRef(false);
  const stoppingAttemptsRef = useRef(new Map<string, number>());
  const [stopping, setStopping] = useState(false);

  useLayoutEffect(() => {
    mountedRef.current = true;
    const sources = streamSources.current;
    const local = localStreamStateRef.current;
    const replies = observedRepliesRef.current;
    const cancellations = stoppingAttemptsRef.current;
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      sessionMutationEpochRef.current += 1;
      for (const source of sources.values()) source.close();
      sources.clear();
      local.clear();
      replies.clear();
      cancellations.clear();
    };
  }, []);

  const setMessages: DeliveryOptions["setMessages"] = (value) => {
    if (mountedRef.current) latest.current.setMessages(value);
  };
  const setStatus = (value: string | null) => {
    if (mountedRef.current) latest.current.onStatus(value);
  };
  const fetchForSession: DeliveryOptions["request"] = (...args) => latest.current.request(...args);

  // A successful write may outlive an ordinary focus read, but never access
  // revocation or unmount. Read ordering and owner lifetime are distinct.
  function currentLifecycle() {
    const lifecycle = lifecycleRef.current;
    return () => mountedRef.current && lifecycle === lifecycleRef.current;
  }

  // Media receipts, speaker changes and replies share the same conversation
  // validity. Callers get a capability, never the counter or stream registries.
  function context({ invalidate = false, isCurrent: callerIsCurrent = () => true }: {
    invalidate?: boolean;
    isCurrent?: () => boolean;
  } = {}) {
    if (invalidate) sessionMutationEpochRef.current += 1;
    const epoch = sessionMutationEpochRef.current;
    const isActive = currentLifecycle();
    const isCurrent = () => isActive() && epoch === sessionMutationEpochRef.current && callerIsCurrent();
    return {
      isCurrent,
      receiveTurn(...args: Parameters<typeof receiveTurn>) {
        if (isActive()) receiveTurn(...args);
      },
      async refresh(signal?: AbortSignal): Promise<ChatSession | null> {
        if (!isCurrent() || signal?.aborted) return null;
        const session = await latest.current.readSession(signal);
        if (!isCurrent() || signal?.aborted || !applySession(session)) return null;
        resumePendingStreams(session.messages);
        return session;
      },
    };
  }

  function refresh(signal?: AbortSignal) { return context().refresh(signal); }

  function reset() {
    lifecycleRef.current += 1;
    sessionMutationEpochRef.current += 1;
    for (const source of streamSources.current.values()) source.close();
    streamSources.current.clear();
    localStreamStateRef.current.clear();
    observedRepliesRef.current.clear();
    stoppingAttemptsRef.current.clear();
    stoppingRef.current = false;
    setStopping(false);
  }

  function invalidateReplies(messageIds: readonly string[]) {
    for (const messageId of messageIds) {
      localStreamStateRef.current.delete(messageId);
      streamSources.current.get(messageId)?.close();
      streamSources.current.delete(messageId);
    }
    latest.current.onRepliesInvalidated(messageIds);
  }

  function applySession(session: ChatSession): boolean {
    if (!mountedRef.current || session.id !== latest.current.conversationId) return false;
    if (session.messages.some(replyHasRegressed)) return false;
    let recoveredStream = false;
    const invalidated: string[] = [];
    for (const message of session.messages) {
      const observed = observedRepliesRef.current.get(message.id);
      const local = localStreamStateRef.current.get(message.id);
      if ((typeof message.attempt === "number" && observed !== undefined && message.attempt > observed.attempt)
        || (local && local.attempt !== message.attempt)) invalidated.push(message.id);
      if (observeReply(message)) recoveredStream = true;
    }
    if (invalidated.length) {
      sessionMutationEpochRef.current += 1;
      invalidateReplies(invalidated);
    }
    if (recoveredStream) setStatus(null);
    const delivered = applyLocalStreamState(session.messages, localStreamStateRef.current);
    setMessages(current => [
      ...delivered,
      ...current.filter(message => isLocalChatMessageId(message.id)),
    ]);
    latest.current.onSession(session);
    return true;
  }

  function replyHasRegressed(message: ChatMessage) {
    if (typeof message.attempt !== "number") return false;
    const observed = observedRepliesRef.current.get(message.id);
    // Main restarts failed/cancelled replies only by incrementing the attempt.
    // Keep terminal payloads refreshable (for example, delivered attachments),
    // but never let an older read or admission ACK make that attempt active again.
    return observed !== undefined && (observed.attempt > message.attempt
      || (observed.attempt === message.attempt && observed.terminal && !chatStreamMessageIsTerminal(message)));
  }

  // Both session snapshots and Voice Call receipts can deliver Main's terminal
  // row before SSE finishes. Revoke that source before any queued delta can run.
  function observeReply(message: ChatMessage) {
    const terminal = chatStreamMessageIsTerminal(message);
    if (typeof message.attempt === "number") observedRepliesRef.current.set(message.id, { attempt: message.attempt, terminal });
    if (!terminal) return false;
    if (message.status !== STOPPED_REPLY_STATUS) localStreamStateRef.current.delete(message.id);
    const source = streamSources.current.get(message.id);
    if (!source) return false;
    source.close();
    streamSources.current.delete(message.id);
    return true;
  }

  function receiveTurn(
    { userMessage, assistant, streamUrl }: { userMessage: ChatMessage; assistant: ChatMessage; streamUrl?: string | null },
    optimisticMessageId?: string,
  ) {
    if (!mountedRef.current) return;
    context({ invalidate: true });
    const observed = observedRepliesRef.current.get(assistant.id);
    if (typeof assistant.attempt === "number") {
      if (replyHasRegressed(assistant)) {
        setMessages(current => current.filter(message => message.id !== optimisticMessageId));
        return;
      }
      if (observed !== undefined && observed.attempt < assistant.attempt) invalidateReplies([assistant.id]);
    }
    if (observeReply(assistant)) setStatus(null);
    // Typed sends replace their optimistic bubble and start with an empty stream.
    // Voice Call receipts can already carry a partial reply; retain that text.
    const typedStream = Boolean(optimisticMessageId && streamUrl && assistant.status !== "blocked");
    const delivered = applyLocalStreamState(
      [userMessage, typedStream ? { ...assistant, content: "" } : assistant],
      localStreamStateRef.current,
    );
    setMessages(current => mergeCanonicalMessages(
      current.filter(message => message.id !== optimisticMessageId),
      delivered,
    ));
    if (assistant.status === "blocked") {
      if (optimisticMessageId) setStatus("That message was blocked by our safety policy.");
    } else if (streamUrl && (optimisticMessageId ? assistant.status === "generating" : chatStreamMessageIsInProgress(assistant))) {
      streamAssistant(streamUrl, assistant.id, assistant.content);
    }
  }

  async function edit(messageId: string, content: string): Promise<"applied" | "quota_exhausted" | "failed"> {
    const isActive = currentLifecycle();
    context({ invalidate: true });
    let accepted = false;
    try {
      const response = await fetchForSession(`/api/v1/messages/${encodeURIComponent(messageId)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }),
      });
      if (!isActive()) return "failed";
      if (response.status === 402) {
        setStatus("Daily free message limit reached.");
        return "quota_exhausted";
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        if (isActive()) setStatus(chatFailureCopy(failure, "Couldn't edit the message. Please try again."));
        return "failed";
      }
      const payload = await response.json() as { assistantMessageId?: string; streamUrl?: string | null; status?: "pending" | "generating" | "blocked" };
      if (!isActive()) return "failed";
      accepted = true;
      // Also reject GETs started while PATCH was in flight.
      const revision = context({ invalidate: true });
      if (payload.assistantMessageId) invalidateReplies([payload.assistantMessageId]);
      const session = await revision.refresh();
      if (!session) return "applied";
      if (payload.status === "blocked" || !payload.streamUrl) {
        if (payload.status === "blocked") setStatus("That message was blocked by our safety policy.");
      } else if (!payload.assistantMessageId) {
        setStatus("Couldn't edit the message. Please try again.");
      } else if (payload.status === "generating") {
        streamAssistant(payload.streamUrl, payload.assistantMessageId, "");
      }
      return "applied";
    } catch {
      if (isActive()) setStatus("Couldn't edit the message. Please try again.");
      return accepted ? "applied" : "failed";
    }
  }

  async function regenerate(messageId: string) {
    const isActive = currentLifecycle();
    context({ invalidate: true });
    try {
      const response = await fetchForSession(`/api/v1/messages/${encodeURIComponent(messageId)}/regenerate`, { method: "POST" });
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        if (isActive()) setStatus(chatFailureCopy(failure, "Couldn't regenerate. Please try again."));
        return;
      }
      const payload = await response.json() as { assistantMessageId?: string; attempt?: number; streamUrl?: string | null; status?: "pending" | "generating" };
      if (!isActive()) return;
      const newId = payload.assistantMessageId;
      if (!newId || !payload.streamUrl || typeof payload.attempt !== "number" || !Number.isSafeInteger(payload.attempt) || payload.attempt <= 0) {
        setStatus("Couldn't regenerate. Please try again.");
        return;
      }
      context({ invalidate: true });
      if (replyHasRegressed({ id: newId, role: "assistant", attempt: payload.attempt, content: "", status: payload.status ?? "pending" })) return;
      invalidateReplies([messageId]);
      observedRepliesRef.current.set(newId, { attempt: payload.attempt, terminal: false });
      setMessages(current => current.map(message => message.id === messageId
        ? { ...message, id: newId, attempt: payload.attempt, content: "", status: payload.status ?? "pending" }
        : message));
      if (payload.status === "generating") streamAssistant(payload.streamUrl, newId, "");
    } catch {
      if (isActive()) setStatus("Couldn't regenerate. Please try again.");
    }
  }

  function removeTurn(messageId: string) {
    if (!mountedRef.current) return;
    context({ invalidate: true });
    const messages = latest.current.messages;
    const target = messages.find(message => message.id === messageId);
    const userMessageId = target?.role === "user" ? target.id : target?.replyToMessageId;
    // Main deletes one complete Turn from either message id.
    const belongsToTurn = (message: ChatMessage) => message.id === messageId
      || (userMessageId !== undefined && (message.id === userMessageId || message.replyToMessageId === userMessageId));
    invalidateReplies([...new Set([messageId, ...messages.filter(belongsToTurn).map(message => message.id)])]);
    setMessages(current => current.filter(message => !belongsToTurn(message)));
  }

  function resumePendingStreams(loadedMessages: ChatMessage[]) {
    for (const message of loadedMessages) {
      if (
        message.role === "assistant" &&
        !message.content.trim() &&
        message.status === "generating" &&
        typeof message.attempt === "number" && Number.isSafeInteger(message.attempt) && message.attempt > 0 &&
        observedRepliesRef.current.get(message.id)?.attempt === message.attempt
      ) {
        streamAssistant(
          `/api/v1/chat/messages/${encodeURIComponent(message.id)}/stream?attempt=${message.attempt}`,
          message.id,
          "",
        );
      }
    }
  }

  function streamAssistant(streamUrl: string, assistantId: string, fallback: string) {
    if (!mountedRef.current) return;
    const requestedAttempt = new URL(streamUrl, window.location.origin).searchParams.get("attempt");
    const attempt = Number(requestedAttempt);
    const local = localStreamStateRef.current.get(assistantId);
    // A lagging generating snapshot cannot undo an in-flight or acknowledged
    // exact-attempt Stop. Failed cancellation clears this fence before recovery.
    if (!Number.isSafeInteger(attempt) || attempt <= 0
      || replyHasRegressed({ id: assistantId, role: "assistant", attempt, content: "", status: "generating" })
      || stoppingAttemptsRef.current.get(assistantId) === attempt
      || (local?.attempt === attempt && local.stopped)
      || streamSources.current.has(assistantId)) return;
    observedRepliesRef.current.set(assistantId, { attempt, terminal: false });
    let streamed = "";
    let finished = false;
    const source = new EventSource(streamUrl);
    streamSources.current.set(assistantId, source);
    localStreamStateRef.current.set(assistantId, { attempt, content: "", stopped: false });

    const close = () => {
      source.close();
      // A late recovery from the previous attempt must not close the newer
      // EventSource registered under the same durable assistant message id.
      if (streamSources.current.get(assistantId) !== source) return;
      streamSources.current.delete(assistantId);
      if (!localStreamStateRef.current.get(assistantId)?.stopped) {
        localStreamStateRef.current.delete(assistantId);
      }
    };

    const finish = async () => {
      if (finished) return;
      finished = true;
      const recovery = context();
      if (!streamed && fallback) {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId ? { ...message, content: fallback } : message,
          ),
        );
      }
      const outcome = await recoverAssistantFromSession(assistantId);
      if (!recovery.isCurrent()) return;
      if (!streamed && !fallback && outcome === "terminal_empty") {
        setMessages((current) => current.filter((message) => message.id !== assistantId));
        setStatus("Reply failed to load. Please try again.");
      }
    };

    source.addEventListener("delta", (event) => {
      if (finished || streamSources.current.get(assistantId) !== source) return;
      const data = parseStreamEvent(event);
      const delta = typeof data.delta === "string" ? data.delta : "";
      streamed += delta;
      localStreamStateRef.current.set(assistantId, {
        attempt,
        content: streamed,
        stopped: false,
      });
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, content: streamed } : message,
        ),
      );
    });

    source.addEventListener("replace", (event) => {
      if (finished || streamSources.current.get(assistantId) !== source) return;
      const data = parseStreamEvent(event);
      streamed = typeof data.content === "string" ? data.content : "";
      localStreamStateRef.current.set(assistantId, {
        attempt,
        content: streamed,
        stopped: false,
      });
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, content: streamed } : message,
        ),
      );
    });

    source.addEventListener("done", () => {
      if (finished || streamSources.current.get(assistantId) !== source) return;
      setStatus(null);
      void finish().finally(close);
    });

    source.addEventListener("error", (event) => {
      if (finished || streamSources.current.get(assistantId) !== source) return;
      const payload = parseStreamEvent(event);
      if (chatStreamErrorDisposition(payload) === "reconnect") {
        // HTTP/auth/protocol failures can leave EventSource CLOSED, where it
        // will never reconnect itself. Let the authority poll reopen this same
        // attempt instead of retaining a dead source in the registry.
        if (source.readyState === EventSource.CLOSED) close();
        setStatus("Reply interrupted. Reconnecting…");
        return;
      }
      finished = true;
      const recovery = context();
      const terminalMessage = chatStreamTerminalErrorMessage(payload);
      void recoverAssistantFromSession(assistantId).finally(() => {
        if (recovery.isCurrent()) setStatus(terminalMessage);
        close();
      });
    });
  }

  // SPEC: Main owns Stop's exact-attempt terminal transition. The browser closes
  // SSE immediately, then applies only the matching durable cancellation ACK.
  async function stop() {
    if (stoppingRef.current || !mountedRef.current) return;
    const isActive = currentLifecycle();
    const messages = latest.current.messages;
    const stoppedReplies = messages.flatMap((message) => {
      if (!chatStreamMessageIsInProgress(message) || typeof message.attempt !== "number"
        || !Number.isSafeInteger(message.attempt) || message.attempt <= 0) return [];
      const local = localStreamStateRef.current.get(message.id);
      return [{ messageId: message.id, attempt: message.attempt,
        content: local?.attempt === message.attempt ? local.content : message.content }];
    });
    if (stoppedReplies.length === 0) return;
    sessionMutationEpochRef.current += 1;
    for (const { messageId, attempt } of stoppedReplies) {
      stoppingAttemptsRef.current.set(messageId, attempt);
      if (observedRepliesRef.current.get(messageId)?.attempt !== attempt) continue;
      streamSources.current.get(messageId)?.close();
      streamSources.current.delete(messageId);
    }
    stoppingRef.current = true;
    setStopping(true);
    setStatus("Stopping reply…");
    let completionWonRace = false;
    const results = await Promise.all(
      stoppedReplies.map(async ({ messageId, attempt }) => {
        const response = await fetchForSession(
          `/api/v1/messages/${encodeURIComponent(messageId)}/cancel`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attempt }) },
        );
        if (response.ok) {
          const result = await response.json() as { cancelled?: boolean; attempt?: number };
          if (result.attempt !== attempt || typeof result.cancelled !== "boolean") return false;
          completionWonRace ||= result.cancelled === false;
        }
        return response.ok;
      }),
    ).catch(() => [false]);
    // A Stop belongs to the attempt visible when clicked, even if another
    // page has already advanced the same assistant id while its ACK travelled.
    if (!isActive()) return;
    for (const { messageId, attempt } of stoppedReplies) {
      if (stoppingAttemptsRef.current.get(messageId) === attempt) stoppingAttemptsRef.current.delete(messageId);
    }
    const currentReplies = stoppedReplies.filter(({ messageId, attempt }) =>
      observedRepliesRef.current.get(messageId)?.attempt === attempt);
    if (currentReplies.length === 0) {
      setStatus(null);
      stoppingRef.current = false;
      if (mountedRef.current) setStopping(false);
      return;
    }
    if (!results.every(Boolean) || completionWonRace) {
      for (const { messageId, attempt } of currentReplies) {
        if (localStreamStateRef.current.get(messageId)?.attempt === attempt) localStreamStateRef.current.delete(messageId);
      }
      setStatus(completionWonRace ? null : "Couldn't stop the reply. Reconnecting…");
      try {
        await refresh();
      } catch {
        // Keep the explicit reconnecting state; the normal poll loop remains
        // the recovery path when this immediate authority read also fails.
      } finally {
        if (isActive()) {
          stoppingRef.current = false;
          setStopping(false);
        }
      }
      return;
    }
    for (const { messageId, attempt, content } of currentReplies) {
      const local = localStreamStateRef.current.get(messageId);
      localStreamStateRef.current.set(messageId, {
        attempt,
        content: local?.attempt === attempt ? local.content : content,
        stopped: true,
      });
    }
    const stoppedState = new Map(localStreamStateRef.current);
    setMessages(current => applyLocalStreamState(current, stoppedState));
    setStatus("Reply stopped. Regenerate for a new one.");
    stoppingRef.current = false;
    setStopping(false);
  }

  async function recoverAssistantFromSession(assistantId: string): Promise<ChatStreamAuthorityOutcome> {
    const recovery = context();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (attempt > 0) await new Promise(resolve => window.setTimeout(resolve, 500));
      if (!recovery.isCurrent()) return "in_progress";
      try {
        // Terminal recovery must not reopen the stream it is about to close.
        const session = await latest.current.readSession();
        if (!recovery.isCurrent() || !applySession(session)) return "in_progress";
        const assistant = session.messages.find(message => message.id === assistantId);
        if (!assistant || !chatStreamMessageIsTerminal(assistant)) continue;
        return assistant.content.trim() ? "terminal_content" : "terminal_empty";
      } catch {
        // Transient reads do not change the durable attempt; retry, then leave
        // the regular conversation poll in charge of recovery.
      }
    }
    return "in_progress";
  }

  return { stopping, refresh, context, receiveTurn, edit, regenerate, removeTurn, reset, stop };
}

function parseStreamEvent(event: Event): Record<string, unknown> {
  try {
    const data = (event as MessageEvent<string>).data;
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}
