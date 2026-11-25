import { describe, expect, it } from "vitest";
import { emptySceneState } from "./scene.js";
import { applyLightweightSceneDelta, projectLightweightScene } from "./scene-light.js";
import { InferencePriorityGate } from "./agent-runtime/execution-scheduler.js";

const PROFILE = {
  tier: "free",
  adapter: "openai-compatible-v1",
  provider: "openai",
  baseUrl: "http://127.0.0.1:8061/v1",
  model: "test-model",
  supportsTools: true,
  maxOutputTokens: 512,
  timeout: { firstTokenMs: 5_000, idleMs: 5_000 },
  sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
} as const;

function sseJson(payload: unknown): Response {
  return new Response(`data: ${JSON.stringify({
    id: "scene-req-1",
    choices: [{ delta: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 20 },
  })}\n\ndata: [DONE]\n\n`);
}

describe("lightweight asynchronous Scene projector", () => {
  it("applies incremental updates while preserving unchanged slots and deduplicating lists", () => {
    const previous = {
      ...emptySceneState(),
      version: 2,
      location: "the conservatory",
      time: "midnight",
      participants: ["Mara", "Robin"],
      emotionalBeat: "warm",
      unresolvedThreads: ["brew chamomile tea"],
    };
    const { scene, applied } = applyLightweightSceneDelta(previous, {
      location: "the balcony",
      time: null,
      emotionalBeat: null,
      participantsAdd: ["Briar", "mara"],
      participantsRemove: ["Robin"],
      threadsAdd: ["watch the meteor shower"],
      threadsResolve: ["brew chamomile tea"],
    });
    expect(applied).toBe(true);
    expect(scene).toEqual({
      schemaVersion: 1,
      version: 3,
      location: "the balcony",
      time: "midnight",
      participants: ["Mara", "Briar"],
      emotionalBeat: "warm",
      unresolvedThreads: ["watch the meteor shower"],
    });

    const capped = applyLightweightSceneDelta({
      ...scene,
      participants: ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"],
      unresolvedThreads: ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"],
    }, {
      location: null,
      time: null,
      emotionalBeat: null,
      participantsAdd: ["NewArrival"],
      participantsRemove: [],
      threadsAdd: ["NewThread"],
      threadsResolve: [],
    });
    expect(capped.scene.participants).toHaveLength(8);
    expect(capped.scene.participants.at(-1)).toBe("NewArrival");
    expect(capped.scene.unresolvedThreads).toHaveLength(8);
    expect(capped.scene.unresolvedThreads.at(-1)).toBe("NewThread");
  });

  it("runs a single JSON-schema request and fails soft on malformed output", async () => {
    const previous = emptySceneState();
    const okResult = await projectLightweightScene({
      previous,
      userText: "Let's head up to the rooftop before the rain starts.",
      assistantText: "I grab my wool coat and lead you up the stairs to the rooftop.",
      characterName: "Mara",
      profile: PROFILE,
      apiKey: "test-key",
      fetch: async () => sseJson({
        location: "the rooftop",
        time: null,
        emotionalBeat: "anticipatory",
        participantsAdd: ["Mara"],
        participantsRemove: [],
        threadsAdd: [],
        threadsResolve: [],
      }),
    });
    expect(okResult.degraded).toBe(false);
    expect(okResult.applied).toBe(true);
    expect(okResult.scene.version).toBe(1);
    expect(okResult.scene.location).toBe("the rooftop");

    const badResult = await projectLightweightScene({
      previous: okResult.scene,
      userText: "Hello",
      assistantText: "Hi there",
      characterName: "Mara",
      profile: PROFILE,
      apiKey: "test-key",
      fetch: async () => new Response(`data: ${JSON.stringify({
        choices: [{ delta: { content: "not valid json" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`),
    });
    expect(badResult.degraded).toBe(true);
    expect(badResult.applied).toBe(false);
    expect(badResult.scene.version).toBe(2);
    expect(badResult.scene.location).toBe("the rooftop");
  });

  it("yields to foreground turns via InferencePriorityGate", async () => {
    const gate = new InferencePriorityGate();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const fg = gate.withForeground(async () => {
      order.push("fg");
      await release.promise;
    });
    const bg = projectLightweightScene({
      previous: emptySceneState(),
      userText: "We arrived at the pier.",
      assistantText: "The sea breeze feels crisp here.",
      characterName: "Mara",
      profile: PROFILE,
      apiKey: "test-key",
      priorityGate: gate,
      fetch: async () => {
        order.push("scene-fetch");
        return sseJson({
          location: "the pier",
          time: null,
          emotionalBeat: null,
          participantsAdd: [],
          participantsRemove: [],
          threadsAdd: [],
          threadsResolve: [],
        });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(order).toEqual(["fg"]);
    release.resolve();
    const result = await bg;
    await fg;
    expect(order).toEqual(["fg", "scene-fetch"]);
    expect(result.scene.location).toBe("the pier");
  });
});
