import { describe, expect, it } from "vitest";
import { resolvePolicy, snapshotFromView } from "./policy.js";

describe("resolvePolicy (SSoT)", () => {
  it("free tier: small context, base memories, free model", () => {
    const p = resolvePolicy({
      modelTier: "free",
      memoryMultiplier: 1,
      unlimitedMessages: false,
      voiceEnabled: false,
    });
    expect(p.model).toBe("pi-agent-local-free");
    expect(p.maxContextMessages).toBe(12);
    expect(p.maxMemories).toBe(6);
    expect(p.rateLimitPerHour).toBe(60);
    expect(p.allowGlobalMemoryWrite).toBe(false);
  });

  it("deluxe tier: doubled context, multiplied memories, global memory writes", () => {
    const p = resolvePolicy({
      modelTier: "deluxe",
      memoryMultiplier: 3,
      unlimitedMessages: true,
      voiceEnabled: true,
    });
    expect(p.maxContextMessages).toBe(24);
    expect(p.maxMemories).toBe(18);
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
