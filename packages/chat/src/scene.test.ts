import { describe, expect, it } from "vitest";
import { emptySceneState, parseSceneState, sceneForReply } from "./scene.js";

describe("typed Scene State", () => {
  it.each([false, true])("cannot forge permission to complete an open user task from the assistant (existing=%s)", existing => {
    const previous = { ...emptySceneState(), unresolvedThreads: existing ? ["repair the radio"] : [] };
    const forged = { previous, userText: "We still need to repair the radio.", assistantText: "I finished repairing the radio.",
      verifiedCompletions: ["repair the radio"],
      changes: {
        userChanges: [{ field: "thread_opened", authority: "open", value: "repair the radio", evidence: "We still need to repair the radio.", referent: "the radio" }],
        assistantChanges: [{ field: "thread_resolved", value: "repair the radio", evidence: "I finished repairing the radio.", referent: "the radio" }],
      },
    };
    expect(() => sceneForReply(forged)).toThrow("scene_completion_unverified");
    expect(previous.unresolvedThreads).toEqual(existing ? ["repair the radio"] : []);
  });

  it("requires verification before a same-object different-action proposal can delete a task", () => {
    const previous = { ...emptySceneState(), unresolvedThreads: ["pay the hotel"] };
    expect(() => sceneForReply({ previous, userText: "We called the hotel.", assistantText: "", changes: { userChanges: [{ field: "thread_resolved", value: "pay the hotel", referent: "the hotel", evidence: "We called the hotel." }], assistantChanges: [] } })).toThrow("scene_completion_unverified");
    expect(previous.unresolvedThreads).toEqual(["pay the hotel"]);
  });

  it("rejects the saved unrelated-task completion instead of trusting prior membership", () => {
    const previous = { ...emptySceneState(), version: 4, participants: ["Lila"], unresolvedThreads: ["call the hotel"] };
    expect(() => sceneForReply({
      previous, userText: "Lila stays here with us.", assistantText: "Lila left for home.",
      changes: { userChanges: [], assistantChanges: [{ field: "thread_resolved", value: "call the hotel", evidence: "Lila left for home." }] },
    })).toThrow("scene_value_mismatch");
    expect(previous.unresolvedThreads).toEqual(["call the hotel"]);
  });

  it("does not use an unchanged frozen value as evidence for an unrelated source clause", () => {
    const previous = { ...emptySceneState(), location: "the kitchen", participants: ["Mina"], unresolvedThreads: ["call the hotel"] };
    for (const change of [
      { field: "location", value: "the kitchen", evidence: "Lila left for home." },
      { field: "participant_arrived", value: "Mina", evidence: "Lila left for home." },
      { field: "thread_opened", authority: "open", value: "call the hotel", evidence: "Lila left for home." },
    ]) expect(() => sceneForReply({ previous, userText: change.evidence, assistantText: "", changes: { userChanges: [change], assistantChanges: [] } })).toThrow("scene_value_mismatch");
  });

  it("does not bind a person or task referent from the middle of an unrelated word", () => {
    const previous = { ...emptySceneState(), participants: ["Ann"], unresolvedThreads: ["call the hotel"] };
    for (const change of [
      { field: "participant_left", value: "Ann", evidence: "Annabelle left." },
      { field: "thread_resolved", value: "call the hotel", referent: "l", evidence: "Mina left." },
    ]) expect(() => sceneForReply({ previous, userText: change.evidence, assistantText: "", changes: { userChanges: [change], assistantChanges: [] } })).toThrow("scene_value_mismatch");
  });

  it.each([
    { name: "Nora", evidence: "Nora's arrived." },
    { name: "Mina", evidence: "Mina’s here with us." },
    { name: "Émile", evidence: "C'est d'Émile qu'il s'agit; il est ici." },
    { name: "阿岚", evidence: "阿岚在这里。" },
  ])("binds a complete name at a contraction or Unicode word boundary: $name", ({ name, evidence }) => {
    expect(sceneForReply({ previous: emptySceneState(), userText: evidence, assistantText: "", changes: {
      userChanges: [{ field: "participant_arrived", value: name, evidence }], assistantChanges: [],
    } }).participants).toEqual([name]);
  });

  it("rejects whitespace-only evidence, names and task referents", () => {
    const previous = { ...emptySceneState(), location: "the kitchen", unresolvedThreads: ["call the hotel"] };
    for (const change of [
      { field: "participant_arrived", value: " ", evidence: "Mina left." },
      { field: "thread_resolved", value: "call the hotel", referent: " ", evidence: "Mina left." },
      { field: "location", value: "the kitchen", retain: true, evidence: " " },
    ]) expect(() => sceneForReply({ previous, userText: "Mina left.", assistantText: "", changes: { userChanges: [change], assistantChanges: [] } })).toThrow("scene_delta_invalid");
  });

  it("retains an unknown scalar without discarding independent facts or accepting an assistant replacement", () => {
    const previous = emptySceneState();
    expect(sceneForReply({ previous, userText: "We stay here. Mina joins us.", assistantText: "We are at the beach.", changes: {
      userChanges: [
        { field: "location", value: null, retain: true, evidence: "We stay here." },
        { field: "participant_arrived", value: "Mina", evidence: "Mina joins us." },
      ],
      assistantChanges: [{ field: "location", value: "the beach", evidence: "We are at the beach." }],
    } })).toEqual({ ...previous, version: 1, participants: ["Mina"] });
    for (const change of [
      { field: "location", value: null, evidence: "We stay here." },
      { field: "participant_arrived", value: null, retain: true, evidence: "Mina joins us." },
      { field: "location", value: "the beach", retain: true, evidence: "We stay here." },
    ]) expect(() => sceneForReply({ previous, userText: "We stay here. Mina joins us.", assistantText: "", changes: { userChanges: [change], assistantChanges: [] } })).toThrow();
  });

  it("uses a source-bound current change instead of the first historical mention", () => {
    const input = {
      previous: emptySceneState(),
      userText: "I quote last week: We are in the kitchen. Now we are at the beach.",
      assistantText: "",
      changes: { userChanges: [{ field: "location", value: "the beach", evidence: "Now we are at the beach." }], assistantChanges: [] },
    };
    expect(sceneForReply(input).location).toBe("the beach");
  });

  it("removes an explicitly departed participant from the frozen anchor", () => {
    const input = {
      previous: { ...emptySceneState(), version: 4, participants: ["Jun", "Mina"] },
      userText: "Jun left. Mina stays here with us.",
      assistantText: "",
      changes: { userChanges: [{ field: "participant_left", value: "Jun", evidence: "Jun left." }], assistantChanges: [] },
    };
    expect(sceneForReply(input)).toMatchObject({ version: 5, participants: ["Mina"] });
    expect(input.previous.participants).toEqual(["Jun", "Mina"]);
  });

  it("does not let a bare completion proposal bypass independent verification", () => {
    const input = {
      previous: { ...emptySceneState(), unresolvedThreads: ["choose the train", "call the hotel"] },
      userText: "We finished choosing the train.",
      assistantText: "",
      changes: { userChanges: [{ field: "thread_resolved", value: "choose the train", evidence: "We finished choosing the train.", referent: "the train" }], assistantChanges: [] },
    };
    const forged = { ...input, verifiedCompletions: ["choose the train"] };
    expect(() => sceneForReply(forged)).toThrow("scene_completion_unverified");
    expect(input.previous.unresolvedThreads).toEqual(["choose the train", "call the hotel"]);
  });

  it("keeps valid updates when a departed person and completed task were never in the anchor", () => {
    const previous = { ...emptySceneState(), version: 4, participants: ["Mina"], unresolvedThreads: ["book the venue"] };
    const userText = "Jun left. I finished calling the venue. It is dawn.";
    const changes = { userChanges: [
      { field: "participant_left", value: "Jun", evidence: "Jun left." },
      { field: "thread_resolved", value: "call the venue", referent: "the venue", evidence: "I finished calling the venue." },
      { field: "time", value: "dawn", evidence: "It is dawn." },
    ], assistantChanges: [] };
    const next = sceneForReply({ previous, userText, assistantText: "", changes });
    expect(next).toEqual({ ...previous, version: 5, time: "dawn" });
    expect(sceneForReply({ previous: next, userText, assistantText: "", changes })).toEqual({ ...next, version: 6 });
    expect(previous.time).toBeNull();
  });

  it("lets explicit unknown user absences and completions fence assistant additions", () => {
    const previous = emptySceneState();
    expect(sceneForReply({ previous,
      userText: "Jun left. We finished calling the venue.", assistantText: "Jun joins us. We need to call the venue. I feel calm.",
      changes: { userChanges: [
        { field: "participant_left", value: "Jun", evidence: "Jun left." },
        { field: "thread_resolved", value: "call the venue", referent: "the venue", evidence: "We finished calling the venue." },
      ], assistantChanges: [
        { field: "participant_arrived", value: "Jun", evidence: "Jun joins us." },
        { field: "thread_opened", authority: "open", value: "call the venue", evidence: "We need to call the venue." },
        { field: "emotionalBeat", value: "calm", evidence: "I feel calm." },
      ] },
    })).toEqual({ ...previous, version: 1, emotionalBeat: "calm" });
  });

  it("protects new user corrections from assistant removals absent in the pre-Turn anchor", () => {
    const previous = emptySceneState();
    expect(sceneForReply({ previous,
      userText: "Ana joins us. No, we still need to repair the radio.", assistantText: "Ana left. We finished repairing the radio.",
      changes: { userChanges: [
        { field: "participant_arrived", value: "Ana", evidence: "Ana joins us." },
        { field: "thread_opened", authority: "hold", value: "repair the radio", evidence: "No, we still need to repair the radio." },
      ], assistantChanges: [
        { field: "participant_left", value: "Ana", evidence: "Ana left." },
        { field: "thread_resolved", value: "repair the radio", referent: "the radio", evidence: "We finished repairing the radio." },
      ] },
    })).toEqual({ ...previous, version: 1, participants: ["Ana"], unresolvedThreads: ["repair the radio"] });
  });

  it("does not lose user facts or independent assistant updates to a harmless assistant removal", () => {
    const previous = emptySceneState();
    expect(sceneForReply({ previous, userText: "It is dawn.", assistantText: "Jun left. I feel calm.", changes: {
      userChanges: [{ field: "time", value: "dawn", evidence: "It is dawn." }],
      assistantChanges: [
        { field: "participant_left", value: "Jun", evidence: "Jun left." },
        { field: "emotionalBeat", value: "calm", evidence: "I feel calm." },
      ],
    } })).toEqual({ ...previous, version: 1, time: "dawn", emotionalBeat: "calm" });
  });

  it("cannot bypass completion verification by creating and then deleting a task in one bare proposal", () => {
    const previous = emptySceneState();
    expect(() => sceneForReply({ previous, userText: "We must call the venue. We finished calling the venue.", assistantText: "", changes: {
      userChanges: [
        { field: "thread_opened", authority: "open", value: "call the venue", evidence: "We must call the venue." },
        { field: "thread_resolved", value: "call the venue", referent: "the venue", evidence: "We finished calling the venue." },
      ], assistantChanges: [],
    } })).toThrow("scene_completion_unverified");
    expect(previous).toEqual(emptySceneState());
  });

  it("accepts only the canonical Scene without dropping unknown fields", () => {
    const scene = emptySceneState();
    expect(parseSceneState(scene)).toEqual(scene);
    for (const value of [null, { ...scene, location: 42 }, { ...scene, version: 1.5 }, { ...scene, source: "invented" }]) {
      expect(parseSceneState(value)).toBeNull();
    }
  });

  it("projects explicit fields and advances once without changing the anchor", () => {
    const previous = emptySceneState();
    const userText = "Tonight we're in the rooftop garden with Mina. I feel nervous, and we still need to choose the train.";
    const changes = { userChanges: [
      { field: "location", value: "the rooftop garden", evidence: "Tonight we're in the rooftop garden with Mina." },
      { field: "time", value: "Tonight", evidence: "Tonight we're in the rooftop garden with Mina." },
      { field: "participant_arrived", value: "Mina", evidence: "Tonight we're in the rooftop garden with Mina." },
      { field: "emotionalBeat", value: "nervous", evidence: "I feel nervous" },
      { field: "thread_opened", authority: "open", value: "choose the train", evidence: "we still need to choose the train." },
    ], assistantChanges: [] };
    expect(sceneForReply({ previous, userText, assistantText: "I stay beside you.", changes })).toEqual({
      schemaVersion: 1, version: 1, location: "the rooftop garden", time: "tonight", participants: ["Mina"],
      emotionalBeat: "nervous", unresolvedThreads: ["choose the train"],
    });
    expect(previous).toEqual(emptySceneState());
  });

  it("preserves the full frozen anchor when no current fact changed", () => {
    const previous = { ...emptySceneState(), version: 4, location: "the kitchen", time: "tonight", participants: ["Mina"], emotionalBeat: "calm", unresolvedThreads: ["call the hotel"] };
    const next = sceneForReply({ previous, userText: 'Yesterday you said, "We are at the station."', assistantText: "", changes: { userChanges: [], assistantChanges: [] } });
    expect(next).toEqual({ ...previous, version: 5 });
    expect(next.participants).not.toBe(previous.participants);
    expect(next.unresolvedThreads).not.toBe(previous.unresolvedThreads);
  });

  it("gives unchanged user facts priority over contradictory assistant facts", () => {
    const previous = { ...emptySceneState(), location: "the kitchen", participants: ["Mina"], unresolvedThreads: ["call the hotel"] };
    expect(sceneForReply({
      previous, userText: "We stay in the kitchen. Mina stays. No, we still need to call the hotel.",
      assistantText: "We are at the beach. Mina left. We finished calling the hotel.",
      changes: {
        userChanges: [
          { field: "location", value: "the kitchen", evidence: "We stay in the kitchen." },
          { field: "participant_arrived", value: "Mina", evidence: "Mina stays." },
          { field: "thread_opened", authority: "hold", value: "call the hotel", evidence: "No, we still need to call the hotel." },
        ],
        assistantChanges: [
          { field: "location", value: "the beach", evidence: "We are at the beach." },
          { field: "participant_left", value: "Mina", evidence: "Mina left." },
          { field: "thread_resolved", value: "call the hotel", evidence: "We finished calling the hotel.", referent: "the hotel" },
        ],
      },
    })).toEqual({ ...previous, version: 1 });
  });

  it("binds an explicit scalar retain and named unchanged facts without borrowing arbitrary previous values", () => {
    const previous = { ...emptySceneState(), version: 4, location: "the kitchen", participants: ["Mina"], unresolvedThreads: ["call the hotel"] };
    const source = { previous, userText: "Our conversation stays here. Mina stays with us. No, the hotel call remains unfinished.", assistantText: "We are in the mountains. Mina left. We finished calling the hotel." };
    expect(sceneForReply({ ...source, changes: {
      userChanges: [
        { evidence: "Our conversation stays here.", field: "location", value: "the kitchen", retain: true },
        { evidence: "Mina stays with us.", field: "participant_arrived", value: "Mina" },
        { evidence: "No, the hotel call remains unfinished.", field: "thread_opened", authority: "hold", value: "call the hotel", referent: "hotel" },
      ],
      assistantChanges: [
        { evidence: "We are in the mountains.", field: "location", value: "the mountains" },
        { evidence: "Mina left.", field: "participant_left", value: "Mina" },
        { evidence: "We finished calling the hotel.", field: "thread_resolved", value: "call the hotel", referent: "the hotel" },
      ],
    } })).toEqual({ ...previous, version: 5 });
    expect(() => sceneForReply({ ...source, changes: { userChanges: [{ evidence: "Our conversation stays here.", field: "location", value: "the beach" }], assistantChanges: [] } })).toThrow("scene_value_mismatch");
    for (const change of [
      { evidence: "She stays with us.", field: "participant_arrived", value: "Mina" },
      { evidence: "That task remains unfinished.", field: "thread_opened", authority: "hold", value: "call the hotel" },
    ]) expect(() => sceneForReply({ previous, userText: change.evidence, assistantText: "", changes: { userChanges: [change], assistantChanges: [] } })).toThrow("scene_value_mismatch");
  });

  it.each([
    { userChanges: [{ field: "location", value: "the beach", evidence: "We are at the beach." }], assistantChanges: [] },
    { userChanges: [], assistantChanges: [{ field: "location", value: "the kitchen", evidence: "We are in the kitchen." }] },
    { userChanges: [{ field: "location", value: "the kitchen", source: "memory", evidence: "We are in the kitchen." }], assistantChanges: [] },
    { userChanges: [{ field: "objectRelations", value: "book left of cup", evidence: "We are in the kitchen." }], assistantChanges: [] },
    { userChanges: [{ field: "participant_left", value: "Unknown", evidence: "We are in the kitchen." }], assistantChanges: [] },
    { userChanges: [{ field: "thread_resolved", value: "not an anchor task", evidence: "We are in the kitchen." }], assistantChanges: [] },
  ])("rejects a forged source slot or unbound change atomically: %j", changes => {
    const previous = emptySceneState();
    expect(() => sceneForReply({
      previous, userText: "We are in the kitchen.", assistantText: "",
      changes: { ...changes, userChanges: [{ field: "location", value: "the kitchen", evidence: "We are in the kitchen." }, ...changes.userChanges] },
    })).toThrow();
    expect(previous).toEqual(emptySceneState());
  });

  it("enforces sixteen total changes across both source slots", () => {
    const change = { field: "location", value: "the kitchen", evidence: "We are in the kitchen." };
    for (const changes of [
      { userChanges: Array(17).fill(change), assistantChanges: [] },
      { userChanges: Array(9).fill(change), assistantChanges: Array(8).fill(change) },
    ]) expect(() => sceneForReply({ previous: emptySceneState(), userText: change.evidence, assistantText: change.evidence, changes })).toThrow("scene_delta_invalid");
  });

  it("does not accept extra fields or a different delta format", () => {
    for (const changes of [null, { location: "the cafe" }, { userChanges: [], assistantChanges: [], memory: "rewrite" }, { changes: [] }]) {
      expect(() => sceneForReply({ previous: emptySceneState(), userText: "", assistantText: "", changes })).toThrow("scene_delta_invalid");
    }
  });

  it("replaces edit/regenerate candidates from the same immutable anchor", () => {
    const previous = { ...emptySceneState(), version: 4, location: "the kitchen" };
    const make = (location: string) => sceneForReply({
      previous, userText: `We are at ${location}.`, assistantText: "",
      changes: { userChanges: [{ field: "location", value: location, evidence: `We are at ${location}.` }], assistantChanges: [] },
    });
    expect(make("the station")).toMatchObject({ version: 5, location: "the station" });
    expect(make("the cafe")).toMatchObject({ version: 5, location: "the cafe" });
    expect(previous).toMatchObject({ version: 4, location: "the kitchen" });
  });
});
