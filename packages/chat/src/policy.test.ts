import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modelForTier, resolvePolicy, snapshotFromView } from "./policy.js";

// P0-D: the policy resolver maps a tier to a REAL provider model via env aliases.
const savedEnv = {
  free: process.env.CHAT_MODEL_FREE,
  premium: process.env.CHAT_MODEL_PREMIUM,
  deluxe: process.env.CHAT_MODEL_DELUXE,
};
beforeAll(() => {
  process.env.CHAT_MODEL_FREE = "model-free";
  process.env.CHAT_MODEL_PREMIUM = "model-premium";
  process.env.CHAT_MODEL_DELUXE = "model-deluxe";
});
afterAll(() => {
  for (const [k, v] of Object.entries({
    CHAT_MODEL_FREE: savedEnv.free,
    CHAT_MODEL_PREMIUM: savedEnv.premium,
    CHAT_MODEL_DELUXE: savedEnv.deluxe,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolvePolicy (SSoT)", () => {
  it("free tier: small context, DSH memory enabled, free model", () => {
    const p = resolvePolicy({
      modelTier: "free",
      unlimitedMessages: false,
      voiceEnabled: false,
      imageToolEnabled: true,
    });
    expect(p.model).toBe("model-free");
    expect(p.maxContextMessages).toBe(12);
    expect(p.rateLimitPerHour).toBe(60);
    expect(p.memoryEnabled).toBe(true);
    expect(p.allowRelationshipPatch).toBe(true);
  });

  it("tiers resolve to distinct real models (Deluxe gets the premium model)", () => {
    expect(modelForTier("free")).toBe("model-free");
    expect(modelForTier("premium")).toBe("model-premium");
    expect(modelForTier("deluxe")).toBe("model-deluxe");
  });

  it("deluxe tier: doubled context and DSH memory remains enabled", () => {
    const p = resolvePolicy({
      modelTier: "deluxe",
      unlimitedMessages: true,
      voiceEnabled: true,
      imageToolEnabled: true,
    });
    expect(p.model).toBe("model-deluxe");
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
