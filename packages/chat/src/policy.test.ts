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
  it("free tier: small context, base memories, free model", () => {
    const p = resolvePolicy({
      modelTier: "free",
      memoryMultiplier: 1,
      unlimitedMessages: false,
      voiceEnabled: false,
    });
    expect(p.model).toBe("model-free");
    expect(p.maxContextMessages).toBe(12);
    expect(p.maxMemories).toBe(6);
    expect(p.maxStoredMemories).toBe(30);
    expect(p.rateLimitPerHour).toBe(60);
    expect(p.allowGlobalMemoryWrite).toBe(false);
  });

  it("tiers resolve to distinct real models (Deluxe gets the premium model)", () => {
    expect(modelForTier("free")).toBe("model-free");
    expect(modelForTier("premium")).toBe("model-premium");
    expect(modelForTier("deluxe")).toBe("model-deluxe");
  });

  it("deluxe tier: doubled context, multiplied memories, global memory writes", () => {
    const p = resolvePolicy({
      modelTier: "deluxe",
      memoryMultiplier: 3,
      unlimitedMessages: true,
      voiceEnabled: true,
    });
    expect(p.model).toBe("model-deluxe");
    expect(p.maxContextMessages).toBe(24);
    expect(p.maxMemories).toBe(18); // 3× Free retrieval top-K
    expect(p.maxStoredMemories).toBe(90); // 3× Free storage — "3x chat memory"
    expect(p.allowGlobalMemoryWrite).toBe(true);
    expect(p.unlimitedMessages).toBe(true);
    expect(p.rateLimitPerHour).toBe(600);
  });

  it("memory disabled (no-memory/incognito) zeroes memories + write gates", () => {
    const p = resolvePolicy(
      { modelTier: "deluxe", memoryMultiplier: 3, unlimitedMessages: false, voiceEnabled: false },
      { memoryEnabled: false },
    );
    expect(p.maxMemories).toBe(0);
    expect(p.maxStoredMemories).toBe(0);
    expect(p.allowMemoryWrite).toBe(false);
    expect(p.allowGlobalMemoryWrite).toBe(false);
    expect(p.allowRelationshipPatch).toBe(false);
  });

  it("snapshotFromView defaults unknown user to free", () => {
    expect(snapshotFromView(null)).toEqual({
      modelTier: "free",
      memoryMultiplier: 1,
      unlimitedMessages: false,
      voiceEnabled: false,
    });
  });
});
