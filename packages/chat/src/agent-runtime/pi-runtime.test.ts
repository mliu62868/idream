import { describe, expect, it } from "vitest";
import type { CompanionInvocation, PreparedTurnMessage } from "./contracts";
import { buildReplaySeed } from "./pi-context";
import { executePiConversation } from "./pi-runtime";
import { OpenAiCompatibleAdapter, type TokenUsage } from "./openai-adapter";

const speaker = { name: "Briar", characterId: "briar", sessionId: "briar-session" };

function invocation(budget: number, historyCount: number, historyChars: number): CompanionInvocation {
  const profile = {
    tier: "test", adapter: "openai-compatible-v1", provider: "local", baseUrl: "https://fixture.invalid/v1", model: "fixture",
    supportsTools: true, maxOutputTokens: 256, timeout: { firstTokenMs: 300, idleMs: 300 },
    sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
  };
  return {
    invocationId: "runtime-test", attemptId: "runtime-attempt", sessionId: "runtime-session", userId: "runtime-user", characterId: "mara", memoryMode: "private",
    expectedProfileDigest: "0".repeat(64), deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    preparedTurn: {
      version: 6, model: profile.model, characterName: "Mara", profile, tools: [],
      messages: [
        { id: "soul", sourceKind: "plugin", role: "system", content: "You are Mara." },
        ...Array.from({ length: historyCount }, (_, index): PreparedTurnMessage => ({
          id: `past-${index}`, sourceKind: "replay", role: index % 2 ? "assistant" : "user",
          content: `Main original ${index}: ${"a".repeat(historyChars)}`,
          ...(index === 1 ? { speaker } : {}),
        })),
        { id: "state:current", sourceKind: "plugin", role: "user", content: "We are in the library now." },
        { id: "current", sourceKind: "current_user", role: "user", content: "Current question: what happened?" },
      ],
      budget: { maxInputTokens: budget, usedInputTokens: 100, dropped: [] },
      trace: { productPromptVersion: "companion-product-1", systemPromptDigest: "0".repeat(64), characterContentVersionId: "content", characterReleaseId: null,
        soulFingerprint: "0".repeat(64), compilerVersion: "test", sceneVersion: 1, contextRevision: "1" },
    },
  };
}

function pinned(value: CompanionInvocation) {
  return value.preparedTurn.messages.filter(message => message.sourceKind === "current_user"
    || (message.sourceKind === "plugin" && message.role === "user"));
}

function response(delta: object, finish = "stop") {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
}

type WireBody = { messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }> };
type SummarySource = { kind: string; source: { id?: string; owner?: string }; messages: Array<{ id: string; sourceKind: string; content: string; speaker?: typeof speaker }> };

describe("Pi execution boundaries", () => {
  it.each([false, true])("exposes Main-only archive availability without leaking omitted originals (omitted=%s)", async omitted => {
    const value = invocation(10_000, 2, 100);
    if (omitted) value.preparedTurn.omittedMessages = [{ id: "archived", sourceKind: "replay", role: "assistant", speaker,
      content: "Original wording exists only in the authorized archive." }];
    let body: WireBody | undefined;
    const adapter = new OpenAiCompatibleAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture",
      maxInputTokens: value.preparedTurn.budget.maxInputTokens,
      fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return response({ content: "Completed reply." }); },
    });
    await executePiConversation({ invocation: value, seed: buildReplaySeed(value), pinned: pinned(value), systemPrompt: "You are Mara.", adapter,
      signal: AbortSignal.timeout(2_000), maxSteps: 8, tools: () => [], assertContinuation() {}, text() {}, reset() {}, compaction() {},
    });
    const current = body!.messages.at(-1)!.content;
    expect(body!.messages.at(-2)!.content.includes("some original messages are available only through session_recall")).toBe(omitted);
    expect(current).toBe("Current question: what happened?");
    expect(JSON.stringify(body)).not.toContain("Original wording exists only in the authorized archive.");
    expect(body!.messages).toContainEqual({ role: "user", content: `Briar: Main original 1: ${"a".repeat(100)}` });
  });

  it("recovers a provider HTTP context overflow through compaction without inventing usage for the rejected request", async () => {
    const value = invocation(10_000, 8, 1_600);
    const requests: Array<{ purpose: string; body: WireBody }> = [];
    const receipts: Array<TokenUsage | undefined> = [];
    const compactions: string[] = [];
    let purpose: string | undefined;
    const adapter = new OpenAiCompatibleAdapter({
      profile: value.preparedTurn.profile, apiKey: "fixture", maxInputTokens: value.preparedTurn.budget.maxInputTokens,
      observeRequest: evidence => { purpose = evidence.purpose; }, observeUsage: usage => receipts.push(usage),
      fetch: async (_url, init) => {
        requests.push({ purpose: purpose ?? "generation", body: JSON.parse(String(init?.body)) });
        if (requests.length === 1) return new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "maximum context length exceeded" } }), { status: 400 });
        return response({ content: purpose === "compaction" ? "Earlier original facts and Briar's words." : "Completed final reply." });
      },
    });
    const output = await executePiConversation({
      invocation: value, seed: buildReplaySeed(value), pinned: pinned(value), systemPrompt: "You are Mara.", adapter,
      signal: AbortSignal.timeout(2_000), maxSteps: 8, tools: () => [], assertContinuation() {}, text() {}, reset() {},
      compaction: outcome => compactions.push(outcome),
    });

    expect(output.message.stopReason).toBe("stop");
    expect(output.steps).toBe(2);
    expect(requests.map(request => request.purpose)).toEqual(["generation", "compaction", "generation"]);
    expect(compactions).toEqual(["hit"]);
    expect(receipts).toEqual([undefined,
      { inputTokens: 100, outputTokens: 10 },
      { inputTokens: 100, outputTokens: 10 },
    ]);
    expect(JSON.stringify(requests[0]!.body)).toContain("Main original 0:");
    expect(JSON.stringify(requests[0]!.body)).not.toContain("some original messages are available only through session_recall");
    expect(JSON.stringify(requests[2]!.body)).not.toContain("Main original 0:");
    expect(JSON.stringify(requests[2]!.body)).toContain("some original messages are available only through session_recall");
    expect(JSON.stringify(requests[2]!.body)).toContain("We are in the library now.");
    expect(JSON.stringify(requests[2]!.body)).toContain("Current question: what happened?");
  });

  it("keeps earlier summaries distinct from Main originals through a second compaction and restores the active tool tail", async () => {
    const value = invocation(6_000, 12, 1_800);
    const requests: Array<{ purpose: string; body: WireBody }> = [];
    const summaries: SummarySource[][] = [];
    const longResult = `Tool original. ${"b".repeat(19_000)}`;
    let purpose: string | undefined;
    let generation = 0;
    const adapter = new OpenAiCompatibleAdapter({
      profile: value.preparedTurn.profile, apiKey: "fixture", maxInputTokens: value.preparedTurn.budget.maxInputTokens,
      observeRequest: evidence => { purpose = evidence.purpose; },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as WireBody;
        requests.push({ purpose: purpose ?? "generation", body });
        if (purpose === "compaction") {
          summaries.push(JSON.parse(body.messages.at(-1)!.content));
          return response({ content: `Summary generation ${summaries.length}. Original names remain fallible here.` });
        }
        if (++generation === 1) return response({ tool_calls: [{ index: 0, id: "large-1", function: { name: "large_read", arguments: "{}" } }] }, "tool_calls");
        return response({ content: "Completed final reply." });
      },
    });
    const output = await executePiConversation({
      invocation: value, seed: buildReplaySeed(value), pinned: pinned(value), systemPrompt: "You are Mara.", adapter,
      signal: AbortSignal.timeout(2_000), maxSteps: 8, assertContinuation() {}, text() {}, reset() {}, compaction() {},
      tools: () => [{ name: "large_read", description: "Read a controlled long result", parameters: { type: "object", properties: {} }, replay: "safe",
        execute: async () => ({ output: [{ type: "text", text: longResult }] }),
      }],
    });

    expect(output.message.stopReason).toBe("stop");
    expect(requests.map(request => request.purpose)).toEqual(["compaction", "generation", "compaction", "generation"]);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.find(source => source.source.id === "past-1")).toMatchObject({
      kind: "idream.replay", source: { owner: value.attemptId, id: "past-1" }, messages: [{ id: "past-1", sourceKind: "replay", speaker }],
    });
    const previousSummary = summaries[1]!.find(source => source.kind === "pi.compaction");
    expect(previousSummary).toBeDefined();
    expect(previousSummary!.messages[0]).toMatchObject({ sourceKind: "plugin" });
    expect(previousSummary!.messages[0]!.content).toContain("Summary generation 1.");
    expect(previousSummary!.source.id).toBeUndefined();
    expect(summaries[1]!.filter(source => source.kind === "idream.replay").every(source => source.source.owner === value.attemptId)).toBe(true);
    const final = requests.at(-1)!.body.messages;
    expect(final.some(message => message.role === "assistant" && message.tool_calls?.some(call => call.id === "large-1"))).toBe(true);
    expect(final.find(message => message.role === "tool" && message.tool_call_id === "large-1")?.content).toBe(longResult);
    for (const text of ["We are in the library now.", "Current question: what happened?"]) {
      expect(final.filter(message => message.role === "user" && message.content.includes(text))).toHaveLength(1);
    }
  });
});
