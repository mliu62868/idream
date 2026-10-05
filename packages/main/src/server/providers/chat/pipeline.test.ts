import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineChatModel } from "./pipeline";

afterEach(() => vi.useRealTimers());
const input = { messages: [{ role: "user" as const, content: "Write a short adult botanical character draft." }] };
function streamingFetch(schedule: (send: (content: string) => void, end: () => void) => void) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      const encoder = new TextEncoder();
      signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      schedule(
        (content) => { if (!signal?.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)); },
        () => { if (!signal?.aborted) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); } },
      );
    } }), { headers: { "content-type": "text/event-stream" } });
  });
}
async function collect(model: PipelineChatModel, options: Parameters<PipelineChatModel["stream"]>[0]) {
  let text = "";
  try { for await (const chunk of model.stream(options)) text += chunk.delta; return { text }; }
  catch (error) { return { error }; }
}

describe("Admin model progress budgets", () => {
  it.each(["json", "sse"])("preserves the model's length stop in a %s response", async (transport) => {
    const choice = { message: { content: "Consent is never forced, always" }, delta: { content: "Consent is never forced, always" }, finish_reason: "length" };
    const fetchImpl = vi.fn(async () => transport === "json"
      ? Response.json({ choices: [choice] })
      : new Response(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const model = new PipelineChatModel({ baseUrl: "http://model.test/v1", model: "local-model", fetchImpl });
    const chunks = [];
    for await (const chunk of model.stream(input)) chunks.push(chunk);
    expect(chunks.some(chunk => "finishReason" in chunk && chunk.finishReason === "length")).toBe(true);
    expect(chunks.map(chunk => chunk.delta).join("")).toBe("Consent is never forced, always");
  });

  it("lets a progressing draft finish beyond the initial wait budget", async () => {
    vi.useFakeTimers();
    const fetchImpl = streamingFetch((send, end) => {
      setTimeout(() => send("visual "), 200); setTimeout(() => send("direction"), 400); setTimeout(end, 600);
    });
    const model = new PipelineChatModel({ baseUrl: "http://model.test/v1", model: "local-model", timeoutMs: 250, fetchImpl });
    const result = collect(model, { ...input, timeoutMode: "progress" });
    await vi.advanceTimersByTimeAsync(600);
    expect(await result).toEqual({ text: "visual direction" });
  });

  it("sends an explicit output bound and trace ID to the backend", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ choices: [{ message: { content: "A concise visual direction." } }] }));
    const model = new PipelineChatModel({ baseUrl: "http://model.test/v1", model: "local-model", fetchImpl });
    await collect(model, { ...input, maxTokens: 192, requestId: "draft-visual-trace", timeoutMode: "progress" });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body)).max_tokens).toBe(192);
    expect(new Headers(init.headers).get("x-request-id")).toBe("draft-visual-trace");
  });

  it("identifies a stalled draft stream rather than treating SSE heartbeats as model progress", async () => {
    vi.useFakeTimers();
    const fetchImpl = streamingFetch(send => { setTimeout(() => send(""), 200); });
    const model = new PipelineChatModel({ baseUrl: "http://model.test/v1", model: "local-model", timeoutMs: 250, fetchImpl });
    const result = collect(model, { ...input, requestId: "stalled-draft", timeoutMode: "progress" });
    await vi.advanceTimersByTimeAsync(251);
    expect(await result).toMatchObject({ error: { kind: "timeout", timeoutPhase: "first_token", requestId: "stalled-draft" } });
  });

  it("does not let heartbeats extend the idle budget after actual output", async () => {
    vi.useFakeTimers();
    const fetchImpl = streamingFetch(send => { setTimeout(() => send("a"), 100); setTimeout(() => send(""), 300); });
    const model = new PipelineChatModel({ baseUrl: "http://model.test/v1", model: "local-model", timeoutMs: 250, fetchImpl });
    const result = collect(model, { ...input, timeoutMode: "progress" });
    await vi.advanceTimersByTimeAsync(351);
    expect(await result).toMatchObject({ error: { kind: "timeout", timeoutPhase: "idle" } });
  });

  it("bounds the total draft even when output continues", async () => {
    vi.useFakeTimers();
    let interval: ReturnType<typeof setInterval>;
    const fetchImpl = streamingFetch(send => { interval = setInterval(() => send("a"), 1_000); });
    const model = new PipelineChatModel({ baseUrl: "http://model.test/v1", model: "local-model", timeoutMs: 10_000, fetchImpl });
    const result = collect(model, { ...input, timeoutMode: "progress" });
    await vi.advanceTimersByTimeAsync(180_001);
    clearInterval(interval!);
    expect(await result).toMatchObject({ error: { kind: "timeout", timeoutPhase: "deadline" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the original total budget for public quick-start callers", async () => {
    vi.useFakeTimers();
    const fetchImpl = streamingFetch((send, end) => {
      setTimeout(() => send("public "), 200); setTimeout(() => send("draft"), 400); setTimeout(end, 600);
    });
    const model = new PipelineChatModel({ baseUrl: "http://model.test/v1", model: "local-model", timeoutMs: 250, fetchImpl });
    const result = collect(model, input);
    await vi.advanceTimersByTimeAsync(251);
    expect(await result).toMatchObject({ error: { kind: "timeout", timeoutPhase: "deadline" } });
  });

  it("preserves the backend HTTP refusal and trace instead of calling it a timeout", async () => {
    const fetchImpl = vi.fn(async () => new Response("Unavailable", { status: 503 }));
    const model = new PipelineChatModel({ baseUrl: "http://model.test/v1", model: "local-model", fetchImpl });
    expect(await collect(model, { ...input, requestId: "http-refusal", timeoutMode: "progress" })).toMatchObject({
      error: { kind: "http", status: 503, requestId: "http-refusal" },
    });
  });

  it("does not hide a timeout while reading a JSON response body as empty model output", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(
      new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":['));
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      } }), { headers: { "content-type": "application/json" } },
    ));
    const model = new PipelineChatModel({ baseUrl: "http://model.test/v1", model: "local-model", timeoutMs: 250, fetchImpl });
    const result = collect(model, { ...input, requestId: "json-body-stall", timeoutMode: "progress" });
    await vi.advanceTimersByTimeAsync(251);
    expect(await result).toMatchObject({ error: { kind: "timeout", timeoutPhase: "first_token", requestId: "json-body-stall" } });
  });

  it("releases the SSE reader and timers when the caller stops consuming", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')); }, cancel,
    }), { headers: { "content-type": "text/event-stream" } }));
    const model = new PipelineChatModel({ baseUrl: "http://model.test/v1", model: "local-model", fetchImpl });
    const iterator = model.stream({ ...input, timeoutMode: "progress" })[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: { delta: "a" } });
    await iterator.return?.();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
