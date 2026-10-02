import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PreparedTurnProfile } from "./agent-runtime/contracts.js";
import { emptySceneState, projectSceneForReply, SCENE_COMPLETION_PROMPT, SCENE_COMPLETION_RESPONSE_FORMAT, SCENE_PROJECTION_PROMPT, SCENE_RESPONSE_FORMAT } from "./scene.js";

const profile: PreparedTurnProfile = {
  tier: "test", adapter: "openai-compatible-v1", provider: "openai",
  model: "scene-model", baseUrl: "https://provider.example/v1", supportsTools: true,
  maxOutputTokens: 1_024, answerMaxOutputTokens: 64,
  timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
  sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
};
const input = {
  previous: { ...emptySceneState(), version: 4, location: "the kitchen", participants: ["Mina"], unresolvedThreads: ["call the hotel"] },
  userText: "Now we are at the beach.", assistantText: "I stay beside you.",
  attemptId: "assistant-1:2", userMessageId: "user-1", assistantMessageId: "assistant-1",
};

function projectionJson(facts: Array<{ evidence: string; field: string; value: string; scope?: string; referent?: string }> = []) {
  const fields = ["location", "time", "participant_present", "participant_absent", "emotionalBeat", "thread_unfinished", "thread_completed"];
  return JSON.stringify(Object.fromEntries(fields.map(field => [field, facts.filter(fact => fact.field === field).map(({ evidence, value, scope, referent }) => ({ evidence, value, scope: scope ?? "current", ...(referent ? { referent } : {}) }))])));
}

function response(text = projectionJson(), finishReason = "stop", includeUsage = true, promptTokens = 23, completionTokens = 8) {
  return new Response([
    `data: ${JSON.stringify({ id: "physical-request-1", provider: "local", choices: [{ delta: { content: text }, finish_reason: finishReason }] })}\n\n`,
    ...(includeUsage ? [`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, completion_tokens_details: { reasoning_tokens: 2 } } })}\n\n`] : []),
    "data: [DONE]\n\n",
  ].join(""));
}

describe("bounded source-bound Scene projection", () => {
  it("keeps unambiguous user references authoritative while applying an unrelated assistant fact", async () => {
    const userText = "She stays with us. That task remains unfinished.";
    const assistantText = "Mina left. We called the hotel. It is dawn.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(fetch.mock.calls.length === 1 ? JSON.stringify({
      ...JSON.parse(projectionJson()),
      participant_present: [{ evidence: "She stays with us.", value: null, scope: "current" }],
      thread_unfinished: [{ evidence: "That task remains unfinished.", value: null, referent: null, scope: "current" }],
    }) : projectionJson([
      { evidence: "Mina left.", field: "participant_absent", value: "Mina" },
      { evidence: "We called the hotel.", field: "thread_completed", value: "call the hotel", referent: "the hotel" },
      { evidence: "It is dawn.", field: "time", value: "dawn" },
    ])));
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, time: "dawn" });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 5 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["participant_present", "thread_unfinished"])("does not guess an unnamed %s among multiple anchors", async field => {
    const previous = { ...input.previous, participants: ["Mina", "Jun"], unresolvedThreads: ["call the hotel", "choose the train"] };
    const userText = field === "participant_present" ? "She stays with us." : "That task remains unfinished.";
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(JSON.stringify({
      ...JSON.parse(projectionJson()),
      [field]: [{ evidence: userText, value: null, scope: "current", ...(field === "thread_unfinished" ? { referent: null } : {}) }],
    })));
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_reference_ambiguous" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { field: "participant_present", introduced: "Nora arrived.", value: "Nora", reference: "She stays with us.", assistantText: "Mina left.", assistantFact: { evidence: "Mina left.", field: "participant_absent", value: "Mina" } },
    { field: "thread_unfinished", introduced: "We must repair the stove.", value: "repair the stove", referent: "the stove", reference: "That task remains unfinished.", assistantText: "We called the hotel.", assistantFact: { evidence: "We called the hotel.", field: "thread_completed", value: "call the hotel", referent: "the hotel" } },
  ])("rejects an unnamed $field when this source introduces a competing candidate", async ({ field, introduced, value, referent, reference, assistantText, assistantFact }) => {
    const userText = `${introduced} ${reference}`;
    // Hand-authored extraction facts expose binding behavior, not model accuracy.
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(fetch.mock.calls.length === 1 ? JSON.stringify({
      ...JSON.parse(projectionJson()),
      [field]: [
        { evidence: reference, value: null, scope: "current", ...(referent ? { referent: null } : {}) },
        { evidence: introduced, value, scope: "current", ...(referent ? { referent } : {}) },
      ],
    }) : projectionJson([assistantFact])));
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_reference_ambiguous" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { introduced: "Mina stays with us.", value: "Mina", scope: "current" },
    { introduced: 'The log says "Nora arrived."', value: "Nora", scope: "current" },
    { introduced: "Nora may arrive tomorrow.", value: "Nora", scope: "future" },
  ])("retains the unique person when another fact repeats the anchor or is not current: $introduced", async ({ introduced, value, scope }) => {
    const reference = "She stays with us.", userText = `${introduced} ${reference}`;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(JSON.stringify({
      ...JSON.parse(projectionJson()),
      participant_present: [
        { evidence: reference, value: null, scope: "current" },
        { evidence: introduced.includes('"') ? "Nora arrived." : introduced, value, scope },
      ],
    })));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence.status).toBe("unchanged");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves a task when an accepted normalized proposal has the same object but a different action", async () => {
    const previous = { ...input.previous, unresolvedThreads: ["pay the hotel"] }, userText = "We called the hotel.";
    // Hand-authored bad normalization, not a recorded provider output.
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(fetch.mock.calls.length === 1 ? projectionJson([{ field: "thread_completed", value: "pay the hotel", referent: "the hotel", evidence: userText }]) : JSON.stringify({ statuses: ["pending"] })));
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_completion_not_supported" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    "We finished choosing the train.",
    "We finished selecting the train.",
    "I examined the train options and chose the train. That decision is made now.",
  ])("resolves only the verified prior task, including a paraphrase or indirect reference: %s", async userText => {
    const previous = { ...input.previous, unresolvedThreads: ["choose the train", "call the hotel"] };
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(fetch.mock.calls.length === 1
      ? projectionJson([{ field: "thread_completed", value: "choose the train", referent: "the train", evidence: userText }])
      : JSON.stringify({ statuses: ["completed"] })));
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5, unresolvedThreads: ["call the hotel"] });
    expect(previous.unresolvedThreads).toEqual(["choose the train", "call the hotel"]);
    expect(result.evidence.status).toBe("applied");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("checks effective tasks against their own source, records both physical phases and charges all usage", async () => {
    const previous = { ...input.previous, unresolvedThreads: ["choose the train", "call the hotel"] };
    const userText = "We chose the train.", assistantText = "We called the hotel.";
    const bodies: Array<{ response_format: { json_schema: { name: string } }; messages: Array<{ role: string; content: string }> }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      const payload = JSON.parse(body.messages[1].content);
      return response(body.response_format.json_schema.name === "scene_task_statuses"
        ? JSON.stringify({ statuses: ["completed"] })
        : projectionJson([{ field: "thread_completed", value: payload.text === userText ? "choose the train" : "call the hotel", referent: payload.text === userText ? "the train" : "the hotel", evidence: payload.text }]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5, unresolvedThreads: [] });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(result.evidence.usage).toEqual({ promptTokens: 92, completionTokens: 32, reasoningTokens: 8 });
    expect(result.evidence.requests.map(request => request.phaseId)).toEqual(["user:extraction", "assistant:extraction", "user:completion", "assistant:completion"]);
    for (const [index, source] of [userText, assistantText].entries()) {
      expect(bodies[index + 2]).toMatchObject({ response_format: SCENE_COMPLETION_RESPONSE_FORMAT, max_tokens: 96, temperature: 0, top_p: 1 });
      expect(bodies[index + 2]!.messages).toEqual([
        { role: "system", content: SCENE_COMPLETION_PROMPT },
        { role: "user", content: JSON.stringify({ previous, text: source, tasks: [previous.unresolvedThreads[index]] }) },
      ]);
    }
    expect(result.evidence.completionPromptDigest).toBe(createHash("sha256").update(SCENE_COMPLETION_PROMPT).digest("hex"));
    expect(JSON.stringify(result.evidence)).not.toContain(userText);
    expect(JSON.stringify(result.evidence)).not.toContain(assistantText);
    expect(JSON.stringify(result.evidence)).not.toContain("secret");
  });

  it.each([
    { statuses: ["pending"], code: "scene_completion_not_supported" },
    { statuses: ["uncertain"], code: "scene_completion_not_supported" },
    { statuses: [], code: "scene_completion_invalid" },
    { statuses: ["completed", "completed"], code: "scene_completion_invalid" },
    { statuses: ["completed"], verified: true, code: "scene_completion_invalid" },
  ])("preserves the entire anchor after unsupported or invalid task completion: %j", async ({ code, ...receipt }) => {
    const userText = "Now we are at the beach. We called the hotel, or perhaps not.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(fetch.mock.calls.length === 1 ? projectionJson([
      { field: "location", value: "the beach", evidence: input.userText },
      { field: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: "We called the hotel, or perhaps not." },
    ]) : JSON.stringify(receipt)));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: code, changeCount: 0, phases: [expect.objectContaining({ kind: "extraction", status: "applied" }), expect.objectContaining({ kind: "completion", status: "rejected" })] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { finish: "length", usage: true, code: "scene_projection_incomplete" },
    { finish: "stop", usage: false, code: "scene_projection_usage_missing" },
  ])("does not reuse extraction usage to hide a failed completion phase: $code", async ({ finish, usage, code }) => {
    const userText = "We called the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => fetch.mock.calls.length === 1
      ? response(projectionJson([{ field: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: userText }]))
      : response(JSON.stringify({ statuses: ["completed"] }), finish, usage));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: code });
    expect(result.evidence.usage).toEqual(usage ? { promptTokens: 46, completionTokens: 16, reasoningTokens: 4 } : null);
    expect(result.evidence.phases[1]).toMatchObject({ source: "user", kind: "completion", usage: usage ? expect.any(Object) : null });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not replenish the output budget for the deletion check", async () => {
    const userText = "We called the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(projectionJson([{ field: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: userText }]), "stop", true, 23, 768));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_projection_budget_exceeded", usage: { promptTokens: 23, completionTokens: 768 } });
    expect(result.evidence.phases[1]?.maxOutputTokens).toBe(0);
    expect(result.evidence.requests).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("spends the extraction's actual input before admitting a completion check", async () => {
    const userText = "We called the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(projectionJson([{ field: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: userText }]), "stop", true, 5_995));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "failed", usage: { promptTokens: 5_995, completionTokens: 8 } });
    expect(result.evidence.phases[1]).toMatchObject({ kind: "completion", maxInputTokens: 5, usage: null });
    expect(result.evidence.requests).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("clamps the completion check to the remaining actual output allowance", async () => {
    const userText = "We called the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => fetch.mock.calls.length === 1
      ? response(projectionJson([{ field: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: userText }]), "stop", true, 23, 760)
      : response(JSON.stringify({ statuses: ["completed"] })));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene.unresolvedThreads).toEqual([]);
    expect(result.evidence.usage?.completionTokens).toBe(768);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).max_tokens).toBe(8);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not let the caller mutate the anchor while a completion is checked", async () => {
    const previous = structuredClone(input.previous), userText = "We called the hotel.";
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => {
      if (fetch.mock.calls.length === 1) return response(projectionJson([{ field: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: userText }]));
      started.resolve(); return await finish.promise;
    });
    const running = projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    await started.promise;
    previous.location = "the station"; previous.unresolvedThreads.push("invented later task");
    finish.resolve(response(JSON.stringify({ statuses: ["completed"] })));
    expect((await running).scene).toEqual({ ...input.previous, version: 5, unresolvedThreads: [] });
  });

  it("aborts the completion check without deletion, retry or fabricated usage", async () => {
    const userText = "We called the hotel.", controller = new AbortController(), started = Promise.withResolvers<void>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      if (fetch.mock.calls.length === 1) return response(projectionJson([{ field: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: userText }]));
      started.resolve(); return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    });
    const running = projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: controller.signal, fetch });
    await started.promise; controller.abort(new Error("run deadline"));
    const result = await running;
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "cancelled", failureCode: "scene_projection_cancelled", usage: null, requests: [expect.any(Object), expect.any(Object)] });
    expect(result.evidence.phases[1]).toMatchObject({ source: "user", kind: "completion", status: "cancelled", usage: null });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects the exact saved policy14 response and keeps the complete anchor", async () => {
    const previous = { ...input.previous, location: "the observatory", time: "midnight", participants: ["Lila"] };
    const userText = "Lila stays here with us.", assistantText = "Lila left for home.";
    // Saved physical responses chatcmpl-7b63e874 / chatcmpl-43fa4e35.
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(fetch.mock.calls.length === 1 ? projectionJson() : JSON.stringify({
      location: [], time: [], participant_present: [], emotionalBeat: [], thread_unfinished: [],
      participant_absent: [{ evidence: assistantText, value: "Lila", scope: "individual" }],
      thread_completed: [{ evidence: assistantText, value: "call the hotel", scope: "current" }],
    })));
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_delta_invalid", changeCount: 0 });
    expect(result.evidence.usage).toEqual({ promptTokens: 46, completionTokens: 16, reasoningTokens: 4 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an old task even with a valid scope when its referent is not in the source", async () => {
    const userText = "Lila left for home.";
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(JSON.stringify({
      location: [], time: [], participant_present: [], participant_absent: [], emotionalBeat: [], thread_unfinished: [],
      thread_completed: [{ evidence: userText, value: "call the hotel", referent: "the hotel", scope: "current" }],
    })));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_value_mismatch" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sends byte-identical source-only requests under counterfactual frozen anchors", async () => {
    const bodies: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => { bodies.push(String(init?.body)); return response(); });
    const options = { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch };
    await projectSceneForReply({ ...input, assistantText: "" }, options);
    await projectSceneForReply({ ...input, previous: { ...emptySceneState(), version: 9, location: "温室", participants: ["阿岚"], unresolvedThreads: ["修好收音机"] }, assistantText: "" }, options);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(JSON.parse(bodies[0]!).messages[1].content)).toEqual({ text: input.userText });
  });

  it("applies both source phases when valid negative user facts are absent from the frozen anchor", async () => {
    const previous = emptySceneState();
    const userText = "Jun left. We finished calling the venue. It is dawn.";
    const assistantText = "Jun joins us. We must call the venue. I feel calm.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(projectionJson(fetch.mock.calls.length === 1 ? [
      { field: "participant_absent", value: "Jun", evidence: "Jun left." },
      { field: "thread_completed", value: "call the venue", referent: "the venue", evidence: "We finished calling the venue." },
      { field: "time", value: "dawn", evidence: "It is dawn." },
    ] : [
      { field: "participant_present", value: "Jun", evidence: "Jun joins us." },
      { field: "thread_unfinished", value: "call the venue", referent: "the venue", evidence: "We must call the venue." },
      { field: "emotionalBeat", value: "calm", evidence: "I feel calm." },
    ])));
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, time: "dawn", emotionalBeat: "calm" });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 6, usage: { promptTokens: 46, completionTokens: 16, reasoningTokens: 4 } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("verifies only a real task deletion when unknown and existing completions share a source", async () => {
    const previous = { ...emptySceneState(), unresolvedThreads: ["repair the radio"] };
    const userText = "We finished calling the venue. We finished repairing the radio. It is dawn.";
    const bodies: Array<{ messages: Array<{ content: string }> }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body)));
      return response(fetch.mock.calls.length === 1 ? projectionJson([
        { field: "thread_completed", value: "call the venue", referent: "the venue", evidence: "We finished calling the venue." },
        { field: "thread_completed", value: "repair the radio", referent: "the radio", evidence: "We finished repairing the radio." },
        { field: "time", value: "dawn", evidence: "It is dawn." },
      ]) : JSON.stringify({ statuses: ["completed"] }));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, time: "dawn", unresolvedThreads: [] });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 3, usage: { promptTokens: 46, completionTokens: 16, reasoningTokens: 4 } });
    expect(JSON.parse(bodies[1]!.messages[1]!.content).tasks).toEqual(["repair the radio"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { field: "time", value: "dawn" }, { field: "emotionalBeat", value: "calm" },
    { field: "participant_present", value: "Mina" }, { field: "participant_absent", value: "Mina" },
    { field: "thread_unfinished", value: "call the hotel", referent: "the hotel" },
    { field: "thread_completed", value: "call the hotel", referent: "the hotel" },
  ])("allows individual scope only for a location, not $field", async ({ field, value, ...binding }) => {
    const userText = `Mina feels calm at dawn. We must call the hotel.`;
    const fields = JSON.parse(projectionJson());
    fields[field] = [{ evidence: userText, value, scope: "individual", ...binding }];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(JSON.stringify(fields)));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_delta_invalid" });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
  });

  it.each([
    { task: "choose the train", referent: "the train", text: "We finished choosing the train." },
    { task: "修好收音机", referent: "收音机", text: "我们已经修好了收音机。" },
  ])("accepts source-bound task normalization without requiring the whole prior wording: $task", async ({ task, referent, text }) => {
    const previous = { ...input.previous, unresolvedThreads: [task, "keep another commitment"] };
    const fields = JSON.parse(projectionJson());
    fields.thread_completed = [{ evidence: text, value: task, referent, scope: "current" }];
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(JSON.stringify(fetch.mock.calls.length === 1 ? fields : { statuses: ["completed"] })));
    const result = await projectSceneForReply({ ...input, previous, userText: text, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5, unresolvedThreads: ["keep another commitment"] });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 1 });
  });

  it("retains only the explicitly referenced scalar and fences a conflicting assistant location", async () => {
    const userText = "We stay here.", assistantText = "We are in the greenhouse.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(JSON.stringify({
      ...JSON.parse(projectionJson()), location: [{ evidence: fetch.mock.calls.length === 1 ? userText : assistantText, value: fetch.mock.calls.length === 1 ? null : "the greenhouse", scope: "current" }],
    })));
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "unchanged", changeCount: 2 });
  });

  it.each([
    { text: 'The log says "We stay here."', evidence: "We stay here.", scope: "current" },
    { text: 'The log says "We stay here."', evidence: "We stay here.", scope: "quoted" },
    { text: "Tomorrow we might stay here.", evidence: "Tomorrow we might stay here.", scope: "future" },
  ])("does not let a quoted or future retain claim fence the current assistant: $scope", async ({ text, evidence, scope }) => {
    const assistantText = "We are in the greenhouse.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(JSON.stringify({
      ...JSON.parse(projectionJson()), location: fetch.mock.calls.length === 1 ? [{ evidence, value: null, scope }] : [{ evidence: assistantText, value: "the greenhouse", scope: "current" }],
    })));
    const result = await projectSceneForReply({ ...input, userText: text, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, location: "the greenhouse" });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 1 });
  });

  it("retains explicit named user presence against a current departure with an individual destination", async () => {
    const previous = { ...input.previous, participants: ["Lila"] };
    const userText = "Lila stays here with us.", assistantText = "Lila left for home.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(projectionJson(fetch.mock.calls.length === 1
      ? [{ evidence: userText, field: "participant_present", value: "Lila" }]
      : [{ evidence: assistantText, field: "participant_absent", value: "Lila" }, { evidence: assistantText, field: "location", value: "home", scope: "individual" }])));
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "unchanged", changeCount: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves unknown when retaining a scalar absent from the frozen anchor", async () => {
    const userText = "We stay here.";
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(JSON.stringify({
      ...JSON.parse(projectionJson()), location: [{ evidence: userText, value: null, scope: "current" }],
    })));
    const previous = emptySceneState();
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1 });
    expect(result.evidence).toMatchObject({ status: "unchanged", changeCount: 1 });
  });

  it("accepts source-normalized presence and unfinished commitments without contradictory event labels", async () => {
    const userText = "Mina did not leave. We have not called the hotel.";
    const assistantText = "Mina left for the station. We finished calling the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(JSON.stringify(fetch.mock.calls.length === 1 ? {
      location: [], time: [], emotionalBeat: [],
      participant_present: [{ evidence: "Mina did not leave.", value: "Mina", scope: "current" }], participant_absent: [],
      thread_unfinished: [{ evidence: "We have not called the hotel.", value: "call the hotel", referent: "the hotel", scope: "current" }], thread_completed: [],
    } : {
      location: [{ evidence: "Mina left for the station.", value: "the station", scope: "individual" }], time: [], emotionalBeat: [], participant_present: [],
      participant_absent: [{ evidence: "Mina left for the station.", value: "Mina", scope: "current" }], thread_unfinished: [],
      thread_completed: [{ evidence: "We finished calling the hotel.", value: "call the hotel", referent: "the hotel", scope: "current" }],
    })));
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "unchanged", changeCount: 4 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("applies the seven field-specific current relationships from one source atomically", async () => {
    const userText = "We are in the greenhouse. It is dawn. Mina left. Ana is with us. I feel calm. We must repair the stove. We called the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(JSON.stringify(fetch.mock.calls.length === 1 ? {
      location: [{ evidence: "We are in the greenhouse.", value: "the greenhouse", scope: "current" }],
      time: [{ evidence: "It is dawn.", value: "dawn", scope: "current" }],
      participant_present: [{ evidence: "Ana is with us.", value: "Ana", scope: "current" }],
      participant_absent: [{ evidence: "Mina left.", value: "Mina", scope: "current" }],
      emotionalBeat: [{ evidence: "I feel calm.", value: "calm", scope: "current" }],
      thread_unfinished: [{ evidence: "We must repair the stove.", value: "repair the stove", referent: "the stove", scope: "current" }],
      thread_completed: [{ evidence: "We called the hotel.", value: "call the hotel", referent: "the hotel", scope: "current" }],
    } : { statuses: ["completed"] })));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, location: "the greenhouse", time: "dawn", participants: ["Ana"], emotionalBeat: "calm", unresolvedThreads: ["repair the stove"] });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 7 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("derives presence and unfinished-task authority from source-bound negative facts", async () => {
    const userText = "Mina did not leave. We have not called the hotel.";
    const assistantText = "Mina left for the station. We finished calling the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(projectionJson(fetch.mock.calls.length === 1 ? [
      { evidence: "Mina did not leave.", field: "participant_present", value: "Mina" },
      { evidence: "We have not called the hotel.", field: "thread_unfinished", value: "call the hotel", referent: "the hotel" },
    ] : [
      { evidence: "Mina left for the station.", field: "participant_absent", value: "Mina" },
      { evidence: "Mina left for the station.", field: "location", value: "the station", scope: "individual" },
      { evidence: "We finished calling the hotel.", field: "thread_completed", value: "call the hotel", referent: "the hotel" },
    ])));
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence.status).toBe("unchanged"); expect(result.evidence.changeCount).toBe(4);
  });

  it("cannot turn quoted source evidence into a current fact even with an incorrect current classification", async () => {
    const quoted = "We are in the courtyard at dawn with Nina.";
    const userText = `The stage manager wrote "${quoted}"`, assistantText = "Now we are in the greenhouse.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(projectionJson(fetch.mock.calls.length === 1 ? [
      { evidence: quoted, field: "location", value: "the courtyard" },
      { evidence: quoted, field: "time", value: "at dawn" },
      { evidence: quoted, field: "participant_present", value: "Nina" },
    ] : [{ evidence: assistantText, field: "location", value: "the greenhouse" }])));
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, location: "the greenhouse" });
    expect(result.evidence.status).toBe("applied"); expect(result.evidence.changeCount).toBe(1);
  });

  it("ignores an individual destination and past emotion without losing actual arrivals and departures", async () => {
    const userText = "Mina leaves for the station. Ravi arrived. Yesterday I felt worried.";
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(projectionJson([
      { evidence: "Mina leaves for the station.", field: "location", value: "the station", scope: "individual" },
      { evidence: "Mina leaves for the station.", field: "participant_absent", value: "Mina" },
      { evidence: "Ravi arrived.", field: "participant_present", value: "Ravi" },
      { evidence: "Yesterday I felt worried.", field: "emotionalBeat", value: "worried", scope: "past" },
    ])));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, participants: ["Ravi"] }); expect(result.evidence.status).toBe("applied");
  });
  it("accepts a quoted name in an actual presence clause without accepting a quoted event", async () => {
    const userText = '“Nora” joins us. The log says "Mina left."';
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(projectionJson([
      { evidence: '“Nora” joins us.', field: "participant_present", value: "Nora" },
      { evidence: "Mina left.", field: "participant_absent", value: "Mina" },
    ])));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, participants: ["Mina", "Nora"] });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 1 });
  });

  it.each([
    { field: "participant_present", opposite: "participant_absent", value: "Mina", evidence: "Mina stayed. Mina left." },
    { field: "thread_unfinished", opposite: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: "We still need to call the hotel. We called the hotel." },
  ])("rejects contradictory current relationships atomically: $field", async ({ field, opposite, value, evidence, ...binding }) => {
    const userText = `${input.userText} ${evidence}`;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(projectionJson([
      { evidence: input.userText, field: "location", value: "the beach" },
      { evidence, field, value, ...binding }, { evidence, field: opposite, value, ...binding },
    ])));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_fact_relation_mismatch", changeCount: 0 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sends only exact current sources, records physical usage, and ignores reply-length caps", async () => {
    const physicalBodies: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const physicalBody = String(init?.body);
      physicalBodies.push(physicalBody);
      const payload = JSON.parse(JSON.parse(physicalBody).messages[1].content);
      return response(projectionJson(payload.text === input.userText ? [{ evidence: "Now we are at the beach.", field: "location", value: "the beach" }] : []));
    });
    const result = await projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [index, physicalBody] of physicalBodies.entries()) {
      const body = JSON.parse(physicalBody);
      expect(body.messages).toEqual([
        { role: "system", content: SCENE_PROJECTION_PROMPT },
        { role: "user", content: JSON.stringify({ text: index === 0 ? input.userText : input.assistantText }) },
      ]);
      expect(body).toMatchObject({ response_format: SCENE_RESPONSE_FORMAT, max_tokens: 384, temperature: 0, top_p: 1 });
      expect(body.tools).toBeUndefined();
      expect(result.evidence.requests[index]?.bodyDigest).toBe(createHash("sha256").update(physicalBody).digest("hex"));
    }
    expect(result.scene).toEqual({ ...input.previous, version: 5, location: "the beach" });
    expect(result.evidence).toMatchObject({
      status: "applied", attemptId: input.attemptId, anchorVersion: 4,
      sourceMessageIds: { user: "user-1", assistant: "assistant-1" }, changeCount: 1,
      usage: { promptTokens: 46, completionTokens: 16, reasoningTokens: 4 },
      phases: [
        expect.objectContaining({ source: "user", requestId: "physical-request-1", actualProvider: "local", maxInputTokens: 6_000 }),
        expect.objectContaining({ source: "assistant", requestId: "physical-request-1", actualProvider: "local" }),
      ],
    });
    expect(result.evidence.phases[1]!.maxInputTokens).toBe(6_000 - result.evidence.requests[0]!.estimatedInputTokens);
    expect(result.evidence.phases.reduce((total, phase) => total + phase.maxOutputTokens, 0)).toBe(768);
    expect(JSON.stringify(result.evidence)).not.toContain(input.userText);
    expect(JSON.stringify(result.evidence)).not.toContain("secret");
    expect(input.previous.version).toBe(4);
  });

  it.each([
    { text: "not JSON", finish: "stop", usage: true, code: "scene_delta_invalid" },
    { text: '{"changes":[]}', finish: "stop", usage: true, code: "scene_delta_invalid" },
    { text: projectionJson([{ evidence: input.userText, field: "location", value: "the beach" }, { evidence: input.userText, field: "location", value: "the beach" }]), finish: "stop", usage: true, code: "scene_delta_invalid" },
    { text: projectionJson([{ evidence: "A different message", field: "location", value: "the station" }]), finish: "stop", usage: true, code: "scene_evidence_mismatch" },
    { text: projectionJson([{ evidence: "I stay beside you.", field: "emotionalBeat", value: "stay" }]), finish: "stop", usage: true, code: "scene_evidence_mismatch" },
    { text: projectionJson(), finish: "length", usage: true, code: "scene_projection_incomplete" },
    { text: projectionJson(), finish: "stop", usage: false, code: "scene_projection_usage_missing" },
  ])("preserves the full anchor after an unusable result, with no retry: $code", async ({ text, finish, usage, code }) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(text, finish, usage));
    const result = await projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 4_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: code, changeCount: 0 });
    expect(result.evidence.requests).toHaveLength(1);
    expect(result.evidence.usage).toEqual(usage ? { promptTokens: 23, completionTokens: 8, reasoningTokens: 2 } : null);
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.scene.participants).not.toBe(input.previous.participants);
  });

  it("records an unavailable provider without silently selecting another model", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await projectSceneForReply(input, { profile: { ...profile, adapter: "mock-v1" }, apiKey: "secret", maxInputTokens: 4_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "unavailable", failureCode: "scene_provider_unavailable", requests: [], usage: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects excess total changes across user and assistant HTTP source slots", async () => {
    const userChange = { evidence: input.userText, field: "participant_present", value: "the beach" };
    const assistantChange = { evidence: input.assistantText, field: "participant_present", value: "stay" };
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(projectionJson(fetch.mock.calls.length === 1 ? Array(9).fill(userChange) : Array(8).fill(assistantChange))));
    const result = await projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_delta_invalid", usage: { promptTokens: 46, completionTokens: 16 } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects excess input before any physical request and keeps the old Scene", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 20, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence.status).toBe("failed");
    expect(result.evidence.requests).toEqual([]);
    expect(result.evidence.usage).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("makes one request on provider failure and exposes unknown usage instead of inventing zero", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: "unavailable" }, { status: 503 }));
    const result = await projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 4_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "failed", requests: [expect.any(Object)], usage: null });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("discards the user delta if the assistant phase fails and retains known partial usage", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => fetch.mock.calls.length === 1
      ? response(projectionJson([{ evidence: "Now we are at the beach.", field: "location", value: "the beach" }]))
      : response(projectionJson(), "stop", false));
    const result = await projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({
      status: "rejected", failureCode: "scene_projection_usage_missing", usage: null,
      phases: [
        { source: "user", status: "applied", usage: { promptTokens: 23, completionTokens: 8 } },
        { source: "assistant", status: "rejected", usage: null },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("enforces the cumulative input budget before sending the second request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const first = await projectSceneForReply({ ...input, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 4_000, signal: new AbortController().signal, fetch });
    fetch.mockClear();
    const result = await projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: first.evidence.requests[0]!.estimatedInputTokens + 1, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence.phases[1]?.maxInputTokens).toBe(1);
    expect(result.evidence.requests).toHaveLength(1);
    expect(result.evidence.usage).toEqual({ promptTokens: 23, completionTokens: 8, reasoningTokens: 2 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("accounts for actual input above the estimate before budgeting the second source", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(undefined, "stop", true, 3_995));
    const result = await projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 4_000, signal: new AbortController().signal, fetch });
    expect(result.evidence.phases[1]?.maxInputTokens).toBe(5);
    expect(result.evidence.usage?.promptTokens).toBe(3_995);
    expect(result.evidence.requests).toHaveLength(1);
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("skips empty sources and gives a sole source the shared output cap", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const options = { profile, apiKey: "secret", maxInputTokens: 4_000, signal: new AbortController().signal, fetch };
    const single = await projectSceneForReply({ ...input, userText: " \n" }, options);
    expect(single.evidence.requests).toHaveLength(1);
    expect(single.evidence.phases).toEqual([expect.objectContaining({ source: "assistant", maxOutputTokens: 768 })]);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).max_tokens).toBe(768);
    fetch.mockClear();
    const empty = await projectSceneForReply({ ...input, userText: "", assistantText: " " }, options);
    expect(empty.scene).toEqual({ ...input.previous, version: 5 });
    expect(empty.evidence).toMatchObject({ status: "unchanged", requests: [], phases: [], usage: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("merges explicit unchanged user facts ahead of conflicting assistant changes", async () => {
    const userText = "We still need to call the hotel.";
    const assistantText = "We finished calling the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(projectionJson(fetch.mock.calls.length === 1
      ? [{ evidence: userText, field: "thread_unfinished", value: "call the hotel", referent: "the hotel" }]
      : [{ evidence: assistantText, field: "thread_completed", value: "call the hotel", referent: "the hotel" }])));
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "unchanged", changeCount: 2, requests: [expect.any(Object), expect.any(Object)] });
  });

  it("honors an already cancelled run before contacting the provider", async () => {
    const controller = new AbortController();
    const reason = new Error("run cancelled");
    controller.abort(reason);
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 4_000, signal: controller.signal, fetch })).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts a pending projection with the run and retains its physical request fact", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      started.resolve();
      return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    });
    const running = projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 4_000, signal: controller.signal, fetch });
    await started.promise;
    controller.abort(new Error("run deadline"));
    const result = await running;
    expect(result.evidence).toMatchObject({ status: "cancelled", failureCode: "scene_projection_cancelled", requests: [expect.any(Object)], usage: null });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
