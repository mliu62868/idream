// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeChatMessage as ChatMessage, RuntimeChatSession as ChatSession } from "@/lib/public-api-contracts";
import { LOCAL_CHAT_MESSAGE_ID_PREFIX } from "./chat-message-actions";
import {
  chatStreamErrorDisposition,
  chatStreamLatestReplyFailed,
  chatStreamMessageIsInProgress,
  chatStreamMessageIsTerminal,
  chatStreamMessagesNeedReconciliation,
  chatStreamTerminalErrorMessage,
  useChatReplyDelivery,
} from "./chat-reply-delivery";

describe("chat stream recovery", () => {
  it("reconnects only for transport loss without a Chat terminal error", () => {
    expect(chatStreamErrorDisposition({})).toBe("reconnect");
    expect(
      chatStreamErrorDisposition({ code: "provider_failed", retryable: true }),
    ).toBe("terminal");
  });

  it("closes for every explicit stream error", () => {
    expect(
      chatStreamErrorDisposition({ code: "blocked", retryable: false }),
    ).toBe("terminal");
    expect(
      chatStreamTerminalErrorMessage({ code: "provider_output_limit" }),
    ).toBe("Reply was cut short. Regenerate to try again.");
    expect(chatStreamErrorDisposition({ code: "agent_run_interrupted" })).toBe("terminal");
    expect(chatStreamTerminalErrorMessage({ code: "agent_run_interrupted" }))
      .toBe("Reply interrupted. Your message is saved. Regenerate to try again.");
  });

  it("closes a recovered stream once session authority is terminal", () => {
    expect(
      chatStreamMessageIsTerminal({
        role: "assistant",
        status: "sent",
        content: "Recovered reply",
      }),
    ).toBe(true);
    expect(
      chatStreamMessageIsTerminal({
        role: "assistant",
        status: "generating",
        content: "",
      }),
    ).toBe(false);
  });

  it("keeps a stream open when a generating reply already has partial text", () => {
    const partial = {
      role: "assistant",
      status: "generating",
      content: "So, are we just going to stare at the ocean, or",
    };
    expect(chatStreamMessageIsTerminal(partial)).toBe(false);
    expect(chatStreamMessageIsInProgress(partial)).toBe(true);
    expect(chatStreamMessagesNeedReconciliation([partial])).toBe(true);
  });

});

describe("chatStreamLatestReplyFailed", () => {
  it("flags the current turn when its reply came back empty", () => {
    expect(
      chatStreamLatestReplyFailed([
        { role: "user", content: "hi" },
        { role: "assistant", content: "", status: "failed" },
      ]),
    ).toBe(true);
  });

  it("leaves an empty failed turn to its attachment card", () => {
    expect(
      chatStreamLatestReplyFailed([
        { role: "user", content: "photo" },
        { role: "assistant", content: "", status: "failed", attachments: [{ status: "failed" }] },
      ]),
    ).toBe(false);
  });

  it("does not keep flagging a healthy session because an older turn failed", () => {
    expect(
      chatStreamLatestReplyFailed([
        { role: "user", content: "hi" },
        { role: "assistant", content: "", status: "failed" },
        { role: "user", content: "again" },
        { role: "assistant", content: "Here I am.", status: "sent" },
      ]),
    ).toBe(false);
  });

  it("stays quiet while the reply is still generating", () => {
    expect(
      chatStreamLatestReplyFailed([
        { role: "user", content: "hi" },
        { role: "assistant", content: "", status: "generating" },
      ]),
    ).toBe(false);
  });

  it("does not report an intentionally cancelled reply as a failure", () => {
    expect(
      chatStreamLatestReplyFailed([
        { role: "user", content: "hi" },
        { role: "assistant", content: "", status: "cancelled" },
      ]),
    ).toBe(false);
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const opening: ChatMessage = { id: "assistant-0", role: "assistant", content: "Hey there.", status: "sent" };
const userTurn: ChatMessage = { id: "user-1", role: "user", content: "hello there" };
const streamingReply: ChatMessage = {
  id: "assistant-1", role: "assistant", content: "", status: "generating", attempt: 1, replyToMessageId: "user-1",
};
const session = (messages: ChatMessage[]): ChatSession => ({
  id: "session-1", ownerScope: "user:viewer-a", title: "Test chat", characterId: "character-1",
  messages, character: { name: "Avery" },
});

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.OPEN;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  close() { this.closed = true; this.readyState = FakeEventSource.CLOSED; }
  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }
}

describe("reply delivery through its public hook boundary", () => {
  let root: Root;
  let container: HTMLDivElement;
  let messages: ChatMessage[];
  let replaceMessages: (rows: ChatMessage[]) => void;
  let delivery: ReturnType<typeof useChatReplyDelivery>;
  const readSession = vi.fn<(signal?: AbortSignal) => Promise<ChatSession>>();
  const request = vi.fn<typeof fetch>();
  const onSession = vi.fn<(snapshot: ChatSession) => void>();
  const onRepliesInvalidated = vi.fn<(ids: readonly string[]) => void>();
  const onStatus = vi.fn<(status: string | null) => void>();

  function Harness() {
    const [rows, setMessages] = useState<ChatMessage[]>([opening]);
    messages = rows;
    replaceMessages = setMessages;
    delivery = useChatReplyDelivery({
      conversationId: "session-1", messages: rows, setMessages, readSession, request,
      onSession, onRepliesInvalidated, onStatus,
    });
    return null;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    readSession.mockReset().mockResolvedValue(session([opening, userTurn, streamingReply]));
    request.mockReset().mockResolvedValue(Response.json({ cancelled: true, attempt: 1 }));
    onSession.mockReset();
    onRepliesInvalidated.mockReset();
    onStatus.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(Harness)); });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function startReply(assistant = streamingReply) {
    await act(async () => delivery.receiveTurn({
      userMessage: userTurn,
      assistant,
      streamUrl: `/api/v1/chat/messages/${assistant.id}/stream?attempt=${assistant.attempt}`,
    }));
    return FakeEventSource.instances.at(-1)!;
  }

  it("keeps streamed text when the authority poll still has an empty generating row", async () => {
    const stream = await startReply();
    await act(async () => stream.emit("delta", { delta: "Once upon" }));
    await act(async () => { await delivery.refresh(); });

    expect(messages.find(({ id }) => id === streamingReply.id)).toMatchObject({ content: "Once upon", status: "generating" });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(stream.closed).toBe(false);
  });

  it.each([
    { status: "sent", content: "Once upon a time." },
    { status: "blocked", content: "Blocked." },
  ])("yields the stream to the authoritative $status content", async ({ status, content }) => {
    const stream = await startReply();
    await act(async () => stream.emit("delta", { delta: "the raw streamed reply before final authority" }));
    readSession.mockResolvedValue(session([opening, userTurn, { ...streamingReply, content, status }]));
    await act(async () => { await delivery.refresh(); });

    expect(messages.find(({ id }) => id === streamingReply.id)).toMatchObject({ content, status });
    expect(stream.closed).toBe(true);
  });

  it.each(["sent", "failed", "cancelled"])("keeps a %s authority row when an older same-attempt generating poll arrives after done recovery", async (status) => {
    const stream = await startReply();
    await act(async () => stream.emit("delta", { delta: "Provisional reply" }));
    const stale = Promise.withResolvers<ChatSession>();
    const terminal = { ...streamingReply, status, content: status === "failed" ? "" : "Canonical reply" };
    readSession.mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(session([opening, userTurn, terminal]));
    let polling!: ReturnType<typeof delivery.refresh>;
    await act(async () => { polling = delivery.refresh(); });
    await act(async () => stream.emit("done", { attempt: 1 }));
    expect(messages.at(-1)).toEqual(terminal);
    expect(stream.closed).toBe(true);
    await act(async () => {
      stale.resolve(session([opening, userTurn, streamingReply]));
      await polling;
    });

    expect(messages.at(-1)).toEqual(terminal);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(await polling).toBeNull();
  });

  it("keeps terminal authority when the typed send acknowledgement still describes the same generating attempt", async () => {
    const terminal = { ...streamingReply, status: "sent", content: "Canonical reply" };
    readSession.mockResolvedValue(session([opening, userTurn, terminal]));
    await act(async () => { await delivery.refresh(); });
    const optimisticId = `${LOCAL_CHAT_MESSAGE_ID_PREFIX}terminal-send`;
    await act(async () => replaceMessages([...messages, { ...userTurn, id: optimisticId }]));
    await act(async () => delivery.receiveTurn({
      userMessage: userTurn, assistant: streamingReply,
      streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=1",
    }, optimisticId));

    expect(messages).toEqual([opening, userTurn, terminal]);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it.each([
    { status: "sent", content: "Done." },
    { status: "failed", content: "" },
    { status: "cancelled", content: "" },
  ])("lets a terminal $status Voice Call receipt override provisional text and revoke its stream", async ({ status, content }) => {
    const stream = await startReply();
    await act(async () => stream.emit("delta", { delta: "Provisional reply" }));
    const terminal = { ...streamingReply, status, content };
    await act(async () => delivery.receiveTurn({ userMessage: userTurn, assistant: terminal, streamUrl: null }));
    expect(messages.at(-1)).toEqual(terminal);
    expect(stream.closed).toBe(true);
    await act(async () => stream.emit("delta", { delta: " superseded tail" }));
    expect(messages.at(-1)).toEqual(terminal);
  });

  it("keeps provisional text across repeated Voice Call receipts for the same generating attempt", async () => {
    const stream = await startReply();
    await act(async () => stream.emit("delta", { delta: "Partial spoken answer" }));
    await act(async () => delivery.receiveTurn({
      userMessage: userTurn, assistant: streamingReply,
      streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=1",
    }));

    expect(messages.at(-1)).toMatchObject({ attempt: 1, content: "Partial spoken answer", status: "generating" });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(stream.closed).toBe(false);
    await act(async () => stream.emit("delta", { delta: " keeps streaming" }));
    expect(messages.at(-1)?.content).toBe("Partial spoken answer keeps streaming");
  });

  it("does not carry provisional text into a newer attempt delivered by a Voice Call receipt", async () => {
    const previous = await startReply();
    await act(async () => previous.emit("delta", { delta: "Earlier provisional answer" }));
    await act(async () => delivery.receiveTurn({
      userMessage: userTurn, assistant: { ...streamingReply, attempt: 2 },
      streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=2",
    }));

    expect(messages.at(-1)).toMatchObject({ attempt: 2, content: "", status: "generating" });
    expect(previous.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.closed).toBe(false);
  });

  it("keeps the completed new attempt when its earlier regenerate acknowledgement arrives late", async () => {
    readSession.mockResolvedValue(session([opening, userTurn, { ...streamingReply, status: "sent", content: "Original reply" }]));
    await act(async () => { await delivery.refresh(); });
    const response = Promise.withResolvers<Response>();
    request.mockImplementationOnce(() => response.promise);
    let regenerating!: ReturnType<typeof delivery.regenerate>;
    await act(async () => { regenerating = delivery.regenerate(streamingReply.id); });
    const terminal = { ...streamingReply, attempt: 2, status: "sent", content: "Regenerated reply" };
    readSession.mockResolvedValue(session([opening, userTurn, terminal]));
    await act(async () => { await delivery.refresh(); });
    await act(async () => {
      response.resolve(Response.json({
        assistantMessageId: streamingReply.id, attempt: 2, status: "generating",
        streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=2",
      }));
      await regenerating;
    });

    expect(messages.at(-1)).toEqual(terminal);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("accepts fresh terminal content and attachment updates without reopening its attempt", async () => {
    const terminal = { ...streamingReply, status: "sent", content: "Original canonical reply" };
    readSession.mockResolvedValue(session([opening, userTurn, terminal]));
    await act(async () => { await delivery.refresh(); });
    const updated = { ...terminal, content: "Canonical correction", attachments: [{ id: "image-1", kind: "generated_image", status: "completed", mediaUrl: "/media/image-1.webp" }] };
    readSession.mockResolvedValue(session([opening, userTurn, updated]));
    await act(async () => { await delivery.refresh(); });

    expect(messages.at(-1)).toEqual(updated);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(onSession).toHaveBeenCalledTimes(2);
  });

  it.each(["sent", "failed", "cancelled"])("allows a higher attempt and later removal after a %s reply", async (status) => {
    readSession.mockResolvedValue(session([opening, userTurn, { ...streamingReply, status, content: "Earlier attempt" }]));
    await act(async () => { await delivery.refresh(); });
    readSession.mockResolvedValue(session([opening, userTurn, { ...streamingReply, attempt: 2 }]));
    await act(async () => { await delivery.refresh(); });
    const current = FakeEventSource.instances.at(-1)!;
    expect(current.url).toContain("attempt=2");
    expect(current.closed).toBe(false);
    await act(async () => current.emit("delta", { delta: "Current reply" }));
    readSession.mockResolvedValue(session([opening, userTurn, { ...streamingReply, attempt: 2, status: "sent", content: "Current final" }]));
    await act(async () => { await delivery.refresh(); });
    readSession.mockResolvedValue(session([opening]));
    await act(async () => { await delivery.refresh(); });

    expect(messages).toEqual([opening]);
    expect(current.closed).toBe(true);
  });

  it("forgets terminal observations when the conversation lifecycle resets", async () => {
    readSession.mockResolvedValue(session([opening, userTurn, { ...streamingReply, status: "sent", content: "Old lifecycle" }]));
    await act(async () => { await delivery.refresh(); });
    await act(async () => { delivery.reset(); replaceMessages([opening]); });
    readSession.mockResolvedValue(session([opening, userTurn, streamingReply]));
    await act(async () => { await delivery.refresh(); });

    expect(messages.at(-1)).toEqual(streamingReply);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.closed).toBe(false);
  });

  it("freezes an acknowledged Stop at the received text across a late generating poll", async () => {
    const stream = await startReply();
    await act(async () => stream.emit("delta", { delta: "Once upon" }));
    await act(async () => { await delivery.stop(); });
    await act(async () => { await delivery.refresh(); });

    expect(messages.find(({ id }) => id === streamingReply.id)).toMatchObject({ content: "Once upon", status: "cancelled" });
    expect(request).toHaveBeenCalledWith("/api/v1/messages/assistant-1/cancel", expect.objectContaining({
      method: "POST", body: JSON.stringify({ attempt: 1 }),
    }));
    expect(stream.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(delivery.stopping).toBe(false);
  });

  it("keeps a source closed while Stop awaits its ACK and resumes the same attempt when Stop fails", async () => {
    const previous = await startReply();
    await act(async () => previous.emit("delta", { delta: "Once upon" }));
    const cancellation = Promise.withResolvers<Response>();
    request.mockImplementationOnce(() => cancellation.promise);
    let stopping!: Promise<void>;
    await act(async () => { stopping = delivery.stop(); });
    await act(async () => { await delivery.refresh(); });

    expect(delivery.stopping).toBe(true);
    expect(previous.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ attempt: 1, content: "Once upon", status: "generating" });

    await act(async () => {
      cancellation.resolve(Response.json({ error: "temporarily_unavailable" }, { status: 503 }));
      await stopping;
    });
    const resumed = FakeEventSource.instances.at(-1)!;
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(resumed.url).toContain("attempt=1");
    expect(resumed.closed).toBe(false);
    expect(delivery.stopping).toBe(false);
    await act(async () => resumed.emit("delta", { delta: "Recovered reply" }));
    expect(messages.at(-1)).toMatchObject({ attempt: 1, content: "Recovered reply", status: "generating" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("removes a typed send's optimistic row when its old ACK arrives after a newer authority attempt", async () => {
    const optimisticId = `${LOCAL_CHAT_MESSAGE_ID_PREFIX}late-send`;
    await act(async () => replaceMessages([opening, { ...userTurn, id: optimisticId }]));
    readSession.mockResolvedValue(session([opening, userTurn, { ...streamingReply, attempt: 2 }]));
    await act(async () => { await delivery.refresh(); });
    const current = FakeEventSource.instances.at(-1)!;
    await act(async () => current.emit("delta", { delta: "Current reply" }));
    await act(async () => delivery.receiveTurn({
      userMessage: userTurn,
      assistant: streamingReply,
      streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=1",
    }, optimisticId));

    expect(messages.map(({ id }) => id)).toEqual([opening.id, userTurn.id, streamingReply.id]);
    expect(messages.at(-1)).toMatchObject({ attempt: 2, content: "Current reply", status: "generating" });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(current.closed).toBe(false);
    await act(async () => current.emit("delta", { delta: " keeps streaming" }));
    expect(messages.at(-1)?.content).toBe("Current reply keeps streaming");
  });

  it("leaves historical messages intact when a removed Turn is already absent from authority", async () => {
    const removed = await startReply();
    readSession.mockResolvedValue(session([opening, userTurn]));
    await act(async () => { await delivery.refresh(); });
    await act(async () => delivery.removeTurn(streamingReply.id));

    expect(messages).toEqual([opening, userTurn]);
    expect(messages[0]).toBe(opening);
    expect(messages[1]).toBe(userTurn);
    expect(removed.closed).toBe(true);
  });

  it.each(["edit", "regenerate"] as const)("revokes a %s response body that arrives after delivery reset", async (operation) => {
    readSession.mockResolvedValue(session([opening, userTurn, { ...streamingReply, content: "Original reply", status: "sent" }]));
    await act(async () => { await delivery.refresh(); });
    onSession.mockClear();
    readSession.mockClear();
    const body = Promise.withResolvers<Record<string, unknown>>();
    const response = Response.json({});
    response.json = vi.fn(() => body.promise);
    request.mockResolvedValueOnce(response);
    let mutation!: Promise<unknown>;
    await act(async () => {
      mutation = operation === "edit"
        ? delivery.edit(userTurn.id, "Revised message")
        : delivery.regenerate(streamingReply.id);
    });
    expect(response.json).toHaveBeenCalledTimes(1);
    await act(async () => {
      delivery.reset();
      replaceMessages([opening]);
    });
    await act(async () => {
      body.resolve({
        assistantMessageId: streamingReply.id, attempt: 2, status: "generating",
        streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=2",
      });
      await mutation;
    });

    expect(messages).toEqual([opening]);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(onSession).not.toHaveBeenCalled();
    expect(readSession).not.toHaveBeenCalled();
    expect(onRepliesInvalidated).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("accepts a send receipt across focus read invalidation but rejects its captured capability after reset", async () => {
    const optimisticId = `${LOCAL_CHAT_MESSAGE_ID_PREFIX}current-send`;
    await act(async () => replaceMessages([opening, { ...userTurn, id: optimisticId }]));
    const sending = delivery.context();
    delivery.context({ invalidate: true });
    await act(async () => sending.receiveTurn({
      userMessage: userTurn,
      assistant: streamingReply,
      streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=1",
    }, optimisticId));
    expect(messages.map(({ id }) => id)).toEqual([opening.id, userTurn.id, streamingReply.id]);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.closed).toBe(false);

    const revoked = delivery.context();
    await act(async () => {
      delivery.reset();
      replaceMessages([opening]);
    });
    await act(async () => revoked.receiveTurn({
      userMessage: userTurn,
      assistant: { ...streamingReply, attempt: 2 },
      streamUrl: "/api/v1/chat/messages/assistant-1/stream?attempt=2",
    }));
    expect(messages).toEqual([opening]);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    expect(onSession).not.toHaveBeenCalled();
  });

  it("leaves unrelated canonical rows untouched while streaming and reconciling", async () => {
    const stream = await startReply();
    await act(async () => stream.emit("delta", { delta: "Once upon" }));
    expect(messages[0]).toBe(opening);
    expect(messages[1]).toBe(userTurn);
    await act(async () => { await delivery.refresh(); });
    expect(messages[0]).toBe(opening);
    expect(messages[1]).toBe(userTurn);
  });

  it("retries a failed done read and keeps reading partial authority until the terminal row arrives", async () => {
    const stream = await startReply();
    readSession
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockResolvedValueOnce(session([opening, userTurn, { ...streamingReply, content: "Partial" }]))
      .mockResolvedValueOnce(session([opening, userTurn, { ...streamingReply, status: "sent", content: "Canonical reply" }]));
    await act(async () => stream.emit("done", { attempt: 1 }));
    expect(readSession).toHaveBeenCalledTimes(1);
    expect(onSession).not.toHaveBeenCalled();
    expect(stream.closed).toBe(false);

    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(messages.at(-1)).toMatchObject({ content: "Partial", status: "generating" });
    expect(stream.closed).toBe(false);

    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(readSession).toHaveBeenCalledTimes(3);
    expect(onSession).toHaveBeenCalledTimes(2);
    expect(messages.at(-1)).toMatchObject({ content: "Canonical reply", status: "sent" });
    expect(stream.closed).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a new attempt live after both old recovery and old Stop acknowledgement arrive", async () => {
    const previous = await startReply();
    const recovery = Promise.withResolvers<ChatSession>();
    const cancellation = Promise.withResolvers<Response>();
    readSession.mockImplementationOnce(() => recovery.promise);
    request.mockImplementationOnce(() => cancellation.promise);
    await act(async () => previous.emit("error", { code: "provider_error" }));
    let stopping!: Promise<void>;
    await act(async () => { stopping = delivery.stop(); });
    expect(delivery.stopping).toBe(true);
    const current = await startReply({ ...streamingReply, attempt: 2 });
    await act(async () => current.emit("delta", { delta: "Current reply" }));
    await act(async () => recovery.resolve(session([opening, userTurn, {
      ...streamingReply, status: "sent", content: "Superseded reply",
    }])));
    await act(async () => {
      cancellation.resolve(Response.json({ cancelled: true, attempt: 1 }));
      await stopping;
    });

    expect(previous.closed).toBe(true);
    expect(current.closed).toBe(false);
    expect(current.url).toContain("attempt=2");
    expect(messages.at(-1)).toMatchObject({ attempt: 2, content: "Current reply", status: "generating" });
    expect(delivery.stopping).toBe(false);
    expect(onSession).not.toHaveBeenCalled();
    await act(async () => current.emit("delta", { delta: " keeps streaming" }));
    expect(messages.at(-1)?.content).toBe("Current reply keeps streaming");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
