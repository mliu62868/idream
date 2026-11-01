import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@earendil-works/pi-ai";
import type { PreparedTurnMessage } from "./contracts";
import type { Chunk } from "./session-recall";
import { fitCompanionMessages, formatCompanionMessages, messageText } from "./pi-context";
import { estimatePiModelRequestInputTokens, OpenAiCompatibleAdapter } from "./openai-adapter";

const current = "请重发同一张蓝色杯子图片，不要生成新图片。另外，17 加 25 等于多少？";
const media = Array.from({ length: 7 }, (_, index) => `media-original-${index}`);
const pinned: PreparedTurnMessage[] = [
  { id: "state", role: "user", sourceKind: "plugin", content: `${media.join("\n")}\n${"state ".repeat(250)}` },
  { id: "current", role: "user", sourceKind: "current_user", content: current },
];
const tools: Tool[] = [
  { name: "session_recall", description: "Read original evidence", parameters: { type: "object", properties: {} } },
  { name: "igrep_search", description: "Search retained evidence", parameters: { type: "object", properties: {} } },
  { name: "send_character_media", description: "Media permission schema. ".repeat(260), parameters: { type: "object", properties: {} } },
];
const systemPrompt = "Character Soul and product rules. ".repeat(270);
function row(index: number, size: number): Chunk {
  const content = `Original ${index}: ${"x".repeat(size)}`;
  return { id: `attempt:owned/main:original-${index}/block:0/byte:0`, ref: `attempt:owned/main:original-${index}/block:0/byte:0`,
    attemptId: "owned", sourceId: `main:original-${index}`, role: "user", kind: "text", title: "user", content,
    byteStart: 0, byteEnd: Buffer.byteLength(content), position: index };
}
function execution(recall: unknown, lookup = "") : PreparedTurnMessage[] {
  return [
    { id: "pi.compaction:summary", role: "user", sourceKind: "plugin", content: "Fallible summary. ".repeat(350) },
    { id: "lookup-call", role: "assistant", sourceKind: "plugin", content: "", tool_calls: [
      { id: "recall", type: "function", function: { name: "session_recall", arguments: '{"query":"original wording"}' } },
      ...(lookup ? [{ id: "search", type: "function" as const, function: { name: "igrep_search", arguments: '{"query":"same source"}' } }] : []),
    ] },
    { id: "recall-result", role: "tool", sourceKind: "plugin", tool_call_id: "recall", content: JSON.stringify(recall) },
    ...(lookup ? [{ id: "search-result", role: "tool" as const, sourceKind: "plugin" as const, tool_call_id: "search", content: lookup }] : []),
  ];
}
function fit(messages: PreparedTurnMessage[], toolSources = new Map<string, readonly Chunk[]>(), maxInputTokens = 6_000) {
  return fitCompanionMessages({ messages, pinned, systemPrompt, tools, respondingCharacterId: "character",
    maxInputTokens, afterRetrievalContext: "Answer the complete original request.", toolSources });
}

describe("final companion request window", () => {
  it("retains seven media references and paired parallel calls while pointing oversized lookup text to exact originals", () => {
    const rows = Array.from({ length: 8 }, (_, index) => row(index, 80));
    const lookup = [{ title: "Original lookup", content: "Archived lookup bytes. ".repeat(200) }];
    const original = JSON.stringify(lookup);
    const source = { ...row(9, 0), id: "attempt:owned/pi:result/message:0/block:0/byte:0", sourceId: "pi:result/message:0", content: original, byteEnd: Buffer.byteLength(original) };
    const messages = execution(rows, original);
    const before = structuredClone(messages);
    expect(estimatePiModelRequestInputTokens(formatCompanionMessages(messages, pinned, systemPrompt, tools, "character"))).toBeGreaterThan(6_000);
    const result = fit(messages, new Map([["search-result", [source]]]));
    expect(estimatePiModelRequestInputTokens(result)).toBeLessThanOrEqual(6_000);
    expect(messages).toEqual(before);
    expect(result.filter(message => message.role === "toolResult").map(message => message.toolCallId)).toEqual(["recall", "search"]);
    const call = result.find(message => message.role === "assistant")!;
    expect(call.role === "assistant" && call.content.filter(block => block.type === "toolCall").map(block => block.id)).toEqual(["recall", "search"]);
    const reference = JSON.parse(messageText(result.find(message => message.role === "toolResult" && message.toolCallId === "search")!));
    expect(reference).toEqual({ sourceId: source.sourceId, status: "paged_for_context", totalBytes: source.byteEnd,
      next: { tool: "session_recall", arguments: { cursor: source.id } } });
    expect(result.some(message => message.role === "user" && messageText(message) === current)).toBe(true);
    for (const id of media) expect(result.some(message => messageText(message).includes(id))).toBe(true);
  });

  it("keeps every withheld ID and the original next cursor when an eight-chunk source page must be paged again", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({ ...row(index, 900), sourceId: "main:long-original",
      id: `attempt:owned/main:long-original/block:0/byte:${index * 912}`, byteStart: index * 912, byteEnd: (index + 1) * 912 }));
    const nextCursor = "attempt:owned/main:long-original/block:0/byte:7296";
    const result = fit(execution({ results: rows, nextCursor }));
    expect(estimatePiModelRequestInputTokens(result)).toBeLessThanOrEqual(6_000);
    const page = JSON.parse(messageText(result.find(message => message.role === "toolResult")!));
    expect(page.results.length).toBeGreaterThan(0);
    expect(page.results.length).toBeLessThan(8);
    expect(page.results).toEqual(rows.slice(0, page.results.length));
    expect(page.remainingIds).toEqual(rows.slice(page.results.length).map(item => item.id));
    expect(page.nextCursor).toBe(nextCursor);
    expect(page.next).toEqual({ tool: "session_recall", arguments: { cursor: rows[page.results.length]!.id } });
  });

  it("rejects irreducible input instead of returning an empty page that rereads the same original forever", async () => {
    const only = row(0, 1_980);
    const maxInputTokens = estimatePiModelRequestInputTokens(formatCompanionMessages(execution([]).slice(1), pinned, systemPrompt, tools, "character")) + 32;
    const result = fit(execution([only]), new Map(), maxInputTokens);
    expect(estimatePiModelRequestInputTokens(fit(execution([]), new Map(), maxInputTokens))).toBeLessThanOrEqual(maxInputTokens);
    const text = messageText(result.find(message => message.role === "toolResult")!);
    expect(JSON.parse(text)).toEqual([only]);
    expect(result.some(message => message.role === "user" && messageText(message) === current)).toBe(true);
    const fetch = vi.fn();
    const adapter = new OpenAiCompatibleAdapter({ apiKey: "fixture", maxInputTokens, fetch, profile: {
      tier: "test", adapter: "openai-compatible-v1", provider: "local", baseUrl: "https://fixture.invalid/v1", model: "fixture", supportsTools: true,
      maxOutputTokens: 256, timeout: { firstTokenMs: 100, idleMs: 100 }, sampling: { temperature: 0, topP: 1, repetitionPenalty: 1 },
    } });
    const rejected = await adapter.stream(result).result();
    expect(adapter.getError(rejected)).toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
