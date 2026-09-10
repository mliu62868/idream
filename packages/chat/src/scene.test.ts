import { describe, expect, it } from "vitest";
import {
  applySceneDelta,
  deriveSceneDelta,
  emptySceneState,
  parseSceneState,
  sceneForReply,
} from "./scene.js";

describe("typed Scene State", () => {
  it("accepts only the canonical cross-service Scene without dropping unknown fields", () => {
    const scene = emptySceneState();
    expect(parseSceneState(scene)).toEqual(scene);
    for (const malformed of [null, { ...scene, location: 42 }, { ...scene, version: 1.5 }, { ...scene, source: "invented" }]) {
      expect(parseSceneState(malformed)).toBeNull();
    }
  });

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

  it("advances once from the frozen pre-turn Scene anchor", () => {
    const prior = {
      schemaVersion: 1 as const,
      version: 4,
      location: "the rooftop garden",
      time: "tonight",
      participants: ["Mina"],
      emotionalBeat: "calm",
      unresolvedThreads: ["choose the train"],
    };

    expect(sceneForReply({
      previous: prior,
      userText: "We are at the station.",
      assistantText: "I wait beside you.",
    })).toMatchObject({
      version: 5,
      location: "the station",
      unresolvedThreads: ["choose the train"],
    });
  });

  it("does not turn an everyday mention of day into a scene time change", () => {
    expect(deriveSceneDelta({ userText: "I had a difficult day. Keep our nighttime scene.", assistantText: "I sit beside you." }).time).toBeNull();
  });

  it("does not promote proposals or conflicting assistant relations to authoritative Scene fields", () => {
    for (const input of [
      { userText: "Would the book look better left of the cup tomorrow?", assistantText: "Maybe." },
      { userText: "The book is left of the cup.", assistantText: "The book is right of the cup." },
    ]) {
      expect(deriveSceneDelta(input)).not.toHaveProperty("objectRelations");
    }
  });

  it.each([
    "I am falling in love with you.",
    "I'm interested in astronomy.",
    "I feel at ease with you.",
    "We are in trouble with the landlord.",
  ])("does not turn an abstract preposition into a location: %s", (userText) => {
    expect(deriveSceneDelta({ userText, assistantText: "" }).location).toBeNull();
  });

  it.each([
    "我在想你。",
    "你在骗我。",
    "我在看你。",
  ])("does not turn a Chinese predicate into a location: %s", (userText) => {
    expect(deriveSceneDelta({ userText, assistantText: "" }).location).toBeNull();
  });

  it.each([
    ["我在厨房", "厨房"],
    ["我在厨房想你。", "厨房"],
    ["我们到了海边", "海边"],
    ["I am in Paris", "Paris"],
    ["I'm at the station waiting for you.", "the station"],
  ])("extracts a concrete location without requiring punctuation: %s", (userText, location) => {
    expect(deriveSceneDelta({ userText, assistantText: "" }).location).toBe(location);
  });
});
