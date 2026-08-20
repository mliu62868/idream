import { describe, expect, it } from "vitest";
import { currentModel, resolvePolicy, snapshotFromView } from "./policy.js";

describe("resolvePolicy (SSoT)", () => {
  it("free tier: small context, DSH memory enabled, configured model", () => {
    const p = resolvePolicy({
      modelTier: "free",
      unlimitedMessages: false,
      voiceEnabled: false,
      imageToolEnabled: true,
    });
    expect(p.model).toBe(currentModel());
    expect(p.maxContextMessages).toBe(12);
    expect(p.rateLimitPerHour).toBe(60);
    expect(p.memoryEnabled).toBe(true);
    expect(p.allowRelationshipPatch).toBe(true);
  });

  it("plans retain their quota policy but use the same configured DSH model", () => {
    const free = resolvePolicy({
      modelTier: "free", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: true,
    });
    const premium = resolvePolicy({
      modelTier: "premium", unlimitedMessages: true, voiceEnabled: true, imageToolEnabled: true,
    });
    const deluxe = resolvePolicy({
      modelTier: "deluxe", unlimitedMessages: true, voiceEnabled: true, imageToolEnabled: true,
    });
    expect([free.model, premium.model, deluxe.model]).toEqual([
      currentModel(), currentModel(), currentModel(),
    ]);
  });

  it("deluxe tier: doubled context and DSH memory remains enabled", () => {
    const p = resolvePolicy({
      modelTier: "deluxe",
      unlimitedMessages: true,
      voiceEnabled: true,
      imageToolEnabled: true,
    });
    expect(p.model).toBe(currentModel());
    expect(p.maxContextMessages).toBe(24);
    expect(p.memoryEnabled).toBe(true);
    expect(p.unlimitedMessages).toBe(true);
    expect(p.rateLimitPerHour).toBe(600);
  });

  it("memory disabled selects the no-memory workspace and relationship boundary", () => {
    const p = resolvePolicy(
      { modelTier: "deluxe", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: true },
      { memoryEnabled: false },
    );
    expect(p.memoryEnabled).toBe(false);
    expect(p.allowRelationshipPatch).toBe(false);
  });

  it("snapshotFromView defaults unknown user to free", () => {
    expect(snapshotFromView(null)).toEqual({
      modelTier: "free",
      unlimitedMessages: false,
      voiceEnabled: false,
      imageToolEnabled: true,
    });
  });
});
