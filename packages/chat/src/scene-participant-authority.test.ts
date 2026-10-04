import { describe, expect, it, vi } from "vitest";
import type { PreparedTurnProfile } from "./agent-runtime/contracts.js";
import { emptySceneState, projectSceneForReply } from "./scene.js";

const profile: PreparedTurnProfile = {
  tier: "test", adapter: "openai-compatible-v1", provider: "openai", model: "scene-model",
  baseUrl: "https://provider.example/v1", supportsTools: true,
  maxOutputTokens: 1024, answerMaxOutputTokens: 64,
  timeout: { firstTokenMs: 1000, idleMs: 1000 }, sampling: { temperature: 0, topP: 1, repetitionPenalty: 1 },
};
const emptyFacts = () => ({ location: [], time: [], participant_present: [], participant_absent: [], emotionalBeat: [], thread_unfinished: [], thread_completed: [] });
const fact = (evidence: string, value: string | null) => ({ evidence, value, scope: "current" });
function sse(value: unknown) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
}
type Decision = { relation: "present" | "absent" | "actor" | "reference" | "unsupported" | "uncertain"; name: string | null };

function transport(facts: ReturnType<typeof emptyFacts> | Record<string, unknown>, decisions: Decision[]) {
  return vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.response_format.json_schema.name === "scene_changes") return sse(facts);
    const payload = JSON.parse(body.messages[1].content);
    return sse({ known: payload.known.map(() => "pending"), candidates: [], bindings: [], participants: { anchor: payload.participants.anchor, decisions } });
  });
}
async function project(text: string, facts: Record<string, unknown>, decisions: Decision[], participants: string[] = ["Lila"]) {
  const fetch = transport(facts, decisions);
  const previous = { ...emptySceneState(), version: 4, time: "midnight", participants };
  const result = await projectSceneForReply({ previous, userText: text, assistantText: "", attemptId: "participant:1", userMessageId: "user", assistantMessageId: "assistant" }, {
    profile, apiKey: "test-secret", maxInputTokens: 6000, signal: new AbortController().signal, fetch,
  });
  return { ...result, fetch };
}

describe("source-bound participant authority", () => {
  it("excludes a conversational actor even when the extractor proposes a source-bound name", async () => {
    const text = "I sit beside you. It is dawn.";
    const result = await project(text, { ...emptyFacts(), participant_present: [fact("I sit beside you.", "you")], time: [fact("It is dawn.", "dawn")] }, [{ relation: "actor", name: null }]);
    expect(result.scene).toMatchObject({ version: 5, time: "dawn", participants: ["Lila"] });
    expect(result.evidence.status).toBe("applied");
    expect(result.fetch).toHaveBeenCalledTimes(2);
  });

  it("verifies named arrivals and departures from the source rather than old membership", async () => {
    const text = "Ana has joined us. Jun has gone home.";
    const result = await project(text, { ...emptyFacts(), participant_present: [fact("Ana has joined us.", "Ana")], participant_absent: [fact("Jun has gone home.", "Jun")] }, [{ relation: "present", name: "Ana" }, { relation: "absent", name: "Jun" }], ["Jun", "Mina"]);
    expect(result.scene.participants).toEqual(["Mina", "Ana"]);
    const body = JSON.parse(String(result.fetch.mock.calls[1]![1]?.body));
    const payload = JSON.parse(body.messages[1].content);
    expect(payload.source).toBe("user");
    expect(payload.text).toBe(text);
    expect(payload.participants).not.toHaveProperty("previousNames");
  });

  it("does not turn an unsupported named claim into a retained historical person", async () => {
    const text = "Lila left for home. It is dawn.";
    const result = await project(text, { ...emptyFacts(), participant_absent: [fact("Lila left for home.", "Lila")], time: [fact("It is dawn.", "dawn")] }, [{ relation: "reference", name: null }]);
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_participant_not_supported" });
    expect(result.scene).toMatchObject({ time: "midnight", participants: ["Lila"] });
  });

  it("binds unnamed third-person continuity after ignoring conversational actors", async () => {
    const text = "She is still here. I sit beside you. It is dawn.";
    const result = await project(text, { ...emptyFacts(), participant_present: [fact("She is still here.", null), fact("I sit beside you.", "you")], time: [fact("It is dawn.", "dawn")] }, [{ relation: "reference", name: null }, { relation: "actor", name: null }]);
    expect(result.scene).toMatchObject({ time: "dawn", participants: ["Lila"] });
    expect(result.evidence.status).toBe("applied");
  });

  it("rejects unnamed continuity when another verified name competes", async () => {
    const text = "Ana arrives. She is still here.";
    const result = await project(text, { ...emptyFacts(), participant_present: [fact("Ana arrives.", "Ana"), fact("She is still here.", null)] }, [{ relation: "present", name: "Ana" }, { relation: "reference", name: null }]);
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_reference_ambiguous" });
    expect(result.scene.participants).toEqual(["Lila"]);
  });

  it("checks raw contradictory actor claims after identity verification", async () => {
    const text = "I sit beside you. It is dawn.";
    const result = await project(text, { ...emptyFacts(), participant_present: [fact("I sit beside you.", "you")], participant_absent: [fact("I sit beside you.", "you")], time: [fact("It is dawn.", "dawn")] }, [{ relation: "actor", name: null }, { relation: "actor", name: null }]);
    expect(result.scene).toMatchObject({ time: "dawn", participants: ["Lila"] });
    expect(result.evidence.status).toBe("applied");
  });

  it("retains the verified user checkpoint when the assistant identity check fails", async () => {
    const userText = "Lila stays here. It is dawn.", assistantText = "Lila left. It is noon.";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content);
      const user = payload.source === "user";
      if (body.response_format.json_schema.name === "scene_changes") return sse({ ...emptyFacts(),
        time: [fact(user ? "It is dawn." : "It is noon.", user ? "dawn" : "noon")],
        ...(user ? { participant_present: [fact("Lila stays here.", "Lila")] } : { participant_absent: [fact("Lila left.", "Lila")] }),
      });
      return sse({ known: [], candidates: [], bindings: [], participants: { anchor: payload.participants.anchor, decisions: [user ? { relation: "present", name: "Lila" } : { relation: "unsupported", name: null }] } });
    });
    const result = await projectSceneForReply({ previous: { ...emptySceneState(), time: "midnight", participants: ["Lila"] }, userText, assistantText, attemptId: "checkpoint:1", userMessageId: "user", assistantMessageId: "assistant" }, { profile, apiKey: "test-secret", maxInputTokens: 6000, signal: new AbortController().signal, fetch });
    expect(result.scene).toMatchObject({ version: 1, time: "dawn", participants: ["Lila"] });
    expect(result.evidence).toMatchObject({ status: "degraded", failureCode: "scene_participant_not_supported", acceptedPhaseIds: ["user:extraction", "user:completion"], usage: { promptTokens: 160, completionTokens: 80 } });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not use a pronoun blacklist for actual named people", async () => {
    const text = 'A visitor named "You" arrives.';
    const result = await project(text, { ...emptyFacts(), participant_present: [fact(text, "You")] }, [{ relation: "present", name: "You" }]);
    expect(result.scene.participants).toEqual(["Lila", "You"]);
  });

  it("checks relation as well as full name and rejects a changed or truncated identity", async () => {
    const text = "Ann Lee left. It is dawn.";
    for (const decision of [{ relation: "present", name: "Ann Lee" }, { relation: "absent", name: "Ann" }] as const) {
      const result = await project(text, { ...emptyFacts(), participant_absent: [fact("Ann Lee left.", "Ann Lee")], time: [fact("It is dawn.", "dawn")] }, [decision], ["Ann Lee"]);
      expect(result.evidence.status).toBe("rejected");
      expect(result.scene).toMatchObject({ time: "midnight", participants: ["Ann Lee"] });
    }
  });

  it("rejects a receipt for a different source before applying its facts", async () => {
    const text = "Ana arrives. It is dawn.";
    const fetch = transport({ ...emptyFacts(), participant_present: [fact("Ana arrives.", "Ana")], time: [fact("It is dawn.", "dawn")] }, [{ relation: "present", name: "Ana" }]);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      const body = JSON.parse(String(init?.body));
      if (body.response_format.json_schema.name === "scene_changes") return response;
      return sse({ known: [], candidates: [], bindings: [], participants: { anchor: "0000000000000000", decisions: [{ relation: "present", name: "Ana" }] } });
    });
    const result = await projectSceneForReply({ previous: emptySceneState(), userText: text, assistantText: "", attemptId: "receipt:1", userMessageId: "user", assistantMessageId: "assistant" }, { profile, apiKey: "test-secret", maxInputTokens: 6000, signal: new AbortController().signal, fetch });
    expect(result.evidence).toMatchObject({ status: "rejected", failureCode: "scene_participant_receipt_mismatch" });
    expect(result.scene.participants).toEqual([]);
    expect(result.scene.time).toBeNull();
  });
});
