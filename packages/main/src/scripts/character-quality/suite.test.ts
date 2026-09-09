import { describe, expect, it } from "vitest";
import { QUALITY_CASES, QUALITY_REVIEW, QUALITY_PROMPT_VERSION, assertQualityActor, qualityPrompts, qualitySummary, qualityTextFacts, qualityTurnCheckNames, qualityVoiceContinuation, qualityVoiceUsageFacts, requireQualityChecks, requireQualityPromptVersion, requireFiveBindings } from "./suite";

describe("character quality evidence", () => {
  it("permits existing audit owners while rejecting real customers and internal admins", () => {
    const actor = { id: "private-owner", role: "user", status: "active", dataClass: "audit", deletedAt: null };
    expect(() => assertQualityActor(actor, actor.id)).not.toThrow();
    expect(() => assertQualityActor({ ...actor, dataClass: "customer" }, actor.id)).toThrow("audit");
    expect(() => assertQualityActor({ ...actor, role: "admin", dataClass: "internal" }, actor.id)).toThrow("audit");
    expect(() => assertQualityActor(actor, "another-user")).toThrow("audit");
  });
  it("uses a different recall fact per run and character without putting the answer in the recall question", () => {
    const a = qualityPrompts(QUALITY_CASES[0], "run-a");
    const b = qualityPrompts(QUALITY_CASES[0], "run-b");
    const c = qualityPrompts(QUALITY_CASES[1], "run-a");
    expect(new Set([a.sentinel, b.sentinel, c.sentinel]).size).toBe(3);
    expect(a.advance).toContain(a.sentinel);
    expect(a.recall).not.toContain(a.sentinel);
    // Chat's result-bound Gate-E telemetry counts this exact marker family.
    expect(a.sentinel).toMatch(/^idreamrecall_[a-f0-9]{32}$/u);
  });
  it("preserves the failed historical truncated-label sample instead of accepting its prefix", () => {
    const sentinel = "idreamrecall_ac82d9ad174cbc30da351234567890abc";
    expect(qualityTextFacts({ stage: "recall", sentinel, text: "The blue notebook was by the window, labeled idreamrecall_ac82d9ad17…" }).exactPriorLabel).toBe(false);
    expect(() => requireQualityPromptVersion(undefined)).toThrow("preserve the old sample");
    expect(() => requireQualityPromptVersion(1)).toThrow("new report");
    expect(() => requireQualityPromptVersion(QUALITY_PROMPT_VERSION)).not.toThrow();
  });
  it("can revisit failed media observations without allowing missing or failed next-stage prerequisites", () => {
    const textKeys = ["opening", "advance", "recall"].flatMap((stage) => qualityTurnCheckNames(stage as "opening" | "advance" | "recall"));
    const checks = Object.fromEntries(textKeys.map((key) => [key, true]));
    checks["image.persistence"] = false;
    expect(() => requireQualityChecks(checks, textKeys)).not.toThrow();
    expect(() => requireQualityChecks(checks, ["image.persistence"])).toThrow("image.persistence");
    checks["image.persistence"] = true;
    expect(() => requireQualityChecks(checks, ["image.persistence", "image.singleCharge"])).toThrow("image.singleCharge");
    checks["recall.exactPriorLabel"] = false;
    expect(() => requireQualityChecks(checks, textKeys)).toThrow("recall.exactPriorLabel");
  });
  it("observes running voice and reuses successful voice without implicitly retrying a failed provider attempt", () => {
    expect(qualityVoiceContinuation(null)).toBe("submit");
    expect(qualityVoiceContinuation("running")).toBe("observe");
    expect(qualityVoiceContinuation("succeeded")).toBe("reuse");
    expect(() => qualityVoiceContinuation("failed")).toThrow("must not create another");
    expect(() => qualityVoiceContinuation("skipped")).toThrow("must not create another");
  });
  it("accepts retained provider usage but rejects duplicate delivery or charges even if replay leaves them unchanged", () => {
    const providerOnly = { mediaAssetId: null, costDreamcoins: 0 };
    const delivered = { mediaAssetId: "voice-current", costDreamcoins: 2 };
    expect(qualityVoiceUsageFacts("voice-current", [providerOnly, delivered])).toEqual({ voiceSingleDelivery: true, voiceSingleCharge: true });
    expect(qualityVoiceUsageFacts("voice-current", [providerOnly, delivered, { ...delivered, costDreamcoins: 0 }])).toEqual({ voiceSingleDelivery: false, voiceSingleCharge: true });
    expect(qualityVoiceUsageFacts("voice-current", [delivered, { mediaAssetId: null, costDreamcoins: 2 }])).toEqual({ voiceSingleDelivery: true, voiceSingleCharge: false });
    expect(qualityVoiceUsageFacts("voice-current", [providerOnly]).voiceSingleDelivery).toBe(false);
  });
  it("rejects a fluent but fabricated recall answer", () => {
    const facts = qualityTextFacts({ stage: "recall", sentinel: "idreamquality_actual", text: "Your red book was on the table. Of course I remember." });
    expect(facts.nonempty).toBe(true);
    expect(facts.exactPriorLabel).toBe(false);
    expect(facts.priorColor).toBe(false);
    expect(facts.priorLocation).toBe(false);
  });
  it("accepts literal recall evidence while leaving subjective quality unscored", () => {
    expect(Object.values(qualityTextFacts({ stage: "recall", sentinel: "idreamquality_actual", text: "The blue notebook labeled idreamquality_actual was beside the window." })).every(Boolean)).toBe(true);
    expect(QUALITY_REVIEW.every((review) => review.verdict === "pending" && review.reviewer === null)).toBe(true);
  });
  it("never promotes text-only, missing media, or failed facts to a complete experience", () => {
    const input = { checks: { terminal: true }, requestedMedia: false, finishedText: true, finishedMedia: false };
    expect(qualitySummary(input)).toMatchObject({ execution: "completed", fullExperienceComplete: false, subjectiveReview: "pending", productQualityApproved: false });
    expect(qualitySummary({ ...input, requestedMedia: true })).toMatchObject({ execution: "incomplete", fullExperienceComplete: false });
    expect(qualitySummary({ ...input, finishedMedia: true, checks: { recall: false } })).toMatchObject({ execution: "failed", fullExperienceComplete: false });
  });
  it("requires five different real character bindings", () => {
    expect(() => requireFiveBindings(["a"])).toThrow("five");
    expect(() => requireFiveBindings(["a", "b", "c", "d", "a"])).toThrow("five");
    expect(requireFiveBindings(["a", "b", "c", "d", "e"]).map((x) => x.key)).toEqual(QUALITY_CASES.map((x) => x.key));
  });
  it("keeps recovery evidence from different source revisions out of full-experience certification", () => {
    const input = { checks: { terminal: true }, requestedMedia: true, finishedText: true, finishedMedia: true };
    expect(qualitySummary({ ...input, sourceRevisions: ["revision-a", "revision-a"] })).toMatchObject({ fullExperienceComplete: true, sourceRevisionConsistent: true });
    expect(qualitySummary({ ...input, sourceRevisions: ["revision-a", "revision-b"] })).toMatchObject({ execution: "completed", fullExperienceComplete: false, sourceRevisionConsistent: false });
    expect(qualitySummary(input).fullExperienceComplete).toBe(false);
  });
});
