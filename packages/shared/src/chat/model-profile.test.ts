import { describe, expect, it } from "vitest";
import {
  resolveChatMemoryExtractProfile,
  resolveChatModelProfile,
} from "./model-profile.js";

describe("chat model profile", () => {
  it("resolves provider, tier model and all timeout budgets once", () => {
    const profile = resolveChatModelProfile({
      CHAT_MODEL_PROVIDER: "openai",
      CHAT_MODEL_NAME: "base",
      CHAT_MODEL_DELUXE: "deluxe",
      CHAT_MODEL_TIMEOUT_MS: "41000",
      CHAT_MODEL_FIRST_TOKEN_TIMEOUT_MS: "52000",
      CHAT_MODEL_IDLE_TIMEOUT_MS: "9000",
      CHAT_MODEL_COMPLETE_TIMEOUT_MS: "17000",
    }, "deluxe");

    expect(profile).toMatchObject({
      provider: "openai",
      model: "deluxe",
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

  it("derives the extraction profile from the same chat endpoint", () => {
    expect(resolveChatMemoryExtractProfile({
      CHAT_MODEL_BASE_URL: "http://model.test/v1",
      CHAT_MODEL_API_KEY: "key",
    })).toMatchObject({
      baseUrl: "http://model.test/v1",
      apiKey: "key",
    });
  });
});
