import { describe, expect, it } from "vitest";
import {
  isOpenRouterBaseUrl,
  requiredChatCanaryProfiles,
  resolveChatModelProfile,
} from "./model-profile.js";

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
    });

    expect(profile).toMatchObject({
      provider: "openai",
      model: "base",
      firstTokenTimeoutMs: 52_000,
      idleTimeoutMs: 9_000,
      supportsTools: true,
    });
  });

  it("does not inherit Main or generic pipeline model settings", () => {
    expect(resolveChatModelProfile({
      CHAT_PROVIDER: "pipeline",
      PIPELINE_API_URL: "https://stale.example/v1",
      PIPELINE_API_TOKEN: "stale-token",
      PIPELINE_CHAT_MODEL_DEFAULT: "stale-model",
      PIPELINE_TIMEOUT_MS: "1",
    })).toMatchObject({
      provider: "mock",
      baseUrl: "http://127.0.0.1:8061/v1",
      apiKey: "",
      firstTokenTimeoutMs: 45_000,
      idleTimeoutMs: 45_000,
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

  it("rejects sampling outside the PreparedTurn contract at configuration time", () => {
    expect(() => resolveChatModelProfile({ CHAT_MODEL_TOP_P: "2" }))
      .toThrow(/CHAT_MODEL_TOP_P/);
    expect(() => resolveChatModelProfile({ CHAT_MODEL_TEMPERATURE: "99" }))
      .toThrow(/CHAT_MODEL_TEMPERATURE/);
    expect(() => resolveChatModelProfile({ CHAT_MODEL_REPETITION_PENALTY: "0" }))
      .toThrow(/CHAT_MODEL_REPETITION_PENALTY/);
    expect(resolveChatModelProfile({ CHAT_MODEL_TEMPERATURE: "0" }).temperature).toBe(0);
  });

  it("identifies OpenRouter from the configured route instead of the generic provider name", () => {
    expect(isOpenRouterBaseUrl("https://openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouterBaseUrl("https://api.openrouter.ai/v1")).toBe(false);
    expect(isOpenRouterBaseUrl("http://127.0.0.1:8061/v1")).toBe(false);
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
  });
});
