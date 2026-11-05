import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createIgrepTools } from "./igrep";
import { projectRecall } from "./session-recall";
import type { CompanionInvocation, PreparedTurnMessage } from "./contracts";
import { buildReplaySeed } from "./pi-context";
import { executePiConversation } from "./pi-runtime";
import { OpenAiCompatibleAdapter, type TokenUsage } from "./openai-adapter";
import { estimateModelRequestInputTokens } from "./model-request-format";
import { IMAGE_AGENT_TOOL_DEFINITIONS } from "@idream/shared/chat/image-action";
import { CHARACTER_MEDIA_TOOL_DEFINITIONS } from "@idream/shared/chat/media-library";

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

function response(delta: object, finish = "stop", usage = { prompt_tokens: 100, completion_tokens: 10 }) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`);
}

type WireBody = { messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>; tools?: unknown[] };
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
    expect(body!.messages.at(-2)!.content.includes("use session_recall to retrieve the omitted original messages")).toBe(omitted);
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
    expect(JSON.stringify(requests[0]!.body)).not.toContain("use session_recall to retrieve the omitted original messages");
    expect(JSON.stringify(requests[2]!.body)).not.toContain("Main original 0:");
    expect(JSON.stringify(requests[2]!.body)).toContain("use session_recall to retrieve the omitted original messages");
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
    let recalled = false;
    const replyContext = "Use the available records for the current reply.";
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
      afterRetrievalContext: { content: replyContext, available: () => recalled },
      tools: () => [{ name: "large_read", description: "Read a controlled long result", parameters: { type: "object", properties: {} }, replay: "safe",
        execute: async () => { recalled = true; return { output: [{ type: "text", text: longResult }] }; },
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
    expect(final.at(-1)).toEqual({ role: "user", content: replyContext });
    expect(final.filter(message => message.content === replyContext)).toHaveLength(1);
    expect(JSON.stringify(summaries)).not.toContain(replyContext);
    expect(final.some(message => message.role === "assistant" && message.tool_calls?.some(call => call.id === "large-1"))).toBe(true);
    expect(final.find(message => message.role === "tool" && message.tool_call_id === "large-1")?.content).toBe(longResult);
    for (const text of ["We are in the library now.", "Current question: what happened?"]) {
      expect(final.filter(message => message.role === "user" && message.content.includes(text))).toHaveLength(1);
    }
  });

  it.each([0, 200, 1_600, 4_000, 8_000])("pages all eight recalled originals after a %i-character summary without losing exact source reads", async summaryChars => {
    const value = invocation(6_000, 0, 0);
    value.attemptId = "fbdd0712-d40d-40a9-a691-e138dbc771a4:1";
    const current = "请把刚才蓝色杯子的同一张图片再发一次，不要生成新图片。另外，17 加 25 等于多少？请用一句友好的中文回答。";
    value.preparedTurn.messages.at(-1)!.content = current;
    value.preparedTurn.messages.find(message => message.id === "state:current")!.content += `\nMedia reference: media_blue_cup. ${"c".repeat(1_850)}`;
    const originals = Array.from({ length: 8 }, (_, index): PreparedTurnMessage => ({
      id: `00000000-0000-4000-8000-00000000000${index}`, sourceKind: "replay", role: index % 2 ? "assistant" : "user",
      content: `Original ${index}: ${"b".repeat(150)}`,
      ...(index % 2 ? { speaker: { ...speaker, characterId: "00000000-0000-4000-8000-000000000010", sessionId: "00000000-0000-4000-8000-000000000011" } } : {}),
    }));
    value.preparedTurn.omittedMessages = originals;
    let purpose: string | undefined;
    let generation = 0;
    let recalled = false;
    const requests: WireBody[] = [];
    const readRows: Array<{ id: string; sourceId: string; content: string; role: string; speaker?: typeof speaker }>[] = [];
    const delivered = new Map<string, typeof readRows[number][number]>();
    const pages: Array<{ results: typeof readRows[number]; remainingIds?: string[]; nextCursor?: string;
      next?: { tool: string; arguments: Record<string, unknown> } }> = [];
    let recallCallId = "recall-large";
    const adapter = new OpenAiCompatibleAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture", maxInputTokens: 6_000,
      observeRequest: request => { purpose = request.purpose; },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as WireBody;
        if (purpose === "compaction") return response({ content: `Earlier original records are available with session_recall. ${"s".repeat(summaryChars)}` });
        requests.push(body);
        if (++generation === 1) return response({ tool_calls: [{ index: 0, id: "recall-large", function: { name: "session_recall", arguments: '{"query":"earlier original words"}' } }] }, "tool_calls", { prompt_tokens: 4_324, completion_tokens: 518 });
        const raw = JSON.parse(body.messages.find(message => message.role === "tool" && message.tool_call_id === recallCallId)!.content);
        const page: typeof pages[number] = Array.isArray(raw) ? { results: raw } : raw;
        expect(page.results.length).toBeGreaterThan(0);
        pages.push(page);
        for (const row of page.results) delivered.set(row.id, row);
        if (page.remainingIds?.length || page.nextCursor) {
          expect(page.next?.tool).toBe("session_recall");
          if (page.remainingIds?.length) expect(page.next!.arguments.ids).toEqual(page.remainingIds);
          recallCallId = `recall-page-${generation}`;
          return response({ tool_calls: [{ index: 0, id: recallCallId, function: {
            name: page.next!.tool, arguments: JSON.stringify(page.next!.arguments),
          } }] }, "tool_calls");
        }
        // The model may finish only after it actually received every original,
        // not merely because the unpaged tool implementation found all eight.
        expect(delivered.size).toBe(8);
        return response({ content: "17 加 25 等于 42 哦！" });
      },
    });
    const output = await executePiConversation({ invocation: value, seed: buildReplaySeed(value), pinned: pinned(value),
      systemPrompt: `You are Mara. ${"s".repeat(9_450)}`, adapter, signal: AbortSignal.timeout(2_000), maxSteps: 8,
      afterRetrievalContext: { content: `Reply scope: ${"r".repeat(660)}`, available: () => recalled },
      assertContinuation() {}, text() {}, reset() {}, compaction() {},
      tools: conversation => {
        const tools = createIgrepTools({ cli: { command: "igrep", env: { IGREP_NO_CACHE: "1" } }, workspace: "/unused", knowledgePath: "/unused", mode: "private",
          recall: () => projectRecall(conversation(), BACKGROUND_CONTEXT, { attemptId: value.attemptId, conversationId: conversation().id,
            assistant: { name: "Mara", characterId: value.characterId, sessionId: value.sessionId }, seed: value.preparedTurn.messages, omitted: originals }),
          run: async command => ({ results: command.stdin!.trim().split("\n").map(line => ({ record: JSON.parse(line) })) }),
        });
        return [...tools.map(tool => ({ ...tool, parameters: tool.parameters as ToolRegistration["parameters"], replay: "safe" as const,
          execute: async (args: Record<string, unknown>) => {
            const found = await tool.execute(args as Record<string, unknown>, AbortSignal.timeout(1_000)) as typeof readRows[number];
            const exact = await tool.execute({ ids: found.map(row => row.id) }, AbortSignal.timeout(1_000));
            expect(exact).toEqual(found);
            readRows.push(found);
            recalled = true;
            return { output: [{ type: "text" as const, text: JSON.stringify(found) }] };
          },
        })), ...[...IMAGE_AGENT_TOOL_DEFINITIONS, ...CHARACTER_MEDIA_TOOL_DEFINITIONS].map(tool => ({ ...tool,
          parameters: tool.parameters as ToolRegistration["parameters"], replay: "safe" as const,
          execute: async () => { throw new Error("The budget regression must not execute media actions"); },
        }))];
      },
    });
    expect(output.message.stopReason).toBe("stop");
    expect(requests.length).toBeGreaterThan(2);
    for (const request of requests) {
      expect(request.messages).toContainEqual({ role: "user", content: current });
      expect(JSON.stringify(request)).toContain("media_blue_cup");
      expect(estimateModelRequestInputTokens(request)).toBeLessThanOrEqual(6_000);
    }
    expect(readRows[0]).toHaveLength(8);
    expect(readRows[0]!.map(row => row.content)).toEqual(originals.map(row => row.content));
    expect(readRows[0]!.map(row => row.sourceId)).toEqual(originals.map(row => `main:${row.id}`));
    expect(readRows[0]!.map(row => row.role)).toEqual(originals.map(row => row.role));
    expect(readRows[0]!.map(row => row.speaker)).toEqual(originals.map(row => "speaker" in row ? row.speaker : undefined));
    expect(pages[0]!.results.length).toBeLessThan(8);
    expect(pages[0]!.remainingIds).toContain(readRows[0]![7]!.id);
    expect([...delivered.values()]).toEqual(readRows[0]);
    expect(pages.at(-1)!.remainingIds ?? []).toEqual([]);
    expect(pages.at(-1)!.nextCursor ?? null).toBeNull();
  });
});

it("recalls transferred attempt tool originals after body compaction without promoting plugin background", async () => {
  const value = invocation(6_000, 12, 1_800);
  const original = "The original lookup found the cedar path, not the shoreline.";
  const executionEvidence: PreparedTurnMessage[] = [
    { id: "lookup-call:earlier", sourceKind: "plugin", role: "assistant", content: "", tool_calls: [
      { id: "earlier", type: "function", function: { name: "memory_search", arguments: '{"query":"earlier route"}' } },
    ] },
    { id: "lookup-result:earlier", sourceKind: "plugin", role: "tool", tool_call_id: "earlier", content: original },
  ];
  const recalledId = `attempt:${value.attemptId}/execution:${encodeURIComponent("lookup-result:earlier")}/block:0/byte:0`;
  let purpose: string | undefined;
  let generations = 0;
  let compactions = 0;
  let recalled = false;
  const bodyRequests: WireBody[] = [];
  const adapter = new OpenAiCompatibleAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture", maxInputTokens: value.preparedTurn.budget.maxInputTokens,
    observeRequest: request => { purpose = request.purpose; },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as WireBody;
      if (purpose === "compaction") return response({ content: `Fallible summary ${++compactions}; original tool wording must be recalled.` });
      expect(purpose).toBe("media_body");
      bodyRequests.push(body);
      if (++generations === 1) return response({ tool_calls: [{ index: 0, id: "padding", function: { name: "read_padding", arguments: "{}" } }] }, "tool_calls");
      if (generations === 2) {
        expect(JSON.stringify(body.messages)).not.toContain(original);
        expect(JSON.stringify(body.messages)).toContain("use session_recall to retrieve the omitted original messages");
        return response({ tool_calls: [{ index: 0, id: "recall-original", function: { name: "session_recall", arguments: JSON.stringify({ ids: [recalledId] }) } }] }, "tool_calls");
      }
      const receipt = JSON.parse(body.messages.find(message => message.role === "tool" && message.tool_call_id === "recall-original")!.content);
      expect(receipt).toEqual([expect.objectContaining({ content: original, role: "toolResult", toolName: "memory_search", sourceId: `execution:${encodeURIComponent("lookup-result:earlier")}` })]);
      recalled = true;
      return response({ content: "You chose the cedar path." });
    },
  });
  const output = await executePiConversation({ invocation: value, seed: buildReplaySeed(value), pinned: pinned(value), executionEvidence,
    systemPrompt: "You are Mara.", adapter, purpose: "media_body", signal: AbortSignal.timeout(3_000), maxSteps: 5,
    assertContinuation() {}, text() {}, reset() {}, compaction() {},
    tools: conversation => {
      const tool = createIgrepTools({ cli: { command: "igrep", env: { IGREP_NO_CACHE: "1" } }, workspace: "/unused", knowledgePath: "/unused", mode: "private",
        recall: () => projectRecall(conversation(), BACKGROUND_CONTEXT, { attemptId: value.attemptId, conversationId: conversation().id,
          assistant: { name: "Mara", characterId: value.characterId, sessionId: value.sessionId }, seed: value.preparedTurn.messages, omitted: [], execution: executionEvidence }),
      }).find(tool => tool.name === "session_recall")!;
      return [
        { name: "read_padding", description: "Read controlled long evidence", parameters: { type: "object", properties: {} }, replay: "safe",
          execute: async () => ({ output: [{ type: "text", text: `Later lookup ${"b".repeat(19_000)}` }] }) },
        { ...tool, parameters: tool.parameters as ToolRegistration["parameters"],
          replay: "safe", execute: async args => ({ output: [{ type: "text", text: JSON.stringify(await tool.execute(args as Record<string, unknown>, AbortSignal.timeout(1_000))) }] }) },
      ];
    },
  });
  expect(compactions).toBeGreaterThanOrEqual(2);
  expect(recalled).toBe(true);
  expect(output.steps).toBe(3);
  expect(bodyRequests).toHaveLength(3);
});
