import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { chatSceneStateSchema } from "@idream/shared/contracts";
import type { PreparedTurnProfile } from "./agent-runtime/contracts.js";
import capturedBudget from "./fixtures/scene-source-budget.json";
import capturedObjectCase from "./fixtures/scene-source-object-case.json";
import { emptySceneState, projectSceneForReply, SCENE_COMPLETION_PROMPT, sceneCompletionResponseFormat, SCENE_PROJECTION_PROMPT, SCENE_RESPONSE_FORMAT } from "./scene.js";

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

// Actual product assistant source; any extraction/decision fixtures below are explicitly controlled.
const actualWateringSource = "The greenhouse is still cool and hushed, that pale green light coming in low through the glass. I kneel by the terracotta pot, testing the top of the soil with my thumb the way you like — the way *our* basil likes.\n\n\"Nearly dry,\" I say, glancing over at Mina, who's watching with that quiet amused expression of hers. \"Good. Too much water before sun's up and the roots just sit there, soggy.\" I reach for the watering can, pour slow and even around the base, not flooding the leaves. \"There. Tuesday's not here yet, but ours seemed to sigh when it got wet.\"\n\nMina leans against the bench beside me. \"You two and your basil,\" she says, but there's no sting in it. \"I'll admit it's nicer to breathe in here than out there.\"\n\nI set the can down and brush dirt off my hands, settling in beside you against the warm glass. \"We've got time before the day gets loud. Want to tell me what you'd like grown next beside it — or just sit a while longer?\"";

function projectionJson(facts: Array<{ evidence: string; field: string; value: string; scope?: string; referent?: string; authority?: "open" | "hold" | "forbid" }> = []) {
  const fields = ["location", "time", "participant_present", "participant_absent", "emotionalBeat", "thread_unfinished", "thread_completed"];
  return JSON.stringify(Object.fromEntries(fields.map(field => [field, facts.filter(fact => fact.field === field).map(({ evidence, value, scope, referent, authority }) => ({ evidence, value, scope: scope ?? "current", ...(referent ? { referent } : {}), ...(field === "thread_unfinished" ? { authority: authority ?? "open" } : {}) }))])));
}

function response(text = projectionJson(), finishReason = "stop", includeUsage = true, promptTokens = 23, completionTokens = 8) {
  return new Response([
    `data: ${JSON.stringify({ id: "physical-request-1", provider: "local", choices: [{ delta: { content: text }, finish_reason: finishReason }] })}\n\n`,
    ...(includeUsage ? [`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, completion_tokens_details: { reasoning_tokens: 2 } } })}\n\n`] : []),
    "data: [DONE]\n\n",
  ].join(""));
}

// Default receipt for fixtures whose source leaves every known task pending.
function pendingCompletion(init: RequestInit | undefined): Response | undefined {
  const body = JSON.parse(String(init?.body));
  if (body.response_format.json_schema.name !== "scene_task_decisions") return undefined;
  return response(decisionJson(init));
}

// Literal fixture identities only. Semantic alias cases provide explicit receipts.
function decisionJson(init: RequestInit | undefined, status: string | ((task: string) => string) = "pending") {
  const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content) as { known: string[]; candidates: string[] };
  const state = typeof status === "function" ? status : () => status;
  return completionJson(init, { known: payload.known.map(state), candidates: payload.candidates.map(state), bindings: payload.candidates.map(value => {
    const index = payload.known.indexOf(value);
    return index < 0 ? null : index;
  }) });
}

// These existing task/scalar fixtures use controlled, literal named-person
// decisions. Identity, actor, ambiguity and receipt attacks have independent
// hand-authored regressions in scene-participant-authority.test.ts.
function completionJson(init: RequestInit | undefined, tasks: unknown) {
  const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
  return JSON.stringify({ ...tasks as object, ...(payload.participants ? { participants: {
    anchor: payload.participants.anchor,
    decisions: payload.participants.claims.map((claim: { field: string; value: string | null }) => ({
      relation: claim.value === null ? "reference" : claim.field === "participant_arrived" ? "present" : "absent", name: claim.value,
    })),
  } } : {}) });
}


// Recorded Ornith responses exercise validation/projection; the final task status
// below is a local fixture and does not claim natural-model completion coverage.
const recordedExtraction = {
  "original-scene": {
    "source": "We are in a greenhouse at dawn. I feel calm. Mina is here with us. We still need to water the basil.",
    "raw": "{\"location\":[{\"evidence\":\"We are in a greenhouse at dawn.\",\"value\":\"greenhouse\",\"scope\":\"current\"}],\"time\":[{\"evidence\":\"We are in a greenhouse at dawn.\",\"value\":\"dawn\",\"scope\":\"current\"}],\"participant_present\":[{\"evidence\":\"Mina is here with us.\",\"value\":\"Mina\",\"scope\":\"current\"}],\"participant_absent\":[],\"emotionalBeat\":[{\"evidence\":\"I feel calm.\",\"value\":\"calm\",\"scope\":\"current\"}],\"thread_unfinished\":[{\"evidence\":\"We still need to water the basil.\",\"value\":\"water the basil\",\"scope\":\"current\",\"referent\":\"the basil\",\"authority\":\"open\"}],\"thread_completed\":[]}",
    "requestId": "chatcmpl-50a9ef9e"
  },
  "relative-location-holdout": {
    "source": "We stay here. It is dawn. I feel calm. Reply only with All right.",
    "raw": "{\"location\":[{\"evidence\":\"We stay here.\",\"value\":null,\"scope\":\"current\"}],\"time\":[{\"evidence\":\"It is dawn.\",\"value\":\"dawn\",\"scope\":\"current\"}],\"participant_present\":[],\"participant_absent\":[],\"emotionalBeat\":[{\"evidence\":\"I feel calm.\",\"value\":\"calm\",\"scope\":\"current\"}],\"thread_unfinished\":[],\"thread_completed\":[]}",
    "requestId": "chatcmpl-573291d7"
  },
  "no-new-facts": {
    "source": "Thank you. Please continue.",
    "raw": "{\"location\":[],\"time\":[],\"participant_present\":[],\"participant_absent\":[],\"emotionalBeat\":[],\"thread_unfinished\":[],\"thread_completed\":[]}",
    "requestId": "chatcmpl-1a177a39"
  },
  "new-metadialogue-formatting": {
    "source": "My earlier message said \"Use two paragraphs.\" Please make your response brief.",
    "raw": "{\"location\":[],\"time\":[],\"participant_present\":[],\"participant_absent\":[],\"emotionalBeat\":[],\"thread_unfinished\":[],\"thread_completed\":[]}",
    "requestId": "chatcmpl-2316f3e2"
  },
  "new-place-world-task": {
    "source": "We are in a boathouse. We need to varnish the oars.",
    "raw": "{\"location\":[{\"evidence\":\"We are in a boathouse.\",\"value\":\"boathouse\",\"scope\":\"current\"}],\"time\":[],\"participant_present\":[],\"participant_absent\":[],\"emotionalBeat\":[],\"thread_unfinished\":[{\"evidence\":\"We need to varnish the oars.\",\"value\":\"varnish the oars\",\"scope\":\"current\",\"referent\":\"the oars\",\"authority\":\"open\"}],\"thread_completed\":[]}",
    "requestId": "chatcmpl-58596183"
  },
  "invalid-metadialogue": {
    "source": "Thank you. Please continue.",
    "raw": "{\"location\":[],\"time\":[],\"participant_present\":[],\"participant_absent\":[],\"emotionalBeat\":[],\"thread_unfinished\":[{\"evidence\":\"Please continue.\",\"value\":\"continue\",\"scope\":\"current\",\"referent\":null,\"authority\":\"open\"}],\"thread_completed\":[]}",
    "requestId": "chatcmpl-d999f375"
  }
} as const;

describe("recorded scene extraction projection", () => {
  it("keeps the actual mis-cased task object rejected without advancing unrelated facts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(capturedObjectCase.sse));
    const result = await projectSceneForReply({ ...input, ...capturedObjectCase, previous: chatSceneStateSchema.parse(capturedObjectCase.previous) }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...capturedObjectCase.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: capturedObjectCase.expectedFailureCode, usage: { promptTokens: 1_163, completionTokens: 117, reasoningTokens: 0 } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("binds an exact capitalized object to its frozen task while preserving the user's incomplete state", async () => {
    const previous = { ...input.previous, unresolvedThreads: ["open the notebook"] };
    const userText = "The notebook is still unopened. We are in the reading room.";
    const assistantText = "I opened the notebook.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const fromUser = JSON.parse(body.messages[1].content).text === userText;
      if (body.response_format.json_schema.name === "scene_task_decisions") {
        expect(JSON.parse(body.messages[1].content).candidates).toEqual([fromUser ? "open The notebook" : "open the notebook"]);
        return response(JSON.stringify({ known: [fromUser ? "hold" : "completed"], candidates: [fromUser ? "hold" : "completed"], bindings: [0] }));
      }
      return response(projectionJson(fromUser ? [
        { field: "thread_unfinished", value: "open The notebook", referent: "The notebook", evidence: "The notebook is still unopened.", authority: "hold" },
        { field: "location", value: "the reading room", evidence: "We are in the reading room." },
      ] : [{ field: "thread_completed", value: "open the notebook", referent: "the notebook", evidence: assistantText }]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5, location: "the reading room" });
    expect(result.evidence.status).toBe("applied");
    expect(result.evidence.requests.reduce((sum, request) => sum + request.estimatedInputTokens, 0)).toBeLessThanOrEqual(6_000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    { id: "original-scene", location: "greenhouse", time: "dawn", emotion: "calm", participants: ["Mina"], tasks: ["water the basil"] },
    { id: "new-place-world-task", location: "boathouse", time: null, emotion: null, participants: [], tasks: ["varnish the oars"] },
  ] as const)("retains complete recorded world facts and task objects: $id", async fixture => {
    const captured = recordedExtraction[fixture.id];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => response(fetch.mock.calls.length === 1 ? captured.raw : decisionJson(init)));
    const result = await projectSceneForReply({ ...input, previous: emptySceneState(), userText: captured.source, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...emptySceneState(), version: 1, location: fixture.location, time: fixture.time, emotionalBeat: fixture.emotion, participants: fixture.participants, unresolvedThreads: fixture.tasks });
    expect(result.evidence.status).toBe("applied");
    expect(JSON.parse(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).messages[1].content).candidates).toEqual(fixture.tasks);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, "the kitchen"])("preserves the anchor's unnamed location from the recorded relative reference: %s", async location => {
    const captured = recordedExtraction["relative-location-holdout"];
    const previous = { ...emptySceneState(), location };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(captured.raw));
    const result = await projectSceneForReply({ ...input, previous, userText: captured.source, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, time: "dawn", emotionalBeat: "calm" });
    expect(result.evidence.status).toBe("applied");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["no-new-facts", "new-metadialogue-formatting"] as const)("does not create scene facts from the recorded metadialogue: %s", async id => {
    const captured = recordedExtraction[id];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => pendingCompletion(init) ?? response(captured.raw));
    const result = await projectSceneForReply({ ...input, userText: captured.source, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence.status).toBe("unchanged");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects the recorded malformed metadialogue task instead of accepting a bare action", async () => {
    const captured = recordedExtraction["invalid-metadialogue"];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(captured.raw));
    const result = await projectSceneForReply({ ...input, userText: captured.source, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_delta_invalid" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});


describe("source-level scene degradation", () => {
  it("rejects the real user-source premature completion instead of deleting the outstanding task", async () => {
    const previous = { ...emptySceneState(), ...capturedBudget.previous, schemaVersion: 1 as const };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init, "completed"));
      return response(capturedBudget.responses[0]!.content);
    });
    const result = await projectSceneForReply({ ...input, previous, userText: capturedBudget.userText, assistantText: "I watered the basil." }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 10 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_completion_evidence_conflict", acceptedPhaseIds: [], changeCount: 0 });
    expect(result.evidence.phases[1]).toMatchObject({ id: "user:completion", status: "rejected" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["completed", "hold", "forbid"])("rejects a bare known-task %s state without source-bound support", async state => {
    const previous = { ...emptySceneState(), unresolvedThreads: ["repair the radio"] };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => response(JSON.parse(String(init?.body)).response_format.json_schema.name === "scene_task_decisions" ? decisionJson(init, state) : projectionJson()));
    const result = await projectSceneForReply({ ...input, previous, userText: "I will explain the radio later.", assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_completion_evidence_conflict", acceptedPhaseIds: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { field: "thread_completed", authority: undefined, state: "pending", userText: "I finished repairing the radio." },
    { field: "thread_unfinished", authority: "hold", state: "pending", userText: "No, the radio has not been repaired." },
    { field: "thread_unfinished", authority: "forbid", state: "pending", userText: "Do not repair the radio." },
    { field: "thread_unfinished", authority: "open", state: "hold", userText: "We still need to repair the radio." },
    { field: "thread_unfinished", authority: "open", state: "forbid", userText: "We still need to repair the radio." },
  ] as const)("rejects disagreeing task evidence instead of silently accepting $field/$authority as $state", async ({ field, authority, state, userText }) => {
    const previous = { ...emptySceneState(), unresolvedThreads: ["repair the radio"] };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => response(JSON.parse(String(init?.body)).response_format.json_schema.name === "scene_task_decisions"
      ? decisionJson(init, state)
      : projectionJson([{ field, authority, value: "repair the radio", referent: "the radio", evidence: userText }])));
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_completion_evidence_conflict", acceptedPhaseIds: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not delete a known task after rejecting the assistant's extraction", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), text = JSON.parse(body.messages[1].content).text;
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init, text === input.userText ? "pending" : "completed"));
      return response(projectionJson([{ field: "location", evidence: text, value: text === input.userText ? "the beach" : "the moon" }]));
    });
    const result = await projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, location: "the beach" });
    expect(result.evidence).toMatchObject({ status: "degraded", failureCode: "scene_value_mismatch", acceptedPhaseIds: ["user:extraction", "user:completion"] });
    expect(result.evidence.phases.map(phase => phase.id)).toEqual(["user:extraction", "user:completion", "assistant:extraction"]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("can finish a task on the next turn after growing the frozen table from 16 to 17", async () => {
    let previous = { ...emptySceneState(), unresolvedThreads: Array.from({ length: 16 }, (_, index) => `repair radio ${index}`) };
    for (const [turn, task] of ["repair radio 16", "repair radio 0"].entries()) {
      const userText = turn === 0 ? `We must ${task}.` : `I finished this task: ${task}.`;
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
        const body = JSON.parse(String(init?.body));
        return response(body.response_format.json_schema.name === "scene_task_decisions"
          ? decisionJson(init, value => turn === 1 && value === task ? "completed" : "pending")
          : projectionJson([{ field: turn === 0 ? "thread_unfinished" : "thread_completed", evidence: userText, value: task, referent: turn === 0 ? "radio 16" : "radio 0" }]));
      });
      const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
      expect(result.evidence.status).toBe("applied");
      expect(result.scene.unresolvedThreads).toHaveLength(turn === 0 ? 17 : 16);
      expect(fetch).toHaveBeenCalledTimes(2);
      previous = result.scene;
    }
    expect(previous.unresolvedThreads).not.toContain("repair radio 0");
    expect(previous.unresolvedThreads).toContain("repair radio 16");
  });

  it.each([17, 32])("validates identities against the complete %s-task frozen table", async count => {
    const previous = { ...emptySceneState(), unresolvedThreads: Array.from({ length: count }, (_, index) => `repair radio ${index}`) };
    const task = previous.unresolvedThreads[count - 1]!, userText = `I finished this task: ${task}.`;
    for (const invalid of [false, true]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
        const body = JSON.parse(String(init?.body));
        if (body.response_format.json_schema.name !== "scene_task_decisions") return response(projectionJson([{ field: "thread_completed", evidence: userText, value: task, referent: `radio ${count - 1}` }]));
        expect(body.response_format.json_schema.schema.properties).toMatchObject({ known: { minItems: count, maxItems: count }, candidates: { minItems: 1, maxItems: 1 }, bindings: { minItems: 1, maxItems: 1, items: { anyOf: [{ type: "integer", minimum: 0, maximum: count - 1 }, { type: "null" }] } } });
        const receipt = JSON.parse(decisionJson(init, value => value === task ? "completed" : "pending"));
        if (invalid) receipt.bindings[0] = count;
        return response(JSON.stringify(receipt));
      });
      const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
      expect(result.scene.unresolvedThreads).toEqual(invalid ? previous.unresolvedThreads : previous.unresolvedThreads.slice(0, -1));
      expect(result.evidence.status).toBe(invalid ? "rejected" : "applied");
      if (invalid) expect(result.evidence.failureCode).toBe("scene_completion_identity_invalid");
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it.each(["hold", "forbid"] as const)("binds a differently worded user %s to the exact frozen task", async authority => {
    const previous = { ...emptySceneState(), unresolvedThreads: ["water the basil", "return the book"] };
    const userText = authority === "hold" ? "No, water basil remains unfinished this turn." : "Do not water basil.";
    const assistantText = "I finished watering the basil. I returned the book.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content), user = payload.text === userText;
      if (body.response_format.json_schema.name === "scene_task_decisions") {
        expect(Object.keys(payload)).toEqual(["text", "known", "candidates"]);
        expect(payload.known).toEqual(previous.unresolvedThreads);
        return response(JSON.stringify(user
          ? { known: [authority, "pending"], candidates: [authority], bindings: [0] }
          : { known: ["completed", "completed"], candidates: ["completed", "completed"], bindings: [0, 1] }));
      }
      return response(projectionJson(user
        ? [{ field: "thread_unfinished", evidence: userText, value: "water basil", referent: "basil", authority }]
        : [{ field: "thread_completed", evidence: "I finished watering the basil.", value: "water the basil", referent: "the basil" },
          { field: "thread_completed", evidence: "I returned the book.", value: "return the book", referent: "the book" }]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, unresolvedThreads: ["water the basil"] });
    expect(result.evidence.status).toBe("applied");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("corroborates completion and a repetition ban across two aliases of one identity", async () => {
    const previous = { ...emptySceneState(), unresolvedThreads: ["pack the suitcase", "return the book"] };
    const userText = "I packed the suitcase. Do not pack suitcase again.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format.json_schema.name === "scene_task_decisions") {
        expect(JSON.parse(body.messages[1].content)).toEqual({ text: userText, known: previous.unresolvedThreads, candidates: ["pack suitcase", "pack the suitcase"] });
        return response(JSON.stringify({ known: ["completed", "pending"], candidates: ["completed", "completed"], bindings: [0, 0] }));
      }
      return response(projectionJson([
        { field: "thread_completed", value: "pack the suitcase", referent: "the suitcase", evidence: "I packed the suitcase." },
        { field: "thread_unfinished", value: "pack suitcase", referent: "suitcase", evidence: "Do not pack suitcase again.", authority: "forbid" },
      ]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, unresolvedThreads: ["return the book"] });
    expect(result.evidence.status).toBe("applied");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["past", "current"] as const)("preserves a later correction while rejecting contradictory current aliases (earlier=%s)", async scope => {
    const previous = { ...emptySceneState(), unresolvedThreads: ["repair the radio", "return the book"] };
    const userText = "I repaired the radio. No, I was mistaken. The radio is not repaired.";
    const assistantText = "I repaired the radio. I returned the book.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content), user = payload.text === userText;
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(JSON.stringify(user
        ? { known: ["hold", "pending"], candidates: payload.candidates.map(() => "hold"), bindings: payload.candidates.map(() => 0) }
        : { known: ["completed", "completed"], candidates: ["completed", "completed"], bindings: [0, 1] }));
      return response(projectionJson(user ? [
        { field: "thread_completed", value: "repair the radio", referent: "the radio", evidence: "I repaired the radio.", scope },
        { field: "thread_unfinished", value: "repair radio", referent: "radio", evidence: "The radio is not repaired.", authority: "hold" },
      ] : [
        { field: "thread_completed", value: "repair the radio", referent: "the radio", evidence: "I repaired the radio." },
        { field: "thread_completed", value: "return the book", referent: "the book", evidence: "I returned the book." },
      ]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, unresolvedThreads: scope === "past" ? ["repair the radio"] : previous.unresolvedThreads });
    expect(result.evidence.status).toBe(scope === "past" ? "applied" : "rejected");
    if (scope === "current") expect(result.evidence.failureCode).toBe("scene_completion_evidence_conflict");
    expect(fetch).toHaveBeenCalledTimes(scope === "past" ? 4 : 2);
  });

  it("protects a new user prohibition from an assistant's differently worded task", async () => {
    const previous = emptySceneState(), userText = "Do not water basil.", assistantText = "We still need to water the basil.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content), user = payload.text === userText;
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(JSON.stringify(user
        ? { known: [], candidates: ["forbid"], bindings: [null] }
        : { known: ["pending"], candidates: ["pending"], bindings: [0] }));
      return response(projectionJson([{ field: "thread_unfinished", evidence: payload.text, value: user ? "water basil" : "water the basil", referent: user ? "basil" : "the basil", authority: user ? "forbid" : "open" }]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1 });
    expect(result.evidence.status).toBe("unchanged");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([false, true])("bounds the real regenerated source and controlled task receipts at the free cap (overflow=%s)", async overflow => {
    const previous = { ...emptySceneState(), ...capturedBudget.previous, schemaVersion: 1 as const };
    const assistantText = actualWateringSource + (overflow ? `\n${"x".repeat(4000)}` : "");
    // Only the user extraction is historical captured output. Assistant task
    // evidence and both receipts are controlled, not recovered policy23 output.
    // Pin this prompt's request bytes; keep historical response bytes and
    // business assertions intact rather than relabeling an old provider call.
    const expectedDigests = ["8f724796c3d7aafe00edd64ee0f112be21576d4053762e1528f61d3351c48c5d",
      "7ae9f7211f6b2979b909d74f24fa1677b3b0214abc227eac2d25d59138662aa4",
      "5b75dcd4cb1131467a8eebc82178c496de45117fa64f0664ed0b4c6c9822edde",
      "29c4ec125a211a8c9dc6beb8721e18e5bc587d43252a550698c80f71c569fcf3"];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const index = fetch.mock.calls.length - 1, body = JSON.parse(String(init?.body));
      if (!overflow) expect(createHash("sha256").update(String(init?.body)).digest("hex")).toBe(expectedDigests[index]);
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(completionJson(init, index === 1
        ? { known: ["pending"], candidates: ["pending"], bindings: [0] }
        : { known: ["completed"], candidates: ["completed"], bindings: [0] }));
      if (index === 2) return response(projectionJson([{ field: "thread_completed", value: "water our basil", referent: "basil", evidence: actualWateringSource.slice(0, actualWateringSource.indexOf('"There.')) }]));
      const captured = capturedBudget.responses[0]!;
      return new Response([
        `data: ${JSON.stringify({ id: captured.requestId, model: capturedBudget.model, choices: [{ delta: { content: captured.content }, finish_reason: captured.finishReason }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: captured.usage })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));
    });
    const result = await projectSceneForReply({ ...input, previous, userText: capturedBudget.userText, assistantText }, {
      profile: { ...profile, model: capturedBudget.model }, apiKey: "offline-fixture", maxInputTokens: 6_000, signal: new AbortController().signal, fetch,
    });
    expect(result.scene).toEqual({ ...previous, version: 10, unresolvedThreads: overflow ? previous.unresolvedThreads : [] });
    expect(result.evidence).toMatchObject({ status: overflow ? "degraded" : "applied", acceptedPhaseIds: ["user:extraction", "user:completion", ...overflow ? [] : ["assistant:extraction", "assistant:completion"]] });
    expect(result.evidence.phases[2]).toMatchObject({ status: "applied" });
    if (overflow) {
      expect(result.evidence.failureCode).toBe("INPUT_BUDGET_EXCEEDED");
      expect(result.evidence.phases[3]).toMatchObject({ id: "assistant:completion", status: "failed", failureCode: "INPUT_BUDGET_EXCEEDED", usage: null });
      expect(result.evidence.requests.map(request => request.phaseId)).toEqual(["user:extraction", "user:completion", "assistant:extraction"]);
      expect(fetch).toHaveBeenCalledTimes(3);
    } else {
      expect(result.evidence.requests.map(request => request.estimatedInputTokens)).toEqual([2119, 1026, 2343, 817]);
      expect(result.evidence.phases.map(phase => phase.maxInputTokens)).toEqual([6000, 6000, 5047, 2704]);
      expect(result.evidence.requests.every(request => request.estimatedInputTokens <= 6_000)).toBe(true);
      expect(result.evidence.phases.map(phase => phase.maxOutputTokens)).toEqual([384, 384, 384, 384]);
      expect(result.evidence.usage).toEqual({ promptTokens: 1230, completionTokens: 160, reasoningTokens: 6 });
      expect(fetch).toHaveBeenCalledTimes(4);
    }
  });

  it("preserves the user checkpoint after the captured assistant extraction is rejected", async () => {
    const previous = { ...emptySceneState(), ...capturedBudget.previous, schemaVersion: 1 as const };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init));
      return response(capturedBudget.responses[fetch.mock.calls.length === 1 ? 0 : 2]!.content);
    });
    const result = await projectSceneForReply({ ...input, previous, userText: capturedBudget.userText, assistantText: capturedBudget.assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 10 });
    expect(result.evidence).toMatchObject({ status: "degraded", failureCode: "scene_value_mismatch", acceptedPhaseIds: ["user:extraction", "user:completion"] });
    expect(result.evidence.phases).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("cancels after the user checkpoint without accepting any source facts", async () => {
    const controller = new AbortController(), started = Promise.withResolvers<void>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content);
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init));
      if (payload.text === input.userText) return response(projectionJson([{ field: "location", evidence: input.userText, value: "the beach" }]));
      started.resolve();
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    });
    const pending = projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: controller.signal, fetch });
    await started.promise;
    controller.abort(new Error("cancel after user checkpoint"));
    const result = await pending;
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "cancelled", acceptedPhaseIds: [], changeCount: 0, usage: null });
    expect(result.evidence.phases[1]).toMatchObject({ id: "user:completion", status: "unchanged" });
    expect(result.evidence.phases[2]).toMatchObject({ id: "assistant:extraction", status: "cancelled" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([true, false])("requires grounded user completion while retaining semantic alias binding (extracted=%s)", async extracted => {
    const previous = { ...emptySceneState(), unresolvedThreads: ["water the basil"] };
    const userText = "I finished watering basil.", assistantText = "We still need to water the basil.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content);
      if (body.response_format.json_schema.name === "scene_task_decisions") {
        const fromUser = payload.text === userText;
        expect(payload).toEqual({ text: fromUser ? userText : assistantText, known: ["water the basil"], candidates: fromUser ? extracted ? ["water basil"] : [] : ["water the basil"] });
        const state = fromUser ? "completed" : "pending";
        return response(JSON.stringify({ known: [state], candidates: payload.candidates.map(() => state), bindings: payload.candidates.map(() => 0) }));
      }
      return response(projectionJson(payload.text === userText
        ? extracted ? [{ field: "thread_completed", evidence: userText, value: "water basil", referent: "basil" }] : []
        : [{ field: "thread_unfinished", evidence: assistantText, value: "water the basil", referent: "the basil" }]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, unresolvedThreads: extracted ? [] : previous.unresolvedThreads });
    expect(result.evidence).toMatchObject(extracted ? { status: "applied", acceptedPhaseIds: ["user:extraction", "user:completion", "assistant:extraction", "assistant:completion"] } : { status: "rejected", failureCode: "scene_completion_evidence_conflict", acceptedPhaseIds: [] });
    expect(result.evidence.requests.map(request => request.phaseId)).toEqual(extracted ? ["user:extraction", "user:completion", "assistant:extraction", "assistant:completion"] : ["user:extraction", "user:completion"]);
    expect(fetch).toHaveBeenCalledTimes(extracted ? 4 : 2);
  });

  it("stops after malformed detailed usage instead of continuing with an unknown input budget", async () => {
    const content = projectionJson([{ field: "location", value: "the beach", evidence: input.userText }]);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 23, completion_tokens: 8, prompt_tokens_details: { cached_tokens: "unknown" } } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("")));
    const result = await projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_projection_usage_missing", acceptedPhaseIds: [], usage: null });
    expect(result.evidence.requests).toHaveLength(1);
    expect(result.evidence.phases).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["usage missing", "transport interrupted"])("stops after assistant extraction with unknown consumption: %s", async failure => {
    const userText = "We are at the beach. We still need to call the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content);
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init), "stop", true, 23, 96);
      if (payload.text === userText) return response(projectionJson([
        { field: "location", evidence: "We are at the beach.", value: "the beach" },
        { field: "thread_unfinished", evidence: "We still need to call the hotel.", value: "call the hotel", referent: "the hotel" },
      ]), "stop", true, 23, 384);
      expect(body.max_tokens).toBe(288);
      if (failure === "transport interrupted") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection lost")); } }));
      return response(projectionJson(), "stop", false);
    });
    const result = await projectSceneForReply({ ...input, userText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, location: "the beach" });
    expect(result.evidence).toMatchObject({ status: "degraded", usage: null, acceptedPhaseIds: ["user:extraction", "user:completion"] });
    expect(result.evidence.phases.map(phase => phase.id)).toEqual(["user:extraction", "user:completion", "assistant:extraction"]);
    expect(result.evidence.phases[2]).toMatchObject({ usage: null, maxOutputTokens: 288 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retains validated user facts when the assistant source is invalid", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content);
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init));
      return response(projectionJson([{ field: "location", evidence: payload.text, value: payload.text === input.userText ? "the beach" : "the moon" }]));
    });
    const result = await projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, location: "the beach" });
    expect(result.evidence).toMatchObject({
      status: "degraded", failureCode: "scene_value_mismatch", changeCount: 1,
      acceptedPhaseIds: ["user:extraction", "user:completion"],
      phases: [
        { id: "user:extraction", status: "applied" },
        { id: "user:completion", status: "unchanged" },
        { id: "assistant:extraction", status: "rejected" },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not request a completion after rejecting a sole assistant extraction", async () => {
    const previous = input.previous;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content);
      return response(projectionJson([{ field: "location", evidence: payload.text, value: payload.text === input.userText ? "the beach" : "the moon" }]), "stop", true, 8_187);
    });
    const result = await projectSceneForReply({ ...input, previous, userText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5 });
    expect(result.evidence).toMatchObject({
      status: "rejected", failureCode: "scene_value_mismatch", acceptedPhaseIds: [],
      phases: [
        { id: "assistant:extraction", status: "rejected", failureCode: "scene_value_mismatch" },
      ],
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("independent final status for known assistant tasks", () => {
  // This is the real policy20 assistant text. Its omitted task facts and the
  // completion receipt below are controlled fixtures, not recovered model JSON.
  it.each([true, false])("keeps the actual watering task when extraction omitted completion evidence (prior=%s)", async priorTask => {
    const previous = { ...emptySceneState(), version: 9, location: priorTask ? "greenhouse" : "the kitchen", time: "dawn", emotionalBeat: "calm", participants: ["Mina"], unresolvedThreads: priorTask ? ["water the basil"] : [] };
    const bodies: Array<{ messages: Array<{ content: string }>; max_tokens: number }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      const payload = JSON.parse(body.messages[1].content), fromUser = payload.text === recordedExtraction["original-scene"].source;
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init, fromUser ? "pending" : "completed"), "stop", true, fromUser ? 287 : 510, 6);
      return response(fromUser ? recordedExtraction["original-scene"].raw : projectionJson(), "stop", true, fromUser ? 1161 : 1373, fromUser ? 136 : 92);
    });
    const result = await projectSceneForReply({ ...input, previous, userText: recordedExtraction["original-scene"].source, assistantText: actualWateringSource }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 10, location: "greenhouse", unresolvedThreads: ["water the basil"] });
    expect(result.evidence.status).toBe(priorTask ? "unchanged" : "applied");
    expect(result.evidence.requests.map(request => request.phaseId)).toEqual(["user:extraction", "user:completion", "assistant:extraction"]);
    expect(result.evidence.usage).toEqual({ promptTokens: 2821, completionTokens: 234, reasoningTokens: 6 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retains frozen tasks without a source-bound completion candidate", async () => {
    const previous = { ...emptySceneState(), unresolvedThreads: ["repair the radio", "return the book"] };
    const assistantText = "I replaced the broken wire and tested it. The radio works now; the book remains on the table.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      return response(body.response_format.json_schema.name === "scene_task_decisions" ? decisionJson(init, task => JSON.parse(body.messages[1].content).text === assistantText && task === "repair the radio" ? "completed" : "pending") : projectionJson());
    });
    const result = await projectSceneForReply({ ...input, previous, userText: "Please go on.", assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, unresolvedThreads: previous.unresolvedThreads });
    expect(result.evidence.phases.at(-1)).toMatchObject({ id: "assistant:extraction", changeCount: 0, status: "unchanged" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { authority: "hold", field: "thread_unfinished", userText: "No, the radio is still broken; keep the repair unfinished.", expected: ["repair the radio"] },
    { authority: "forbid", field: "thread_unfinished", userText: "Do not repair the radio.", expected: ["repair the radio"] },
    { authority: undefined, field: "thread_completed", userText: "I finished repairing the radio.", expected: [] },
  ] as const)("protects user $authority/$field authority after checking the full assistant identity table", async fixture => {
    const previous = { ...emptySceneState(), unresolvedThreads: ["repair the radio", "return the book"] };
    const assistantText = "I repaired the radio and returned the book.";
    const batches: Array<{ text: string; known: string[]; candidates: string[] }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content), fromUser = payload.text === fixture.userText;
      if (body.response_format.json_schema.name === "scene_task_decisions") {
        batches.push(payload);
        return response(decisionJson(init, task => fromUser ? task === "repair the radio" ? fixture.field === "thread_completed" ? "completed" : fixture.authority! : "pending" : "completed"));
      }
      return response(fromUser ? projectionJson([{ field: fixture.field, evidence: fixture.userText, value: "repair the radio", referent: "the radio", ...(fixture.authority ? { authority: fixture.authority } : {}) }]) : projectionJson([{ field: "thread_completed", evidence: assistantText, value: "repair the radio", referent: "the radio" }, { field: "thread_completed", evidence: assistantText, value: "return the book", referent: "the book" }]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText: fixture.userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, unresolvedThreads: fixture.expected });
    expect(batches.filter(batch => batch.text === assistantText)).toEqual([{ text: assistantText, known: previous.unresolvedThreads, candidates: previous.unresolvedThreads }]);
  });

  it.each([
    { receipt: { known: ["uncertain"], candidates: ["uncertain"], bindings: [0] }, usage: true, code: "scene_completion_not_supported" },
    { receipt: { known: [], candidates: [], bindings: [] }, usage: true, code: "scene_completion_invalid" },
    { receipt: { known: ["completed"], candidates: ["completed"], bindings: [0], verified: true }, usage: true, code: "scene_completion_invalid" },
    { receipt: { known: ["completed"], candidates: ["completed"], bindings: [0] }, usage: false, code: "scene_projection_usage_missing" },
  ])("keeps the user checkpoint when a grounded task's final receipt fails: $code", async ({ receipt, usage, code }) => {
    const previous = { ...emptySceneState(), location: "the kitchen", unresolvedThreads: ["repair the radio"] };
    const assistantText = "We are in the workshop. I fixed the radio.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      return body.response_format.json_schema.name === "scene_task_decisions" ? response(JSON.parse(body.messages[1].content).text === assistantText ? JSON.stringify(receipt) : decisionJson(init), "stop", JSON.parse(body.messages[1].content).text !== assistantText || usage)
        : response(JSON.parse(body.messages[1].content).text === assistantText ? projectionJson([{ field: "location", evidence: "We are in the workshop.", value: "the workshop" }, { field: "thread_completed", evidence: "I fixed the radio.", value: "repair the radio", referent: "the radio" }]) : projectionJson());
    });
    const result = await projectSceneForReply({ ...input, previous, userText: "Go on.", assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1 });
    expect(result.evidence).toMatchObject({ status: "degraded", failureCode: code });
    expect(result.evidence.usage).toEqual(usage ? { promptTokens: 92, completionTokens: 32, reasoningTokens: 8 } : null);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("keeps a known task when its independent final status is pending", async () => {
    const previous = { ...emptySceneState(), unresolvedThreads: ["repair the radio"] };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => response(JSON.parse(String(init?.body)).response_format.json_schema.name === "scene_task_decisions" ? decisionJson(init) : projectionJson()));
    const result = await projectSceneForReply({ ...input, previous, userText: "Go on.", assistantText: "I only looked at the casing; I have not repaired it." }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1 });
    expect(result.evidence.status).toBe("unchanged");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("bounded source-bound Scene projection", () => {
  it("accepts an actual completion alongside a prohibition against repeating the task", async () => {
    const userText = "I finished repairing the radio. Do not repair the radio again.";
    const previous = { ...emptySceneState(), unresolvedThreads: ["repair the radio"] };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => response(fetch.mock.calls.length === 1
      ? projectionJson([{ field: "thread_completed", evidence: "I finished repairing the radio.", value: "repair the radio", referent: "the radio" },
        { field: "thread_unfinished", evidence: "Do not repair the radio again.", value: "repair the radio", referent: "the radio", authority: "forbid" }])
      : decisionJson(init, "completed")));
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, unresolvedThreads: [] });
    expect(result.evidence.status).toBe("applied");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects conflicting authority labels for the same task in one normalized source", async () => {
    const userText = "We still need to repair the radio. Do not repair the radio.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => response(fetch.mock.calls.length === 1
      ? projectionJson([{ field: "thread_unfinished", evidence: "We still need to repair the radio.", value: "repair the radio", referent: "the radio", authority: "open" },
        { field: "thread_unfinished", evidence: "Do not repair the radio.", value: "repair the radio", referent: "the radio", authority: "forbid" }])
      : decisionJson(init)));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_fact_relation_mismatch" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("makes one final-status decision per task despite repeated source facts", async () => {
    const userText = "We finished repairing the radio. I finished repairing the radio.";
    const previous = { ...emptySceneState(), unresolvedThreads: ["repair the radio"] };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init, "completed"));
      return response(projectionJson(["We finished repairing the radio.", "I finished repairing the radio."].map(evidence => ({ field: "thread_completed", evidence, value: "repair the radio", referent: "the radio" }))));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, unresolvedThreads: [] });
    expect(JSON.parse(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).messages[1].content).known).toEqual(["repair the radio"]);
    expect(result.evidence.phases[1]).toMatchObject({ status: "applied", changeCount: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "assume_open", true])("rejects missing or invalid task authority instead of assuming open: %s", async authority => {
    const userText = "We still need to repair the radio.";
    const candidate = JSON.parse(projectionJson([{ field: "thread_unfinished", value: "repair the radio", referent: "the radio", evidence: userText }]));
    if (authority === undefined) delete candidate.thread_unfinished[0].authority;
    else candidate.thread_unfinished[0].authority = authority;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(JSON.stringify(candidate)));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_delta_invalid" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { assistantText: "I will repair the radio tomorrow.", evidence: "I will repair the radio tomorrow.", scope: "future" },
    { assistantText: "Yesterday I repaired the radio.", evidence: "Yesterday I repaired the radio.", scope: "past" },
    { assistantText: 'The diary says "I finished repairing the radio."', evidence: "I finished repairing the radio.", scope: "current" },
    { assistantText: "If we had a spare wire, I would have repaired the radio.", evidence: "If we had a spare wire, I would have repaired the radio.", scope: "hypothetical" },
  ])("does not complete an open user task from a non-current assistant event: $scope", async ({ assistantText, evidence, scope }) => {
    const userText = "We still need to repair the radio.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), fromUser = JSON.parse(body.messages[1].content).text === userText;
      return response(body.response_format.json_schema.name === "scene_task_decisions" ? decisionJson(init)
        : projectionJson([{ field: fromUser ? "thread_unfinished" : "thread_completed", value: "repair the radio", referent: "the radio", evidence: fromUser ? userText : evidence, scope: fromUser ? "current" : scope }]));
    });
    const result = await projectSceneForReply({ ...input, previous: emptySceneState(), userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene.unresolvedThreads).toEqual(["repair the radio"]);
    expect(result.evidence.requests.map(request => request.phaseId)).toEqual(["user:extraction", "user:completion", "assistant:extraction"]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["user", "assistant"] as const)("rejects conflicting $source completion and pending evidence without applying other source facts", async source => {
    const userText = source === "user" ? "It is dawn. We called the hotel, or perhaps not." : "We still need to call the hotel.";
    const assistantText = source === "assistant" ? "It is dawn. We called the hotel, or perhaps not." : "";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), text = JSON.parse(body.messages[1].content).text;
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init));
      return response(text.includes("It is dawn.") ? projectionJson([
        { field: "time", evidence: "It is dawn.", value: "dawn" },
        { field: "thread_completed", evidence: "We called the hotel, or perhaps not.", value: "call the hotel", referent: "the hotel" },
      ]) : projectionJson([{ field: "thread_unfinished", evidence: userText, value: "call the hotel", referent: "the hotel" }]));
    });
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 6_000, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence.status).toBe(source === "user" ? "rejected" : "degraded");
    expect(result.evidence.failureCode).toBe("scene_completion_evidence_conflict");
    expect(result.evidence.phases.at(-1)).toMatchObject({ source, kind: "completion", status: "rejected" });
    expect(fetch).toHaveBeenCalledTimes(source === "user" ? 2 : 4);
  });

  it.each([
    { receipt: { known: ["uncertain"], candidates: ["uncertain"], bindings: [0] }, usage: true, code: "scene_completion_not_supported" },
    { receipt: { known: ["completed"], candidates: ["completed"], bindings: [0], verified: true }, usage: true, code: "scene_completion_invalid" },
    { receipt: { known: ["completed"], candidates: ["completed"], bindings: [0] }, usage: false, code: "scene_projection_usage_missing" },
  ])("does not apply a cross-source completion without a valid independent receipt: $code", async ({ receipt, usage, code }) => {
    const userText = "We still need to repair the radio.", assistantText = "I finished repairing the radio.";
    const previous = emptySceneState();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), fromUser = JSON.parse(body.messages[1].content).text === userText;
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(fromUser ? decisionJson(init) : JSON.stringify(receipt), "stop", fromUser || usage);
      return response(projectionJson([{ field: fromUser ? "thread_unfinished" : "thread_completed", value: "repair the radio", referent: "the radio", evidence: fromUser ? userText : assistantText }]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, unresolvedThreads: ["repair the radio"] });
    expect(result.evidence).toMatchObject({ status: "degraded", failureCode: code });
    expect(result.evidence.usage).toEqual(usage ? { promptTokens: 92, completionTokens: 32, reasoningTokens: 8 } : null);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("cannot replenish the budget for the assistant after checking an open user task", async () => {
    const userText = "We still need to repair the radio.", assistantText = "I finished repairing the radio.";
    const previous = emptySceneState();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), fromUser = JSON.parse(body.messages[1].content).text === userText;
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init), "stop", true, 23, 96);
      return response(projectionJson([{ field: fromUser ? "thread_unfinished" : "thread_completed", value: "repair the radio", referent: "the radio", evidence: fromUser ? userText : assistantText }]), "stop", true, 23, fromUser ? 384 : 288);
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, unresolvedThreads: ["repair the radio"] });
    expect(result.evidence).toMatchObject({ status: "degraded", failureCode: "scene_projection_budget_exceeded", usage: { promptTokens: 69, completionTokens: 768 } });
    expect(result.evidence.phases[3]).toMatchObject({ source: "assistant", kind: "completion", maxOutputTokens: 0, usage: null });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { language: "English", existing: false, task: "repair the radio", referent: "the radio", userText: "We still need to repair the radio.", assistantText: "I replaced the broken wire and tested it. I finished repairing the radio." },
    { language: "English", existing: true, task: "repair the radio", referent: "the radio", userText: "We still need to repair the radio.", assistantText: "I replaced the broken wire and tested it. I finished repairing the radio." },
    { language: "Chinese", existing: false, task: "修好收音机", referent: "收音机", userText: "收音机还需要修理。", assistantText: "我换好了坏掉的电线，测试正常，收音机已经修好了。" },
    { language: "Chinese", existing: true, task: "修好收音机", referent: "收音机", userText: "收音机还需要修理。", assistantText: "我换好了坏掉的电线，测试正常，收音机已经修好了。" },
  ])("allows verified assistant progress on an open $language task (existing=$existing)", async ({ existing, task, referent, userText, assistantText }) => {
    const previous = { ...emptySceneState(), unresolvedThreads: [...(existing ? [task] : []), "return the book"] };
    const bodies: Array<{ messages: Array<{ content: string }> }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      const fromUser = JSON.parse(body.messages[1].content).text === userText;
      return response(body.response_format.json_schema.name === "scene_task_decisions"
        ? decisionJson(init, value => !fromUser && value === task ? "completed" : "pending")
        : projectionJson([{ field: fromUser ? "thread_unfinished" : "thread_completed", evidence: fromUser ? userText : assistantText, value: task, referent }]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, unresolvedThreads: ["return the book"] });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(result.evidence.requests.map(request => request.phaseId)).toEqual(["user:extraction", "user:completion", "assistant:extraction", "assistant:completion"]);
    expect(JSON.parse(bodies[3]!.messages[1]!.content)).toEqual({ text: assistantText, known: [...previous.unresolvedThreads, ...existing ? [] : [task]], candidates: [task] });
    expect(result.evidence.usage).toEqual({ promptTokens: 92, completionTokens: 32, reasoningTokens: 8 });
  });

  it.each([
    { authority: "hold", userText: "No, the radio has not been repaired. That task remains unfinished.", task: "repair the radio", referent: "the radio" },
    { authority: "forbid", userText: "Do not repair the radio.", task: "repair the radio", referent: "the radio" },
    { authority: "hold", userText: "不是，收音机还没修好；这件事仍然没有完成。", task: "修好收音机", referent: "收音机" },
    { authority: "forbid", userText: "不要修理收音机。", task: "修好收音机", referent: "收音机" },
  ] as const)("protects a user $authority while allowing a different task to progress: $userText", async fixture => {
    const { task, referent } = fixture;
    const assistantText = `I finished ${task}. I returned the book.`, userText = fixture.userText;
    const previous = { ...emptySceneState(), unresolvedThreads: [task, "return the book"] };
    const checked: Array<{ text: string; known: string[]; candidates: string[] }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content);
      if (body.response_format.json_schema.name === "scene_task_decisions") {
        checked.push(payload);
        return response(decisionJson(init, value => payload.text === userText ? value === task ? fixture.authority : "pending" : "completed"));
      }
      return response(projectionJson(payload.text === userText
        ? [{ field: "thread_unfinished", evidence: userText, value: task, referent, authority: fixture.authority }]
        : [{ field: "thread_completed", evidence: `I finished ${task}.`, value: task, referent }, { field: "thread_completed", evidence: "I returned the book.", value: "return the book", referent: "the book" }]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, unresolvedThreads: [task] });
    expect(checked.filter(check => check.text === assistantText).map(check => check.known)).toEqual([previous.unresolvedThreads]);
    expect(checked.filter(check => check.text === userText)).toHaveLength(1);
  });

  it.each([
    { userText: "Do not repair the radio.", assistantText: "I finished repairing the radio.", task: "repair the radio", referent: "the radio" },
    { userText: "不要修理收音机。", assistantText: "收音机已经修好了。", task: "修好收音机", referent: "收音机" },
  ])("does not create a commitment from a prohibition: $userText", async ({ userText, assistantText, task, referent }) => {
    const previous = emptySceneState();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), fromUser = JSON.parse(body.messages[1].content).text === userText;
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init, fromUser ? "forbid" : "completed"));
      return response(projectionJson(fromUser ? [{ field: "thread_unfinished", value: task, referent, evidence: userText, authority: "forbid" }]
        : [{ field: "thread_completed", value: task, referent, evidence: assistantText }]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1 });
    expect(result.evidence.status).toBe("unchanged");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not equate an open task with another completed action on the same object", async () => {
    const userText = "We still need to repair the radio.", assistantText = "I sold the radio.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), fromUser = JSON.parse(body.messages[1].content).text === userText;
      return response(body.response_format.json_schema.name === "scene_task_decisions" ? decisionJson(init, task => !fromUser && task === "sell the radio" ? "completed" : "pending")
        : projectionJson([{ field: fromUser ? "thread_unfinished" : "thread_completed", value: fromUser ? "repair the radio" : "sell the radio", referent: "the radio", evidence: fromUser ? userText : assistantText }]));
    });
    const result = await projectSceneForReply({ ...input, previous: emptySceneState(), userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene.unresolvedThreads).toEqual(["repair the radio"]);
    expect(result.evidence.status).toBe("applied");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    { source: "user", existing: false }, { source: "assistant", existing: false },
    { source: "user", existing: true }, { source: "assistant", existing: true },
  ] as const)("rejects uncorroborated completion of a $source task introduced earlier in that source (existing=$existing)", async ({ source, existing }) => {
    const task = "repair the radio", pending = "We still need to repair the radio.";
    const text = `${pending} I replaced its broken wire. The radio works now; I finished repairing the radio.`;
    const previous = { ...emptySceneState(), version: 4, unresolvedThreads: [...(existing ? [task] : []), "return the book"] };
    const bodies: Array<{ messages: Array<{ content: string }> }> = [];
    // A deliberately incomplete extraction isolates orchestration from model quality.
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return response(body.response_format.json_schema.name === "scene_task_decisions"
        ? decisionJson(init, value => value === task ? "completed" : "pending")
        : projectionJson([{ field: "thread_unfinished", value: task, referent: "the radio", evidence: pending }]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText: source === "user" ? text : "", assistantText: source === "assistant" ? text : "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5, unresolvedThreads: previous.unresolvedThreads });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(bodies[1]!.messages[1]!.content)).toEqual({ text, known: previous.unresolvedThreads, candidates: [task] });
    expect(result.evidence.phases.map(phase => [phase.source, phase.kind, phase.status])).toEqual([[source, "extraction", "applied"], [source, "completion", "rejected"]]);
    expect(result.evidence.usage).toEqual({ promptTokens: 46, completionTokens: 16, reasoningTokens: 4 });
    expect(previous.unresolvedThreads).toEqual([...(existing ? [task] : []), "return the book"]);
  });

  it.each([
    "We still need to repair the radio. I sold the radio.",
    'We still need to repair the radio. The log says "I finished repairing the radio."',
    "I finished repairing the radio. No, I was mistaken; we still need to repair the radio.",
  ])("keeps an opened task when its own source check does not establish completion: %s", async userText => {
    const evidence = userText.startsWith("We") ? "We still need to repair the radio." : "we still need to repair the radio.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => response(fetch.mock.calls.length === 1
      ? projectionJson([{ field: "thread_unfinished", value: "repair the radio", referent: "the radio", evidence }])
      : decisionJson(init)));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene.unresolvedThreads).toEqual(["call the hotel", "repair the radio"]);
    expect(result.evidence.phases[1]).toMatchObject({ kind: "completion", status: "unchanged", changeCount: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the frozen anchor when an opened task's final status is uncertain", async () => {
    const userText = "Now we are at the beach. We still need to repair the radio. Perhaps I fixed it, or perhaps I did not.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => response(fetch.mock.calls.length === 1
      ? projectionJson([{ field: "location", value: "the beach", evidence: input.userText }, { field: "thread_unfinished", value: "repair the radio", referent: "the radio", evidence: "We still need to repair the radio." }])
      : decisionJson(init, task => task === "repair the radio" ? "uncertain" : "pending")));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_completion_not_supported" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { receipt: { known: [], candidates: [], bindings: [] }, finish: "stop", usage: true, code: "scene_completion_invalid" },
    { receipt: { known: ["completed", "completed"], candidates: ["completed"], bindings: [0] }, finish: "stop", usage: true, code: "scene_completion_invalid" },
    { receipt: { known: ["completed"], candidates: ["completed"], bindings: [0], verified: true }, finish: "stop", usage: true, code: "scene_completion_invalid" },
    { receipt: { known: ["completed"], candidates: ["completed"], bindings: [0] }, finish: "length", usage: true, code: "scene_projection_incomplete" },
    { receipt: { known: ["completed"], candidates: ["completed"], bindings: [0] }, finish: "stop", usage: false, code: "scene_projection_usage_missing" },
  ])("does not authorize an opened task's completion with an invalid receipt: $code", async ({ receipt, finish, usage, code }) => {
    const userText = "We still need to call the hotel. We called the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => fetch.mock.calls.length === 1
      ? response(projectionJson([{ field: "thread_unfinished", value: "call the hotel", referent: "the hotel", evidence: "We still need to call the hotel." }]))
      : response(JSON.stringify(receipt), finish, usage));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: code });
    expect(result.evidence.usage).toEqual(usage ? { promptTokens: 46, completionTokens: 16, reasoningTokens: 4 } : null);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { promptTokens: 23, completionTokens: 768, code: "scene_projection_budget_exceeded" },
    { promptTokens: 8_187, completionTokens: 8, code: "INPUT_BUDGET_EXCEEDED" },
  ])("does not refill an opened task's exhausted projection budget: $code", async ({ promptTokens, completionTokens, code }) => {
    const userText = "We still need to call the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(projectionJson([{ field: "thread_unfinished", value: "call the hotel", referent: "the hotel", evidence: userText }]), "stop", true, promptTokens, completionTokens));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence.failureCode).toBe(code);
    expect(result.evidence.phases[1]).toMatchObject({ kind: "completion", usage: null });
    expect(result.evidence.requests).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels an opened task's status check without applying facts or fabricating its usage", async () => {
    const controller = new AbortController(), started = Promise.withResolvers<void>();
    const userText = "We still need to call the hotel. We called the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      if (fetch.mock.calls.length === 1) return response(projectionJson([{ field: "thread_unfinished", value: "call the hotel", referent: "the hotel", evidence: "We still need to call the hotel." }]));
      started.resolve();
      return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    });
    const running = projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: controller.signal, fetch });
    await started.promise; controller.abort(new Error("run deadline"));
    const result = await running;
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "cancelled", usage: null });
    expect(result.evidence.phases[1]).toMatchObject({ kind: "completion", status: "cancelled", usage: null });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["past", "quoted", "future", "hypothetical"])("checks only prior tasks without applying a non-current opened task: %s", async scope => {
    const userText = 'The log says "We still need to repair the radio."';
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => pendingCompletion(init) ?? response(projectionJson([{ field: "thread_unfinished", value: "repair the radio", referent: "the radio", evidence: "We still need to repair the radio.", scope }])));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "unchanged", phases: [expect.objectContaining({ kind: "extraction", changeCount: 0 }), expect.objectContaining({ kind: "completion", changeCount: 0 })] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).messages[1].content).known).toEqual(["call the hotel"]);
  });

  it("keeps unambiguous user references authoritative while applying an unrelated assistant fact", async () => {
    const userText = "She stays with us. No, that task remains unfinished.";
    const assistantText = "Mina left. We called the hotel. It is dawn.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => JSON.parse(String(init?.body)).response_format.json_schema.name === "scene_task_decisions"
      ? response(decisionJson(init, JSON.parse(JSON.parse(String(init?.body)).messages[1].content).text === userText ? "hold" : "completed"))
      : response(JSON.parse(JSON.parse(String(init?.body)).messages[1].content).text === userText ? JSON.stringify({
      ...JSON.parse(projectionJson()),
      participant_present: [{ evidence: "She stays with us.", value: null, scope: "current" }],
      thread_unfinished: [{ evidence: "No, that task remains unfinished.", value: null, referent: null, scope: "current", authority: "hold" }],
    }) : projectionJson([
      { evidence: "Mina left.", field: "participant_absent", value: "Mina" },
      { evidence: "We called the hotel.", field: "thread_completed", value: "call the hotel", referent: "the hotel" },
      { evidence: "It is dawn.", field: "time", value: "dawn" },
    ])));
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, time: "dawn" });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 5 });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(result.evidence.phases[1]).toMatchObject({ source: "user", kind: "completion", status: "applied" });
  });

  it.each(["participant_present", "thread_unfinished"])("does not guess an unnamed %s among multiple anchors", async field => {
    const previous = { ...input.previous, participants: ["Mina", "Jun"], unresolvedThreads: ["call the hotel", "choose the train"] };
    const userText = field === "participant_present" ? "She stays with us." : "That task remains unfinished.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => pendingCompletion(init) ?? response(JSON.stringify({
      ...JSON.parse(projectionJson()),
      [field]: [{ evidence: userText, value: null, scope: "current", ...(field === "thread_unfinished" ? { referent: null, authority: "hold" } : {}) }],
    })));
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_reference_ambiguous" });
    expect(fetch).toHaveBeenCalledTimes(field === "participant_present" ? 2 : 1);
  });

  it.each([
    { field: "participant_present", introduced: "Nora arrived.", value: "Nora", reference: "She stays with us.", assistantText: "Mina left.", assistantFact: { evidence: "Mina left.", field: "participant_absent", value: "Mina" } },
    { field: "thread_unfinished", introduced: "We must repair the stove.", value: "repair the stove", referent: "the stove", reference: "That task remains unfinished.", assistantText: "We called the hotel.", assistantFact: { evidence: "We called the hotel.", field: "thread_completed", value: "call the hotel", referent: "the hotel" } },
  ])("rejects an unnamed $field when this source introduces a competing candidate", async ({ field, introduced, value, referent, reference, assistantText, assistantFact }) => {
    const userText = `${introduced} ${reference}`;
    // Hand-authored extraction facts expose binding behavior, not model accuracy.
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => pendingCompletion(init) ?? response(fetch.mock.calls.length === 1 ? JSON.stringify({
      ...JSON.parse(projectionJson()),
      [field]: [
        { evidence: reference, value: null, scope: "current", ...(referent ? { referent: null, authority: "hold" } : {}) },
        { evidence: introduced, value, scope: "current", ...(referent ? { referent, authority: "open" } : {}) },
      ],
    }) : projectionJson([assistantFact])));
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_reference_ambiguous" });
    expect(fetch).toHaveBeenCalledTimes(field === "participant_present" ? 2 : 1);
  });

  it.each([
    { introduced: "Mina stays with us.", value: "Mina", scope: "current" },
    { introduced: 'The log says "Nora arrived."', value: "Nora", scope: "current" },
    { introduced: "Nora may arrive tomorrow.", value: "Nora", scope: "future" },
  ])("retains the unique person when another fact repeats the anchor or is not current: $introduced", async ({ introduced, value, scope }) => {
    const reference = "She stays with us.", userText = `${introduced} ${reference}`;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => pendingCompletion(init) ?? response(JSON.stringify({
      ...JSON.parse(projectionJson()),
      participant_present: [
        { evidence: reference, value: null, scope: "current" },
        { evidence: introduced.includes('"') ? "Nora arrived." : introduced, value, scope },
      ],
    })));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence.status).toBe("unchanged");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves a task when an accepted normalized proposal has the same object but a different action", async () => {
    const previous = { ...input.previous, unresolvedThreads: ["pay the hotel"] }, userText = "We called the hotel.";
    // Hand-authored bad normalization, not a recorded provider output.
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => response(fetch.mock.calls.length === 1 ? projectionJson([{ field: "thread_completed", value: "pay the hotel", referent: "the hotel", evidence: userText }]) : decisionJson(init)));
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_completion_evidence_conflict" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    "We finished choosing the train.",
    "We finished selecting the train.",
    "I examined the train options and chose the train. That decision is made now.",
  ])("resolves only the verified prior task, including a paraphrase or indirect reference: %s", async userText => {
    const previous = { ...input.previous, unresolvedThreads: ["choose the train", "call the hotel"] };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => response(fetch.mock.calls.length === 1
      ? projectionJson([{ field: "thread_completed", value: "choose the train", referent: "the train", evidence: userText }])
      : decisionJson(init, task => task === "call the hotel" ? "pending" : "completed")));
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
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
      return response(body.response_format.json_schema.name === "scene_task_decisions"
        ? decisionJson(init, task => task === (payload.text === userText ? "choose the train" : "call the hotel") ? "completed" : "pending")
        : projectionJson([{ field: "thread_completed", value: payload.text === userText ? "choose the train" : "call the hotel", referent: payload.text === userText ? "the train" : "the hotel", evidence: payload.text }]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5, unresolvedThreads: [] });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(result.evidence.usage).toEqual({ promptTokens: 92, completionTokens: 32, reasoningTokens: 8 });
    expect(result.evidence.requests.map(request => request.phaseId)).toEqual(["user:extraction", "user:completion", "assistant:extraction", "assistant:completion"]);
    for (const [index, source] of [userText, assistantText].entries()) {
      expect(bodies[index * 2 + 1]).toMatchObject({ response_format: sceneCompletionResponseFormat(2, 1), max_tokens: 384, temperature: 0, top_p: 1 });
      expect(bodies[index * 2 + 1]!.messages).toEqual([
        { role: "system", content: SCENE_COMPLETION_PROMPT },
        { role: "user", content: JSON.stringify({ text: source, known: previous.unresolvedThreads, candidates: [index === 0 ? "choose the train" : "call the hotel"] }) },
      ]);
    }
    expect(result.evidence.completionPromptDigest).toBe(createHash("sha256").update(SCENE_COMPLETION_PROMPT).digest("hex"));
    expect(JSON.stringify(result.evidence)).not.toContain(userText);
    expect(JSON.stringify(result.evidence)).not.toContain(assistantText);
    expect(JSON.stringify(result.evidence)).not.toContain("secret");
  });

  it.each([
    { known: ["uncertain"], candidates: ["uncertain"], bindings: [0], code: "scene_completion_not_supported" },
    { known: [], candidates: [], bindings: [], code: "scene_completion_invalid" },
    { known: ["completed", "completed"], candidates: ["completed"], bindings: [0], code: "scene_completion_invalid" },
    { known: ["completed"], candidates: ["completed"], bindings: [0], verified: true, code: "scene_completion_invalid" },
  ])("preserves the entire anchor after unsupported or invalid task completion: %j", async ({ code, ...receipt }) => {
    const userText = "Now we are at the beach. We called the hotel, or perhaps not.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(fetch.mock.calls.length === 1 ? projectionJson([
      { field: "location", value: "the beach", evidence: input.userText },
      { field: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: "We called the hotel, or perhaps not." },
    ]) : JSON.stringify(receipt)));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: code, changeCount: 0, phases: [expect.objectContaining({ kind: "extraction", status: "applied" }), expect.objectContaining({ kind: "completion", status: "rejected" })] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { finish: "length", usage: true, code: "scene_projection_incomplete" },
    { finish: "stop", usage: false, code: "scene_projection_usage_missing" },
  ])("does not reuse extraction usage to hide a failed completion phase: $code", async ({ finish, usage, code }) => {
    const userText = "We called the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => fetch.mock.calls.length === 1
      ? response(projectionJson([{ field: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: userText }]))
      : response(decisionJson(init, "completed"), finish, usage));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: code });
    expect(result.evidence.usage).toEqual(usage ? { promptTokens: 46, completionTokens: 16, reasoningTokens: 4 } : null);
    expect(result.evidence.phases[1]).toMatchObject({ source: "user", kind: "completion", usage: usage ? expect.any(Object) : null });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not replenish the output budget for the deletion check", async () => {
    const userText = "We called the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => response(projectionJson([{ field: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: userText }]), "stop", true, 23, 768));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_projection_budget_exceeded", usage: { promptTokens: 23, completionTokens: 768 } });
    expect(result.evidence.phases[1]?.maxOutputTokens).toBe(0);
    expect(result.evidence.requests).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("spends the extraction's actual input before admitting a completion check", async () => {
    const userText = "We called the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(projectionJson([{ field: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: userText }]), "stop", true, 8_187));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "failed", usage: { promptTokens: 8_187, completionTokens: 8 } });
    expect(result.evidence.phases[1]).toMatchObject({ kind: "completion", maxInputTokens: 5, usage: null });
    expect(result.evidence.requests).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("clamps the completion check to the remaining actual output allowance", async () => {
    const userText = "We called the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => fetch.mock.calls.length === 1
      ? response(projectionJson([{ field: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: userText }]), "stop", true, 23, 760)
      : response(decisionJson(init, "completed")));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
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
    const running = projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    await started.promise;
    previous.location = "the station"; previous.unresolvedThreads.push("invented later task");
    finish.resolve(response(JSON.stringify({ known: ["completed"], candidates: ["completed"], bindings: [0] })));
    expect((await running).scene).toEqual({ ...input.previous, version: 5, unresolvedThreads: [] });
  });

  it("aborts the completion check without deletion, retry or fabricated usage", async () => {
    const userText = "We called the hotel.", controller = new AbortController(), started = Promise.withResolvers<void>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      if (fetch.mock.calls.length === 1) return response(projectionJson([{ field: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: userText }]));
      started.resolve(); return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    });
    const running = projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: controller.signal, fetch });
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
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => JSON.parse(String(init?.body)).response_format.json_schema.name === "scene_task_decisions" ? response(decisionJson(init)) : response(fetch.mock.calls.length === 1 ? projectionJson() : JSON.stringify({
      location: [], time: [], participant_present: [], emotionalBeat: [], thread_unfinished: [],
      participant_absent: [{ evidence: assistantText, value: "Lila", scope: "individual" }],
      thread_completed: [{ evidence: assistantText, value: "call the hotel", scope: "current" }],
    })));
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "degraded", failureCode: "scene_delta_invalid", changeCount: 0 });
    expect(result.evidence.usage).toEqual({ promptTokens: 69, completionTokens: 24, reasoningTokens: 6 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects an old task even with a valid scope when its referent is not in the source", async () => {
    const userText = "Lila left for home.";
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(JSON.stringify({
      location: [], time: [], participant_present: [], participant_absent: [], emotionalBeat: [], thread_unfinished: [],
      thread_completed: [{ evidence: userText, value: "call the hotel", referent: "the hotel", scope: "current" }],
    })));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_value_mismatch" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sends byte-identical source-only requests under counterfactual frozen anchors", async () => {
    const bodies: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => { const pending = pendingCompletion(init); if (pending) return pending; bodies.push(String(init?.body)); return response(); });
    const options = { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch };
    await projectSceneForReply({ ...input, assistantText: "" }, options);
    await projectSceneForReply({ ...input, previous: { ...emptySceneState(), version: 9, location: "温室", participants: ["阿岚"], unresolvedThreads: ["修好收音机"] }, assistantText: "" }, options);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(JSON.parse(bodies[0]!).messages[1].content)).toEqual({ source: "user", text: input.userText });
  });

  it("applies both source phases when valid negative user facts are absent from the frozen anchor", async () => {
    const previous = emptySceneState();
    const userText = "Jun left. We finished calling the venue. It is dawn.";
    const assistantText = "Jun joins us. We must call the venue. I feel calm.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), fromUser = JSON.parse(body.messages[1].content).text === userText;
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init, fromUser ? "completed" : "pending"));
      return response(projectionJson(fromUser ? [
      { field: "participant_absent", value: "Jun", evidence: "Jun left." },
      { field: "thread_completed", value: "call the venue", referent: "the venue", evidence: "We finished calling the venue." },
      { field: "time", value: "dawn", evidence: "It is dawn." },
    ] : [
      { field: "participant_present", value: "Jun", evidence: "Jun joins us." },
      { field: "thread_unfinished", value: "call the venue", referent: "the venue", evidence: "We must call the venue." },
      { field: "emotionalBeat", value: "calm", evidence: "I feel calm." },
    ]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, time: "dawn", emotionalBeat: "calm" });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 6, usage: { promptTokens: 92, completionTokens: 32, reasoningTokens: 8 } });
    expect(fetch).toHaveBeenCalledTimes(4);
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
      ]) : decisionJson(init, "completed"));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1, time: "dawn", unresolvedThreads: [] });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 3, usage: { promptTokens: 46, completionTokens: 16, reasoningTokens: 4 } });
    expect(JSON.parse(bodies[1]!.messages[1]!.content).known).toEqual(["repair the radio"]);
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
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
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
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => response(fetch.mock.calls.length === 1 ? JSON.stringify(fields) : decisionJson(init, value => value === task ? "completed" : "pending")));
    const result = await projectSceneForReply({ ...input, previous, userText: text, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5, unresolvedThreads: ["keep another commitment"] });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 1 });
  });

  it("retains only the explicitly referenced scalar and fences a conflicting assistant location", async () => {
    const userText = "We stay here.", assistantText = "We are in the greenhouse.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init));
      return response(JSON.stringify({
      ...JSON.parse(projectionJson()), location: [{ evidence: fetch.mock.calls.length === 1 ? userText : assistantText, value: fetch.mock.calls.length === 1 ? null : "the greenhouse", scope: "current" }],
    }));
    });
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "unchanged", changeCount: 2 });
  });

  it.each([
    { text: 'The log says "We stay here."', evidence: "We stay here.", scope: "current" },
    { text: 'The log says "We stay here."', evidence: "We stay here.", scope: "quoted" },
    { text: "Tomorrow we might stay here.", evidence: "Tomorrow we might stay here.", scope: "future" },
  ])("does not let a quoted or future retain claim fence the current assistant: $scope", async ({ text, evidence, scope }) => {
    const assistantText = "We are in the greenhouse.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init));
      return response(JSON.stringify({
      ...JSON.parse(projectionJson()), location: fetch.mock.calls.length === 1 ? [{ evidence, value: null, scope }] : [{ evidence: assistantText, value: "the greenhouse", scope: "current" }],
    }));
    });
    const result = await projectSceneForReply({ ...input, userText: text, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, location: "the greenhouse" });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 1 });
  });

  it("retains explicit named user presence against a current departure with an individual destination", async () => {
    const previous = { ...input.previous, participants: ["Lila"] };
    const userText = "Lila stays here with us.", assistantText = "Lila left for home.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init));
      return response(projectionJson(fetch.mock.calls.length === 1
      ? [{ evidence: userText, field: "participant_present", value: "Lila" }]
      : [{ evidence: assistantText, field: "participant_absent", value: "Lila" }, { evidence: assistantText, field: "location", value: "home", scope: "individual" }]));
    });
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "unchanged", changeCount: 2 });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("preserves unknown when retaining a scalar absent from the frozen anchor", async () => {
    const userText = "We stay here.";
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(JSON.stringify({
      ...JSON.parse(projectionJson()), location: [{ evidence: userText, value: null, scope: "current" }],
    })));
    const previous = emptySceneState();
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 1 });
    expect(result.evidence).toMatchObject({ status: "unchanged", changeCount: 1 });
  });

  it("accepts source-normalized presence and unfinished commitments without contradictory event labels", async () => {
    const userText = "Mina did not leave. No, we have not called the hotel.";
    const assistantText = "Mina left for the station. We finished calling the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => JSON.parse(String(init?.body)).response_format.json_schema.name === "scene_task_decisions"
      ? response(decisionJson(init, JSON.parse(JSON.parse(String(init?.body)).messages[1].content).text === userText ? "hold" : "completed"))
      : response(JSON.stringify(JSON.parse(JSON.parse(String(init?.body)).messages[1].content).text === userText ? {
      location: [], time: [], emotionalBeat: [],
      participant_present: [{ evidence: "Mina did not leave.", value: "Mina", scope: "current" }], participant_absent: [],
      thread_unfinished: [{ evidence: "No, we have not called the hotel.", value: "call the hotel", referent: "the hotel", scope: "current", authority: "hold" }], thread_completed: [],
    } : {
      location: [{ evidence: "Mina left for the station.", value: "the station", scope: "individual" }], time: [], emotionalBeat: [], participant_present: [],
      participant_absent: [{ evidence: "Mina left for the station.", value: "Mina", scope: "current" }], thread_unfinished: [],
      thread_completed: [{ evidence: "We finished calling the hotel.", value: "call the hotel", referent: "the hotel", scope: "current" }],
    })));
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "unchanged", changeCount: 4 });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(result.evidence.phases[1]).toMatchObject({ source: "user", kind: "completion", status: "applied" });
  });

  it("applies the seven field-specific current relationships from one source atomically", async () => {
    const userText = "We are in the greenhouse. It is dawn. Mina left. Ana is with us. I feel calm. We must repair the stove. We called the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => response(fetch.mock.calls.length === 1 ? JSON.stringify({
      location: [{ evidence: "We are in the greenhouse.", value: "the greenhouse", scope: "current" }],
      time: [{ evidence: "It is dawn.", value: "dawn", scope: "current" }],
      participant_present: [{ evidence: "Ana is with us.", value: "Ana", scope: "current" }],
      participant_absent: [{ evidence: "Mina left.", value: "Mina", scope: "current" }],
      emotionalBeat: [{ evidence: "I feel calm.", value: "calm", scope: "current" }],
      thread_unfinished: [{ evidence: "We must repair the stove.", value: "repair the stove", referent: "the stove", scope: "current", authority: "open" }],
      thread_completed: [{ evidence: "We called the hotel.", value: "call the hotel", referent: "the hotel", scope: "current" }],
    }) : decisionJson(init, task => task === "call the hotel" ? "completed" : "pending")));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, location: "the greenhouse", time: "dawn", participants: ["Ana"], emotionalBeat: "calm", unresolvedThreads: ["repair the stove"] });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 7 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("derives presence and unfinished-task authority from source-bound negative facts", async () => {
    const userText = "Mina did not leave. No, we have not called the hotel.";
    const assistantText = "Mina left for the station. We finished calling the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => JSON.parse(String(init?.body)).response_format.json_schema.name === "scene_task_decisions"
      ? response(decisionJson(init, JSON.parse(JSON.parse(String(init?.body)).messages[1].content).text === userText ? "hold" : "completed"))
      : response(projectionJson(JSON.parse(JSON.parse(String(init?.body)).messages[1].content).text === userText ? [
      { evidence: "Mina did not leave.", field: "participant_present", value: "Mina" },
      { evidence: "No, we have not called the hotel.", field: "thread_unfinished", value: "call the hotel", referent: "the hotel", authority: "hold" },
    ] : [
      { evidence: "Mina left for the station.", field: "participant_absent", value: "Mina" },
      { evidence: "Mina left for the station.", field: "location", value: "the station", scope: "individual" },
      { evidence: "We finished calling the hotel.", field: "thread_completed", value: "call the hotel", referent: "the hotel" },
    ])));
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence.status).toBe("unchanged"); expect(result.evidence.changeCount).toBe(4);
  });

  it("cannot turn quoted source evidence into a current fact even with an incorrect current classification", async () => {
    const quoted = "We are in the courtyard at dawn with Nina.";
    const userText = `The stage manager wrote "${quoted}"`, assistantText = "Now we are in the greenhouse.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init));
      return response(projectionJson(fetch.mock.calls.length === 1 ? [
      { evidence: quoted, field: "location", value: "the courtyard" },
      { evidence: quoted, field: "time", value: "at dawn" },
      { evidence: quoted, field: "participant_present", value: "Nina" },
    ] : [{ evidence: assistantText, field: "location", value: "the greenhouse" }]));
    });
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, location: "the greenhouse" });
    expect(result.evidence.status).toBe("applied"); expect(result.evidence.changeCount).toBe(1);
  });

  it("ignores an individual destination and past emotion without losing actual arrivals and departures", async () => {
    const userText = "Mina leaves for the station. Ravi arrived. Yesterday I felt worried.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => pendingCompletion(init) ?? response(projectionJson([
      { evidence: "Mina leaves for the station.", field: "location", value: "the station", scope: "individual" },
      { evidence: "Mina leaves for the station.", field: "participant_absent", value: "Mina" },
      { evidence: "Ravi arrived.", field: "participant_present", value: "Ravi" },
      { evidence: "Yesterday I felt worried.", field: "emotionalBeat", value: "worried", scope: "past" },
    ])));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, participants: ["Ravi"] }); expect(result.evidence.status).toBe("applied");
  });
  it("keeps the shared scalar when several non-current locations are described", async () => {
    const userText = "We are in the library. Mina is beside the door. Ravi is at the window. Yesterday we were in the loft.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => pendingCompletion(init) ?? response(projectionJson([
      { evidence: "We are in the library.", field: "location", value: "the library" },
      { evidence: "Mina is beside the door.", field: "location", value: "the door", scope: "individual" },
      { evidence: "Ravi is at the window.", field: "location", value: "the window", scope: "individual" },
      { evidence: "Yesterday we were in the loft.", field: "location", value: "the loft", scope: "past" },
    ])));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, location: "the library" });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 1 });
  });

  it("accepts a quoted name in an actual presence clause without accepting a quoted event", async () => {
    const userText = '“Nora” joins us. The log says "Mina left."';
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => pendingCompletion(init) ?? response(projectionJson([
      { evidence: '“Nora” joins us.', field: "participant_present", value: "Nora" },
      { evidence: "Mina left.", field: "participant_absent", value: "Mina" },
    ])));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, participants: ["Mina", "Nora"] });
    expect(result.evidence).toMatchObject({ status: "applied", changeCount: 1 });
  });

  it.each([
    { field: "participant_present", opposite: "participant_absent", value: "Mina", evidence: "Mina stayed. Mina left." },
    { field: "thread_unfinished", opposite: "thread_completed", value: "call the hotel", referent: "the hotel", evidence: "We still need to call the hotel. We called the hotel." },
  ])("rejects contradictory current relationships atomically: $field", async ({ field, opposite, value, evidence, ...binding }) => {
    const userText = `${input.userText} ${evidence}`;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => pendingCompletion(init) ?? response(projectionJson([
      { evidence: input.userText, field: "location", value: "the beach" },
      { evidence, field, value, ...binding }, { evidence, field: opposite, value, ...binding },
    ])));
    const result = await projectSceneForReply({ ...input, userText, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_fact_relation_mismatch", changeCount: 0 });
    expect(fetch).toHaveBeenCalledTimes(field === "participant_present" ? 2 : 1);
  });

  it("sends only exact current sources, records physical usage, and ignores reply-length caps", async () => {
    const physicalBodies: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const physicalBody = String(init?.body);
      physicalBodies.push(physicalBody);
      const body = JSON.parse(physicalBody);
      const payload = JSON.parse(body.messages[1].content);
      if (body.response_format.json_schema.name === "scene_task_decisions") return response(decisionJson(init));
      return response(projectionJson(payload.text === input.userText ? [{ evidence: "Now we are at the beach.", field: "location", value: "the beach" }] : []));
    });
    const result = await projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [index, physicalBody] of physicalBodies.filter((_, index) => index % 2 === 0).entries()) {
      const body = JSON.parse(physicalBody);
      expect(body.messages).toEqual([
        { role: "system", content: SCENE_PROJECTION_PROMPT },
        { role: "user", content: JSON.stringify({ source: index === 0 ? "user" : "assistant", text: index === 0 ? input.userText : input.assistantText }) },
      ]);
      expect(body).toMatchObject({ response_format: SCENE_RESPONSE_FORMAT, max_tokens: 384, temperature: 0, top_p: 1 });
      expect(body.tools).toBeUndefined();
      expect(result.evidence.requests[index * 2]?.bodyDigest).toBe(createHash("sha256").update(physicalBody).digest("hex"));
    }
    expect(result.scene).toEqual({ ...input.previous, version: 5, location: "the beach" });
    expect(result.evidence).toMatchObject({
      status: "applied", attemptId: input.attemptId, anchorVersion: 4,
      sourceMessageIds: { user: "user-1", assistant: "assistant-1" }, changeCount: 1,
      usage: { promptTokens: 69, completionTokens: 24, reasoningTokens: 6 },
      phases: [
        expect.objectContaining({ source: "user", requestId: "physical-request-1", actualProvider: "local", maxInputTokens: 8_192 }),
        expect.objectContaining({ source: "user", kind: "completion", requestId: "physical-request-1", actualProvider: "local" }),
        expect.objectContaining({ source: "assistant", kind: "extraction", requestId: "physical-request-1", actualProvider: "local" }),
      ],
    });
    expect(result.evidence.phases[1]!.maxInputTokens).toBe(8_192 - result.evidence.requests[0]!.estimatedInputTokens);
    expect(result.evidence.phases.filter(phase => phase.kind === "extraction").reduce((total, phase) => total + phase.maxOutputTokens, 0)).toBe(768);
    expect(JSON.parse(physicalBodies[1]!)).toMatchObject({ response_format: sceneCompletionResponseFormat(1, 0), max_tokens: 384, temperature: 0, top_p: 1 });
    expect(JSON.parse(JSON.parse(physicalBodies[1]!).messages[1].content)).toEqual({ text: input.userText, known: ["call the hotel"], candidates: [] });
    expect(result.evidence.requests[1]?.bodyDigest).toBe(createHash("sha256").update(physicalBodies[1]!).digest("hex"));
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
    const previous = { ...input.previous, unresolvedThreads: [] };
    const userText = "Sam arrives.", assistantText = "Nora arrives.";
    const userChange = { evidence: userText, field: "participant_present", value: "Sam" };
    const assistantChange = { evidence: assistantText, field: "participant_present", value: "Nora" };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => pendingCompletion(init) ?? response(projectionJson(JSON.parse(JSON.parse(String(init?.body)).messages[1].content).text === userText ? Array(9).fill(userChange) : Array(8).fill(assistantChange))));
    const result = await projectSceneForReply({ ...input, previous, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5, participants: ["Mina", "Sam"] });
    expect(result.evidence).toMatchObject({ status: "degraded", failureCode: "scene_delta_invalid", acceptedPhaseIds: ["user:extraction", "user:completion"], usage: { promptTokens: 92, completionTokens: 32 } });
    expect(fetch).toHaveBeenCalledTimes(4);
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

  it("retains the user checkpoint if the assistant phase fails and exposes unknown total usage", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => JSON.parse(String(init?.body)).response_format.json_schema.name === "scene_task_decisions" ? response(decisionJson(init)) : fetch.mock.calls.length === 1
      ? response(projectionJson([{ evidence: "Now we are at the beach.", field: "location", value: "the beach" }]))
      : response(projectionJson(), "stop", false));
    const result = await projectSceneForReply(input, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5, location: "the beach" });
    expect(result.evidence).toMatchObject({
      status: "degraded", failureCode: "scene_projection_usage_missing", usage: null,
      phases: [
        { source: "user", status: "applied", usage: { promptTokens: 23, completionTokens: 8 } },
        { source: "user", status: "unchanged", usage: { promptTokens: 23, completionTokens: 8 } },
        { source: "assistant", status: "rejected", usage: null },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("enforces a lower per-request input cap before sending a larger second source", async () => {
    const previous = { ...input.previous, unresolvedThreads: [] };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const first = await projectSceneForReply({ ...input, previous, assistantText: "" }, { profile, apiKey: "secret", maxInputTokens: 4_000, signal: new AbortController().signal, fetch });
    const requestCap = first.evidence.requests[0]!.estimatedInputTokens + 1;
    fetch.mockClear();
    const result = await projectSceneForReply({ ...input, previous, assistantText: "x".repeat(4000) }, { profile, apiKey: "secret", maxInputTokens: requestCap, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...previous, version: 5 });
    expect(result.evidence.phases[1]).toMatchObject({ id: "assistant:extraction", maxInputTokens: requestCap, failureCode: "INPUT_BUDGET_EXCEEDED" });
    expect(result.evidence.requests).toHaveLength(1);
    expect(result.evidence.usage).toEqual({ promptTokens: 23, completionTokens: 8, reasoningTokens: 2 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("accounts for actual input above the estimate before budgeting the second source", async () => {
    const previous = { ...input.previous, unresolvedThreads: [] };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(undefined, "stop", true, 8_187));
    const result = await projectSceneForReply({ ...input, previous }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.evidence.phases[1]).toMatchObject({ id: "assistant:extraction", maxInputTokens: 5, failureCode: "INPUT_BUDGET_EXCEEDED" });
    expect(result.evidence.usage?.promptTokens).toBe(8_187);
    expect(result.evidence.requests).toHaveLength(1);
    expect(result.scene).toEqual({ ...previous, version: 5 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("skips empty sources and gives a sole source the shared output cap", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => response(JSON.parse(String(init?.body)).response_format.json_schema.name === "scene_task_decisions" ? decisionJson(init) : projectionJson()));
    const options = { profile, apiKey: "secret", maxInputTokens: 4_000, signal: new AbortController().signal, fetch };
    const single = await projectSceneForReply({ ...input, userText: " \n" }, options);
    expect(single.evidence.requests).toHaveLength(1);
    expect(single.evidence.phases).toEqual([expect.objectContaining({ source: "assistant", kind: "extraction", maxOutputTokens: 768 })]);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).max_tokens).toBe(768);
    fetch.mockClear();
    const empty = await projectSceneForReply({ ...input, userText: "", assistantText: " " }, options);
    expect(empty.scene).toEqual({ ...input.previous, version: 5 });
    expect(empty.evidence).toMatchObject({ status: "unchanged", requests: [], phases: [], usage: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("protects an explicit user correction from a conflicting assistant completion", async () => {
    const userText = "No, we have not called the hotel. That task remains unfinished.";
    const assistantText = "We finished calling the hotel.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => JSON.parse(String(init?.body)).response_format.json_schema.name === "scene_task_decisions"
      ? response(decisionJson(init, JSON.parse(JSON.parse(String(init?.body)).messages[1].content).text === userText ? "hold" : "completed"))
      : response(projectionJson(JSON.parse(JSON.parse(String(init?.body)).messages[1].content).text === userText
      ? [{ evidence: userText, field: "thread_unfinished", value: "call the hotel", referent: "the hotel", authority: "hold" }]
      : [{ evidence: assistantText, field: "thread_completed", value: "call the hotel", referent: "the hotel" }])));
    const result = await projectSceneForReply({ ...input, userText, assistantText }, { profile, apiKey: "secret", maxInputTokens: 8_192, signal: new AbortController().signal, fetch });
    expect(result.scene).toEqual({ ...input.previous, version: 5 });
    expect(result.evidence).toMatchObject({ status: "unchanged", changeCount: 2, requests: [expect.any(Object), expect.objectContaining({ source: "user", phaseId: "user:completion" }), expect.any(Object), expect.objectContaining({ source: "assistant", phaseId: "assistant:completion" })] });
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
