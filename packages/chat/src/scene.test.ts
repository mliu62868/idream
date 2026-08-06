import { describe, expect, it } from "vitest";
import {
  applySceneDelta,
  deriveSceneDelta,
  emptySceneState,
} from "./scene.js";

describe("typed Scene State", () => {
  it("derives and applies session-local continuity without creating user memory", () => {
    const delta = deriveSceneDelta({
      userText: "Tonight we're in the rooftop garden with Mina. I feel nervous, and we still need to choose the train.",
      assistantText: "I stay beside you while we look over the city.",
    });
    const state = applySceneDelta(emptySceneState(), delta);

    expect(state).toEqual({
      schemaVersion: 1,
      version: 1,
      location: "the rooftop garden",
      time: "tonight",
      participants: ["Mina"],
      emotionalBeat: "nervous",
      unresolvedThreads: ["choose the train"],
    });
  });

  it("preserves prior fields when a turn does not replace them and closes resolved threads", () => {
    const prior = {
      schemaVersion: 1 as const,
      version: 4,
      location: "the rooftop garden",
      time: "tonight",
      participants: ["Mina"],
      emotionalBeat: "nervous",
      unresolvedThreads: ["choose the train", "call the hotel"],
    };
    const next = applySceneDelta(prior, {
      location: null,
      time: null,
      participants: [],
      emotionalBeat: "relieved",
      addUnresolvedThreads: [],
      resolveUnresolvedThreads: ["choose the train"],
    });

    expect(next.version).toBe(5);
    expect(next.location).toBe("the rooftop garden");
    expect(next.emotionalBeat).toBe("relieved");
    expect(next.unresolvedThreads).toEqual(["call the hotel"]);
  });
});
