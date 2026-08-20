import { describe, expect, it } from "vitest";
import { characterSoulLiveCanarySchema } from "../admin/contracts/characters-release.js";
import { requiredChatCanaryProfiles, resolveChatModelProfile } from "./model-profile.js";

describe("chat model profile", () => {
  it("uses one DSH model configuration regardless of retired plan aliases", () => {
    const profile = resolveChatModelProfile({
      CHAT_MODEL_PROVIDER: "openai",
      CHAT_MODEL_NAME: "base",
      CHAT_MODEL_FREE: "free",
      CHAT_MODEL_PREMIUM: "premium",
      CHAT_MODEL_DELUXE: "deluxe",
      CHAT_MODEL_TIMEOUT_MS: "41000",
      CHAT_MODEL_FIRST_TOKEN_TIMEOUT_MS: "52000",
      CHAT_MODEL_IDLE_TIMEOUT_MS: "9000",
      CHAT_MODEL_COMPLETE_TIMEOUT_MS: "17000",
    });

    expect(profile).toMatchObject({
      provider: "openai",
      model: "base",
      firstTokenTimeoutMs: 52_000,
      idleTimeoutMs: 9_000,
      completionTimeoutMs: 17_000,
      supportsTools: true,
    });
  });

  it("defaults sampling to the roleplay knobs and lets the environment override them", () => {
    expect(resolveChatModelProfile({})).toMatchObject({
      temperature: 0.9,
      topP: 0.95,
      repetitionPenalty: 1.05,
      structuredTemperature: 0.2,
    });

    expect(resolveChatModelProfile({
      CHAT_MODEL_TEMPERATURE: "1.05",
      CHAT_MODEL_TOP_P: "0.9",
      CHAT_MODEL_REPETITION_PENALTY: "1.2",
      CHAT_MODEL_STRUCTURED_TEMPERATURE: "0.1",
    })).toMatchObject({
      temperature: 1.05,
      topP: 0.9,
      repetitionPenalty: 1.2,
      structuredTemperature: 0.1,
    });
  });

  it("requires one DSH runtime canary even when retired plan aliases are set", () => {
    const canaries = requiredChatCanaryProfiles({
      CHAT_MODEL_PROVIDER: "openai",
      CHAT_MODEL_NAME: "base",
      CHAT_MODEL_FREE: "free",
      CHAT_MODEL_PREMIUM: "premium",
      CHAT_MODEL_DELUXE: "deluxe",
    });
    expect(canaries).toMatchObject([{ tier: "free", profile: { model: "base" } }]);
    const canary = canaries[0];
    expect(characterSoulLiveCanarySchema.safeParse({
      tier: canary.tier,
      provider: canary.profile.provider,
      model: canary.profile.model,
      adapter: canary.profile.adapter,
      characterContentVersionId: "content_1",
      soulFingerprint: "fingerprint",
      compilerVersion: "character-soul-1",
      firstTokenMs: 1,
      totalMs: 2,
      coldStart: false,
      result: "passed",
      evidenceRef: "test://dsh-canary",
    }).success).toBe(true);
  });
});
